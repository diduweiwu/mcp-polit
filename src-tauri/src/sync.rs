//! Git 同步模块：把全部项目的目录树与 Server 配置导出到本地 git 仓库（JSON 文件），
//! 以及从该仓库导入回数据库。
//!
//! 设计要点：
//! - 仓库结构：`<repo>/projects/<项目名安全化>/tree.json` + `servers/<别名>.json`
//! - 只扫描/读写 `.json` 文件；解析失败的文件记入日志并跳过，绝不静默丢弃
//! - 同一项目目录下 server 别名（即文件名）不允许重名，导出/导入均校验
//! - 导入为覆盖语义：同名项目会被仓库内容完全替换（UI 有明确提示）
//! - 可选脱敏导出（默认开启）：headers/env 的值替换为 `***`
//! - git 操作通过 CLI（tokio::process），参数数组形式，无 shell 注入风险

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::AppHandle;

use crate::db::Db;
use crate::models::{LogEntry, NodeType, ServerConfig, TransportType};
use crate::mcp_manager::McpManager;

/// 单个导出的树节点。
#[derive(Debug, Serialize, Deserialize)]
struct SyncNode {
    /// 稳定引用 ID（导出时生成，如 "c0"/"s1"，仅在同一 tree.json 内有意义）
    id: String,
    /// 父节点引用 ID；null 表示根层
    parent: Option<String>,
    /// 节点类型：folder / server
    #[serde(rename = "type")]
    node_type: String,
    /// 目录名或 Server 别名
    name: String,
    /// 同层排序
    order: i64,
}

/// 单个导出的 Server 配置（servers/<别名>.json 的内容）。
#[derive(Debug, Serialize, Deserialize)]
struct SyncServer {
    /// 挂载的目录引用 ID；null 表示根层
    parent: Option<String>,
    /// 传输类型：stdio / streamable_http
    transport_type: String,
    command: Option<String>,
    args: Option<String>,
    env: Option<String>,
    working_dir: Option<String>,
    url: Option<String>,
    headers: Option<String>,
    timeout_ms: i64,
    enabled: bool,
    note: Option<String>,
}

/// 导出全部项目到 git 仓库。
///
/// # 参数
///
/// - `repo`: 仓库根目录（不存在则报错；非 git 仓库会自动 init）
/// - `include_secrets`: false 时 headers/env 的值以 `***` 导出（脱敏）
///
/// # 返回
///
/// 本次操作的日志列表（level: info / warn / error），由前端写入日志面板。
pub async fn export_all(
    app: &AppHandle,
    db: &Db,
    repo: &Path,
    include_secrets: bool,
) -> Vec<LogEntry> {
    let mut logs: Vec<LogEntry> = Vec::new();
    let log = |logs: &mut Vec<LogEntry>, level: &str, msg: String| {
        logs.push(LogEntry {
            level: level.into(),
            message: msg,
        });
    };

    if !repo.is_dir() {
        log(&mut logs, "error", format!("仓库目录不存在：{}", repo.display()));
        return logs;
    }

    // 非 git 仓库自动 init
    if !repo.join(".git").exists() {
        match git(repo, &["init"]).await {
            Ok(_) => log(&mut logs, "info", "该目录不是 git 仓库，已自动执行 git init".into()),
            Err(e) => {
                log(&mut logs, "error", format!("git init 失败：{e}"));
                return logs;
            }
        }
    }

    // 导出前先拉取远端，减小冲突面（失败不阻断，本地提交仍会完成）
    if let Err(e) = git(repo, &["pull", "--ff-only"]).await {
        log(&mut logs, "warn", format!("git pull 失败（继续导出本地内容）：{e}"));
    }

    // 收集全部项目并逐个导出
    let projects = {
        let conn = db.0.lock().unwrap();
        crate::db::list_projects(&conn).unwrap_or_default()
    };
    if projects.is_empty() {
        log(&mut logs, "warn", "没有任何项目可导出".into());
        return logs;
    }

    let projects_root = repo.join("projects");
    for project in &projects {
        let nodes_cfgs = {
            let conn = db.0.lock().unwrap();
            let nodes = match crate::db::list_nodes(&conn, project.id) {
                Ok(n) => n,
                Err(e) => {
                    log(&mut logs, "error", format!("项目「{}」读取节点失败：{e}", project.name));
                    continue;
                }
            };
            let mut cfgs = HashMap::new();
            for n in &nodes {
                if n.node_type == NodeType::Server {
                    cfgs.insert(n.id, crate::db::get_server_config(&conn, n.id).ok());
                }
            }
            (nodes, cfgs)
        };
        let (nodes, cfgs) = nodes_cfgs;

        // 稳定 ID + 重名检测
        let mut id_of: HashMap<i64, String> = HashMap::new();
        let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut dup: Vec<String> = Vec::new();
        let mut sync_nodes: Vec<SyncNode> = Vec::new();
        let mut servers_dir_items: Vec<(String, SyncServer)> = Vec::new();

        for (i, n) in nodes.iter().enumerate() {
            let sid = format!("n{i}");
            if n.node_type == NodeType::Server {
                if !used_names.insert(n.name.clone()) {
                    dup.push(n.name.clone());
                    continue; // 同目录重名：跳过并记日志
                }
            }
            id_of.insert(n.id, sid.clone());
            sync_nodes.push(SyncNode {
                id: sid,
                parent: n.parent_id.and_then(|p| id_of.get(&p).cloned()),
                node_type: if n.node_type == NodeType::Folder { "folder" } else { "server" }.into(),
                name: n.name.clone(),
                order: n.sort_order,
            });
        }
        // 第二遍补 parent 引用（上面第一遍时父节点的 id 可能尚未生成）
        let raw: Vec<(Option<i64>, String)> = nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.parent_id, format!("n{i}")))
            .collect();
        for (idx, sn) in sync_nodes.iter_mut().enumerate() {
            sn.parent = raw[idx].0.and_then(|p| id_of.get(&p).cloned());
        }
        for name in &dup {
            log(&mut logs, "warn", format!(
                "项目「{}」存在同名 Server「{name}」，同目录配置不允许重名，已跳过导出该项",
                project.name
            ));
        }

        // Server 配置文件
        for n in &nodes {
            if n.node_type != NodeType::Server || !id_of.contains_key(&n.id) {
                continue;
            }
            if let Some(Some(cfg)) = cfgs.get(&n.id) {
                let parent = n
                    .parent_id
                    .and_then(|p| id_of.get(&p).cloned())
                    .unwrap_or_else(|| "ROOT".into());
                let ss = SyncServer {
                    parent: if parent == "ROOT" { None } else { Some(parent) },
                    transport_type: transport_str(cfg.transport_type).into(),
                    command: cfg.command.clone(),
                    args: cfg.args.clone(),
                    env: if include_secrets { cfg.env.clone() } else { scrub(cfg.env.as_deref()) },
                    working_dir: cfg.working_dir.clone(),
                    url: cfg.url.clone(),
                    headers: if include_secrets { cfg.headers.clone() } else { scrub(cfg.headers.as_deref()) },
                    timeout_ms: cfg.timeout_ms,
                    enabled: cfg.enabled,
                    note: cfg.note.clone(),
                };
                servers_dir_items.push((safe_name(&n.name), ss));
            }
        }

        // 写文件：先清空该项目目录再重建（防残留已删除节点）
        let proj_dir = projects_root.join(safe_name(&project.name));
        if proj_dir.exists() {
            let _ = std::fs::remove_dir_all(&proj_dir);
        }
        if let Err(e) = std::fs::create_dir_all(proj_dir.join("servers")) {
            log(&mut logs, "error", format!("创建目录失败（{}）：{e}", proj_dir.display()));
            continue;
        }
        let tree = serde_json::json!({ "project": project.name, "nodes": sync_nodes });
        if let Err(e) = std::fs::write(
            proj_dir.join("tree.json"),
            serde_json::to_string_pretty(&tree).unwrap_or_default() + "\n",
        ) {
            log(&mut logs, "error", format!("写入 tree.json 失败：{e}"));
            continue;
        }
        for (file, ss) in &servers_dir_items {
            let path = proj_dir.join("servers").join(format!("{file}.json"));
            if let Err(e) = std::fs::write(
                &path,
                serde_json::to_string_pretty(ss).unwrap_or_default() + "\n",
            ) {
                log(&mut logs, "error", format!("写入 {} 失败：{e}", path.display()));
            }
        }
        log(&mut logs, "info", format!(
            "项目「{}」已导出：{} 个节点 / {} 个 Server（{}）",
            project.name,
            nodes.len(),
            servers_dir_items.len(),
            if include_secrets { "含敏感信息" } else { "已脱敏" }
        ));
    }

    // 提交 + 推送
    let _ = git(repo, &["add", "-A"]).await;
    match git(repo, &["-c", "user.name=MCPilot", "-c", "user.email=mcpilot@local", "commit", "-m", "MCPilot 配置同步"]).await {
        Ok(_) => {
            log(&mut logs, "info", "已提交到本地 git 仓库".into());
            match git(repo, &["push"]).await {
                Ok(_) => log(&mut logs, "info", "已推送到远端".into()),
                Err(e) => log(&mut logs, "warn", format!("git push 失败（本地提交已完成，可稍后手动 push）：{e}")),
            }
        }
        Err(e) => {
            if e.contains("nothing to commit") {
                log(&mut logs, "info", "内容无变化，未产生新提交".into());
            } else {
                log(&mut logs, "error", format!("git commit 失败：{e}"));
            }
        }
    }
    let _ = app; // 预留：后续需要事件推送时使用
    logs
}

/// 从 git 仓库导入全部项目（覆盖同名项目）。
pub async fn import_all(app: &AppHandle, db: &Db, repo: &Path) -> Vec<LogEntry> {
    let mut logs: Vec<LogEntry> = Vec::new();
    let log = |logs: &mut Vec<LogEntry>, level: &str, msg: String| {
        logs.push(LogEntry {
            level: level.into(),
            message: msg,
        });
    };

    if !repo.is_dir() {
        log(&mut logs, "error", format!("仓库目录不存在：{}", repo.display()));
        return logs;
    }
    if let Err(e) = git(repo, &["pull", "--ff-only"]).await {
        log(&mut logs, "warn", format!("git pull 失败（使用本地仓库当前内容）：{e}"));
    }

    let projects_root = repo.join("projects");
    let entries = match std::fs::read_dir(&projects_root) {
        Ok(e) => e,
        Err(_) => {
            log(&mut logs, "warn", format!("仓库中没有 projects 目录（{}）", projects_root.display()));
            return logs;
        }
    };

    for entry in entries.flatten() {
        let proj_dir = entry.path();
        if !proj_dir.is_dir() {
            continue;
        }
        let tree_path = proj_dir.join("tree.json");
        // 只认 .json，且必须有 tree.json
        if !tree_path.is_file() {
            log(&mut logs, "warn", format!("跳过 {}：缺少 tree.json", proj_dir.display()));
            continue;
        }
        // 损坏文件：提示且不加载
        let tree_raw = match std::fs::read_to_string(&tree_path) {
            Ok(s) => s,
            Err(e) => {
                log(&mut logs, "error", format!("tree.json 读取失败（{}）：{e}", tree_path.display()));
                continue;
            }
        };
        let tree: Value = match serde_json::from_str(&tree_raw) {
            Ok(v) => v,
            Err(e) => {
                log(&mut logs, "error", format!(
                    "文件已损坏，跳过加载：{} 解析失败（{e}）",
                    tree_path.display()
                ));
                continue;
            }
        };
        let project_name = tree["project"].as_str().unwrap_or_default().to_string();
        if project_name.is_empty() {
            log(&mut logs, "error", format!("tree.json 缺少 project 字段，跳过：{}", tree_path.display()));
            continue;
        }
        let nodes: Vec<SyncNode> = match serde_json::from_value(tree["nodes"].clone()) {
            Ok(v) => v,
            Err(e) => {
                log(&mut logs, "error", format!(
                    "文件已损坏，跳过加载：{} nodes 解析失败（{e}）",
                    tree_path.display()
                ));
                continue;
            }
        };

        // servers/*.json（只扫描 .json）
        let mut servers: Vec<(String, SyncServer)> = Vec::new();
        let servers_dir = proj_dir.join("servers");
        if let Ok(files) = std::fs::read_dir(&servers_dir) {
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let alias = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                match std::fs::read_to_string(&p)
                    .map_err(|e| e.to_string())
                    .and_then(|s| serde_json::from_str::<SyncServer>(&s).map_err(|e| e.to_string()))
                {
                    Ok(ss) => servers.push((alias, ss)),
                    Err(e) => log(&mut logs, "error", format!(
                        "文件已损坏，跳过加载：{} 解析失败（{e}）",
                        p.display()
                    )),
                }
            }
        }
        // 同目录 server 重名校验（文件名即别名）
        let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
        servers.retain(|(alias, _)| used.insert(alias.clone()));

        // 覆盖导入：断开该项目连接 -> 删除节点 -> 重建
        let (project_id, removed) = {
            let conn = db.0.lock().unwrap();
            let existing = crate::db::list_projects(&conn).unwrap_or_default();
            match existing.into_iter().find(|p| p.name == project_name) {
                Some(p) => match crate::db::delete_project_nodes(&conn, p.id) {
                    Ok(removed) => (p.id, removed),
                    Err(e) => {
                        log(&mut logs, "error", format!("清空项目「{project_name}」旧节点失败：{e}"));
                        continue;
                    }
                },
                None => match crate::db::create_project(&conn, &project_name) {
                    Ok(p) => (p.id, Vec::new()),
                    Err(e) => {
                        log(&mut logs, "error", format!("创建项目「{project_name}」失败：{e}"));
                        continue;
                    }
                },
            }
        };
        for node_id in removed {
            McpManager::disconnect(app.clone(), node_id).await.ok();
        }

        // 建目录树（拓扑序：父节点先建）
        let mut id_map: HashMap<String, i64> = HashMap::new();
        let mut pending: Vec<&SyncNode> = nodes.iter().collect();
        let mut guard = 0;
        while !pending.is_empty() {
            guard += 1;
            if guard > 1000 {
                log(&mut logs, "error", format!("项目「{project_name}」节点引用疑似成环，未挂载的节点已跳过"));
                break;
            }
            let mut progress = false;
            pending.retain(|n| {
                let ready = n.parent.is_none() || id_map.contains_key(n.parent.as_deref().unwrap());
                if !ready {
                    return true;
                }
                let parent_id = n.parent.as_deref().and_then(|p| id_map.get(p).copied());
                let node_type = if n.node_type == "folder" { NodeType::Folder } else { NodeType::Server };
                let conn = db.0.lock().unwrap();
                let created = crate::db::create_node(&conn, project_id, parent_id, node_type, &n.name)
                    .map_err(|e| format!("{e}"));
                drop(conn);
                match created {
                    Ok(t) => {
                        id_map.insert(n.id.clone(), t.id);
                        progress = true;
                        false
                    }
                    Err(e) => {
                        log(&mut logs, "error", format!("项目「{project_name}」创建节点「{}」失败：{e}", n.name));
                        false
                    }
                }
            });
            if !progress {
                for n in &pending {
                    log(&mut logs, "warn", format!(
                        "项目「{project_name}」节点「{}」的父节点缺失，已跳过", n.name
                    ));
                }
                break;
            }
        }

        // 建 Server 配置
        let mut ok = 0;
        for (alias, ss) in &servers {
            let tt = match ss.transport_type.as_str() {
                "stdio" => TransportType::Stdio,
                "streamable_http" => TransportType::StreamableHttp,
                other => {
                    log(&mut logs, "warn", format!(
                        "Server「{alias}」transport_type 非法（{other}），跳过"
                    ));
                    continue;
                }
            };
            let parent_db = ss.parent.as_deref().and_then(|p| id_map.get(p).copied());
            let node = {
                let conn = db.0.lock().unwrap();
                crate::db::create_node(&conn, project_id, parent_db, NodeType::Server, alias)
                    .map_err(|e| format!("{e}"))
            };
            let node = match node {
                Ok(n) => n,
                Err(e) => {
                    log(&mut logs, "error", format!("创建 Server「{alias}」失败：{e}"));
                    continue;
                }
            };
            let cfg = ServerConfig {
                node_id: node.id,
                transport_type: tt,
                command: ss.command.clone(),
                args: ss.args.clone(),
                env: ss.env.clone(),
                working_dir: ss.working_dir.clone(),
                url: ss.url.clone(),
                headers: ss.headers.clone(),
                timeout_ms: ss.timeout_ms,
                enabled: ss.enabled,
                note: ss.note.clone(),
            };
            let save = {
                let conn = db.0.lock().unwrap();
                crate::db::upsert_server_config(&conn, &cfg).map_err(|e| format!("{e}"))
            };
            match save {
                Ok(_) => ok += 1,
                Err(e) => log(&mut logs, "error", format!("保存 Server「{alias}」配置失败：{e}")),
            }
        }
        log(&mut logs, "info", format!(
            "项目「{project_name}」导入完成：{} 目录 / {} Server（覆盖同名项目）",
            nodes.iter().filter(|n| n.node_type == "folder").count(),
            ok
        ));
    }
    logs
}

/* ---------- 工具函数 ---------- */

/// 执行 git 子命令（工作目录为 repo），成功返回 stdout。
async fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("git 未安装或执行失败：{e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!(
            "git {}：{}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// 文件名安全化：替换路径分隔符与 Windows 非法字符。
fn safe_name(s: &str) -> String {
    s.chars()
        .map(|c| if r#"\/:*?"<>|"#.contains(c) || c.is_control() { '_' } else { c })
        .collect()
}

/// TransportType -> 存储字符串。
fn transport_str(t: TransportType) -> &'static str {
    match t {
        TransportType::Stdio => "stdio",
        TransportType::StreamableHttp => "streamable_http",
    }
}

/// 脱敏：解析 JSON 对象，全部字符串值替换为 "***"；解析失败返回 None（原样丢弃）。
fn scrub(raw: Option<&str>) -> Option<String> {
    let s = raw?;
    let obj: Map<String, Value> = serde_json::from_str(s).ok()?;
    let mut out = Map::new();
    for (k, _v) in obj {
        out.insert(k, Value::String("***".into()));
    }
    serde_json::to_string(&Value::Object(out)).ok()
}

/// 从 settings 读取同步配置（仓库路径 / 是否含敏感信息）。
pub fn read_sync_settings(conn: &rusqlite::Connection) -> (Option<PathBuf>, bool) {
    let all = crate::db::get_all_settings(conn).unwrap_or_default();
    let path = all
        .iter()
        .find(|(k, _)| k == "sync_repo_path")
        .and_then(|(_, v)| if v.trim().is_empty() { None } else { Some(PathBuf::from(v)) });
    let secrets = all
        .iter()
        .find(|(k, _)| k == "sync_include_secrets")
        .map(|(_, v)| v == "1")
        .unwrap_or(false);
    (path, secrets)
}

/* ---------- 测试 ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 文件名安全化() {
        assert_eq!(safe_name("a/b:c*d"), "a_b_c_d");
        assert_eq!(safe_name("普通名称"), "普通名称");
    }

    #[test]
    fn 脱敏替换全部值() {
        let raw = r#"{"Authorization":"Bearer sk-123","X-A":"1"}"#;
        let out = scrub(Some(raw)).unwrap();
        let map: Map<String, Value> = serde_json::from_str(&out).unwrap();
        assert!(map.values().all(|v| v == "***"));
        assert!(scrub(Some("not json")).is_none());
        assert!(scrub(None).is_none());
    }
}

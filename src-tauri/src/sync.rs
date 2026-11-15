//! Git 同步模块：项目配置与 git 仓库之间的导入/导出。
//!
//! 两种模式：
//! - **项目级**（主要入口）：每个项目可绑定自己的 git 仓库目录（`projects.sync_dir`），
//!   资源树中直接推送/拉取/切分支。仓库根即项目根：`tree.json` + `servers/<别名>.json`。
//! - **全局级**（设置页）：把全部项目导出到统一仓库的 `projects/<项目名>/` 子目录。
//!
//! 通用规则：
//! - 只扫描/读写 `.json` 文件；解析失败的文件记入日志并跳过，绝不静默加载
//! - 同一项目下 Server 别名（即文件名）不允许重名，导出/导入均校验
//! - 导入为覆盖语义：会先清空本地同名项目的树再按仓库内容重建
//! - 默认脱敏导出（headers/env 值替换 `***`），可显式开启明文
//! - git 操作通过 CLI（tokio::process / std::process），参数数组形式，无 shell 注入

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::AppHandle;

use crate::db::Db;
use crate::models::{LogEntry, NodeType, Project, ServerConfig, TransportType};
use crate::mcp_manager::McpManager;

/// 单个导出的树节点。
#[derive(Debug, Serialize, Deserialize)]
struct SyncNode {
    /// 稳定引用 ID（导出时生成，如 "n0"，仅在同一 tree.json 内有意义）
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

/// 日志快捷构造。
fn entry(level: &str, message: String) -> LogEntry {
    LogEntry {
        level: level.into(),
        message,
    }
}

/* ==================== 项目级同步（资源树推送/拉取） ==================== */

/// 推送项目到其绑定的 git 仓库：导出 JSON -> commit -> push。
pub async fn push_project(app: &AppHandle, db: &Db, project_id: i64) -> Vec<LogEntry> {
    let mut logs = Vec::new();
    let (project, include_secrets) = {
        let conn = db.0.lock().unwrap();
        let p = match crate::db::get_project(&conn, project_id) {
            Ok(p) => p,
            Err(e) => {
                logs.push(entry("error", format!("读取项目失败：{e}")));
                return logs;
            }
        };
        let secrets = crate::db::get_all_settings(&conn)
            .unwrap_or_default()
            .iter()
            .any(|(k, v)| k == "sync_include_secrets" && v == "1");
        (p, secrets)
    };
    let Some(dir) = project.sync_dir.clone() else {
        logs.push(entry("warn", format!("项目「{}」未开启同步（未绑定目录）", project.name)));
        return logs;
    };
    let repo = std::path::PathBuf::from(&dir);
    if !repo.is_dir() {
        logs.push(entry("error", format!("同步目录不存在：{dir}")));
        return logs;
    }
    ensure_git_repo(&repo, &mut logs).await;

    if let Err(e) = git_async(&repo, &["pull", "--ff-only"]).await {
        logs.push(entry("warn", format!("git pull 失败（继续推送本地内容）：{e}")));
    }

    // 导出该项目
    let data = load_project_data(db, &project, include_secrets, &mut logs);
    if let Some((nodes, servers)) = data {
        if let Err(e) = write_project_files(&repo, &project.name, &nodes, &servers) {
            logs.push(entry("error", format!("写入同步文件失败：{e}")));
            return logs;
        }
        logs.push(entry("info", format!(
            "项目「{}」已导出：{} 个节点 / {} 个 Server（{}）",
            project.name,
            nodes.len(),
            servers.len(),
            if include_secrets { "含敏感信息" } else { "已脱敏" }
        )));
    } else {
        return logs;
    }

    // 提交并推送
    let _ = git_async(&repo, &["add", "-A"]).await;
    match git_async(&repo, &["-c", "user.name=MCPilot", "-c", "user.email=mcpilot@local", "commit", "-m", "MCPilot 配置同步"]).await {
        Ok(_) => {
            logs.push(entry("info", "已提交到本地仓库".into()));
            match git_async(&repo, &["push"]).await {
                Ok(_) => logs.push(entry("info", "已推送到远端".into())),
                Err(e) => logs.push(entry("warn", format!("git push 失败（本地提交已完成，可稍后手动推送）：{e}"))),
            }
        }
        Err(e) => {
            if e.contains("nothing to commit") {
                logs.push(entry("info", "内容无变化，未产生新提交".into()));
            } else {
                logs.push(entry("error", format!("git commit 失败：{e}")));
            }
        }
    }
    let _ = app;
    logs
}

/// 从项目绑定的 git 仓库拉取并导入（覆盖该项目当前配置）。
pub async fn pull_project(app: &AppHandle, db: &Db, project_id: i64) -> Vec<LogEntry> {
    let mut logs = Vec::new();
    let project = {
        let conn = db.0.lock().unwrap();
        match crate::db::get_project(&conn, project_id) {
            Ok(p) => p,
            Err(e) => {
                logs.push(entry("error", format!("读取项目失败：{e}")));
                return logs;
            }
        }
    };
    let Some(dir) = project.sync_dir.clone() else {
        logs.push(entry("warn", format!("项目「{}」未开启同步（未绑定目录）", project.name)));
        return logs;
    };
    let repo = std::path::PathBuf::from(&dir);
    if !repo.is_dir() {
        logs.push(entry("error", format!("同步目录不存在：{dir}")));
        return logs;
    }
    if let Err(e) = git_async(&repo, &["pull", "--ff-only"]).await {
        logs.push(entry("warn", format!("git pull 失败（使用本地仓库当前内容）：{e}")));
    }

    import_tree_dir(&repo, app, db, Some(&project), &mut logs).await;
    logs
}

/* ==================== 全局同步（设置页导出/导入全部） ==================== */

/// 导出全部项目到统一仓库（settings 配置的 sync_repo_path）。
pub async fn export_all(app: &AppHandle, db: &Db, repo: &Path, include_secrets: bool) -> Vec<LogEntry> {
    let mut logs = Vec::new();
    if !repo.is_dir() {
        logs.push(entry("error", format!("仓库目录不存在：{}", repo.display())));
        return logs;
    }
    ensure_git_repo(repo, &mut logs).await;
    if let Err(e) = git_async(repo, &["pull", "--ff-only"]).await {
        logs.push(entry("warn", format!("git pull 失败（继续导出本地内容）：{e}")));
    }

    let projects = {
        let conn = db.0.lock().unwrap();
        crate::db::list_projects(&conn).unwrap_or_default()
    };
    if projects.is_empty() {
        logs.push(entry("warn", "没有任何项目可导出".into()));
        return logs;
    }
    let projects_root = repo.join("projects");
    for project in &projects {
        let data = load_project_data(db, project, include_secrets, &mut logs);
        let Some((nodes, servers)) = data else { continue };
        let dir = projects_root.join(safe_name(&project.name));
        if let Err(e) = write_project_files(&dir, &project.name, &nodes, &servers) {
            logs.push(entry("error", format!("写入 {} 失败：{e}", dir.display())));
            continue;
        }
        logs.push(entry("info", format!(
            "项目「{}」已导出：{} 个节点 / {} 个 Server（{}）",
            project.name,
            nodes.len(),
            servers.len(),
            if include_secrets { "含敏感信息" } else { "已脱敏" }
        )));
    }

    let _ = git_async(repo, &["add", "-A"]).await;
    match git_async(repo, &["-c", "user.name=MCPilot", "-c", "user.email=mcpilot@local", "commit", "-m", "MCPilot 配置同步"]).await {
        Ok(_) => {
            logs.push(entry("info", "已提交到本地 git 仓库".into()));
            match git_async(repo, &["push"]).await {
                Ok(_) => logs.push(entry("info", "已推送到远端".into())),
                Err(e) => logs.push(entry("warn", format!("git push 失败（本地提交已完成）：{e}"))),
            }
        }
        Err(e) => {
            if e.contains("nothing to commit") {
                logs.push(entry("info", "内容无变化，未产生新提交".into()));
            } else {
                logs.push(entry("error", format!("git commit 失败：{e}")));
            }
        }
    }
    let _ = app;
    logs
}

/// 从统一仓库导入全部项目（覆盖同名项目）。
pub async fn import_all(app: &AppHandle, db: &Db, repo: &Path) -> Vec<LogEntry> {
    let mut logs = Vec::new();
    if !repo.is_dir() {
        logs.push(entry("error", format!("仓库目录不存在：{}", repo.display())));
        return logs;
    }
    if let Err(e) = git_async(repo, &["pull", "--ff-only"]).await {
        logs.push(entry("warn", format!("git pull 失败（使用本地仓库当前内容）：{e}")));
    }
    let projects_root = repo.join("projects");
    let entries = match std::fs::read_dir(&projects_root) {
        Ok(e) => e,
        Err(_) => {
            logs.push(entry("warn", format!("仓库中没有 projects 目录（{}）", projects_root.display())));
            return logs;
        }
    };
    for entry_path in entries.flatten() {
        let dir = entry_path.path();
        if dir.is_dir() {
            import_tree_dir(&dir, app, db, None, &mut logs).await;
        }
    }
    logs
}

/* ==================== 分支管理 ==================== */

/// 分支信息：当前分支 + 全部本地分支。
#[derive(Debug, Serialize)]
pub struct BranchInfo {
    /// 当前分支名
    pub current: String,
    /// 全部本地分支名
    pub branches: Vec<String>,
}

/// 列出仓库的本地分支与当前分支（同步命令，git 查询毫秒级）。
pub fn git_branches(dir: &Path) -> Result<BranchInfo, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .output()
        .map_err(|e| format!("git 未安装或执行失败：{e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let branches: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    let current = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("git 执行失败：{e}"))?;
    let current = if current.status.success() {
        String::from_utf8_lossy(&current.stdout).trim().to_string()
    } else {
        "(main)".into() // 空仓库尚无提交
    };
    Ok(BranchInfo { current, branches })
}

/// 切换仓库分支。
pub fn git_checkout(dir: &Path, branch: &str) -> Result<(), String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["checkout", branch])
        .output()
        .map_err(|e| format!("git 执行失败：{e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/* ==================== 内部实现 ==================== */

/// 目录不是 git 仓库时自动 init。
async fn ensure_git_repo(repo: &Path, logs: &mut Vec<LogEntry>) {
    if !repo.join(".git").exists() {
        match git_async(repo, &["init"]).await {
            Ok(_) => logs.push(entry("info", format!("{} 不是 git 仓库，已自动 git init", repo.display()))),
            Err(e) => logs.push(entry("error", format!("git init 失败：{e}"))),
        }
    }
}

/// 读取项目全部节点与配置，生成（树节点列表 + server 文件列表）。
///
/// 重名 server 跳过并记日志；读取失败返回 None（日志已写入）。
fn load_project_data(
    db: &Db,
    project: &Project,
    include_secrets: bool,
    logs: &mut Vec<LogEntry>,
) -> Option<(Vec<SyncNode>, Vec<(String, SyncServer)>)> {
    let conn = db.0.lock().unwrap();
    let nodes = match crate::db::list_nodes(&conn, project.id) {
        Ok(n) => n,
        Err(e) => {
            logs.push(entry("error", format!("项目「{}」读取节点失败：{e}", project.name)));
            return None;
        }
    };

    // 生成稳定 ID 并检测重名（重名的 server 不参与导出）
    let mut id_of: HashMap<i64, String> = HashMap::new();
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut sync_nodes: Vec<SyncNode> = Vec::new();
    let mut kept_ids: Vec<i64> = Vec::new();
    for (i, n) in nodes.iter().enumerate() {
        if n.node_type == NodeType::Server && !used.insert(n.name.clone()) {
            logs.push(entry("warn", format!(
                "项目「{}」存在同名 Server「{}」，同目录配置不允许重名，已跳过导出该项",
                project.name, n.name
            )));
            continue;
        }
        let sid = format!("n{i}");
        id_of.insert(n.id, sid.clone());
        kept_ids.push(n.id);
        sync_nodes.push(SyncNode {
            id: sid,
            parent: None, // 下面统一补
            node_type: if n.node_type == NodeType::Folder { "folder" } else { "server" }.into(),
            name: n.name.clone(),
            order: n.sort_order,
        });
    }
    // 补 parent 引用（此时所有保留节点的 ID 已生成）
    let mut idx = 0;
    for n in &nodes {
        if !kept_ids.contains(&n.id) {
            continue;
        }
        sync_nodes[idx].parent = n.parent_id.and_then(|p| id_of.get(&p).cloned());
        idx += 1;
    }

    // server 配置文件
    let mut servers = Vec::new();
    for n in &nodes {
        if n.node_type != NodeType::Server || !id_of.contains_key(&n.id) {
            continue;
        }
        let cfg = match crate::db::get_server_config(&conn, n.id) {
            Ok(c) => c,
            Err(_) => continue,
        };
        servers.push((safe_name(&n.name), SyncServer {
            parent: n.parent_id.and_then(|p| id_of.get(&p).cloned()),
            transport_type: transport_str(cfg.transport_type).into(),
            command: cfg.command,
            args: cfg.args,
            env: if include_secrets { cfg.env } else { scrub(cfg.env.as_deref()) },
            working_dir: cfg.working_dir,
            url: cfg.url,
            headers: if include_secrets { cfg.headers } else { scrub(cfg.headers.as_deref()) },
            timeout_ms: cfg.timeout_ms,
            enabled: cfg.enabled,
            note: cfg.note,
        }));
    }
    Some((sync_nodes, servers))
}

/// 把单个项目的数据写入目录（tree.json + servers/*.json，先清空重建防残留）。
fn write_project_files(
    dir: &Path,
    project_name: &str,
    nodes: &[SyncNode],
    servers: &[(String, SyncServer)],
) -> Result<(), String> {
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| format!("清理旧目录失败：{e}"))?;
    }
    std::fs::create_dir_all(dir.join("servers")).map_err(|e| format!("创建目录失败：{e}"))?;
    let tree = serde_json::json!({ "project": project_name, "nodes": nodes });
    std::fs::write(dir.join("tree.json"), serde_json::to_string_pretty(&tree).unwrap_or_default() + "\n")
        .map_err(|e| format!("写入 tree.json 失败：{e}"))?;
    for (file, ss) in servers {
        std::fs::write(
            dir.join("servers").join(format!("{file}.json")),
            serde_json::to_string_pretty(ss).unwrap_or_default() + "\n",
        )
        .map_err(|e| format!("写入 servers/{file}.json 失败：{e}"))?;
    }
    Ok(())
}

/// 从「项目目录」（含 tree.json + servers/）导入：覆盖 `project`（None 时按 tree.json 里的项目名匹配/创建）。
async fn import_tree_dir(
    dir: &Path,
    app: &AppHandle,
    db: &Db,
    fixed: Option<&Project>,
    logs: &mut Vec<LogEntry>,
) {
    let tree_path = dir.join("tree.json");
    if !tree_path.is_file() {
        logs.push(entry("warn", format!("跳过 {}：缺少 tree.json", dir.display())));
        return;
    }
    // 损坏文件：提示且不加载
    let (project_name, nodes) = match parse_tree(&tree_path) {
        Ok(v) => v,
        Err(e) => {
            logs.push(entry("error", e));
            return;
        }
    };
    // 读取 servers/*.json（只扫描 .json），重名跳过
    let mut servers: Vec<(String, SyncServer)> = Vec::new();
    if let Ok(files) = std::fs::read_dir(dir.join("servers")) {
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
                Err(e) => logs.push(entry("error", format!(
                    "文件已损坏，跳过加载：{} 解析失败（{e}）", p.display()
                ))),
            }
        }
    }
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    servers.retain(|(a, _)| used.insert(a.clone()));

    // 定位/创建目标项目
    let project_id = match fixed {
        Some(p) => p.id,
        None => {
            let conn = db.0.lock().unwrap();
            let existing = crate::db::list_projects(&conn).unwrap_or_default();
            match existing.into_iter().find(|p| p.name == project_name) {
                Some(p) => p.id,
                None => match crate::db::create_project(&conn, &project_name, None) {
                    Ok(p) => p.id,
                    Err(e) => {
                        logs.push(entry("error", format!("创建项目「{project_name}」失败：{e}")));
                        return;
                    }
                },
            }
        }
    };

    // 覆盖：断开该项目全部连接 -> 清空节点 -> 重建
    let removed = {
        let conn = db.0.lock().unwrap();
        crate::db::delete_project_nodes(&conn, project_id)
    };
    match removed {
        Ok(ids) => {
            for node_id in ids {
                McpManager::disconnect(app.clone(), node_id).await.ok();
            }
        }
        Err(e) => {
            logs.push(entry("error", format!("清空旧节点失败：{e}")));
            return;
        }
    }

    // 建目录树（拓扑序：父节点先建；成环/缺父的节点跳过并记日志）
    let mut id_map: HashMap<String, i64> = HashMap::new();
    let mut pending: Vec<&SyncNode> = nodes.iter().collect();
    let mut guard = 0;
    while !pending.is_empty() {
        guard += 1;
        if guard > 1000 {
            logs.push(entry("error", format!("项目「{project_name}」节点引用疑似成环，未挂载的节点已跳过")));
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
            let result = {
                let conn = db.0.lock().unwrap();
                crate::db::create_node(&conn, project_id, parent_id, node_type, &n.name)
                    .map_err(|e| e.to_string())
            };
            match result {
                Ok(t) => {
                    id_map.insert(n.id.clone(), t.id);
                    progress = true;
                    false
                }
                Err(e) => {
                    logs.push(entry("error", format!("创建节点「{}」失败：{e}", n.name)));
                    false
                }
            }
        });
        if !progress {
            for n in &pending {
                logs.push(entry("warn", format!("节点「{}」的父节点缺失，已跳过", n.name)));
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
                logs.push(entry("warn", format!("Server「{alias}」transport_type 非法（{other}），跳过")));
                continue;
            }
        };
        let parent_db = ss.parent.as_deref().and_then(|p| id_map.get(p).copied());
        let node = {
            let conn = db.0.lock().unwrap();
            crate::db::create_node(&conn, project_id, parent_db, NodeType::Server, alias)
                .map_err(|e| e.to_string())
        };
        let node = match node {
            Ok(n) => n,
            Err(e) => {
                logs.push(entry("error", format!("创建 Server「{alias}」失败：{e}")));
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
            envs: None,
            active_env: None,
        };
        let saved = {
            let conn = db.0.lock().unwrap();
            crate::db::upsert_server_config(&conn, &cfg).map_err(|e| e.to_string())
        };
        match saved {
            Ok(_) => ok += 1,
            Err(e) => logs.push(entry("error", format!("保存 Server「{alias}」配置失败：{e}"))),
        }
    }
    let folders = nodes.iter().filter(|n| n.node_type == "folder").count();
    logs.push(entry("info", format!(
        "项目「{project_name}」导入完成：{folders} 目录 / {ok} Server（覆盖当前配置）"
    )));
}

/// 解析 tree.json，返回（项目名, 节点列表）；失败返回错误日志条目。
fn parse_tree(path: &Path) -> Result<(String, Vec<SyncNode>), String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("tree.json 读取失败（{}）：{e}", path.display()))?;
    let tree: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("文件已损坏，跳过加载：{} 解析失败（{e}）", path.display()))?;
    let name = tree["project"].as_str().unwrap_or_default().to_string();
    if name.is_empty() {
        return Err(format!("tree.json 缺少 project 字段，跳过：{}", path.display()));
    }
    let nodes: Vec<SyncNode> = serde_json::from_value(tree["nodes"].clone())
        .map_err(|e| format!("文件已损坏，跳过加载：{} nodes 解析失败（{e}）", path.display()))?;
    Ok((name, nodes))
}

/// 执行 git 子命令（async 版，工作目录为 repo）。
async fn git_async(repo: &Path, args: &[&str]) -> Result<String, String> {
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
        Err(format!("git {}：{}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
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

/// 脱敏：解析 JSON 对象，全部字符串值替换为 "***"；解析失败返回 None。
fn scrub(raw: Option<&str>) -> Option<String> {
    let s = raw?;
    let obj: Map<String, Value> = serde_json::from_str(s).ok()?;
    let mut out = Map::new();
    for (k, _v) in obj {
        out.insert(k, Value::String("***".into()));
    }
    serde_json::to_string(&Value::Object(out)).ok()
}

/// 从 settings 读取全局同步配置（仓库路径 / 是否含敏感信息）。
pub fn read_sync_settings(conn: &rusqlite::Connection) -> (Option<std::path::PathBuf>, bool) {
    let all = crate::db::get_all_settings(conn).unwrap_or_default();
    let path = all
        .iter()
        .find(|(k, _)| k == "sync_repo_path")
        .and_then(|(_, v)| if v.trim().is_empty() { None } else { Some(std::path::PathBuf::from(v)) });
    let secrets = all
        .iter()
        .find(|(k, _)| k == "sync_include_secrets")
        .map(|(_, v)| v == "1")
        .unwrap_or(false);
    (path, secrets)
}

/// 准备项目同步目录：展开 ~、创建目录、必要时 git init。返回可用的仓库路径。
pub fn prepare_sync_dir(raw: &str) -> Result<std::path::PathBuf, String> {
    let expanded = if let Some(rest) = raw.strip_prefix("~/") {
        let home = std::env::var("HOME").map_err(|_| "无法确定用户主目录".to_string())?;
        std::path::PathBuf::from(home).join(rest)
    } else {
        std::path::PathBuf::from(raw)
    };
    if !expanded.exists() {
        std::fs::create_dir_all(&expanded).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    if !expanded.is_dir() {
        return Err(format!("{} 不是目录", expanded.display()));
    }
    if !expanded.join(".git").exists() {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&expanded)
            .arg("init")
            .output()
            .map_err(|e| format!("git 未安装或执行失败：{e}"))?;
        if !out.status.success() {
            return Err(format!("git init 失败：{}", String::from_utf8_lossy(&out.stderr).trim()));
        }
    }
    Ok(expanded)
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

    #[test]
    fn 解析合法与损坏的tree() {
        let dir = std::env::temp_dir().join("mcpilot-sync-test");
        std::fs::create_dir_all(&dir).unwrap();
        // 合法
        std::fs::write(dir.join("good.json"), r#"{"project":"p","nodes":[{"id":"n0","parent":null,"type":"folder","name":"f","order":0}]}"#).unwrap();
        let (name, nodes) = parse_tree(&dir.join("good.json")).unwrap();
        assert_eq!(name, "p");
        assert_eq!(nodes.len(), 1);
        // 损坏
        std::fs::write(dir.join("bad.json"), "{oops").unwrap();
        assert!(parse_tree(&dir.join("bad.json")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

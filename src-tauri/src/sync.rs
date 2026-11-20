//! Git 同步模块：项目配置与 git 仓库之间的导入/导出。
//!
//! **项目级同步**（唯一模式）：每个项目可绑定自己的 git 仓库目录（`projects.sync_dir`），
//! 资源树中直接推送/拉取/切分支。仓库目录结构**镜像资源树**：分组 = 真实子目录、
//! Server = 其分组目录下的 `<别名>.json`（根层 Server 直接放仓库根），另有 `tree.json`
//! 记录结构元数据（原名 / 层级引用 / 排序），两者配合完成高保真往返。
//!
//! 通用规则：
//! - 只扫描/读写 `.json` 文件；解析失败的文件记入日志并跳过，绝不静默加载
//! - 同目录同类型节点名称不允许重名（工具内新建/重命名/移动时实时校验拦截）；
//!   磁盘名仍冲突时（历史数据、安全化字符归并）自动追加 `-2`、`-3` 后缀消解，
//!   导出/导入共用同一推导函数（`compute_layout`），往返一致
//! - **跨目录同名 Server 完全合法**（旧版拍平布局会被跳过导出，现已解除该限制）
//! - 空分组目录写 `.gitkeep` 占位（git 不跟踪空目录）；导入只认 `.json`，占位自动忽略
//! - 拉取兼容旧版拍平布局（`servers/*.json`）：按新布局找不到文件时回退旧路径；
//!   存量仓库首次推送会自动升级为新布局
//! - 导入为覆盖语义：会先清空本地同名项目的树再按仓库内容重建
//! - **配置明文导出**：env / headers / 环境组写入真实值，json 即完整可用配置
//!   （同步目录与远端仓库将包含明文鉴权信息，请勿推送到公开远端）
//! - git 操作通过 CLI（tokio::process / std::process），参数数组形式，无 shell 注入

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
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

/// 单个导出的 Server 配置（`<分组路径>/<别名>.json` 的内容）。
///
/// 可选字段均带 `#[serde(default)]`：手工往分组目录放置配置文件时，
/// 只需 `transport_type` / `timeout_ms` / `enabled` 三个必填字段即可被拉取加载。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncServer {
    /// 挂载的目录引用 ID；null 表示根层（手工放置的文件按所在目录挂载，此字段可省略）
    #[serde(default)]
    parent: Option<String>,
    /// 传输类型：stdio / streamable_http
    transport_type: String,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Option<String>,
    #[serde(default)]
    env: Option<String>,
    #[serde(default)]
    working_dir: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: Option<String>,
    /// 敏感请求头名称列表（JSON 数组字符串）：仅是头名称、非敏感值，导出导入原样透传，
    /// 使拉取方保留「展示打码」标记（headers 值本身明文导出）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sensitive_headers: Option<String>,
    /// 环境组（组名 -> {env, headers, sensitive_headers} 的 JSON 字符串）：
    /// 明文导出导入，完整保留多套环境
    #[serde(default, skip_serializing_if = "Option::is_none")]
    envs: Option<String>,
    /// 激活的环境组名（非敏感值，导出导入原样透传）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_env: Option<String>,
    timeout_ms: i64,
    enabled: bool,
    #[serde(default)]
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
///
/// `message` 为用户填写的提交信息（前端推送弹窗传入）：去首尾空白后非空才使用，
/// 否则回退默认提交信息「MCPilot 配置同步」。提交与推送日志均携带当前分支名，
/// 便于用户确认推送目标。
pub async fn push_project(
    app: &AppHandle,
    db: &Db,
    project_id: i64,
    message: Option<String>,
) -> Vec<LogEntry> {
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
    ensure_git_repo(&repo, &mut logs).await;
    let branch = current_branch(&repo).await;

    // 同步远端基线。实时同步（自动导出）让工作树常驻未提交改动，脏树直接 pull
    // 会因文件冲突失败，加 --autostash 先暂存本地改动、拉取后自动恢复
    // （随后 add -A 提交的仍是本地导出的完整内容）
    let dirty = git_async(&repo, &["status", "--porcelain"])
        .await
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let pull_args: Vec<&str> = if dirty {
        vec!["pull", "--ff-only", "--autostash"]
    } else {
        vec!["pull", "--ff-only"]
    };
    if let Err(e) = git_async(&repo, &pull_args).await {
        logs.push(entry("warn", format!("git pull 失败（分支 {branch}，继续推送本地内容）：{e}")));
    }

    // 导出该项目（配置明文，json 即完整可用配置）
    let data = load_project_data(db, &project, &mut logs);
    if let Some((nodes, servers)) = data {
        if let Err(e) = write_project_files(&repo, &project.name, &nodes, &servers) {
            logs.push(entry("error", format!("写入同步文件失败：{e}")));
            return logs;
        }
        logs.push(entry("info", format!(
            "项目「{}」已导出：{} 个节点 / {} 个 Server（明文，含鉴权信息）",
            project.name,
            nodes.len(),
            servers.len()
        )));
    } else {
        return logs;
    }

    // 提交并推送（提交信息：用户填写优先，留空回退默认）
    let commit_msg = message
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| "MCPilot 配置同步".into());
    let _ = git_async(&repo, &["add", "-A"]).await;
    match git_async(&repo, &["-c", "user.name=MCPilot", "-c", "user.email=mcpilot@local", "commit", "-m", &commit_msg]).await {
        Ok(_) => {
            logs.push(entry("info", format!("已提交到本地仓库（分支 {branch}）")));
            match git_async(&repo, &["push"]).await {
                Ok(_) => logs.push(entry("info", format!("已推送到远端（分支 {branch}）"))),
                Err(e) => logs.push(entry("warn", format!("git push 失败（分支 {branch}，本地提交已完成，可稍后手动推送）：{e}"))),
            }
        }
        Err(e) => {
            if e.contains("nothing to commit") {
                logs.push(entry("info", "内容无变化，未产生新提交".into()));
            } else {
                logs.push(entry("error", format!("git commit 失败（分支 {branch}）：{e}")));
            }
        }
    }
    let _ = app;
    logs
}

/// 从项目绑定的 git 仓库拉取并导入（覆盖该项目当前配置）。
///
/// 有远端时 `git fetch` 后从远端分支快照导入（`export_git_tree` 导出到临时目录，
/// **不触碰当前工作树**——实时同步让工作树常驻未提交改动，直接 pull 会与之冲突）；
/// 导入完成后把结果回写工作树，文件与工具内数据保持一致（git 状态归零，推送无噪音）。
/// 无远端时沿用旧流程：导入本地仓库当前文件（用于手工编辑 json 后加载）。
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

    // 拉取来源：远端分支快照（临时目录）或本地仓库当前文件
    let has_remote = git_async(&repo, &["remote"])
        .await
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let mut snapshot: Option<std::path::PathBuf> = None;
    let branch = current_branch(&repo).await;
    if has_remote {
        match git_async(&repo, &["fetch", "--prune"]).await {
            Err(e) => logs.push(entry("warn", format!(
                "git fetch 失败（分支 {branch}，改用本地仓库当前内容导入）：{e}"))),
            Ok(_) => match export_git_tree(&repo, &format!("origin/{branch}")) {
                Ok(tmp) => snapshot = Some(tmp),
                Err(e) => logs.push(entry("warn", format!(
                    "读取远端分支快照失败（{e}），改用本地仓库当前内容导入"))),
            },
        }
    }

    // 拉取前检测：本地与导入来源内容存在差异 = 本地有未推送的改动，
    // 覆盖导入会丢失这些差异，提醒用户先推送
    let source = snapshot.clone().unwrap_or_else(|| repo.clone());
    if let Some((local_nodes, local_servers)) = load_project_data(db, &project, &mut logs) {
        if local_has_unpushed_changes(&source, &local_nodes, &local_servers) {
            logs.push(entry("warn",
                "检测到本地与仓库内容存在差异（本地有未推送的改动），拉取将覆盖本地配置；建议先推送再拉取".into()));
        }
    }

    import_tree_dir(&source, app, db, Some(&project), &mut logs).await;
    if let Some(tmp) = snapshot {
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // 导入完成后把当前数据回写工作树：文件与工具内数据一致（实时同步语义），
    // 工作树归零后后续推送无噪音；失败不阻断（下次变更/推送会自动重试）
    if has_remote {
        if let Some((nodes, servers)) = load_project_data(db, &project, &mut logs) {
            if let Err(e) = write_project_files(&repo, &project.name, &nodes, &servers) {
                logs.push(entry("warn", format!("回写同步目录失败（下次推送/变更时会自动重试）：{e}")));
            }
        }
    }
    logs
}

/// 取仓库当前分支名（仅用于日志与提示展示）。
///
/// 优先 `git branch --show-current`：尚无提交的空仓库也能取到分支名；
/// detached HEAD 或命令失败时返回「?」占位。
async fn current_branch(repo: &Path) -> String {
    git_async(repo, &["branch", "--show-current"])
        .await
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "?".into())
}

/// 项目绑定新的空同步目录后，把项目当前数据迁移进去：导出 JSON + 创建初始提交。
///
/// 与推送不同：不执行 git pull（新目录是空仓库，无历史可拉）、不执行 git push
/// （新目录通常尚未配置远端），只做本地导出与提交；用户随后可正常推送/拉取。
/// 项目没有任何节点与 Server 时跳过迁移（仅完成绑定），日志里给出说明。
pub async fn migrate_project_to_dir(db: &Db, project_id: i64, dir: &Path) -> Vec<LogEntry> {
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
    let repo = dir.to_path_buf();
    if !repo.is_dir() {
        logs.push(entry("error", format!("同步目录不存在：{}", dir.display())));
        return logs;
    }

    let data = load_project_data(db, &project, &mut logs);
    let Some((nodes, servers)) = data else {
        return logs;
    };
    if nodes.is_empty() && servers.is_empty() {
        logs.push(entry("info", format!("项目「{}」暂无数据，同步目录已绑定（待首次推送生成内容）", project.name)));
        return logs;
    }

    if let Err(e) = write_project_files(&repo, &project.name, &nodes, &servers) {
        logs.push(entry("error", format!("迁移写入失败：{e}")));
        return logs;
    }
    logs.push(entry("info", format!(
        "项目「{}」数据已迁移到同步目录：{} 个节点 / {} 个 Server（明文，含鉴权信息）",
        project.name,
        nodes.len(),
        servers.len()
    )));

    let _ = git_async(&repo, &["add", "-A"]).await;
    match git_async(&repo, &["-c", "user.name=MCPilot", "-c", "user.email=mcpilot@local", "commit", "-m", "MCPilot 初始化项目同步"]).await {
        Ok(_) => logs.push(entry("info", "已创建初始提交".into())),
        Err(e) => {
            if !e.contains("nothing to commit") {
                logs.push(entry("error", format!("git commit 失败：{e}")));
            }
        }
    }
    logs
}

/* ==================== 自动导出（实时同步） ==================== */

/// 同步目录写盘互斥：自动导出 / 手动推送 / 拉取回写并发时防止交错写坏文件。
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 把项目当前配置全量导出到同步目录（不含任何 git 操作）。
///
/// 「实时同步」核心：树/配置变更后由前端防抖调用（`project_sync_export` 命令），
/// 保持同步目录文件与工具内数据一致——文件始终可看、可被第三方工具读取，
/// git 提交/推送节奏仍由用户手动控制。
/// 成功时静默（返回空日志，不打扰连续操作）；失败返回 warn 日志（操作本身不受影响，
/// 推送时会显示 git 层面的详细错误）。项目未绑定同步目录时静默跳过。
pub fn export_project_dir(db: &Db, project_id: i64) -> Vec<LogEntry> {
    let mut logs = Vec::new();
    let project = {
        let conn = db.0.lock().unwrap();
        match crate::db::get_project(&conn, project_id) {
            Ok(p) => p,
            Err(e) => {
                logs.push(entry("warn", format!("自动同步失败：读取项目失败：{e}")));
                return logs;
            }
        }
    };
    let Some(dir) = project.sync_dir.clone() else {
        return logs; // 未开启同步：静默跳过（自动导出是后台行为）
    };
    let repo = std::path::PathBuf::from(&dir);
    if !repo.is_dir() {
        logs.push(entry("warn", format!("自动同步失败：同步目录不存在：{dir}")));
        return logs;
    }
    let data = load_project_data(db, &project, &mut logs);
    let Some((nodes, servers)) = data else { return logs };
    if let Err(e) = write_project_files(&repo, &project.name, &nodes, &servers) {
        logs.push(entry("warn", format!("自动同步失败（推送时会显示详细错误）：{e}")));
    }
    logs
}

/* ==================== 分支管理 ==================== */

/// 检测本地导出内容与仓库当前内容是否存在差异（= 本地有未推送的改动）。
///
/// 对比 `tree.json` 的 nodes 与全部 Server 配置文件（配置明文导出，无需归一处理）。
/// 仓库缺 `tree.json` / 解析失败视为有差异（空仓库或异常状态都提醒）。
fn local_has_unpushed_changes(
    repo: &Path,
    nodes: &[SyncNode],
    servers: &[(String, SyncServer)],
) -> bool {
    // nodes 直接深比较（serde_json 的 Value 对象比较与键序无关）
    let local_nodes = serde_json::to_value(nodes).unwrap_or(Value::Null);
    let disk_nodes = std::fs::read_to_string(repo.join(TREE_META_FILE))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|tree| tree.get("nodes").cloned());
    let Some(disk_nodes) = disk_nodes else {
        return true;
    };
    if disk_nodes != local_nodes {
        return true;
    }
    let local: HashMap<&str, Value> = servers
        .iter()
        .map(|(rel, ss)| (rel.as_str(), serde_json::to_value(ss).unwrap_or(Value::Null)))
        .collect();
    let disk = match collect_repo_server_values(repo) {
        Ok(v) => v,
        Err(_) => return true,
    };
    if disk.len() != local.len() {
        return true;
    }
    !local.iter().all(|(rel, v)| disk.get(*rel) == Some(v))
}

/// 收集仓库全部 Server 配置文件（相对路径 -> JSON Value；`tree.json` 元数据与 `.git` 除外）。
fn collect_repo_server_values(repo: &Path) -> Result<HashMap<String, Value>, String> {
    let mut out = HashMap::new();
    walk_repo(repo, repo, &mut out)?;
    Ok(out)
}

/// `collect_repo_server_values` 的递归实现。
fn walk_repo(root: &Path, dir: &Path, out: &mut HashMap<String, Value>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if e.file_name() == ".git" {
                continue;
            }
            walk_repo(root, &p, out)?;
        } else if p.extension().and_then(|s| s.to_str()) == Some("json")
            && p != root.join(TREE_META_FILE)
        {
            let rel = p
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if let Ok(v) = serde_json::from_str::<Value>(&std::fs::read_to_string(&p).unwrap_or_default()) {
                out.insert(rel, v);
            }
        }
    }
    Ok(())
}

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
    let mut branches: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    // 当前分支用 branch --show-current：尚无提交的空仓库也能拿到正确分支名
    // （rev-parse HEAD 在空仓库会失败，旧版回退的 "(main)" 在默认分支非 main 时是错的）
    let cur = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["branch", "--show-current"])
        .output()
        .map_err(|e| format!("git 执行失败：{e}"))?;
    let mut current = if cur.status.success() {
        String::from_utf8_lossy(&cur.stdout).trim().to_string()
    } else {
        String::new()
    };
    if current.is_empty() {
        // --show-current 不可用（老版本 git）或 detached HEAD 时回退 rev-parse
        let fallback = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output();
        current = match fallback {
            Ok(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if s.is_empty() || s == "HEAD" { "(无分支)".into() } else { s }
            }
            _ => "(无分支)".into(),
        };
    }
    // 尚无提交的空仓库：refs/heads 为空（分支要等首次提交才「诞生」），但 HEAD 已指向
    // 当前分支名——把当前分支并入列表，避免 UI 出现「显示 main 却说没有任何分支」的矛盾；
    // detached HEAD（current 为「(无分支)」占位）时不并入
    if branches.is_empty() && !current.is_empty() && !current.starts_with('(') {
        branches.push(current.clone());
    }
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

/// 执行 git 子命令（同步版，风格同 `git_branches` / `git_checkout`：短命令毫秒级）。
fn git_sync(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("git 未安装或执行失败：{e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!("git {}：{}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// 把 git 引用（如 `origin/main`）指向的完整树导出到临时目录（拉取远端快照用）。
///
/// 用 `git ls-tree` 枚举、`git show` 逐文件读取：不依赖 tar、**不触碰当前工作树**
/// （实时同步让工作树常驻未提交改动，直接 `git pull` 会与之冲突）。只导出 `.json`
/// 文件（tree.json + Server 配置），`.gitkeep` 等占位无意义跳过；调用方用完负责删除。
///
/// # 异常
///
/// 引用不存在（远端无对应分支）、仓库无任何 json 内容时返回 `Err`，由调用方回退本地导入。
fn export_git_tree(repo: &Path, git_ref: &str) -> Result<std::path::PathBuf, String> {
    // 确认引用存在且指向提交（远端无该分支时在此报错回退）
    git_sync(repo, &["rev-parse", "--verify", &format!("{git_ref}^{{commit}}")])?;
    let listing = git_sync(repo, &["ls-tree", "-r", "--name-only", "-z", git_ref])?;
    let tmp = std::env::temp_dir().join(format!(
        "mcpilot-pull-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("创建临时目录失败：{e}"))?;
    let mut count = 0usize;
    for path in listing.split('\0').filter(|p| !p.is_empty()) {
        // 只导出 json；防御性跳过路径穿越成分（远端仓库内容属于不可信输入）
        if !path.ends_with(".json")
            || path.starts_with('/')
            || path.split('/').any(|c| c == "..")
        {
            continue;
        }
        let content = git_sync(repo, &["show", &format!("{git_ref}:{path}")])?;
        let target = tmp.join(path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建临时目录失败：{e}"))?;
        }
        std::fs::write(&target, content).map_err(|e| format!("写入临时文件失败：{e}"))?;
        count += 1;
    }
    if count == 0 {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("分支「{git_ref}」没有任何 json 配置内容"));
    }
    Ok(tmp)
}

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
/// 文件项为（磁盘相对路径, SyncServer），相对路径由 [`compute_layout`] 按树形镜像布局推导。
/// 全部节点都参与导出：跨目录同名 Server 合法；同目录同名由磁盘名后缀消解兜底
/// （工具内已有重名校验拦截，此处只处理历史遗留数据）。
/// Server 配置（含环境组）**明文**完整写入 json，json 即完整可用配置。
/// 配置读取失败的 Server 记 warn 并从导出剔除（否则对端会收到缺配置文件的节点并整体丢失）。
/// 读取失败返回 None（日志已写入）。
fn load_project_data(
    db: &Db,
    project: &Project,
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

    // 生成稳定引用 ID（全量节点，不再按名字跳过）
    let mut id_of: HashMap<i64, String> = HashMap::new();
    let mut sync_nodes: Vec<SyncNode> = Vec::new();
    for (i, n) in nodes.iter().enumerate() {
        let sid = format!("n{i}");
        id_of.insert(n.id, sid.clone());
        sync_nodes.push(SyncNode {
            id: sid,
            parent: None, // 下面统一补
            node_type: if n.node_type == NodeType::Folder { "folder" } else { "server" }.into(),
            name: n.name.clone(),
            order: n.sort_order,
        });
    }
    // 补 parent 引用（此时全部节点的引用 ID 已生成；父可能排在子后面，需两段循环）
    for (idx, n) in nodes.iter().enumerate() {
        sync_nodes[idx].parent = n.parent_id.and_then(|p| id_of.get(&p).cloned());
    }

    // 读取 Server 配置（含环境组）；读取失败记 warn 并剔除，防止对端收到缺配置文件的节点
    let mut collected: Vec<(String, SyncServer)> = Vec::new();
    let mut failed_refs: std::collections::HashSet<String> = std::collections::HashSet::new();
    for n in &nodes {
        if n.node_type != NodeType::Server {
            continue;
        }
        let cfg = match crate::db::get_server_config(&conn, n.id) {
            Ok(c) => c,
            Err(e) => {
                if let Some(sid) = id_of.get(&n.id) {
                    failed_refs.insert(sid.clone());
                }
                logs.push(entry("warn", format!(
                    "项目「{}」读取 Server「{}」配置失败（{e}），本次导出已跳过该 Server",
                    project.name, n.name
                )));
                continue;
            }
        };
        let Some(sid) = id_of.get(&n.id) else { continue };
        collected.push((sid.clone(), SyncServer {
            parent: n.parent_id.and_then(|p| id_of.get(&p).cloned()),
            transport_type: transport_str(cfg.transport_type).into(),
            command: cfg.command,
            args: cfg.args,
            env: cfg.env,
            working_dir: cfg.working_dir,
            url: cfg.url,
            headers: cfg.headers,
            sensitive_headers: cfg.sensitive_headers,
            envs: cfg.envs,
            active_env: cfg.active_env,
            timeout_ms: cfg.timeout_ms,
            enabled: cfg.enabled,
            note: cfg.note,
        }));
    }
    if !failed_refs.is_empty() {
        sync_nodes.retain(|n| !failed_refs.contains(&n.id));
    }

    // server 配置文件：按树形布局写入各自的分组目录
    let layout = compute_layout(&sync_nodes);
    let mut servers = Vec::new();
    for (sid, ss) in collected {
        if let Some(rel) = layout.get(&sid) {
            servers.push((rel.clone(), ss));
        }
    }
    Some((sync_nodes, servers))
}

/// 把单个项目的数据写入同步目录（树形镜像布局，先清空重建防残留）。
///
/// 布局：`tree.json`（结构元数据）+ 分组目录树 + 各分组目录下的 `<别名>.json`。
/// 不含任何条目的分组目录补 `.gitkeep` 占位——git 不跟踪空目录，否则没有 Server
/// 的分组跨机器 clone 后会消失。
///
/// 全程持有 [`WRITE_LOCK`]：自动导出 / 手动推送 / 拉取回写并发时防止交错写坏文件。
fn write_project_files(
    dir: &Path,
    project_name: &str,
    nodes: &[SyncNode],
    servers: &[(String, SyncServer)],
) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| format!("清理旧目录失败：{e}"))?;
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
    let tree = serde_json::json!({ "project": project_name, "nodes": nodes });
    std::fs::write(dir.join(TREE_META_FILE), serde_json::to_string_pretty(&tree).unwrap_or_default() + "\n")
        .map_err(|e| format!("写入 tree.json 失败：{e}"))?;

    // 分组目录全部落盘（空分组也要存在，目录名经 compute_layout 后缀消解）
    let layout = compute_layout(nodes);
    for n in nodes.iter().filter(|n| n.node_type == "folder") {
        if let Some(rel) = layout.get(&n.id) {
            std::fs::create_dir_all(dir.join(rel))
                .map_err(|e| format!("创建目录「{rel}」失败：{e}"))?;
        }
    }
    // Server 配置文件写入各自的分组目录
    for (rel, ss) in servers {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        std::fs::write(&p, serde_json::to_string_pretty(ss).unwrap_or_default() + "\n")
            .map_err(|e| format!("写入 {rel} 失败：{e}"))?;
    }
    ensure_gitkeep(dir);
    Ok(())
}

/// 递归给不含任何条目的空目录写 `.gitkeep` 占位（后序：先处理子目录再判断自身）。
///
/// `.git` 目录跳过；导入只扫描 `.json`，占位文件不会被当成 Server 加载。
fn ensure_gitkeep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let sub_dirs: Vec<_> = entries
        .flatten()
        .filter(|e| {
            e.file_name() != ".git" && e.file_type().map(|t| t.is_dir()).unwrap_or(false)
        })
        .map(|e| e.path())
        .collect();
    for sub in sub_dirs {
        ensure_gitkeep(&sub);
    }
    if std::fs::read_dir(dir).map(|it| it.count()).unwrap_or(1) == 0 {
        let _ = std::fs::write(dir.join(".gitkeep"), "");
    }
}

/// 从「项目目录」（树形镜像布局）导入：覆盖 `project`（None 时按 tree.json 里的项目名匹配/创建）。
async fn import_tree_dir(
    dir: &Path,
    app: &AppHandle,
    db: &Db,
    fixed: Option<&Project>,
    logs: &mut Vec<LogEntry>,
) {
    let tree_path = dir.join(TREE_META_FILE);
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
    // 解析全部 Server 导入项（tree.json 顺序 + 旧版拍平布局回退 + 额外文件扫描）
    let imports = collect_server_imports(dir, &nodes, logs);

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

    // 重建目录树与 Server
    let conn = db.0.lock().unwrap();
    rebuild_project_tree(&conn, project_id, &project_name, &nodes, &imports, logs);
}

/// 单个待导入的 Server：显示名 + 挂载引用 + 配置内容。
struct ServerImport {
    /// 显示名（tree.json 里的原名，名字保真；额外文件用文件名去 `.json`）
    display_name: String,
    /// 挂载的目录引用 ID（tree.json 引用体系）；None = 根层
    parent: Option<String>,
    /// 配置内容
    server: SyncServer,
}

/// 从同步目录解析全部 Server 导入项（只读文件不写库，便于单元测试）。
///
/// 三个来源，按序：
/// 1. tree.json 登记的 server 节点：按 [`compute_layout`] 推导的路径读取，
///    创建顺序与 tree.json 一致（排序保真）；新布局路径缺文件时回退旧版拍平布局
///    `servers/<安全化别名>.json`（兼容存量仓库）
/// 2. 目录树中的额外 `.json` 文件（用户手工放置）：按文件所在目录反查分组挂载，
///    反查不到回退文件内容的 parent 引用
/// 3. 解析失败的文件记入日志跳过，绝不静默加载
fn collect_server_imports(
    dir: &Path,
    nodes: &[SyncNode],
    logs: &mut Vec<LogEntry>,
) -> Vec<ServerImport> {
    let layout = compute_layout(nodes);
    let mut imports: Vec<ServerImport> = Vec::new();
    // 已消费文件集合（规范化路径，供额外文件扫描去重）
    let mut consumed: std::collections::HashSet<std::path::PathBuf> = std::collections::HashSet::new();

    // 1) tree.json 登记的 server 节点，按 tree.json 顺序读取（显示名直接用节点原名，名字保真）
    for n in nodes.iter().filter(|n| n.node_type == "server") {
        let rel = layout.get(&n.id);
        let (path, via) = match rel {
            Some(rel) => {
                let p = dir.join(rel);
                if p.is_file() {
                    (Some(p), rel.clone())
                } else {
                    // 旧版拍平布局回退：servers/<安全化别名>.json
                    let legacy_rel = format!("servers/{}.json", safe_name(&n.name));
                    let legacy = dir.join(&legacy_rel);
                    if legacy.is_file() {
                        (Some(legacy), legacy_rel)
                    } else {
                        (None, rel.clone())
                    }
                }
            }
            None => (None, String::new()),
        };
        let Some(path) = path else {
            logs.push(entry("warn", format!(
                "Server「{}」缺少配置文件 {}，已跳过", n.name, via
            )));
            continue;
        };
        match read_sync_server(&path) {
            Ok(ss) => {
                if let Some(c) = path.canonicalize().ok() {
                    consumed.insert(c);
                }
                imports.push(ServerImport {
                    display_name: n.name.clone(),
                    parent: ss.parent.clone(),
                    server: ss,
                });
            }
            Err(e) => logs.push(entry("error", format!(
                "文件已损坏，跳过加载：{} 解析失败（{e}）", path.display()
            ))),
        }
    }

    // 2) 额外 .json 文件扫描（目录相对路径 -> 目录节点引用，用于按所在目录挂载）
    let dir_ref_by_path: HashMap<&str, &str> = nodes
        .iter()
        .filter(|n| n.node_type == "folder")
        .filter_map(|n| layout.get(&n.id).map(|p| (p.as_str(), n.id.as_str())))
        .collect();
    scan_extra_servers(dir, dir, &dir_ref_by_path, &mut consumed, &mut imports, logs);
    imports
}

/// 递归扫描目录树中未被登记路径消费的 `.json` 文件，作为「额外 Server」导入
/// （支持用户手工放置配置文件）。挂载分组按文件所在目录反查 tree.json 目录节点，
/// 反查不到回退文件内容的 parent 引用；解析失败记入日志跳过。
fn scan_extra_servers(
    root: &Path,
    dir: &Path,
    dir_ref_by_path: &HashMap<&str, &str>,
    consumed: &mut std::collections::HashSet<std::path::PathBuf>,
    out: &mut Vec<ServerImport>,
    logs: &mut Vec<LogEntry>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if e.file_name() == ".git" {
                continue;
            }
            scan_extra_servers(root, &p, dir_ref_by_path, consumed, out, logs);
            continue;
        }
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        // 仓库根的 tree.json 是结构元数据，不是 Server 文件
        if p == root.join(TREE_META_FILE) {
            continue;
        }
        // 已被 tree.json 登记条目消费过的文件不重复导入
        match p.canonicalize() {
            Ok(c) if consumed.contains(&c) => continue,
            Err(_) => continue, // 文件读取期间被移走，跳过
            Ok(_) => {}
        }
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let ss = match read_sync_server(&p) {
            Ok(ss) => ss,
            Err(err) => {
                logs.push(entry("error", format!(
                    "文件已损坏，跳过加载：{} 解析失败（{err}）", p.display()
                )));
                continue;
            }
        };
        // 挂载分组：文件所在目录的相对路径反查（目录名经同一算法消解，能精确对上）；
        // 反查不到（如旧版 servers/ 平铺目录）回退文件内容的 parent 引用
        let rel_dir = p
            .parent()
            .and_then(|pp| pp.strip_prefix(root).ok())
            .map(|d| d.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let parent = dir_ref_by_path
            .get(rel_dir.as_str())
            .map(|s| s.to_string())
            .or(ss.parent.clone());
        if let Ok(c) = p.canonicalize() {
            consumed.insert(c);
        }
        out.push(ServerImport {
            display_name: stem,
            parent,
            server: ss,
        });
    }
}

/// 读取并反序列化单个 Server 配置文件。
fn read_sync_server(path: &Path) -> Result<SyncServer, String> {
    let s = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

/// 在已清空的项目里重建目录树与 Server（tree.json 顺序 = 同级排序保真）。
///
/// 目录节点按引用拓扑序创建（成环/缺父跳过并记日志）；Server 按导入项顺序创建
/// （挂载引用解析失败 = 根层兜底，transport 非法跳过）；配置完整恢复（含环境组，
/// 明文加载）。结束输出汇总日志。
fn rebuild_project_tree(
    conn: &rusqlite::Connection,
    project_id: i64,
    project_name: &str,
    nodes: &[SyncNode],
    imports: &[ServerImport],
    logs: &mut Vec<LogEntry>,
) {
    // 建目录树（拓扑序：父节点先建；成环/缺父的节点跳过并记日志）。
    // 只重建目录节点——server 节点统一由下方「建 Server 配置」按导入项创建，
    // 否则 tree.json 里的 server 节点会先建出一份无配置的空壳，配置阶段再建一份造成重复。
    let mut id_map: HashMap<String, i64> = HashMap::new();
    let mut pending: Vec<&SyncNode> = nodes.iter().filter(|n| n.node_type == "folder").collect();
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
            let result = crate::db::create_node(conn, project_id, parent_id, NodeType::Folder, &n.name)
                .map_err(|e| e.to_string());
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

    // 建 Server 配置（imports 顺序即 tree.json 顺序，同级排序与导出端一致）
    let mut ok = 0;
    for imp in imports {
        let ss = &imp.server;
        let tt = match ss.transport_type.as_str() {
            "stdio" => TransportType::Stdio,
            "streamable_http" => TransportType::StreamableHttp,
            other => {
                logs.push(entry("warn", format!(
                    "Server「{}」transport_type 非法（{other}），跳过", imp.display_name
                )));
                continue;
            }
        };
        let parent_db = imp.parent.as_deref().and_then(|p| id_map.get(p).copied());
        let node = crate::db::create_node(conn, project_id, parent_db, NodeType::Server, &imp.display_name)
            .map_err(|e| e.to_string());
        let node = match node {
            Ok(n) => n,
            Err(e) => {
                logs.push(entry("error", format!("创建 Server「{}」失败：{e}", imp.display_name)));
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
            sensitive_headers: ss.sensitive_headers.clone(),
            timeout_ms: ss.timeout_ms,
            enabled: ss.enabled,
            note: ss.note.clone(),
            envs: ss.envs.clone(),
            active_env: ss.active_env.clone(),
        };
        match crate::db::upsert_server_config(conn, &cfg).map_err(|e| e.to_string()) {
            Ok(_) => ok += 1,
            Err(e) => logs.push(entry("error", format!(
                "保存 Server「{}」配置失败：{e}", imp.display_name
            ))),
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

/* ---------- 磁盘路径推导（导出 / 导入共用，保证两端一致） ---------- */

/// 结构元数据文件名：仓库根的 tree.json 记录原名 / 层级 / 排序，
/// 根层的目录与 Server 文件名都不允许占用该名字。
const TREE_META_FILE: &str = "tree.json";

/// 由树节点列表推导每个节点的同步磁盘相对路径（树形镜像布局）。
///
/// 规则：
/// - 目录节点 → 相对目录路径；Server 节点 → 所在目录路径 + `<安全化别名>.json`
/// - 目录名 / 文件名经 [`safe_name`] 安全化；同级磁盘名冲突时追加 `-2`、`-3` 后缀消解
///   （占用比较小写折叠，兼容 macOS 等大小写不敏感文件系统）；同级按数组顺序
///   先到先得，结果确定
/// - 分层处理：先定所有层深（[`node_depths`]），再逐层按数组顺序消解，
///   保证父目录路径在子节点处理前已确定
/// - 父引用缺失或成环的节点按根层兜底（导入端其父本就不会创建，行为一致）
///
/// 返回：SyncNode.id -> 相对路径（`/` 分隔；目录不含尾分隔符，Server 含 `.json` 文件名）。
///
/// # 示例
///
/// ```text
/// 节点 [目录A(根), Server x(目录A), Server x(根)]
/// → { "n0": "目录A", "n1": "目录A/x.json", "n2": "x.json" }
/// ```
fn compute_layout(nodes: &[SyncNode]) -> HashMap<String, String> {
    let depths = node_depths(nodes);
    let by_id: HashMap<&str, &SyncNode> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let max_depth = depths.values().copied().max().unwrap_or(0);
    // 目录节点 id -> 已确定的目录路径（Server 文件所在目录由 parent 引用查这里）
    let mut dir_path: HashMap<String, String> = HashMap::new();
    // 父目录路径（"" = 根层）-> 已占用的磁盘名集合（小写折叠）；根层预置元数据文件名
    let mut used: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
    used.insert(
        String::new(),
        [TREE_META_FILE.to_lowercase()].into_iter().collect(),
    );
    let mut layout = HashMap::new();
    for depth in 0..=max_depth {
        // 同层内严格按数组顺序消解，导出/导入两端跑同一算法得到同一结果
        for n in nodes.iter().filter(|n| depths.get(&n.id) == Some(&depth)) {
            // 父引用无效（缺父/成环兜底）或父路径未知时挂根层
            let parent_dir = n
                .parent
                .as_deref()
                .and_then(|p| by_id.get(p))
                .and_then(|p| dir_path.get(&p.id))
                .cloned()
                .unwrap_or_default();
            let disk = match n.node_type.as_str() {
                "folder" => unique_disk_name(used.entry(parent_dir.clone()).or_default(), &safe_name(&n.name), ""),
                _ => unique_disk_name(used.entry(parent_dir.clone()).or_default(), &safe_name(&n.name), ".json"),
            };
            let path = if parent_dir.is_empty() {
                disk
            } else {
                format!("{parent_dir}/{disk}")
            };
            if n.node_type == "folder" {
                dir_path.insert(n.id.clone(), path.clone());
            }
            layout.insert(n.id.clone(), path);
        }
    }
    layout
}

/// 计算每个节点的层深（根层 = 0，子层 = 父层 + 1）。
///
/// 迭代松弛实现（避免恶意 tree.json 构造超深嵌套导致递归栈溢出）：
/// 每轮把「父层深已确定」的节点定深，无进展即停；父引用缺失或成环的节点按 0 兜底。
fn node_depths(nodes: &[SyncNode]) -> HashMap<String, usize> {
    let ids: std::collections::HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    let mut depths: HashMap<String, usize> = HashMap::new();
    loop {
        let mut progress = false;
        for n in nodes {
            if depths.contains_key(&n.id) {
                continue;
            }
            match n.parent.as_deref() {
                None => {
                    depths.insert(n.id.clone(), 0);
                    progress = true;
                }
                // 父引用指向不存在的节点：按根层兜底
                Some(p) if !ids.contains(p) => {
                    depths.insert(n.id.clone(), 0);
                    progress = true;
                }
                Some(p) => {
                    if let Some(pd) = depths.get(p) {
                        depths.insert(n.id.clone(), pd + 1);
                        progress = true;
                    }
                }
            }
        }
        if !progress {
            break;
        }
    }
    // 仍未定深（成环）的节点按根层兜底
    for n in nodes {
        depths.entry(n.id.clone()).or_insert(0);
    }
    depths
}

/// 在同级占用集合中挑一个不冲突的磁盘名：首选 `base + ext`，冲突时追加 `-2`、`-3`…。
///
/// 目录名 `ext` 传空串，Server 文件名传 `".json"`（后缀始终保留，保证能被 `.json`
/// 扫描识别）。占用比较一律小写折叠，兼容大小写不敏感文件系统；新名字会回写进集合。
///
/// # 示例
///
/// ```text
/// used 为空，base="网关", ext=""        → "网关"
/// 已占用 "x.json"，base="x", ext=".json" → "x-2.json"
/// ```
fn unique_disk_name(used: &mut std::collections::HashSet<String>, base: &str, ext: &str) -> String {
    let mut name = base.to_string();
    let mut i = 2;
    while used.contains(&format!("{name}{ext}").to_lowercase()) {
        name = format!("{base}-{i}");
        i += 1;
    }
    let full = format!("{name}{ext}");
    used.insert(full.to_lowercase());
    full
}

/// TransportType -> 存储字符串。
fn transport_str(t: TransportType) -> &'static str {
    match t {
        TransportType::Stdio => "stdio",
        TransportType::StreamableHttp => "streamable_http",
    }
}

/// 检查目录是否含有实际内容（空目录校验用）。
///
/// 忽略 `.git`（用户自行 init 过的空仓库，绑定后照常使用）与 `.DS_Store`
/// （macOS Finder 自动生成的系统文件，不代表用户数据）；其余任何条目都视为有内容。
fn dir_has_content(dir: &Path) -> bool {
    match std::fs::read_dir(dir) {
        Ok(entries) => entries.flatten().any(|e| {
            let name = e.file_name();
            name != ".git" && name != ".DS_Store"
        }),
        Err(_) => false,
    }
}

/// 准备项目同步目录：展开 ~、创建目录、校验必须为空目录、必要时 git init。返回可用的仓库路径。
///
/// 空目录规则：目录不存在视为合法（自动创建后即为空）；已存在的目录必须为空
/// （忽略 `.git` / `.DS_Store`），否则拒绝绑定——防止把项目数据绑到已有内容的目录上
/// 造成推送/拉取互相覆盖。
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
    if dir_has_content(&expanded) {
        return Err(format!(
            "同步目录必须是空目录：「{}」中已有内容。请换一个空目录，或清空该目录后重试",
            expanded.display()
        ));
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

    /// 构造内存数据库（表结构与正式库一致，重建逻辑测试用）。
    fn mem_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn
    }

    /// 构造 tree.json 树节点（测试便捷封装）。
    fn node(id: &str, parent: Option<&str>, ty: &str, name: &str, order: i64) -> SyncNode {
        SyncNode {
            id: id.into(),
            parent: parent.map(Into::into),
            node_type: ty.into(),
            name: name.into(),
            order,
        }
    }

    /// 构造最小 SyncServer 配置（stdio，可选字段全空）。
    fn server_cfg(command: &str) -> SyncServer {
        SyncServer {
            parent: None,
            transport_type: "stdio".into(),
            command: Some(command.into()),
            args: None,
            env: None,
            working_dir: None,
            url: None,
            headers: None,
            sensitive_headers: None,
            envs: None,
            active_env: None,
            timeout_ms: 30_000,
            enabled: true,
            note: None,
        }
    }

    #[test]
    fn 文件名安全化() {
        assert_eq!(safe_name("a/b:c*d"), "a_b_c_d");
        assert_eq!(safe_name("普通名称"), "普通名称");
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

    #[test]
    fn 空目录校验忽略git与系统残留() {
        let base = std::env::temp_dir().join(format!("mcpilot-empty-test-{}", std::process::id()));
        // 完全空目录
        let empty = base.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        // 仅含 .git（用户自行 init 过的空仓库）
        let gited = base.join("gited");
        std::fs::create_dir_all(gited.join(".git")).unwrap();
        // 仅含 .DS_Store（macOS 系统残留）
        let dsstore = base.join("dsstore");
        std::fs::create_dir_all(&dsstore).unwrap();
        std::fs::write(dsstore.join(".DS_Store"), "").unwrap();
        // 含实际内容
        let full = base.join("full");
        std::fs::create_dir_all(&full).unwrap();
        std::fs::write(full.join("tree.json"), "{}").unwrap();

        assert!(!dir_has_content(&empty));
        assert!(!dir_has_content(&gited));
        assert!(!dir_has_content(&dsstore));
        assert!(dir_has_content(&full));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 非空目录拒绝绑定() {
        let base = std::env::temp_dir().join(format!("mcpilot-bind-test-{}", std::process::id()));
        let full = base.join("full");
        std::fs::create_dir_all(&full).unwrap();
        std::fs::write(full.join("old.txt"), "x").unwrap();
        let err = prepare_sync_dir(full.to_str().unwrap()).unwrap_err();
        assert!(err.contains("空目录"), "错误信息应说明必须为空目录：{err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 磁盘路径推导_跨目录同名与同级冲突后缀() {
        // 跨目录同名 Server：各自分组目录下的同名文件，合法且互不覆盖
        let nodes = vec![
            node("n0", None, "folder", "网关组", 0),
            node("n1", Some("n0"), "server", "x", 0),
            node("n2", None, "folder", "其他", 1),
            node("n3", Some("n2"), "server", "x", 0),
            node("n4", None, "server", "x", 2), // 根层同名 → x.json
            node("n5", None, "server", "x", 3), // 根层再来一个 → x-2.json
        ];
        let layout = compute_layout(&nodes);
        assert_eq!(layout["n0"], "网关组");
        assert_eq!(layout["n1"], "网关组/x.json");
        assert_eq!(layout["n2"], "其他");
        assert_eq!(layout["n3"], "其他/x.json");
        assert_eq!(layout["n4"], "x.json");
        assert_eq!(layout["n5"], "x-2.json");
    }

    #[test]
    fn 磁盘路径推导_安全化归并大小写折叠与根层预留() {
        let nodes = vec![
            node("n0", None, "folder", "配置:A", 0), // 安全化后与 配置_A 归并 → 后缀消解
            node("n1", None, "folder", "配置_A", 1),
            node("n2", None, "folder", "tree.json", 2), // 根层预留元数据文件名
            node("n3", None, "server", "API", 3), // 与 api 大小写折叠冲突（macOS 文件系统不区分大小写）
            node("n4", None, "server", "api", 4),
        ];
        let layout = compute_layout(&nodes);
        assert_eq!(layout["n0"], "配置_A");
        assert_eq!(layout["n1"], "配置_A-2");
        assert_eq!(layout["n2"], "tree.json-2");
        assert_eq!(layout["n3"], "API.json");
        assert_eq!(layout["n4"], "api-2.json");
    }

    #[test]
    fn 磁盘路径推导_缺失父引用与成环兜底() {
        let nodes = vec![
            node("n0", Some("nX"), "server", "孤儿", 0), // 父引用不存在 → 根层
            node("n1", Some("n2"), "folder", "环A", 1),
            node("n2", Some("n1"), "folder", "环B", 2), // 成环：两者兜底根层，按序打破成链
        ];
        let layout = compute_layout(&nodes);
        assert_eq!(layout["n0"], "孤儿.json");
        assert_eq!(layout["n1"], "环A");
        assert_eq!(layout["n2"], "环A/环B");
    }

    #[test]
    fn 导出写入与解析往返_树形布局() {
        let base = std::env::temp_dir().join(format!("mcpilot-tree-roundtrip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // 树：根层 root + 网关组（含 x、空子组）+ 其他（含跨目录同名 x）
        let nodes = vec![
            node("n0", None, "server", "root", 0),
            node("n1", None, "folder", "网关组", 1),
            node("n2", Some("n1"), "server", "x", 0),
            node("n3", Some("n1"), "folder", "空组", 2),
            node("n4", None, "folder", "其他", 3),
            node("n5", Some("n4"), "server", "x", 0),
        ];
        let s0 = server_cfg("node root.js");
        let mut s2 = server_cfg("node x-gw.js");
        s2.parent = Some("n1".into());
        let mut s5 = server_cfg("node x-other.js");
        s5.parent = Some("n4".into());
        let layout = compute_layout(&nodes);
        let servers = vec![
            (layout["n0"].clone(), s0),
            (layout["n2"].clone(), s2),
            (layout["n5"].clone(), s5),
        ];
        write_project_files(&base, "演示项目", &nodes, &servers).unwrap();

        // 目录结构镜像资源树 + 空分组 .gitkeep 占位
        assert!(base.join("tree.json").is_file());
        assert!(base.join("root.json").is_file());
        assert!(base.join("网关组/x.json").is_file());
        assert!(base.join("其他/x.json").is_file());
        assert!(base.join("网关组/空组").is_dir());
        assert!(base.join("网关组/空组/.gitkeep").is_file());

        // 往返解析：3 个导入项，名字保真、挂载引用不串
        let mut logs = Vec::new();
        let imports = collect_server_imports(&base, &nodes, &mut logs);
        assert!(logs.is_empty(), "不应产生警告日志：{logs:?}");
        assert_eq!(imports.len(), 3);
        let root = imports.iter().find(|i| i.display_name == "root").unwrap();
        assert_eq!(root.parent, None);
        let xs: Vec<_> = imports
            .iter()
            .filter(|i| i.display_name == "x")
            .map(|i| i.parent.clone())
            .collect();
        assert_eq!(xs, vec![Some("n1".to_string()), Some("n4".to_string())]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 解析导入_旧版拍平布局回退() {
        let base = std::env::temp_dir().join(format!("mcpilot-legacy-flat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("servers")).unwrap();
        // 旧版布局：server 文件全部在 servers/ 平铺目录，tree.json 结构一致
        std::fs::write(
            base.join("tree.json"),
            r#"{"project":"旧项目","nodes":[
                {"id":"n0","parent":null,"type":"folder","name":"组A","order":0},
                {"id":"n1","parent":"n0","type":"server","name":"旧服务","order":0}]}"#,
        )
        .unwrap();
        let mut ss = server_cfg("legacy cmd");
        ss.parent = Some("n0".into());
        std::fs::write(base.join("servers/旧服务.json"), serde_json::to_string_pretty(&ss).unwrap()).unwrap();

        let (_, nodes) = parse_tree(&base.join("tree.json")).unwrap();
        let mut logs = Vec::new();
        let imports = collect_server_imports(&base, &nodes, &mut logs);
        assert!(logs.is_empty(), "不应产生警告日志：{logs:?}");
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].display_name, "旧服务");
        assert_eq!(imports[0].parent.as_deref(), Some("n0"));
        assert_eq!(imports[0].server.command.as_deref(), Some("legacy cmd"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 重建项目树_内存库挂载与排序() {
        let conn = mem_db();
        let p = crate::db::create_project(&conn, "p", None).unwrap();
        let nodes = vec![
            node("n0", None, "folder", "组A", 0),
            node("n1", Some("n0"), "server", "x", 0), // 挂组A下
            node("n2", None, "server", "x", 1),       // 跨目录同名，根层
        ];
        let imports = vec![
            ServerImport {
                display_name: "x".into(),
                parent: Some("n0".into()),
                server: server_cfg("cmd-a"),
            },
            ServerImport {
                display_name: "x".into(),
                parent: Some("n9".into()), // 无效引用 → 根层兜底
                server: server_cfg("cmd-b"),
            },
        ];
        let mut logs = Vec::new();
        rebuild_project_tree(&conn, p.id, "p", &nodes, &imports, &mut logs);
        assert!(!logs.iter().any(|l| l.level == "error"), "不应有错误：{logs:?}");

        let list = crate::db::list_nodes(&conn, p.id).unwrap();
        assert_eq!(list.len(), 3, "1 目录 + 2 Server：{list:?}");
        let folder = list.iter().find(|n| n.node_type == NodeType::Folder).unwrap();
        let xs: Vec<_> = list.iter().filter(|n| n.name == "x").collect();
        assert_eq!(xs.len(), 2, "跨目录同名 Server 都应重建：{list:?}");
        assert_eq!(xs[0].parent_id, Some(folder.id), "第一个 x 挂组A下");
        assert_eq!(xs[1].parent_id, None, "无效引用的 x 根层兜底");
        // 配置逐个对上
        let c0 = crate::db::get_server_config(&conn, xs[0].id).unwrap();
        let c1 = crate::db::get_server_config(&conn, xs[1].id).unwrap();
        assert_eq!(c0.command.as_deref(), Some("cmd-a"));
        assert_eq!(c1.command.as_deref(), Some("cmd-b"));
    }

    fn init_git_repo(dir: &Path) {
        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap()
        };
        assert!(run(&["init"]).status.success());
        assert!(run(&["config", "user.email", "t@t"]).status.success());
        assert!(run(&["config", "user.name", "t"]).status.success());
    }

    #[test]
    fn 远端快照导出_仅json且保持目录结构() {
        let repo = std::env::temp_dir().join(format!("mcpilot-snap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(repo.join("远程服务")).unwrap();
        std::fs::create_dir_all(repo.join("空组")).unwrap();
        std::fs::write(repo.join("tree.json"), r#"{"project":"p","nodes":[]}"#).unwrap();
        std::fs::write(repo.join("远程服务/测试.json"), r#"{"transport_type":"stdio"}"#).unwrap();
        std::fs::write(repo.join("空组/.gitkeep"), "").unwrap();
        init_git_repo(&repo);
        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap()
        };
        assert!(run(&["add", "-A"]).status.success());
        assert!(run(&["commit", "-m", "init"]).status.success());

        let tmp = export_git_tree(&repo, "HEAD").expect("导出应成功");
        assert!(tmp.join("tree.json").is_file());
        assert!(tmp.join("远程服务/测试.json").is_file());
        // .gitkeep 非 json，不导出
        assert!(!tmp.join("空组/.gitkeep").exists());
        let content = std::fs::read_to_string(tmp.join("远程服务/测试.json")).unwrap();
        assert!(content.contains("stdio"));

        // 引用不存在时回退报错
        assert!(export_git_tree(&repo, "origin/不存在分支").is_err());

        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn 自动导出_全量写盘含环境组() {
        let dir = std::env::temp_dir().join(format!("mcpilot-auto-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db(std::sync::Mutex::new(mem_db()));
        let p = {
            let conn = db.0.lock().unwrap();
            crate::db::create_project(&conn, "自动项目", Some(dir.to_str().unwrap())).unwrap()
        };
        let folder = {
            let conn = db.0.lock().unwrap();
            crate::db::create_node(&conn, p.id, None, NodeType::Folder, "组A").unwrap()
        };
        let server = {
            let conn = db.0.lock().unwrap();
            crate::db::create_node(&conn, p.id, Some(folder.id), NodeType::Server, "x").unwrap()
        };
        {
            let conn = db.0.lock().unwrap();
            crate::db::upsert_server_config(&conn, &ServerConfig {
                node_id: server.id,
                transport_type: TransportType::Stdio,
                command: Some("node x.js".into()),
                args: None,
                env: Some(r#"{"DEBUG":"1"}"#.into()),
                working_dir: None,
                url: None,
                headers: None,
                sensitive_headers: None,
                envs: Some(r#"{"dev":{"env":"{}","headers":"{}","sensitive_headers":[]}}"#.into()),
                active_env: Some("dev".into()),
                timeout_ms: 30_000,
                enabled: true,
                note: None,
            }).unwrap();
        }

        // 明文导出：env 真实值原样写入，环境组与激活环境完整保留
        let logs = export_project_dir(&db, p.id);
        assert!(!logs.iter().any(|l| l.level != "info"), "不应有 warn/error：{logs:?}");
        assert!(dir.join("tree.json").is_file());
        assert!(dir.join("组A/x.json").is_file());
        let content = std::fs::read_to_string(dir.join("组A/x.json")).unwrap();
        assert!(content.contains(r#"{\"DEBUG\":\"1\"}"#), "env 应明文写入：{content}");
        assert!(!content.contains("***"), "不应有脱敏占位：{content}");
        assert!(content.contains("dev"), "环境组应完整写入：{content}");
        assert!(content.contains("active_env"), "激活环境应写入：{content}");

        // 未绑定同步目录：静默跳过
        let dir2 = std::env::temp_dir().join(format!("mcpilot-auto2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir2);
        std::fs::create_dir_all(&dir2).unwrap();
        let db2 = Db(std::sync::Mutex::new(mem_db()));
        let p2 = {
            let conn = db2.0.lock().unwrap();
            crate::db::create_project(&conn, "无同步", None).unwrap()
        };
        assert!(export_project_dir(&db2, p2.id).is_empty(), "未绑定同步目录应静默");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }
}

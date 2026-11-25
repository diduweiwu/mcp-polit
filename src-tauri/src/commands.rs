//! Tauri command 层：前端通过 `invoke` 调用的全部入口。
//!
//! 命名约定：动词开头（list_/create_/rename_/delete_/move_/save_/get_）。
//! 全部命令都会经过 [`AppError`] 统一错误出口返回给前端。

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State};

use crate::db::Db;
use crate::error::CmdResult;
use crate::mcp_manager::McpManager;
use crate::models::{
    CallResult, Environment, HistoryRecord, LogEntry, NodeType, Project, ServerConfig, ToolInfo,
    TreeNode,
};

/* ---------- 项目 ---------- */

/// 列出全部项目。
#[tauri::command]
pub fn list_projects(db: State<'_, Db>) -> CmdResult<Vec<Project>> {
    let conn = db.0.lock().unwrap();
    crate::db::list_projects(&conn)
}

/// 新建项目。
///
/// # 参数
///
/// - `name`: 项目名称
/// - `sync_dir`: 可选的同步目录；填写时会校验/创建并自动 git init
/// - `resolve`: 目录为已有数据的 MCPilot 同步仓库时的数据方向（前端冲突弹窗的选择结果）：
///   `project` = 以项目数据为准（清空仓库内容，新建项目从空开始）；
///   `git` = 以仓库数据为准（导入仓库配置作为项目初始数据）；
///   `merge_git` / `merge_project` = 合并（仓库数据并入项目，两边都保留，同名按偏向取值）；
///   其余/None = 空目录正常绑定
///
/// 返回（项目，操作日志）：日志（导入/清空/迁移详情）由前端写入日志面板。
#[tauri::command]
pub async fn create_project(
    app: AppHandle,
    db: State<'_, Db>,
    name: String,
    sync_dir: Option<String>,
    resolve: Option<String>,
) -> CmdResult<(Project, Vec<crate::models::LogEntry>)> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(crate::error::AppError::new("项目名称不能为空"));
    }
    let dir = match sync_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => Some(
            crate::sync::prepare_sync_dir(d)
                .map_err(crate::error::AppError::new)?
                .to_string_lossy()
                .into_owned(),
        ),
        None => None,
    };
    /* 锁作用域收窄：MutexGuard 不能跨 await（下方导入/迁移是 async） */
    let project = {
        let conn = db.0.lock().unwrap();
        crate::db::create_project(&conn, &name, dir.as_deref())?
    };
    let mut logs = Vec::new();
    if let Some(d) = &dir {
        let path = std::path::Path::new(d);
        match resolve.as_deref() {
            /* 以仓库数据为准：导入仓库配置作为新建项目的初始数据 */
            Some("git") => logs = crate::sync::import_repo_to_project(&db, project.id, path, &app).await,
            /* 以项目数据为准：新建项目尚无数据，清空仓库旧内容后走迁移（产出说明日志） */
            Some("project") => logs = crate::sync::take_over_dir_with_project(&db, project.id, path).await,
            /* 合并：仓库数据并入项目，两边都保留（同名按偏向取值） */
            Some("merge_git") => logs = crate::sync::merge_repo_into_project(&db, project.id, path, true),
            Some("merge_project") => logs = crate::sync::merge_repo_into_project(&db, project.id, path, false),
            /* 空目录/新建目录：无需处理 */
            _ => {}
        }
    }
    Ok((project, logs))
}

/// 检查同步目录状态（绑定前检测）。
///
/// 返回是否存在、是否已有内容、是否为 MCPilot 同步仓库（含 tree.json）；
/// 前端据此在保存前判断：普通有内容目录直接拦截，同步仓库目录弹「数据冲突」选择框。
#[tauri::command]
pub fn sync_dir_status(path: String) -> CmdResult<crate::sync::SyncDirStatus> {
    crate::sync::sync_dir_status(&path).map_err(crate::error::AppError::new)
}

/// 重命名项目。
#[tauri::command]
pub fn rename_project(db: State<'_, Db>, id: i64, name: String) -> CmdResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(crate::error::AppError::new("项目名称不能为空"));
    }
    let conn = db.0.lock().unwrap();
    crate::db::rename_project(&conn, id, &name)
}

/// 更新项目同步目录（编辑项目用）。
///
/// - 目录规则：必须是空目录（不存在时自动创建并 git init；忽略 `.git` / `.DS_Store`
///   残留）；已存在的 MCPilot 同步仓库（含 tree.json）允许绑定，数据方向由 `resolve`
///   决定；其余非空目录拒绝绑定，防止项目数据与目录已有内容互相覆盖；
/// - `resolve` = `project`：以项目数据为准——清空仓库工作区内容，再把项目数据
///   导出迁移进去并创建初始提交；
/// - `resolve` = `git`：以仓库数据为准——把仓库配置导入项目（覆盖项目现有
///   节点 / Server / 环境库），不做导出迁移；
/// - `resolve` = `merge_git` / `merge_project`：合并——仓库数据并入项目（仓库
///   独有创建、项目独有保留），同名目录/Server/环境按名称对齐后以偏向方覆盖；
/// - 其余（空目录）：绑定成功后，若项目已有数据，会导出到该目录并创建初始
///   git 提交（不 pull / 不 push）；
/// - 传 null 或空串解除绑定（不涉及迁移）。
///
/// 返回（更新后的项目，操作日志）：日志由前端写入日志面板。
#[tauri::command]
pub async fn update_project_sync_dir(
    app: AppHandle,
    db: State<'_, Db>,
    id: i64,
    sync_dir: Option<String>,
    resolve: Option<String>,
) -> CmdResult<(Project, Vec<crate::models::LogEntry>)> {
    let dir = match sync_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => Some(
            crate::sync::prepare_sync_dir(d)
                .map_err(crate::error::AppError::new)?
                .to_string_lossy()
                .into_owned(),
        ),
        None => None,
    };
    /* 锁作用域收窄：MutexGuard 不能跨 await（下方迁移是 async） */
    let project = {
        let conn = db.0.lock().unwrap();
        crate::db::update_project_sync_dir(&conn, id, dir.as_deref())?
    };
    let mut logs = Vec::new();
    if let Some(d) = &dir {
        let path = std::path::Path::new(d);
        match resolve.as_deref() {
            /* 以仓库数据为准：导入覆盖项目数据（不导出迁移） */
            Some("git") => logs = crate::sync::import_repo_to_project(&db, id, path, &app).await,
            /* 以项目数据为准：先清空仓库旧内容，再按迁移流程导出 */
            Some("project") => logs = crate::sync::take_over_dir_with_project(&db, id, path).await,
            /* 合并：仓库数据并入项目，两边都保留（同名按偏向取值） */
            Some("merge_git") => logs = crate::sync::merge_repo_into_project(&db, id, path, true),
            Some("merge_project") => logs = crate::sync::merge_repo_into_project(&db, id, path, false),
            /* 空目录绑定：维持原迁移行为 */
            _ => logs = crate::sync::migrate_project_to_dir(&db, id, path).await,
        }
    }
    Ok((project, logs))
}

/// 用系统文件管理器打开目录：macOS 用 open，Windows 用 explorer，Linux 用 xdg-open。
/// 路径以参数数组传递，无拼接注入风险；目录不存在时报错。
#[tauri::command]
pub fn open_dir(path: String) -> CmdResult<()> {
    let p = std::path::Path::new(&path);
    if !p.is_dir() {
        return Err(crate::error::AppError::new(format!("目录不存在：{path}")));
    }
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(p);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer");
        c.arg(p);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(p);
        c
    };
    // spawn 后不等待：文件管理器是常驻进程，等待会阻塞命令返回
    cmd.spawn()
        .map_err(|e| crate::error::AppError::new(format!("打开文件管理器失败：{e}")))?;
    Ok(())
}

/// 删除项目：先断开其下全部连接，再级联删除数据。
#[tauri::command]
pub async fn delete_project(app: AppHandle, db: State<'_, Db>, id: i64) -> CmdResult<()> {
    let server_ids = {
        let conn = db.0.lock().unwrap();
        crate::db::delete_project(&conn, id)?
    };
    for node_id in server_ids {
        McpManager::disconnect(app.clone(), node_id).await?;
    }
    Ok(())
}

/* ---------- 树节点 ---------- */

/// 列出项目下全部节点（扁平，前端组装树）。
#[tauri::command]
pub fn list_nodes(db: State<'_, Db>, project_id: i64) -> CmdResult<Vec<TreeNode>> {
    let conn = db.0.lock().unwrap();
    crate::db::list_nodes(&conn, project_id)
}

/// 校验同一父目录下同类型节点名称唯一。
///
/// 同步目录为树形镜像布局（分组 = 真实子目录、Server = 分组目录下的同名 `.json`），
/// 同目录同名会在磁盘上互相覆盖，故新建 / 重命名 / 移动 / 复制时统一拦截；
/// 前端输入时已实时提示，此处为后端兜底。目录与 Server 同名不冲突
/// （磁盘上一个目录一个文件）；跨目录同名完全合法。
///
/// `exclude_id` 用于重命名 / 移动时排除自身（新建传 None）。
fn ensure_sibling_name_unique(
    conn: &rusqlite::Connection,
    project_id: i64,
    parent_id: Option<i64>,
    node_type: NodeType,
    name: &str,
    exclude_id: Option<i64>,
) -> CmdResult<()> {
    let type_str = match node_type {
        NodeType::Folder => "folder",
        NodeType::Server => "server",
    };
    let exists = conn
        .query_row(
            "SELECT 1 FROM tree_nodes
             WHERE project_id = ?1 AND parent_id IS ?2 AND node_type = ?3 AND name = ?4 AND id != ?5
             LIMIT 1",
            rusqlite::params![
                project_id,
                parent_id,
                type_str,
                name,
                exclude_id.unwrap_or(0) // 新建场景无自身；id 从 1 自增，0 不会误排除
            ],
            |_| Ok(()),
        )
        .is_ok();
    if exists {
        let kind = if type_str == "folder" { "目录" } else { "Server" };
        return Err(crate::error::AppError::new(format!(
            "同目录下已存在同名{kind}「{name}」"
        )));
    }
    Ok(())
}

/// 在目录下（或根层）新建目录 / Server 节点。
#[tauri::command]
pub fn create_node(
    db: State<'_, Db>,
    project_id: i64,
    parent_id: Option<i64>,
    node_type: NodeType,
    name: String,
) -> CmdResult<TreeNode> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(crate::error::AppError::new("名称不能为空"));
    }
    let conn = db.0.lock().unwrap();
    ensure_sibling_name_unique(&conn, project_id, parent_id, node_type, &name, None)?;
    crate::db::create_node(&conn, project_id, parent_id, node_type, &name)
}

/// 重命名节点（目录名或 Server 别名）。
#[tauri::command]
pub fn rename_node(db: State<'_, Db>, id: i64, name: String) -> CmdResult<TreeNode> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(crate::error::AppError::new("名称不能为空"));
    }
    let conn = db.0.lock().unwrap();
    let node = crate::db::get_node(&conn, id)?;
    ensure_sibling_name_unique(&conn, node.project_id, node.parent_id, node.node_type, &name, Some(id))?;
    crate::db::rename_node(&conn, id, &name)
}

/// 设置节点自定义图标（目录 / Server 通用）；`icon` 传 None 恢复默认图标。
#[tauri::command]
pub fn set_node_icon(db: State<'_, Db>, id: i64, icon: Option<String>) -> CmdResult<TreeNode> {
    let conn = db.0.lock().unwrap();
    crate::db::set_node_icon(&conn, id, icon.as_deref())
}

/// 移动节点到新的父目录（支持拖拽）。
#[tauri::command]
pub fn move_node(db: State<'_, Db>, id: i64, new_parent_id: Option<i64>) -> CmdResult<TreeNode> {
    let conn = db.0.lock().unwrap();
    let node = crate::db::get_node(&conn, id)?;
    ensure_sibling_name_unique(&conn, node.project_id, new_parent_id, node.node_type, &node.name, Some(id))?;
    crate::db::move_node(&conn, id, new_parent_id)
}

/// 删除节点：先断开其下 server 连接，再递归级联删除。
#[tauri::command]
pub async fn delete_node(app: AppHandle, db: State<'_, Db>, id: i64) -> CmdResult<()> {
    let server_ids = {
        let conn = db.0.lock().unwrap();
        crate::db::delete_node(&conn, id)?
    };
    for node_id in server_ids {
        McpManager::disconnect(app.clone(), node_id).await?;
    }
    Ok(())
}

/* ---------- Server 配置 ---------- */

/// 读取某节点的 Server 配置（无配置时返回默认值）。
#[tauri::command]
pub fn get_server_config(db: State<'_, Db>, node_id: i64) -> CmdResult<ServerConfig> {
    let conn = db.0.lock().unwrap();
    crate::db::get_server_config(&conn, node_id)
}

/// 保存 Server 配置。
///
/// 保存前校验：节点必须是 server 类型；stdio 必须有 command；http 必须有合法 url。
#[tauri::command]
pub fn save_server_config(db: State<'_, Db>, config: ServerConfig) -> CmdResult<()> {
    {
        let conn = db.0.lock().unwrap();
        let node = crate::db::get_node(&conn, config.node_id)?;
        if node.node_type != NodeType::Server {
            return Err(crate::error::AppError::new("只有 Server 节点才有连接配置"));
        }
        validate_config(&config)?;
        crate::db::upsert_server_config(&conn, &config)?;
    }
    Ok(())
}

/// 校验 Server 配置的基本合法性。
fn validate_config(config: &ServerConfig) -> CmdResult<()> {
    if config.timeout_ms <= 0 || config.timeout_ms > 600_000 {
        return Err(crate::error::AppError::new(
            "超时时间必须在 1 ~ 600000 毫秒之间",
        ));
    }
    match config.transport_type {
        crate::models::TransportType::Stdio => {
            if config.command.as_deref().map(str::trim).unwrap_or("").is_empty() {
                return Err(crate::error::AppError::new("stdio 模式必须填写启动命令"));
            }
        }
        crate::models::TransportType::StreamableHttp => {
            let url = config.url.as_deref().map(str::trim).unwrap_or("");
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err(crate::error::AppError::new(
                    "服务地址必须以 http:// 或 https:// 开头",
                ));
            }
        }
    }
    // args / env / headers 必须是合法 JSON（提前在保存时暴露问题）
    for (label, raw) in [
        ("参数", config.args.as_deref()),
        ("环境变量", config.env.as_deref()),
        ("请求头", config.headers.as_deref()),
    ] {
        if let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) {
            if serde_json::from_str::<Value>(s).is_err() {
                return Err(crate::error::AppError::new(format!("{label} 不是合法的 JSON")));
            }
        }
    }
    Ok(())
}

/* ---------- 项目级环境库 ---------- */

/// 列出项目的全部环境（variables 为 JSON 对象字符串原文，前端解析渲染）。
#[tauri::command]
pub fn list_environments(
    db: State<'_, Db>,
    project_id: i64,
) -> CmdResult<Vec<Environment>> {
    let conn = db.0.lock().unwrap();
    crate::db::list_environments(&conn, project_id)
}

/// 环境保存负载：环境管理弹窗整批提交的单个环境（id / 排序由后端生成）。
#[derive(serde::Deserialize)]
pub struct EnvironmentPayload {
    /// 环境名（同项目内唯一，如 dev / prod）
    pub name: String,
    /// 变量集 JSON 对象字符串，如 '{"TOKEN":"xxx"}'
    pub variables: String,
}

/// 整批保存项目的环境库（全量覆盖语义：列表中没有的环境会被删除，改名 = 删旧建新）。
///
/// 同批重名 / 空名 / variables 非法 JSON 时整体报错不落盘（校验在 [`crate::db::replace_environments`]）。
#[tauri::command]
pub fn save_environments(
    db: State<'_, Db>,
    project_id: i64,
    environments: Vec<EnvironmentPayload>,
) -> CmdResult<()> {
    let inputs: Vec<crate::db::EnvironmentInput> = environments
        .into_iter()
        .map(|e| crate::db::EnvironmentInput {
            name: e.name,
            variables: e.variables,
        })
        .collect();
    let mut conn = db.0.lock().unwrap();
    crate::db::replace_environments(&mut conn, project_id, &inputs)
}

/// 旧版每 Server 环境组（`envs` 字段）向项目级环境库的一次性迁移（幂等）。
///
/// 前端在切换到某项目时调用；已迁移过的项目返回空日志（静默）。
/// 返回的日志（迁移明细 / 冲突提醒）由前端写入日志面板，保证迁移可见、冲突不静默。
#[tauri::command]
pub fn migrate_legacy_envs(
    db: State<'_, Db>,
    project_id: i64,
) -> CmdResult<Vec<LogEntry>> {
    let mut conn = db.0.lock().unwrap();
    let report = crate::db::merge_legacy_envs(&mut conn, project_id, false)?;
    Ok(report.to_logs())
}

/* ---------- 连接与调用 ---------- */

/// 连接指定 server，成功返回工具列表。
#[tauri::command]
pub async fn connect_server(
    app: AppHandle,
    db: State<'_, Db>,
    node_id: i64,
) -> CmdResult<Vec<ToolInfo>> {
    McpManager::connect(app, &db, node_id).await
}

/// 断开指定 server。
#[tauri::command]
pub async fn disconnect_server(app: AppHandle, node_id: i64) -> CmdResult<()> {
    McpManager::disconnect(app, node_id).await
}

/// 中断进行中的连接尝试（连接中状态下的「中断」按钮；对已建立连接等同断开）。
#[tauri::command]
pub async fn cancel_connect_server(app: AppHandle, node_id: i64) -> CmdResult<()> {
    McpManager::cancel_connect(&app, node_id).await
}

/// 刷新工具列表（走重连路径，拿到最新缓存）。
#[tauri::command]
pub async fn refresh_tools(
    app: AppHandle,
    db: State<'_, Db>,
    node_id: i64,
) -> CmdResult<Vec<ToolInfo>> {
    McpManager::refresh_tools(app, &db, node_id).await
}

/// 调用工具。
///
/// # 参数
///
/// - `arguments`: 入参对象（前端把表单值组装成 JSON 对象字符串传过来）。
/// - `seq`: 前端生成的调用序号，用于结果面板对照，原样回传。
#[tauri::command]
pub async fn call_tool(
    app: AppHandle,
    db: State<'_, Db>,
    node_id: i64,
    tool_name: String,
    arguments: String,
    seq: i64,
) -> CmdResult<CallResult> {
    let parsed: Value = serde_json::from_str(arguments.trim())
        .map_err(|e| crate::error::AppError::new(format!("入参不是合法的 JSON：{e}")))?;
    let map: Map<String, Value> = match parsed {
        Value::Object(m) => m,
        Value::Null => Map::new(),
        _ => {
            return Err(crate::error::AppError::new(
                "入参必须是 JSON 对象（如 {\"key\":\"value\"}）",
            ))
        }
    };
    let arguments_json = serde_json::to_string(&Value::Object(map.clone()))
        .unwrap_or_else(|_| "{}".to_string());
    McpManager::call_tool(app, &db, node_id, tool_name, map, arguments_json, seq).await
}

/// 查询某节点的连接状态与错误信息（前端刷新/重载后恢复展示用）。
#[tauri::command]
pub fn get_conn_state(app: AppHandle, node_id: i64) -> crate::models::ConnStateEvent {
    let manager = app.state::<McpManager>();
    let s = manager.state_of(node_id);
    crate::models::ConnStateEvent {
        node_id,
        status: s.status,
        message: s.message,
    }
}

/// 获取已连接 server 的缓存工具列表（前端窗口刷新后恢复工具面板用）。
#[tauri::command]
pub fn get_cached_tools(app: AppHandle, node_id: i64) -> CmdResult<Vec<ToolInfo>> {
    let manager = app.state::<McpManager>();
    manager.cached_tools(node_id)
}

/* ---------- 应用设置 ---------- */

/// 读取全部设置项（键值对列表）。
#[tauri::command]
pub fn get_settings(db: State<'_, Db>) -> CmdResult<Vec<(String, String)>> {
    let conn = db.0.lock().unwrap();
    crate::db::get_all_settings(&conn)
}

/// 写入一个设置项。
#[tauri::command]
pub fn save_setting(db: State<'_, Db>, key: String, value: String) -> CmdResult<()> {
    let conn = db.0.lock().unwrap();
    crate::db::set_setting(&conn, &key, &value)
}

/* ---------- 项目级同步（资源树推送/拉取/分支） ---------- */

/// 推送项目到其绑定的 git 仓库（导出 + commit + push），返回操作日志。
///
/// `message` 为用户在推送弹窗填写的提交信息；None 或空白时后端使用默认提交信息。
#[tauri::command]
pub async fn project_sync_push(
    app: AppHandle,
    db: State<'_, Db>,
    project_id: i64,
    message: Option<String>,
) -> CmdResult<Vec<crate::models::LogEntry>> {
    Ok(crate::sync::push_project(&app, &db, project_id, message).await)
}

/// 从项目绑定的 git 仓库拉取并导入（覆盖当前配置），返回操作日志。
#[tauri::command]
pub async fn project_sync_pull(
    app: AppHandle,
    db: State<'_, Db>,
    project_id: i64,
) -> CmdResult<Vec<crate::models::LogEntry>> {
    Ok(crate::sync::pull_project(&app, &db, project_id).await)
}

/// 同步目录自动导出（实时同步）：把项目当前配置全量写入同步目录（不含 git 操作）。
///
/// 树/配置变更后由前端防抖调用。成功返回空日志（静默）；失败返回 warn 日志
/// 供日志面板展示，不影响触发它的操作本身。
#[tauri::command]
pub fn project_sync_export(
    db: State<'_, Db>,
    project_id: i64,
) -> CmdResult<Vec<crate::models::LogEntry>> {
    Ok(crate::sync::export_project_dir(&db, project_id))
}

/// 列出项目同步仓库的分支（当前分支 + 全部本地分支）。
#[tauri::command]
pub fn project_branches(
    db: State<'_, Db>,
    project_id: i64,
) -> CmdResult<crate::sync::BranchInfo> {
    let project = {
        let conn = db.0.lock().unwrap();
        crate::db::get_project(&conn, project_id)?
    };
    let dir = project
        .sync_dir
        .ok_or_else(|| crate::error::AppError::new("该项目未开启同步"))?;
    crate::sync::git_branches(std::path::Path::new(&dir)).map_err(crate::error::AppError::new)
}

/// 切换项目同步仓库的分支。
#[tauri::command]
pub fn project_checkout(db: State<'_, Db>, project_id: i64, branch: String) -> CmdResult<()> {
    let project = {
        let conn = db.0.lock().unwrap();
        crate::db::get_project(&conn, project_id)?
    };
    let dir = project
        .sync_dir
        .ok_or_else(|| crate::error::AppError::new("该项目未开启同步"))?;
    crate::sync::git_checkout(std::path::Path::new(&dir), &branch)
        .map_err(crate::error::AppError::new)
}

/// 读取项目同步目录的未提交变更列表（git status 视角，未推送变更提醒的数据源）。
///
/// - `project_id`：项目 ID
/// - 返回 `SyncChanges`：`available` = 同步目录是否为可用 git 仓库（false 时前端
///   隐藏变更徽标）；`entries[].nodeId` = 资源树节点 ID（null = 不对应单个节点），
///   `name` = 展示名，`action` = create/update/rename/delete/env/tree，`path` = 相对
///   仓库根的文件路径
/// - 目录/仓库异常一律静默（`available=false`，不报错）：该命令被前端 10s 定时轮询；
///   仅项目不存在或数据库读取失败时报错
#[tauri::command]
pub async fn project_sync_changes(
    db: State<'_, Db>,
    project_id: i64,
) -> CmdResult<crate::sync::SyncChanges> {
    crate::sync::project_changes(&db, project_id)
        .await
        .map_err(crate::error::AppError::new)
}

/// 复制节点：目录连同整棵子树（含各 Server 连接配置）一起复制。
///
/// # 参数
///
/// - `node_id`: 源节点 ID
/// - `name`: 副本名称（前端生成，如「原名-a3f2」随机后缀避免重名；
///   极小概率撞同级同名时由同级重名校验拦截）
#[tauri::command]
pub fn duplicate_node(db: State<'_, Db>, node_id: i64, name: String) -> CmdResult<TreeNode> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(crate::error::AppError::new("副本名称不能为空"));
    }
    let conn = db.0.lock().unwrap();
    let src = crate::db::get_node(&conn, node_id)?;
    ensure_sibling_name_unique(&conn, src.project_id, src.parent_id, src.node_type, &name, None)?;
    crate::db::duplicate_node(&conn, node_id, &name)
}

/// 用表单中的（未落库）配置测试连通性：握手 → 拉取工具列表 → 立即断开。
///
/// 与正式连接一致：先按 `project_id` 当前激活环境对配置做 `{{}}` 插值解析，
/// 存在未定义的环境变量引用时直接报错（fail-fast，不把占位符原样发出）。
///
/// 不写入连接表、不广播状态、不影响该节点可能已存在的正式连接。
#[tauri::command]
pub async fn test_server_config(
    db: State<'_, Db>,
    config: ServerConfig,
    project_id: i64,
) -> CmdResult<Vec<ToolInfo>> {
    let resolved = {
        let conn = db.0.lock().unwrap();
        crate::mcp_manager::resolve_config(&conn, &config, project_id)?
    };
    McpManager::probe_config(resolved).await
}

/* ---------- 调用历史 ---------- */

/// 追加一条调用历史记录（id / created_at 由后端生成，传入值被忽略），
/// 返回新记录的自增 ID（前端展示编号用）。
#[tauri::command]
pub fn append_history(db: State<'_, Db>, record: HistoryRecord) -> CmdResult<i64> {
    let conn = db.0.lock().unwrap();
    crate::db::insert_history(&conn, &record)
}

/// 追加一条前端诊断日志到 crash.log（与 Rust panic / ObjC 异常同一文件，跨会话可查）。
///
/// 前端全局异常（JS error / unhandledrejection）经此落盘；kind 建议用
/// `JS_ERROR` / `JS_REJECTION`，message 由前端拼好（含简要堆栈）。
/// 写入失败静默（诊断日志绝不反过来影响运行）；无鉴权风险：仅写入本机数据目录。
#[tauri::command]
pub fn append_diag_log(
    log: State<'_, crate::diag::DiagLog>,
    kind: String,
    message: String,
) -> CmdResult<()> {
    // 限制单条长度：堆栈可能很长，截断到 8KB 防止日志被单条异常撑爆
    let message: String = message.chars().take(8192).collect();
    crate::diag::append_diag(&log.0, &kind, &message);
    Ok(())
}

/// 读取调用历史（新 → 旧，按 offset 分页动态加载）。
#[tauri::command]
pub fn list_history(
    db: State<'_, Db>,
    limit: i64,
    offset: Option<i64>,
) -> CmdResult<Vec<HistoryRecord>> {
    let conn = db.0.lock().unwrap();
    crate::db::list_history(&conn, limit, offset.unwrap_or(0))
}

/// 清空全部调用历史（收藏行保留，避免用户显式收藏的数据被静默清除），
/// 返回本次删除的条数（前端提示「已保留 N 条收藏」用）。
#[tauri::command]
pub fn clear_history(db: State<'_, Db>) -> CmdResult<i64> {
    let conn = db.0.lock().unwrap();
    crate::db::clear_history(&conn)
}

/// 设置一条调用历史的收藏状态。
///
/// # 参数
///
/// - `id`: 记录 ID（历史条目展示的落库自增编号）。
/// - `starred`: true = 收藏；false = 取消收藏。
#[tauri::command]
pub fn set_history_starred(db: State<'_, Db>, id: i64, starred: bool) -> CmdResult<()> {
    let conn = db.0.lock().unwrap();
    crate::db::set_history_starred(&conn, id, starred)
}

/// 读取全部收藏的调用记录（新 → 旧，不分页）。
#[tauri::command]
pub fn list_starred_history(db: State<'_, Db>) -> CmdResult<Vec<HistoryRecord>> {
    let conn = db.0.lock().unwrap();
    crate::db::list_starred_history(&conn)
}

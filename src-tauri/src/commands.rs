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
    CallResult, HistoryRecord, NodeType, Project, ServerConfig, ToolInfo, TreeNode,
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
#[tauri::command]
pub fn create_project(db: State<'_, Db>, name: String, sync_dir: Option<String>) -> CmdResult<Project> {
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
    let conn = db.0.lock().unwrap();
    crate::db::create_project(&conn, &name, dir.as_deref())
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
///   残留），非空目录拒绝绑定，防止项目数据与目录已有内容互相覆盖；
/// - 数据迁移：绑定成功后，若项目已有数据（目录树 / Server 配置），
///   会把数据导出到该目录并创建初始 git 提交（不 pull / 不 push）；
/// - 传 null 或空串解除绑定（不涉及迁移）。
///
/// 返回（更新后的项目，操作日志）：日志由前端写入日志面板。
#[tauri::command]
pub async fn update_project_sync_dir(
    db: State<'_, Db>,
    id: i64,
    sync_dir: Option<String>,
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
        logs = crate::sync::migrate_project_to_dir(&db, id, std::path::Path::new(d)).await;
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
    crate::db::rename_node(&conn, id, &name)
}

/// 移动节点到新的父目录（支持拖拽）。
#[tauri::command]
pub fn move_node(db: State<'_, Db>, id: i64, new_parent_id: Option<i64>) -> CmdResult<TreeNode> {
    let conn = db.0.lock().unwrap();
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
#[tauri::command]
pub async fn project_sync_push(
    app: AppHandle,
    db: State<'_, Db>,
    project_id: i64,
) -> CmdResult<Vec<crate::models::LogEntry>> {
    Ok(crate::sync::push_project(&app, &db, project_id).await)
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

/// 复制节点：目录连同整棵子树（含各 Server 连接配置）一起复制。
///
/// # 参数
///
/// - `node_id`: 源节点 ID
/// - `name`: 副本名称（前端生成，如「原名-a3f2」随机后缀避免重名）
#[tauri::command]
pub fn duplicate_node(db: State<'_, Db>, node_id: i64, name: String) -> CmdResult<TreeNode> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(crate::error::AppError::new("副本名称不能为空"));
    }
    let conn = db.0.lock().unwrap();
    crate::db::duplicate_node(&conn, node_id, &name)
}

/// 用表单中的（未落库）配置测试连通性：握手 → 拉取工具列表 → 立即断开。
///
/// 不写入连接表、不广播状态、不影响该节点可能已存在的正式连接。
#[tauri::command]
pub async fn test_server_config(config: ServerConfig) -> CmdResult<Vec<ToolInfo>> {
    McpManager::probe_config(config).await
}

/* ---------- 调用历史 ---------- */

/// 追加一条调用历史记录（id / created_at 由后端生成，传入值被忽略），
/// 返回新记录的自增 ID（前端展示编号用）。
#[tauri::command]
pub fn append_history(db: State<'_, Db>, record: HistoryRecord) -> CmdResult<i64> {
    let conn = db.0.lock().unwrap();
    crate::db::insert_history(&conn, &record)
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

/// 清空全部调用历史。
#[tauri::command]
pub fn clear_history(db: State<'_, Db>) -> CmdResult<()> {
    let conn = db.0.lock().unwrap();
    crate::db::clear_history(&conn)
}

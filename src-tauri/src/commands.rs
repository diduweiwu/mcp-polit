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
    CallResult, NodeType, Project, ServerConfig, ToolInfo, TreeNode,
};

/* ---------- 项目 ---------- */

/// 列出全部项目。
#[tauri::command]
pub fn list_projects(db: State<'_, Db>) -> CmdResult<Vec<Project>> {
    let conn = db.0.lock().unwrap();
    crate::db::list_projects(&conn)
}

/// 新建项目。
#[tauri::command]
pub fn create_project(db: State<'_, Db>, name: String) -> CmdResult<Project> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(crate::error::AppError::new("项目名称不能为空"));
    }
    let conn = db.0.lock().unwrap();
    crate::db::create_project(&conn, &name)
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

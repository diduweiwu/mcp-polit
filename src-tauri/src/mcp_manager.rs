//! MCP 连接管理器：维护所有 server 的连接会话、工具列表缓存与连接状态。
//!
//! 设计要点：
//! - 每个成功连接的 server 对应一个 [`ConnHandle`]（rmcp 的 `RunningService` + 工具缓存）。
//! - 状态通过 Tauri event（`conn-state`）实时推送给前端，前端树节点据此显示状态点。
//! - 工具调用带超时保护（每个 server 可单独配置 `timeout_ms`）。
//! - 所有配置中的 header/env 属于敏感信息：不写日志、不出现在错误信息里。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rmcp::model::{CallToolRequestParams, JsonObject};
use rmcp::service::{RunningService, RoleClient};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{
    ConfigureCommandExt, IntoTransport, StreamableHttpClientTransport, TokioChildProcess,
};
use rmcp::ServiceExt;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;

use crate::db::Db;
use crate::error::{AppError, CmdResult};
use crate::models::{CallResult, ConnStateEvent, ConnStatus, ServerConfig, ToolInfo, TransportType};

/// 一个已建立的 MCP 连接。
pub struct ConnHandle {
    /// rmcp 客户端会话（Arc 便于在调用期间先取句柄再释放表锁）
    service: Arc<RunningService<RoleClient, ()>>,
    /// 连接时缓存的工具列表（手动刷新时更新）
    tools: Mutex<Vec<ToolInfo>>,
}

/// 连接状态（含最后一次错误信息）。
#[derive(Debug, Clone)]
pub struct ConnState {
    /// 当前状态
    pub status: ConnStatus,
    /// 错误信息（脱敏后）
    pub message: Option<String>,
}

/// 连接管理器：应用级单例状态。
pub struct McpManager {
    /// node_id -> 活跃连接
    conns: Mutex<HashMap<i64, Arc<ConnHandle>>>,
    /// node_id -> 最近一次状态（连接断开后仍保留 error 信息供前端展示）
    states: Mutex<HashMap<i64, ConnState>>,
    /// node_id -> 进行中的连接握手取消令牌（握手结束后注销；中断/断开时取消）
    connect_tokens: Mutex<HashMap<i64, Arc<CancellationToken>>>,
}

impl McpManager {
    /// 创建空的管理器。
    pub fn new() -> Self {
        Self {
            conns: Mutex::new(HashMap::new()),
            states: Mutex::new(HashMap::new()),
            connect_tokens: Mutex::new(HashMap::new()),
        }
    }

    /// 更新状态表并向前端广播 `conn-state` 事件。
    fn report(app: &AppHandle, node_id: i64, status: ConnStatus, message: Option<String>) {
        let manager = app.state::<McpManager>();
        manager.states.lock().unwrap().insert(
            node_id,
            ConnState {
                status,
                message: message.clone(),
            },
        );
        // emit 失败仅说明窗口已关闭，忽略即可
        let _ = app.emit(
            "conn-state",
            &ConnStateEvent {
                node_id,
                status,
                message,
            },
        );
    }

    /// 建立连接：按配置构建传输层 -> 握手 -> 拉取工具列表 -> 入表并广播状态。
    ///
    /// 连接前会按当前项目激活的环境对配置做 `{{}}` 插值解析（[`resolve_config`]），
    /// 存在未定义的环境变量引用时连接失败并明确报错。
    ///
    /// 成功后返回该 server 的工具列表。
    pub async fn connect(app: AppHandle, db: &Db, node_id: i64) -> CmdResult<Vec<ToolInfo>> {
        // 读取配置与所属项目（短锁）
        let (raw_config, project_id) = {
            let conn = db.0.lock().unwrap();
            let node = crate::db::get_node(&conn, node_id)?;
            let cfg = crate::db::get_server_config(&conn, node_id)?;
            (cfg, node.project_id)
        };
        if !raw_config.enabled {
            return Err(AppError::new("该 Server 已停用，请先在配置中启用"));
        }

        // 先静默清理旧连接（旧的中断令牌随上一轮连接结束时已注销，此处不会误伤）
        Self::disconnect_inner(&app, node_id).await;
        // 注册本次握手的取消令牌：断开/中断操作可提前取消握手（不必等 30s 超时）
        let token = {
            let manager = app.state::<McpManager>();
            let t = Arc::new(CancellationToken::new());
            manager
                .connect_tokens
                .lock()
                .unwrap()
                .insert(node_id, t.clone());
            t
        };
        Self::report(&app, node_id, ConnStatus::Connecting, None);

        // 环境插值解析（短锁）：失败（未定义引用等）与传输构建失败同样走 Error 状态上报
        let config = {
            let conn = db.0.lock().unwrap();
            match resolve_config(&conn, &raw_config, project_id) {
                Ok(c) => c,
                Err(e) => {
                    Self::report(&app, node_id, ConnStatus::Error, Some(e.message.clone()));
                    return Err(e);
                }
            }
        };

        let result = match config.transport_type {
            TransportType::Stdio => {
                let transport = match build_stdio_transport(&config) {
                    Ok(t) => t,
                    Err(e) => {
                        Self::report(&app, node_id, ConnStatus::Error, Some(e.message.clone()));
                        return Err(e);
                    }
                };
                Self::do_connect(app, node_id, config, transport, token).await
            }
            TransportType::StreamableHttp => {
                let transport = match build_http_transport(&config) {
                    Ok(t) => t,
                    Err(e) => {
                        Self::report(&app, node_id, ConnStatus::Error, Some(e.message.clone()));
                        return Err(e);
                    }
                };
                Self::do_connect(app, node_id, config, transport, token).await
            }
        };
        result
    }

    /// 连接的通用后半段：握手 -> 工具列表 -> 入表 -> 广播。
    ///
    /// 泛型 `T` 同时覆盖 stdio 与 streamable_http 两种传输实现。
    /// `token` 为本次握手的取消令牌：外部（中断按钮/断开操作）取消后握手提前退出，
    /// 广播 Disconnected 并返回「连接已手动中断」错误。
    async fn do_connect<T, E, A>(
        app: AppHandle,
        node_id: i64,
        config: ServerConfig,
        transport: T,
        token: Arc<CancellationToken>,
    ) -> CmdResult<Vec<ToolInfo>>
    where
        T: IntoTransport<RoleClient, E, A>,
        E: std::error::Error + Send + Sync + 'static,
    {
        // 握手 + 初始化：30s 超时上限避免无限等待；取消令牌支持手动中断
        let served = tokio::select! {
            r = tokio::time::timeout(Duration::from_secs(30), ().serve(transport)) => r,
            _ = token.cancelled() => {
                // 手动中断：注销令牌并广播断开（前端恢复空闲态）
                app.state::<McpManager>()
                    .connect_tokens
                    .lock()
                    .unwrap()
                    .remove(&node_id);
                Self::report(&app, node_id, ConnStatus::Disconnected, None);
                return Err(AppError::new("连接已手动中断"));
            }
        };
        // 握手已结束（成功/失败/超时），注销取消令牌
        app.state::<McpManager>()
            .connect_tokens
            .lock()
            .unwrap()
            .remove(&node_id);
        let service = match served {
            Ok(Ok(s)) => Arc::new(s),
            Ok(Err(e)) => {
                let msg = sanitize(format!("连接失败：{e}"), &config);
                Self::report(&app, node_id, ConnStatus::Error, Some(msg.clone()));
                return Err(AppError::new(msg));
            }
            Err(_) => {
                let msg = "连接超时（30 秒）".to_string();
                Self::report(&app, node_id, ConnStatus::Error, Some(msg.clone()));
                return Err(AppError::new(msg));
            }
        };

        // 拉取工具列表
        let listed = service.peer().list_tools(None).await;
        let tools = match listed {
            Ok(result) => result
                .tools
                .into_iter()
                .map(|t| ToolInfo {
                    name: t.name.to_string(),
                    title: t.title.map(|x| x.to_string()),
                    description: t.description.map(|x| x.to_string()),
                    input_schema: serde_json::to_value(&*t.input_schema).unwrap_or(Value::Null),
                })
                .collect::<Vec<_>>(),
            Err(e) => {
                let msg = sanitize(format!("获取工具列表失败：{e}"), &config);
                Self::report(&app, node_id, ConnStatus::Error, Some(msg.clone()));
                return Err(AppError::new(msg));
            }
        };

        // 入表并广播
        let manager = app.state::<McpManager>();
        manager.conns.lock().unwrap().insert(
            node_id,
            Arc::new(ConnHandle {
                service,
                tools: Mutex::new(tools.clone()),
            }),
        );
        Self::report(&app, node_id, ConnStatus::Connected, None);
        Ok(tools)
    }

    /// 断开连接（若未连接则静默成功）。
    pub async fn disconnect(app: AppHandle, node_id: i64) -> CmdResult<()> {
        Self::disconnect_inner(&app, node_id).await;
        Self::report(&app, node_id, ConnStatus::Disconnected, None);
        Ok(())
    }

    /// 中断进行中的连接尝试：取消握手令牌，`do_connect` 的 select 分支会广播
    /// Disconnected 并以「连接已手动中断」结束。没有进行中的握手时按断开处理
    /// （幂等：对已建立会话等同 disconnect，无任何状态时仅归位状态）。
    pub async fn cancel_connect(app: &AppHandle, node_id: i64) -> CmdResult<()> {
        let manager = app.state::<McpManager>();
        let token = manager.connect_tokens.lock().unwrap().remove(&node_id);
        if let Some(t) = token {
            t.cancel();
            return Ok(());
        }
        Self::disconnect_inner(&app, node_id).await;
        Self::report(&app, node_id, ConnStatus::Disconnected, None);
        Ok(())
    }

    /// 内部断开：只移除并关闭会话，不广播状态。
    async fn disconnect_inner(app: &AppHandle, node_id: i64) {
        let manager = app.state::<McpManager>();
        // 进行中的连接尝试一并取消（否则断开后握手完成又变回已连接）
        if let Some(t) = manager.connect_tokens.lock().unwrap().remove(&node_id) {
            t.cancel();
        }
        let removed = manager.conns.lock().unwrap().remove(&node_id);
        if let Some(handle) = removed {
            // 通过取消令牌触发优雅关闭（可在 Arc 共享状态下调用），随后 Drop 兜底清理
            handle.service.cancellation_token().cancel();
        }
    }

    /// 重新连接并刷新工具列表（断开 -> 重连 -> 新缓存）。
    pub async fn refresh_tools(app: AppHandle, db: &Db, node_id: i64) -> CmdResult<Vec<ToolInfo>> {
        Self::connect(app, db, node_id).await
    }

    /// 用一份（未落库的）配置做连通性探测：握手 -> 拉取工具列表 -> 立即断开。
    ///
    /// 与 [`McpManager::connect`] 的区别：不写入连接表、不广播 `conn-state`、
    /// 不影响该节点可能已存在的正式连接，专供 Server 表单的「测试连通性」按钮。
    ///
    /// 成功返回探测到的工具列表（前端展示数量即可）。
    pub async fn probe_config(config: ServerConfig) -> CmdResult<Vec<ToolInfo>> {
        match config.transport_type {
            TransportType::Stdio => {
                let transport = build_stdio_transport(&config)?;
                Self::probe_with(transport, config).await
            }
            TransportType::StreamableHttp => {
                let transport = build_http_transport(&config)?;
                Self::probe_with(transport, config).await
            }
        }
    }

    /// 连通性探测的通用执行段（泛型覆盖 stdio 与 streamable_http 两种传输）。
    async fn probe_with<T, E, A>(transport: T, config: ServerConfig) -> CmdResult<Vec<ToolInfo>>
    where
        T: IntoTransport<RoleClient, E, A>,
        E: std::error::Error + Send + Sync + 'static,
    {
        // 握手 + 初始化，固定 30 秒上限，与正式连接一致
        let served = tokio::time::timeout(Duration::from_secs(30), ().serve(transport)).await;
        let service = match served {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                let msg = sanitize(format!("连接失败：{e}"), &config);
                return Err(AppError::new(msg));
            }
            Err(_) => return Err(AppError::new("连接超时（30 秒）")),
        };
        // 拉取工具列表
        let listed = service.peer().list_tools(None).await;
        let tools = match listed {
            Ok(result) => result
                .tools
                .into_iter()
                .map(|t| ToolInfo {
                    name: t.name.to_string(),
                    title: t.title.map(|x| x.to_string()),
                    description: t.description.map(|x| x.to_string()),
                    input_schema: serde_json::to_value(&*t.input_schema).unwrap_or(Value::Null),
                })
                .collect::<Vec<_>>(),
            Err(e) => {
                let msg = sanitize(format!("获取工具列表失败：{e}"), &config);
                return Err(AppError::new(msg));
            }
        };
        // 探测完成即断开（stdio 子进程随之回收）
        service.cancellation_token().cancel();
        Ok(tools)
    }

    /// 获取已缓存的工具列表；未连接时报错。
    pub fn cached_tools(&self, node_id: i64) -> CmdResult<Vec<ToolInfo>> {
        let conns = self.conns.lock().unwrap();
        match conns.get(&node_id) {
            Some(h) => Ok(h.tools.lock().unwrap().clone()),
            None => Err(AppError::new("该 Server 尚未连接，请先连接")),
        }
    }

    /// 调用工具（带超时）。成功返回结构化的调用结果。
    ///
    /// # 参数
    ///
    /// - `arguments`: 已解析的入参对象（JSON 对象）。
    /// - `seq`: 前端生成的调用序号，原样回传用于结果面板对照。
    pub async fn call_tool(
        app: AppHandle,
        db: &Db,
        node_id: i64,
        tool_name: String,
        arguments: Map<String, Value>,
        arguments_json: String,
        seq: i64,
    ) -> CmdResult<CallResult> {
        // 先取句柄与超时配置（短锁），再释放锁执行调用
        let (handle, timeout_ms, config) = {
            let manager = app.state::<McpManager>();
            let conns = manager.conns.lock().unwrap();
            let h = conns
                .get(&node_id)
                .ok_or_else(|| AppError::new("该 Server 尚未连接，请先连接"))?
                .clone();
            let conn = db.0.lock().unwrap();
            let cfg = crate::db::get_server_config(&conn, node_id)?;
            (h, cfg.timeout_ms, cfg)
        };

        let started = Instant::now();
        let params = CallToolRequestParams::new(tool_name.clone()).with_arguments(JsonObject::from(
            arguments,
        ));
        let fut = handle.service.peer().call_tool(params);
        let result =
            tokio::time::timeout(Duration::from_millis(timeout_ms.max(1) as u64), fut).await;
        let duration_ms = started.elapsed().as_millis() as i64;

        match result {
            Ok(Ok(res)) => Ok(CallResult {
                seq,
                tool_name,
                is_error: res.is_error.unwrap_or(false),
                content: serde_json::to_value(&res.content).unwrap_or(Value::Null),
                structured_content: res.structured_content,
                duration_ms,
                arguments: arguments_json,
            }),
            Ok(Err(e)) => {
                let msg = sanitize(format!("工具调用失败：{e}"), &config);
                Err(AppError::new(msg))
            }
            Err(_) => Err(AppError::new(format!(
                "工具调用超时（{timeout_ms} 毫秒），可在 Server 配置中调大超时时间"
            ))),
        }
    }

    /// 查询某节点当前状态；无记录视为未连接。
    pub fn state_of(&self, node_id: i64) -> ConnState {
        match self.states.lock().unwrap().get(&node_id) {
            Some(s) => s.clone(),
            None => ConnState {
                status: ConnStatus::Disconnected,
                message: None,
            },
        }
    }

    /// 批量断开全部连接（删除项目/节点或退出应用时调用）。
    pub async fn disconnect_all(app: &AppHandle) {
        let ids: Vec<i64> = {
            let manager = app.state::<McpManager>();
            manager.conns.lock().unwrap().keys().copied().collect()
        };
        for id in ids {
            Self::disconnect_inner(app, id).await;
        }
    }
}

/// 解析 JSON 对象字符串（空/非法返回空 Map，非法值由调用方校验兜底）。
fn parse_json_object(raw: Option<&str>) -> Map<String, Value> {
    raw.and_then(|s| serde_json::from_str::<Map<String, Value>>(s.trim()).ok())
        .unwrap_or_default()
}

/* ---------- 环境变量引用（{{占位符}} 插值） ---------- */

/// 占位符开/闭标记。
const PLACEHOLDER_OPEN: &str = "{{";
const PLACEHOLDER_CLOSE: &str = "}}";

/// 扫描并替换文本中的 `{{变量名}}` 占位符（项目级环境引用，Apifox 同款语法）。
///
/// 规则：
/// - 变量名两侧允许空白（`{{ TOKEN }}` 与 `{{TOKEN}}` 等价）；
/// - 变量集命中 -> 替换为变量值；未命中 -> 原文保留并把变量名记入 `missing`
///   （去重，按首次出现顺序）；
/// - 空名 `{{}}` 与未闭合的 `{{` 视为普通文本原样保留，不进 missing。
///
/// # 使用示例
///
/// ```text
/// vars = {"TOKEN": "abc"}
/// resolve_placeholders("Bearer {{ TOKEN }}", vars, missing) -> "Bearer abc"
/// resolve_placeholders("{{NOPE}}",        vars, missing) -> "{{NOPE}}"，missing 收集 ["NOPE"]
/// ```
fn resolve_placeholders(
    value: &str,
    vars: &std::collections::BTreeMap<String, String>,
    missing: &mut Vec<String>,
) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find(PLACEHOLDER_OPEN) {
        let body_start = start + PLACEHOLDER_OPEN.len();
        let Some(end) = rest[body_start..].find(PLACEHOLDER_CLOSE) else {
            break; // 从 start 起未闭合：剩余文本原样保留（循环外统一追加）
        };
        out.push_str(&rest[..start]);
        let name = rest[body_start..body_start + end].trim();
        match (name.is_empty(), vars.get(name)) {
            (true, _) | (_, None) => {
                // 空名 / 未定义：原文保留；未定义记入 missing
                out.push_str(&rest[start..body_start + end + PLACEHOLDER_CLOSE.len()]);
                if !name.is_empty() && !missing.iter().any(|m| m == name) {
                    missing.push(name.to_string());
                }
            }
            (_, Some(v)) => out.push_str(v),
        }
        rest = &rest[body_start + end + PLACEHOLDER_CLOSE.len()..];
    }
    out.push_str(rest);
    out
}

/// 连接期配置解析：按项目激活环境的变量集对配置做 `{{}}` 插值，返回解析后的新配置。
///
/// 解析范围：command / working_dir / url（整串）、args（JSON 数组逐元素）、
/// env / headers（JSON 对象逐值）；JSON 字段解析失败时原样保留（由保存校验与
/// 传输构建阶段报错）。原配置不被修改（数据库里存的是含 `{{}}` 的原文）。
///
/// 行为约定：
/// - 配置不含任何 `{{` 时走快速路径，不读环境库；
/// - 未选择环境时变量集为空集——含占位符的配置会在下方因 missing 报错，
///   引导用户选择环境（fail-fast，绝不把 `{{TOKEN}}` 原样发给 Server）；
/// - 所选环境已被删除时报错提醒重新选择（不静默回退）。
///
/// # 异常
///
/// 所选环境不存在、环境变量集非法 JSON、存在未定义变量引用时返回 [`AppError`]。
pub(crate) fn resolve_config(
    conn: &rusqlite::Connection,
    config: &ServerConfig,
    project_id: i64,
) -> CmdResult<ServerConfig> {
    // 快速路径：全部文本字段都不含占位符则原样返回
    let has_placeholder = [
        config.command.as_deref(),
        config.args.as_deref(),
        config.env.as_deref(),
        config.working_dir.as_deref(),
        config.url.as_deref(),
        config.headers.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|s| s.contains(PLACEHOLDER_OPEN));
    if !has_placeholder {
        return Ok(config.clone());
    }

    // 激活环境：settings 里按项目存的环境名（空/未设 = 未选择环境）
    let active = crate::db::get_setting(conn, &format!("active_env_{project_id}"))?
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let mut vars = std::collections::BTreeMap::new();
    if let Some(name) = &active {
        let env = crate::db::list_environments(conn, project_id)?
            .into_iter()
            .find(|e| &e.name == name)
            .ok_or_else(|| {
                AppError::new(format!(
                    "当前环境「{name}」不存在（可能已被删除），请到顶栏「环境」重新选择"
                ))
            })?;
        let parsed: serde_json::Value = serde_json::from_str(env.variables.trim())
            .map_err(|e| AppError::new(format!("环境「{name}」的变量集不是合法的 JSON：{e}")))?;
        if let Some(obj) = parsed.as_object() {
            for (k, v) in obj {
                vars.insert(
                    k.clone(),
                    v.as_str().map(String::from).unwrap_or_else(|| v.to_string()),
                );
            }
        }
    }

    let mut missing: Vec<String> = Vec::new();
    let mut resolved = config.clone();
    let mut sub = |s: &str| resolve_placeholders(s, &vars, &mut missing);

    resolved.command = resolved.command.map(|s| sub(&s));
    resolved.working_dir = resolved.working_dir.map(|s| sub(&s));
    resolved.url = resolved.url.map(|s| sub(&s));
    // args：JSON 字符串数组逐元素替换（解析失败原样保留，交由传输构建报错）
    if let Some(raw) = resolved.args.as_deref() {
        if let Ok(items) = serde_json::from_str::<Vec<String>>(raw.trim()) {
            let out: Vec<String> = items.iter().map(|s| sub(s)).collect();
            resolved.args = serde_json::to_string(&out).ok();
        }
    }
    // env / headers：JSON 对象逐值替换（键不替换；非字符串值原样保留）
    resolved.env = resolve_json_object_values(resolved.env.as_deref(), &mut sub);
    resolved.headers = resolve_json_object_values(resolved.headers.as_deref(), &mut sub);

    if !missing.is_empty() {
        let list = missing.iter().map(|m| format!("{{{{{m}}}}}")).collect::<Vec<_>>().join("、");
        let msg = match &active {
            Some(name) => format!(
                "存在未定义的环境变量引用：{list}。环境「{name}」中没有这些变量，请到顶栏「环境」补充变量或切换环境"
            ),
            None => format!(
                "配置中使用了环境变量引用：{list}，但当前未选择环境。请到顶栏「环境」选择环境，或在配置中填写实际值"
            ),
        };
        return Err(AppError::new(msg));
    }
    Ok(resolved)
}

/// 对 JSON 对象字符串的每个字符串值做替换，返回替换后的 JSON 字符串。
///
/// 入参为空/非法时原样返回 `None`（交由保存校验与传输构建阶段报错）。
fn resolve_json_object_values(
    raw: Option<&str>,
    sub: &mut impl FnMut(&str) -> String,
) -> Option<String> {
    let raw = raw?;
    let map: Map<String, Value> = serde_json::from_str(raw.trim()).ok()?;
    let out: Map<String, Value> = map
        .into_iter()
        .map(|(k, v)| {
            let v = match v {
                Value::String(s) => Value::String(sub(&s)),
                other => other,
            };
            (k, v)
        })
        .collect();
    serde_json::to_string(&out).ok()
}

/// 构建 stdio 子进程传输。
///
/// 传入的配置应是 [`resolve_config`] 解析后的结果（`{{}}` 已替换为实际值）。
///
/// # 异常
///
/// - 未填启动命令、参数/环境变量 JSON 非法、子进程启动失败时返回 [`AppError`]。
fn build_stdio_transport(config: &ServerConfig) -> Result<TokioChildProcess, AppError> {
    let command = config
        .command
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::new("stdio 模式必须填写启动命令"))?;
    let args: Vec<String> = match config.args.as_deref().map(str::trim) {
        None | Some("") => Vec::new(),
        Some(s) => serde_json::from_str::<Vec<String>>(s)
            .map_err(|e| AppError::new(format!("参数必须是 JSON 字符串数组：{e}")))?,
    };
    // 环境变量：已由 resolve_config 完成 {{}} 插值，这里直接使用
    let env = parse_json_object(config.env.as_deref());

    TokioChildProcess::new(
        tokio::process::Command::new(command).configure(|cmd| {
            cmd.args(&args);
            for (k, v) in &env {
                if let Some(v_str) = v.as_str() {
                    cmd.env(k, v_str);
                }
            }
            if let Some(dir) = config
                .working_dir
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                cmd.current_dir(dir);
            }
        }),
    )
    .map_err(|e| AppError::new(format!("启动子进程失败：{e}")))
}

/// 构建 Streamable HTTP 传输（含自定义请求头 / 鉴权头）。
///
/// 传入的配置应是 [`resolve_config`] 解析后的结果（`{{}}` 已替换为实际值）。
///
/// # 异常
///
/// - URL 缺失或非 http(s)、headers JSON 非法、头名称/值不合法时返回 [`AppError`]。
fn build_http_transport(
    config: &ServerConfig,
) -> Result<StreamableHttpClientTransport<reqwest::Client>, AppError> {
    let url = config
        .url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::new("Streamable HTTP 模式必须填写服务地址 URL"))?;
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(AppError::new("服务地址必须以 http:// 或 https:// 开头"));
    }
    let mut builder = StreamableHttpClientTransportConfig::with_uri(url);

    // 自定义 headers：已由 resolve_config 完成 {{}} 插值（JSON 对象 -> HeaderName/HeaderValue）
    let headers = parse_json_object(config.headers.as_deref());
    if !headers.is_empty() {
        let mut map = HashMap::new();
        for (k, v) in headers {
            let name = http::HeaderName::from_bytes(k.as_bytes())
                .map_err(|e| AppError::new(format!("请求头名称「{k}」不合法：{e}")))?;
            let value = v
                .as_str()
                .ok_or_else(|| AppError::new(format!("请求头「{k}」的值必须是字符串")))?;
            let header_value = http::HeaderValue::from_str(value)
                .map_err(|e| AppError::new(format!("请求头「{k}」的值不合法：{e}")))?;
            map.insert(name, header_value);
        }
        builder = builder.custom_headers(map);
    }

    Ok(StreamableHttpClientTransport::from_config(builder))
}

/// 错误信息脱敏：剥离可能混入的 header/env 敏感值。
///
/// 策略：把配置里各敏感字段的值（长度 ≥ 4 的字符串）从错误文本中替换为 `***`。
/// 传入的配置应是解析后的结果——只有解析后的真实值才可能出现在连接错误里。
fn sanitize(mut msg: String, config: &ServerConfig) -> String {
    let mut secrets: Vec<String> = Vec::new();
    collect_secret_values(&parse_json_object(config.headers.as_deref()), &mut secrets);
    collect_secret_values(&parse_json_object(config.env.as_deref()), &mut secrets);
    for secret in secrets {
        msg = msg.replace(&secret, "***");
    }
    msg
}

/// 从 JSON 对象里收集值形式的敏感字符串（长度 ≥ 4 才收集，避免误伤过短的普通词）。
fn collect_secret_values(map: &Map<String, Value>, out: &mut Vec<String>) {
    for (_k, v) in map {
        if let Some(sv) = v.as_str() {
            if sv.len() >= 4 {
                out.push(sv.to_string());
            }
        }
    }
}

/* ---------- 插值引擎单元测试（内存库，不依赖网络/子进程） ---------- */

#[cfg(test)]
mod resolve_tests {
    use super::*;
    use crate::db;
    use crate::models::TransportType;

    /// 内存数据库（每个测试独立，已跑迁移）。
    fn setup() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    /// 构造一个 http 配置（其余字段为空默认值）。
    fn cfg(url: &str) -> ServerConfig {
        ServerConfig {
            node_id: 0,
            transport_type: TransportType::StreamableHttp,
            command: None,
            args: None,
            env: None,
            working_dir: None,
            url: Some(url.into()),
            headers: None,
            sensitive_headers: None,
            timeout_ms: 30_000,
            enabled: true,
            note: None,
            envs: None,
            active_env: None,
        }
    }

    #[test]
    fn 占位符替换与未定义收集() {
        let vars = std::collections::BTreeMap::from([("TOKEN".to_string(), "abc".to_string())]);
        let mut missing = Vec::new();
        // 命中替换（两侧空白等价）+ 未定义保留原文并收集
        assert_eq!(resolve_placeholders("Bearer {{ TOKEN }}", &vars, &mut missing), "Bearer abc");
        assert_eq!(resolve_placeholders("{{NOPE}}-{{TOKEN}}", &vars, &mut missing), "{{NOPE}}-abc");
        assert_eq!(missing, ["NOPE"]);
        // 未闭合 / 空名原样保留、不进 missing
        let mut m2 = Vec::new();
        assert_eq!(resolve_placeholders("a{{b", &vars, &mut m2), "a{{b");
        assert_eq!(resolve_placeholders("{{}}", &vars, &mut m2), "{{}}");
        assert!(m2.is_empty());
    }

    #[test]
    fn 解析按激活环境插值且不改原配置() {
        let mut conn = setup();
        let p = db::create_project(&conn, "p", None).unwrap();
        db::replace_environments(
            &mut conn,
            p.id,
            &[db::EnvironmentInput {
                name: "dev".into(),
                variables: r#"{"TOKEN":"dev-token","HOST":"127.0.0.1"}"#.into(),
            }],
        )
        .unwrap();
        db::set_setting(&conn, &format!("active_env_{}", p.id), "dev").unwrap();

        let mut c = cfg("http://{{HOST}}:3000/mcp");
        c.headers = Some(r#"{"Authorization":"Bearer {{TOKEN}}","X-Lit":"{{MISSING}}"}"#.into());
        // 有未定义引用 -> 报错并列出变量名
        let err = resolve_config(&conn, &c, p.id).unwrap_err();
        assert!(err.message.contains("{{MISSING}}"), "实际：{}", err.message);
        // 补全后成功插值
        c.headers = Some(r#"{"Authorization":"Bearer {{TOKEN}}"}"#.into());
        let r = resolve_config(&conn, &c, p.id).unwrap();
        assert_eq!(r.url.as_deref(), Some("http://127.0.0.1:3000/mcp"));
        assert!(r.headers.as_deref().unwrap().contains("Bearer dev-token"));
        // 原配置不被修改（数据库存的是含 {{}} 的原文）
        assert_eq!(c.url.as_deref(), Some("http://{{HOST}}:3000/mcp"));
    }

    #[test]
    fn 未选环境时含引用报错_无引用走快速路径() {
        let conn = setup();
        let p = db::create_project(&conn, "p", None).unwrap();
        // 未选环境 + 含 {{}} -> 报错引导选择环境（不把占位符原样发出）
        let c = cfg("http://{{HOST}}/mcp");
        let err = resolve_config(&conn, &c, p.id).unwrap_err();
        assert!(err.message.contains("未选择环境"), "实际：{}", err.message);
        // 无占位符快速路径：环境库为空也不报错
        let plain = cfg("http://127.0.0.1:3000/mcp");
        let r = resolve_config(&conn, &plain, p.id).unwrap();
        assert_eq!(r.url, plain.url);
    }

    #[test]
    fn 激活环境被删除时明确报错() {
        let conn = setup();
        let p = db::create_project(&conn, "p", None).unwrap();
        db::set_setting(&conn, &format!("active_env_{}", p.id), "ghost").unwrap();
        let c = cfg("http://{{HOST}}/mcp");
        let err = resolve_config(&conn, &c, p.id).unwrap_err();
        assert!(err.message.contains("ghost"), "实际：{}", err.message);
    }
}

/* ---------- 端到端集成测试（依赖本机 node 与 /tmp/mcpilot-test 下的测试 server） ---------- */

#[cfg(test)]
mod e2e_tests {
    use super::*;
    use crate::models::{TransportType::Stdio, TransportType::StreamableHttp};

    /// 测试脚本缺失时跳过（非本机环境不失败）
    fn skip_if_missing(path: &str) -> bool {
        !std::path::Path::new(path).exists()
    }

    fn stdio_cfg() -> ServerConfig {
        ServerConfig {
            node_id: 0,
            transport_type: Stdio,
            command: Some("node".into()),
            args: Some(r#"["/tmp/mcpilot-test/stdio-server.mjs"]"#.into()),
            env: Some(r#"{"DEBUG":"topsecret"}"#.into()),
            working_dir: None,
            url: None,
            headers: None,
            sensitive_headers: None,
            timeout_ms: 10_000,
            enabled: true,
            note: None,
            envs: None,
            active_env: None,
        }
    }

    /// 从 CallResult 的 content 里提取文本
    fn text_of(content: &Value) -> String {
        content
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|c| {
                        let o = c.as_object()?;
                        if o.get("type")?.as_str()? == "text" {
                            o.get("text")?.as_str().map(String::from)
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn stdio_端到端_连接列表调用与脱敏() {
        let script = "/tmp/mcpilot-test/stdio-server.mjs";
        if skip_if_missing(script) {
            eprintln!("跳过：找不到 {script}");
            return;
        }
        let cfg = stdio_cfg();
        let transport = build_stdio_transport(&cfg).expect("构建 stdio 传输");
        let service = ().serve(transport).await.expect("握手");
        let tools = service.peer().list_tools(None).await.expect("tools/list");
        assert_eq!(tools.tools.len(), 2);
        assert_eq!(tools.tools[0].name, "echo");

        let params = CallToolRequestParams::new("add")
            .with_arguments(JsonObject::from(
                serde_json::json!({"a": 40, "b": 2})
                    .as_object()
                    .cloned()
                    .unwrap(),
            ));
        let res = service.peer().call_tool(params).await.expect("tools/call");
        assert!(!res.is_error.unwrap_or(true));
        let v = serde_json::to_value(&res.content).unwrap();
        assert_eq!(text_of(&v), "42");

        // 脱敏验证：把敏感词放进错误文案后应被替换
        let msg = sanitize("连接失败 secret=topsecret 泄漏".into(), &cfg);
        assert!(!msg.contains("topsecret"), "脱敏失败：{msg}");
        assert!(msg.contains("***"));
        let _ = service.cancel().await;
    }

    #[tokio::test]
    async fn http_端到端_会话与自定义头() {
        let port = 3931; // 测试专用端口，避免与手动调试实例冲突
        let script = "/tmp/mcpilot-test/http-server.mjs";
        if skip_if_missing(script) {
            eprintln!("跳过：找不到 {script}");
            return;
        }
        let mut child = tokio::process::Command::new("node")
            .arg(script)
            .env("PORT", port.to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("启动 http 测试 server");
        // 等待端口就绪
        let mut up = false;
        for _ in 0..50 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                up = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(up, "http 测试 server 未就绪");

        let cfg = ServerConfig {
            node_id: 0,
            transport_type: StreamableHttp,
            command: None,
            args: None,
            env: None,
            working_dir: None,
            url: Some(format!("http://127.0.0.1:{port}/mcp")),
            headers: Some(r#"{"Authorization":"Bearer test-token-123456"}"#.into()),
            sensitive_headers: Some(r#"["Authorization"]"#.into()),
            timeout_ms: 10_000,
            enabled: true,
            note: None,
            envs: None,
            active_env: None,
        };
        let transport = build_http_transport(&cfg).expect("构建 http 传输");
        let service = ().serve(transport).await.expect("握手");
        let tools = service.peer().list_tools(None).await.expect("tools/list");
        assert_eq!(tools.tools.len(), 1);
        assert_eq!(tools.tools[0].name, "upper");

        let params = CallToolRequestParams::new("upper").with_arguments(JsonObject::from(
            serde_json::json!({"text": "hello mcpilot"})
                .as_object()
                .cloned()
                .unwrap(),
        ));
        let res = service.peer().call_tool(params).await.expect("tools/call");
        let v = serde_json::to_value(&res.content).unwrap();
        let txt = text_of(&v);
        assert!(txt.contains("HELLO MCPILOT"), "实际返回：{txt}");
        // 请求头已随请求送达（测试 server 会在带 Authorization 时打标记）
        assert!(txt.contains("已带鉴权头"), "自定义头未送达：{txt}");

        let _ = service.cancel().await;
        let _ = child.kill().await;
    }
}

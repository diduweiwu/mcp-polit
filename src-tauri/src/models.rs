//! 数据模型层：定义前后端共享的数据结构（全部可序列化）。
//!
//! 这些结构与 SQLite 表一一对应，通过 serde 与前端 TypeScript 类型保持一致。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 项目：最顶层的数据组织单位，左上角可切换。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    /// 项目 ID，自增主键
    pub id: i64,
    /// 项目名称
    pub name: String,
    /// 创建时间（本地时间字符串）
    pub created_at: String,
    /// 最后更新时间（本地时间字符串）
    pub updated_at: String,
}

/// 树节点类型：目录或 MCP Server。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    /// 目录（可嵌套，可包含子目录与 Server）
    Folder,
    /// MCP Server（挂在某个目录或根层下）
    Server,
}

/// 树节点：项目内的目录 / Server 统一用一张扁平表存储，前端负责组装成树。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeNode {
    /// 节点 ID，自增主键
    pub id: i64,
    /// 所属项目 ID
    pub project_id: i64,
    /// 父节点 ID；None 表示位于项目根层
    pub parent_id: Option<i64>,
    /// 节点类型：folder（目录）或 server（MCP Server）
    pub node_type: NodeType,
    /// 显示名称：目录名，或 Server 的别名
    pub name: String,
    /// 同层排序序号（小的在前）
    pub sort_order: i64,
    /// 创建时间（本地时间字符串）
    pub created_at: String,
    /// 最后更新时间（本地时间字符串）
    pub updated_at: String,
}

/// MCP 传输类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportType {
    /// stdio：本地子进程方式启动 MCP Server
    Stdio,
    /// streamable_http：远程 Streamable HTTP 方式连接 MCP Server
    StreamableHttp,
}

/// MCP Server 连接配置，与树节点 1:1（仅 node_type = server 的节点有配置）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    /// 对应树节点 ID（主键）
    pub node_id: i64,
    /// 传输类型：stdio 或 streamable_http
    pub transport_type: TransportType,
    /// stdio 模式：启动命令（如 npx / uvx / node）
    pub command: Option<String>,
    /// stdio 模式：命令参数（JSON 数组字符串，如 ["-y","server-xxx"]）
    pub args: Option<String>,
    /// stdio 模式：附加环境变量（JSON 对象字符串，如 {"KEY":"VALUE"}）
    pub env: Option<String>,
    /// stdio 模式：工作目录（可选）
    pub working_dir: Option<String>,
    /// streamable_http 模式：服务地址（如 http://127.0.0.1:3000/mcp）
    pub url: Option<String>,
    /// streamable_http 模式：自定义请求头（JSON 对象字符串，可放 Authorization 等鉴权头）
    pub headers: Option<String>,
    /// 工具调用超时时间（毫秒）
    pub timeout_ms: i64,
    /// 是否启用该 Server
    pub enabled: bool,
    /// 备注（可选）
    pub note: Option<String>,
}

/// 工具信息：从 MCP Server 的 tools/list 结果中提炼、传给前端的结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInfo {
    /// 工具名
    pub name: String,
    /// 工具标题（可选，较新的 server 才有）
    pub title: Option<String>,
    /// 工具描述
    pub description: Option<String>,
    /// 输入参数的 JSON Schema（原样透传给前端渲染表单）
    pub input_schema: Value,
}

/// 连接状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnStatus {
    /// 未连接
    Disconnected,
    /// 正在连接（握手进行中）
    Connecting,
    /// 已连接
    Connected,
    /// 连接出错或调用出错
    Error,
}

/// 连接状态变化事件负载：通过 Tauri event 推送给前端。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnStateEvent {
    /// 树节点 ID（即 server ID）
    pub node_id: i64,
    /// 新状态
    pub status: ConnStatus,
    /// 错误信息（仅 status = error 时存在；注意：不含敏感的 header/env 内容）
    pub message: Option<String>,
}

/// 工具调用结果：传给前端展示。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallResult {
    /// 本次调用的自增序号（前端用于结果面板区分多次调用）
    pub seq: i64,
    /// 被调用的工具名
    pub tool_name: String,
    /// 是否为错误结果（来自 MCP 协议的 isError 标记）
    pub is_error: bool,
    /// 内容列表（text / image 等，原样透传）
    pub content: Value,
    /// 结构化内容（部分 server 会返回 structuredContent）
    pub structured_content: Option<Value>,
    /// 调用耗时（毫秒）
    pub duration_ms: i64,
    /// 入参快照（JSON 字符串，便于前端历史对照）
    pub arguments: String,
}

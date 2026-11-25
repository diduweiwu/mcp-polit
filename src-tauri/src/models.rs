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
    /// 同步绑定的 git 仓库目录；None 表示未开启同步
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_dir: Option<String>,
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
    /// 自定义图标标识（前端 icon 注册表的 key，如 "database"）；None = 使用默认图标。
    /// 同步导出写入 tree.json 随仓库分发，旧版应用导入时忽略该字段
    #[serde(default)]
    pub icon: Option<String>,
    /// 同层排序序号（小的在前）
    pub sort_order: i64,
    /// 创建时间（本地时间字符串）
    pub created_at: String,
    /// 最后更新时间（本地时间字符串）
    pub updated_at: String,
    /// 传输类型（仅 server 节点有值，前端按协议类型着色标识）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport_type: Option<TransportType>,
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
    /// 敏感请求头名称列表（JSON 数组字符串，如 ["Authorization"]）：
    /// 标记哪些头的值属于敏感信息，摘要/编辑展示时以星号打码，仅影响展示不影响连接
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sensitive_headers: Option<String>,
    /// 工具调用超时时间（毫秒）
    pub timeout_ms: i64,
    /// 是否启用该 Server
    pub enabled: bool,
    /// 备注（可选）
    pub note: Option<String>,
    /// 【已废弃】旧版每 Server 内嵌环境组（JSON：{"dev":{"env":{...},"headers":{...}}}）。
    /// 环境模型已改为项目级环境库（`environments` 表）+ 配置中 `{{变量名}}` 引用；
    /// 本字段仅保留旧数据不被删除（休眠不读），Git 同步仍原样透传以防回退丢数据。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub envs: Option<String>,
    /// 【已废弃】旧版激活的环境名。保留原因同 `envs`；连接解析不再读取。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_env: Option<String>,
}

/// 项目级环境：一组可在 Server 配置中以 `{{变量名}}` 引用的变量。
///
/// 同一项目下可定义多套环境（如 dev / prod），同一时刻全局激活一套；
/// 连接 Server 时按激活环境的变量集对配置值做插值替换。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Environment {
    /// 环境 ID，自增主键
    pub id: i64,
    /// 所属项目 ID
    pub project_id: i64,
    /// 环境名（同项目内唯一，如 dev / prod）
    pub name: String,
    /// 变量集（JSON 对象字符串，如 {"TOKEN":"xxx"}；配置中以 {{键}} 引用）
    pub variables: String,
    /// 同项目内排序序号（小的在前）
    pub sort_order: i64,
}

/// 旧版每 Server 环境组（`envs` 字段）向项目级环境库合并的结果报告。
///
/// 由 [`crate::db::merge_legacy_envs`] 产出，经 [`Self::to_logs`] 转成日志条目
/// 展示给用户，保证迁移过程可见、冲突不静默。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LegacyEnvsMergeReport {
    /// 扫描的 Server 总数（项目内全部 server 节点）
    pub scanned_servers: usize,
    /// 携带旧环境组数据的 Server 别名列表
    pub servers_with_envs: Vec<String>,
    /// 本次新建的环境名列表
    pub created_envs: Vec<String>,
    /// 向已有环境补充变量的（环境名, 补充的变量键列表）列表
    pub merged_into: Vec<(String, Vec<String>)>,
    /// 同键取值冲突明细（环境库已有值优先保留，新值丢弃）：每条一句人话
    pub conflicts: Vec<String>,
}

impl LegacyEnvsMergeReport {
    /// 把合并报告转成用户可见的日志条目（info 明细 + warn 冲突）。
    ///
    /// 无旧数据（`servers_with_envs` 为空，含已迁移过的重复调用）时返回空，
    /// 调用方静默即可，不骚扰用户。
    ///
    /// # 使用示例
    ///
    /// ```text
    /// LegacyEnvsMergeReport::default().to_logs().is_empty() == true  // 无旧数据 -> 静默
    /// ```
    pub fn to_logs(&self) -> Vec<LogEntry> {
        if self.servers_with_envs.is_empty() {
            return Vec::new();
        }
        let mut logs = Vec::new();
        logs.push(LogEntry {
            level: "info".into(),
            message: format!(
                "检测到旧版 Server 环境组数据（{} 个 Server：{}），已合并进项目环境库",
                self.servers_with_envs.len(),
                self.servers_with_envs.join("、")
            ),
        });
        if !self.created_envs.is_empty() {
            logs.push(LogEntry {
                level: "info".into(),
                message: format!("新建环境：{}", self.created_envs.join("、")),
            });
        }
        for (name, keys) in &self.merged_into {
            logs.push(LogEntry {
                level: "info".into(),
                message: format!("环境「{name}」补充变量：{}", keys.join("、")),
            });
        }
        for c in &self.conflicts {
            logs.push(LogEntry {
                level: "warn".into(),
                message: format!("合并冲突：{c}"),
            });
        }
        logs.push(LogEntry {
            level: "info".into(),
            message: "旧环境组数据已保留在原 Server 配置中（不再生效），可在配置值里改用 {{变量名}} 引用环境变量".into(),
        });
        logs
    }
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
    /// 请求头快照：连接时按激活环境插值后实际发送的请求头（JSON 对象字符串）。
    /// 仅 Streamable HTTP 传输有值；stdio 为本地子进程无 HTTP 头；旧历史记录无值
    #[serde(default)]
    pub request_headers: Option<String>,
    /// 敏感请求头名称名单（JSON 数组字符串，原样取自 Server 配置）：
    /// 前端展示时这些头的值打码为星号，复制按钮仍复制明文
    #[serde(default)]
    pub sensitive_headers: Option<String>,
}

/// 日志条目：同步等操作的执行记录，前端在结果面板底部的日志区展示。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    /// 级别。枚举：info-普通信息；warn-警告；error-错误
    pub level: String,
    /// 日志内容
    pub message: String,
}

/// 工具调用历史记录：落盘 SQLite，跨会话保留（全局，不限项目）。
///
/// `result` 通过 serde flatten 展开，前端看到的形态为
/// `{ id, node_id, server_name, created_at, starred, ...CallResult 字段 }`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryRecord {
    /// 记录 ID：自增主键；前端新增时传 0，由后端落库生成
    pub id: i64,
    /// 被调用 Server 的树节点 ID：仅作展示关联，节点删除后历史仍保留
    pub node_id: i64,
    /// Server 别名：冗余存储，节点删除后仍可读
    pub server_name: String,
    /// 调用时间：本地时间字符串（YYYY-MM-DD HH:MM:SS）；前端新增时传空串，由后端生成
    pub created_at: String,
    /// 是否被收藏。枚举：false-未收藏；true-已收藏。收藏行不被总量裁剪删除，清空历史时保留
    #[serde(default)]
    pub starred: bool,
    /// 调用结果主体（工具名、是否出错、content、耗时、入参快照等）
    #[serde(flatten)]
    pub result: CallResult,
}

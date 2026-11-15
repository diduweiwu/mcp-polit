/**
 * 前后端共享的数据类型定义（与 Rust 端 models.rs 一一对应）。
 */

/** 项目：最顶层的数据组织单位 */
export interface Project {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
  /** 同步绑定的 git 仓库目录；无则未开启同步 */
  sync_dir?: string | null;
}

/** 分支信息：当前分支 + 全部本地分支 */
export interface BranchInfo {
  current: string;
  branches: string[];
}

/** 树节点类型 */
export type NodeType = "folder" | "server";

/** 树节点：目录 / MCP Server 统一结构（扁平存储，前端组装树） */
export interface TreeNode {
  id: number;
  project_id: number;
  parent_id: number | null;
  node_type: NodeType;
  /** 目录名或 Server 别名 */
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  /** 传输类型（仅 server 节点有值，按协议类型着色标识） */
  transport_type?: TransportType | null;
}

/** MCP 传输类型 */
export type TransportType = "stdio" | "streamable_http";

/** MCP Server 连接配置 */
export interface ServerConfig {
  node_id: number;
  transport_type: TransportType;
  /** stdio：启动命令 */
  command: string | null;
  /** stdio：JSON 数组字符串 */
  args: string | null;
  /** stdio：JSON 对象字符串 */
  env: string | null;
  /** stdio：工作目录 */
  working_dir: string | null;
  /** http：服务地址 */
  url: string | null;
  /** http：JSON 对象字符串（含鉴权头） */
  headers: string | null;
  /** 工具调用超时（毫秒） */
  timeout_ms: number;
  enabled: boolean;
  note: string | null;
}

/** 连接状态 */
export type ConnStatus = "disconnected" | "connecting" | "connected" | "error";

/** 连接状态事件负载（Tauri event "conn-state"） */
export interface ConnStateEvent {
  node_id: number;
  status: ConnStatus;
  message: string | null;
}

/** 工具信息（tools/list 提炼） */
export interface ToolInfo {
  name: string;
  title: string | null;
  description: string | null;
  /** 输入参数 JSON Schema */
  input_schema: JsonSchema;
}

/** JSON Schema（宽松定义，按需取用字段） */
export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: (string | number)[];
  enumNames?: string[];
  items?: JsonSchema;
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | JsonSchema;
}

/** 日志级别 */
export type LogLevel = "info" | "warn" | "error";

/** 日志条目（同步等操作的执行记录） */
export interface LogEntry {
  /** 前端写入时生成的显示时间 HH:MM:SS */
  time: string;
  level: LogLevel;
  message: string;
}

/** 历史调用记录：CallResult + 定位元数据（所有工具共用一份全局列表） */
export interface HistoryEntry extends CallResult {
  /** 被调用 server 的树节点 ID */
  node_id: number;
  /** server 别名（冗余存储，跨项目可读） */
  server_name: string;
  /** 本地时间 HH:MM:SS */
  timestamp: string;
}

/** 工具调用结果 */
export interface CallResult {
  /** 调用序号（前端生成，用于结果对照） */
  seq: number;
  tool_name: string;
  is_error: boolean;
  /** MCP content 数组（text/image 等原样透传） */
  content: unknown;
  structured_content: unknown | null;
  duration_ms: number;
  /** 入参快照（JSON 字符串） */
  arguments: string;
}

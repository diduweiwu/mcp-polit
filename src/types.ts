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

/** 同步目录绑定前检测结果（sync_dir_status 命令返回，与 Rust SyncDirStatus 对应） */
export interface SyncDirStatus {
  /** 目录是否存在且是目录（不存在时绑定流程会自动创建） */
  exists: boolean;
  /** 忽略 .git / .DS_Store 后是否有实际内容 */
  has_content: boolean;
  /** 是否为 MCPilot 同步仓库（含 tree.json 元数据，可作为导入来源） */
  is_repo: boolean;
}

/**
 * 目录数据冲突时的方向选择（用户在冲突弹窗中选定）：
 * project = 以项目数据为准（清空仓库内容后导出项目数据）；
 * git = 以 Git 仓库数据为准（仓库配置导入项目，覆盖项目现有数据）；
 * merge_git / merge_project = 合并（仓库数据并入项目，两边都保留，
 * 同名目录/Server/环境按名称对齐后分别以仓库/项目配置为准）
 */
export type SyncDirResolve = "project" | "git" | "merge_git" | "merge_project";

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
  /** http：JSON 数组字符串——敏感请求头名称列表（如 ["Authorization"]），展示时值打码为星号，仅影响展示不影响连接 */
  sensitive_headers?: string | null;
  /** 工具调用超时（毫秒） */
  timeout_ms: number;
  enabled: boolean;
  note: string | null;
  /** 【已废弃】旧版每 Server 内嵌环境组 JSON：{"dev":{"env":{...},"headers":{...}}}。
   *  环境模型已改为项目级环境库（Environment）+ 配置值中 {{变量名}} 引用；
   *  本字段仅保留旧数据不被删除（不再读取、不再编辑），Git 同步原样透传防丢数据 */
  envs?: string | null;
  /** 【已废弃】旧版激活环境名。保留原因同 envs；连接解析不再读取 */
  active_env?: string | null;
}

/** 项目级环境：一组可被 Server 配置以 {{变量名}} 引用的变量（variables 为 JSON 对象字符串） */
export interface Environment {
  /** 环境 ID（自增主键；整批保存后由后端重新生成，前端列表 key 请用 name） */
  id: number;
  /** 所属项目 ID */
  project_id: number;
  /** 环境名（同项目内唯一，如 dev / prod） */
  name: string;
  /** 变量集：JSON 对象字符串，如 '{"TOKEN":"xxx"}' */
  variables: string;
  /** 同项目内排序序号（小的在前） */
  sort_order: number;
}

/** 单个调用参数 Case（保存的入参快照） */
export interface ParamCase {
  /** Case 名称 */
  name: string;
  /** 入参 JSON 字符串 */
  args: string;
  /** 保存时间 HH:MM:SS */
  saved_at: string;
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

/** 日志条目（同步、连接等操作的执行记录） */
export interface LogEntry {
  /** 前端写入时生成的显示时间 HH:MM:SS */
  time: string;
  level: LogLevel;
  message: string;
  /** 归属的 server 节点 ID；缺省表示全局日志（项目操作、Git 同步等） */
  node_id?: number;
}

/** 历史调用记录：CallResult + 定位元数据（所有工具共用一份全局列表） */
export interface HistoryEntry extends CallResult {
  /** 落库自增 ID：作为条目展示编号（最新最大、跨会话稳定）；会话内新调用在落盘返回前暂缺 */
  id?: number;
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

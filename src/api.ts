/**
 * Tauri IPC 封装层：所有对 Rust 后端的调用集中在这里，带完整类型。
 */
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  BranchInfo,
  CallResult,
  ConnStateEvent,
  Project,
  ServerConfig,
  ToolInfo,
  TreeNode,
  NodeType,
} from "./types";

/** 项目 GitHub 仓库主页（顶栏与关于页的仓库入口共用） */
export const REPO_URL = "https://github.com/diduweiwu/mcp-polit";

/* ---------- 项目 ---------- */

/** 列出全部项目 */
export const listProjects = () => invoke<Project[]>("list_projects");

/** 新建项目（syncDir 为可选的同步目录，后端会校验/创建并 git init） */
export const createProject = (name: string, syncDir?: string) =>
  invoke<Project>("create_project", { name, syncDir: syncDir || null });

/** 重命名项目 */
export const renameProject = (id: number, name: string) =>
  invoke<void>("rename_project", { id, name });

/**
 * 更新项目同步目录（传 null 解除绑定）。
 *
 * 目录规则：必须是空目录（不存在会自动创建并 git init），非空目录拒绝绑定；
 * 绑定成功后项目已有数据会自动迁移到该目录并创建初始提交。
 *
 * @returns 元组：[更新后的项目，操作日志]——日志（迁移/错误信息）由调用方写入日志面板
 */
export const updateProjectSyncDir = (id: number, syncDir: string | null) =>
  invoke<[Project, Array<{ level: string; message: string }>]>("update_project_sync_dir", {
    id,
    syncDir,
  });

/** 用系统文件管理器打开目录（macOS Finder / Windows 资源管理器 / Linux 文件管理器） */
export const openDir = (path: string) => invoke<void>("open_dir", { path });

/** 删除项目（级联删除节点与配置，后端会先断开连接） */
export const deleteProject = (id: number) => invoke<void>("delete_project", { id });

/**
 * 打开系统「选择目录」对话框（tauri-plugin-dialog），供同步目录字段一键填入。
 * 不限制所选目录是否为 git 仓库——绑定后端会校验/创建并自动 git init。
 *
 * @param title 对话框标题（如「选择同步目录」）
 * @returns 确认选择时返回目录绝对路径；取消或关闭对话框时返回 null
 * @throws 插件调起失败时抛出异常（权限被拒等），调用方自行捕获
 */
export async function pickDirectory(title: string): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

/**
 * 用系统默认浏览器打开项目 GitHub 仓库主页（tauri-plugin-opener）。
 * 浏览器演示模式（无 Tauri 环境）下降级为 window.open 新标签页打开。
 *
 * @throws opener 插件调起失败时抛出异常，调用方自行捕获处理
 */
export async function openRepoPage(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) {
    window.open(REPO_URL, "_blank");
    return;
  }
  await openUrl(REPO_URL);
}

/* ---------- 树节点 ---------- */

/** 列出项目下全部节点（扁平列表） */
export const listNodes = (projectId: number) =>
  invoke<TreeNode[]>("list_nodes", { projectId });

/** 新建目录/Server 节点 */
export const createNode = (
  projectId: number,
  parentId: number | null,
  nodeType: NodeType,
  name: string,
) =>
  invoke<TreeNode>("create_node", {
    projectId,
    parentId,
    nodeType,
    name,
  });

/** 重命名节点 */
export const renameNode = (id: number, name: string) =>
  invoke<TreeNode>("rename_node", { id, name });

/** 移动节点（拖拽） */
export const moveNode = (id: number, newParentId: number | null) =>
  invoke<TreeNode>("move_node", { id, newParentId });

/** 删除节点（级联） */
export const deleteNode = (id: number) => invoke<void>("delete_node", { id });

/** 复制节点：目录连同整棵子树（含 Server 配置）一起复制，副本排在同级末尾 */
export const duplicateNode = (id: number, name: string) =>
  // 注意参数名必须是 nodeId：Rust 端 duplicate_node 的入参为 node_id，
  // Tauri 按 camelCase↔snake_case 匹配，传 id 会导致「missing required key node_id」
  invoke<TreeNode>("duplicate_node", { nodeId: id, name });

/* ---------- Server 配置 ---------- */

/** 读取 Server 配置 */
export const getServerConfig = (nodeId: number) =>
  invoke<ServerConfig>("get_server_config", { nodeId });

/** 保存 Server 配置 */
export const saveServerConfig = (config: ServerConfig) =>
  invoke<void>("save_server_config", { config });

/** 测试连通性：用表单中的未保存配置握手 + 拉取工具列表，成功返回工具列表 */
export const testServerConfig = (config: ServerConfig) =>
  invoke<ToolInfo[]>("test_server_config", { config });

/* ---------- 连接与调用 ---------- */

/** 连接 server，成功返回工具列表 */
export const connectServer = (nodeId: number) =>
  invoke<ToolInfo[]>("connect_server", { nodeId });

/** 断开 server */
export const disconnectServer = (nodeId: number) =>
  invoke<void>("disconnect_server", { nodeId });

/** 刷新工具列表（重连） */
export const refreshTools = (nodeId: number) =>
  invoke<ToolInfo[]>("refresh_tools", { nodeId });

/** 获取缓存工具列表（连接存活时窗口刷新恢复用） */
export const getCachedTools = (nodeId: number) =>
  invoke<ToolInfo[]>("get_cached_tools", { nodeId });

/** 查询连接状态 */
export const getConnState = (nodeId: number) =>
  invoke<ConnStateEvent>("get_conn_state", { nodeId });

/** 调用工具 */
export const callTool = (
  nodeId: number,
  toolName: string,
  argsJson: string,
  seq: number,
) =>
  invoke<CallResult>("call_tool", {
    nodeId,
    toolName,
    arguments: argsJson,
    seq,
  });

/* ---------- 应用设置 ---------- */

/** 读取全部设置 */
export const getSettings = () =>
  invoke<Array<[string, string]>>("get_settings");

/** 写入一个设置项 */
export const saveSetting = (key: string, value: string) =>
  invoke<void>("save_setting", { key, value });

/* ---------- 调用历史 ---------- */

/** 后端落盘的历史记录行（serde flatten 展开 CallResult 字段后的形态） */
export interface StoredHistoryRow extends CallResult {
  /** 记录 ID：后端自增主键 */
  id: number;
  /** 被调用 server 的树节点 ID */
  node_id: number;
  /** server 别名（冗余存储） */
  server_name: string;
  /** 调用时间：完整本地时间串（YYYY-MM-DD HH:MM:SS） */
  created_at: string;
}

/** 追加一条调用历史（id / created_at 由后端生成，传 0 和空串即可），返回新记录的自增 ID */
export const appendHistory = (record: StoredHistoryRow) =>
  invoke<number>("append_history", { record });

/** 分页读取调用历史（新 → 旧；offset 为已加载条数，首页传 0） */
export const listHistory = (limit: number, offset: number) =>
  invoke<StoredHistoryRow[]>("list_history", { limit, offset });

/** 清空全部调用历史 */
export const clearHistory = () => invoke<void>("clear_history");

/* ---------- 项目级同步 ---------- */

/**
 * 推送项目到其绑定的 git 仓库（导出 + commit + push）。
 *
 * @param projectId 项目 ID
 * @param message 用户填写的提交信息；null/undefined/空白时后端使用默认提交信息「MCPilot 配置同步」
 * @returns 操作日志（info/warn/error），调用方按级别做界面提醒
 */
export const projectSyncPush = (projectId: number, message?: string | null) =>
  invoke<Array<{ level: string; message: string }>>("project_sync_push", {
    projectId,
    message: message?.trim() || null,
  });

/** 从项目绑定的 git 仓库拉取并导入（覆盖当前配置） */
export const projectSyncPull = (projectId: number) =>
  invoke<Array<{ level: string; message: string }>>("project_sync_pull", { projectId });

/**
 * 同步目录自动导出（实时同步）：把当前配置全量写入同步目录（不含 git 操作）。
 *
 * 变更后由 store 的 scheduleSyncExport 防抖调用；成功返回空日志（静默），
 * 失败返回 warn 日志供日志面板展示，不影响触发它的操作。
 */
export const projectSyncExport = (projectId: number) =>
  invoke<Array<{ level: string; message: string }>>("project_sync_export", { projectId });

/**
 * 追加一条前端诊断日志到 crash.log（与后端 panic / ObjC 异常同一文件，跨会话可查）。
 *
 * main.tsx 的全局异常监听调用：kind 用 `JS_ERROR` / `JS_REJECTION`，
 * message 建议含简要堆栈。写入失败直接 reject，调用方 catch 静默即可。
 */
export const appendDiagLog = (kind: string, message: string) =>
  invoke<void>("append_diag_log", { kind, message });

/** 列出项目同步仓库的分支 */
export const projectBranches = (projectId: number) =>
  invoke<BranchInfo>("project_branches", { projectId });

/** 切换项目同步仓库的分支 */
export const projectCheckout = (projectId: number, branch: string) =>
  invoke<void>("project_checkout", { projectId, branch });

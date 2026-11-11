/**
 * Tauri IPC 封装层：所有对 Rust 后端的调用集中在这里，带完整类型。
 */
import { invoke } from "@tauri-apps/api/core";
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

/* ---------- 项目 ---------- */

/** 列出全部项目 */
export const listProjects = () => invoke<Project[]>("list_projects");

/** 新建项目（syncDir 为可选的同步目录，后端会校验/创建并 git init） */
export const createProject = (name: string, syncDir?: string) =>
  invoke<Project>("create_project", { name, syncDir: syncDir || null });

/** 重命名项目 */
export const renameProject = (id: number, name: string) =>
  invoke<void>("rename_project", { id, name });

/** 删除项目（级联删除节点与配置，后端会先断开连接） */
export const deleteProject = (id: number) => invoke<void>("delete_project", { id });

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

/* ---------- Server 配置 ---------- */

/** 读取 Server 配置 */
export const getServerConfig = (nodeId: number) =>
  invoke<ServerConfig>("get_server_config", { nodeId });

/** 保存 Server 配置 */
export const saveServerConfig = (config: ServerConfig) =>
  invoke<void>("save_server_config", { config });

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

/* ---------- Git 同步 ---------- */

/** 导出全部项目到 git 仓库，返回操作日志 */
export const syncExport = () =>
  invoke<Array<{ level: string; message: string }>>("sync_export");

/** 从 git 仓库导入全部项目（覆盖同名项目），返回操作日志 */
export const syncImport = () =>
  invoke<Array<{ level: string; message: string }>>("sync_import");

/* ---------- 项目级同步 ---------- */

/** 推送项目到其绑定的 git 仓库（导出 + commit + push） */
export const projectSyncPush = (projectId: number) =>
  invoke<Array<{ level: string; message: string }>>("project_sync_push", { projectId });

/** 从项目绑定的 git 仓库拉取并导入（覆盖当前配置） */
export const projectSyncPull = (projectId: number) =>
  invoke<Array<{ level: string; message: string }>>("project_sync_pull", { projectId });

/** 列出项目同步仓库的分支 */
export const projectBranches = (projectId: number) =>
  invoke<BranchInfo>("project_branches", { projectId });

/** 切换项目同步仓库的分支 */
export const projectCheckout = (projectId: number, branch: string) =>
  invoke<void>("project_checkout", { projectId, branch });

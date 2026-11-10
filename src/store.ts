/**
 * 全局状态（Zustand）：项目、树、连接状态、工具、调用结果与主题设置。
 *
 * 所有对后端的调用都通过 api.ts；连接状态变化由 Tauri event 推送合并进来。
 */
import { create } from "zustand";
import * as api from "./api";
import type {
  CallResult,
  ConnStatus,
  NodeType,
  Project,
  ToolInfo,
  TreeNode,
} from "./types";
import { applyThemeColor, applyThemeMode, presetByKey, type ThemeMode } from "./theme";

/** 结果面板最多保留的历史条数 */
const MAX_RESULTS = 50;

interface AppState {
  /* 初始化标记 */
  initialized: boolean;

  /* 主题设置 */
  themeColorKey: string;
  themeMode: ThemeMode;

  /* 项目 */
  projects: Project[];
  activeProjectId: number | null;

  /* 树（当前项目扁平节点表） */
  nodes: TreeNode[];
  /** 已展开的目录 ID */
  expandedIds: Record<number, boolean>;

  /* 选中与连接 */
  selectedNodeId: number | null;
  connStates: Record<number, ConnStatus>;
  connErrors: Record<number, string>;
  tools: Record<number, ToolInfo[]>;
  selectedToolName: string | null;

  /* 调用 */
  running: boolean;
  results: CallResult[];
  seq: number;

  /* 布局：资源树栏是否折叠 */
  treeCollapsed: boolean;

  /* ---------- actions ---------- */

  /** 应用启动时调用：恢复设置、项目列表与上次激活项目 */
  init: () => Promise<void>;

  /** 设置主题色（持久化） */
  setThemeColor: (key: string) => Promise<void>;
  /** 切换明暗（持久化） */
  setThemeMode: (mode: ThemeMode) => Promise<void>;

  /** 切换激活项目 */
  setActiveProject: (id: number) => Promise<void>;
  /** 重新加载当前项目节点列表 */
  reloadNodes: () => Promise<void>;

  createProject: (name: string) => Promise<void>;
  renameProject: (id: number, name: string) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;

  createNode: (parentId: number | null, type: NodeType, name: string) => Promise<void>;
  renameNode: (id: number, name: string) => Promise<void>;
  deleteNode: (id: number) => Promise<void>;
  moveNode: (id: number, newParentId: number | null) => Promise<void>;
  /** 展开目录（含沿路祖先） */
  expandNode: (id: number) => void;
  /** 折叠/展开切换 */
  toggleExpand: (id: number) => void;

  /** 选中一个树节点：server 会自动补连接、拉工具（可用 opts 关闭自动连接） */
  selectNode: (id: number, opts?: { autoConnect?: boolean }) => Promise<void>;
  /** 连接指定 server 并加载工具 */
  connect: (id: number) => Promise<void>;
  /** 断开指定 server */
  disconnect: (id: number) => Promise<void>;
  /** 刷新工具列表（重连） */
  refreshTools: (id: number) => Promise<void>;
  /** 选中工具（清空结果面板） */
  selectTool: (name: string) => void;

  /** 运行工具；错误也会折叠成一条 is_error 结果进入面板 */
  runTool: (nodeId: number, toolName: string, argsJson: string) => Promise<void>;
  /** 清空当前结果面板 */
  clearResults: () => void;

  /** 切换资源树栏折叠/展开 */
  toggleTreeCollapsed: () => void;

  /** 合并后端推送的连接状态（Tauri event） */
  applyConnState: (ev: { node_id: number; status: ConnStatus; message: string | null }) => void;
}

/** 拉取某节点的工具列表；失败返回 null 并写入错误状态 */
async function fetchTools(id: number): Promise<ToolInfo[] | null> {
  try {
    const tools = await api.getCachedTools(id);
    useAppStore.setState((s) => ({
      tools: { ...s.tools, [id]: tools },
      connStates: { ...s.connStates, [id]: "connected" },
    }));
    return tools;
  } catch {
    return null;
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  initialized: false,
  themeColorKey: "sky",
  themeMode: "light",
  projects: [],
  activeProjectId: null,
  nodes: [],
  expandedIds: {},
  selectedNodeId: null,
  connStates: {},
  connErrors: {},
  tools: {},
  selectedToolName: null,
  running: false,
  results: [],
  seq: 0,
  treeCollapsed: false,

  async init() {
    // 1. 设置
    try {
      const kv = await api.getSettings();
      const map = Object.fromEntries(kv);
      const mode = (map["theme_mode"] as ThemeMode) || "light";
      const colorKey = map["theme_color"] || "sky";
      applyThemeMode(mode);
      applyThemeColor(presetByKey(colorKey));
      set({ themeMode: mode, themeColorKey: colorKey });
    } catch {
      /* 后端未就绪时用默认值 */
    }
    // 2. 项目
    const projects = await api.listProjects();
    const savedActive = Number(localStorage.getItem("mcpilot.activeProject") || 0);
    const active =
      projects.find((p) => p.id === savedActive)?.id ?? projects[0]?.id ?? null;
    set({ projects, initialized: true });
    if (active != null) {
      await get().setActiveProject(active);
    }
  },

  async setThemeColor(key) {
    const preset = presetByKey(key);
    applyThemeColor(preset);
    set({ themeColorKey: preset.key });
    await api.saveSetting("theme_color", preset.key).catch(() => {});
  },

  async setThemeMode(mode) {
    applyThemeMode(mode);
    set({ themeMode: mode });
    await api.saveSetting("theme_mode", mode).catch(() => {});
  },

  async setActiveProject(id) {
    localStorage.setItem("mcpilot.activeProject", String(id));
    set({
      activeProjectId: id,
      nodes: [],
      selectedNodeId: null,
      selectedToolName: null,
      results: [],
      expandedIds: {},
    });
    await get().reloadNodes();
    // 恢复仍在存活连接的状态（窗口刷新场景）
    const { nodes } = get();
    for (const n of nodes) {
      if (n.node_type === "server") {
        api
          .getConnState(n.id)
          .then((st) => {
            useAppStore.setState((s) => ({
              connStates: { ...s.connStates, [n.id]: st.status },
              connErrors: {
                ...s.connErrors,
                [n.id]: st.message ?? "",
              },
            }));
            if (st.status === "connected") void fetchTools(n.id);
          })
          .catch(() => {});
      }
    }
  },

  async reloadNodes() {
    const id = get().activeProjectId;
    if (id == null) return;
    const nodes = await api.listNodes(id);
    // 默认展开全部目录（少量节点时体验最好）
    const expandedIds: Record<number, boolean> = {};
    for (const n of nodes) {
      if (n.node_type === "folder") expandedIds[n.id] = true;
    }
    set({ nodes, expandedIds });
  },

  async createProject(name) {
    const p = await api.createProject(name);
    set((s) => ({ projects: [...s.projects, p] }));
    await get().setActiveProject(p.id);
  },

  async renameProject(id, name) {
    await api.renameProject(id, name);
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
    }));
  },

  async deleteProject(id) {
    await api.deleteProject(id);
    const rest = get().projects.filter((p) => p.id !== id);
    set({ projects: rest });
    if (get().activeProjectId === id) {
      if (rest.length > 0) {
        await get().setActiveProject(rest[0].id);
      } else {
        localStorage.removeItem("mcpilot.activeProject");
        set({ activeProjectId: null, nodes: [], selectedNodeId: null, selectedToolName: null, results: [] });
      }
    }
  },

  async createNode(parentId, type, name) {
    const pid = get().activeProjectId;
    if (pid == null) return;
    await api.createNode(pid, parentId, type, name);
    await get().reloadNodes();
  },

  async renameNode(id, name) {
    await api.renameNode(id, name);
    await get().reloadNodes();
  },

  async deleteNode(id) {
    await api.deleteNode(id);
    const s = get();
    const remaining = s.nodes.filter((n) => n.id !== id);
    const patch: Partial<AppState> = { nodes: remaining };
    if (s.selectedNodeId === id) {
      patch.selectedNodeId = null;
      patch.selectedToolName = null;
      patch.results = [];
    }
    set(patch as AppState);
    await get().reloadNodes();
  },

  async moveNode(id, newParentId) {
    await api.moveNode(id, newParentId);
    await get().reloadNodes();
  },

  expandNode(id) {
    set((s) => ({ expandedIds: { ...s.expandedIds, [id]: true } }));
  },

  toggleExpand(id) {
    set((s) => ({ expandedIds: { ...s.expandedIds, [id]: !s.expandedIds[id] } }));
  },

  async selectNode(id, opts) {
    const node = get().nodes.find((n) => n.id === id);
    if (!node || node.node_type !== "server") return;
    // 展开祖先目录，保证选中项可见
    let cur = node.parent_id;
    while (cur != null) {
      get().expandNode(cur);
      const parent = get().nodes.find((n) => n.id === cur);
      cur = parent?.parent_id ?? null;
    }
    set({ selectedNodeId: id, selectedToolName: null, results: [] });
    const autoConnect = opts?.autoConnect !== false;
    const status = get().connStates[id];
    if (status === "connected") {
      if (!get().tools[id]) await fetchTools(id);
    } else if (autoConnect && status !== "connecting") {
      await get().connect(id);
    }
    // 连接成功后自动选中第一个工具
    const tools = get().tools[id];
    if (tools && tools.length > 0 && get().selectedNodeId === id) {
      set({ selectedToolName: tools[0].name });
    }
  },

  async connect(id) {
    set((s) => ({ connStates: { ...s.connStates, [id]: "connecting" }, connErrors: { ...s.connErrors, [id]: "" } }));
    try {
      const tools = await api.connectServer(id);
      set((s) => ({
        connStates: { ...s.connStates, [id]: "connected" },
        connErrors: { ...s.connErrors, [id]: "" },
        tools: { ...s.tools, [id]: tools },
      }));
    } catch (e) {
      set((s) => ({
        connStates: { ...s.connStates, [id]: "error" },
        connErrors: { ...s.connErrors, [id]: String(e) },
        tools: { ...s.tools, [id]: [] },
      }));
    }
  },

  async disconnect(id) {
    try {
      await api.disconnectServer(id);
    } finally {
      set((s) => ({ connStates: { ...s.connStates, [id]: "disconnected" } }));
    }
  },

  async refreshTools(id) {
    set((s) => ({ connStates: { ...s.connStates, [id]: "connecting" } }));
    try {
      const tools = await api.refreshTools(id);
      set((s) => ({
        connStates: { ...s.connStates, [id]: "connected" },
        connErrors: { ...s.connErrors, [id]: "" },
        tools: { ...s.tools, [id]: tools },
      }));
    } catch (e) {
      set((s) => ({
        connStates: { ...s.connStates, [id]: "error" },
        connErrors: { ...s.connErrors, [id]: String(e) },
      }));
    }
  },

  selectTool(name) {
    set({ selectedToolName: name, results: [] });
  },

  async runTool(nodeId, toolName, argsJson) {
    const seq = get().seq + 1;
    set({ running: true, seq });
    try {
      const result = await api.callTool(nodeId, toolName, argsJson, seq);
      set((s) => ({ running: false, results: [result, ...s.results].slice(0, MAX_RESULTS) }));
    } catch (e) {
      // IPC/超时等异常折叠成错误结果展示
      const err: CallResult = {
        seq,
        tool_name: toolName,
        is_error: true,
        content: [{ type: "text", text: String(e) }],
        structured_content: null,
        duration_ms: 0,
        arguments: argsJson,
      };
      set((s) => ({ running: false, results: [err, ...s.results].slice(0, MAX_RESULTS) }));
    }
  },

  clearResults() {
    set({ results: [] });
  },

  toggleTreeCollapsed() {
    set((s) => ({ treeCollapsed: !s.treeCollapsed }));
  },

  applyConnState(ev) {
    set((s) => ({
      connStates: { ...s.connStates, [ev.node_id]: ev.status },
      connErrors: { ...s.connErrors, [ev.node_id]: ev.message ?? "" },
    }));
  },
}));

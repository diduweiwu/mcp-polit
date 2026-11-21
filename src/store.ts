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
  Environment,
  HistoryEntry,
  LogLevel,
  LogEntry,
  NodeType,
  ParamCase,
  Project,
  ServerConfig,
  ToolInfo,
  TreeNode,
} from "./types";
import { applyThemeMode, type ThemeMode } from "./theme";

/** 结果面板最多保留的历史条数 */
const MAX_RESULTS = 50;

/** 历史分页大小：首屏与每次滚动动态加载的条数 */
const HISTORY_PAGE = 30;

/** 历史内存上限：与后端落盘裁剪上限一致（后端保留最新 500 条，满员时最旧的同步出列） */
const HISTORY_KEEP = 500;

/**
 * 后端历史行 -> 内存历史条目。
 *
 * @param r 后端行（含落库自增 id，作为条目展示编号：最新最大、跨会话稳定）
 * @param seq 本批次分配的序号（历史列表 React key / 展开标识；保证会话内唯一）
 */
function rowToEntry(r: api.StoredHistoryRow, seq: number): HistoryEntry {
  return {
    seq,
    id: r.id,
    tool_name: r.tool_name,
    is_error: r.is_error,
    content: r.content,
    structured_content: r.structured_content,
    duration_ms: r.duration_ms,
    arguments: r.arguments,
    node_id: r.node_id,
    server_name: r.server_name,
    timestamp: r.created_at.length >= 19 ? r.created_at.slice(11, 19) : r.created_at,
  };
}

interface AppState {
  /* 初始化标记 */
  initialized: boolean;

  /* 主题设置 */
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
  /** server 配置缓存（nodeId -> 配置；选中时按需加载） */
  serverConfigs: Record<number, ServerConfig>;

  /* 调用 */
  running: boolean;
  results: CallResult[];
  seq: number;

  /* 布局：资源树栏是否折叠 */
  treeCollapsed: boolean;
  /** 工具列表栏是否折叠 */
  toolsCollapsed: boolean;
  /** 参数栏是否折叠 */
  paramsCollapsed: boolean;
  /** 均分布局信号（计数器；TopBar 触发，Workspace 监听） */
  layoutEqualizeSignal: number;

  /* 日志（结果面板底部展示；最多保留 200 条） */
  logs: LogEntry[];

  /* 调用历史（全局，跨工具/项目；落盘 SQLite 跨会话保留，动态分页加载） */
  history: HistoryEntry[];
  /** 是否还有更旧的未加载历史（滚动到底继续拉取） */
  hasMoreHistory: boolean;
  /** 历史分页加载进行中 */
  loadingHistory: boolean;

  /* 应用设置缓存（键值对；含按项目存的激活环境 active_env_<projectId>） */
  settings: Record<string, string>;

  /* 项目级环境库（当前项目的环境列表；Server 配置以 {{变量名}} 引用其中的变量） */
  environments: Environment[];

  /** 工具参数缓存（key: "nodeId:toolName" -> 入参 JSON；跨切换/重启保留） */
  toolParams: Record<string, string>;
  /** 参数 Case（key: "nodeId:toolName" -> case 列表；持久化） */
  cases: Record<string, ParamCase[]>;
  /** 每个 server 上次选中的工具（切换回来时恢复） */
  lastToolByNode: Record<number, string>;

  /* ---------- actions ---------- */

  /** 应用启动时调用：恢复设置、项目列表与上次激活项目 */
  init: () => Promise<void>;

  /** 设置主题色（持久化） */
  /** 切换明暗（持久化） */
  setThemeMode: (mode: ThemeMode) => Promise<void>;

  /** 切换激活项目 */
  setActiveProject: (id: number) => Promise<void>;
  /** 重新加载当前项目节点列表 */
  reloadNodes: () => Promise<void>;

  createProject: (name: string, syncDir?: string) => Promise<void>;
  renameProject: (id: number, name: string) => Promise<void>;
  /** 更新项目同步目录（null 解除绑定）；本地 projects 缓存同步更新 */
  updateProjectSyncDir: (id: number, syncDir: string | null) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;

  createNode: (parentId: number | null, type: NodeType, name: string) => Promise<void>;
  renameNode: (id: number, name: string) => Promise<void>;
  deleteNode: (id: number) => Promise<void>;
  /** 复制节点：目录含整棵子树与各 Server 配置；副本名称自动追加随机后缀 */
  duplicateNode: (id: number) => Promise<void>;
  moveNode: (id: number, newParentId: number | null) => Promise<void>;
  /** 展开目录（含沿路祖先） */
  expandNode: (id: number) => void;
  /** 折叠/展开切换 */
  toggleExpand: (id: number) => void;
  /** 一键展开当前项目全部目录 */
  expandAllFolders: () => void;
  /** 一键收起当前项目全部目录 */
  collapseAllFolders: () => void;

  /** 选中一个树节点：server 显示配置摘要，不自动连接（连接由双击/按钮触发） */
  selectNode: (id: number, opts?: { autoConnect?: boolean }) => Promise<void>;
  /** 按需加载某节点的配置（带缓存） */
  loadConfig: (id: number) => Promise<ServerConfig | null>;
  /** 更新配置缓存（保存配置后调用） */
  updateConfigCache: (cfg: ServerConfig) => void;
  /** 连接指定 server 并加载工具 */
  connect: (id: number) => Promise<void>;
  /** 中断进行中的连接尝试（连接中状态；后端取消握手并广播断开） */
  cancelConnect: (id: number) => Promise<void>;
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
  /** 切换工具列表栏折叠/展开 */
  toggleToolsCollapsed: () => void;
  /** 切换参数栏折叠/展开 */
  toggleParamsCollapsed: () => void;
  /** 均分伴随展开标记：true 表示本次均分触发了折叠栏展开，Workspace 重建的新分栏应直接按等宽挂载（消费后清除） */
  equalizeFromExpand: boolean;
  /** 触发四栏均分布局（有折叠栏时先全部展开再均分，一键回到标准四栏布局） */
  equalizeLayout: () => void;

  /** 追加一条日志；nodeId 可选，缺省为全局日志（项目操作、Git 同步等） */
  addLog: (level: LogLevel, message: string, nodeId?: number) => void;
  /** 批量追加后端返回的日志（补时间戳）；nodeId 可选，缺省为全局日志 */
  addLogs: (entries: Array<{ level: string; message: string }>, nodeId?: number) => void;
  /** 清空日志 */
  clearLogs: () => void;
  /** 清空全部调用历史 */
  clearHistory: () => void;
  /** 动态加载更旧的调用历史（历史列表滚动到底时触发） */
  loadMoreHistory: () => Promise<void>;

  /** 记住工具参数（内存 + 防抖持久化到 settings） */
  saveToolParam: (key: string, argsJson: string) => void;
  /** 保存参数 Case */
  saveParamCase: (key: string, name: string, argsJson: string) => Promise<void>;
  /** 删除参数 Case */
  deleteParamCase: (key: string, name: string) => Promise<void>;
  /** 记住 server 上次选中的工具 */
  rememberTool: (nodeId: number, toolName: string) => void;

  /** 保存一个设置项并同步缓存 */
  saveSetting: (key: string, value: string) => Promise<void>;

  /** 加载当前项目的环境库（切换项目时调用） */
  loadEnvironments: () => Promise<void>;
  /** 整批保存环境库（弹窗草稿式编辑后一次性落盘；全量覆盖） */
  saveEnvironments: (envs: api.EnvironmentPayload[]) => Promise<void>;
  /** 切换全局激活环境（空串 = 不使用环境）；已连接的 Server 需重连后生效 */
  switchActiveEnv: (name: string) => Promise<void>;

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
  serverConfigs: {},
  running: false,
  results: [],
  seq: 0,
  treeCollapsed: false,
  toolsCollapsed: false,
  paramsCollapsed: false,
  layoutEqualizeSignal: 0,
  equalizeFromExpand: false,
  history: [],
  hasMoreHistory: false,
  loadingHistory: false,
  logs: [],
  settings: {},
  environments: [],
  toolParams: {},
  cases: {},
  lastToolByNode: {},

  async init() {
    // 1. 设置
    try {
      const kv = await api.getSettings();
      const map = Object.fromEntries(kv);
      const mode = (map["theme_mode"] as ThemeMode) || "light";
      applyThemeMode(mode);
      const toolParams = JSON.parse(map["tool_params"] || "{}") as Record<string, string>;
      const cases = JSON.parse(map["tool_cases"] || "{}") as Record<string, ParamCase[]>;
      set({ themeMode: mode, settings: map, toolParams, cases });
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
    // 3. 调用历史：从 SQLite 恢复第一页（跨会话保留）；更旧的记录滚动到底动态加载
    try {
      const rows = await api.listHistory(HISTORY_PAGE, 0);
      // 落盘无 seq，按新→旧分配唯一值（历史列表以 seq 作 React key / 展开标识）
      const history = rows.map((r, i) => rowToEntry(r, rows.length - i));
      // 会话内 seq 从恢复条数续起：避免新执行的 seq 与恢复历史的 seq 重复（列表 key / 展开标识需唯一）
      set({ history, seq: rows.length, hasMoreHistory: rows.length === HISTORY_PAGE });
    } catch {
      /* 历史读取失败不影响启动 */
    }
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
    // 加载项目环境库 + 旧环境组一次性迁移（幂等；迁移明细/冲突写日志面板）
    await get().loadEnvironments();
    void api
      .migrateLegacyEnvs(id)
      .then((logs) => {
        if (logs.length) get().addLogs(logs);
      })
      .catch((e) => get().addLog("warn", `旧环境组迁移检查失败：${e}`));
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

  async createProject(name, syncDir) {
    const p = await api.createProject(name, syncDir);
    set((s) => ({ projects: [...s.projects, p] }));
    await get().setActiveProject(p.id);
  },

  async renameProject(id, name) {
    await api.renameProject(id, name);
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
    }));
  },

  /** 更新项目同步目录：后端返回含绝对路径的项目，用它覆盖本地缓存（SyncBar 随之显隐） */
  async updateProjectSyncDir(id, syncDir) {
    const [updated, logs] = await api.updateProjectSyncDir(id, syncDir);
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? updated : p)),
    }));
    /* 绑定新目录时的数据迁移日志（迁移详情 / 失败原因）写入日志面板 */
    if (logs.length > 0) get().addLogs(logs);
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
    scheduleSyncExport();
  },

  async renameNode(id, name) {
    await api.renameNode(id, name);
    await get().reloadNodes();
    scheduleSyncExport();
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
    scheduleSyncExport();
  },

  async moveNode(id, newParentId) {
    await api.moveNode(id, newParentId);
    await get().reloadNodes();
    scheduleSyncExport();
  },

  async duplicateNode(id) {
    const src = get().nodes.find((n) => n.id === id);
    if (!src) return;
    // 副本名称 = 原名 + 4 位随机 base36 后缀，避免同级重名
    const suffix = Math.random().toString(36).slice(2, 6);
    await api.duplicateNode(id, `${src.name}-${suffix}`);
    await get().reloadNodes();
    scheduleSyncExport();
  },

  expandNode(id) {
    set((s) => ({ expandedIds: { ...s.expandedIds, [id]: true } }));
  },

  toggleExpand(id) {
    set((s) => ({ expandedIds: { ...s.expandedIds, [id]: !s.expandedIds[id] } }));
  },

  /** 一键展开：全部目录置为展开 */
  expandAllFolders() {
    set((s) => {
      const expandedIds: Record<number, boolean> = {};
      for (const n of s.nodes) {
        if (n.node_type === "folder") expandedIds[n.id] = true;
      }
      return { expandedIds };
    });
  },

  /** 一键收起：清空展开表（目录全部折叠） */
  collapseAllFolders() {
    set({ expandedIds: {} });
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
    // 按需加载配置摘要（单击即看配置，不自动连接）
    void get().loadConfig(id);
    const autoConnect = opts?.autoConnect === true;
    const status = get().connStates[id];
    if (status === "connected") {
      if (!get().tools[id]) await fetchTools(id);
    } else if (autoConnect && status !== "connecting") {
      await get().connect(id);
    }
    // 恢复该 server 上次选中的工具（参数由 ParamPane 依据缓存自动回填）
    const lastTool = get().lastToolByNode[id];
    const tools = get().tools[id] ?? [];
    if (lastTool && tools.some((t) => t.name === lastTool)) {
      set({ selectedToolName: lastTool });
    }
  },

  async loadConfig(id) {
    const cached = get().serverConfigs[id];
    if (cached) return cached;
    try {
      const cfg = await api.getServerConfig(id);
      set((s) => ({ serverConfigs: { ...s.serverConfigs, [id]: cfg } }));
      return cfg;
    } catch {
      return null;
    }
  },

  updateConfigCache(cfg) {
    set((s) => ({ serverConfigs: { ...s.serverConfigs, [cfg.node_id]: cfg } }));
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
      // 连接成功且该节点正被选中时，自动选中第一个工具
      const st = get();
      if (st.selectedNodeId === id && !st.selectedToolName && tools.length > 0) {
        set({ selectedToolName: tools[0].name });
      }
    } catch (e) {
      const msg = String(e);
      // 手动中断：后端已广播断开事件，恢复空闲态而非错误态（info 日志提示）
      if (msg.includes("手动中断")) {
        set((s) => ({
          connStates: { ...s.connStates, [id]: "disconnected" },
          connErrors: { ...s.connErrors, [id]: "" },
          tools: { ...s.tools, [id]: [] },
        }));
        get().addLog("info", `已中断连接（未等超时）`, id);
        return;
      }
      set((s) => ({
        connStates: { ...s.connStates, [id]: "error" },
        connErrors: { ...s.connErrors, [id]: msg },
        tools: { ...s.tools, [id]: [] },
      }));
    }
  },

  /** 中断进行中的连接尝试：后端取消握手；无论如何把本地状态归位为未连接 */
  async cancelConnect(id) {
    try {
      await api.cancelConnect(id);
    } finally {
      set((s) => ({ connStates: { ...s.connStates, [id]: "disconnected" } }));
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
    const nodeId = get().selectedNodeId;
    if (nodeId != null) get().rememberTool(nodeId, name);
    set({ selectedToolName: name, results: [] });
  },

  async runTool(nodeId, toolName, argsJson) {
    const seq = get().seq + 1;
    set({ running: true, seq });
    const now = new Date();
    const timestamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
    const server_name = get().nodes.find((n) => n.id === nodeId)?.name ?? "";

    /** 结果入列：当前工具结果面板 + 全局历史（含落盘） */
    const commit = (result: CallResult) => {
      const entry: HistoryEntry = {
        ...result,
        node_id: nodeId,
        server_name,
        timestamp,
      };
      set((s) => ({
        running: false,
        results: [result, ...s.results].slice(0, MAX_RESULTS),
        history: [entry, ...s.history].slice(0, HISTORY_KEEP),
      }));
      // 落盘留痕：成功后把落库自增 id 补写到条目（作为展示编号）；失败静默，不影响调用主流程展示
      void api
        .appendHistory({
          id: 0,
          node_id: nodeId,
          server_name,
          created_at: "",
          seq: result.seq,
          tool_name: result.tool_name,
          is_error: result.is_error,
          content: result.content,
          structured_content: result.structured_content,
          duration_ms: result.duration_ms,
          arguments: result.arguments,
        })
        .then((id) =>
          useAppStore.setState((s) => ({
            history: s.history.map((h) =>
              h.seq === result.seq && h.id == null ? { ...h, id } : h,
            ),
          })),
        )
        .catch(() => {});
    };

    try {
      const result = await api.callTool(nodeId, toolName, argsJson, seq);
      commit(result);
    } catch (e) {
      // IPC/超时等异常折叠成错误结果展示
      commit({
        seq,
        tool_name: toolName,
        is_error: true,
        content: [{ type: "text", text: String(e) }],
        structured_content: null,
        duration_ms: 0,
        arguments: argsJson,
      });
    }
  },

  clearResults() {
    set({ results: [] });
  },

  toggleTreeCollapsed() {
    set((s) => ({ treeCollapsed: !s.treeCollapsed }));
  },

  toggleToolsCollapsed() {
    set((s) => ({ toolsCollapsed: !s.toolsCollapsed }));
  },

  toggleParamsCollapsed() {
    set((s) => ({ paramsCollapsed: !s.paramsCollapsed }));
  },

  equalizeLayout() {
    /* 一键均分 = 标准四栏布局：有折叠栏时先全部展开再等分。展开标志与均分信号
       在同一次 set 里原子更新——「伴随展开的均分」会让 Workspace 的分栏随 key
       重建，新实例的尺寸测量（ResizeObserver）落地前调用 resize 不生效，
       所以用 equalizeFromExpand 标记让新分栏直接以等宽挂载，绕开 resize 时序 */
    set((s) => ({
      treeCollapsed: false,
      toolsCollapsed: false,
      paramsCollapsed: false,
      layoutEqualizeSignal: s.layoutEqualizeSignal + 1,
      equalizeFromExpand: s.treeCollapsed || s.toolsCollapsed || s.paramsCollapsed,
    }));
  },

  addLog(level, message, nodeId) {
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
    set((s) => ({
      logs: [...s.logs, { time, level, message, ...(nodeId != null ? { node_id: nodeId } : {}) }].slice(-200),
    }));
  },

  addLogs(entries, nodeId) {
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
    const mapped = entries.map((e) => ({
      time,
      level: (["info", "warn", "error"].includes(e.level) ? e.level : "info") as LogLevel,
      message: e.message,
      ...(nodeId != null ? { node_id: nodeId } : {}),
    }));
    set((s) => ({ logs: [...s.logs, ...mapped].slice(-200) }));
  },

  clearLogs() {
    set({ logs: [] });
  },

  clearHistory() {
    set({ history: [], hasMoreHistory: false });
    void api.clearHistory().catch(() => {});
  },

  /** 动态加载更旧的调用历史：按 offset 翻页追加；不足一页即视为全部加载完 */
  async loadMoreHistory() {
    const s = get();
    if (!s.hasMoreHistory || s.loadingHistory) return;
    set({ loadingHistory: true });
    try {
      const rows = await api.listHistory(HISTORY_PAGE, s.history.length);
      // 批次 seq 从当前最小值往下递减（负数区），与恢复批（1..N）和新调用（递增）永不冲突
      const minSeq = s.history.reduce((m, h) => Math.min(m, h.seq), 0);
      set((st) => ({
        history: [...st.history, ...rows.map((r, i) => rowToEntry(r, minSeq - 1 - i))],
        hasMoreHistory: rows.length === HISTORY_PAGE,
      }));
    } catch (e) {
      get().addLog("error", `加载历史失败：${e}`);
    } finally {
      set({ loadingHistory: false });
    }
  },

  /** 记住工具参数（写入内存；300ms 防抖持久化到 settings 表） */
  saveToolParam(key, argsJson) {
    set((s) => ({ toolParams: { ...s.toolParams, [key]: argsJson } }));
    const timerKey = `__tp_${key}`;
    const timers = (window as unknown as Record<string, ReturnType<typeof setTimeout>>);
    clearTimeout(timers[timerKey]);
    timers[timerKey] = setTimeout(() => {
      const st = useAppStore.getState();
      void st
        .saveSetting("tool_params", JSON.stringify(st.toolParams))
        .catch(() => {});
    }, 300);
  },

  /** 保存参数 Case（持久化到 settings 表） */
  async saveParamCase(key, name, argsJson) {
    const now = new Date();
    const saved_at = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
    const list = [
      ...(get().cases[key] ?? []).filter((c) => c.name !== name),
      { name, args: argsJson, saved_at },
    ];
    set((s) => ({ cases: { ...s.cases, [key]: list } }));
    await api
      .saveSetting("tool_cases", JSON.stringify(get().cases))
      .catch(() => {});
  },

  /** 删除参数 Case */
  async deleteParamCase(key, name) {
    const list = (get().cases[key] ?? []).filter((c) => c.name !== name);
    set((s) => ({ cases: { ...s.cases, [key]: list } }));
    await api
      .saveSetting("tool_cases", JSON.stringify(get().cases))
      .catch(() => {});
  },

  /** 记住 server 上次选中的工具（跨切换恢复） */
  rememberTool(nodeId, toolName) {
    set((s) => ({ lastToolByNode: { ...s.lastToolByNode, [nodeId]: toolName } }));
  },

  async saveSetting(key, value) {
    await api.saveSetting(key, value);
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
  },

  async loadEnvironments() {
    const pid = get().activeProjectId;
    if (pid == null) {
      set({ environments: [] });
      return;
    }
    try {
      const environments = await api.listEnvironments(pid);
      set({ environments });
    } catch {
      set({ environments: [] });
    }
  },

  async saveEnvironments(envs) {
    const pid = get().activeProjectId;
    if (pid == null) return;
    await api.saveEnvironments(pid, envs);
    // 后端整批替换会重新生成 id，重新拉取保证缓存一致（以环境名为身份）
    await get().loadEnvironments();
    scheduleSyncExport(); // 实时同步：环境库已变更，防抖写盘到同步目录
  },

  async switchActiveEnv(name) {
    const pid = get().activeProjectId;
    if (pid == null) return;
    const key = `active_env_${pid}`;
    if ((get().settings[key] ?? "").trim() === name) return;
    await get().saveSetting(key, name);
    const label = name || "不使用环境";
    const connected = Object.values(get().connStates).filter((s) => s === "connected").length;
    get().addLog(
      "info",
      connected > 0
        ? `全局环境已切换为「${label}」：${connected} 个已连接的 Server 需重新连接后生效`
        : `全局环境已切换为「${label}」`,
    );
  },

  applyConnState(ev) {
    set((s) => ({
      connStates: { ...s.connStates, [ev.node_id]: ev.status },
      connErrors: { ...s.connErrors, [ev.node_id]: ev.message ?? "" },
    }));
    // 连接错误同时写入日志面板（归属到对应 server）
    if (ev.status === "error" && ev.message) {
      const name = get().nodes.find((n) => n.id === ev.node_id)?.name;
      get().addLog("error", `连接失败${name ? `「${name}」` : ""}：${ev.message}`, ev.node_id);
    }
  },
}));

/**
 * 当前项目激活的全局环境名（settings 里按项目存：`active_env_<projectId>`）。
 *
 * 空串 = 未选择环境（配置中的 {{变量名}} 引用会在连接时报错引导选择）。
 * 环境身份是「名字」：整批保存后 id 会重建，凡以环境为 key 的地方都用名字。
 *
 * @example
 * const name = activeEnvName(useAppStore.getState());
 * const vars = useAppStore.getState().environments.find((e) => e.name === name);
 */
export function activeEnvName(
  s: Pick<AppState, "settings" | "activeProjectId">,
): string {
  if (s.activeProjectId == null) return "";
  return (s.settings[`active_env_${s.activeProjectId}`] ?? "").trim();
}

/** 自动导出的防抖计时器（连续操作合并为一次写盘） */
let syncExportTimer: number | null = null;

/**
 * 变更后调度一次同步目录自动导出（300ms 防抖合并连续操作）。
 *
 * 「实时同步」：新建/改名/移动/删除/复制节点、保存 Server 配置后调用，
 * 让同步目录文件始终与工具内数据一致（文件可看、可被第三方工具读取）；
 * git 提交/推送节奏仍由用户手动控制（推送按钮）。
 * 成功静默不打扰；失败写日志面板提醒，不影响触发它的操作。
 *
 * @example
 * scheduleSyncExport(); // 树操作 / 配置保存成功后
 */
export function scheduleSyncExport(): void {
  if (syncExportTimer != null) window.clearTimeout(syncExportTimer);
  syncExportTimer = window.setTimeout(() => {
    syncExportTimer = null;
    const { activeProjectId, addLogs } = useAppStore.getState();
    if (activeProjectId == null) return;
    api
      .projectSyncExport(activeProjectId)
      .then((logs) => {
        if (logs.length) addLogs(logs);
      })
      .catch((e) => {
        useAppStore.getState().addLog("warn", `自动同步失败：${String(e)}`);
      });
  }, 300);
}

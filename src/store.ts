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
  SyncDirResolve,
  SyncDirtyEntry,
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
    starred: r.starred ?? false,
  };
}

/** 全局调用超时默认值（秒），与后端 db.rs 的 DEFAULT_CALL_TIMEOUT_SECS 保持一致 */
const DEFAULT_CALL_TIMEOUT_SECS = 60;

/** 全局调用超时上限（秒），与后端 db.rs 的 MAX_CALL_TIMEOUT_SECS 保持一致 */
export const MAX_CALL_TIMEOUT_SECS = 1024;

/**
 * 解析全局调用超时设置值：缺失或非法时回退默认值，并收敛到 1~1024 秒。
 * 与后端 `get_call_timeout_secs` 的防御逻辑一致，双端各自兜底。
 *
 * @param raw 设置表中的原始字符串（可能为 undefined / 非数字 / 负数）
 * @returns 合法的超时秒数（1 ~ 1024）
 */
function clampCallTimeoutSecs(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CALL_TIMEOUT_SECS;
  return Math.min(MAX_CALL_TIMEOUT_SECS, Math.max(1, Math.floor(n)));
}

interface AppState {
  /* 初始化标记 */
  initialized: boolean;

  /* 主题设置 */
  themeMode: ThemeMode;

  /* 全局调用超时（秒）：工具调用的超时下限，实际生效取与 Server 配置较大的值 */
  callTimeoutSecs: number;

  /* 未推送的变更（按项目分桶，内存态）：资源树变更提醒数据源，推送/拉取成功后清空 */
  syncDirty: Record<number, SyncDirtyEntry[]>;

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

  /** 收藏的调用记录（落盘跨会话保留；打开收藏 tab 时加载，收藏操作后同步更新） */
  stars: HistoryEntry[];
  /** 拉取收藏列表 */
  loadStars: () => Promise<void>;
  /** 收藏/取消收藏一条记录（按 entry.id 落盘；历史、结果面板与收藏缓存三处同步） */
  toggleStar: (entry: HistoryEntry) => Promise<void>;

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

  /**
   * 修改全局调用超时（秒，持久化）。
   * 非法值静默忽略并收敛到 1~1024（设置页输入已 clamp，这里兜底防御）。
   */
  setCallTimeoutSecs: (secs: number) => Promise<void>;

  /**
   * 标记一条未推送的变更（资源树变更提醒数据源）。
   * 同一节点的多次变更只保留最新一条（如改名后再改配置 → 只记「修改」）。
   */
  markSyncDirty: (entry: SyncDirtyEntry) => void;

  /** 清空当前项目的未推送变更（推送 / 拉取成功后调用） */
  clearSyncDirty: () => void;

  /** 切换激活项目 */
  setActiveProject: (id: number) => Promise<void>;
  /**
   * 重新加载当前项目节点列表。
   *
   * @param opts.keepExpand true = 保留现有目录展开状态（新建/删除等节点级操作后用，
   *                        节点 ID 稳定，不打扰用户当前视图）；
   *                        省略 = 重置为「全部展开」兜底（项目加载、git 拉取导入等
   *                        数据整体替换场景，节点 ID 可能全部变化，按 ID 记忆无意义）
   */
  reloadNodes: (opts?: { keepExpand?: boolean }) => Promise<void>;

  /**
   * 新建项目（可带同步目录）。
   *
   * 目录为已有数据的 MCPilot 同步仓库时传 resolve 指明数据方向：
   * "project" = 以项目数据为准（清空仓库内容）；"git" = 以仓库数据为准（导入为初始数据）。
   */
  createProject: (name: string, syncDir?: string, resolve?: SyncDirResolve) => Promise<void>;
  renameProject: (id: number, name: string) => Promise<void>;
  /**
   * 更新项目同步目录（null 解除绑定）；本地 projects 缓存同步更新。
   *
   * resolve 含义同 createProject；传 "git" 导入会覆盖项目数据，
   * 若目标为当前活跃项目会自动刷新节点列表。
   */
  updateProjectSyncDir: (id: number, syncDir: string | null, resolve?: SyncDirResolve) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;

  createNode: (parentId: number | null, type: NodeType, name: string) => Promise<void>;
  renameNode: (id: number, name: string) => Promise<void>;
  /** 设置节点自定义图标（icon 注册表 key；null 恢复默认），刷新节点列表并触发同步导出 */
  setNodeIcon: (id: number, icon: string | null) => Promise<void>;
  deleteNode: (id: number) => Promise<void>;
  /** 复制节点：目录含整棵子树与各 Server 配置；副本名称自动追加随机后缀 */
  duplicateNode: (id: number) => Promise<void>;
  moveNode: (id: number, newParentId: number | null) => Promise<void>;
  /** 展开目录（含沿路祖先） */
  expandNode: (id: number) => void;
  /** 展开某节点的全部祖先目录（不含自身），保证该节点在树中可见；不改动其他目录的展开状态 */
  revealNode: (id: number) => void;
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
  callTimeoutSecs: DEFAULT_CALL_TIMEOUT_SECS,
  syncDirty: {},
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
  stars: [],
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
      const callTimeoutSecs = clampCallTimeoutSecs(map["call_timeout_secs"]);
      set({ themeMode: mode, settings: map, toolParams, cases, callTimeoutSecs });
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

  async setCallTimeoutSecs(secs) {
    const v = clampCallTimeoutSecs(Number.isFinite(secs) ? String(Math.floor(secs)) : undefined);
    set({ callTimeoutSecs: v });
    await api.saveSetting("call_timeout_secs", String(v)).catch(() => {});
  },

  markSyncDirty(entry) {
    const pid = get().activeProjectId;
    if (pid == null) return;
    set((s) => {
      const list = (s.syncDirty[pid] ?? []).filter((e) => e.nodeId !== entry.nodeId);
      return { syncDirty: { ...s.syncDirty, [pid]: [...list, entry] } };
    });
  },

  clearSyncDirty() {
    const pid = get().activeProjectId;
    if (pid == null) return;
    set((s) => ({ syncDirty: { ...s.syncDirty, [pid]: [] } }));
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

  async reloadNodes(opts) {
    const id = get().activeProjectId;
    if (id == null) return;
    const nodes = await api.listNodes(id);
    // 节点级增删改后的刷新：保留用户当前展开状态，不重置视图
    if (opts?.keepExpand) {
      set({ nodes });
      return;
    }
    // 默认展开全部目录（少量节点时体验最好）
    const expandedIds: Record<number, boolean> = {};
    for (const n of nodes) {
      if (n.node_type === "folder") expandedIds[n.id] = true;
    }
    set({ nodes, expandedIds });
  },

  async createProject(name, syncDir, resolve) {
    const [p, logs] = await api.createProject(name, syncDir, resolve);
    set((s) => ({ projects: [...s.projects, p] }));
    // 绑定同步目录时的导入/迁移日志（数据方向详情 / 失败原因）写入日志面板
    if (logs.length > 0) get().addLogs(logs);
    await get().setActiveProject(p.id);
  },

  async renameProject(id, name) {
    await api.renameProject(id, name);
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
    }));
  },

  /** 更新项目同步目录：后端返回含绝对路径的项目，用它覆盖本地缓存（SyncBar 随之显隐） */
  async updateProjectSyncDir(id, syncDir, resolve) {
    const [updated, logs] = await api.updateProjectSyncDir(id, syncDir, resolve);
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? updated : p)),
    }));
    /* 绑定新目录时的数据迁移日志（迁移详情 / 失败原因）写入日志面板 */
    if (logs.length > 0) get().addLogs(logs);
    /* 以仓库数据为准导入会覆盖项目节点/Server：活跃项目必须刷新节点列表，
       否则资源树展示的还是导入前的旧数据 */
    if (resolve === "git" && get().activeProjectId === id) {
      await get().reloadNodes();
    }
  },

  async deleteProject(id) {
    await api.deleteProject(id);
    const rest = get().projects.filter((p) => p.id !== id);
    /* 该项目的未推送变更记录随之移除（分桶数据不残留） */
    set((s) => {
      const dirty = { ...s.syncDirty };
      delete dirty[id];
      return { projects: rest, syncDirty: dirty };
    });
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
    const node = await api.createNode(pid, parentId, type, name);
    await get().reloadNodes({ keepExpand: true });
    // 只保证新建节点可见（展开祖先链）；目录再展开自身，其余目录保持原状
    get().revealNode(node.id);
    if (type === "folder") get().expandNode(node.id);
    get().markSyncDirty({ nodeId: node.id, name: node.name, action: "create" });
    scheduleSyncExport();
  },

  async renameNode(id, name) {
    await api.renameNode(id, name);
    await get().reloadNodes({ keepExpand: true });
    get().markSyncDirty({ nodeId: id, name, action: "rename" });
    scheduleSyncExport();
  },

  /** 设置节点自定义图标：落盘后刷新节点列表（树随 icon 立即变化）并触发实时同步导出 */
  async setNodeIcon(id, icon) {
    await api.setNodeIcon(id, icon);
    await get().reloadNodes({ keepExpand: true });
    get().markSyncDirty({
      nodeId: id,
      name: get().nodes.find((n) => n.id === id)?.name ?? "?",
      action: "update",
    });
    scheduleSyncExport();
  },

  async deleteNode(id) {
    await api.deleteNode(id);
    const s = get();
    const removed = s.nodes.find((n) => n.id === id);
    const remaining = s.nodes.filter((n) => n.id !== id);
    const patch: Partial<AppState> = { nodes: remaining };
    if (s.selectedNodeId === id) {
      patch.selectedNodeId = null;
      patch.selectedToolName = null;
      patch.results = [];
    }
    /* 变更提醒：本节点记一条「删除」；其子树节点既已随之删除，旧变更记录一并移除，
       避免列表出现指向已消失节点的幽灵条目 */
    const pid = s.activeProjectId;
    if (pid != null) {
      const doomed = new Set<number>([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of s.nodes) {
          if (n.parent_id != null && doomed.has(n.parent_id) && !doomed.has(n.id)) {
            doomed.add(n.id);
            grew = true;
          }
        }
      }
      patch.syncDirty = {
        ...s.syncDirty,
        [pid]: (s.syncDirty[pid] ?? []).filter((e) => e.nodeId == null || !doomed.has(e.nodeId)),
      };
    }
    set(patch as AppState);
    get().markSyncDirty({
      nodeId: id,
      name: removed?.name ?? "?",
      action: "delete",
    });
    await get().reloadNodes({ keepExpand: true });
    scheduleSyncExport();
  },

  async moveNode(id, newParentId) {
    await api.moveNode(id, newParentId);
    await get().reloadNodes({ keepExpand: true });
    // 展开目标祖先链：拖进折叠目录时移动结果可见（否则节点像「消失」）
    get().revealNode(id);
    get().markSyncDirty({
      nodeId: id,
      name: get().nodes.find((n) => n.id === id)?.name ?? "?",
      action: "move",
    });
    scheduleSyncExport();
  },

  async duplicateNode(id) {
    const src = get().nodes.find((n) => n.id === id);
    if (!src) return;
    // 副本名称 = 原名 + 4 位随机 base36 后缀，避免同级重名
    const suffix = Math.random().toString(36).slice(2, 6);
    const copy = await api.duplicateNode(id, `${src.name}-${suffix}`);
    await get().reloadNodes({ keepExpand: true });
    // 副本与源同级（祖先已随源展开）；目录副本展开自身即可见其子树
    get().revealNode(copy.id);
    if (copy.node_type === "folder") get().expandNode(copy.id);
    get().markSyncDirty({ nodeId: copy.id, name: copy.name, action: "create" });
    scheduleSyncExport();
  },

  expandNode(id) {
    set((s) => ({ expandedIds: { ...s.expandedIds, [id]: true } }));
  },

  revealNode(id) {
    let cur = get().nodes.find((n) => n.id === id)?.parent_id ?? null;
    while (cur != null) {
      get().expandNode(cur);
      cur = get().nodes.find((n) => n.id === cur)?.parent_id ?? null;
    }
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
    get().revealNode(id);
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
    // 连接握手中不重复发起（如双击树节点、快速点连接按钮），避免并发握手互相干扰
    if (get().connStates[id] === "connecting") return;
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
      const msg = String(e);
      // 中断重连：后端 refresh 与 connect 共用握手令牌，取消后恢复空闲态而非错误态
      if (msg.includes("手动中断")) {
        set((s) => ({
          connStates: { ...s.connStates, [id]: "disconnected" },
          connErrors: { ...s.connErrors, [id]: "" },
          tools: { ...s.tools, [id]: [] },
        }));
        get().addLog("info", `已中断重连（未等超时）`, id);
        return;
      }
      set((s) => ({
        connStates: { ...s.connStates, [id]: "error" },
        connErrors: { ...s.connErrors, [id]: msg },
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

    /** 结果入列：当前工具结果面板 + 全局历史（含落盘）。两处存同一 entry 引用，
        落盘回填 id / 收藏状态后两边同时可见（结果卡片因此也能收藏/开抽屉） */
    const commit = (result: CallResult) => {
      const entry: HistoryEntry = {
        ...result,
        node_id: nodeId,
        server_name,
        timestamp,
        starred: false,
      };
      set((s) => ({
        running: false,
        results: [entry, ...s.results].slice(0, MAX_RESULTS),
        history: [entry, ...s.history].slice(0, HISTORY_KEEP),
      }));
      // 落盘留痕：成功后把落库自增 id 补写到条目（作为展示编号 + 收藏操作的主键）；
      // 失败静默，不影响调用主流程展示
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
            // 结果面板与历史里是同一批 entry（按 seq 匹配补 id）
            results: s.results.map((r) =>
              r.seq === result.seq && (r as HistoryEntry).id == null
                ? { ...r, id }
                : r,
            ),
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
    void api
      .clearHistory()
      .then((deleted) => {
        // 后端保留收藏行：提示保留数量，避免用户误以为收藏随历史一起被清掉
        get()
          .loadStars()
          .then(() => {
            const kept = get().stars.length;
            get().addLog(
              "info",
              kept > 0
                ? `已清空历史（删除 ${deleted} 条，保留收藏 ${kept} 条）`
                : `已清空历史（${deleted} 条）`,
            );
          });
      })
      .catch((e) => get().addLog("error", `清空历史失败：${e}`));
  },

  /** 拉取收藏列表（打开收藏 tab 时调用；覆盖式刷新本地缓存） */
  async loadStars() {
    try {
      const rows = await api.listStarredHistory();
      // seq 置 0：收藏条目以落库 id 为身份，列表 key / 展开态均用 id
      set({ stars: rows.map((r) => rowToEntry(r, 0)) });
    } catch (e) {
      get().addLog("error", `加载收藏失败：${e}`);
    }
  },

  /**
   * 收藏 / 取消收藏一条调用记录。
   *
   * 乐观更新结果面板、历史与收藏缓存三处（同一落库 id 对齐），落盘失败回滚并写日志；
   * id 未回填（刚发起、落盘尚未返回）的条目不可收藏。
   *
   * @example
   * void toggleStar(entry); // entry.id 必须已存在
   */
  async toggleStar(entry) {
    const id = entry.id;
    if (id == null) return;
    const next = !entry.starred;

    /** 三处缓存中按 id 定位并改写 starred；返回回滚函数。
        results 声明为 CallResult[] 但实际元素都是 HistoryEntry（commit 存同一引用），
        故以 id 判断、写入后还原声明类型 */
    const patchAll = (starred: boolean) => {
      const s = useAppStore.getState();
      const flip = <T extends CallResult>(h: T): T =>
        (h as unknown as HistoryEntry).id === id ? ({ ...h, starred } as T) : h;
      useAppStore.setState({
        results: s.results.map(flip),
        history: s.history.map(flip),
        stars: starred
          ? // 收藏缓存可能尚未加载（loadStars 未跑过），按 id 去重插入
            s.stars.some((x) => x.id === id)
              ? s.stars.map(flip)
              : [{ ...entry, starred }, ...s.stars]
          : s.stars.filter((x) => x.id !== id),
      });
      return () => patchAll(!starred);
    };
    const rollback = patchAll(next);
    try {
      await api.setHistoryStarred(id, next);
    } catch (e) {
      rollback();
      get().addLog("error", `${next ? "收藏" : "取消收藏"}失败：${String(e)}`);
    }
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
    get().markSyncDirty({ nodeId: null, name: "环境库", action: "env" });
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

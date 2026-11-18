/**
 * 浏览器演示模式（仅 import.meta.env.DEV 生效，生产构建不包含）。
 *
 * 在纯浏览器（无 Tauri IPC）中打开 http://localhost:1420 时，
 * 注入一套演示数据与 mock 的 __TAURI_INTERNALS__，让全部 UI 可交互，
 * 便于界面开发与截图。
 */

/* 演示数据 */
const settings: Record<string, string> = {
  theme_mode: "light",
  sync_repo_path: "/Users/demo/mcpilot-sync",
  sync_include_secrets: "0",
  tool_params: JSON.stringify({
    "2:web_search": JSON.stringify({ query: "MCP protocol", count: 5 }),
  }),
  tool_cases: JSON.stringify({
    "2:web_search": [{ name: "默认查询", args: JSON.stringify({ query: "MCP protocol", count: 5 }), saved_at: "10:02:11" }],
  }),
};

const projects = [
  { id: 1, name: "演示项目", created_at: "2026-11-15 09:00:00", updated_at: "2026-11-15 09:00:00", sync_dir: "/Users/demo/mcpilot-sync" },
  { id: 2, name: "个人工具集", created_at: "2026-11-15 09:10:00", updated_at: "2026-11-15 09:10:00" },
];

let nodeSeq = 100;
const nodes = [
  { id: 1, project_id: 1, parent_id: null, node_type: "folder", name: "远程服务", sort_order: 0, created_at: "", updated_at: "" },
  { id: 2, project_id: 1, parent_id: 1, node_type: "server", name: "GitHub Copilot", sort_order: 0, created_at: "", updated_at: "" },
  { id: 3, project_id: 1, parent_id: 1, node_type: "server", name: "网页摘要", sort_order: 1, created_at: "", updated_at: "" },
  { id: 4, project_id: 1, parent_id: null, node_type: "folder", name: "本地工具", sort_order: 1, created_at: "", updated_at: "" },
  { id: 5, project_id: 1, parent_id: 4, node_type: "server", name: "文件系统", sort_order: 0, created_at: "", updated_at: "" },
];

const configs: Record<number, unknown> = {
  2: {
    node_id: 2, transport_type: "streamable_http", command: null, args: null, env: null,
    working_dir: null, url: "https://api.githubcopilot.com/mcp",
    headers: JSON.stringify({ Authorization: "Bearer ghp_demo_token", "X-Env": "prod" }),
    timeout_ms: 30000, enabled: true, note: "官方 GitHub MCP",
    envs: JSON.stringify({
      prod: { env: "{}", headers: JSON.stringify({ Authorization: "Bearer ghp_prod_token" }) },
      dev: { env: "{}", headers: JSON.stringify({ Authorization: "Bearer ghp_dev_token" }) },
    }),
    active_env: "prod",
  },
  3: {
    node_id: 3, transport_type: "streamable_http", command: null, args: null, env: null,
    working_dir: null, url: "https://mcp.exa.ai/mcp", headers: JSON.stringify({ "x-api-key": "demo" }),
    timeout_ms: 30000, enabled: true, note: null, envs: null, active_env: null,
  },
  5: {
    node_id: 5, transport_type: "stdio", command: "npx",
    args: JSON.stringify(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]),
    env: JSON.stringify({ DEBUG: "1" }), working_dir: null, url: null, headers: null,
    timeout_ms: 30000, enabled: true, note: null, envs: null, active_env: null,
  },
};

const toolsByNode: Record<number, Array<{ name: string; title: string | null; description: string | null; input_schema: unknown }>> = {
  2: [
    { name: "web_search", title: null, description: "Search the web for current information, news and facts.", input_schema: { type: "object", properties: { query: { type: "string", description: "搜索关键词" }, count: { type: "integer", description: "结果数量", default: 5 } }, required: ["query"] } },
    { name: "create_issue", title: null, description: "Create a GitHub issue in a repository.", input_schema: { type: "object", properties: { repo: { type: "string", description: "仓库（owner/name）" }, title: { type: "string", description: "标题" }, body: { type: "string", description: "正文" } }, required: ["repo", "title"] } },
  ],
  3: [
    { name: "web_fetch_exa", title: null, description: "Read a webpage's full content as clean markdown.", input_schema: { type: "object", properties: { url: { type: "string", description: "页面地址" } }, required: ["url"] } },
  ],
  5: [
    { name: "read_file", title: null, description: "读取指定路径的文件内容。", input_schema: { type: "object", properties: { path: { type: "string", description: "文件路径" } }, required: ["path"] } },
    { name: "list_directory", title: null, description: "列出目录内容。", input_schema: { type: "object", properties: { path: { type: "string", description: "目录路径" } }, required: ["path"] } },
  ],
};

const connStates: Record<number, string> = { 2: "connected", 3: "error", 5: "disconnected" };
const connErrors: Record<number, string> = {
  3: "连接失败：unexpected server response 401 Unauthorized（检查 x-api-key）",
};

let seq = 100;
/** 演示模式的历史编号（append_history 返回值，模拟后端自增 id） */
let historyId = 100;
const demoHistory: Array<Record<string, unknown>> = [
  { seq: 3, tool_name: "web_search", node_id: 2, server_name: "GitHub Copilot", timestamp: "10:02:11", is_error: false, duration_ms: 823, arguments: JSON.stringify({ query: "MCP protocol", count: 5 }), content: [{ type: "text", text: "1. Model Context Protocol 官方文档 —— modelcontextprotocol.io\n2. MCP 规范 2025-06-18 版本已发布，新增任务与鉴权扩展。\n3. MCP 生态：数千个社区 server 可通过 npm 安装。" }], structured_content: null },
  { seq: 2, tool_name: "web_search", node_id: 2, server_name: "GitHub Copilot", timestamp: "10:01:40", is_error: false, duration_ms: 651, arguments: JSON.stringify({ query: "rust tokio 教程", count: 5 }), content: [{ type: "text", text: "1. Tokio 官方教程 —— tokio.rs\n2. async Rust 入门实践（2025 修订版）…" }], structured_content: null },
  { seq: 1, tool_name: "read_file", node_id: 5, server_name: "文件系统", timestamp: "09:58:03", is_error: true, duration_ms: 12, arguments: JSON.stringify({ path: "/etc/hosts" }), content: [{ type: "text", text: "权限不足：read denied by policy" }], structured_content: null },
];

/** 演示工具调用的模拟响应 */
function mockCallTool(toolName: string, argsJson: string) {
  seq += 1;
  if (toolName === "web_search") {
    return {
      seq, tool_name: toolName, is_error: false, duration_ms: 500 + Math.floor(Math.random() * 400),
      content: [{ type: "text", text: `1. 「${JSON.parse(argsJson || "{}").query ?? "…"}」的搜索结果（演示数据）——包含 5 条高质量链接与摘要。` }],
      structured_content: null, arguments: argsJson,
    };
  }
  return {
    seq, tool_name: toolName, is_error: false, duration_ms: 120,
    content: [{ type: "text", text: `（演示）${toolName} 调用成功，参数：${argsJson}` }],
    structured_content: null, arguments: argsJson,
  };
}

/** 命令路由 */
function handle(cmd: string, args: Record<string, unknown> = {}): unknown {
  switch (cmd) {
    case "get_settings": return Object.entries(settings);
    case "save_setting": settings[args.key as string] = args.value as string; return null;
    case "list_projects": return projects;
    case "create_project": {
      const p = { id: projects.length + 10, name: args.name as string, created_at: "", updated_at: "", sync_dir: (args.syncDir as string) ?? null };
      projects.push(p); return p;
    }
    case "rename_project": { const p = projects.find((x) => x.id === args.id); if (p) p.name = args.name as string; return null; }
    // 更新同步目录：必须返回更新后的完整项目（store 用返回值覆盖本地缓存，返回 null 会导致渲染崩溃）
    case "update_project_sync_dir": {
      const p = projects.find((x) => x.id === args.id);
      if (p) p.sync_dir = (args.syncDir as string) ?? null;
      return p ?? null;
    }
    case "delete_project": { const i = projects.findIndex((x) => x.id === args.id); if (i >= 0) projects.splice(i, 1); return null; }
    case "list_nodes": return nodes.filter((n) => n.project_id === args.projectId);
    case "create_node": {
      nodeSeq += 1;
      const n = { id: nodeSeq, project_id: args.projectId as number, parent_id: (args.parentId as number) ?? null, node_type: args.nodeType as string, name: args.name as string, sort_order: 0, created_at: "", updated_at: "" };
      nodes.push(n); return n;
    }
    case "rename_node": { const n = nodes.find((x) => x.id === args.id); if (n) n.name = args.name as string; return n; }
    case "move_node": { const n = nodes.find((x) => x.id === args.id); if (n) n.parent_id = (args.newParentId as number) ?? null; return n; }
    case "delete_node": { const i = nodes.findIndex((x) => x.id === args.id); if (i >= 0) nodes.splice(i, 1); return []; }
    case "duplicate_node": {
      // 递归复制子树 + 各 server 配置；根副本用传入名称并保持原父，子孙副本父指向新副本
      const clone = (srcId: number, parentId: number | null, name: string | null): number => {
        const src = nodes.find((x) => x.id === srcId);
        if (!src) throw new Error("节点不存在");
        nodeSeq += 1;
        nodes.push({ ...src, id: nodeSeq, parent_id: parentId, name: name ?? src.name });
        if (configs[srcId]) configs[nodeSeq] = { ...configs[srcId], node_id: nodeSeq };
        for (const c of [...nodes].filter((x) => x.parent_id === srcId)) clone(c.id, nodeSeq, null);
        return nodeSeq;
      };
      const srcNode = nodes.find((x) => x.id === args.id);
      const nid = clone(args.id as number, srcNode?.parent_id ?? null, args.name as string);
      return nodes.find((x) => x.id === nid) ?? null;
    }
    case "test_server_config": return [{ name: "echo", title: "Echo", description: "演示模式：探测成功", input_schema: {} }];
    case "get_server_config": return configs[args.nodeId as number] ?? { node_id: args.nodeId, transport_type: "streamable_http", command: "", args: "", env: "", working_dir: "", url: "", headers: "", timeout_ms: 30000, enabled: true, note: "" };
    // 调用历史：浏览器演示模式不落盘，仅保证启动流程畅通（append 返回模拟编号）
    case "append_history": { historyId += 1; return historyId; }
    case "list_history": return [];
    case "clear_history": return null;
    case "save_server_config": {
      const cfg = args.config as { node_id: number };
      configs[cfg.node_id] = args.config;
      return null;
    }
    case "connect_server": return toolsByNode[args.nodeId as number] ?? [];
    case "disconnect_server": connStates[args.nodeId as number] = "disconnected"; return null;
    case "refresh_tools": return toolsByNode[args.nodeId as number] ?? [];
    case "get_cached_tools": return connStates[args.nodeId as number] === "connected" ? (toolsByNode[args.nodeId as number] ?? []) : (() => { throw new Error("未连接"); })();
    case "get_conn_state": return { node_id: args.nodeId, status: connStates[args.nodeId as number] ?? "disconnected", message: connErrors[args.nodeId as number] ?? null };
    case "call_tool": {
      const toolName = args.toolName as string;
      const result = mockCallTool(toolName, args.arguments as string);
      demoHistory.unshift({ ...result, node_id: args.nodeId, server_name: "GitHub Copilot", timestamp: "now" });
      return result;
    }
    case "project_sync_push": return [
      { level: "info", message: "项目「演示项目」已导出：5 个节点 / 3 个 Server（已脱敏）" },
      { level: "info", message: "已提交到本地仓库" },
      { level: "info", message: "已推送到远端" },
    ];
    case "project_sync_pull": return [
      { level: "info", message: "项目「演示项目」导入完成：2 目录 / 3 Server（覆盖当前配置）" },
    ];
    case "project_branches": return { current: "main", branches: ["main", "dev", "staging"] };
    case "project_checkout": return null;
    default: return null;
  }
}

/* 注入 mock 的 Tauri IPC（纯浏览器环境） */
if (!("__TAURI_INTERNALS__" in window)) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    plugins: {},
    transformCallback: (cb: unknown) => cb,
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "plugin:event|listen" || cmd === "plugin:event|unlisten") {
        return Promise.resolve(1);
      }
      // 演示模式的版本与更新检查：显示固定版本、检查更新视为「已是最新」
      if (cmd === "plugin:app|version") return Promise.resolve("0.1.2");
      if (cmd === "plugin:updater|check") return Promise.resolve(null);
      // 演示模式的系统目录选择：返回固定假路径，便于演示「选择目录」的填入效果
      if (cmd === "plugin:dialog|open") return Promise.resolve("/Users/demo/mcpilot-sync");
      // 演示模式的仓库入口：桌面端由 opener 插件打开系统浏览器，这里直接用浏览器新标签打开
      if (cmd === "plugin:opener|open_url") {
        window.open(String(args?.url ?? ""), "_blank");
        return Promise.resolve(null);
      }
      return Promise.resolve(handle(cmd, args));
    },
  };
}
export {};

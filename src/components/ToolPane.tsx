/**
 * 第二栏：选中 Server 的工具列表（搜索过滤、连接/断开、刷新）。
 */
import { useMemo, useState } from "react";
import {
  AlertCircle,
  Clock,
  Globe,
  PanelLeftOpen,
  Pencil,
  Plug,
  PlugZap,
  RefreshCw,
  Search,
  Terminal,
  Unplug,
  Wrench,
} from "lucide-react";
import { useAppStore } from "../store";
import type { TreeNode } from "../types";
import { EmptyState, StatusDot } from "./ui";
import { ServerFormModal } from "./ServerFormModal";

/** 工具列表栏 */
export function ToolPane() {
  const { selectedNodeId, nodes, tools, connStates, connErrors, selectedToolName, selectTool, connect, disconnect, refreshTools, treeCollapsed, toggleTreeCollapsed } =
    useAppStore();

  const [keyword, setKeyword] = useState("");
  const node = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const list = selectedNodeId != null ? (tools[selectedNodeId] ?? []) : [];
  const status = selectedNodeId != null ? (connStates[selectedNodeId] ?? "disconnected") : "disconnected";
  const err = selectedNodeId != null ? (connErrors[selectedNodeId] ?? "") : "";

  /** 按关键词过滤（名称 + 描述） */
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return list;
    return list.filter(
      (t) =>
        t.name.toLowerCase().includes(kw) ||
        (t.description ?? "").toLowerCase().includes(kw),
    );
  }, [list, keyword]);

  if (!node) {
    return (
      <PaneWrap
        title="工具列表"
        lead={
          treeCollapsed ? (
            <button
              className="mr-1 rounded p-1 text-inksoft hover:bg-panel2 hover:text-ink"
              title="展开资源树"
              onClick={toggleTreeCollapsed}
            >
              <PanelLeftOpen size={14} />
            </button>
          ) : undefined
        }
      >
        <EmptyState icon={<Wrench size={36} strokeWidth={1.2} />} text="在左侧选择一个 MCP Server，这里会列出它的全部工具。" />
      </PaneWrap>
    );
  }

  return (
    <PaneWrap
      title={`工具列表 · ${node.name}`}
      lead={
        treeCollapsed ? (
          <button
            className="mr-1 rounded p-1 text-inksoft hover:bg-panel2 hover:text-ink"
            title="展开资源树"
            onClick={toggleTreeCollapsed}
          >
            <PanelLeftOpen size={14} />
          </button>
        ) : undefined
      }
    >
      {/* 状态条 */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-2.5">
        <div className="flex items-center gap-1.5 text-[12px]">
          <StatusDot status={status} />
          <span className="text-inksoft">
            {status === "connected"
              ? `已连接 · ${list.length} 个工具`
              : status === "connecting"
                ? "连接中…"
                : status === "error"
                  ? "连接失败"
                  : "未连接"}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {status === "connected" ? (
            <>
              <IconBtn title="刷新工具列表（重连）" onClick={() => void refreshTools(node.id)}>
                <RefreshCw size={14} />
              </IconBtn>
              <IconBtn title="断开连接" onClick={() => void disconnect(node.id)}>
                <Unplug size={14} />
              </IconBtn>
            </>
          ) : (
            <IconBtn
              title={status === "connecting" ? "连接中…" : "连接"}
              disabled={status === "connecting"}
              onClick={() => void connect(node.id)}
            >
              {status === "error" ? <AlertCircle size={14} className="text-err" /> : <PlugZap size={14} />}
            </IconBtn>
          )}
        </div>
      </div>

      {/* 搜索框 */}
      {status === "connected" && (
        <div className="border-b border-line p-2">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-inksoft" />
            <input
              className="field !py-1 pl-7"
              placeholder="搜索工具…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* 连接错误提示 */}
      {status === "error" && err && (
        <div className="mx-2 mt-2 rounded-md border border-err/30 bg-err/10 p-2 text-[12px] leading-relaxed text-err selectable">
          {err}
        </div>
      )}

      {/* 未连接：显示配置摘要面板（单击节点即出现）；已连接：显示工具列表 */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {status !== "connected" ? (
          <ServerSummary node={node} status={status} />
        ) : filtered.length === 0 ? (
          <EmptyState text={keyword ? "没有匹配的工具。" : "该 Server 未提供任何工具。"} />
        ) : (
          filtered.map((t) => {
            const active = selectedToolName === t.name;
            return (
              <button
                key={t.name}
                onClick={() => selectTool(t.name)}
                className={`mb-1 w-full rounded-md border p-2 text-left transition-colors ${
                  active
                    ? "border-primary bg-primarysoft"
                    : "border-transparent hover:border-line hover:bg-panel2"
                }`}
              >
                <div className={`truncate font-mono text-[12.5px] font-medium ${active ? "text-primarystrong" : ""}`}>
                  {t.name}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-inksoft">
                  {t.description || "（无描述）"}
                </div>
              </button>
            );
          })
        )}
      </div>
    </PaneWrap>
  );
}

/** 栏外壳：标题 + 内容（lead 为标题左侧的可选元素，如展开按钮） */
function PaneWrap({
  title,
  children,
  lead,
}: {
  title: string;
  children: React.ReactNode;
  lead?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden border-r border-line bg-panel/50">
      <div className="flex h-9 shrink-0 items-center border-b border-line px-3">
        {lead}
        <span className="truncate text-[12px] font-semibold text-inksoft">{title}</span>
      </div>
      {children}
    </div>
  );
}

/** 图标按钮 */
function IconBtn({
  children,
  title,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="rounded p-1.5 text-inksoft transition-colors hover:bg-panel2 hover:text-ink disabled:opacity-50"
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** JSON 对象字符串 -> 键值对数组（非法/为空返回 []） */
function rowsOf(json?: string | null): Array<[string, string]> {
  const s = json?.trim();
  if (!s) return [];
  try {
    const obj = JSON.parse(s) as Record<string, unknown>;
    return Object.entries(obj).map(([k, v]) => [k, String(v)]);
  } catch {
    return [];
  }
}

/** 摘要行 */
function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5">
      <div className="mb-0.5 text-[11px] text-inksoft/70">{label}</div>
      <div className="rounded-md bg-panel2 px-2 py-1 font-mono text-[12px] break-all selectable">
        {children}
      </div>
    </div>
  );
}

/**
 * Server 配置摘要面板：单击树节点后显示连接信息与「连接」入口，
 * 双击树节点或点击按钮才发起连接。
 */
function ServerSummary({ node, status }: { node: TreeNode; status: string }) {
  const cfg = useAppStore((s) => s.serverConfigs[node.id]);
  const connect = useAppStore((s) => s.connect);
  const [editOpen, setEditOpen] = useState(false);

  if (!cfg) {
    return (
      <EmptyState
        icon={<Plug size={32} strokeWidth={1.2} />}
        text={status === "connecting" ? "正在连接 Server…" : "加载配置中…"}
      />
    );
  }

  const isHttp = cfg.transport_type === "streamable_http";
  const connecting = status === "connecting";

  return (
    <div className="anim-fade-in p-2">
      {/* 传输类型徽章 */}
      <div className="mb-2.5 flex items-center gap-1.5">
        <span
          className={`chip ${
            isHttp ? "bg-violet-500/10 text-violet-500" : "bg-emerald-500/10 text-emerald-500"
          }`}
        >
          {isHttp ? <Globe size={11} /> : <Terminal size={11} />}
          {isHttp ? "Streamable HTTP" : "stdio"}
        </span>
        {!cfg.enabled && <span className="chip bg-warn/10 text-warn">已停用</span>}
      </div>

      {/* 主要连接信息 */}
      {isHttp ? (
        <SummaryRow label="服务地址">{cfg.url ?? "（未配置）"}</SummaryRow>
      ) : (
        <>
          <SummaryRow label="启动命令">{cfg.command ?? "（未配置）"}</SummaryRow>
          {cfg.args?.trim() && <SummaryRow label="参数">{cfg.args}</SummaryRow>}
          {cfg.working_dir?.trim() && <SummaryRow label="工作目录">{cfg.working_dir}</SummaryRow>}
        </>
      )}

      {rowsOf(cfg.headers).length > 0 && (
        <SummaryRow label="请求头">
          {rowsOf(cfg.headers).map(([k, v]) => (
            <div key={k} className="mb-0.5">
              <span className="text-primarystrong">{k}:</span> {v}
            </div>
          ))}
        </SummaryRow>
      )}
      {rowsOf(cfg.env).length > 0 && (
        <SummaryRow label="环境变量">
          {rowsOf(cfg.env).map(([k, v]) => (
            <div key={k} className="mb-0.5">
              <span className="text-primarystrong">{k}:</span> {v}
            </div>
          ))}
        </SummaryRow>
      )}

      <div className="mb-2.5 flex items-center gap-1 text-[11px] text-inksoft">
        <Clock size={11} /> 调用超时 {cfg.timeout_ms} ms
      </div>
      {cfg.note?.trim() && (
        <div className="mb-2.5 rounded-md bg-panel2 p-2 text-[12px] leading-relaxed text-inksoft selectable">
          {cfg.note}
        </div>
      )}

      {/* 操作 */}
      <button
        className="btn-primary h-9 w-full"
        disabled={connecting || !cfg.enabled}
        onClick={() => void connect(node.id)}
      >
        <PlugZap size={14} />
        {connecting ? "连接中…" : status === "error" ? "重试连接" : "连接"}
      </button>
      <button className="btn-ghost mt-1.5 h-8 w-full" onClick={() => setEditOpen(true)}>
        <Pencil size={13} /> 编辑配置
      </button>
      <p className="mt-2 text-center text-[11px] text-inksoft/60">
        提示：双击左侧节点可直接连接
      </p>

      {editOpen && <ServerFormModal parentId={null} onClose={() => setEditOpen(false)} />}
    </div>
  );
}

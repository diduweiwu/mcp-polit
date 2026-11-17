/**
 * 第四栏：调用结果（tab 1）与全局调用历史（tab 2）。
 *
 * - 结果：当前选中工具的结果卡片（最新在顶）
 * - 历史：全部调用记录，支持关键字搜索 + 范围过滤（全部/当前 Server/当前工具），
 *   最近一条默认展开，新调用完成后自动改为展开新条目；条目点击展开完整详情（复用结果卡片）
 */
import { useEffect, useMemo, useState } from "react";
import {
  Braces,
  Check,
  ChevronUp,
  Copy,
  History,
  ListTree,
  Loader2,
  ScrollText,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { useAppStore } from "../store";
import type { CallResult, LogLevel } from "../types";
import { EmptyState } from "./ui";
import { JsonNode } from "./JsonView";

/** 历史最多保留条数（与 store 一致） */
type PaneTab = "results" | "history";

/** 结果栏 */
export function ResultPane() {
  const { results, running, clearResults, history, clearHistory } =
    useAppStore();
  const [tab, setTab] = useState<PaneTab>("results");
  const [logOpen, setLogOpen] = useState(false);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-2">
        {/* 标签页切换 */}
        <div className="flex overflow-hidden rounded-md border border-line">
          <TabBtn active={tab === "results"} onClick={() => setTab("results")}>
            调用结果
          </TabBtn>
          <TabBtn active={tab === "history"} onClick={() => setTab("history")}>
            <span className="flex items-center gap-1">
              <History size={12} /> 历史
              {history.length > 0 && (
                <span className="rounded-full bg-panel2 px-1 text-[10px] text-inksoft">
                  {history.length}
                </span>
              )}
            </span>
          </TabBtn>
        </div>

        {/* 清空按钮（随 tab 变化） */}
        {tab === "results" ? (
          <button
            className="rounded p-1 text-inksoft hover:bg-panel2 hover:text-ink disabled:opacity-40"
            title="清空当前结果"
            disabled={results.length === 0}
            onClick={clearResults}
          >
            <Trash2 size={14} />
          </button>
        ) : (
          <button
            className="rounded p-1 text-inksoft hover:bg-panel2 hover:text-ink disabled:opacity-40"
            title="清空全部历史"
            disabled={history.length === 0}
            onClick={clearHistory}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {running && (
        <div className="flex items-center gap-2 border-b border-line bg-primarysoft px-3 py-1.5 text-[12px] text-primarystrong">
          <Loader2 size={13} className="animate-spin" /> 正在调用工具…
        </div>
      )}

      {tab === "results" ? (
        <div className="flex-1 overflow-y-auto p-2">
          {results.length === 0 && !running ? (
            <EmptyState
              icon={<Braces size={36} strokeWidth={1.2} />}
              text="填写参数后点击「运行」，调用结果会显示在这里。历史调用记录已写入本机数据库，重启后仍可查看。"
            />
          ) : (
            results.map((r) => (
              <ResultCard key={r.seq} result={r} isNew={r.seq === results[0]?.seq} />
            ))
          )}
        </div>
      ) : (
        <HistoryPanel />
      )}

      {/* 底部日志面板：默认收起 */}
      <LogPanel open={logOpen} toggle={() => setLogOpen((v) => !v)} />
    </div>
  );
}

/** 历史过滤范围 */
type HistoryScope = "all" | "server" | "tool";

/** 历史面板：搜索 + 范围过滤 + 可展开详情列表（最近一条默认展开，新调用完成后旧条目自动折叠） */
function HistoryPanel() {
  const { history, selectedNodeId, selectedToolName, nodes } = useAppStore();
  const [keyword, setKeyword] = useState("");
  const [scope, setScope] = useState<HistoryScope>("all");
  /** 当前展开的条目（单开模式） */
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);

  /** 最近一条记录的 seq（历史为空时为 null） */
  const latestSeq = history[0]?.seq ?? null;

  /* 最近一条变化（启动恢复历史 / 新调用完成入列）时，自动展开最近一条；
     单开模式下之前的条目随之自动折叠。latestSeq 未变时不触发，手动展开/收起不受影响 */
  useEffect(() => {
    setExpandedSeq(latestSeq);
  }, [latestSeq]);

  /** 过滤：范围 + 关键字（匹配工具名 / Server 别名 / 入参） */
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return history.filter((h) => {
      if (scope === "server" && h.node_id !== selectedNodeId) return false;
      if (scope === "tool" && (h.node_id !== selectedNodeId || h.tool_name !== selectedToolName))
        return false;
      if (!kw) return true;
      return (
        h.tool_name.toLowerCase().includes(kw) ||
        h.server_name.toLowerCase().includes(kw) ||
        h.arguments.toLowerCase().includes(kw)
      );
    });
  }, [history, keyword, scope, selectedNodeId, selectedToolName]);

  const serverName = (nodeId: number) =>
    nodes.find((n) => n.id === nodeId)?.name ?? "?";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 搜索 + 范围切换 */}
      <div className="shrink-0 space-y-1.5 border-b border-line p-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-inksoft" />
          <input
            className="field !py-1 pl-7"
            placeholder="搜索工具名 / Server / 入参…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <div className="flex overflow-hidden rounded-md border border-line">
          {(
            [
              ["all", "全部"],
              ["server", "当前 Server"],
              ["tool", "当前工具"],
            ] as Array<[HistoryScope, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setScope(key)}
              className={`flex-1 px-2 py-1 text-[11.5px] transition-colors ${
                scope === key
                  ? "bg-primarysoft text-primarystrong"
                  : "text-inksoft hover:bg-panel2"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto p-2">
        {filtered.length === 0 ? (
          <EmptyState
            icon={<History size={36} strokeWidth={1.2} />}
            text={
              history.length === 0
                ? "还没有调用记录。运行任意工具后，历史会显示在这里（仅保留本会话内存中，最多 200 条）。"
                : "没有匹配的记录，试试调整关键字或过滤范围。"
            }
          />
        ) : (
          filtered.map((h) => (
            <div key={h.seq} className="mb-1.5">
              {/* 摘要行 */}
              <button
                onClick={() => setExpandedSeq(expandedSeq === h.seq ? null : h.seq)}
                className={`w-full rounded-md border p-2 text-left transition-colors ${
                  expandedSeq === h.seq
                    ? "border-primary bg-primarysoft"
                    : "border-line bg-panel hover:bg-panel2"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {h.is_error ? (
                    <XCircle size={13} className="shrink-0 text-err" />
                  ) : (
                    <Check size={13} className="shrink-0 text-ok" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium">
                    {h.tool_name}
                  </span>
                  <span className="shrink-0 text-[10.5px] text-inksoft/70">{h.timestamp}</span>
                  <span className="shrink-0 text-[10.5px] text-inksoft">{h.duration_ms}ms</span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-inksoft">
                  {serverName(h.node_id)} · {h.arguments || "{}"}
                </div>
              </button>
              {/* 展开的详情 */}
              {expandedSeq === h.seq && (
                <div className="anim-fade-in mt-0.5">
                  <ResultCard result={h} />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** 视图切换小按钮（icon 可选：纯文字切换如「内容/结构化」可不带图标） */
function ViewToggle({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
        active ? "bg-primarysoft text-primarystrong" : "text-inksoft hover:bg-panel hover:text-ink"
      }`}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}

/** tab 按钮 */
function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`flex items-center gap-1 px-2.5 py-1 text-[12px] font-medium transition-colors ${
        active ? "bg-primarysoft text-primarystrong" : "text-inksoft hover:bg-panel2"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * 单条结果卡片；isNew=true（最新一条）默认展开，其余默认折叠，点击头部可展开/收起。
 *
 * 展开后内容分「请求 · 入参」与「响应」上下两段独立显示，各带复制按钮，
 * 便于分别复制请求数据与响应数据。
 */
function ResultCard({ result, isNew }: { result: CallResult; isNew?: boolean }) {
  const [view, setView] = useState<"tree" | "raw">("tree");
  const [tab, setTab] = useState<"content" | "structured">("content");
  /** 响应复制成功的短暂标记 */
  const [copied, setCopied] = useState(false);
  /** 请求入参复制成功的短暂标记 */
  const [argsCopied, setArgsCopied] = useState(false);
  /** 折叠态：非最新结果默认只显示摘要行，手动展开查看详情 */
  const [collapsed, setCollapsed] = useState(!isNew);

  /* 新结果入列后，本卡片从「最新」退化为历史时自动折叠；
     useState 初始值只在挂载时生效，需要跟随 isNew 变化补一次折叠 */
  useEffect(() => {
    if (!isNew) setCollapsed(true);
  }, [isNew]);

  const structured = result.structured_content ?? null;

  /** 从 content 数组中提取全部 text 块拼接 */
  const textBody = useMemo(() => {
    if (!Array.isArray(result.content)) return "";
    return result.content
      .filter((c): c is { type: "text"; text: string } => {
        const o = c as { type?: string };
        return o?.type === "text" && typeof (c as { text?: unknown }).text === "string";
      })
      .map((c) => c.text)
      .join("\n");
  }, [result]);

  /** 文本是否可解析为 JSON（用于树形展示） */
  const parsed = useMemo(() => {
    const t = textBody.trim();
    if (!t) return null;
    if (!(t.startsWith("{") || t.startsWith("["))) return null;
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  }, [textBody]);

  /** 入参格式化展示：合法 JSON 缩进美化便于阅读，损坏/非 JSON 时显示原文 */
  const formattedArgs = useMemo(() => {
    const raw = result.arguments;
    if (!raw) return "{}";
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }, [result.arguments]);

  /** 复制请求入参（格式化后的 JSON） */
  const copyArgs = async () => {
    await navigator.clipboard.writeText(formattedArgs).catch(() => {});
    setArgsCopied(true);
    setTimeout(() => setArgsCopied(false), 1200);
  };

  /** 复制当前响应视图：内容 tab 复制文本体（无文本时回退原始 content），结构化 tab 复制美化 JSON */
  const copyResult = async () => {
    const raw =
      tab === "structured"
        ? JSON.stringify(structured, null, 2)
        : textBody || JSON.stringify(result.content, null, 2);
    await navigator.clipboard.writeText(raw).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={`card overflow-hidden ${isNew ? "anim-slide-up mb-2" : "mb-1"}`}>
      {/* 卡片头：整行可点击切换折叠 */}
      <div
        className={`flex h-8 items-center justify-between border-b border-line bg-panel2 px-2.5 ${
          collapsed ? "cursor-pointer select-none" : ""
        }`}
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? "展开详情" : undefined}
      >
        <div className="flex min-w-0 items-center gap-2 text-[11.5px]">
          <ChevronUp
            size={13}
            className={`shrink-0 text-inksoft transition-transform duration-200 ${collapsed ? "rotate-180" : ""}`}
          />
          {result.is_error ? (
            <span className="chip bg-err/10 text-err">
              <XCircle size={11} /> 失败
            </span>
          ) : (
            <span className="chip bg-ok/10 text-ok">成功</span>
          )}
          <span className="truncate font-mono text-ink">{result.tool_name}</span>
          <span className="shrink-0 text-inksoft">{result.duration_ms} ms</span>
        </div>
      </div>

      {/* 展开后：请求 / 响应两段分开显示，各自独立复制（折叠时不渲染，避免隐藏的树展开开销） */}
      {!collapsed && (
        <>
          {/* 请求段：格式化入参 JSON，独立复制按钮 */}
          <div className="border-b border-line">
            <div className="flex h-7 items-center justify-between bg-panel2/60 pl-2.5 pr-1">
              <span className="text-[10.5px] font-semibold tracking-wide text-inksoft/80">
                请求 · 入参
              </span>
              <button
                className="rounded p-1 text-inksoft hover:bg-panel hover:text-ink"
                title="复制入参 JSON"
                onClick={() => void copyArgs()}
              >
                {argsCopied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
              </button>
            </div>
            <pre className="max-h-[120px] overflow-y-auto whitespace-pre-wrap break-all px-2.5 py-2 font-mono text-[12px] leading-relaxed text-inksoft selectable">
              {formattedArgs}
            </pre>
          </div>

          {/* 响应段：内容/结构化切换 + 树/原始视图 + 独立复制按钮 */}
          <div>
            <div className="flex h-7 items-center gap-0.5 bg-panel2/60 pl-2.5 pr-1">
              <span className="mr-auto text-[10.5px] font-semibold tracking-wide text-inksoft/80">
                响应
              </span>
              {structured !== null && (
                <>
                  <ViewToggle active={tab === "content"} onClick={() => setTab("content")}>
                    内容
                  </ViewToggle>
                  <ViewToggle active={tab === "structured"} onClick={() => setTab("structured")}>
                    结构化
                  </ViewToggle>
                  <span className="mx-1 h-3.5 w-px bg-line" />
                </>
              )}
              <ViewToggle active={view === "tree"} onClick={() => setView("tree")} icon={<ListTree size={12} />}>
                树
              </ViewToggle>
              <ViewToggle active={view === "raw"} onClick={() => setView("raw")} icon={<Braces size={12} />}>
                原始
              </ViewToggle>
              <button
                className="rounded p-1 text-inksoft hover:bg-panel hover:text-ink"
                title="复制响应"
                onClick={() => void copyResult()}
              >
                {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
              </button>
            </div>
            <div className="max-h-[300px] overflow-y-auto p-2.5">
              {tab === "structured" ? (
                view === "tree" ? (
                  <JsonNode value={structured} />
                ) : (
                  <pre className="whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed selectable">
                    {JSON.stringify(structured, null, 2)}
                  </pre>
                )
              ) : parsed !== null && view === "tree" ? (
                <JsonNode value={parsed} />
              ) : (
                <pre
                  className={`whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed selectable ${
                    result.is_error ? "text-err" : ""
                  }`}
                >
                  {textBody || JSON.stringify(result.content, null, 2)}
                </pre>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** 日志面板属性 */
interface LogPanelProps {
  open: boolean;
  toggle: () => void;
}

/** 可折叠日志面板：展示当前选中 server 的日志 + 全局日志（同步等，仅内存，不落盘） */
function LogPanel({ open, toggle }: LogPanelProps) {
  const { logs, clearLogs, selectedNodeId, nodes } = useAppStore();
  const levelCls: Record<LogLevel, string> = {
    info: "text-inksoft",
    warn: "text-warn",
    error: "text-err",
  };
  const dotCls: Record<LogLevel, string> = {
    info: "bg-inksoft/50",
    warn: "bg-warn",
    error: "bg-err",
  };
  /** 只显示全局日志 + 当前选中 server 的日志（切换 server 时面板内容跟随切换） */
  const visibleLogs = useMemo(
    () => logs.filter((l) => l.node_id == null || l.node_id === selectedNodeId),
    [logs, selectedNodeId],
  );
  /** 选中 server 时在标题中显示其名称，便于辨识日志归属 */
  const serverName =
    selectedNodeId != null ? nodes.find((n) => n.id === selectedNodeId)?.name : null;
  return (
    <div className="shrink-0 border-t border-line">
      <button
        className="flex h-8 w-full items-center justify-between px-3 text-[12px] text-inksoft transition-colors hover:text-ink"
        onClick={toggle}
      >
        <span className="flex items-center gap-1.5">
          <ScrollText size={13} /> 日志{serverName ? ` · ${serverName}` : ""}
          {visibleLogs.length > 0 && (
            <span className="chip bg-panel2 text-[10px] text-inksoft">{visibleLogs.length}</span>
          )}
        </span>
        <ChevronUp size={14} className={`transition-transform duration-200 ${open ? "" : "rotate-180"}`} />
      </button>
      {open && (
        <div className="anim-fade-in max-h-44 overflow-y-auto border-t border-line px-3 py-1.5">
          {visibleLogs.length === 0 ? (
            <div className="py-2 text-[11.5px] text-inksoft/60">
              暂无日志。Git 同步、连接失败等操作的记录会显示在这里（仅保留在本会话内存中）。
            </div>
          ) : (
            <>
              <div className="mb-1 flex justify-end">
                <button
                  className="rounded px-1.5 py-0.5 text-[11px] text-inksoft hover:bg-panel2 hover:text-err"
                  title="清空全部日志"
                  onClick={clearLogs}
                >
                  清空
                </button>
              </div>
              {visibleLogs.map((l, i) => (
                <div key={i} className="flex items-start gap-2 py-0.5 font-mono text-[11.5px] leading-relaxed selectable">
                  <span className="shrink-0 text-inksoft/50">{l.time}</span>
                  <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${dotCls[l.level]}`} />
                  <span className={`break-all ${levelCls[l.level]}`}>{l.message}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

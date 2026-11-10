/**
 * 第四栏：调用结果（历史卡片列表，支持树形/原始切换与复制）。
 */
import { useMemo, useState } from "react";
import { Braces, Check, Copy, ListTree, Loader2, Trash2, XCircle } from "lucide-react";
import { useAppStore } from "../store";
import type { CallResult } from "../types";
import { EmptyState } from "./ui";
import { JsonNode } from "./JsonView";

/** 结果栏 */
export function ResultPane() {
  const { results, running, clearResults, selectedToolName } = useAppStore();
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <span className="text-[12px] font-semibold text-inksoft">
          调用结果{selectedToolName ? ` · ${selectedToolName}` : ""}
        </span>
        <button
          className="rounded p-1 text-inksoft hover:bg-panel2 hover:text-ink"
          title="清空结果"
          onClick={clearResults}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {running && (
        <div className="flex items-center gap-2 border-b border-line bg-primarysoft px-3 py-1.5 text-[12px] text-primarystrong">
          <Loader2 size={13} className="animate-spin" /> 正在调用工具…
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {results.length === 0 && !running ? (
          <EmptyState
            icon={<Braces size={36} strokeWidth={1.2} />}
            text="填写参数后点击「运行」，调用结果会显示在这里。本会话的历史结果仅保留在内存中，不会写入磁盘。"
          />
        ) : (
          results.map((r) => <ResultCard key={r.seq} result={r} />)
        )}
      </div>
    </div>
  );
}

/** 单条结果卡片 */
function ResultCard({ result }: { result: CallResult }) {
  const [view, setView] = useState<"tree" | "raw">("tree");
  const [tab, setTab] = useState<"content" | "structured" | "args">("content");
  const [copied, setCopied] = useState(false);

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

  const copy = async () => {
    const raw = tab === "args" ? result.arguments : textBody || JSON.stringify(result.content, null, 2);
    await navigator.clipboard.writeText(raw).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="card mb-2 overflow-hidden">
      {/* 卡片头 */}
      <div className="flex h-8 items-center justify-between border-b border-line bg-panel2 px-2.5">
        <div className="flex items-center gap-2 text-[11.5px]">
          {result.is_error ? (
            <span className="chip bg-err/10 text-err">
              <XCircle size={11} /> 失败
            </span>
          ) : (
            <span className="chip bg-ok/10 text-ok">成功</span>
          )}
          <span className="font-mono text-ink">{result.tool_name}</span>
          <span className="text-inksoft">{result.duration_ms} ms</span>
        </div>
        <div className="flex items-center gap-0.5">
          <ViewToggle active={view === "tree"} onClick={() => setView("tree")} icon={<ListTree size={12} />}>
            树
          </ViewToggle>
          <ViewToggle active={view === "raw"} onClick={() => setView("raw")} icon={<Braces size={12} />}>
            原始
          </ViewToggle>
          <button
            className="rounded p-1 text-inksoft hover:bg-panel hover:text-ink"
            title="复制"
            onClick={() => void copy()}
          >
            {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
          </button>
        </div>
      </div>

      {/* 选项卡 */}
      {structured !== null && (
        <div className="flex gap-1 border-b border-line px-2 py-1">
          <TabBtn active={tab === "content"} onClick={() => setTab("content")}>内容</TabBtn>
          <TabBtn active={tab === "structured"} onClick={() => setTab("structured")}>结构化</TabBtn>
          <TabBtn active={tab === "args"} onClick={() => setTab("args")}>入参</TabBtn>
        </div>
      )}

      {/* 内容区 */}
      <div className="max-h-[300px] overflow-y-auto p-2.5">
        {tab === "args" ? (
          <pre className="whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-inksoft selectable">
            {result.arguments || "{}"}
          </pre>
        ) : tab === "structured" ? (
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
  );
}

/** 视图切换小按钮 */
function ViewToggle({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
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

/** 选项卡按钮 */
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
      className={`rounded px-2 py-0.5 text-[11.5px] transition-colors ${
        active ? "bg-primarysoft text-primarystrong" : "text-inksoft hover:bg-panel2"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

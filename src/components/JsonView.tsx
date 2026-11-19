/**
 * JSON 折叠树查看器：结果面板展示调用返回的任意 JSON 结构。
 * 长字符串值默认截断，点击值可展开/收起完整内容，悬停显示复制按钮。
 */
import { useState } from "react";
import { AlertCircle, Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { copyText } from "../lib/clipboard";

/** 超过该长度的字符串折叠显示 */
const STR_TRUNC = 120;

/** JSON 节点 */
export function JsonNode({ name, value, depth = 0 }: { name?: string; value: unknown; depth?: number }) {
  /* 基础类型 */
  if (value === null) return <Leaf name={name} text="null" cls="text-inksoft" />;
  if (typeof value === "string") return <StringLeaf name={name} value={value} />;
  if (typeof value === "number") return <Leaf name={name} text={String(value)} cls="text-warn selectable" />;
  if (typeof value === "boolean") return <Leaf name={name} text={String(value)} cls="text-primarystrong selectable" />;

  /* 容器类型：可折叠 */
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  return <Collapsible name={name} entries={entries} isArray={Array.isArray(value)} depth={depth} />;
}

/** 基础类型叶子 */
function Leaf({
  name,
  text,
  cls,
  title,
}: {
  name?: string;
  text: string;
  cls: string;
  title?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5 py-[1px] leading-snug">
      {name !== undefined && <span className="font-mono text-[12px] text-primarystrong">{name}:</span>}
      <span className={`font-mono text-[12px] break-all ${cls}`} title={title}>
        {text}
      </span>
    </div>
  );
}

/**
 * 字符串叶子：短字符串原样展示；长字符串（超过 STR_TRUNC）截断显示，
 * 点击值在「截断 / 完整」间切换，悬停出现复制按钮（复制原始文本，不含引号转义）。
 */
function StringLeaf({ name, value }: { name?: string; value: string }) {
  const long = value.length > STR_TRUNC;
  /** 是否展开完整内容 */
  const [expanded, setExpanded] = useState(false);
  /** 复制反馈态：ok 成功 / fail 失败，短暂显示后还原 */
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);

  /* 短字符串：无交互，原样展示 */
  if (!long) {
    return <Leaf name={name} text={JSON.stringify(value)} cls="text-ok selectable" />;
  }

  const displayed = expanded ? JSON.stringify(value) : `"${value.slice(0, STR_TRUNC)}…"`;
  return (
    <div className="group flex items-start gap-1.5 py-[1px] leading-snug">
      {name !== undefined && (
        <span className="shrink-0 font-mono text-[12px] text-primarystrong">{name}:</span>
      )}
      <span
        className="min-w-0 flex-1 cursor-pointer font-mono text-[12px] break-all text-ok selectable"
        title={expanded ? "点击收起" : "点击展开完整内容"}
        onClick={() => setExpanded((v) => !v)}
      >
        {displayed}
      </span>
      <button
        className={`shrink-0 rounded p-0.5 text-inksoft transition-opacity hover:bg-panel2 hover:text-ink ${
          copied ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        title={copied === "fail" ? "复制失败" : "复制该值（原始文本）"}
        onClick={async () => {
          const ok = await copyText(value);
          setCopied(ok ? "ok" : "fail");
          window.setTimeout(() => setCopied(null), 1500);
        }}
      >
        {copied === "ok" ? (
          <Check size={12} className="text-ok" />
        ) : copied === "fail" ? (
          <AlertCircle size={12} className="text-err" />
        ) : (
          <Copy size={12} />
        )}
      </button>
    </div>
  );
}

/** 对象/数组折叠块 */
function Collapsible({
  name,
  entries,
  isArray,
  depth,
}: {
  name?: string;
  entries: readonly (readonly [string, unknown])[];
  isArray: boolean;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  const braceOpen = isArray ? "[" : "{";
  const braceClose = isArray ? "]" : "}";
  return (
    <div className="leading-snug">
      <button
        className="flex items-center gap-1 rounded py-[1px] text-left hover:bg-panel2"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-inksoft" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-inksoft" />
        )}
        {name !== undefined && <span className="font-mono text-[12px] text-primarystrong">{name}:</span>}
        <span className="font-mono text-[12px] text-inksoft">
          {braceOpen}
          {!open && <>…{braceClose} <span className="text-inksoft/60">({entries.length} 项)</span></>}
        </span>
      </button>
      {open && (
        <div className="ml-4 border-l border-line pl-2">
          {entries.map(([k, v]) => (
            <JsonNode key={k} name={k} value={v} depth={depth + 1} />
          ))}
          <div className="font-mono text-[12px] text-inksoft">{braceClose}</div>
        </div>
      )}
    </div>
  );
}

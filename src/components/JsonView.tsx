/**
 * JSON 折叠树查看器：结果面板展示调用返回的任意 JSON 结构。
 */
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

/** 超过该长度的字符串折叠显示 */
const STR_TRUNC = 120;

/** JSON 节点 */
export function JsonNode({ name, value, depth = 0 }: { name?: string; value: unknown; depth?: number }) {
  /* 基础类型 */
  if (value === null) return <Leaf name={name} text="null" cls="text-inksoft" />;
  if (typeof value === "string") {
    const long = value.length > STR_TRUNC;
    return (
      <Leaf
        name={name}
        text={long ? `"${value.slice(0, STR_TRUNC)}…"` : JSON.stringify(value)}
        cls="text-ok selectable"
        title={long ? value : undefined}
      />
    );
  }
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

/**
 * 第四栏：调用结果（tab 1）、全局调用历史（tab 2）与收藏（tab 3）。
 *
 * - 结果：当前选中工具的结果卡片（最新在顶）
 * - 历史：全部调用记录，支持关键字搜索 + 范围过滤（全部/当前 Server/当前工具），
 *   最近一条默认展开，新调用完成后自动改为展开新条目；条目点击展开完整详情（复用结果卡片）
 * - 收藏：跨会话保留的收藏记录（落盘 starred 字段，不被历史裁剪/清空删除），
 *   支持搜索与取消收藏；卡片与摘要行上的星标按钮即可收藏
 * - 每条结果可「放大查看」：右侧滑出大抽屉，左侧请求 / 右侧响应，请求支持复制为 cURL
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Braces,
  Check,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  History,
  ListTree,
  Loader2,
  Maximize2,
  ScrollText,
  Search,
  Star,
  Terminal,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useAppStore } from "../store";
import { copyText } from "../lib/clipboard";
import { isSensitiveKey, parseSensitiveKeys } from "../lib/sensitive";
import { buildToolsCallCurl } from "../lib/curl";
import type { CallResult, HistoryEntry, LogLevel } from "../types";
import { Collapse, EmptyState, Tooltip } from "./ui";
import { JsonNode } from "./JsonView";

/** 结果栏 tab：调用结果 / 历史 / 收藏 */
type PaneTab = "results" | "history" | "stars";

/** 结果栏 */
export function ResultPane() {
  const { results, running, clearResults, history, stars, loadStars } =
    useAppStore();
  const [tab, setTab] = useState<PaneTab>("results");
  const [logOpen, setLogOpen] = useState(false);
  /** 放大抽屉当前展示的条目（存初始引用；渲染时按 id/seq 从最新 store 解析，收藏态实时） */
  const [drawerInit, setDrawerInit] = useState<HistoryEntry | null>(null);

  /* 切到收藏 tab 时拉取/刷新收藏列表（幂等） */
  useEffect(() => {
    if (tab === "stars") void loadStars();
  }, [tab, loadStars]);

  /** 抽屉条目实时解析：优先按落库 id 对齐三处缓存（收藏/历史），结果面板按 seq 兜底 */
  const drawer = useMemo<HistoryEntry | null>(() => {
    if (!drawerInit) return null;
    const byId = [...history, ...stars].find(
      (h) => drawerInit.id != null && h.id === drawerInit.id,
    );
    if (byId) return byId;
    const bySeq = results.find((r) => r.seq === drawerInit.seq) as HistoryEntry | undefined;
    return bySeq ?? drawerInit;
  }, [drawerInit, results, history, stars]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-2">
        <div className="flex min-w-0 items-center">
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
            <TabBtn active={tab === "stars"} onClick={() => setTab("stars")}>
              <span className="flex items-center gap-1">
                <Star size={12} /> 收藏
                {stars.length > 0 && (
                  <span className="rounded-full bg-panel2 px-1 text-[10px] text-inksoft">
                    {stars.length}
                  </span>
                )}
              </span>
            </TabBtn>
          </div>
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
        ) : tab === "history" ? (
          <button
            className="rounded p-1 text-inksoft hover:bg-panel2 hover:text-ink disabled:opacity-40"
            title="清空历史（收藏的记录会保留）"
            disabled={history.length === 0}
            onClick={useAppStore.getState().clearHistory}
          >
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>

      {running && (
        <div className="flex items-center gap-2 border-b border-line bg-primarysoft px-3 py-1.5 text-[12px] text-primarystrong">
          <Loader2 size={13} className="animate-spin" /> 正在调用工具…
          <Tooltip content="取消本次调用（结果面板会记一条已取消）">
            <button
              className="ml-auto rounded p-1 text-primarystrong/70 hover:bg-panel2 hover:text-primarystrong"
              onClick={() => void useAppStore.getState().cancelRun()}
            >
              <X size={13} />
            </button>
          </Tooltip>
        </div>
      )}

      {/* 空态时给内容区负 margin（33px = 日志条 h-8 标题 + 上边框）补偿其常驻占位：
          EmptyState 的 icon 锚定区与其他两栏（无底部占位条）等高，三栏空态 icon/文字水平对齐；
          非空态不加，保证列表滚动底缘不被日志条遮挡 */}
      {tab === "results" ? (
        <div className={`flex-1 overflow-y-auto p-2 ${results.length === 0 && !running ? "-mb-[33px]" : ""}`}>
          {results.length === 0 && !running ? (
            <EmptyState
              icon={<Braces size={36} strokeWidth={1.2} />}
              text="填写参数后点击「运行」，调用结果会显示在这里。历史调用记录已写入本机数据库，重启后仍可查看。"
            />
          ) : (
            results.map((r) => (
              <ResultCard
                key={r.seq}
                result={r}
                isNew={r.seq === results[0]?.seq}
                starred={(r as HistoryEntry).starred}
                onToggleStar={
                  (r as HistoryEntry).id != null
                    ? () => void useAppStore.getState().toggleStar(r as HistoryEntry)
                    : undefined
                }
                onExpand={() => setDrawerInit(r as HistoryEntry)}
              />
            ))
          )}
        </div>
      ) : tab === "history" ? (
        <HistoryPanel onExpand={setDrawerInit} />
      ) : (
        <StarPanel onExpand={setDrawerInit} />
      )}

      {/* 放大抽屉：左侧请求 / 右侧响应 */}
      {drawer && (
        <ResultDrawer entry={drawer} onClose={() => setDrawerInit(null)} />
      )}

      {/* 底部日志面板：默认收起 */}
      <LogPanel open={logOpen} toggle={() => setLogOpen((v) => !v)} />
    </div>
  );
}

/** 历史过滤范围 */
type HistoryScope = "all" | "server" | "tool";

/** 历史面板：搜索 + 范围过滤 + 可展开详情列表（最近一条默认展开，滚动到底动态加载更早记录） */
function HistoryPanel({ onExpand }: { onExpand: (entry: HistoryEntry) => void }) {
  const { history, hasMoreHistory, loadingHistory, loadMoreHistory, selectedNodeId, selectedToolName, nodes, toggleStar } =
    useAppStore();
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

      {/* 列表：滚动到底触发动态加载更早的记录（空态时同结果 tab 负 margin 补偿日志条占位，切 tab 时 icon 不跳） */}
      <div
        className={`flex-1 overflow-y-auto p-2 ${filtered.length === 0 ? "-mb-[33px]" : ""}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) void loadMoreHistory();
        }}
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={<History size={36} strokeWidth={1.2} />}
            text={
              history.length === 0
                ? "还没有调用记录。运行任意工具后，历史会显示在这里（本机保留最近 500 条，跨会话可查）。"
                : "没有匹配的记录，试试调整关键字或过滤范围。"
            }
          />
        ) : (
          filtered.map((h) => (
            <div key={h.seq} className="mb-1.5">
              {/* 摘要行：div + role/button（行内还要嵌星标按钮，避免 button 套 button） */}
              <EntrySummary
                entry={h}
                expanded={expandedSeq === h.seq}
                serverName={serverName(h.node_id)}
                onToggleExpand={() => setExpandedSeq(expandedSeq === h.seq ? null : h.seq)}
                onToggleStar={() => void toggleStar(h)}
              />
              {/* 展开的详情：Collapse 双向动画（收起不卸载，保留卡片内部状态） */}
              <Collapse open={expandedSeq === h.seq} className="mt-0.5">
                <ResultCard
                  result={h}
                  starred={h.starred}
                  onToggleStar={() => void toggleStar(h)}
                  onExpand={() => onExpand(h)}
                />
              </Collapse>
            </div>
          ))
        )}

        {/* 动态加载状态行 */}
        {(loadingHistory || hasMoreHistory) && history.length > 0 && (
          <div className="py-2 text-center text-[11px] text-inksoft/60">
            {loadingHistory ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 size={12} className="animate-spin" /> 正在加载更早的记录…
              </span>
            ) : (
              "上滑加载更早的记录"
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 收藏面板：搜索 + 列表（星标按钮取消收藏）；挂载时由 ResultPane 切 tab 触发 loadStars */
function StarPanel({ onExpand }: { onExpand: (entry: HistoryEntry) => void }) {
  const { stars, toggleStar, loadStars, nodes } = useAppStore();
  const [keyword, setKeyword] = useState("");
  /** 当前展开的条目（单开模式，按落库 id） */
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return stars;
    return stars.filter(
      (h) =>
        h.tool_name.toLowerCase().includes(kw) ||
        h.server_name.toLowerCase().includes(kw) ||
        h.arguments.toLowerCase().includes(kw),
    );
  }, [stars, keyword]);

  const serverName = (nodeId: number) =>
    nodes.find((n) => n.id === nodeId)?.name ?? "?";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line p-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-inksoft" />
          <input
            className="field !py-1 pl-7"
            placeholder="搜索收藏的工具名 / Server / 入参…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
      </div>

      <div className={`flex-1 overflow-y-auto p-2 ${filtered.length === 0 ? "-mb-[33px]" : ""}`}>
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Star size={36} strokeWidth={1.2} />}
            text={
              stars.length === 0
                ? "还没有收藏。点击调用记录卡片右上角的星标即可收藏，收藏不会被历史清理删除。"
                : "没有匹配的收藏，试试调整关键字。"
            }
          />
        ) : (
          filtered.map((h) =>
            h.id == null ? null : (
              <div key={h.id} className="mb-1.5">
                <EntrySummary
                  entry={h}
                  expanded={expandedId === h.id}
                  serverName={serverName(h.node_id)}
                  onToggleExpand={() => setExpandedId(expandedId === h.id ? null : h.id!)}
                  onToggleStar={() => void toggleStar(h)}
                />
                {/* 详情：Collapse 双向动画（收起不卸载，保留卡片内部状态） */}
                <Collapse open={expandedId === h.id} className="mt-0.5">
                  <ResultCard
                    result={h}
                    starred={h.starred}
                    onToggleStar={() => void toggleStar(h)}
                    onExpand={() => onExpand(h)}
                  />
                </Collapse>
              </div>
            ),
          )
        )}

        {stars.length === 0 && (
          <div className="pb-2 text-center">
            <button
              className="text-[11px] text-inksoft/60 underline-offset-2 hover:underline"
              onClick={() => void loadStars()}
            >
              刷新收藏列表
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 历史/收藏共用的摘要行：编号 + 状态 + 工具名 + 时间/耗时 + Server 与入参预览 + 星标按钮。
 *
 * 容器为 div + role/button（行内嵌星标按钮，避免 button 套 button），键盘 Enter/Space 可切换展开。
 */
function EntrySummary({
  entry,
  expanded,
  serverName,
  onToggleExpand,
  onToggleStar,
}: {
  entry: HistoryEntry;
  expanded: boolean;
  serverName: string;
  onToggleExpand: () => void;
  onToggleStar: () => void;
}) {
  const starred = !!entry.starred;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggleExpand}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggleExpand();
        }
      }}
      className={`w-full rounded-md border p-2 text-left transition-colors ${
        expanded
          ? "border-primary bg-primarysoft"
          : "border-line bg-panel hover:bg-panel2"
      }`}
    >
      <div className="flex items-center gap-1.5">
        {/* 编号 = 落库自增 id：最新最大、跨会话稳定（新调用在落盘返回前暂缺不显示） */}
        <span className="shrink-0 font-mono text-[10.5px] text-inksoft/70">
          {entry.id != null ? `#${entry.id}` : ""}
        </span>
        {entry.is_error ? (
          <XCircle size={13} className="shrink-0 text-err" />
        ) : (
          <Check size={13} className="shrink-0 text-ok" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium">
          {entry.tool_name}
        </span>
        {/* 星标：收藏/取消（停止冒泡，不触发展开切换） */}
        <button
          className={`shrink-0 rounded p-0.5 transition-colors hover:bg-panel hover:text-warn ${
            starred ? "text-warn" : "text-inksoft/50"
          }`}
          title={starred ? "取消收藏" : "收藏这条记录"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
        >
          <Star size={12} className={starred ? "fill-current" : ""} />
        </button>
        <span className="shrink-0 text-[10.5px] text-inksoft/70">{entry.timestamp}</span>
        <span className="shrink-0 text-[10.5px] text-inksoft">{entry.duration_ms}ms</span>
      </div>
      <div className="mt-0.5 truncate text-[11px] text-inksoft">
        {serverName} · {entry.arguments || "{}"}
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

/** 复制反馈小按钮（带三态图标）：请求入参 / 响应 / cURL 各段共用 */
function CopyBtn({
  state,
  title,
  onCopy,
}: {
  state: "idle" | "ok" | "fail";
  title: string;
  onCopy: () => void;
}) {
  return (
    <button
      className="rounded p-1 text-inksoft hover:bg-panel hover:text-ink"
      title={state === "fail" ? "复制失败" : title}
      onClick={onCopy}
    >
      {state === "ok" ? (
        <Check size={13} className="text-ok" />
      ) : state === "fail" ? (
        <AlertCircle size={13} className="text-err" />
      ) : (
        <Copy size={13} />
      )}
    </button>
  );
}

/** 入参格式化展示：合法 JSON 缩进美化便于阅读，损坏/非 JSON 时显示原文 */
function formatArgsJson(raw: string): string {
  if (!raw) return "{}";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** 敏感头的展示形态：固定星号，不显示真实内容（与 Server 摘要的打码口径一致） */
const MASKED_VALUE = "******";

/**
 * 解析请求头快照为键值行数组，并标记敏感头（是否敏感由第三列携带）。
 * 打码是展示层行为（HeaderRowsView 控制默认星号 + 眼睛切换明文）：快照 JSON
 * 本身含明文（复制按钮/cURL 均复制明文），此处不做值丢弃。
 *
 * @param raw 请求头快照（request_headers，JSON 对象字符串；空/非法 = 空数组）
 * @param sensitiveRaw 敏感头名称名单（sensitive_headers，JSON 数组字符串）
 * @returns `[名称, 原始值, 是否敏感]` 数组（保持 JSON 对象的原有顺序）
 *
 * @example
 * parseHeaderRows('{"Authorization":"Bearer x","Accept":"json"}', '["Authorization"]');
 * // => [["Authorization", "Bearer x", true], ["Accept", "json", false]]
 */
function parseHeaderRows(raw?: string | null, sensitiveRaw?: string | null): Array<[string, string, boolean]> {
  if (!raw?.trim()) return [];
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
    const sensitive = parseSensitiveKeys(sensitiveRaw);
    return Object.entries(obj as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => [k, v as string, isSensitiveKey(sensitive, k)]);
  } catch {
    return [];
  }
}

/**
 * 请求头键值行视图（结果卡片与放大抽屉共用）：敏感头默认星号打码，非敏感行
 * 原样明文（跟随调用时配置的敏感标记）。是否显示敏感行明文由父级通过
 * revealSecrets 控制（如卡片标题行的段级「查看明文」入口），本组件不自带切换。
 *
 * @param rows parseHeaderRows 的输出（[名称, 原始值, 是否敏感]）
 * @param revealSecrets 置 true 时敏感行显示明文（默认打码）
 */
function HeaderRowsView({
  rows,
  revealSecrets = false,
}: {
  rows: Array<[string, string, boolean]>;
  revealSecrets?: boolean;
}) {
  return (
    <div className="max-h-[132px] overflow-y-auto py-2 font-mono text-[12px] leading-relaxed">
      {rows.map(([k, v, sensitive]) => {
        const masked = sensitive && !revealSecrets;
        return (
          <div key={k} className="break-all px-2.5 selectable">
            <span className="text-primarystrong">{k}:</span>{" "}
            <span className={masked ? "text-inksoft/50" : "text-inksoft"}>
              {masked ? MASKED_VALUE : v}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 历史详情卡片内的可收起内容段（请求头/入参/响应三段共用）：
 * 标题行整行可点击切换收起/展开（chevron 旋转动画），right 槽放复制/视图切换
 * 等操作按钮（拦截冒泡不误触标题行）；内容用 Collapse 承载——懒挂载 + 双向动画，
 * 收起不卸载（保留 JSON 折叠树/滚动/tab 状态），默认展开。
 *
 * @param title 段标题（如「请求 · 请求头」）
 * @param right 标题行右侧的操作区（按钮组，内部点击不会触发收起/展开）
 * @param children 段内容
 */
function CollapsibleSection({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  /** 展开状态（各卡片各段独立，会话内记忆） */
  const [open, setOpen] = useState(true);
  return (
    <div className="border-b border-line last:border-b-0">
      <div
        className="flex h-7 cursor-pointer select-none items-center justify-between bg-panel2/60 pl-2.5 pr-1"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-1 text-[10.5px] font-semibold tracking-wide text-inksoft/80">
          <ChevronUp
            size={12}
            className={`shrink-0 text-inksoft transition-transform duration-200 ${open ? "" : "rotate-180"}`}
          />
          {title}
        </span>
        {right && (
          <span className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
            {right}
          </span>
        )}
      </div>
      <Collapse open={open}>{children}</Collapse>
    </div>
  );
}

/** 从 content 数组中提取全部 text 块拼接 */
function extractTextBody(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => {
      const o = c as { type?: string };
      return o?.type === "text" && typeof (c as { text?: unknown }).text === "string";
    })
    .map((c) => c.text)
    .join("\n");
}

/**
 * 响应内容渲染（结果卡片与放大抽屉共用）：按 内容/结构化 tab 与 树/原始视图渲染。
 * 树视图仅在文本可解析为 JSON 时生效，否则回退原始文本。
 */
function ResponseBody({
  result,
  structured,
  tab,
  view,
}: {
  result: CallResult;
  structured: unknown | null;
  tab: "content" | "structured";
  view: "tree" | "raw";
}) {
  const textBody = useMemo(() => extractTextBody(result.content), [result.content]);
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

  if (tab === "structured") {
    return view === "tree" ? (
      <JsonNode value={structured} />
    ) : (
      <pre className="whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed selectable">
        {JSON.stringify(structured, null, 2)}
      </pre>
    );
  }
  return parsed !== null && view === "tree" ? (
    <JsonNode value={parsed} />
  ) : (
    <pre
      className={`whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed selectable ${
        result.is_error ? "text-err" : ""
      }`}
    >
      {textBody || JSON.stringify(result.content, null, 2)}
    </pre>
  );
}

/** 复制反馈 hook 形态的简化状态机：set 后自动复位（每个复制点独立实例） */
function useCopyFeedback(): [
  "idle" | "ok" | "fail",
  (text: string) => Promise<void>,
] {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const copy = async (text: string) => {
    setState((await copyText(text)) ? "ok" : "fail");
    setTimeout(() => setState("idle"), 1200);
  };
  return [state, copy];
}

/**
 * 单条结果卡片；isNew=true（最新一条）默认展开，其余默认折叠，点击头部可展开/收起。
 *
 * 展开后内容分「请求 · 请求头」「请求 · 入参」与「响应」段独立显示，各带复制按钮；
 * HTTP 传输的调用带请求头快照（敏感值默认打码、标题行眼睛可整段查看明文，复制/cURL 为明文），stdio/旧记录不显示请求头段；
 * 头部右侧提供收藏星标（落盘后可用）与「放大查看」（右侧抽屉）入口。
 */
function ResultCard({
  result,
  isNew,
  onExpand,
  starred,
  onToggleStar,
}: {
  result: CallResult;
  isNew?: boolean;
  onExpand?: () => void;
  starred?: boolean;
  onToggleStar?: () => void;
}) {
  const [view, setView] = useState<"tree" | "raw">("tree");
  const [tab, setTab] = useState<"content" | "structured">("content");
  const [copyState, copyResultText] = useCopyFeedback();
  const [argsCopyState, copyArgsText] = useCopyFeedback();
  const [headersCopyState, copyHeadersText] = useCopyFeedback();
  /** 折叠态：非最新结果默认只显示摘要行，手动展开查看详情 */
  const [collapsed, setCollapsed] = useState(!isNew);

  /* 新结果入列后，本卡片从「最新」退化为历史时自动折叠；
     useState 初始值只在挂载时生效，需要跟随 isNew 变化补一次折叠 */
  useEffect(() => {
    if (!isNew) setCollapsed(true);
  }, [isNew]);

  const structured = result.structured_content ?? null;
  const formattedArgs = formatArgsJson(result.arguments);
  const canStar = (result as HistoryEntry).id != null;
  /** 请求头快照键值行（含敏感标记，打码由 HeaderRowsView 控制；stdio / 旧记录为空数组 = 不显示该段） */
  const headerRows = parseHeaderRows(result.request_headers, result.sensitive_headers);

  /** 复制请求头快照明文 JSON（含鉴权头时由复制按钮的提示语提醒注意粘贴场合） */
  const copyHeaders = () => copyHeadersText(result.request_headers ?? "");

  /** 请求头段级「查看明文」：true 时敏感行整段显示明文（行内无逐行切换，入口在标题行） */
  const [revealHeaders, setRevealHeaders] = useState(false);

  /** 复制请求入参（格式化后的 JSON） */
  const copyArgs = () => copyArgsText(formattedArgs);

  /** 复制当前响应视图：内容 tab 复制文本体（无文本时回退原始 content），结构化 tab 复制美化 JSON */
  const copyResult = () => {
    const raw =
      tab === "structured"
        ? JSON.stringify(structured, null, 2)
        : extractTextBody(result.content) || JSON.stringify(result.content, null, 2);
    void copyResultText(raw);
  };

  return (
    <div className={`card overflow-hidden ${isNew ? "anim-slide-up mb-2" : "mb-1"}`}>
      {/* 卡片头：整行可点击切换折叠；右侧星标/放大按钮各自拦截冒泡 */}
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
        <div className="flex shrink-0 items-center gap-0.5">
          {onToggleStar && (
            <button
              className={`rounded p-1 transition-colors hover:bg-panel hover:text-warn disabled:cursor-not-allowed disabled:opacity-30 ${
                starred ? "text-warn" : "text-inksoft"
              }`}
              title={canStar ? (starred ? "取消收藏" : "收藏这条记录") : "落盘完成后可收藏"}
              disabled={!canStar}
              onClick={(e) => {
                e.stopPropagation();
                onToggleStar();
              }}
            >
              <Star size={13} className={starred ? "fill-current" : ""} />
            </button>
          )}
          {onExpand && (
            <button
              className="rounded p-1 text-inksoft transition-colors hover:bg-panel hover:text-ink"
              title="放大查看（左请求 / 右响应，可复制 cURL）"
              onClick={(e) => {
                e.stopPropagation();
                onExpand();
              }}
            >
              <Maximize2 size={13} />
            </button>
          )}
        </div>
      </div>

      {/* 请求头/入参/响应三段各自可收起（点标题行切换；复制/视图按钮拦截冒泡）；
          Collapse 双向动画，懒挂载（未展开过不产生 DOM，避免隐藏的树展开开销；
          收起保留内容——JSON 折叠树/滚动/tab 状态不丢，再展开即时呈现） */}
      <Collapse open={!collapsed}>
        <>
          {/* 请求头段：HTTP 传输的调用才有快照；敏感值默认打码，标题行眼睛一键查看整段明文，
              复制按钮复制明文 */}
          {headerRows.length > 0 && (
            <CollapsibleSection
              title="请求 · 请求头"
              right={
                <>
                  <button
                    className="rounded p-1 text-inksoft transition-colors hover:bg-panel hover:text-ink"
                    title={revealHeaders ? "恢复脱敏显示" : "查看敏感头明文"}
                    aria-label={revealHeaders ? "恢复请求头脱敏显示" : "查看请求头明文"}
                    onClick={() => setRevealHeaders((v) => !v)}
                  >
                    {revealHeaders ? <Eye size={12} /> : <EyeOff size={12} />}
                  </button>
                  <CopyBtn
                    state={headersCopyState}
                    title="复制请求头 JSON（含鉴权头明文，注意粘贴场合）"
                    onCopy={copyHeaders}
                  />
                </>
              }
            >
              <HeaderRowsView rows={headerRows} revealSecrets={revealHeaders} />
            </CollapsibleSection>
          )}

          {/* 请求段：格式化入参 JSON，独立复制按钮 */}
          <CollapsibleSection
            title="请求 · 入参"
            right={<CopyBtn state={argsCopyState} title="复制入参 JSON" onCopy={copyArgs} />}
          >
            <pre className="max-h-[120px] overflow-y-auto whitespace-pre-wrap break-all px-2.5 py-2 font-mono text-[12px] leading-relaxed text-inksoft selectable">
              {formattedArgs}
            </pre>
          </CollapsibleSection>

          {/* 响应段：内容/结构化切换 + 树/原始视图 + 独立复制按钮 */}
          <CollapsibleSection
            title="响应"
            right={
              <>
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
                <CopyBtn state={copyState} title="复制响应" onCopy={copyResult} />
              </>
            }
          >
            <div className="max-h-[300px] overflow-y-auto p-2.5">
              <ResponseBody result={result} structured={structured} tab={tab} view={view} />
            </div>
          </CollapsibleSection>
        </>
      </Collapse>
    </div>
  );
}

/** 请求栏属性（放大抽屉左栏） */
interface RequestPanelProps {
  /** 格式化后的入参 JSON */
  formattedArgs: string;
  /** 生成的 cURL 命令；null = 无法生成（stdio / 配置未就绪），按钮禁用并说明原因 */
  curl: string | null;
  /** cURL 按钮禁用原因（悬浮说明） */
  curlHint?: string;
  /** 请求头快照（JSON 对象字符串）；null/缺省 = stdio 或旧记录，不显示请求头段 */
  requestHeaders?: string | null;
  /** 敏感请求头名称名单（JSON 数组字符串），展示打码用 */
  sensitiveHeaders?: string | null;
}

/** 放大抽屉左栏：请求头（HTTP 传输才有）+ 请求入参（全高滚动），支持复制 JSON / 复制 cURL */
function RequestPanel({ formattedArgs, curl, curlHint, requestHeaders, sensitiveHeaders }: RequestPanelProps) {
  const [argsCopyState, copyArgsText] = useCopyFeedback();
  const [curlCopyState, copyCurlText] = useCopyFeedback();
  const [headersCopyState, copyHeadersText] = useCopyFeedback();
  /** 请求头快照键值行（含敏感标记，打码由 HeaderRowsView 控制；为空 = 不显示请求头段） */
  const headerRows = parseHeaderRows(requestHeaders, sensitiveHeaders);

  return (
    <div className="flex min-h-0 min-w-0 flex-col border-r border-line">
      <div className="flex h-8 shrink-0 items-center justify-between gap-1 border-b border-line bg-panel2/60 pl-3 pr-1.5">
        <span className="text-[11px] font-semibold tracking-wide text-inksoft/80">
          请求 · 入参
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-inksoft transition-colors hover:bg-panel hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            title={curl ? "复制为 cURL（含请求头明文，注意粘贴场合）" : curlHint ?? "无法生成 cURL"}
            disabled={!curl}
            onClick={() => curl && void copyCurlText(curl)}
          >
            {curlCopyState === "ok" ? (
              <Check size={12} className="text-ok" />
            ) : curlCopyState === "fail" ? (
              <AlertCircle size={12} className="text-err" />
            ) : (
              <Terminal size={12} />
            )}
            cURL
          </button>
          <CopyBtn
            state={argsCopyState}
            title="复制入参 JSON"
            onCopy={() => void copyArgsText(formattedArgs)}
          />
        </div>
      </div>
      {/* 请求头块：快照存在时显示在入参上方（敏感值默认打码、眼睛切换明文，复制为明文） */}
      {headerRows.length > 0 && (
        <div className="shrink-0 border-b border-line">
          <div className="flex h-7 items-center justify-between bg-panel2/60 pl-3 pr-1.5">
            <span className="text-[10.5px] font-semibold tracking-wide text-inksoft/80">
              请求 · 请求头
            </span>
            <CopyBtn
              state={headersCopyState}
              title="复制请求头 JSON（含鉴权头明文，注意粘贴场合）"
              onCopy={() => void copyHeadersText(requestHeaders ?? "")}
            />
          </div>
          <div className="px-0.5">
            <HeaderRowsView rows={headerRows} />
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-3">
        <pre className="whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-inksoft selectable">
          {formattedArgs}
        </pre>
      </div>
    </div>
  );
}

/** 响应栏属性（放大抽屉右栏） */
interface ResponsePanelProps {
  result: CallResult;
  structured: unknown | null;
}

/** 放大抽屉右栏：响应（内容/结构化 + 树/原始视图，全高滚动） */
function ResponsePanel({ result, structured }: ResponsePanelProps) {
  const [view, setView] = useState<"tree" | "raw">("tree");
  const [tab, setTab] = useState<"content" | "structured">("content");
  const [copyState, copyResultText] = useCopyFeedback();

  /** 复制当前响应视图 */
  const copyResult = () => {
    const raw =
      tab === "structured"
        ? JSON.stringify(structured, null, 2)
        : extractTextBody(result.content) || JSON.stringify(result.content, null, 2);
    void copyResultText(raw);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line bg-panel2/60 pl-3 pr-1.5">
        <span className="mr-auto text-[11px] font-semibold tracking-wide text-inksoft/80">
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
        <CopyBtn state={copyState} title="复制响应" onCopy={copyResult} />
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <ResponseBody result={result} structured={structured} tab={tab} view={view} />
      </div>
    </div>
  );
}

/**
 * 放大抽屉：右侧滑出的大面板，左侧请求 / 右侧响应对照查看。
 *
 * 头部展示调用元信息（状态、工具、Server、编号、耗时、时间）与收藏/关闭；
 * Esc 或点击遮罩关闭。请求栏可一键复制为 cURL（仅 Streamable HTTP server，
 * 生成的是单次 tools/call POST，含请求头明文）。
 */
function ResultDrawer({ entry, onClose }: { entry: HistoryEntry; onClose: () => void }) {
  const { serverConfigs, loadConfig, toggleStar, nodes } = useAppStore();
  const nodeId = entry.node_id;
  /** 退出动画播放中标记（播完才真正回调 onClose 卸载；期间忽略重复请求） */
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);

  /** 请求关闭：先播 200ms 滑出动画再卸载（与 Modal 的关闭时序一致） */
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    window.setTimeout(() => {
      closingRef.current = false;
      setClosing(false);
      onClose();
    }, 200);
  }, [onClose]);

  /* 父组件切换展示条目时复位关闭动画状态：残留的关闭定时器不应把新条目的抽屉误关 */
  useEffect(() => {
    closingRef.current = false;
    setClosing(false);
  }, [entry.seq]);

  /* 配置按需加载（历史里的 server 可能从未在本会话打开过摘要） */
  const cfg = nodeId != null ? serverConfigs[nodeId] : undefined;
  useEffect(() => {
    if (nodeId != null) void loadConfig(nodeId);
  }, [nodeId, loadConfig]);

  /* Esc 关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  /** cURL 文本：配置就绪且为 HTTP 传输才生成；stdio 返回 null（按钮禁用说明原因） */
  const curl = useMemo(
    () => (cfg ? buildToolsCallCurl(cfg, entry.tool_name, entry.arguments) : null),
    [cfg, entry],
  );
  const curlHint =
    cfg == null
      ? "正在加载 Server 配置…"
      : "仅 Streamable HTTP server 可生成 cURL（stdio 是本地子进程，无 HTTP 端点）";

  const formattedArgs = formatArgsJson(entry.arguments);
  const structured = entry.structured_content ?? null;
  const serverName =
    nodes.find((n) => n.id === nodeId)?.name ?? entry.server_name ?? "";
  const starred = !!entry.starred;

  return (
    <>
      {/* 遮罩：点击关闭；关闭时与面板一起淡出 */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 ${closing ? "anim-fade-out" : "anim-fade-in"}`}
        onClick={requestClose}
      />
      {/* 面板：右侧滑入，关闭时对称滑出 */}
      <div
        className={`fixed inset-y-0 right-0 z-50 flex w-[min(1080px,94vw)] flex-col border-l border-line bg-panel shadow-2xl ${
          closing ? "anim-drawer-out" : "anim-drawer-in"
        }`}
      >
        {/* 头部：元信息 + 收藏 + 关闭 */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
          {entry.is_error ? (
            <span className="chip bg-err/10 text-err">
              <XCircle size={11} /> 失败
            </span>
          ) : (
            <span className="chip bg-ok/10 text-ok">成功</span>
          )}
          <span className="truncate font-mono text-[13px] font-medium text-ink">
            {entry.tool_name}
          </span>
          <span className="shrink-0 text-[11px] text-inksoft">{serverName}</span>
          <span className="shrink-0 font-mono text-[10.5px] text-inksoft/70">
            {entry.id != null ? `#${entry.id}` : ""}
          </span>
          <span className="shrink-0 text-[11px] text-inksoft">{entry.duration_ms} ms</span>
          <span className="hidden shrink-0 text-[11px] text-inksoft/70 sm:inline">
            {entry.timestamp}
          </span>
          <span className="flex-1" />
          <button
            className={`rounded p-1.5 transition-colors hover:bg-panel2 hover:text-warn ${
              starred ? "text-warn" : "text-inksoft"
            }`}
            title={starred ? "取消收藏" : "收藏这条记录"}
            onClick={() => void toggleStar(entry)}
          >
            <Star size={15} className={starred ? "fill-current" : ""} />
          </button>
          <button
            className="rounded p-1.5 text-inksoft transition-colors hover:bg-panel2 hover:text-ink"
            title="关闭（Esc）"
            onClick={requestClose}
          >
            <X size={16} />
          </button>
        </div>

        {/* 主体：左请求 / 右响应 */}
        <div className="grid min-h-0 flex-1 grid-cols-2">
          <RequestPanel
            formattedArgs={formattedArgs}
            curl={curl}
            curlHint={curlHint}
            requestHeaders={entry.request_headers}
            sensitiveHeaders={entry.sensitive_headers}
          />
          <ResponsePanel result={entry} structured={structured} />
        </div>
      </div>
    </>
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

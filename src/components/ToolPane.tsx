/**
 * 第二栏：选中 Server 的工具列表（搜索过滤、连接/断开、刷新）。
 */
import { useMemo, useState } from "react";
import {
  AlertCircle,
  Plug,
  PlugZap,
  RefreshCw,
  Search,
  Unplug,
  Wrench,
} from "lucide-react";
import { useAppStore } from "../store";
import { EmptyState, StatusDot } from "./ui";

/** 工具列表栏 */
export function ToolPane() {
  const { selectedNodeId, nodes, tools, connStates, connErrors, selectedToolName, selectTool, connect, disconnect, refreshTools } =
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
      <PaneWrap title="工具列表">
        <EmptyState icon={<Wrench size={36} strokeWidth={1.2} />} text="在左侧选择一个 MCP Server，这里会列出它的全部工具。" />
      </PaneWrap>
    );
  }

  return (
    <PaneWrap title={`工具列表 · ${node.name}`}>
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

      {/* 工具列表 */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {status !== "connected" ? (
          <EmptyState
            icon={<Plug size={32} strokeWidth={1.2} />}
            text={status === "connecting" ? "正在连接 Server…" : "连接后即可查看工具列表。"}
          />
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

/** 栏外壳：标题 + 内容 */
function PaneWrap({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-hidden border-r border-line bg-panel/50">
      <div className="flex h-9 shrink-0 items-center border-b border-line px-3">
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

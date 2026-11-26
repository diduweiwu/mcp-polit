/**
 * 第二栏：选中 Server 的工具列表（搜索过滤、连接/断开、刷新）。
 */
import { useMemo, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  Clock,
  Globe,
  PanelLeftClose,
  Pencil,
  Plug,
  PlugZap,
  RefreshCw,
  Search,
  Settings2,
  Square,
  Terminal,
  Unplug,
  Wrench,
} from "lucide-react";
import { activeEnvName, useAppStore } from "../store";
import type { TreeNode } from "../types";
import { isSensitiveKey, parseSensitiveKeys } from "../lib/sensitive";
import { Collapse, EmptyState, StatusDot } from "./ui";
import { ServerFormModal } from "./ServerFormModal";

/** 工具列表栏 */
export function ToolPane() {
  const { selectedNodeId, nodes, tools, connStates, connErrors, selectedToolName, selectTool, connect, cancelConnect, disconnect, refreshTools } =
    useAppStore();

  const [keyword, setKeyword] = useState("");
  /** 描述已展开的工具名集合（描述超两行截断，点角标查看全文） */
  const [expandedDescs, setExpandedDescs] = useState<Set<string>>(new Set());

  /** 切换某工具描述的展开/收起 */
  const toggleDesc = (name: string) =>
    setExpandedDescs((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const node = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const list = selectedNodeId != null ? (tools[selectedNodeId] ?? []) : [];
  const status = selectedNodeId != null ? (connStates[selectedNodeId] ?? "disconnected") : "disconnected";
  const err = selectedNodeId != null ? (connErrors[selectedNodeId] ?? "") : "";
  /** 收起动画播放中（淡出结束后才真正折叠；展开重建时由 PaneWrap 播放入场） */
  const [closing, setClosing] = useState(false);

  /** 收起本栏：先播 160ms 淡出，再触发折叠（与资源树栏折叠同一节奏） */
  const collapseWithAnim = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => {
      useAppStore.getState().toggleToolsCollapsed();
    }, 160);
  };

  /** 栏头右侧的收起按钮（空态/正常态共用） */
  const collapseBtn = (
    <button
      className="rounded p-1 text-inksoft transition-colors hover:bg-panel2 hover:text-ink"
      title="收起工具列表"
      onClick={collapseWithAnim}
    >
      <PanelLeftClose size={14} />
    </button>
  );
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
      <PaneWrap title="工具列表" className={closing ? "anim-fade-out" : "anim-pane-in"} right={collapseBtn}>
        <EmptyState icon={<Wrench size={36} strokeWidth={1.2} />} text="在左侧选择一个 MCP Server，这里会列出它的全部工具。" />
      </PaneWrap>
    );
  }

  return (
    <PaneWrap title={`工具列表 · ${node.name}`} className={closing ? "anim-fade-out" : "anim-pane-in"} right={collapseBtn}>
      {/* 已连接：「Server 配置」折叠条紧跟栏头标题（固定，不随工具列表滚动） */}
      {status === "connected" && (
        <div className="shrink-0 px-1.5 pt-1.5">
          <ConnectedConfigBar node={node} />
        </div>
      )}

      {/* 状态条 */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-2.5">
        <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
          <StatusDot status={status} />
          <span className="truncate text-inksoft">
            {status === "connected"
              ? `已连接 · ${list.length} 个工具`
              : status === "connecting"
                ? "连接中…"
                : status === "error"
                  ? "连接失败"
                  : "未连接"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
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
            ) : status === "connecting" ? (
              // 连接中：提供「中断」入口，避免连不上时干等 30s 超时
              <IconBtn title="中断连接（不必等超时）" onClick={() => void cancelConnect(node.id)}>
                <Square size={11} className="fill-current text-err" />
              </IconBtn>
            ) : (
              <IconBtn title="连接" onClick={() => void connect(node.id)}>
                {status === "error" ? <AlertCircle size={14} className="text-err" /> : <PlugZap size={14} />}
              </IconBtn>
            )}
          </div>
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

      {/* 连接错误提示（whitespace-pre-wrap 保留原始换行；break-all 兜底超长无空格行不溢出） */}
      {status === "error" && err && (
        <div className="mx-2 mt-2 whitespace-pre-wrap break-all rounded-md border border-err/30 bg-err/10 p-2 text-[12px] leading-relaxed text-err selectable">
          {err}
        </div>
      )}

      {/* 未连接：显示配置摘要面板（单击节点即出现）；已连接：工具列表 */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {status !== "connected" && <ServerSummary node={node} status={status} />}
        {status === "connected" &&
          (filtered.length === 0 ? (
            <EmptyState text={keyword ? "没有匹配的工具。" : "该 Server 未提供任何工具。"} />
          ) : (
          filtered.map((t) => {
            const active = selectedToolName === t.name;
            const expanded = expandedDescs.has(t.name);
            return (
              // 容器用 div + role/button：卡片内还要嵌展开角标按钮，避免 button 套 button
              <div
                key={t.name}
                role="button"
                tabIndex={0}
                onClick={() => selectTool(t.name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectTool(t.name);
                  }
                }}
                className={`group mb-1 w-full cursor-pointer select-none rounded-md border p-2 text-left transition-colors ${
                  active
                    ? "border-primary bg-primarysoft"
                    : "border-transparent hover:border-line hover:bg-panel2"
                }`}
              >
                <div className="flex items-start gap-1">
                  <div
                    className={`min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium ${active ? "text-primarystrong" : ""}`}
                    title={t.name}
                  >
                    {t.name}
                  </div>
                  {/* 描述展开/收起角标：悬停卡片时出现，点击只切换展开不影响选中 */}
                  {t.description && (
                    <button
                      className={`shrink-0 rounded p-0.5 text-inksoft/60 transition-all hover:bg-panel2 hover:text-ink ${
                        expanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                      }`}
                      title={expanded ? "收起描述" : "查看完整描述"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleDesc(t.name);
                      }}
                    >
                      <ChevronDown
                        size={13}
                        className={`transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
                      />
                    </button>
                  )}
                </div>
                <div
                  className={`mt-0.5 text-[11.5px] leading-snug text-inksoft ${expanded ? "" : "line-clamp-2"}`}
                  title={t.description || undefined}
                >
                  {t.description || "（无描述）"}
                </div>
              </div>
            );
          })
        ))}
      </div>
    </PaneWrap>
  );
}

/** 已连接状态顶部的可折叠配置条：默认收起，点击展开完整配置摘要 */
function ConnectedConfigBar({ node }: { node: TreeNode }) {
  const cfg = useAppStore((s) => s.serverConfigs[node.id]);
  const [open, setOpen] = useState(false);
  /* 配置尚未异步加载完成时只渲染骨架条 */
  if (!cfg) {
    return (
      <div className="mb-1">
        <div className="h-[30px] animate-pulse rounded-md border border-line bg-panel2" />
      </div>
    );
  }
  return (
    <div className="mb-1">
      <button
        className="flex w-full items-center justify-between rounded-md border border-line bg-panel2 px-2 py-1.5 text-[12px] text-inksoft transition-colors hover:text-ink"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-1.5">
          <Settings2 size={13} /> Server 配置
        </span>
        <ChevronDown
          size={13}
          className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {/* 摘要展开/收起：Collapse 双向动画（收起不卸载，保留内容状态） */}
      <Collapse open={open} className="mt-1">
        <ServerSummary node={node} status="connected" />
      </Collapse>
    </div>
  );
}

/** 栏外壳：标题 + 内容（lead 为标题左侧可选元素；right 为标题右侧可选区域；className 透传到根容器承载出入场动画） */
function PaneWrap({
  title,
  children,
  right,
  className,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex h-full flex-col overflow-hidden border-r border-line bg-panel/50 ${className ?? ""}`}
    >
      <div className="flex h-9 shrink-0 items-center border-b border-line px-3">
        <span className="min-w-0 truncate text-[12px] font-semibold text-inksoft">{title}</span>
        <span className="flex-1" />
        {right}
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

/** 敏感值的摘要展示形态：固定星号，不显示真实内容 */
const MASKED_VALUE = "******";
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
 * Server 配置摘要面板。
 *
 * - 未连接：显示连接信息 + 「连接」「编辑配置」按钮；
 * - 已连接（折叠条展开时）：显示同样信息，底部按钮换为「重新连接」「断开」。
 */
function ServerSummary({ node, status }: { node: TreeNode; status: string }) {
  const cfg = useAppStore((s) => s.serverConfigs[node.id]);
  const callTimeoutSecs = useAppStore((s) => s.callTimeoutSecs);
  const { connect, cancelConnect, disconnect, refreshTools } = useAppStore();
  /** 当前全局环境名（连接时配置里的 {{}} 引用按它插值；空串 = 未选择） */
  const envName = useAppStore((s) => activeEnvName(s));
  const [editOpen, setEditOpen] = useState(false);
  const connected = status === "connected";

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
  /** 实际生效的调用超时（毫秒）：Server 配置与全局设置（秒）取较大者，与后端 call_tool 一致 */
  const effectiveTimeoutMs = Math.max(cfg.timeout_ms, callTimeoutSecs * 1000);

  return (
    <div className="anim-fade-in p-2">
      {/* 传输类型徽章 + 当前环境 + 停用标记 */}
      <div className="mb-2.5 flex items-center gap-1.5">
        <span
          className={`chip ${
            isHttp ? "bg-violet-500/10 text-violet-500" : "bg-emerald-500/10 text-emerald-500"
          }`}
        >
          {isHttp ? <Globe size={11} /> : <Terminal size={11} />}
          {isHttp ? "Streamable HTTP" : "stdio"}
        </span>
        {envName && (
          <span className="chip bg-primarysoft text-primarystrong" title={`连接时按环境「${envName}」解析 {{变量名}} 引用`}>
            环境：{envName}
          </span>
        )}
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
              <span className="text-primarystrong">{k}:</span>{" "}
              {isSensitiveKey(parseSensitiveKeys(cfg.sensitive_headers), k) ? (
                <span className="text-inksoft" title="已标记为敏感信息，值已隐藏">
                  {MASKED_VALUE}
                </span>
              ) : (
                v
              )}
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
        <Clock size={11} /> 调用超时 {effectiveTimeoutMs} ms
        {cfg.timeout_ms < effectiveTimeoutMs && (
          <span className="text-inksoft/60">· 全局下限生效</span>
        )}
      </div>
      {cfg.note?.trim() && (
        <div className="mb-2.5 rounded-md bg-panel2 p-2 text-[12px] leading-relaxed text-inksoft selectable">
          {cfg.note}
        </div>
      )}

      {/* 操作：已连接 -> 重新连接 / 断开；未连接 -> 连接 / 编辑配置 */}
      {connected ? (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              className="btn-primary h-9"
              disabled={connecting}
              onClick={() => void refreshTools(node.id)}
              title="断开并重新连接（刷新工具列表）"
            >
              <RefreshCw size={14} className={connecting ? "animate-spin" : ""} />
              {connecting ? "连接中…" : "重新连接"}
            </button>
            <button className="btn-ghost h-9" onClick={() => void disconnect(node.id)}>
              <Unplug size={14} /> 断开
            </button>
          </div>
          <button className="btn-ghost mt-1.5 h-8 w-full" onClick={() => setEditOpen(true)}>
            <Pencil size={13} /> 编辑配置
          </button>
        </>
      ) : (
        <>
          {connecting ? (
            /* 连接中：大按钮切换为「中断连接」，不必干等超时（与状态条小按钮同能力） */
            <button className="btn-ghost h-9 w-full" onClick={() => void cancelConnect(node.id)}>
              <Square size={12} className="fill-current text-err" />
              中断连接
            </button>
          ) : (
            <button
              className="btn-primary h-9 w-full"
              disabled={!cfg.enabled}
              onClick={() => void connect(node.id)}
            >
              <PlugZap size={14} />
              {status === "error" ? "重试连接" : "连接"}
            </button>
          )}
          <button
            className="btn-ghost mt-1.5 h-8 w-full"
            disabled={connecting}
            onClick={() => setEditOpen(true)}
          >
            <Pencil size={13} /> 编辑配置
          </button>
          <p className="mt-2 text-center text-[11px] text-inksoft/60">
            提示：双击左侧节点可直接连接
          </p>
        </>
      )}

      {editOpen && <ServerFormModal parentId={null} onClose={() => setEditOpen(false)} />}
    </div>
  );
}

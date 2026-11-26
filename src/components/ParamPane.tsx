/**
 * 第三栏：工具参数（表单模式 / JSON 模式切换）+ 运行按钮 + 参数 Case 管理。
 *
 * 参数自动缓存（跨工具/项目切换与重启保留）；可保存为命名 Case 一键带入。
 */
import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { BookmarkPlus, Play, Table2, Braces, Loader2, SlidersHorizontal, PanelLeftClose } from "lucide-react";
import { useAppStore } from "../store";
import { buildDefaults, pruneArgs, SchemaForm, type FormValue } from "./SchemaForm";
import { EmptyState, Modal, SearchSelect } from "./ui";

/** 参数栏 */
export function ParamPane() {
  const {
    nodes,
    selectedNodeId,
    tools,
    selectedToolName,
    running,
    runTool,
    toolParams,
    cases,
    saveToolParam,
    saveParamCase,
    deleteParamCase,
  } = useAppStore();

  const tool = useMemo(() => {
    const list = selectedNodeId != null ? (tools[selectedNodeId] ?? []) : [];
    return list.find((t) => t.name === selectedToolName) ?? null;
  }, [tools, selectedNodeId, selectedToolName]);

  const node = nodes.find((n) => n.id === selectedNodeId) ?? null;
  /** 收起动画播放中（淡出结束后才真正折叠；展开重建时由根容器播放入场） */
  const [closing, setClosing] = useState(false);

  /** 收起本栏：先播 160ms 淡出，再触发折叠（与资源树/工具列表栏同一节奏） */
  const collapseWithAnim = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => {
      useAppStore.getState().toggleParamsCollapsed();
    }, 160);
  };

  /** 缓存/Case 的 key */
  const paramKey = selectedNodeId != null && selectedToolName ? `${selectedNodeId}:${selectedToolName}` : null;
  const myCases = paramKey ? (cases[paramKey] ?? []) : [];

  const [mode, setMode] = useState<"form" | "json">("form");
  const [value, setValue] = useState<FormValue>({});
  const [jsonText, setJsonText] = useState("{}");
  const [jsonError, setJsonError] = useState("");
  /** 保存 Case 的命名输入态 */
  const [caseName, setCaseName] = useState("");
  const [namingCase, setNamingCase] = useState(false);
  /** Case 管理弹窗开关 */
  const [caseMgrOpen, setCaseMgrOpen] = useState(false);

  /* 实际生效的暗色态：跟随系统时以 html.dark 类为准（applyThemeMode 维护），
     用 MutationObserver 监听类变化，保证 light/dark/system 三态下编辑器主题都正确 */
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setIsDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  /* 切换工具时：优先恢复缓存的参数（跨切换/重启保留），否则用 schema 默认值 */
  useEffect(() => {
    if (tool) {
      const cached = paramKey ? toolParams[paramKey] : undefined;
      const init: FormValue = cached
        ? (() => {
            try {
              return JSON.parse(cached) as FormValue;
            } catch {
              return buildDefaults(tool.input_schema);
            }
          })()
        : buildDefaults(tool.input_schema);
      setValue(init);
      setJsonText(JSON.stringify(init, null, 2));
      setJsonError("");
      setMode("form");
      setNamingCase(false);
      setCaseName("");
    }
    // toolParams 不作为依赖：仅切换工具时恢复一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  /** 表单/JSON 变化时写入参数缓存（防抖由 saveToolParam 内部处理） */
  const persist = (v: FormValue) => {
    if (paramKey) {
      try {
        saveToolParam(paramKey, JSON.stringify(v));
      } catch {
        /* 含 undefined 的序列化失败忽略 */
      }
    }
  };

  if (!node || !tool) {
    return (
      <div
        className={`flex h-full flex-col overflow-hidden bg-panel/50 ${closing ? "anim-fade-out" : "anim-pane-in"}`}
      >
        <PaneHeader title="参数" tool={null} mode={mode} setMode={setMode} onCollapse={collapseWithAnim} />
        {/* 空态与工具列表/调用结果两栏共用 EmptyState：icon 与文字首行跨栏水平对齐 */}
        <EmptyState
          icon={<SlidersHorizontal size={36} strokeWidth={1.2} />}
          text="选择一个工具后在此填写参数"
        />
      </div>
    );
  }

  /** 表单模式 → JSON 模式时同步文本 */
  const switchMode = (m: "form" | "json") => {
    if (m === "json") setJsonText(JSON.stringify(value, null, 2));
    setMode(m);
  };

  /** 带入一个 Case 的入参快照（同步到表单与 JSON 文本）；损坏的 Case 静默忽略 */
  const applyCase = (argsJson: string) => {
    try {
      const parsed = JSON.parse(argsJson) as FormValue;
      setValue(parsed);
      setJsonText(JSON.stringify(parsed, null, 2));
      setJsonError("");
    } catch {
      /* 忽略损坏的 case */
    }
  };

  /** 运行：按当前模式组装入参并调用 */
  const doRun = () => {
    if (selectedNodeId == null || !selectedToolName) return;
    let argsJson: string;
    if (mode === "form") {
      try {
        argsJson = JSON.stringify(pruneArgs(value, tool.input_schema));
      } catch (e) {
        setJsonError(`入参序列化失败：${e}`);
        return;
      }
    } else {
      try {
        const parsed = JSON.parse(jsonText);
        argsJson = JSON.stringify(parsed);
        setJsonError("");
      } catch (e) {
        setJsonError(`JSON 格式错误：${e}`);
        return;
      }
    }
    void runTool(selectedNodeId, selectedToolName, argsJson);
  };

  return (
    <div
      className={`flex h-full flex-col overflow-hidden bg-panel/50 ${closing ? "anim-fade-out" : "anim-pane-in"}`}
    >
      <PaneHeader title={`参数 · ${tool.name}`} tool={tool} mode={mode} setMode={switchMode} onCollapse={collapseWithAnim} />

      <div key={selectedToolName ?? "empty"} className="anim-fade-in flex-1 overflow-y-auto p-3">
        {/* 参数 Case 条：可搜索下拉一键带入（输入关键字过滤），「管理」打开弹窗查看/删除 */}
        {myCases.length > 0 && (
          <div className="mb-3 flex items-center gap-1.5">
            <span className="shrink-0 text-[11px] text-inksoft/70">Case：</span>
            <SearchSelect
              placeholder="选择 Case 带入…"
              options={myCases.map((c) => ({ value: c.name, label: c.name }))}
              onSelect={(name) => {
                const hit = myCases.find((c) => c.name === name);
                if (hit) applyCase(hit.args);
              }}
            />
            <button
              className="btn-ghost h-7 shrink-0 gap-1 !px-2 text-[11.5px]"
              title="查看全部 Case，可带入或删除"
              onClick={() => setCaseMgrOpen(true)}
            >
              <SlidersHorizontal size={12} /> 管理
            </button>
          </div>
        )}
        {mode === "form" ? (
          <SchemaForm
            schema={tool.input_schema}
            value={value}
            onChange={(v) => {
              setValue(v);
              setJsonText(JSON.stringify(v, null, 2));
              persist(v);
            }}
          />
        ) : (
          <div className="overflow-hidden rounded-md border border-line">
            <CodeMirror
              value={jsonText}
              height="320px"
              extensions={[json()]}
              theme={isDark ? oneDark : "light"}
              basicSetup={{ foldGutter: false, lineNumbers: true }}
              onChange={(v) => {
                setJsonText(v);
                try {
                  const parsed = JSON.parse(v) as FormValue;
                  setValue(parsed);
                  setJsonError("");
                  persist(parsed);
                } catch {
                  setJsonError("（输入中，JSON 暂不完整）");
                }
              }}
            />
          </div>
        )}
        {jsonError && (
          <div className="mt-2 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[12px] text-warn">
            {jsonError}
          </div>
        )}
        {tool.description && (
          <div className="mt-3 rounded-md bg-panel2 p-2.5 text-[12px] leading-relaxed text-inksoft selectable">
            {tool.description}
          </div>
        )}
      </div>

      {/* 底部运行条：保存 Case + 运行 */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-t border-line px-3">
        <span className="min-w-0 flex-1 truncate text-[12px] text-inksoft">
          {running
            ? "调用中…"
            : namingCase
              ? "输入 Case 名称后回车保存当前参数"
              : "参数会自动保留，也可保存为 Case"}
        </span>
        {namingCase ? (
          <div className="flex items-center gap-1.5">
            <input
              className="field h-8 !py-0.5"
              style={{ width: 120 }}
              autoFocus
              placeholder="Case 名称"
              value={caseName}
              onChange={(e) => setCaseName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && caseName.trim() && paramKey) {
                  void saveParamCase(paramKey, caseName.trim(), JSON.stringify(pruneArgs(value, tool.input_schema)));
                  setNamingCase(false);
                  setCaseName("");
                }
                if (e.key === "Escape") setNamingCase(false);
              }}
            />
            <button
              className="btn-ghost h-8 !px-2"
              onClick={() => setNamingCase(false)}
            >
              取消
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <button
              className="btn-ghost h-8 gap-1 !px-2"
              title="把当前入参保存为 Case，下次一键带入"
              onClick={() => setNamingCase(true)}
            >
              <BookmarkPlus size={14} />
            </button>
            <button className="btn-primary h-8 gap-1.5" onClick={doRun} disabled={running}>
              {running ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Play size={14} />
              )}
              {running ? "运行中…" : "运行"}
            </button>
          </div>
        )}
      </div>

      {/* Case 管理弹窗：查看该工具全部 Case，可带入或删除 */}
      <Modal
        open={caseMgrOpen}
        title={`参数 Case · ${tool.name}`}
        onClose={() => setCaseMgrOpen(false)}
        width={520}
      >
        {myCases.length === 0 ? (
          <p className="py-8 text-center text-[13px] leading-relaxed text-inksoft">
            还没有保存的 Case。
            <br />
            填写参数后点击底部 <BookmarkPlus size={13} className="inline align-[-2px]" /> 按钮即可把当前参数保存为 Case。
          </p>
        ) : (
          <div className="space-y-1.5">
            {myCases.map((c) => (
              <div key={c.name} className="rounded-md border border-line bg-panel2/50 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate font-mono text-[12.5px] font-medium text-ink">
                    {c.name}
                  </span>
                  <span className="shrink-0 text-[10.5px] text-inksoft/70">保存于 {c.saved_at}</span>
                  <span className="flex-1" />
                  <button
                    className="btn-ghost h-6 shrink-0 !px-2 text-[11px]"
                    title="带入该 Case 的参数"
                    onClick={() => {
                      applyCase(c.args);
                      setCaseMgrOpen(false);
                    }}
                  >
                    带入
                  </button>
                  <button
                    className="h-6 shrink-0 rounded px-2 text-[11px] text-inksoft transition-colors hover:bg-err/10 hover:text-err"
                    title="删除该 Case"
                    onClick={() => paramKey && void deleteParamCase(paramKey, c.name)}
                  >
                    删除
                  </button>
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-inksoft" title={c.args}>
                  {c.args}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}

/**
 * 栏头：展开入口（左邻栏折叠时）+ 标题 + 模式切换 + 本栏收起按钮。
 *
 * 折叠栏的展开入口链：资源树折叠 → 工具列表/参数栏头展开；工具列表折叠 →
 * 参数栏头展开；本栏（参数）收起由 onCollapse 触发（带淡出动画）。
 */
function PaneHeader({
  title,
  tool,
  mode,
  setMode,
  onCollapse,
}: {
  title: string;
  tool: { description: string | null } | null;
  mode: "form" | "json";
  setMode: (m: "form" | "json") => void;
  /** 收起本栏（由父级播放淡出动画后折叠） */
  onCollapse: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
      <div className="flex min-w-0 items-center">
        <span className="truncate text-[12px] font-semibold text-inksoft">{title}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {tool && (
          <div className="flex overflow-hidden rounded-md border border-line">
            <ModeBtn active={mode === "form"} onClick={() => setMode("form")} icon={<Table2 size={12} />}>
              表单
            </ModeBtn>
            <ModeBtn active={mode === "json"} onClick={() => setMode("json")} icon={<Braces size={12} />}>
              JSON
            </ModeBtn>
          </div>
        )}
        <button
          className="rounded p-1 text-inksoft transition-colors hover:bg-panel2 hover:text-ink"
          title="收起参数栏"
          onClick={onCollapse}
        >
          <PanelLeftClose size={14} />
        </button>
      </div>
    </div>
  );
}

/** 模式切换按钮 */
function ModeBtn({
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
      className={`flex items-center gap-1 px-2 py-1 text-[11.5px] transition-colors ${
        active ? "bg-primarysoft text-primarystrong" : "text-inksoft hover:bg-panel2"
      }`}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}

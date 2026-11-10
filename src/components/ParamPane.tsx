/**
 * 第三栏：工具参数（表单模式 / JSON 模式切换）+ 运行按钮。
 */
import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { Play, Table2, Braces, Loader2 } from "lucide-react";
import { useAppStore } from "../store";
import { buildDefaults, pruneArgs, SchemaForm, type FormValue } from "./SchemaForm";

/** 参数栏 */
export function ParamPane() {
  const { nodes, selectedNodeId, tools, selectedToolName, running, runTool, themeMode } =
    useAppStore();

  const tool = useMemo(() => {
    const list = selectedNodeId != null ? (tools[selectedNodeId] ?? []) : [];
    return list.find((t) => t.name === selectedToolName) ?? null;
  }, [tools, selectedNodeId, selectedToolName]);

  const node = nodes.find((n) => n.id === selectedNodeId) ?? null;

  const [mode, setMode] = useState<"form" | "json">("form");
  const [value, setValue] = useState<FormValue>({});
  const [jsonText, setJsonText] = useState("{}");
  const [jsonError, setJsonError] = useState("");

  /* 切换工具时重建表单初始值 */
  useEffect(() => {
    if (tool) {
      const init = buildDefaults(tool.input_schema);
      setValue(init);
      setJsonText(JSON.stringify(init, null, 2));
      setJsonError("");
      setMode("form");
    }
  }, [tool]);

  if (!node || !tool) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-panel/50">
        <PaneHeader title="参数" tool={null} mode={mode} setMode={setMode} />
        <div className="flex flex-1 items-center justify-center text-[13px] text-inksoft">
          选择一个工具后在此填写参数
        </div>
      </div>
    );
  }

  /** 表单模式 → JSON 模式时同步文本 */
  const switchMode = (m: "form" | "json") => {
    if (m === "json") setJsonText(JSON.stringify(value, null, 2));
    setMode(m);
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
    <div className="flex h-full flex-col overflow-hidden bg-panel/50">
      <PaneHeader title={`参数 · ${tool.name}`} tool={tool} mode={mode} setMode={switchMode} />

      <div className="flex-1 overflow-y-auto p-3">
        {mode === "form" ? (
          <SchemaForm
            schema={tool.input_schema}
            value={value}
            onChange={(v) => {
              setValue(v);
              setJsonText(JSON.stringify(v, null, 2));
            }}
          />
        ) : (
          <div className="overflow-hidden rounded-md border border-line">
            <CodeMirror
              value={jsonText}
              height="320px"
              extensions={[json()]}
              theme={themeMode === "dark" ? oneDark : "light"}
              basicSetup={{ foldGutter: false, lineNumbers: true }}
              onChange={(v) => {
                setJsonText(v);
                try {
                  const parsed = JSON.parse(v) as FormValue;
                  setValue(parsed);
                  setJsonError("");
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

      {/* 底部运行条 */}
      <div className="flex h-12 shrink-0 items-center justify-between border-t border-line px-3">
        <span className="text-[12px] text-inksoft">
          {running ? "调用中…" : "检查参数后点击运行"}
        </span>
        <button className="btn-primary h-8 gap-1.5" onClick={doRun} disabled={running}>
          {running ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Play size={14} />
          )}
          {running ? "运行中…" : "运行"}
        </button>
      </div>
    </div>
  );
}

/** 栏头：标题 + 模式切换 */
function PaneHeader({
  title,
  tool,
  mode,
  setMode,
}: {
  title: string;
  tool: { description: string | null } | null;
  mode: "form" | "json";
  setMode: (m: "form" | "json") => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
      <span className="truncate text-[12px] font-semibold text-inksoft">{title}</span>
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

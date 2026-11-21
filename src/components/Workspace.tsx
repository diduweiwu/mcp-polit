/**
 * 四栏工作台布局：资源树 | 工具列表 | 参数 | 结果（可拖拽调整宽度）。
 * 资源树 / 工具列表 / 参数三栏均可折叠（不渲染对应栏，其余栏重新分配比例）；
 * 支持一键均分（按当前可见栏数均分）。
 */
import { useEffect, useRef } from "react";
import { Allotment, type AllotmentHandle } from "allotment";
import { useAppStore } from "../store";
import { TreePane } from "./TreePane";
import { ToolPane } from "./ToolPane";
import { ParamPane } from "./ParamPane";
import { ResultPane } from "./ResultPane";

/** 各栏的初始宽度偏好（折叠不改变偏好，展开时按可见组合分配） */
const PANE_PREFERRED: Record<string, number> = {
  tree: 240,
  tools: 250,
  params: 380,
  result: 360,
};

/** 工作台主体 */
export function Workspace() {
  const treeCollapsed = useAppStore((s) => s.treeCollapsed);
  const toolsCollapsed = useAppStore((s) => s.toolsCollapsed);
  const paramsCollapsed = useAppStore((s) => s.paramsCollapsed);
  const equalizeSignal = useAppStore((s) => s.layoutEqualizeSignal);
  const allotmentRef = useRef<AllotmentHandle>(null);

  /** 当前可见栏的宽度偏好列表（结果栏恒显示，排在最后） */
  const visibleKeys: string[] = [];
  if (!treeCollapsed) visibleKeys.push("tree");
  if (!toolsCollapsed) visibleKeys.push("tools");
  if (!paramsCollapsed) visibleKeys.push("params");
  visibleKeys.push("result");

  /* 一键均分：resize 按传入值的相对比例分配，全部传 1 即等分（只均分可见栏） */
  useEffect(() => {
    if (equalizeSignal === 0) return;
    allotmentRef.current?.resize(visibleKeys.map(() => 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equalizeSignal, treeCollapsed, toolsCollapsed, paramsCollapsed]);

  return (
    <div className="min-h-0 flex-1">
      {/* key 随折叠组合变化，切换时重建分栏并应用对应比例 */}
      <Allotment
        key={`${treeCollapsed}-${toolsCollapsed}-${paramsCollapsed}`}
        ref={allotmentRef}
        vertical={false}
        defaultSizes={visibleKeys.map((k) => PANE_PREFERRED[k])}
      >
        {!treeCollapsed && (
          <Allotment.Pane minSize={190} maxSize={480}>
            <TreePane />
          </Allotment.Pane>
        )}
        {!toolsCollapsed && (
          <Allotment.Pane minSize={190} preferredSize={250}>
            <ToolPane />
          </Allotment.Pane>
        )}
        {!paramsCollapsed && (
          <Allotment.Pane minSize={260}>
            <ParamPane />
          </Allotment.Pane>
        )}
        <Allotment.Pane minSize={240} preferredSize={360}>
          <ResultPane />
        </Allotment.Pane>
      </Allotment>
    </div>
  );
}

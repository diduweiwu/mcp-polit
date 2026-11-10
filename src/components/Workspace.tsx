/**
 * 四栏工作台布局：资源树 | 工具列表 | 参数 | 结果（可拖拽调整宽度）。
 * 资源树栏可折叠（不渲染第一栏，其余三栏重新分配）；支持一键四栏均分。
 */
import { useEffect, useRef } from "react";
import { Allotment, type AllotmentHandle } from "allotment";
import { useAppStore } from "../store";
import { TreePane } from "./TreePane";
import { ToolPane } from "./ToolPane";
import { ParamPane } from "./ParamPane";
import { ResultPane } from "./ResultPane";

/** 工作台主体 */
export function Workspace() {
  const treeCollapsed = useAppStore((s) => s.treeCollapsed);
  const equalizeSignal = useAppStore((s) => s.layoutEqualizeSignal);
  const allotmentRef = useRef<AllotmentHandle>(null);

  /* 一键均分：resize 按传入值的相对比例分配，全部传 1 即等宽 */
  useEffect(() => {
    if (equalizeSignal === 0) return;
    const sizes = treeCollapsed ? [1, 1, 1] : [1, 1, 1, 1];
    allotmentRef.current?.resize(sizes);
  }, [equalizeSignal, treeCollapsed]);

  return (
    <div className="min-h-0 flex-1">
      {/* key 随折叠状态变化，切换时重建分栏并应用对应比例 */}
      <Allotment
        key={treeCollapsed ? "collapsed" : "expanded"}
        ref={allotmentRef}
        vertical={false}
        defaultSizes={treeCollapsed ? [250, 380, 360] : [240, 250, 380, 360]}
      >
        {!treeCollapsed && (
          <Allotment.Pane minSize={190} maxSize={480}>
            <TreePane />
          </Allotment.Pane>
        )}
        <Allotment.Pane minSize={190} preferredSize={250}>
          <ToolPane />
        </Allotment.Pane>
        <Allotment.Pane minSize={260}>
          <ParamPane />
        </Allotment.Pane>
        <Allotment.Pane minSize={240} preferredSize={360}>
          <ResultPane />
        </Allotment.Pane>
      </Allotment>
    </div>
  );
}

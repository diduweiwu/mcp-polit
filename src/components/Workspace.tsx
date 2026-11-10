/**
 * 四栏工作台布局：资源树 | 工具列表 | 参数 | 结果（可拖拽调整宽度）。
 * 资源树栏可整体折叠/展开。
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
  const allotmentRef = useRef<AllotmentHandle>(null);
  const treeCollapsed = useAppStore((s) => s.treeCollapsed);

  /* 折叠状态联动到第一栏的可见性 */
  useEffect(() => {
    allotmentRef.current?.setVisible(0, !treeCollapsed);
  }, [treeCollapsed]);

  return (
    <div className="min-h-0 flex-1">
      <Allotment ref={allotmentRef} vertical={false} defaultSizes={[240, 250, 380, 360]}>
        <Allotment.Pane minSize={190} maxSize={480}>
          <TreePane />
        </Allotment.Pane>
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

/**
 * 四栏工作台布局：资源树 | 工具列表 | 参数 | 结果（可拖拽调整宽度）。
 */
import { Allotment } from "allotment";
import { TreePane } from "./TreePane";
import { ToolPane } from "./ToolPane";
import { ParamPane } from "./ParamPane";
import { ResultPane } from "./ResultPane";

/** 工作台主体 */
export function Workspace() {
  return (
    <div className="min-h-0 flex-1">
      <Allotment vertical={false} defaultSizes={[240, 250, 380, 360]}>
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

/**
 * 四栏工作台布局：资源树 | 工具列表 | 参数 | 结果（可拖拽调整宽度）。
 * 资源树 / 工具列表 / 参数三栏均可折叠：折叠后在原槽位保留一条竖向占位条
 * （不完全消失，占位条自身即展开开关），替代原先散落在相邻栏头的展开按钮；
 * 支持一键均分（占位条宽度固定，不参与均分）。
 */
import { useEffect, useRef } from "react";
import { Allotment, type AllotmentHandle } from "allotment";
import { PanelLeftOpen } from "lucide-react";
import { useAppStore } from "../store";
import { TreePane } from "./TreePane";
import { ToolPane } from "./ToolPane";
import { ParamPane } from "./ParamPane";
import { ResultPane } from "./ResultPane";

/** 折叠栏占位条的固定宽度（px，窄竖条：图标 + 竖排栏名） */
const STRIP_SIZE = 24;

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
  const equalizeFromExpand = useAppStore((s) => s.equalizeFromExpand);
  const allotmentRef = useRef<AllotmentHandle>(null);
  /** 分栏容器引用（resize 入参是像素值，等分需按容器宽换算每栏目标宽） */
  const wrapRef = useRef<HTMLDivElement>(null);
  /** 上次消费过的均分信号（防同一信号被重复处理） */
  const prevSignalRef = useRef(0);

  /** 按槽位顺序（树/工具/参数/结果）生成宽度值：折叠槽为占位条固定宽，展开槽为偏好宽度 */
  const slotSizes = [
    treeCollapsed ? STRIP_SIZE : PANE_PREFERRED.tree,
    toolsCollapsed ? STRIP_SIZE : PANE_PREFERRED.tools,
    paramsCollapsed ? STRIP_SIZE : PANE_PREFERRED.params,
    PANE_PREFERRED.result,
  ];

  /** 分栏挂载初始宽度：均分伴随展开时新分栏直接按等宽挂载（key 重建后新实例上
      调 resize 会在尺寸测量落地前被忽略，故用挂载值代替），其余按各栏偏好 */
  const mountSizes = equalizeFromExpand ? slotSizes.map(() => 1) : slotSizes;

  /* 一键均分（无展开的常规场景）：⚠ Allotment 的 resize 入参是像素值而非权重
     （传 1 会被各栏 minSize 钳制后按比例重排，永远不等分），按容器宽换算等分
     目标宽后全栏传同一值——钳制不绑定时精确等分，绑定时尽力接近。
     伴随展开的场景由挂载值等分，这里只消费标记，不在刚重建的实例上调 resize */
  useEffect(() => {
    if (equalizeSignal === 0) return;
    const fresh = prevSignalRef.current !== equalizeSignal;
    prevSignalRef.current = equalizeSignal;
    if (!fresh) return;
    if (equalizeFromExpand) {
      useAppStore.setState({ equalizeFromExpand: false });
      return;
    }
    const target = Math.floor((wrapRef.current?.clientWidth ?? 0) / slotSizes.length);
    allotmentRef.current?.resize(slotSizes.map(() => target));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equalizeSignal, equalizeFromExpand, treeCollapsed, toolsCollapsed, paramsCollapsed]);

  return (
    <div className="min-h-0 flex-1" ref={wrapRef}>
      {/* key 随折叠组合变化，切换时重建分栏并应用对应比例 */}
      <Allotment
        key={`${treeCollapsed}-${toolsCollapsed}-${paramsCollapsed}`}
        ref={allotmentRef}
        vertical={false}
        defaultSizes={mountSizes}
      >
        {treeCollapsed ? (
          <Allotment.Pane minSize={STRIP_SIZE} maxSize={STRIP_SIZE}>
            <CollapsedStrip
              title="资源树"
              onExpand={() => useAppStore.getState().toggleTreeCollapsed()}
            />
          </Allotment.Pane>
        ) : (
          <Allotment.Pane minSize={190} maxSize={480}>
            <TreePane />
          </Allotment.Pane>
        )}
        {toolsCollapsed ? (
          <Allotment.Pane minSize={STRIP_SIZE} maxSize={STRIP_SIZE}>
            <CollapsedStrip
              title="工具列表"
              onExpand={() => useAppStore.getState().toggleToolsCollapsed()}
            />
          </Allotment.Pane>
        ) : (
          <Allotment.Pane minSize={190} preferredSize={250}>
            <ToolPane />
          </Allotment.Pane>
        )}
        {paramsCollapsed ? (
          <Allotment.Pane minSize={STRIP_SIZE} maxSize={STRIP_SIZE}>
            <CollapsedStrip
              title="参数"
              onExpand={() => useAppStore.getState().toggleParamsCollapsed()}
            />
          </Allotment.Pane>
        ) : (
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

/**
 * 折叠栏占位条：栏折叠后在原槽位保留的窄竖条，自身即展开开关。
 * 顶部展开图标 + 竖排栏名标识归属，整条可点击恢复展开（键盘可聚焦触发）。
 *
 * 使用示例：
 * ```tsx
 * <CollapsedStrip title="资源树" onExpand={() => toggleTreeCollapsed()} />
 * ```
 */
function CollapsedStrip({ title, onExpand }: { title: string; onExpand: () => void }) {
  return (
    <button
      className="flex h-full w-full flex-col items-center gap-2 border-r border-line bg-panel/50 pt-2 text-inksoft transition-colors hover:bg-panel hover:text-ink"
      aria-label={`展开${title}`}
      onClick={onExpand}
    >
      <PanelLeftOpen size={13} className="shrink-0" />
      <span className="text-[11px] leading-none tracking-widest [writing-mode:vertical-rl]">{title}</span>
    </button>
  );
}

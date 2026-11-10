/**
 * 四栏工作台布局：资源树 | 工具列表 | 参数 | 结果（可拖拽调整宽度）。
 * 资源树栏折叠/展开带宽度过渡动画（rAF 插值调用 allotment.resizeViews）。
 */
import { useEffect, useRef } from "react";
import { Allotment, type AllotmentHandle } from "allotment";
import { useAppStore } from "../store";
import { TreePane } from "./TreePane";
import { ToolPane } from "./ToolPane";
import { ParamPane } from "./ParamPane";
import { ResultPane } from "./ResultPane";

/** 资源树默认宽度（逻辑像素） */
const TREE_DEFAULT = 240;
/** 动画时长 */
const ANIM_MS = 260;
/** resizeViews 传入值总和（任意常数；allotment 按传入比例映射到容器实际宽度） */
const SUM = TREE_DEFAULT + 250 + 380 + 360;

/** 工作台主体 */
export function Workspace() {
  const treeCollapsed = useAppStore((s) => s.treeCollapsed);
  const containerRef = useRef<HTMLDivElement>(null);
  const allotmentRef = useRef<AllotmentHandle>(null);
  const rafRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    /* 首次挂载不播动画（保持 defaultSizes 初始布局） */
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    const handle = allotmentRef.current;
    const containerW = containerRef.current?.clientWidth ?? 0;
    if (!handle || !containerW) return;

    cancelAnimationFrame(rafRef.current);
    const from = treeCollapsed ? TREE_DEFAULT : 0;
    const to = treeCollapsed ? 0 : TREE_DEFAULT;
    /* allotment.resizeViews 内部按「传入值占传入总和的比例」分配容器宽度，
       因此传入值需按 SUM/容器宽度 换算，才能得到目标像素宽度 */
    const k = SUM / containerW;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ANIM_MS);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      const w = (from + (to - from) * eased) * k;
      handle.resize([w, 250, 380, 360]);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [treeCollapsed]);

  return (
    <div ref={containerRef} className="min-h-0 flex-1">
      <Allotment ref={allotmentRef} vertical={false} defaultSizes={[240, 250, 380, 360]}>
        {/* 折叠时 minSize 放开为 0，动画才能收拢到底；展开态限制最小宽度 */}
        <Allotment.Pane minSize={treeCollapsed ? 0 : 150} maxSize={480}>
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

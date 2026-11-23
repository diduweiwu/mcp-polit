/**
 * 同步目录数据冲突选择弹窗。
 *
 * 新建/编辑项目绑定的目录是「已有数据的 MCPilot 同步仓库」（含 tree.json）时，
 * 项目数据与仓库数据都可能有价值，由用户选择如何处理，四个方向：
 * - 合并（推荐，两边都保留）：两边独有的都保留，重名条目按偏向取 Git 或项目配置；
 * - 覆盖：以单边为准，另一边数据被清空。
 * 取消则回到表单不做绑定。数据方向判定由后端 sync_dir_status 检测 + resolve
 * 参数执行，本组件只负责选择。
 *
 * 文案原则（用户反馈「说明太绕」后定稿）：组标题说明共同后果，选项标题即结论，
 * 描述只讲该选项与其他选项的差异，一句话说完。
 */
import { Database, GitBranch, GitMerge, Layers } from "lucide-react";
import { Modal } from "./ui";
import type { SyncDirResolve } from "../types";

/** 冲突选择弹窗属性 */
interface SyncDirConflictDialogProps {
  /** 冲突的同步目录路径（表单里填写的原始路径） */
  dir: string;
  /** 用户选定数据方向 */
  onResolve: (resolve: SyncDirResolve) => void;
  /** 取消（回到表单，不绑定该目录） */
  onCancel: () => void;
}

/**
 * 同步目录数据冲突选择弹窗。
 *
 * 使用示例：
 * ```tsx
 * const [conflict, setConflict] = useState<string | null>(null);
 * // onResolve 里先 setConflict(null)，再带上 resolve 结果重新提交表单
 * <SyncDirConflictDialog
 *   dir={conflict ?? ""}
 *   onResolve={handleResolve}
 *   onCancel={() => setConflict(null)}
 * />
 * ```
 */
export function SyncDirConflictDialog({ dir, onResolve, onCancel }: SyncDirConflictDialogProps) {
  return (
    <Modal
      open
      title="同步目录已有数据"
      onClose={onCancel}
      width={520}
      footer={
        <button className="btn-ghost" onClick={onCancel}>
          取消
        </button>
      }
    >
      <p className="mb-1 text-[13px] leading-relaxed text-inksoft">
        目录里已有数据，请选择如何处理：
      </p>
      <div className="mb-3 truncate rounded-md border border-line bg-panel2/50 px-3 py-1.5 font-mono text-[12px]" title={dir}>
        {dir}
      </div>

      {/* 合并组（推荐）：两边独有的都保留，只有重名条目需要取舍 */}
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink">
        合并（两边都保留）
        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primarystrong">推荐</span>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <button
          className="w-full rounded-md border border-primary/40 px-3 py-2.5 text-left transition-colors hover:border-primary/60 hover:bg-panel2"
          onClick={() => onResolve("merge_git")}
        >
          <div className="flex items-center gap-1.5 text-[13px] font-medium">
            <GitMerge size={14} className="text-primarystrong" />
            同名用 Git
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-inksoft">
            两边独有的都保留；重名的采用 Git 里的配置。
          </p>
        </button>
        <button
          className="w-full rounded-md border border-primary/40 px-3 py-2.5 text-left transition-colors hover:border-primary/60 hover:bg-panel2"
          onClick={() => onResolve("merge_project")}
        >
          <div className="flex items-center gap-1.5 text-[13px] font-medium">
            <Layers size={14} className="text-primarystrong" />
            同名用项目
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-inksoft">
            两边独有的都保留；重名的保留项目里的配置。
          </p>
        </button>
      </div>

      {/* 覆盖组：单边为准，另一边数据被清空 */}
      <div className="mb-1.5 text-[12px] font-medium text-ink">覆盖（一边将被清空）</div>
      <div className="grid grid-cols-2 gap-2">
        <button
          className="w-full rounded-md border border-line px-3 py-2.5 text-left transition-colors hover:border-primary/50 hover:bg-panel2"
          onClick={() => onResolve("git")}
        >
          <div className="flex items-center gap-1.5 text-[13px] font-medium">
            <GitBranch size={14} className="text-primarystrong" />
            清空项目，用 Git
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-inksoft">
            项目现有配置全部丢弃，完全使用 Git 目录里的数据。
          </p>
        </button>
        <button
          className="w-full rounded-md border border-line px-3 py-2.5 text-left transition-colors hover:border-primary/50 hover:bg-panel2"
          onClick={() => onResolve("project")}
        >
          <div className="flex items-center gap-1.5 text-[13px] font-medium">
            <Database size={14} className="text-primarystrong" />
            清空目录，用项目
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-inksoft">
            目录现有内容全部删除，完全使用项目当前的数据。
          </p>
        </button>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-inksoft">
        合并不丢数据；覆盖不可撤销，需保留请先取消备份。
      </p>
    </Modal>
  );
}

/**
 * 同步目录字段：手动输入框 + 「选择目录」按钮。
 *
 * 供新建项目 / 编辑项目 / 管理项目弹窗复用：输入框保留手动输入路径的能力
 * （支持 ~/ 开头的写法），按钮调起系统目录选择器，选中后自动填入输入框。
 * 不要求所选目录是 git 仓库——绑定后端会校验/创建并自动 git init；
 * 目录必须为空（忽略 .git/.DS_Store 残留），非空目录后端会拒绝绑定。
 */
import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { GrowTextarea } from "./ui";
import { pickDirectory } from "../api";

/** 同步目录字段属性 */
interface SyncDirFieldProps {
  /** 当前目录路径（受控值） */
  value: string;
  /** 路径变化回调（手动输入与选择目录后都会触发） */
  onChange: (value: string) => void;
  /** 输入框内按 Enter 的回调（可选，编辑表单用于提交保存） */
  onEnter?: () => void;
  /** 是否自动聚焦输入框（可选） */
  autoFocus?: boolean;
}

/**
 * 同步目录字段（输入框 + 选择目录按钮）。
 *
 * 使用示例：
 * ```tsx
 * const [dir, setDir] = useState("");
 * <SyncDirField value={dir} onChange={setDir} />
 * ```
 */
export function SyncDirField({ value, onChange, onEnter, autoFocus }: SyncDirFieldProps) {
  /** 系统目录选择器调起中标记（防重复调起 + 按钮禁用态） */
  const [picking, setPicking] = useState(false);

  /** 调起系统目录选择器；确认后把所选路径填入输入框，取消则不变 */
  const pick = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const dir = await pickDirectory("选择同步目录");
      if (dir) onChange(dir);
    } catch (e) {
      // 选择器调起失败（权限被拒等）：记入控制台，不打断手动输入流程
      console.error("打开目录选择器失败", e);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <GrowTextarea
        className="field min-w-0 flex-1 font-mono"
        placeholder="~/mcpilot-sync/backend 或本地目录路径"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // 路径不会需要换行：回车保持「提交」语义，不插入换行
          if (onEnter && e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      <button
        className="btn-ghost h-8 shrink-0 gap-1.5 !px-2.5 text-[12px]"
        title="从文件系统选择目录（不要求是 git 仓库）"
        disabled={picking}
        onClick={() => void pick()}
      >
        <FolderOpen size={14} />
        {picking ? "选择中…" : "选择目录"}
      </button>
    </div>
  );
}

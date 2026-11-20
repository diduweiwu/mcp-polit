/**
 * 管理项目弹窗：集中管理全部项目——重命名、配置同步目录、删除。
 *
 * 取代原「项目下拉 → 编辑当前项目 / 删除当前项目」的分散入口：
 * 列表展示全部项目（当前项目带「当前」徽标），单行内联展开编辑表单
 * （名称 + 同步目录，同步目录可直接从文件系统挑选），删除走二次确认。
 * 保存复用 store 既有 actions（renameProject / updateProjectSyncDir /
 * deleteProject），数据流与原编辑弹窗完全一致。
 */
import { useState } from "react";
import { Check, Pencil, Trash2 } from "lucide-react";
import { useAppStore } from "../store";
import type { Project } from "../types";
import { ConfirmDialog, Modal } from "./ui";
import { SyncDirField } from "./SyncDirField";

/** 管理项目弹窗属性 */
interface ProjectManageModalProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
}

/**
 * 管理项目弹窗。
 *
 * 使用示例：
 * ```tsx
 * const [open, setOpen] = useState(false);
 * <ProjectManageModal open={open} onClose={() => setOpen(false)} />
 * ```
 */
export function ProjectManageModal({ open, onClose }: ProjectManageModalProps) {
  const {
    projects,
    activeProjectId,
    renameProject,
    updateProjectSyncDir,
    deleteProject,
  } = useAppStore();

  /** 正在内联编辑的项目 ID（同一时间最多一个；null 表示无编辑行） */
  const [editingId, setEditingId] = useState<number | null>(null);
  /** 编辑表单：项目名称 */
  const [editName, setEditName] = useState("");
  /** 编辑表单：同步目录 */
  const [editSyncDir, setEditSyncDir] = useState("");
  /** 编辑表单：校验/保存失败的错误信息（展示在表单内） */
  const [editError, setEditError] = useState("");
  /** 待删除的项目（非 null 时显示删除确认框） */
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);

  /** 进入某项目的内联编辑：带入该项目当前的基础信息 */
  const startEdit = (p: Project) => {
    setEditingId(p.id);
    setEditName(p.name);
    setEditSyncDir(p.sync_dir ?? "");
    setEditError("");
  };

  /** 取消内联编辑：收起表单并清空错误 */
  const cancelEdit = () => {
    setEditingId(null);
    setEditError("");
  };

  /**
   * 提交内联编辑：名称与同步目录分别按需保存（无变化的字段不发起请求）。
   * 成功后收起表单；失败把错误信息留在表单内，不收起。
   */
  const submitEdit = async () => {
    const target = projects.find((p) => p.id === editingId);
    if (!target) {
      cancelEdit();
      return;
    }
    setEditError("");
    const name = editName.trim();
    const dir = editSyncDir.trim();
    if (!name) {
      setEditError("请填写项目名称");
      return;
    }
    try {
      if (name !== target.name) await renameProject(target.id, name);
      if (dir !== (target.sync_dir ?? "")) {
        // 空串传 null：解除绑定（Git 同步条随之隐藏）
        await updateProjectSyncDir(target.id, dir || null);
      }
      setEditingId(null);
    } catch (e) {
      setEditError(String(e));
    }
  };

  /** 确认删除（二次确认回调）；删除激活项目时 store 会自动切换到剩余第一个项目 */
  const confirmDelete = () => {
    if (deleteTarget) void deleteProject(deleteTarget.id);
    setDeleteTarget(null);
  };

  return (
    <>
      <Modal
        open={open}
        title="管理项目"
        onClose={onClose}
        width={560}
        /* 删除确认框打开期间禁用本弹窗的 Esc 关闭：按 Esc 只关最上层的确认框 */
        escClose={deleteTarget == null}
      >
        {projects.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-inksoft">
            还没有项目。点击左上角「新建项目」开始使用。
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {projects.map((p) => {
              /* 当前行进入内联编辑：整行替换为编辑表单 */
              if (p.id === editingId) {
                return (
                  <div
                    key={p.id}
                    className="rounded-md border border-primary/40 bg-panel2/50 px-3 py-2.5"
                  >
                    <label className="label">
                      项目名称
                      <span className="ml-0.5 text-err" title="必填">*</span>
                    </label>
                    <input
                      className="field"
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void submitEdit()}
                    />
                    <div className="mt-2">
                      <label className="label">同步目录（可选，开启 Git 同步）</label>
                      <SyncDirField
                        value={editSyncDir}
                        onChange={setEditSyncDir}
                        onEnter={() => void submitEdit()}
                      />
                      <p className="mt-1.5 text-[12px] leading-relaxed text-inksoft">
                        目录必须是<b>空目录</b>（不存在会自动创建，非 git 目录会自动
                        <span className="font-mono"> git init</span>）；保存后当前项目的数据会自动迁移进去并创建初始提交。清空此字段并保存即解除绑定（原有仓库内容不受影响）。
                      </p>
                    </div>
                    {editError && (
                      <div className="mt-2 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-[12px] text-err">
                        {editError}
                      </div>
                    )}
                    <div className="mt-2.5 flex justify-end gap-2">
                      <button className="btn-ghost" onClick={cancelEdit}>
                        取消
                      </button>
                      <button className="btn-primary" onClick={() => void submitEdit()}>
                        保存
                      </button>
                    </div>
                  </div>
                );
              }
              /* 普通行：状态点 + 名称 + 当前徽标 + 同步目录 + 编辑/删除操作 */
              const isActive = p.id === activeProjectId;
              return (
                <div
                  key={p.id}
                  className="group flex items-center gap-2.5 rounded-md border border-line px-3 py-2 transition-colors hover:bg-panel2"
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: isActive ? "var(--c-ok)" : "var(--c-ink-soft)" }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{p.name}</span>
                      {isActive && (
                        <span className="flex shrink-0 items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primarystrong">
                          <Check size={10} />
                          当前
                        </span>
                      )}
                    </div>
                    <div
                      className="truncate font-mono text-[11px] text-inksoft"
                      title={p.sync_dir ?? undefined}
                    >
                      {p.sync_dir || "未绑定同步目录"}
                    </div>
                  </div>
                  <button
                    className="btn-ghost h-7 shrink-0 !px-2"
                    title="编辑项目信息（名称 / 同步目录）"
                    onClick={() => startEdit(p)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="btn-ghost h-7 shrink-0 !px-2 text-err hover:bg-err/10"
                    title="删除项目（其下目录与 Server 配置一并删除）"
                    onClick={() => setDeleteTarget(p)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

      </Modal>

      {/* 删除二次确认：嵌套弹窗，打开时外层 Esc 已禁用 */}
      <ConfirmDialog
        open={deleteTarget != null}
        title="删除项目"
        message={`确定删除项目「${deleteTarget?.name}」吗？其下全部目录、Server 配置将被一并删除，且不可恢复。`}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </>
  );
}

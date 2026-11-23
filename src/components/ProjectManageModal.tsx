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
import { syncDirStatus } from "../api";
import type { Project, SyncDirResolve } from "../types";
import { ConfirmDialog, Modal } from "./ui";
import { SyncDirField } from "./SyncDirField";
import { SyncDirConflictDialog } from "./SyncDirConflictDialog";

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
  /** 保存提交中标记：防双击重复提交（重命名/绑定目录请求重复发起） */
  const [saving, setSaving] = useState(false);
  /** 待删除的项目（非 null 时显示删除确认框） */
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  /**
   * 同步目录数据冲突：编辑中的目录是已有数据的 MCPilot 同步仓库，等待用户选择
   * 数据方向。非 null 时弹冲突选择弹窗（编辑表单保持打开，Esc 关闭临时让位）。
   */
  const [editConflict, setEditConflict] = useState<string | null>(null);

  /** 进入某项目的内联编辑：带入该项目当前的基础信息 */
  const startEdit = (p: Project) => {
    setEditingId(p.id);
    setEditName(p.name);
    setEditSyncDir(p.sync_dir ?? "");
    setEditError("");
    setEditConflict(null);
  };

  /** 取消内联编辑：收起表单并清空错误与冲突状态 */
  const cancelEdit = () => {
    setEditingId(null);
    setEditError("");
    setEditConflict(null);
  };

  /**
   * 提交内联编辑：名称与同步目录分别按需保存（无变化的字段不发起请求）。
   *
   * 新目录绑定前先检测目录状态（sync_dir_status）：有内容且不是 MCPilot 同步
   * 仓库直接拦截；是同步仓库则暂缓保存，弹冲突选择弹窗，用户选定数据方向后
   * 带 resolve 重新走本函数完成保存。
   * 成功后收起表单；失败把错误信息留在表单内，不收起。
   */
  const submitEdit = async (resolve?: SyncDirResolve) => {
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
    if (saving) return;
    setSaving(true);
    try {
      if (name !== target.name) await renameProject(target.id, name);
      if (dir !== (target.sync_dir ?? "")) {
        if (dir && resolve === undefined) {
          const st = await syncDirStatus(dir);
          if (st.has_content && !st.is_repo) {
            setEditError(`目录已有内容且不是 MCPilot 同步仓库，无法绑定：${dir}`);
            return;
          }
          if (st.has_content && st.is_repo) {
            setEditConflict(dir);
            return;
          }
        }
        // 空串传 null：解除绑定（Git 同步条随之隐藏）
        await updateProjectSyncDir(target.id, dir || null, resolve);
      }
      setEditingId(null);
    } catch (e) {
      setEditError(String(e));
    } finally {
      setSaving(false);
    }
  };

  /** 冲突选择回调：记录数据方向后回到编辑流程完成保存 */
  const resolveEditConflict = (resolve: SyncDirResolve) => {
    setEditConflict(null);
    void submitEdit(resolve);
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
        /* 删除确认框 / 目录冲突弹窗打开期间禁用本弹窗的 Esc 关闭：按 Esc 只关最上层 */
        escClose={deleteTarget == null && editConflict == null}
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
                        <span className="font-mono"> git init</span>）；已有数据的 MCPilot
                        同步仓库可接管，保存时会让你选择以哪边数据为准。保存后当前项目的数据会按所选方向处理并创建初始提交。清空此字段并保存即解除绑定（原有仓库内容不受影响）。
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
                      <button className="btn-primary" disabled={saving} onClick={() => void submitEdit()}>
                        {saving ? "保存中…" : "保存"}
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

      {/* 编辑表单：同步目录数据冲突选择（选定后带 resolve 回到 submitEdit 完成保存） */}
      {editConflict != null && (
        <SyncDirConflictDialog
          dir={editConflict}
          onResolve={resolveEditConflict}
          onCancel={() => setEditConflict(null)}
        />
      )}

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

/**
 * 项目级环境管理弹窗：环境的增删 / 重命名与每套环境的变量编辑（草稿式，保存一次性落盘）。
 *
 * 环境变量集中在这里定义与修改；Server 配置表单不编辑环境值，只在值里以
 * {{变量名}} 引用（连接时按顶栏切换的全局环境插值替换）——Server 编辑与环境
 * 变量编辑完全解耦，互不影响。
 */
import { useEffect, useState } from "react";
import { Check, Info, Pencil, Plus, X } from "lucide-react";
import { activeEnvName, useAppStore } from "../store";
import { ConfirmDialog, Modal } from "./ui";
import { KVEditor } from "./KVEditor";

/** 环境草稿（编辑期形态；id / 排序由后端整批保存时生成，环境名即身份） */
interface EnvDraft {
  /** 环境名（同项目内唯一） */
  name: string;
  /** 变量集：JSON 对象字符串 */
  variables: string;
}

/** 环境管理弹窗属性 */
interface Props {
  /** 是否打开（关闭时丢弃未保存草稿） */
  open: boolean;
  onClose: () => void;
}

/** 项目级环境管理弹窗 */
export function EnvironmentManageModal({ open, onClose }: Props) {
  const environments = useAppStore((s) => s.environments);
  const saveEnvironments = useAppStore((s) => s.saveEnvironments);
  const switchActiveEnv = useAppStore((s) => s.switchActiveEnv);
  /** 当前全局激活的环境名（保存时若它被删除/改名，自动回到「不使用环境」） */
  const currentActive = useAppStore((s) => activeEnvName(s));

  /** 草稿：打开时从 store 初始化，改动即写草稿，保存时一次性落盘 */
  const [draft, setDraft] = useState<EnvDraft[]>([]);
  /** 当前选中的环境（下标；进入选择态/新建后自动切到新环境） */
  const [selected, setSelected] = useState(0);
  /** 新建环境的 inline 输入态 */
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  /** 选中环境的重命名 inline 输入态 */
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  /** 待删除的环境名（非 null 时显示删除确认框） */
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  /* 打开时初始化草稿（保存后 store 更新也会同步进来，表现为草稿与落库值一致） */
  useEffect(() => {
    if (!open) return;
    setDraft(environments.map((e) => ({ name: e.name, variables: e.variables })));
    setSelected(0);
    setError("");
    setCreating(false);
    setRenaming(false);
    setDeleteTarget(null);
  }, [open, environments]);

  /** 新建环境名是否与草稿中已有环境重名（实时拦截） */
  const newConflict =
    creating && draft.some((e) => e.name === newName.trim());
  /** 重命名是否与其它环境重名（排除自身） */
  const renameConflict =
    renaming &&
    draft.some((e, i) => i !== selected && e.name === renameValue.trim());

  /** 新建环境（空白起步；重名/空名不通过） */
  const createEnv = () => {
    const name = newName.trim();
    if (!name || newConflict) return;
    setDraft((d) => [...d, { name, variables: "" }]);
    setSelected(draft.length);
    setCreating(false);
    setNewName("");
  };

  /** 提交重命名（环境名即引用身份，改名后引用旧名的配置会失效——提交时写日志提醒） */
  const commitRename = () => {
    const name = renameValue.trim();
    if (!name || renameConflict) return;
    const oldName = draft[selected]?.name ?? "";
    setDraft((d) => d.map((e, i) => (i === selected ? { ...e, name } : e)));
    setRenaming(false);
    if (oldName !== name) {
      useAppStore
        .getState()
        .addLog(
          "info",
          `环境「${oldName}」已改名为「${name}」（未保存）：引用 {{${oldName}}} 的 Server 配置保存后需改为 {{${name}}}，激活环境也会切换到新名`,
        );
    }
  };

  /** 确认删除选中环境（引用它的配置在连接时会报「未定义变量」，弹窗里已提示） */
  const confirmDelete = () => {
    if (deleteTarget == null) return;
    const idx = draft.findIndex((e) => e.name === deleteTarget);
    setDraft((d) => d.filter((e) => e.name !== deleteTarget));
    setSelected((s) => Math.max(0, Math.min(s >= idx ? s - 1 : s, draft.length - 2)));
    setDeleteTarget(null);
  };

  /** 保存：整批落盘；被删除/改名的激活环境自动回到「不使用环境」 */
  const submit = async () => {
    setError("");
    if (draft.some((e) => !e.name.trim())) {
      setError("环境名不能为空");
      return;
    }
    const names = draft.map((e) => e.name.trim());
    if (new Set(names).size !== names.length) {
      setError("环境名重复，请修改后再保存");
      return;
    }
    setSaving(true);
    try {
      await saveEnvironments(draft.map((e) => ({ name: e.name.trim(), variables: e.variables })));
      // 激活环境跟随处理：被删除 -> 回到「不使用环境」；被改名 -> 跟随新名（按旧列表同名位置判断）
      if (currentActive && !names.includes(currentActive)) {
        const idx = environments.findIndex((e) => e.name === currentActive);
        const renamed = idx >= 0 ? names[idx] : null;
        await switchActiveEnv(renamed ?? "");
      }
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const cur = draft[selected];

  return (
    <>
      <Modal
        open={open}
        title="环境变量管理"
        onClose={onClose}
        width={620}
        footer={
          <>
            <button className="btn-ghost" onClick={onClose}>
              取消
            </button>
            <button className="btn-primary" disabled={saving} onClick={() => void submit()}>
              {saving ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          {/* 使用说明 */}
          <div className="flex items-start gap-1.5 rounded-md bg-panel2 p-2.5 text-[12px] leading-relaxed text-inksoft">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              环境变量集中在这里定义与修改；Server 配置的值中以
              <span className="mx-0.5 font-mono text-primarystrong">{"{{变量名}}"}</span>
              引用（如 <span className="font-mono">Bearer {"{{TOKEN}}"}</span>
              ），连接时按顶栏切换的当前环境替换。编辑 Server 不会改动这里。
            </span>
          </div>

          {/* 环境 chips + 新建 */}
          <div className="flex flex-wrap items-center gap-1.5">
            {draft.map((e, i) => (
              <span key={e.name || i} className="relative">
                <button
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] transition-colors ${
                    i === selected
                      ? "border-primary bg-primarysoft text-primarystrong"
                      : "border-line text-ink hover:bg-panel2"
                  }`}
                  onClick={() => {
                    setSelected(i);
                    setRenaming(false);
                  }}
                >
                  {e.name}
                  {e.name && currentActive === e.name && (
                    <span className="h-2 w-2 rounded-full bg-ok" title="当前激活环境" />
                  )}
                </button>
                {/* 删除角标 */}
                <button
                  className="absolute -right-1 -top-1.5 rounded-full bg-panel text-inksoft/60 shadow-sm transition-colors hover:text-err"
                  title={`删除环境「${e.name}」`}
                  onClick={() => setDeleteTarget(e.name)}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            {creating ? (
              <span className="flex items-center gap-1">
                <input
                  className="field !py-0.5"
                  style={{ width: 110 }}
                  autoFocus
                  placeholder="环境名，如 dev"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createEnv()}
                />
                <button
                  className="btn-ghost h-6 !px-1.5 text-[11px]"
                  disabled={!newName.trim() || newConflict}
                  onClick={createEnv}
                >
                  <Check size={12} />
                </button>
                <button
                  className="btn-ghost h-6 !px-1.5 text-[11px]"
                  onClick={() => {
                    setCreating(false);
                    setNewName("");
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            ) : (
              <button
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-inksoft hover:bg-panel2 hover:text-ink"
                onClick={() => {
                  setCreating(true);
                  setNewName("");
                  setRenaming(false);
                }}
              >
                <Plus size={12} /> 新建环境
              </button>
            )}
            {newConflict && (
              <span className="text-[11px] text-err">已存在同名环境</span>
            )}
            {/* 选中环境的重命名入口 */}
            {cur && !creating && !renaming && (
              <button
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-inksoft hover:bg-panel2 hover:text-ink"
                title={`重命名环境「${cur.name}」`}
                onClick={() => {
                  setRenaming(true);
                  setRenameValue(cur.name);
                }}
              >
                <Pencil size={11} /> 重命名
              </button>
            )}
            {renaming && cur && (
              <span className="flex items-center gap-1">
                <input
                  className="field !py-0.5"
                  style={{ width: 110 }}
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && commitRename()}
                />
                <button
                  className="btn-ghost h-6 !px-1.5 text-[11px]"
                  disabled={!renameValue.trim() || renameConflict}
                  onClick={commitRename}
                >
                  <Check size={12} />
                </button>
                <button
                  className="btn-ghost h-6 !px-1.5 text-[11px]"
                  onClick={() => setRenaming(false)}
                >
                  <X size={12} />
                </button>
                {renameConflict && (
                  <span className="text-[11px] text-err">与其他环境重名</span>
                )}
              </span>
            )}
          </div>

          {/* 选中环境的变量编辑 */}
          {cur ? (
            <KVEditor
              title={`环境「${cur.name}」的变量`}
              json={cur.variables}
              onChange={(v) =>
                setDraft((d) => d.map((e, i) => (i === selected ? { ...e, variables: v } : e)))
              }
              keyPlaceholder="变量名，如 TOKEN"
              valuePlaceholder="值，如 sk-xxxx"
            />
          ) : (
            <div className="rounded-md border border-dashed border-line px-3 py-6 text-center text-[12px] text-inksoft/70">
              还没有环境。点「新建环境」创建（如 dev / prod），再在 Server
              配置里用 <span className="font-mono">{"{{变量名}}"}</span> 引用。
            </div>
          )}

          {/* 错误反馈 */}
          {error && (
            <div className="rounded-md border border-err/30 bg-err/10 px-3 py-2 text-[12px] leading-relaxed text-err">
              {error}
            </div>
          )}

          {/* 底部提示 */}
          <p className="text-[11px] leading-relaxed text-inksoft/80">
            保存后对新连接生效：已建立的连接不会自动应用新变量，需重新连接。
            删除环境后，引用它的 Server 配置在连接时会提示「未定义的环境变量引用」。
          </p>
        </div>
      </Modal>

      {/* 删除环境二次确认 */}
      <ConfirmDialog
        open={deleteTarget != null}
        title="删除环境"
        message={`确定删除环境「${deleteTarget}」吗？该环境下的全部变量将被删除（保存后生效），引用这些变量的 Server 配置在连接时会报「未定义的环境变量引用」。`}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </>
  );
}

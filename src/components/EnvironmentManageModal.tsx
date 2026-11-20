/**
 * 项目级环境管理弹窗（Apifox / Postman 式布局）：
 *
 * - 左栏：环境列表（点击选中、hover 出重命名/删除、底部「+ 新建环境」内联输入，
 *   当前激活环境带绿点标识）；
 * - 右栏：当前环境的变量表格（KVEditor）+ 精简说明。
 *
 * 环境变量集中在这里定义与修改；Server 配置表单不编辑环境值，只在值里以
 * {{变量名}} 引用（连接时按顶栏切换的全局环境插值替换）——Server 编辑与
 * 环境变量编辑完全解耦，互不影响。
 */
import { useEffect, useState } from "react";
import { Check, Pencil, Plus, X } from "lucide-react";
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
  /** 当前全局激活的环境名（保存时若它被删除/改名，自动跟随或回到「不使用环境」） */
  const currentActive = useAppStore((s) => activeEnvName(s));

  /** 草稿：打开时从 store 初始化，改动即写草稿，保存时一次性落盘 */
  const [draft, setDraft] = useState<EnvDraft[]>([]);
  /** 当前选中的环境（下标；新建后自动切到新环境） */
  const [selected, setSelected] = useState(0);
  /** 重命名的环境下标（null = 无重命名输入态） */
  const [renamingIdx, setRenamingIdx] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  /** 新建环境的内联输入态（左栏底部） */
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
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
    setRenamingIdx(null);
    setDeleteTarget(null);
  }, [open, environments]);

  /** 新建环境名是否与草稿中已有环境重名（实时拦截） */
  const newConflict = creating && draft.some((e) => e.name === newName.trim());
  /** 重命名是否与其它环境重名（排除自身） */
  const renameConflict =
    renamingIdx != null &&
    draft.some((e, i) => i !== renamingIdx && e.name === renameValue.trim());

  /** 新建环境（空白起步；重名/空名不通过），成功后自动选中新环境 */
  const createEnv = () => {
    const name = newName.trim();
    if (!name || newConflict) return;
    setDraft((d) => [...d, { name, variables: "" }]);
    setSelected(draft.length);
    setCreating(false);
    setNewName("");
  };

  /** 进入重命名输入态（预填当前名） */
  const startRename = (idx: number) => {
    setRenamingIdx(idx);
    setRenameValue(draft[idx]?.name ?? "");
  };

  /** 提交重命名（环境名即引用身份，改名后引用旧名的配置需同步改——写日志提醒） */
  const commitRename = () => {
    const idx = renamingIdx;
    const name = renameValue.trim();
    if (idx == null || !name || renameConflict) return;
    const oldName = draft[idx]?.name ?? "";
    setDraft((d) => d.map((e, i) => (i === idx ? { ...e, name } : e)));
    setRenamingIdx(null);
    if (oldName !== name) {
      useAppStore
        .getState()
        .addLog(
          "info",
          `环境「${oldName}」已改名为「${name}」（未保存）：引用 {{${oldName}}} 的 Server 配置保存后需改为 {{${name}}}，激活环境也会切换到新名`,
        );
    }
  };

  /** 确认删除选中环境（引用它的配置在连接时会报「未定义变量」，确认框里已提示） */
  const confirmDelete = () => {
    if (deleteTarget == null) return;
    const idx = draft.findIndex((e) => e.name === deleteTarget);
    setDraft((d) => d.filter((e) => e.name !== deleteTarget));
    setSelected((s) => Math.max(0, s > idx ? s - 1 : Math.min(s, draft.length - 2)));
    if (renamingIdx === idx) setRenamingIdx(null);
    setDeleteTarget(null);
  };

  /** 保存：整批落盘；被删除/改名的激活环境自动跟随或回到「不使用环境」 */
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
        width={860}
        height={540}
        footer={
          <>
            <p className="mr-auto text-[11px] leading-relaxed text-inksoft/80">
              值中以 <span className="font-mono text-primarystrong">{"{{变量名}}"}</span>
              引用（连接时按顶栏切换的当前环境替换）；保存后对新连接生效，已建立的连接需重新连接。
            </p>
            <button className="btn-ghost" onClick={onClose}>
              取消
            </button>
            <button className="btn-primary" disabled={saving} onClick={() => void submit()}>
              {saving ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        <div className="flex h-full min-h-0 gap-3">
          {/* 左栏：环境列表 */}
          <div className="flex w-[210px] shrink-0 flex-col rounded-md bg-panel2 p-1.5">
            <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
              <span className="text-[11px] font-medium text-inksoft/70">环境</span>
              <span className="text-[11px] text-inksoft/50">{draft.length}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
              {draft.map((e, i) => {
                const active = i === selected;
                return (
                  <div key={`${e.name}-${i}`} className="group relative">
                    {renamingIdx === i ? (
                      /* 重命名内联输入 */
                      <span className="flex items-center gap-1 px-1 py-0.5">
                        <input
                          className="field !py-1 text-[12.5px]"
                          autoFocus
                          value={renameValue}
                          onChange={(ev) => setRenameValue(ev.target.value)}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter") commitRename();
                            if (ev.key === "Escape") setRenamingIdx(null);
                          }}
                        />
                        <button
                          className="shrink-0 rounded p-1 text-inksoft hover:bg-hover hover:text-ink disabled:opacity-40"
                          title="确认重命名"
                          disabled={!renameValue.trim() || renameConflict}
                          onClick={commitRename}
                        >
                          <Check size={13} />
                        </button>
                        {renameConflict && (
                          <span className="absolute -bottom-3.5 left-2 text-[10px] text-err">
                            与其他环境重名
                          </span>
                        )}
                      </span>
                    ) : (
                      <button
                        className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors ${
                          active
                            ? "bg-panel text-ink shadow-sm"
                            : "text-inksoft hover:bg-hover hover:text-ink"
                        }`}
                        title={e.name}
                        onClick={() => {
                          setSelected(i);
                          setRenamingIdx(null);
                        }}
                      >
                        {/* 激活标识放名称左侧：不会被 hover 出现的操作图标遮挡 */}
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            currentActive === e.name ? "bg-ok" : "bg-transparent"
                          }`}
                          title={currentActive === e.name ? "当前激活环境（连接时使用）" : undefined}
                        />
                        <span className="min-w-0 flex-1 truncate">{e.name}</span>
                      </button>
                    )}
                    {/* 重命名 / 删除：hover 出现，选中项常显（可发现性） */}
                    {renamingIdx !== i && (
                      <span
                        className={`absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded bg-panel px-0.5 transition-opacity ${
                          active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                        }`}
                      >
                        <button
                          className="rounded p-1 text-inksoft hover:bg-hover hover:text-ink"
                          title={`重命名「${e.name}」`}
                          onClick={() => startRename(i)}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          className="rounded p-1 text-inksoft hover:bg-err/10 hover:text-err"
                          title={`删除环境「${e.name}」`}
                          onClick={() => setDeleteTarget(e.name)}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
              {draft.length === 0 && !creating && (
                <p className="px-2 py-3 text-[11.5px] leading-relaxed text-inksoft/70">
                  还没有环境，点击下方「新建环境」创建。
                </p>
              )}
            </div>
            {/* 底部新建环境：点击展开内联输入 */}
            <div className="shrink-0 border-t border-line pt-1.5">
              {creating ? (
                <span className="flex items-center gap-1 px-0.5">
                  <input
                    className="field !py-1 text-[12.5px]"
                    autoFocus
                    placeholder="环境名，如 dev"
                    value={newName}
                    onChange={(ev) => setNewName(ev.target.value)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") createEnv();
                      if (ev.key === "Escape") {
                        setCreating(false);
                        setNewName("");
                      }
                    }}
                  />
                  <button
                    className="shrink-0 rounded p-1 text-inksoft hover:bg-hover hover:text-ink disabled:opacity-40"
                    title="确认新建"
                    disabled={!newName.trim() || newConflict}
                    onClick={createEnv}
                  >
                    <Check size={13} />
                  </button>
                  <button
                    className="shrink-0 rounded p-1 text-inksoft hover:bg-hover hover:text-ink"
                    title="取消"
                    onClick={() => {
                      setCreating(false);
                      setNewName("");
                    }}
                  >
                    <X size={13} />
                  </button>
                </span>
              ) : (
                <button
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] text-inksoft transition-colors hover:bg-hover hover:text-ink"
                  onClick={() => {
                    setCreating(true);
                    setNewName("");
                    setRenamingIdx(null);
                  }}
                >
                  <Plus size={13} /> 新建环境
                </button>
              )}
              {newConflict && (
                <p className="px-2 pb-1 pt-0.5 text-[10.5px] text-err">已存在同名环境</p>
              )}
            </div>
          </div>

          {/* 右栏：当前环境的变量表格 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {cur ? (
              <>
                <div className="mb-2 flex shrink-0 items-center gap-2">
                  <span className="truncate text-[14px] font-semibold" title={cur.name}>
                    {cur.name}
                  </span>
                  {currentActive === cur.name && (
                    <span className="chip bg-ok/10 text-ok">当前激活</span>
                  )}
                  <span className="flex-1" />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
                  <KVEditor
                    title="变量"
                    json={cur.variables}
                    onChange={(v) =>
                      setDraft((d) => d.map((e, i) => (i === selected ? { ...e, variables: v } : e)))
                    }
                    keyPlaceholder="变量名，如 TOKEN"
                    valuePlaceholder="值，如 sk-xxxx"
                  />
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <div className="rounded-md border border-dashed border-line px-6 py-8 text-center text-[12.5px] leading-relaxed text-inksoft/70">
                  在左侧选中一个环境，或新建一个（如 dev / prod），
                  <br />
                  再在 Server 配置里用 <span className="font-mono">{"{{变量名}}"}</span> 引用这里的变量。
                </div>
              </div>
            )}

            {/* 保存错误反馈 */}
            {error && (
              <div className="mt-2 shrink-0 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-[12px] leading-relaxed text-err">
                {error}
              </div>
            )}
          </div>
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

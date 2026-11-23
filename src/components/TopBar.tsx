/**
 * 顶栏：左上角项目切换器 + 项目管理；右侧布局均分、设置与风格模式切换。
 */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Check,
  ChevronDown,
  Columns3,
  FolderCog,
  FolderPlus,
  Monitor,
  Moon,
  Settings,
  SlidersHorizontal,
  Sun,
  Zap,
} from "lucide-react";
import { activeEnvName, useAppStore } from "../store";
import { THEME_MODE_OPTIONS, type ThemeMode } from "../theme";
import { openRepoPage, REPO_URL, syncDirStatus } from "../api";
import type { SyncDirResolve } from "../types";
import { Dropdown, MenuItem, Modal } from "./ui";
import { GithubIcon } from "./icons";
import { SettingsModal } from "./SettingsModal";
import { ProjectManageModal } from "./ProjectManageModal";
import { SyncDirField } from "./SyncDirField";
import { SyncDirConflictDialog } from "./SyncDirConflictDialog";
import { EnvironmentManageModal } from "./EnvironmentManageModal";

/** 风格模式 -> 图标 */
function ModeIcon({ mode }: { mode: ThemeMode }) {
  return mode === "dark" ? (
    <Moon size={14} />
  ) : mode === "system" ? (
    <Monitor size={14} />
  ) : (
    <Sun size={14} />
  );
}

/** 是否 macOS（快捷键提示文案用：macOS 惯例 ⌘,，其余平台 Ctrl+,） */
const IS_MAC = navigator.userAgent.includes("Mac");

/**
 * 顶栏按下即拖动窗口。
 *
 * 规则：左键按下、且落点不在任何交互元素（按钮/输入框/菜单）内时，
 * 调用系统级 startDragging 进入窗口拖动——比 data-tauri-drag-region
 * 更可靠（后者要求命中元素本身，顶栏子元素会挡住大部分区域）。
 */
function handleDragMouseDown(e: React.MouseEvent<HTMLElement>) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, input, select, textarea, [role='menu']")) return;
  /* 顶栏里挂载的弹窗（Modal）portal 到 body：React 合成事件仍会沿组件树
     冒泡到 header，但 DOM 上弹窗不在 header 内——按下属正常文本选择等
     交互，必须排除，否则弹窗里拖选文本会误拖窗口 */
  if (!(e.currentTarget as HTMLElement).contains(target)) return;
  void getCurrentWindow().startDragging();
}

/** 顶栏 */
export function TopBar() {
  const {
    projects,
    activeProjectId,
    themeMode,
    setActiveProject,
    createProject,
    setThemeMode,
    environments,
    switchActiveEnv,
  } = useAppStore();
  /** 当前激活的全局环境名（空串 = 未选择环境，配置里的 {{}} 引用会在连接时报错引导） */
  const envName = useAppStore((s) => activeEnvName(s));

  const active = projects.find((p) => p.id === activeProjectId) ?? null;
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSyncDir, setNewSyncDir] = useState("");
  /** 新建表单：校验/保存失败的错误信息（展示在表单内，与「管理项目」编辑表单一致） */
  const [newError, setNewError] = useState("");
  /** 创建提交中标记：防双击/回车重复提交（后端无重名约束，重复提交会产生同名项目） */
  const [creating, setCreating] = useState(false);
  /**
   * 同步目录数据冲突：目录是已有数据的 MCPilot 同步仓库，等待用户选择数据方向。
   * 非 null 时弹冲突选择弹窗（新建弹窗保持打开，Esc 关闭临时让位给冲突弹窗）。
   */
  const [newConflict, setNewConflict] = useState<string | null>(null);
  /** 管理项目弹窗：全部项目的重命名 / 配置同步目录 / 删除集中在此 */
  const [manageOpen, setManageOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 环境管理弹窗：环境变量集中定义（Server 配置以 {{变量名}} 引用） */
  const [envManageOpen, setEnvManageOpen] = useState(false);
  /** 项目下拉的关键字过滤（每次打开下拉时清空） */
  const [projectKw, setProjectKw] = useState("");
  /** 按关键字过滤后的项目列表（不区分大小写，匹配项目名） */
  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(projectKw.trim().toLowerCase()),
  );

  /* 全局快捷键：⌘,（macOS）/ Ctrl+,（其他平台）打开设置（桌面应用惯例键位）。
     已打开时重复触发幂等；Esc 关闭由 Modal 自带 */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /** 当前模式的中文名（下拉按钮显示） */
  const modeLabel =
    THEME_MODE_OPTIONS.find((o) => o.key === themeMode)?.label ?? "亮色";

  /**
   * 提交新建项目（含可选同步目录）。
   *
   * 绑定目录前先检测目录状态（sync_dir_status）：
   * - 有内容且不是 MCPilot 同步仓库：错误留在表单内（后端 prepare_sync_dir 同样会拦）；
   * - 有内容且是同步仓库：暂缓提交，弹冲突选择弹窗；用户选定数据方向后
   *   带 resolve 重新走本函数完成创建。
   * 校验失败（名称为空）或后端拒绝时，错误信息显示在表单内——不能只写日志
   * 面板：弹窗开着时用户看不到日志，会误以为「点击创建没反应」。
   * 成功后清空表单并关闭弹窗。
   */
  const submitNew = async (resolve?: SyncDirResolve) => {
    const name = newName.trim();
    const dir = newSyncDir.trim();
    if (!name) {
      setNewError("请填写项目名称");
      return;
    }
    if (creating) return;
    setCreating(true);
    setNewError("");
    try {
      if (dir && resolve === undefined) {
        const st = await syncDirStatus(dir);
        if (st.has_content && !st.is_repo) {
          setNewError(`目录已有内容且不是 MCPilot 同步仓库，无法绑定：${dir}`);
          return;
        }
        if (st.has_content && st.is_repo) {
          setNewConflict(dir);
          return;
        }
      }
      await createProject(name, dir || undefined, resolve);
      setNewName("");
      setNewSyncDir("");
      setNewOpen(false);
    } catch (e) {
      setNewError(String(e));
    } finally {
      setCreating(false);
    }
  };

  /** 冲突选择回调：记录日志的方向选择后回到新建流程完成创建 */
  const resolveNewConflict = (resolve: SyncDirResolve) => {
    setNewConflict(null);
    void submitNew(resolve);
  };

  return (
    // 整条顶栏可拖动窗口（onMouseDown 里排除按钮等交互元素）
    // pl-[84px]：为 macOS Overlay 模式下系统原生红绿灯的默认位置留白
    <header
      onMouseDown={handleDragMouseDown}
      className="flex h-12 shrink-0 cursor-default items-center justify-between border-b border-line bg-panel pl-[84px] pr-3"
    >
      {/* 左侧：Logo + 项目切换（左侧留白是 macOS 悬浮红绿灯的区域） */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 pr-1">
          <span
            className="flex h-6 w-6 items-center justify-center rounded-md text-white"
            style={{ background: "linear-gradient(135deg, #FB7185, #E11D48)" }}
            title="MCPilot"
          >
            <Zap size={14} />
          </span>
          <span className="text-[14px] font-bold tracking-wide">MCPilot</span>
        </div>

        <Dropdown
          trigger={(open, toggle) => (
            <button
              className="btn-ghost h-8 gap-2 !px-2.5"
              onClick={() => {
                setProjectKw("");
                toggle();
              }}
              title="切换项目"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: active ? "var(--c-ok)" : "var(--c-ink-soft)" }}
              />
              <span className="max-w-[160px] truncate">
                {active ? active.name : "未选择项目"}
              </span>
              <ChevronDown
                size={14}
                className={`text-inksoft transition-transform ${open ? "rotate-180" : ""}`}
              />
            </button>
          )}
        >
          {(close) => (
            <>
              {/* 关键字过滤（项目多时快速定位）；新建入口用顶栏「新建项目」按钮，不在面板里重复 */}
              <div className="px-2 pb-1 pt-0.5">
                <input
                  className="field !py-1 text-[12.5px]"
                  autoFocus
                  placeholder="搜索项目…"
                  value={projectKw}
                  onChange={(e) => setProjectKw(e.target.value)}
                />
              </div>
              <div className="max-h-[260px] overflow-y-auto">
                {filteredProjects.map((p) => (
                  <MenuItem
                    key={p.id}
                    label={p.name}
                    icon={
                      p.id === activeProjectId ? (
                        <Check size={14} className="text-primarystrong" />
                      ) : (
                        <span className="w-[14px]" />
                      )
                    }
                    onClick={() => {
                      void setActiveProject(p.id);
                      close();
                    }}
                  />
                ))}
                {filteredProjects.length === 0 && (
                  <div className="px-3 py-2 text-[12px] text-inksoft/70">
                    没有匹配的项目
                  </div>
                )}
              </div>
            </>
          )}
        </Dropdown>

        <button
          className="btn-ghost h-8 !px-2"
          title="新建项目"
          onClick={() => {
            setNewName("");
            setNewError("");
            setNewConflict(null);
            setNewOpen(true);
          }}
        >
          <FolderPlus size={15} />
        </button>

        {/* 管理项目：全部项目的重命名 / 配置同步目录 / 删除集中管理 */}
        <button
          className="btn-ghost h-8 !px-2"
          title="管理项目（重命名 / 配置同步目录 / 删除）"
          onClick={() => setManageOpen(true)}
        >
          <FolderCog size={15} />
        </button>

        {/* 全局环境切换：一处切换影响项目内全部 Server 的 {{}} 引用解析（Apifox 式） */}
        <Dropdown
          trigger={(open, toggle) => (
            <button
              className="btn-ghost h-8 gap-1.5 !px-2.5"
              onClick={toggle}
              title="切换全局环境（Server 配置里的 {{变量名}} 按此环境解析）"
            >
              <SlidersHorizontal size={14} />
              <span className="max-w-[120px] truncate">
                {envName ? `环境：${envName}` : "环境：未选择"}
              </span>
              <ChevronDown
                size={14}
                className={`text-inksoft transition-transform ${open ? "rotate-180" : ""}`}
              />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                label="不使用环境"
                icon={
                  envName === "" ? (
                    <Check size={14} className="text-primarystrong" />
                  ) : (
                    <span className="w-[14px]" />
                  )
                }
                onClick={() => {
                  void switchActiveEnv("");
                  close();
                }}
              />
              {environments.map((e) => (
                <MenuItem
                  key={e.name}
                  label={e.name}
                  icon={
                    envName === e.name ? (
                      <Check size={14} className="text-primarystrong" />
                    ) : (
                      <span className="w-[14px]" />
                    )
                  }
                  onClick={() => {
                    void switchActiveEnv(e.name);
                    close();
                  }}
                />
              ))}
              <div className="my-1 border-t border-line" />
              <MenuItem
                icon={<Settings size={14} />}
                label="管理环境…"
                onClick={() => {
                  setEnvManageOpen(true);
                  close();
                }}
              />
            </>
          )}
        </Dropdown>
      </div>

      {/* 右侧：均分布局 + 设置 + 主题色 + 明暗切换 + GitHub 仓库 */}
      <div className="flex items-center gap-1.5">
        <button
          className="btn-ghost h-8 !px-2"
          title="四栏均分宽度（有折叠栏时先全部展开）"
          onClick={() => useAppStore.getState().equalizeLayout()}
        >
          <Columns3 size={15} />
        </button>
        <button
          className="btn-ghost h-8 !px-2"
          title={IS_MAC ? "设置（⌘,）" : "设置（Ctrl+,）"}
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={15} />
        </button>
        {/* 风格模式：下拉选择（亮色 / 暗色 / 跟随系统） */}
        <Dropdown
          align="right"
          trigger={(open, toggle) => (
            <button
              className="btn-ghost h-8 gap-1.5 !px-2.5"
              title="风格模式"
              onClick={toggle}
            >
              <ModeIcon mode={themeMode} />
              <span className="text-[12px]">{modeLabel}</span>
              <ChevronDown
                size={12}
                className={`text-inksoft transition-transform ${open ? "rotate-180" : ""}`}
              />
            </button>
          )}
        >
          {(close) => (
            <>
              {THEME_MODE_OPTIONS.map((o) => (
                <MenuItem
                  key={o.key}
                  label={o.label}
                  icon={
                    themeMode === o.key ? (
                      <Check size={13} className="text-primarystrong" />
                    ) : (
                      <ModeIcon mode={o.key} />
                    )
                  }
                  onClick={() => {
                    void setThemeMode(o.key);
                    close();
                  }}
                />
              ))}
            </>
          )}
        </Dropdown>
        {/* GitHub 仓库主页：系统默认浏览器打开 */}
        <button
          className="btn-ghost h-8 !px-2"
          title={`GitHub 仓库（${REPO_URL}）`}
          onClick={() => void openRepoPage()}
        >
          <GithubIcon size={15} />
        </button>
      </div>

      {/* 新建项目弹窗（冲突选择弹窗打开期间禁用本弹窗的 Esc 关闭：按 Esc 只关最上层） */}
      <Modal
        open={newOpen}
        title="新建项目"
        onClose={() => setNewOpen(false)}
        width={480}
        escClose={newConflict == null}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setNewOpen(false)}>
              取消
            </button>
            <button className="btn-primary" disabled={creating} onClick={() => void submitNew()}>
              {creating ? "创建中…" : "创建"}
            </button>
          </>
        }
      >
        <label className="label">项目名称</label>
        <input
          className="field"
          autoFocus
          placeholder="例如：后端服务 / 数据工具集"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submitNew()}
        />
        <div className="mt-3">
          <label className="label">同步目录（可选，开启 Git 同步）</label>
          <SyncDirField value={newSyncDir} onChange={setNewSyncDir} />
          <p className="mt-1.5 text-[12px] leading-relaxed text-inksoft">
            填写后该项目与此目录绑定：目录必须是<b>空目录</b>（不存在会自动创建，非 git 目录会自动
            <span className="font-mono"> git init</span>；已 init 过的空仓库可直接用）；已有数据的 MCPilot
            同步仓库可接管，创建时会让你选择以哪边数据为准。开启后可在资源树切换分支、推送/拉取配置。
          </p>
        </div>
        {newError && (
          <div className="mt-2 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-[12px] text-err">
            {newError}
          </div>
        )}
        <p className="mt-2 text-[12px] text-inksoft">
          项目用于隔离不同场景的目录与 Server 配置，可随时在左上角切换。
        </p>
      </Modal>

      {/* 新建项目：同步目录数据冲突选择（选定后带 resolve 回到 submitNew 完成创建） */}
      {newConflict != null && (
        <SyncDirConflictDialog
          dir={newConflict}
          onResolve={resolveNewConflict}
          onCancel={() => setNewConflict(null)}
        />
      )}

      {/* 管理项目弹窗：重命名 / 配置同步目录（可选目录） / 删除，集中管理全部项目 */}
      <ProjectManageModal open={manageOpen} onClose={() => setManageOpen(false)} />

      {/* 环境管理弹窗：环境变量集中定义与修改（Server 配置只做 {{}} 引用） */}
      <EnvironmentManageModal open={envManageOpen} onClose={() => setEnvManageOpen(false)} />

      {/* 设置弹窗 */}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}

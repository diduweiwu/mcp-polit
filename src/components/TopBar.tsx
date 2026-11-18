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
  Plus,
  Settings,
  Sun,
  Zap,
} from "lucide-react";
import { useAppStore } from "../store";
import { THEME_MODE_OPTIONS, type ThemeMode } from "../theme";
import { openRepoPage, REPO_URL } from "../api";
import { Dropdown, MenuItem, Modal } from "./ui";
import { GithubIcon } from "./icons";
import { SettingsModal } from "./SettingsModal";
import { ProjectManageModal } from "./ProjectManageModal";
import { SyncDirField } from "./SyncDirField";

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
  } = useAppStore();

  const active = projects.find((p) => p.id === activeProjectId) ?? null;
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSyncDir, setNewSyncDir] = useState("");
  /** 管理项目弹窗：全部项目的重命名 / 配置同步目录 / 删除集中在此 */
  const [manageOpen, setManageOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  /** 提交新建项目（含可选同步目录；目录校验失败时错误信息由后端返回） */
  const submitNew = async () => {
    if (!newName.trim()) return;
    try {
      await createProject(newName.trim(), newSyncDir.trim() || undefined);
      setNewName("");
      setNewSyncDir("");
      setNewOpen(false);
    } catch (e) {
      useAppStore.getState().addLog("error", `创建项目失败：${e}`);
    }
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
              onClick={toggle}
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
              {projects.map((p) => (
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
              <div className="my-1 border-t border-line" />
              <MenuItem
                icon={<Plus size={14} />}
                label="新建项目"
                onClick={() => {
                  setNewName("");
                  setNewOpen(true);
                  close();
                }}
              />
            </>
          )}
        </Dropdown>

        <button
          className="btn-ghost h-8 !px-2"
          title="新建项目"
          onClick={() => {
            setNewName("");
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
      </div>

      {/* 右侧：均分布局 + 设置 + 主题色 + 明暗切换 + GitHub 仓库 */}
      <div className="flex items-center gap-1.5">
        <button
          className="btn-ghost h-8 !px-2"
          title="四栏均分宽度"
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

      {/* 新建项目弹窗 */}
      <Modal
        open={newOpen}
        title="新建项目"
        onClose={() => setNewOpen(false)}
        width={480}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setNewOpen(false)}>
              取消
            </button>
            <button className="btn-primary" onClick={() => void submitNew()}>
              创建
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
            <span className="font-mono"> git init</span>）。开启后可在资源树切换分支、推送/拉取配置。
          </p>
        </div>
        <p className="mt-2 text-[12px] text-inksoft">
          项目用于隔离不同场景的目录与 Server 配置，可随时在左上角切换。
        </p>
      </Modal>

      {/* 管理项目弹窗：重命名 / 配置同步目录（可选目录） / 删除，集中管理全部项目 */}
      <ProjectManageModal open={manageOpen} onClose={() => setManageOpen(false)} />

      {/* 设置弹窗 */}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}

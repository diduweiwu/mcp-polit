/**
 * 顶栏：左上角项目切换器 + 项目管理；右侧主题色与明暗切换。
 */
import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Check,
  ChevronDown,
  Columns3,
  FolderPlus,
  Monitor,
  Moon,
  Palette,
  Pencil,
  Plus,
  Settings,
  Sun,
  Trash2,
  Zap,
} from "lucide-react";
import { useAppStore } from "../store";
import { THEME_PRESETS, nextThemeMode, type ThemeMode } from "../theme";
import { ConfirmDialog, Dropdown, MenuItem, Modal, useClickOutside } from "./ui";
import { SettingsModal } from "./SettingsModal";

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
  void getCurrentWindow().startDragging();
}

/** 顶栏 */
export function TopBar() {
  const {
    projects,
    activeProjectId,
    themeColorKey,
    themeMode,
    setActiveProject,
    createProject,
    renameProject,
    deleteProject,
    setThemeColor,
    setThemeMode,
  } = useAppStore();

  const active = projects.find((p) => p.id === activeProjectId) ?? null;
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSyncDir, setNewSyncDir] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const paletteRef = useClickOutside<HTMLDivElement>(() => setPaletteOpen(false));

  /** 主题模式按钮的图标与提示文案 */
  const themeBtn =
    themeMode === "dark"
      ? { icon: <Moon size={15} />, title: "暗色（点击切换为跟随系统）" }
      : themeMode === "system"
        ? { icon: <Monitor size={15} />, title: "跟随系统（点击切换为亮色）" }
        : { icon: <Sun size={15} />, title: "亮色（点击切换为暗色）" };

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

  /** 提交重命名 */
  const submitRename = async () => {
    if (!active || !renameName.trim()) return;
    await renameProject(active.id, renameName.trim());
    setRenameOpen(false);
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
            style={{ background: "var(--c-primary-strong)" }}
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
              {active && (
                <>
                  <MenuItem
                    icon={<Pencil size={14} />}
                    label="重命名当前项目"
                    onClick={() => {
                      setRenameName(active.name);
                      setRenameOpen(true);
                      close();
                    }}
                  />
                  <MenuItem
                    icon={<Trash2 size={14} />}
                    label="删除当前项目"
                    danger
                    onClick={() => {
                      setDeleteOpen(true);
                      close();
                    }}
                  />
                </>
              )}
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
      </div>

      {/* 右侧：均分布局 + 设置 + 主题色 + 明暗切换 */}
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
          title="设置"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={15} />
        </button>
        <div className="relative" ref={paletteRef}>
          <button
            className="btn-ghost h-8 gap-1.5 !px-2.5"
            title="主色调"
            onClick={() => setPaletteOpen((v) => !v)}
          >
            <Palette size={15} />
            <span
              className="h-3.5 w-3.5 rounded-full border border-white/40"
              style={{
                background: THEME_PRESETS.find((p) => p.key === themeColorKey)?.primary,
              }}
            />
          </button>
          {paletteOpen && (
            <div className="card anim-pop-in absolute right-0 top-full z-40 mt-1 w-[156px] p-1.5 shadow-xl">
              <div className="px-2 pb-1 pt-1 text-[11px] font-medium text-inksoft">主色调</div>
              {THEME_PRESETS.map((p) => {
                const selected = themeColorKey === p.key;
                return (
                  <button
                    key={p.key}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors ${
                      selected
                        ? "bg-primarysoft font-medium text-primarystrong"
                        : "text-ink hover:bg-panel2"
                    }`}
                    onClick={() => {
                      void setThemeColor(p.key);
                      setPaletteOpen(false);
                    }}
                  >
                    <span
                      className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/20"
                      style={{ background: p.primary }}
                    />
                    <span className="flex-1 text-left">{p.label}</span>
                    {selected && <Check size={14} className="text-primarystrong" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          className="btn-ghost h-8 !px-2"
          title={themeBtn.title}
          onClick={() => void setThemeMode(nextThemeMode(themeMode) as ThemeMode)}
        >
          {themeBtn.icon}
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
          <input
            className="field font-mono"
            placeholder="~/mcpilot-sync/backend 或本地 git 仓库路径"
            value={newSyncDir}
            onChange={(e) => setNewSyncDir(e.target.value)}
          />
          <p className="mt-1.5 text-[12px] leading-relaxed text-inksoft">
            填写后该项目与此目录绑定：目录不存在会自动创建，非 git 目录会自动
            <span className="font-mono"> git init</span>。开启后可在资源树切换分支、推送/拉取配置。
          </p>
        </div>
        <p className="mt-2 text-[12px] text-inksoft">
          项目用于隔离不同场景的目录与 Server 配置，可随时在左上角切换。
        </p>
      </Modal>

      {/* 重命名弹窗 */}
      <Modal
        open={renameOpen}
        title="重命名项目"
        onClose={() => setRenameOpen(false)}
        width={420}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setRenameOpen(false)}>
              取消
            </button>
            <button className="btn-primary" onClick={() => void submitRename()}>
              保存
            </button>
          </>
        }
      >
        <label className="label">项目名称</label>
        <input
          className="field"
          autoFocus
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submitRename()}
        />
      </Modal>

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteOpen}
        title="删除项目"
        message={`确定删除项目「${active?.name}」吗？其下全部目录、Server 配置将被一并删除，且不可恢复。`}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          if (active) void deleteProject(active.id);
          setDeleteOpen(false);
        }}
      />

      {/* 设置弹窗 */}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}

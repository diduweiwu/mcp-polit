/**
 * 顶栏：左上角项目切换器 + 项目管理；右侧主题色与明暗切换。
 */
import { useState } from "react";
import {
  Check,
  ChevronDown,
  FolderPlus,
  Moon,
  Palette,
  Pencil,
  Plus,
  Sun,
  Trash2,
  Zap,
} from "lucide-react";
import { useAppStore } from "../store";
import { THEME_PRESETS } from "../theme";
import { ConfirmDialog, Dropdown, MenuItem, Modal, useClickOutside } from "./ui";

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
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteRef = useClickOutside<HTMLDivElement>(() => setPaletteOpen(false));

  /** 提交新建项目 */
  const submitNew = async () => {
    if (!newName.trim()) return;
    await createProject(newName.trim());
    setNewName("");
    setNewOpen(false);
  };

  /** 提交重命名 */
  const submitRename = async () => {
    if (!active || !renameName.trim()) return;
    await renameProject(active.id, renameName.trim());
    setRenameOpen(false);
  };

  return (
    // data-tauri-drag-region：顶栏空白处可拖动窗口；按钮/下拉不受影响
    <header
      data-tauri-drag-region
      className="flex h-12 shrink-0 items-center justify-between border-b border-line bg-panel pl-[84px] pr-3"
    >
      {/* 左侧：Logo + 项目切换（左侧留白是 macOS 悬浮红绿灯的区域） */}
      <div className="flex items-center gap-2" data-tauri-drag-region>
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

      {/* 右侧：主题色 + 明暗切换 */}
      <div className="flex items-center gap-1.5">
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
            <div className="card absolute right-0 top-full z-40 mt-1 w-[168px] p-2 shadow-xl">
              <div className="mb-1.5 px-1 text-[12px] text-inksoft">主色调</div>
              <div className="grid grid-cols-3 gap-1.5">
                {THEME_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    title={p.label}
                    className={`flex items-center justify-center gap-1 rounded-md border py-1.5 text-[11px] transition-colors ${
                      themeColorKey === p.key
                        ? "border-primary bg-primarysoft text-primarystrong"
                        : "border-line hover:bg-panel2"
                    }`}
                    onClick={() => {
                      void setThemeColor(p.key);
                      setPaletteOpen(false);
                    }}
                  >
                    <span
                      className="h-3 w-3 rounded-full"
                      style={{ background: p.primary }}
                    />
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <button
          className="btn-ghost h-8 !px-2"
          title={themeMode === "dark" ? "切换到亮色" : "切换到深色"}
          onClick={() => void setThemeMode(themeMode === "dark" ? "light" : "dark")}
        >
          {themeMode === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>

      {/* 新建项目弹窗 */}
      <Modal
        open={newOpen}
        title="新建项目"
        onClose={() => setNewOpen(false)}
        width={420}
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
    </header>
  );
}

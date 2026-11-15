/**
 * 设置弹窗：外观（明暗三态 + 主色调）、Git 同步（仓库路径/脱敏/导入导出）、关于。
 */
import { useEffect, useState } from "react";
import {
  Download,
  FolderSync,
  Info,
  Monitor,
  Moon,
  Sun,
  Upload,
} from "lucide-react";
import { useAppStore } from "../store";
import { type ThemeMode } from "../theme";
import { Modal } from "./ui";

/** 明暗三态选项 */
const MODE_OPTIONS: Array<{ key: ThemeMode; label: string; icon: React.ReactNode }> = [
  { key: "light", label: "亮色", icon: <Sun size={14} /> },
  { key: "dark", label: "暗色", icon: <Moon size={14} /> },
  { key: "system", label: "跟随系统", icon: <Monitor size={14} /> },
];

/** 设置弹窗属性 */
interface Props {
  open: boolean;
  onClose: () => void;
}

/** 设置弹窗 */
export function SettingsModal({ open, onClose }: Props) {
  const {
    themeMode,
    setThemeMode,
    settings,
    saveSetting,
    syncExport,
    syncImport,
    syncing,
    projects,
  } = useAppStore();

  const [repoPath, setRepoPath] = useState("");
  const [includeSecrets, setIncludeSecrets] = useState(false);

  /* 打开时从设置缓存回填 */
  useEffect(() => {
    if (open) {
      setRepoPath(settings["sync_repo_path"] ?? "");
      setIncludeSecrets(settings["sync_include_secrets"] === "1");
    }
  }, [open, settings]);

  /** 保存同步设置 */
  const saveSyncSettings = async (secrets: boolean) => {
    await saveSetting("sync_repo_path", repoPath.trim());
    await saveSetting("sync_include_secrets", secrets ? "1" : "0");
  };

  return (
    <Modal open={open} title="设置" onClose={onClose} width={560}>
      {/* ---------- 外观 ---------- */}
      <section>
        <SectionTitle>外观</SectionTitle>
        <label className="label">风格模式</label>
        <div className="mb-1 flex gap-2">
          {MODE_OPTIONS.map((o) => (
            <button
              key={o.key}
              onClick={() => void setThemeMode(o.key)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border py-2 text-[12.5px] transition-colors ${
                themeMode === o.key
                  ? "border-primary bg-primarysoft text-primarystrong"
                  : "border-line text-ink hover:bg-panel2"
              }`}
            >
              {o.icon}
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-[11.5px] text-inksoft/70">
          「跟随系统」会实时响应系统的深浅色切换。
        </p>
      </section>

      <div className="my-4 border-t border-line" />

      {/* ---------- 同步 ---------- */}
      <section>
        <SectionTitle>Git 同步</SectionTitle>
        <label className="label">仓库路径（本机已有的 git 仓库目录）</label>
        <input
          className="field mb-2 font-mono"
          placeholder="/Users/you/mcpilot-sync（或已 clone 的私有仓库）"
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          onBlur={() => void saveSyncSettings(includeSecrets)}
        />
        <label className="mb-3 flex cursor-pointer items-start gap-2 text-[12px] leading-relaxed text-inksoft">
          <input
            type="checkbox"
            className="mt-0.5 accent-[var(--c-primary-strong)]"
            checked={includeSecrets}
            onChange={(e) => {
              setIncludeSecrets(e.target.checked);
              void saveSyncSettings(e.target.checked);
            }}
          />
          <span>
            导出包含敏感信息（请求头 / 环境变量的真实值）。
            <span className="text-warn">关闭时这些值以 *** 脱敏导出</span>
            ；仓库若为公开远端，请务必保持关闭。
          </span>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <button
            className="btn-ghost h-9"
            disabled={syncing}
            onClick={() => {
              void saveSyncSettings(includeSecrets).then(() => void syncExport());
            }}
          >
            <Upload size={14} /> 导出到 Git
          </button>
          <button
            className="btn-ghost h-9"
            disabled={syncing}
            onClick={() => void syncImport()}
          >
            <Download size={14} /> 从 Git 导入
          </button>
        </div>

        <div className="mt-2.5 flex items-start gap-1.5 rounded-md bg-panel2 p-2.5 text-[11.5px] leading-relaxed text-inksoft">
          <FolderSync size={14} className="mt-0.5 shrink-0" />
          <span>
            导出把{projects.length > 0 ? `全部 ${projects.length} 个项目` : "全部项目"}的目录树与
            Server 配置写成 JSON 文件（只读写 .json）并 git commit/push；导入为
            <b>覆盖语义</b>——同名项目会被仓库内容替换。损坏的文件会记录在日志面板并跳过，
            不会加载；同目录下 Server 别名不允许重复。
          </span>
        </div>
      </section>

      <div className="my-4 border-t border-line" />

      {/* ---------- 关于 ---------- */}
      <section>
        <SectionTitle>关于</SectionTitle>
        <div className="flex items-start gap-1.5 text-[12px] leading-relaxed text-inksoft">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>
            MCPilot v0.1.0 — 本地 MCP 调试工作台。全部数据仅保存在本机应用数据目录的
            SQLite 中，除你配置的 MCP Server 与同步仓库外不发起任何网络请求。
          </span>
        </div>
      </section>
    </Modal>
  );
}

/** 小节标题 */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[13px] font-semibold text-ink">{children}</div>
  );
}

/**
 * 设置弹窗：外观（明暗三态 + 主色调）、Git 同步（仓库路径/脱敏/导入导出）、关于与在线更新。
 */
import { useEffect, useState } from "react";
import {
  Download,
  FolderSync,
  Info,
  Loader2,
  Monitor,
  Moon,
  RefreshCw,
  Sun,
  Upload,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
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
  /** 当前应用版本（浏览器演示模式下取不到，显示为空） */
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

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

      {/* ---------- 关于与在线更新 ---------- */}
      <section>
        <SectionTitle>关于与更新</SectionTitle>
        <div className="flex items-start gap-1.5 text-[12px] leading-relaxed text-inksoft">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>
            MCPilot {version ? `v${version}` : ""} — 本地 MCP 调试工作台。全部数据仅保存在本机应用数据目录的
            SQLite 中，除你配置的 MCP Server、同步仓库与检查更新（GitHub Releases）外不发起任何网络请求。
          </span>
        </div>
        <UpdaterSection />
      </section>
    </Modal>
  );
}

/** 更新状态机 */
type UpdateState = "idle" | "checking" | "available" | "downloading" | "installed";

/**
 * 在线更新区：检查 GitHub Releases 最新版本（updater 插件做签名校验），
 * 发现新版本后下载安装（带进度），完成后可一键重启应用。
 */
function UpdaterSection() {
  const [state, setState] = useState<UpdateState>("idle");
  /** 已是最新 / 出错时的提示文案 */
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  /** 待安装的新版本号 */
  const [newVersion, setNewVersion] = useState("");
  /** 下载进度 */
  const [progress, setProgress] = useState({ received: 0, total: 0 });
  /** 检查到的更新对象（downloadAndInstall 用） */
  const [update, setUpdate] = useState<Update | null>(null);

  /** 检查更新：请求 latest.json（GitHub Release 最新版），版本更高才返回更新对象 */
  const doCheck = async () => {
    setError("");
    setNote("");
    setUpdate(null);
    setNewVersion("");
    setState("checking");
    try {
      const found = await check();
      if (found) {
        setUpdate(found);
        setNewVersion(found.version);
        setState("available");
      } else {
        setNote("已是最新版本。");
        setState("idle");
      }
    } catch (e) {
      setError(String(e));
      setState("idle");
    }
  };

  /** 下载并安装：完成后提示重启（macOS/Linux 直接替换应用文件） */
  const install = async () => {
    if (!update) return;
    setError("");
    setState("downloading");
    setProgress({ received: 0, total: 0 });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setProgress({ received: 0, total: event.data.contentLength ?? 0 });
        } else if (event.event === "Progress") {
          setProgress((p) => ({ ...p, received: p.received + event.data.chunkLength }));
        }
        // Finished：安装落盘完成，等用户点重启
      });
      setState("installed");
    } catch (e) {
      setError(String(e));
      setState("available");
    }
  };

  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;

  return (
    <div className="mt-2.5">
      <div className="flex items-center gap-2">
        {state === "idle" && (
          <button className="btn-ghost h-8 gap-1.5" onClick={() => void doCheck()}>
            <RefreshCw size={13} /> 检查更新
          </button>
        )}
        {state === "checking" && (
          <span className="flex h-8 items-center gap-1.5 text-[12.5px] text-inksoft">
            <Loader2 size={14} className="animate-spin" /> 正在检查更新…
          </span>
        )}
        {state === "available" && (
          <button className="btn-primary h-8 gap-1.5" onClick={() => void install()}>
            <Download size={13} /> 下载并安装 v{newVersion}
          </button>
        )}
        {state === "downloading" && (
          <span className="flex h-8 items-center gap-1.5 text-[12.5px] text-inksoft">
            <Loader2 size={14} className="animate-spin" />
            正在下载… {pct}%
          </span>
        )}
        {state === "installed" && (
          <button className="btn-primary h-8 gap-1.5" onClick={() => void relaunch()}>
            <RefreshCw size={13} /> 安装完成，重启应用
          </button>
        )}
        {note && state === "idle" && (
          <span className="text-[12px] text-ok">{note}</span>
        )}
      </div>

      {state === "downloading" && progress.total > 0 && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel2">
          <div
            className="h-full rounded-full bg-[var(--c-primary-strong)] transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {error && (
        <div className="mt-2 rounded-md border border-err/30 bg-err/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-err">
          {error}
        </div>
      )}
      {state === "idle" && !note && !error && (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-inksoft/70">
          检查 GitHub Releases 获取最新版本，下载前会校验更新包签名。
        </p>
      )}
    </div>
  );
}

/** 小节标题 */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[13px] font-semibold text-ink">{children}</div>
  );
}

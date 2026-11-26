/**
 * 设置弹窗：左侧竖排 tab 导航 + 右侧内容区——外观（明暗三态）、
 * 调用（全局调用超时）、关于（版本信息 + 在线更新）。
 * 弹窗固定高度（Modal height），切 tab 时尺寸不跳变，内容超长由右侧区域内部滚动。
 */
import { useEffect, useState } from "react";
import {
  Download,
  Info,
  Loader2,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  ScrollText,
  Sun,
  Timer,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useAppStore, MAX_CALL_TIMEOUT_SECS } from "../store";
import { CHANGELOG_RAW, getVersionNotes } from "../lib/changelog";
import { type ThemeMode } from "../theme";
import { openRepoPage, REPO_URL } from "../api";
import { Modal, Tooltip } from "./ui";
import { GithubIcon } from "./icons";

/** 明暗三态选项 */
const MODE_OPTIONS: Array<{ key: ThemeMode; label: string; icon: React.ReactNode }> = [
  { key: "light", label: "亮色", icon: <Sun size={14} /> },
  { key: "dark", label: "暗色", icon: <Moon size={14} /> },
  { key: "system", label: "跟随系统", icon: <Monitor size={14} /> },
];

/** 设置 tab 键 */
type SettingsTab = "appearance" | "call" | "about";

/** 设置 tab 定义（顺序即展示顺序，icon 用于左侧导航） */
const TABS: Array<{ key: SettingsTab; label: string; icon: React.ReactNode }> = [
  { key: "appearance", label: "外观", icon: <Palette size={14} /> },
  { key: "call", label: "调用", icon: <Timer size={14} /> },
  { key: "about", label: "关于", icon: <Info size={14} /> },
];

/** 设置弹窗属性 */
interface Props {
  open: boolean;
  onClose: () => void;
}

/** 设置弹窗：左侧 tab 导航 + 右侧分区（tab 状态跨开关保留，重开停在上次页） */
export function SettingsModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>("appearance");
  /** 原生菜单「检查更新」触发的自动检查标记：打开时强制切到「关于」tab 触发检查 */
  const autoCheck = useAppStore((s) => s.settingsAutoCheck);

  /* 菜单触发：弹窗打开即切「关于」tab，由 UpdaterSection 挂载时自动检查一次 */
  useEffect(() => {
    if (open && autoCheck) setTab("about");
  }, [open, autoCheck]);

  return (
    <Modal open={open} title="设置" onClose={onClose} width={680} height={520}>
      <div className="flex h-full gap-3.5">
        {/* 左侧竖排 tab 导航（选中态沿用原分段控件的样式语言） */}
        <nav className="flex w-[116px] shrink-0 flex-col gap-0.5 rounded-lg bg-panel2 p-1.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] font-medium transition-colors ${
                tab === t.key
                  ? "bg-panel text-primarystrong shadow-sm"
                  : "text-inksoft hover:bg-panel/50 hover:text-ink"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>

        {/* 右侧内容区：固定高度下内容各自滚动 */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {tab === "appearance" && <AppearanceSection />}
          {tab === "call" && <CallSection />}
          {tab === "about" && <AboutSection />}
        </div>
      </div>
    </Modal>
  );
}

/** 外观 tab：明暗三态切换 */
function AppearanceSection() {
  const { themeMode, setThemeMode } = useAppStore();

  return (
    <section className="anim-fade-in">
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
  );
}

/** 调用 tab：全局调用超时（工具调用的超时下限，实际生效取与 Server 配置较大的值） */
function CallSection() {
  const { callTimeoutSecs, setCallTimeoutSecs } = useAppStore();
  /** 输入草稿：失焦时才 clamp + 落库，避免输入中间态（如清空）被强行改写 */
  const [draft, setDraft] = useState(String(callTimeoutSecs));

  // 外部变更（重开弹窗/其他入口修改）时同步草稿
  useEffect(() => setDraft(String(callTimeoutSecs)), [callTimeoutSecs]);

  /** 失焦提交：收敛到 1~1024 秒（与前后端防御逻辑一致），有变化才落库 */
  const commit = () => {
    const n = Number(draft);
    const v =
      Number.isFinite(n) && draft.trim() !== ""
        ? Math.min(MAX_CALL_TIMEOUT_SECS, Math.max(1, Math.floor(n)))
        : callTimeoutSecs;
    setDraft(String(v));
    if (v !== callTimeoutSecs) void setCallTimeoutSecs(v);
  };

  return (
    <section className="anim-fade-in">
      <label className="label">调用超时（秒）</label>
      <input
        className="field w-40"
        type="number"
        min={1}
        max={MAX_CALL_TIMEOUT_SECS}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-inksoft/70">
        工具调用等待结果的超时下限，范围 1 ~ {MAX_CALL_TIMEOUT_SECS} 秒，默认 60 秒。
        实际生效取本值与 Server 配置中「调用超时」的较大者——单独调大过超时的 Server 不受影响。
      </p>
    </section>
  );
}

/** 关于 tab：版本信息 + 在线更新 */
function AboutSection() {
  /** 当前应用版本（浏览器演示模式下取不到，显示为空） */
  const [version, setVersion] = useState("");
  /** 本次版本更新日志弹窗 */
  const [logOpen, setLogOpen] = useState(false);
  /** 原生菜单触发的自动检查标记（透传给 UpdaterSection，检查完由其清除） */
  const autoCheck = useAppStore((s) => s.settingsAutoCheck);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  return (
    <section className="anim-fade-in">
      {/* 版本与隐私说明：card 呈现 */}
      <div className="flex items-start gap-1.5 rounded-md bg-panel2 p-3 text-[12px] leading-relaxed text-inksoft">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          MCPilot {version ? `v${version}` : ""} — 本地 MCP 调试工作台。全部数据仅保存在本机应用数据目录的
          SQLite 中，除你配置的 MCP Server、同步仓库与检查更新（GitHub Releases）外不发起任何网络请求。
        </span>
      </div>
      {/* 更新状态机 + 右侧两个入口 icon（本次更新日志 / GitHub 仓库）；说明/进度/错误由
          UpdaterSection 在下方通栏展示；更新日志弹窗挂载在此处 */}
      <UpdaterSection
        className="mt-2.5"
        autoCheck={autoCheck}
        trailing={
          <>
            {/* 本次版本更新日志：CHANGELOG.md 打包内置，离线可查（零网络请求） */}
            <Tooltip content="本次版本更新日志（离线可查）">
              <button
                className="rounded p-1.5 text-inksoft transition-colors hover:bg-panel2 hover:text-ink"
                aria-label="查看本次版本更新日志"
                onClick={() => setLogOpen(true)}
              >
                <ScrollText size={14} />
              </button>
            </Tooltip>
            <Tooltip content={`在浏览器打开 ${REPO_URL}`}>
              <button
                className="rounded p-1.5 text-inksoft transition-colors hover:bg-panel2 hover:text-ink"
                aria-label={`在浏览器打开 ${REPO_URL}`}
                onClick={() => void openRepoPage()}
              >
                <GithubIcon size={14} />
              </button>
            </Tooltip>
          </>
        }
      />
      {logOpen && <ChangelogModal onClose={() => setLogOpen(false)} />}
    </section>
  );
}

/** 更新状态机 */
type UpdateState = "idle" | "checking" | "available" | "downloading" | "installed";

/**
 * 在线更新区：检查 GitHub Releases 最新版本（updater 插件做签名校验），
 * 发现新版本后下载安装（带进度），完成后可一键重启应用。
 *
 * @param trailing 状态行右侧的附加节点（如更新日志/GitHub 仓库入口 icon），
 *                 紧跟当前状态元素（按钮/进度文案）之后同行展示
 * @param className 外层容器附加类名（与上方内容的间距由调用方控制）
 * @param autoCheck 原生菜单「检查更新」触发：挂载即自动检查一次（初始直接进入
 *                  checking 态），检查结束（无论结果）清除 store 里的标记防止误触发
 */
function UpdaterSection({
  trailing,
  className = "",
  autoCheck = false,
}: {
  trailing?: React.ReactNode;
  className?: string;
  autoCheck?: boolean;
}) {
  const [state, setState] = useState<UpdateState>(autoCheck ? "checking" : "idle");
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

  /* 原生菜单「检查更新」触发：挂载即自动检查一次，结束后（无论成功/失败）清除
     store 标记——下次手动打开设置不应再自动检查 */
  useEffect(() => {
    if (!autoCheck) return;
    void doCheck().finally(() => useAppStore.setState({ settingsAutoCheck: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <div className={`min-w-0 ${className}`}>
      {/* 第一行：更新状态按钮/进度文案 + 右侧附加入口 icon */}
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
        {/* 右侧附加入口 icon（更新日志 / GitHub 仓库）：紧跟状态元素之后 */}
        {trailing && <span className="flex shrink-0 items-center gap-1">{trailing}</span>}
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
          <p className="mt-2 text-[11.5px] leading-relaxed text-inksoft/70">
            检查 GitHub Releases 获取最新版本，下载前会校验更新包签名。
          </p>
        )}

        {/* 更新日志显示框：检查到新版本时展示（内容 = latest.json 的 notes，
            CI 发版时从仓库根 CHANGELOG.md 最新段落提取）；无日志内容则不出框 */}
        {state === "available" && update?.body?.trim() && (
          <div className="mt-2.5 rounded-md border border-line bg-panel2 px-3 py-2">
            <p className="mb-1 text-[11px] text-inksoft">更新日志 · v{newVersion}</p>
            <div className="max-h-[150px] overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink/90">
              {update.body.trim()}
            </div>
          </div>
        )}
    </div>
  );
}

/**
 * 本次版本更新日志弹窗：内容来自打包内置的 CHANGELOG.md（构建期 raw 导入，
 * 运行期零网络请求）；按当前应用版本提取对应段落展示。
 *
 * 版本取不到（浏览器演示模式）或 CHANGELOG.md 无该版本记录时显示说明文案。
 */
function ChangelogModal({ onClose }: { onClose: () => void }) {
  /** 当前应用版本（取不到时空串，标题退化为「更新日志」） */
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  const notes = version ? getVersionNotes(CHANGELOG_RAW, version) : null;

  return (
    <Modal
      open
      title={version ? `更新日志 · v${version}` : "更新日志"}
      onClose={onClose}
      width={520}
      footer={
        <button className="btn-primary" onClick={onClose}>
          知道了
        </button>
      }
    >
      {notes ? (
        <div className="max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink">
          {notes.body}
        </div>
      ) : (
        <p className="text-[12.5px] leading-relaxed text-inksoft">
          {version
            ? `CHANGELOG.md 中暂无 v${version} 的记录（v0.1.19 之前的版本未维护更新日志）。`
            : "演示模式下取不到当前应用版本号，无法定位对应日志。"}
        </p>
      )}
    </Modal>
  );
}

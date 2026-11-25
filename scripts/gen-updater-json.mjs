/**
 * 汇总生成 Tauri updater 的 latest.json（含全部平台条目）。
 *
 * 背景：CI 各平台 job 并发构建时，tauri-action 的 includeUpdaterJson 会让
 * 每个 job 各自生成并上传 latest.json，后完成者覆盖先完成者——v0.1.4 实证
 * macOS (darwin-aarch64 / darwin-x86_64) 条目在竞态中丢失，导致应用内
 * 「检查更新」报 "None of the fallback platforms ... were found in the
 * 'platforms' object"。本脚本在全部平台构建完成后统一汇总：读取各平台
 * 更新包的 .sig 签名文件（minisign 签名内容即 signature 字段），按 Tauri
 * 官方键集（无后缀键 + 安装器后缀键，如 darwin-aarch64 / darwin-aarch64-app）
 * 拼出完整 latest.json。
 *
 * 用法：
 *   node scripts/gen-updater-json.mjs --tag v0.1.4 --sig-dir ./sigs \
 *     [--repo diduweiwu/mcp-polit] [-o latest.json]
 *
 *   --tag      必填，Release 标签（如 v0.1.4），version 取去掉 v 的部分
 *   --sig-dir  必填，存放 *.sig 签名文件的目录（CI 用 gh release download，
 *              本地可用 curl 从 Release 下载）
 *   --repo     owner/repo；缺省读环境变量 GITHUB_REPOSITORY（CI 内自动可用）
 *   -o         输出路径，缺省 stdout
 *
 * 退出码：产物签名文件缺失时非 0 并列出缺失清单（防止生成半残的 latest.json）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/* ---------- 参数解析 ---------- */

function parseArgs(argv) {
  const args = { tag: null, sigDir: null, repo: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tag") args.tag = argv[++i];
    else if (a === "--sig-dir") args.sigDir = argv[++i];
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "-o") args.out = argv[++i];
    else throw new Error(`未知参数：${a}`);
  }
  if (!args.tag || !args.tag.startsWith("v")) throw new Error("--tag 必须以 v 开头，如 v0.1.4");
  if (!args.sigDir) throw new Error("缺少 --sig-dir（*.sig 签名文件所在目录）");
  args.repo = args.repo || process.env.GITHUB_REPOSITORY;
  if (!args.repo) throw new Error("缺少 --repo 或环境变量 GITHUB_REPOSITORY");
  return args;
}

const args = parseArgs(process.argv);
const VERSION = args.tag.slice(1); // v0.1.4 -> 0.1.4
const SIG_DIR = resolve(args.sigDir);
const BASE_URL = `https://github.com/${args.repo}/releases/download/${args.tag}`;

/**
 * 平台条目映射。
 *
 * - key：Tauri updater 的平台键。插件按「安装器后缀键 → 无后缀键」顺序查找
 *   （如报错信息中的 fallback 顺序 ["darwin-aarch64-app", "darwin-aarch64"]），
 *   故同一份产物挂双键兜底。
 * - artifact：更新包文件名（Release asset 名）。
 * - signature：对应的 .sig 签名文件名（GitHub Actions 上传的 minisign 签名）。
 *
 * macOS：CI 只构建 universal 单包，darwin 两种架构（含 -app 后缀键）都指向
 * 同一份 MCPilot_universal.app.tar.gz；不带版本号（{productName}_{arch}.app.tar.gz
 * 命名中 universal 即 arch 段），其余平台带版本号（tauri bundle 默认命名）。
 * Windows：只发 NSIS——历史上用 MSI 安装的用户更新时会 fallback 到无后缀键
 * 拿到 NSIS 安装包，覆盖安装可用，仅卸载列表可能残留旧 MSI 记录，可接受。
 */
const ARTIFACTS = [
  { keys: ["darwin-aarch64-app", "darwin-aarch64", "darwin-x86_64-app", "darwin-x86_64"], artifact: `MCPilot_universal.app.tar.gz`, signature: `MCPilot_universal.app.tar.gz.sig` },
  { keys: ["windows-x86_64-nsis", "windows-x86_64"], artifact: `MCPilot_${VERSION}_x64-setup.exe`, signature: `MCPilot_${VERSION}_x64-setup.exe.sig` },
  { keys: ["linux-x86_64-appimage", "linux-x86_64"], artifact: `MCPilot_${VERSION}_amd64.AppImage`, signature: `MCPilot_${VERSION}_amd64.AppImage.sig` },
  { keys: ["linux-x86_64-deb"], artifact: `MCPilot_${VERSION}_amd64.deb`, signature: `MCPilot_${VERSION}_amd64.deb.sig` },
  { keys: ["linux-x86_64-rpm"], artifact: `MCPilot-${VERSION}-1.x86_64.rpm`, signature: `MCPilot-${VERSION}-1.x86_64.rpm.sig` },
];

/* ---------- 校验签名文件齐全 ---------- */

const missing = ARTIFACTS.filter((a) => !existsSync(join(SIG_DIR, a.signature))).map(
  (a) => `${a.signature}（对应产物 ${a.artifact}）`,
);
if (missing.length > 0) {
  console.error(`缺少签名文件：\n  - ${missing.join("\n  - ")}`);
  process.exit(1);
}

/* ---------- 拼装 latest.json ---------- */

const platforms = {};
for (const { keys, artifact, signature } of ARTIFACTS) {
  const sig = readFileSync(join(SIG_DIR, signature), "utf8");
  // 签名即多行 minisign 文本；去掉尾随换行后原样作为 signature 字段
  for (const key of keys) {
    platforms[key] = { signature: sig.trimEnd(), url: `${BASE_URL}/${artifact}` };
  }
}

const latest = {
  version: VERSION,
  notes: extractNotes(VERSION),
  pub_date: new Date().toISOString(),
  platforms,
};

/**
 * 从仓库根 CHANGELOG.md 提取指定版本的日志段落，作为 latest.json 的 notes
 * （应用内「检查更新」发现新版本时的更新日志显示框数据源，与 GitHub Release
 * 正文的提取规则一致，见 build.yml 的「提取更新日志」步骤）。
 *
 * 段落格式：`## vX.Y.Z（日期）` 标题到下一个 `## ` 标题之间；版本号要求
 * 后跟非数字/非点字符（防 0.1.2 误命中 0.1.21）。文件缺失或无该版本记录时
 * 回退通用文案——不阻塞发版流程。
 */
function extractNotes(version) {
  const FALLBACK = "MCPilot 桌面客户端安装包。详见 README 的系统版本要求。";
  let raw;
  try {
    raw = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  } catch {
    return FALLBACK;
  }
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s+v?${escaped}(?![\\d.])`);
  const out = [];
  let inSection = false;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      if (inSection) break; // 下一个版本段落开始，收集结束
      inSection = re.test(line);
      continue;
    }
    if (inSection) out.push(line);
  }
  const body = out.join("\n").trim();
  return body || FALLBACK;
}

const json = JSON.stringify(latest, null, 2) + "\n";
if (args.out) {
  writeFileSync(args.out, json);
  console.log(`已生成 ${args.out}（${Object.keys(platforms).length} 个平台键）`);
} else {
  console.log(json);
}

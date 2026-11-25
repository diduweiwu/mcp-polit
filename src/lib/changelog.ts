/**
 * 更新日志（CHANGELOG.md）解析：应用打包时把仓库根的 CHANGELOG.md 原文内置进来
 * （vite `?raw` 导入，构建期完成、运行期零网络请求），提供按版本取日志段落的工具。
 *
 * CHANGELOG.md 的段落格式（见仓库根文件头部说明）：
 *
 *   ## vX.Y.Z（2026-11-25）
 *   - 变更条目…
 *
 * 用法：
 *
 *   import { CHANGELOG_RAW, getVersionNotes } from "../lib/changelog";
 *   const notes = getVersionNotes(CHANGELOG_RAW, "0.1.21"); // 或 null（无该版本记录）
 */

/** CHANGELOG.md 原文（构建期打包进应用，运行期零网络） */
import changelogRaw from "../../CHANGELOG.md?raw";
export const CHANGELOG_RAW = changelogRaw;

/** 一个版本的更新日志段落 */
export interface ChangelogSection {
  /** 段落标题行原文（如 `## v0.1.21（2026-11-25）`，不含末尾换行） */
  heading: string;
  /** 段落正文（标题行之后到下一个 `## ` 标题之前的全部行，trim 后） */
  body: string;
}

/**
 * 把 CHANGELOG.md 原文解析为版本段落列表（按文件顺序，即新版本在前）。
 *
 * 只认 `## ` 开头的二级标题为版本分界（`#` 文档标题与其余内容归属「文件头」，
 * 不产出段落）；`###` 等更深层标题视作段落正文的一部分。
 *
 * @param raw CHANGELOG.md 原文
 * @returns 段落列表（空文件 / 无 `## ` 标题时返回空数组）
 *
 * @example
 * parseChangelogSections(CHANGELOG_RAW)[0]?.heading; // "## v0.1.21（2026-11-25）"
 */
export function parseChangelogSections(raw: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      if (current) sections.push({ heading: current.heading, body: current.lines.join("\n").trim() });
      current = { heading: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.lines.join("\n").trim() });
  return sections;
}

/**
 * 取指定版本的更新日志段落。
 *
 * 版本号匹配 `## vX.Y.Z` 或 `## X.Y.Z` 标题，且**要求版本号后紧跟非数字/非点字符**
 * （标题行尾、空格、全角括号等）——防止 `0.1.2` 误匹配到 `0.1.21` 的段落。
 *
 * @param raw CHANGELOG.md 原文
 * @param version 版本号（不带 v 前缀，如 `getVersion()` 返回的 "0.1.21"）
 * @returns 匹配段落；找不到时返回 null
 *
 * @example
 * const notes = getVersionNotes(CHANGELOG_RAW, "0.1.21");
 * if (notes) show(notes.body);
 */
export function getVersionNotes(raw: string, version: string): ChangelogSection | null {
  const v = version.trim().replace(/^v/, "");
  if (!v) return null;
  // 版本号中的点转义后拼进正则；(?![\d.]) 锚定版本号结束边界
  const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s+v?${escaped}(?![\\d.])`);
  return parseChangelogSections(raw).find((s) => re.test(s.heading)) ?? null;
}

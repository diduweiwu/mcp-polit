/**
 * 生成 macOS icon.icns（保留源图透明边距）。
 *
 * 背景：`tauri icon` 生成 icns 时会把源图裁掉透明边距铺满画布，
 * 导致 Dock 图标比其他应用大一号。本脚本按 Apple Big Sur+ 官方网格
 * （1024 画布 / 主体 824 居中 / 边距 100 / 圆角 185）直接产出
 * 标准 iconset 并用系统 iconutil 打包成 icns。
 *
 * 用法：node scripts/gen-macos-icns.mjs <1024x1024源图.png>
 * 依赖：项目 devDependencies 中的 sharp（pnpm add -D sharp）+ 系统 iconutil
 * 输出：覆盖 src-tauri/icons/icon.icns
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";

const SRC = resolve(process.argv[2]);
const ROOT = resolve(import.meta.dirname, "..");
const ICONS_DIR = join(ROOT, "src-tauri", "icons");
const ICONSET = "/tmp/mcpilot.iconset";

const SIZES = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });

for (const [size, name] of SIZES) {
  await sharp(SRC)
    .resize(size, size, { kernel: "lanczos3" })
    .png()
    .toFile(join(ICONSET, name));
  console.log(`icon_${size}.png -> ${name}`);
}

execFileSync("iconutil", ["-c", "icns", ICONSET, "-o", join(ICONS_DIR, "icon.icns")]);
console.log("icon.icns written");

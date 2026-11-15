/**
 * 主题：明暗模式管理。
 *
 * 主色调为固定天蓝色（CSS 变量 --c-primary，见 index.css）；
 * 明暗模式支持 亮色 / 暗色 / 跟随系统 三态，选择持久化到后端 settings。
 */

/** 明暗模式：system = 跟随系统 */
export type ThemeMode = "light" | "dark" | "system";

/** 三态选项（顶栏下拉与设置弹窗共用） */
export const THEME_MODE_OPTIONS: Array<{ key: ThemeMode; label: string }> = [
  { key: "light", label: "亮色" },
  { key: "dark", label: "暗色" },
  { key: "system", label: "跟随系统" },
];

/** 明暗模式对应的图标名（UI 层映射 lucide 图标用） */
export function modeIconName(mode: ThemeMode): "sun" | "moon" | "monitor" {
  return mode === "dark" ? "moon" : mode === "system" ? "monitor" : "sun";
}

/** 切换明暗模式（system 时查询系统偏好；给 html 加/去掉 dark 类） */
export function applyThemeMode(mode: ThemeMode) {
  const dark =
    mode === "dark" ||
    (mode === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** 订阅系统明暗变化（themeMode = system 时实时生效） */
export function watchSystemTheme(cb: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** 明暗模式循环顺序：亮色 -> 暗色 -> 跟随系统 */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  return mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
}

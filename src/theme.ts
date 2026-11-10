/**
 * 主题：主色调预设与明暗模式管理。
 *
 * 主色调通过 CSS 变量注入，切换即时生效；选择结果持久化到后端 settings 表。
 */

/** 主色调预设 */
export interface ThemePreset {
  key: string;
  /** 中文名（设置面板显示） */
  label: string;
  /** 正常态主色 */
  primary: string;
  /** 深一档（按钮底色等） */
  strong: string;
}

/** 内置色板：默认天蓝色 */
export const THEME_PRESETS: ThemePreset[] = [
  { key: "sky", label: "天蓝", primary: "#38bdf8", strong: "#0284c7" },
  { key: "indigo", label: "靛蓝", primary: "#818cf8", strong: "#4f46e5" },
  { key: "emerald", label: "翠绿", primary: "#34d399", strong: "#059669" },
  { key: "violet", label: "紫罗兰", primary: "#a78bfa", strong: "#7c3aed" },
  { key: "rose", label: "玫红", primary: "#fb7185", strong: "#e11d48" },
  { key: "orange", label: "暖橙", primary: "#fb923c", strong: "#ea580c" },
];

/** 明暗模式：system = 跟随系统 */
export type ThemeMode = "light" | "dark" | "system";

/** 把主色调应用到文档根元素 */
export function applyThemeColor(preset: ThemePreset) {
  const root = document.documentElement;
  root.style.setProperty("--c-primary", preset.primary);
  root.style.setProperty("--c-primary-strong", preset.strong);
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

/** 按 key 找预设；找不到回退到默认天蓝 */
export function presetByKey(key: string | undefined): ThemePreset {
  return THEME_PRESETS.find((p) => p.key === key) ?? THEME_PRESETS[0];
}

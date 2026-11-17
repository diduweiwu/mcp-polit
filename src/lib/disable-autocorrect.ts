/**
 * 关闭 WKWebView（macOS）原生的输入纠正行为。
 *
 * 背景：Tauri 在 macOS 上使用 WKWebView 渲染，输入框键入时会弹出系统级
 * 自动修正建议气泡（如输入 "asd" 时建议 "Asd"），并附带拼写检查下划线、
 * 首字母自动大写等行为。Tauri/wry 未提供全局关闭开关，只能通过输入元素
 * 上的 HTML 属性逐个关闭（`autocorrect` / `autocapitalize` / `spellcheck`）。
 *
 * 实现方式（观察者模式，基于 DOM 事件委托）：
 * 1. 初始化时对文档中已存在的全部文本输入控件设置关闭属性；
 * 2. 监听捕获阶段的 `focusin` 事件——任何输入控件获得焦点（包括后续动态
 *    创建、程序化聚焦的）都会在用户键入前被补上关闭属性，无需侵入任何
 *    业务组件，新增输入框自动生效。
 *
 * @example
 * // 在应用入口（src/main.tsx）渲染前调用一次即可：
 * import { disableNativeTextCorrection } from "./lib/disable-autocorrect";
 * disableNativeTextCorrection();
 */

/** 用于关闭系统输入纠正的 HTML 属性集合 */
const CORRECTION_OFF_ATTRS: Readonly<Record<string, string>> = {
  autocorrect: "off", // 关闭自动修正建议气泡（WebKit 扩展属性）
  autocapitalize: "off", // 关闭首字母自动大写
  autocomplete: "off", // 关闭表单自动填充建议
  spellcheck: "false", // 关闭拼写检查（含红色下划线）
};

/**
 * 判断元素是否为可键入文本的输入控件。
 *
 * @param target - 事件或查询命中的目标节点
 * @returns 是文本输入控件（input / textarea / contenteditable）时为 true
 */
function isTextInputTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    target.isContentEditable
  );
}

/**
 * 在单个元素上应用全部“关闭纠正”属性。
 *
 * @param el - 目标输入控件元素
 */
function applyCorrectionOff(el: HTMLElement): void {
  for (const [name, value] of Object.entries(CORRECTION_OFF_ATTRS)) {
    el.setAttribute(name, value);
  }
}

/**
 * 处理 focusin 事件：聚焦到输入控件时补齐关闭属性。
 *
 * @param event - focusin 事件对象
 */
function handleFocusIn(event: FocusEvent): void {
  if (isTextInputTarget(event.target)) {
    applyCorrectionOff(event.target);
  }
}

/**
 * 全局关闭 WKWebView 原生输入纠正（自动修正气泡 / 拼写检查 / 自动大写）。
 *
 * 幂等：重复调用无副作用。应在 ReactDOM 渲染前调用一次。
 */
export function disableNativeTextCorrection(): void {
  // 1. 兜底存量：处理初始化时已存在于文档中的输入控件
  document
    .querySelectorAll<HTMLElement>("input, textarea, [contenteditable]")
    .forEach(applyCorrectionOff);

  // 2. 捕获阶段监听聚焦：覆盖之后动态创建/挂载的任意输入控件
  document.addEventListener("focusin", handleFocusIn, true);
}

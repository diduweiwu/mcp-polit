/**
 * 剪贴板工具。
 *
 * Tauri 的 WKWebView/WebView2 中 `navigator.clipboard` 常不可用
 * （secure context 与权限限制），直接调用会静默失败——复制功能统一走本工具：
 * 先用 execCommand 降级路径（同步执行于用户手势调用栈内，成功率最高），
 * 失败再回退 async Clipboard API。
 */

/**
 * 复制文本到剪贴板。
 *
 * @param text 要复制的文本
 * @returns 是否复制成功（调用方据此展示反馈，避免「假成功」误导用户）
 *
 * @example
 * const ok = await copyText(json);
 * setCopyState(ok ? "ok" : "fail");
 */
export async function copyText(text: string): Promise<boolean> {
  // 1. execCommand 降级（同步、在点击手势调用栈内执行，WKWebView 下最可靠）
  if (legacyCopy(text)) return true;
  // 2. 回退 async Clipboard API（secure context 下可用）
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** execCommand 降级复制：隐藏 textarea 选中后触发系统复制 */
function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  // 固定在视口内但不显示；readonly 防止 iOS 弹键盘
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.setAttribute("readonly", "");
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

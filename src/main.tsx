import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "allotment/dist/style.css";
import { disableNativeTextCorrection } from "./lib/disable-autocorrect";
import { appendDiagLog } from "./api";

// 关闭 WKWebView 原生输入纠正（macOS 键入时的自动修正气泡 / 拼写检查）
disableNativeTextCorrection();

// 窗口级拖放兜底：屏蔽 WebView 默认行为（拖入文件会触发导航打开、拖拽结束光标残留），
// 只 preventDefault 不 stopPropagation，不影响资源树的 HTML5 拖拽处理
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// 屏蔽 WebView 原生右键菜单（含「重新加载/Reload」等 WebView 调试项）；
// 输入框 / 文本域 / 富文本编辑器（CodeMirror）保留系统菜单，复制粘贴不受影响。
// 自绘右键菜单（资源树）在合成层已 stopPropagation，不会走到这里
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable]")) return;
  e.preventDefault();
});

/**
 * 前端全局异常落盘：JS 运行时错误与未处理的 Promise 拒绝写入 crash.log
 * （与后端 panic / ObjC 异常同一文件，跨会话可查）。
 *
 * 前端异常此前完全无痕（日志面板仅内存、重启即失）；落盘后与后端日志合并排查。
 * 截图/事件对象等非字符串直接 String() 化；写入失败静默（诊断不能反噬运行）。
 */
window.addEventListener("error", (e) => {
  const detail = e.error?.stack ?? e.message ?? String(e.error ?? "未知错误");
  appendDiagLog("JS_ERROR", `${e.message}\n${detail}`).catch(() => {});
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  const detail =
    reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason ?? "未知拒绝");
  appendDiagLog("JS_REJECTION", detail).catch(() => {});
});

// 浏览器演示模式：纯浏览器打开时注入 mock IPC（仅 DEV，生产构建不含）
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  await import("./dev-mock");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

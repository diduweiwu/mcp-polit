import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "allotment/dist/style.css";
import { disableNativeTextCorrection } from "./lib/disable-autocorrect";

// 关闭 WKWebView 原生输入纠正（macOS 键入时的自动修正气泡 / 拼写检查）
disableNativeTextCorrection();

// 窗口级拖放兜底：屏蔽 WebView 默认行为（拖入文件会触发导航打开、拖拽结束光标残留），
// 只 preventDefault 不 stopPropagation，不影响资源树的 HTML5 拖拽处理
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// 浏览器演示模式：纯浏览器打开时注入 mock IPC（仅 DEV，生产构建不含）
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  await import("./dev-mock");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "allotment/dist/style.css";

// 浏览器演示模式：纯浏览器打开时注入 mock IPC（仅 DEV，生产构建不含）
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  await import("./dev-mock");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

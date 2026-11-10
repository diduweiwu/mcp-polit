/**
 * 应用根组件：初始化设置与数据，装配顶栏 + 四栏工作台，订阅连接状态事件。
 */
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "./store";
import { applyThemeMode, watchSystemTheme } from "./theme";
import { TopBar } from "./components/TopBar";
import { Workspace } from "./components/Workspace";
import type { ConnStateEvent } from "./types";

export default function App() {
  const init = useAppStore((s) => s.init);
  const applyConnState = useAppStore((s) => s.applyConnState);

  useEffect(() => {
    void init();
    // 订阅后端连接状态推送
    const unlisten = listen<ConnStateEvent>("conn-state", (ev) => {
      applyConnState(ev.payload);
    });
    // 跟随系统主题：系统明暗变化时若当前为 system 模式则实时切换
    const unwatch = watchSystemTheme(() => {
      if (useAppStore.getState().themeMode === "system") {
        applyThemeMode("system");
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
      unwatch();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <TopBar />
      <Workspace />
    </div>
  );
}

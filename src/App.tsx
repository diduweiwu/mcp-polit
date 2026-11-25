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
    // 原生菜单「检查更新」（macOS 应用菜单 / Win·Linux 菜单栏）：打开设置弹窗
    // 并自动切「关于」tab 检查一次（复用设置页的整套检查/下载/安装 UI）
    const unlistenMenu = listen("menu-check-updates", () => {
      useAppStore.getState().openSettings(true);
    });
    // 跟随系统主题：系统明暗变化时若当前为 system 模式则实时切换
    const unwatch = watchSystemTheme(() => {
      if (useAppStore.getState().themeMode === "system") {
        applyThemeMode("system");
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
      void unlistenMenu.then((fn) => fn());
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

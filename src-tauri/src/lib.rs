//! MCPilot 应用入口：装配数据库、MCP 连接管理器与全部 Tauri 命令。
//!
//! 数据隐私：全部数据仅保存在本机应用数据目录下的 SQLite 文件中，
//! 不接入任何遥测/上报能力。

mod commands;
mod db;
mod diag;
mod error;
mod mcp_manager;
mod menu;
mod models;
mod sync;

use tauri::{Emitter, Manager};

use db::Db;

/// 退出前清理：断开全部 MCP 连接（回收 stdio 子进程）。
fn on_exit(app: &tauri::AppHandle) {
    let runtime = app.state::<tauri::async_runtime::Runtime>();
    runtime.block_on(mcp_manager::McpManager::disconnect_all(app));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(mcp_manager::McpManager::new())
        // 在线更新：走 GitHub Release 的 latest.json（签名校验），安装后由 process 插件重启
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 应用菜单三平台统一自建（menu::install）：macOS 关闭默认菜单避免闪现，
        // 「检查更新」项点击后转发事件给前端复用设置页的更新流程
        .enable_macos_default_menu(false)
        .on_menu_event(|app, event| {
            if event.id() == menu::MENU_CHECK_UPDATES {
                let _ = app.emit_to("main", "menu-check-updates", ());
            }
        })
        // macOS 红绿灯定位：decorum 插件（社区方案，Hoppscotch 生产同款机制）。
        // 仅注册即可：macOS 上插件在 on_window_ready 自动挪按钮（默认 inset 12,16）
        // 并挂 NSWindowDelegate 在 resize/退出全屏时重钉；Windows/Linux 为空操作。
        // 纯 Rust API，无需 capabilities 权限与前端 binding。
        .plugin(tauri_plugin_decorum::init())
        // 系统目录选择对话框：项目同步目录「选择目录」按钮（前端 @tauri-apps/plugin-dialog）
        .plugin(tauri_plugin_dialog::init())
        // 系统默认浏览器打开 URL：顶栏、关于页的 GitHub 仓库入口（前端 @tauri-apps/plugin-opener）
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 数据库文件位置：系统应用数据目录/<identifier>/mcpilot.db
            let data_dir = app.path().app_data_dir()?;
            let db_path = data_dir.join("mcpilot.db");
            let conn = db::init(&db_path)?;
            app.manage(Db(std::sync::Mutex::new(conn)));

            // 诊断留痕：panic 与 ObjC 未捕获异常（SIGABRT 类崩溃，panic 钩子拿不到）
            // 都写入本地 crash.log 供事后定位；前端 JS 异常经 append_diag_log 命令写入
            let crash_log = data_dir.join("crash.log");
            diag::install_panic_logger(crash_log.clone());
            #[cfg(target_os = "macos")]
            diag::install_uncaught_exception_logger(crash_log.clone());
            app.manage(diag::DiagLog(crash_log));

            // 主窗口手动构建
            let builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("MCPilot — 本地 MCP 调试工作台")
            .inner_size(1360.0, 840.0)
            .min_inner_size(1000.0, 620.0)
            .center()
            // 禁用 wry 原生拖放拦截：默认它接管全部 OS 拖放事件（为文件拖放生成
            // DragDropEvent），会导致 WKWebView/WebView2 内 HTML5 拖拽（资源树
            // 拖拽移动）的 dragover/drop 事件到不了 JS 层。本应用无文件拖放
            // 需求（前端未监听 DragDropEvent），禁用后 HTML5 DnD 恢复正常。
            .disable_drag_drop_handler();
            // macOS：Overlay 标题栏 + 隐藏标题文字。
            // 历史定论（见 git 历史）：2026-11-17 曾两次自研挪按钮均回滚——
            // traffic_light_position 被 wry 布局重置冲掉（wry#1747），
            // 复刻 wry 重钉则因新系统标题栏容器结构变化直接错位。
            // 本次换 tauri-plugin-decorum 第三次尝试（同为「挪按钮 + delegate
            // 重钉」机制，社区维护、Hoppscotch 生产验证）。若仍错位，
            // 回滚 = 删 decorum 注册、下方 inset 调用与 Cargo 依赖三处。
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            let _win = builder.build()?;
            // macOS：红绿灯与 48px 顶栏垂直居中（按钮中心距窗口顶 24）。
            // decorum 几何推导（按钮高 16 实测）：中心距顶 = y/2 + 12 → y = 24；
            // x = 12 保持默认水平位（TopBar pl-[84px] 避让不变）。
            // 已知缺陷：插件 resize 重钉硬编码默认 inset(12,16)，窗口缩放后
            // 按钮会回落 4pt——先验证初始定位可行，回落问题后续再补。
            #[cfg(target_os = "macos")]
            {
                use tauri_plugin_decorum::WebviewWindowExt as _;
                _win.set_traffic_lights_inset(12.0, 24.0)?;
            }

            // 原生菜单：三平台统一（macOS 应用菜单 / Win·Linux 窗口菜单栏）
            menu::install(app.handle())?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗即退出（单窗口应用），退出前断开全部连接
            if let tauri::WindowEvent::Destroyed = event {
                on_exit(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            // 项目
            commands::list_projects,
            commands::create_project,
            commands::sync_dir_status,
            commands::rename_project,
            commands::update_project_sync_dir,
            commands::open_dir,
            commands::delete_project,
            // 树节点
            commands::list_nodes,
            commands::create_node,
            commands::rename_node,
            commands::set_node_icon,
            commands::move_node,
            commands::delete_node,
            commands::duplicate_node,
            // Server 配置
            commands::get_server_config,
            commands::save_server_config,
            // 项目级环境库（环境变量在环境中定义，Server 配置以 {{变量名}} 引用）
            commands::list_environments,
            commands::save_environments,
            commands::migrate_legacy_envs,
            // 连接与调用
            commands::connect_server,
            commands::disconnect_server,
            commands::cancel_connect_server,
            commands::test_server_config,
            commands::refresh_tools,
            commands::call_tool,
            commands::get_conn_state,
            commands::get_cached_tools,
            // 应用设置
            commands::get_settings,
            commands::save_setting,
            // 调用历史
            commands::append_history,
            // 诊断（前端异常落盘 crash.log）
            commands::append_diag_log,
            commands::list_history,
            commands::clear_history,
            commands::set_history_starred,
            commands::list_starred_history,
            // Git 同步（项目级：推送/拉取/分支/实时自动导出）
            commands::project_sync_push,
            commands::project_sync_pull,
            commands::project_sync_export,
            commands::project_branches,
            commands::project_checkout,
            commands::project_sync_changes,
        ])
        .build(tauri::generate_context!())
        .expect("MCPilot 启动失败");
    // 事件循环：退出事件留痕——与 PANIC 日志配合区分「闪退（panic）」与「被正常退出路径带走」
    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { code, .. } => {
            let path = app_handle.state::<diag::DiagLog>().0.clone();
            diag::append_diag(&path, "EXIT", &format!("收到退出请求 code={code:?}"));
        }
        tauri::RunEvent::Exit => {
            let path = app_handle.state::<diag::DiagLog>().0.clone();
            diag::append_diag(&path, "EXIT", "进程退出");
        }
        _ => {}
    });
}

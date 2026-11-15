//! MCPilot 应用入口：装配数据库、MCP 连接管理器与全部 Tauri 命令。
//!
//! 数据隐私：全部数据仅保存在本机应用数据目录下的 SQLite 文件中，
//! 不接入任何遥测/上报能力。

mod commands;
mod db;
mod error;
mod mcp_manager;
mod models;
mod sync;

use tauri::Manager;

use db::Db;

/// macOS：把红绿灯按钮的垂直位置对齐到指定中心（窗口顶部起算的逻辑像素）。
///
/// 背景：wry 的 `traffic_light_position` 的 y 只拉高标题栏容器高度，
/// `inset_traffic_lights` 每次重绘只重设按钮的 x 坐标——按钮 y 永远贴顶，
/// 所以这里用 objc2 直接改按钮 frame。
///
/// 「距窗口顶部的距离」统一用**屏幕坐标系**测量（AppKit 各级 view 的
/// flipped 方向不一，窗口内坐标做绝对参考会偏差）：
///   按钮屏幕坐标 - 窗口屏幕坐标 = 按钮距窗口顶部（屏幕系 y 向下，直接相减即得）。
/// 仍保留探测差分：origin.y 每 +1 对应的视觉位移量由实测得出，不假设方向。
///
/// # 参数
///
/// - `window`: 已创建的主窗口
/// - `target_center`: 按钮期望的中心（距窗口顶部，逻辑像素；顶栏 48px → 传 24）
///
/// # 异常
///
/// 按钮不存在或 NSWindow 指针无效时静默返回（不影响启动）。
#[cfg(target_os = "macos")]
fn align_traffic_lights(window: &tauri::WebviewWindow, target_center: f64) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};
    use objc2_foundation::{NSPoint, NSRect};

    let Ok(raw) = window.ns_window() else {
        return;
    };
    if raw.is_null() {
        return;
    }
    let ns_win = unsafe { &*(raw as *const NSWindow) };

    /// 按钮中心当前距窗口顶部的距离（逻辑像素，屏幕坐标系测量）。
    fn center_from_top(view: &NSView, ns_win: &NSWindow) -> f64 {
        let base = view.convertRect_toView(NSView::frame(view), None);
        let screen = ns_win.convertRectToScreen(base);
        let win = ns_win.frame();
        // 屏幕 y 向下：按钮屏幕 y - 窗口屏幕 y = 距窗口顶
        screen.origin.y - win.origin.y
    }

    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        let button: *mut AnyObject =
            unsafe { msg_send![ns_win, standardWindowButton: kind] };
        if button.is_null() {
            continue;
        }
        let view = unsafe { &*(button as *const NSView) };
        let f0 = NSView::frame(view);

        // 1. 当前中心距顶
        let d0 = center_from_top(view, ns_win);
        // 2. 试探：origin.y + 100，测方向系数
        NSView::setFrameOrigin(view, NSPoint { x: f0.origin.x, y: f0.origin.y + 100.0 });
        let d1 = center_from_top(view, ns_win);
        // 3. 回退
        NSView::setFrameOrigin(view, f0.origin);
        let per_unit = d0 - d1; // origin.y 每 +1 对应「距顶」的变化量（通常为 -1）
        if per_unit.abs() < 0.001 {
            continue; // 移动无效（异常环境），跳过
        }
        // 4. 线性外推精确目标
        let target_y = f0.origin.y + (d0 - target_center) / per_unit;
        NSView::setFrameOrigin(view, NSPoint { x: f0.origin.x, y: target_y });
    }
}

/// 退出前清理：断开全部 MCP 连接（回收 stdio 子进程）。
fn on_exit(app: &tauri::AppHandle) {
    let runtime = app.state::<tauri::async_runtime::Runtime>();
    runtime.block_on(mcp_manager::McpManager::disconnect_all(app));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(mcp_manager::McpManager::new())
        .setup(|app| {
            // 数据库文件位置：系统应用数据目录/<identifier>/mcpilot.db
            let data_dir = app.path().app_data_dir()?;
            let db_path = data_dir.join("mcpilot.db");
            let conn = db::init(&db_path)?;
            app.manage(Db(std::sync::Mutex::new(conn)));

            // 主窗口手动构建（conf 声明式窗口无法设置红绿灯的逻辑坐标）
            let builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("MCPilot — 本地 MCP 调试工作台")
            .inner_size(1360.0, 840.0)
            .min_inner_size(1000.0, 620.0)
            .center();
            // macOS：Overlay 标题栏 + 标题栏容器拉高到 48（y=32：容器高 = 按钮高16 + y）
            // 按钮的垂直位置随后由 align_traffic_lights 精确对齐
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(20.0, 32.0));
            let win = builder.build()?;

            // macOS：红绿灯与 48px 顶栏垂直居中（按钮中心 = 24px）
            #[cfg(target_os = "macos")]
            align_traffic_lights(&win, 24.0);

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
            commands::rename_project,
            commands::delete_project,
            // 树节点
            commands::list_nodes,
            commands::create_node,
            commands::rename_node,
            commands::move_node,
            commands::delete_node,
            // Server 配置
            commands::get_server_config,
            commands::save_server_config,
            // 连接与调用
            commands::connect_server,
            commands::disconnect_server,
            commands::refresh_tools,
            commands::call_tool,
            commands::get_conn_state,
            commands::get_cached_tools,
            // 应用设置
            commands::get_settings,
            commands::save_setting,
            // Git 同步
            commands::sync_export,
            commands::sync_import,
            commands::project_sync_push,
            commands::project_sync_pull,
            commands::project_branches,
            commands::project_checkout,
        ])
        .run(tauri::generate_context!())
        .expect("MCPilot 启动失败");
}

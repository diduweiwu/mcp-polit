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
/// 所以这里用 objc2 直接改按钮 frame 的 origin.y。
///
/// # 参数
///
/// - `window`: 已创建的主窗口
/// - `center_y`: 三个按钮期望的中心（距窗口顶部，逻辑像素；顶栏 48px → 传 24）
///
/// # 异常
///
/// 按钮不存在或 NSWindow 指针无效时静默返回（不影响启动）。
#[cfg(target_os = "macos")]
fn align_traffic_lights(window: &tauri::WebviewWindow, center_y: f64) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSView, NSWindowButton};

    let Ok(raw) = window.ns_window() else {
        return;
    };
    if raw.is_null() {
        return;
    }
    let ns_win = raw as *mut AnyObject;

    // 按钮直径 12，frame 高约 16：origin.y = 中心 - 半高
    let target_y = center_y - 8.0;

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
        // 注意：objc2-app-kit 0.3 中这两个方法本身是安全的（内部自动处理消息发送）
        let mut frame = NSView::frame(view);
        frame.origin.y = target_y;
        NSView::setFrameOrigin(view, frame.origin);
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
        ])
        .run(tauri::generate_context!())
        .expect("MCPilot 启动失败");
}

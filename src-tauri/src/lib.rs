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

/// 退出前清理：断开全部 MCP 连接（回收 stdio 子进程）。
fn on_exit(app: &tauri::AppHandle) {
    let runtime = app.state::<tauri::async_runtime::Runtime>();
    runtime.block_on(mcp_manager::McpManager::disconnect_all(app));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(mcp_manager::McpManager::new())
        // 在线更新：走 GitHub Release 的 latest.json（签名校验），安装后由 process 插件重启
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 数据库文件位置：系统应用数据目录/<identifier>/mcpilot.db
            let data_dir = app.path().app_data_dir()?;
            let db_path = data_dir.join("mcpilot.db");
            let conn = db::init(&db_path)?;
            app.manage(Db(std::sync::Mutex::new(conn)));

            // 主窗口手动构建
            let builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("MCPilot — 本地 MCP 调试工作台")
            .inner_size(1360.0, 840.0)
            .min_inner_size(1000.0, 620.0)
            .center();
            // macOS：Overlay 标题栏 + 红绿灯垂直定位
            //
            // 实测（见 git 历史）：按钮固定在标题栏容器内 origin.y=6、高 16（中心距容器底 14），
            // 容器高度 = 16 + y（wry 的 y 参数只调容器高度、不动按钮 y）。
            // 要按钮中心距窗口顶 24（与 48px 顶栏垂直居中）：容器高 = 14 + 24 = 38 → y = 22。
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(20.0, 22.0));
            let _win = builder.build()?;

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

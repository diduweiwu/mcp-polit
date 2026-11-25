//! 应用原生菜单：三平台统一构建并挂载。
//!
//! - **macOS**：挂左上角苹果 logo 旁的应用菜单（应用名子菜单含「检查更新」）
//! - **Windows / Linux**：同一份菜单显示为窗口顶部的菜单栏（Tauri 默认菜单只在
//!   macOS 自动创建，这里三平台统一自建，行为一致）
//!
//! 结构复刻 Tauri 默认菜单（预定义项：关于/服务/隐藏/退出/编辑/窗口），并插入
//! 「检查更新」项：点击后经 `menu-check-updates` 事件通知前端，前端复用设置页
//! 「关于」tab 的检查/下载/安装 UI，更新流程零重复实现。

use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle,
};

/// 「检查更新」菜单项 ID（`on_menu_event` 按此匹配）
pub const MENU_CHECK_UPDATES: &str = "check-updates";

/// 构建并挂载应用菜单（setup 阶段调用一次）。
///
/// # 异常
///
/// 菜单项创建失败（系统资源异常等极少见情况）时返回 `Err`，由调用方在 setup 中传播。
///
/// # 示例
///
/// ```text
/// // lib.rs 的 setup 里：
/// menu::install(app.handle())?;
/// ```
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let pkg = app.package_info();
    let about_metadata = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };
    let check_updates =
        MenuItem::with_id(app, MENU_CHECK_UPDATES, "检查更新", true, None::<&str>)?;

    /* 应用菜单：macOS 惯例全量复刻（关于/服务/隐藏/退出）+ 检查更新；
       Windows/Linux 精简为 关于/检查更新/退出（无服务/隐藏概念） */
    let about = PredefinedMenuItem::about(app, None, Some(about_metadata))?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    #[cfg(target_os = "macos")]
    let services = PredefinedMenuItem::services(app, None)?;
    #[cfg(target_os = "macos")]
    let sep3 = PredefinedMenuItem::separator(app)?;
    #[cfg(target_os = "macos")]
    let hide = PredefinedMenuItem::hide(app, None)?;
    #[cfg(target_os = "macos")]
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    #[cfg(target_os = "macos")]
    let sep4 = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let app_menu = Submenu::with_items(
        app,
        pkg.name.clone(),
        true,
        &[
            &about,
            &sep1,
            &check_updates,
            &sep2,
            #[cfg(target_os = "macos")]
            &services,
            #[cfg(target_os = "macos")]
            &sep3,
            #[cfg(target_os = "macos")]
            &hide,
            #[cfg(target_os = "macos")]
            &hide_others,
            #[cfg(target_os = "macos")]
            &sep4,
            &quit,
        ],
    )?;

    /* 编辑菜单：文本编辑标准项（保证 macOS 常规 Cmd+C/V/X/A 快捷键语义完整）；
       Linux 无 libxdo 特性时个别项可能不生效，仅展示无副作用 */
    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let sep5 = PredefinedMenuItem::separator(app)?;
    let sep6 = PredefinedMenuItem::separator(app)?;
    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[&undo, &redo, &sep5, &cut, &copy, &paste, &sep6, &select_all],
    )?;

    /* 窗口菜单：最小化/最大化/关闭（macOS 惯例关闭项与最大化之间有分隔线） */
    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let maximize = PredefinedMenuItem::maximize(app, None)?;
    let close = PredefinedMenuItem::close_window(app, None)?;
    let sep7 = PredefinedMenuItem::separator(app)?;
    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &minimize,
            &maximize,
            #[cfg(target_os = "macos")]
            &sep7,
            &close,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
    app.set_menu(menu)?;
    Ok(())
}

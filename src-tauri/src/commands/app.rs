use crate::{
    capture,
    config::{BgTemplate, ConfigStore, CustomProvider, Settings, ShortcutAction, ShortcutCapture},
    drive::DriveClient,
    icon_cache,
    meta::MetaStore,
    overlay, sync, tag::{Tag, TagStore}, tray, CaptureMeta,
};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_clipboard_manager::ClipboardExt;

#[tauri::command]
pub fn has_builtin_credentials() -> bool {
    crate::config::has_builtin_credentials()
}

#[tauri::command]
pub fn window_ready(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let _ = window.set_always_on_top(false);
    let _ = window.set_focus();
}

#[tauri::command]
pub fn is_gallery_open(app: AppHandle) -> bool {
    if let Some(win) = app.get_webview_window("main") {
        win.is_visible().unwrap_or(false)
    } else {
        false
    }
}

#[tauri::command]
pub fn get_settings(config: State<'_, Arc<ConfigStore>>) -> Settings {
    config.get()
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    config: State<'_, Arc<ConfigStore>>,
    settings: Settings,
) -> Result<(), String> {
    let old = config.get();
    config.save(settings.clone()).map_err(|e| e.to_string())?;
    tray::register_hotkeys(&app);
    tray::refresh_tray_menu(&app);
    let autostart_changed = settings.autostart != old.autostart;
    let admin_changed = settings.run_as_admin != old.run_as_admin;
    if admin_changed {
        crate::win_util::update_start_menu_shortcut(settings.run_as_admin);
    }
    if autostart_changed || admin_changed {
        if settings.run_as_admin {
            // Admin mode: use Task Scheduler when elevated; registry autostart is removed
            let _ = app.autolaunch().disable();
            if settings.autostart && crate::win_util::is_elevated() {
                if let Err(e) = crate::win_util::create_admin_autostart() {
                    log::warn!("failed to create admin autostart task: {e}");
                }
            } else if !settings.autostart {
                crate::win_util::remove_admin_autostart();
            }
        } else {
            // Normal mode: remove any scheduled task and use the registry
            crate::win_util::remove_admin_autostart();
            let result = if settings.autostart {
                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            };
            if let Err(e) = result {
                log::warn!("failed to set autostart: {e}");
            }
        }
    }
    if settings.resolved_screenshots_dir() != old.resolved_screenshots_dir() {
        sync::restart_watcher(&app);
        sync::scan_and_enqueue(&app);
    }
    if settings.drive_folder_name != old.drive_folder_name {
        tray::on_library_folder_change(&app);
    }
    let _ = app.emit("settings-changed", ());
    Ok(())
}

#[derive(Serialize)]
pub struct DriveStatus {
    connected: bool,
    email: Option<String>,
    name: Option<String>,
    photo: Option<String>,
}

#[derive(Serialize)]
pub struct DriveFolderInfo {
    id: String,
    name: String,
    empty: bool,
    is_shotcove: bool,
}

fn is_shotcove_filename(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    if stem.len() < 19 { return false; }
    let b = stem.as_bytes();
    b[4] == b'-' && b[7] == b'-' && b[10] == b'_' && b[13] == b'-' && b[16] == b'-'
        && b[..19].iter().enumerate().all(|(i, &c)| matches!(i, 4|7|10|13|16) || c.is_ascii_digit())
}

#[tauri::command]
pub async fn list_drive_folders(
    config: State<'_, Arc<ConfigStore>>,
    drive: State<'_, Arc<DriveClient>>,
) -> Result<Vec<DriveFolderInfo>, String> {
    if !drive.is_connected() {
        return Err("Drive not connected".into());
    }
    let settings = config.get();
    let cid = settings.effective_google_client_id().to_string();
    let csec = settings.effective_google_client_secret().to_string();
    let folders = drive.list_root_folders(&cid, &csec).await.map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for (id, name) in folders {
        let files = drive.list_folder_file_names(&cid, &csec, &id, 20).await.unwrap_or_default();
        let empty = files.is_empty();
        let is_shotcove = files.iter().any(|f| is_shotcove_filename(f));
        result.push(DriveFolderInfo { id, name, empty, is_shotcove });
    }
    Ok(result)
}

#[tauri::command]
pub fn get_drive_status(drive: State<'_, Arc<DriveClient>>) -> DriveStatus {
    DriveStatus {
        connected: drive.is_connected(),
        email: drive.account_email(),
        name: drive.account_name(),
        photo: drive.account_photo(),
    }
}

#[tauri::command]
pub async fn connect_drive(
    app: AppHandle,
    config: State<'_, Arc<ConfigStore>>,
    drive: State<'_, Arc<DriveClient>>,
    login_hint: Option<String>,
) -> Result<String, String> {
    let settings = config.get();
    let opener_app = app.clone();
    let email = drive
        .authorize(
            settings.effective_google_client_id(),
            settings.effective_google_client_secret(),
            login_hint.as_deref(),
            move |url| {
                use tauri_plugin_opener::OpenerExt;
                let _ = opener_app.opener().open_url(url, None::<&str>);
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    sync::scan_and_enqueue(&app);
    let drain_app = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::library::drain_offline_ops(&drain_app).await;
    });
    let sync_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = sync::sync_metadata_and_icons(&sync_app).await;
    });
    Ok(email)
}

#[tauri::command]
pub fn disconnect_drive(drive: State<'_, Arc<DriveClient>>) {
    drive.disconnect();
}

#[tauri::command]
pub async fn direct_link_upload(
    app: AppHandle,
    config: State<'_, Arc<ConfigStore>>,
    data: String,
) -> Result<String, String> {
    let settings = config.get();
    if !crate::direct_link::any_provider_enabled(&settings) {
        return Err("No direct link provider is enabled (Settings → Direct Link)".into());
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(&data).map_err(|e| e.to_string())?;
    let url = crate::direct_link::upload_to_provider(&settings, "screenshot.png", &bytes)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.clipboard().write_text(&url);
    Ok(url)
}

#[tauri::command]
pub fn sync_now(app: AppHandle) {
    sync::scan_and_enqueue(&app);
    let sync_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = sync::sync_metadata_and_icons(&sync_app).await;
    });
}

#[tauri::command]
pub fn open_screenshots_folder(app: AppHandle) {
    tray::open_folder(&app);
}

#[tauri::command]
pub fn open_settings(app: AppHandle) {
    tray::show_settings(&app);
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(picked.map(|p| p.to_string()))
}

#[tauri::command]
pub fn take_screenshot(
    app: AppHandle,
    config: State<'_, Arc<ConfigStore>>,
    slot_id: String,
) -> Result<(), String> {
    let settings = config.get();
    let slot = settings
        .shortcuts
        .iter()
        .find(|s| s.id == slot_id)
        .ok_or_else(|| format!("unknown slot: {slot_id}"))?;
    overlay::trigger(&app, slot.capture.clone(), slot.actions.clone(), slot.multi_monitor, slot.bg_template.clone());
    Ok(())
}

/// Triggers an ad-hoc capture (gallery sidebar buttons) without going through a configured
/// shortcut slot. Always opens the editor afterwards and spans all monitors.
#[tauri::command]
pub fn quick_capture(app: AppHandle, mode: String) -> Result<(), String> {
    let capture = match mode.as_str() {
        "area" => ShortcutCapture::Area,
        "fullscreen" => ShortcutCapture::Fullscreen,
        "window" => ShortcutCapture::Window,
        _ => return Err(format!("unknown capture mode: {mode}")),
    };
    overlay::trigger(&app, capture, vec![ShortcutAction::OpenEditor], true, Default::default());
    Ok(())
}

/// Opens the editor pinned to designing the background template for `slot_id`:
/// takes a quick screenshot of the current monitor just so there's something
/// real to preview the gradient/padding/shadow against.
#[tauri::command]
pub async fn start_bg_template_capture(app: AppHandle, slot_id: String) -> Result<(), String> {
    let cfg = app.state::<Arc<ConfigStore>>().get();
    let existing = if slot_id == "printscreen" {
        cfg.printscreen_bg_template.clone()
    } else {
        cfg.shortcuts.iter().find(|s| s.id == slot_id).and_then(|s| s.bg_template.clone())
    };
    let cap = tauri::async_runtime::spawn_blocking(capture::capture_current_monitor)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let meta = CaptureMeta { bg_template: existing, ..Default::default() };
    overlay::open_editor_for_template(&app, cap.image, meta, slot_id);
    Ok(())
}

/// Saves the editor's current background settings as the named shortcut's
/// template, then closes the (template-mode) editor window.
#[tauri::command]
pub fn save_bg_template(app: AppHandle, window: tauri::WebviewWindow, slot_id: String, template: BgTemplate) -> Result<(), String> {
    let config = app.state::<Arc<ConfigStore>>();
    let mut settings = config.get();
    if slot_id == "printscreen" {
        settings.printscreen_bg_template = Some(template);
    } else {
        let Some(slot) = settings.shortcuts.iter_mut().find(|s| s.id == slot_id) else {
            return Err(format!("unknown slot: {slot_id}"));
        };
        slot.bg_template = Some(template);
    }
    config.save(settings).map_err(|e| e.to_string())?;
    // Shortcut hotkeys capture their slot's bg_template into the closure at
    // registration time — without this, a freshly-saved template would be
    // invisible to the actual shortcut until the next unrelated settings save.
    tray::register_hotkeys(&app);
    let _ = app.emit("settings-changed", ());
    let _ = window.close();
    Ok(())
}

#[tauri::command]
pub fn get_app_icon(app: AppHandle, app_name: String) -> Result<String, String> {
    let ic = app.state::<Arc<icon_cache::IconCache>>();
    ic.get_base64(&app_name).ok_or_else(|| "not cached".to_string())
}

// ---------------------------------------------------------------------------
// Admin / elevation commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_is_elevated() -> bool {
    crate::win_util::is_elevated()
}

/// True when running from an installed MSIX/AppX package (e.g. Microsoft Store).
/// Such installs are updated by the Store, not by the in-app updater.
#[tauri::command]
pub fn is_packaged_install() -> bool {
    crate::win_util::is_packaged()
}

/// Re-launches the app with UAC elevation and exits the current process.
#[tauri::command]
pub fn request_admin() {
    crate::win_util::restart_as_admin();
}

// ---------------------------------------------------------------------------
// Tag commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_tags(tags: State<'_, Arc<TagStore>>) -> Vec<Tag> {
    tags.get_all()
}

#[tauri::command]
pub fn save_tags(tags: State<'_, Arc<TagStore>>, list: Vec<Tag>) {
    tags.save(list);
}

#[tauri::command]
pub fn set_image_tags(
    meta: State<'_, Arc<MetaStore>>,
    filename: String,
    tag_ids: Vec<String>,
) {
    let mut m = meta.get(&filename).unwrap_or_default();
    m.tags = tag_ids;
    meta.set(filename, m);
}

#[derive(Serialize)]
pub struct TestProviderResult {
    pub status: u16,
    pub headers: String,
    pub body: String,
}

#[tauri::command]
pub async fn test_custom_provider(provider: CustomProvider) -> Result<TestProviderResult, String> {
    let (status, headers, body) = crate::direct_link::test_custom_provider(&provider)
        .await
        .map_err(|e| e.to_string())?;
    Ok(TestProviderResult { status, headers, body })
}

#[tauri::command]
pub fn is_gallery_locked(state: State<'_, crate::GalleryLocked>) -> bool {
    state.0.load(std::sync::atomic::Ordering::Relaxed)
}

#[derive(Serialize)]
pub struct PlatformCapabilities {
    pub os: &'static str,
    /// Whether the window picker (select-a-window capture) is expected to work.
    /// False on native Wayland sessions, where per-window introspection isn't available.
    pub window_capture: bool,
    /// True on Linux when running under native Wayland (not XWayland) — window
    /// capture is limited to X11/XWayland clients, so the UI should explain this.
    pub wayland_limited: bool,
}

#[tauri::command]
pub fn platform_capabilities() -> PlatformCapabilities {
    #[cfg(target_os = "windows")]
    {
        PlatformCapabilities { os: "windows", window_capture: true, wayland_limited: false }
    }
    #[cfg(target_os = "macos")]
    {
        PlatformCapabilities { os: "macos", window_capture: true, wayland_limited: false }
    }
    #[cfg(target_os = "linux")]
    {
        let wayland = std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false)
            || std::env::var("WAYLAND_DISPLAY").is_ok();
        PlatformCapabilities { os: "linux", window_capture: !wayland, wayland_limited: wayland }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        PlatformCapabilities { os: "unknown", window_capture: false, wayland_limited: false }
    }
}

/// Probes the macOS Screen Recording permission (a real, tiny capture — see
/// `capture_macos::probe_permission`) and caches the result so `overlay::trigger`
/// can skip attempting captures it already knows will come back blank.
/// No-op (always granted) on other platforms.
#[tauri::command]
pub async fn check_screen_permission(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let granted = tauri::async_runtime::spawn_blocking(crate::capture_macos::probe_permission)
            .await
            .unwrap_or(false);
        app.state::<crate::ScreenPermission>().0.store(if granted { 1 } else { 2 }, std::sync::atomic::Ordering::Relaxed);
        Ok(granted)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(true)
    }
}

/// Opens the macOS Screen Recording privacy pane so the user can grant (or
/// review) the permission for this app.
#[tauri::command]
pub fn open_screen_recording_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn();
    }
}

#[tauri::command]
pub fn flash_settings(#[allow(unused_variables)] app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{FlashWindowEx, FLASHWINFO, FLASHW_CAPTION};
        if let Some(sw) = app.get_webview_window("settings") {
            if let Ok(raw) = sw.hwnd() {
                let hwnd = windows::Win32::Foundation::HWND(raw.0 as usize as *mut _);
                unsafe {
                    let mut info = FLASHWINFO {
                        cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
                        hwnd,
                        dwFlags: FLASHW_CAPTION,
                        uCount: 3,
                        dwTimeout: 0,
                    };
                    let _ = FlashWindowEx(&mut info);
                }
            }
        }
    }
}


mod capture;
#[cfg(target_os = "macos")]
mod capture_macos;
mod clipboard_file;
mod commands;
mod config;
mod drive;
mod icon_cache;
mod direct_link;
mod library;
mod meta;
mod overlay;
#[cfg(debug_assertions)]
mod store_screenshots;
mod sync;
mod tag;
mod tray;
mod translate;
mod win_util;

use config::ConfigStore;
use drive::DriveClient;
use image::RgbaImage;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use sync::SyncState;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};
use tauri_plugin_notification::NotificationExt;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
pub(crate) struct WindowCropInfo {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub label: String,
    pub app: String,
}

#[derive(Clone, Default)]
pub(crate) struct CaptureMeta {
    pub title: Option<String>,
    pub app: Option<String>,
    pub is_window: bool,
    pub tags: Vec<String>,
    /// Monitor rects within the combined image: [x, y, w, h] per monitor (fullscreen only).
    pub monitor_rects: Vec<[u32; 4]>,
    pub monitor_names: Vec<String>,
    /// Visible window rects within the combined image (fullscreen only).
    pub window_crops: Vec<WindowCropInfo>,
    /// Set only for template-design editor sessions, to pre-load the
    /// shortcut's existing background template (if any) on open.
    pub bg_template: Option<config::BgTemplate>,
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum OverlayMode {
    Area,
    AreaMulti, // multi-monitor area selection — one overlay per monitor
    Window,
}

#[derive(Clone)]
pub(crate) struct MonitorInfo {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub scale: f32,
}

pub(crate) struct PendingCapture {
    pub image: RgbaImage,
    pub image_jpeg: Option<String>,
    pub scale: f32,
    pub actions: Vec<config::ShortcutAction>,
    pub meta: CaptureMeta,
    pub mode: OverlayMode,
    pub windows: Vec<capture::WinInfo>,
    pub mon_x: i32, // for AreaMulti: combined image origin_x
    pub mon_y: i32, // for AreaMulti: combined image origin_y
    pub mon_w: u32,
    pub mon_h: u32,
    pub monitors: Vec<MonitorInfo>,
    pub mon_jpegs: Vec<String>, // per-monitor JPEG b64 (AreaMulti only)
    pub live_mode: bool,        // true = capture fresh on selection; false = crop pre-captured image
    pub mon_images: Vec<RgbaImage>, // per-monitor raw images for AreaMulti frozen mode
    /// `None` means the shortcut has no custom background — and thus no
    /// padding at all should be applied when saving directly.
    pub bg_template: Option<config::BgTemplate>,
}

#[derive(Default)]
pub(crate) struct Pending(pub Mutex<Option<PendingCapture>>);

#[derive(Default)]
pub(crate) struct PendingEditMeta(pub Mutex<std::collections::HashMap<String, CaptureMeta>>);

#[derive(Default)]
pub(crate) struct PendingEdit(pub Mutex<std::collections::HashMap<String, Vec<u8>>>);

/// Maps editor window label → original source filename (set when opening a file for editing)
#[derive(Default)]
pub(crate) struct PendingEditFilename(pub Mutex<std::collections::HashMap<String, String>>);

#[derive(Default)]
pub(crate) struct PopupJustHidden(pub Mutex<Option<Instant>>);

#[derive(Default)]
pub(crate) struct PopupDestroyTimer(pub Mutex<Option<tauri::async_runtime::JoinHandle<()>>>);

#[derive(Default)]
pub(crate) struct PopupHideTimer(pub Mutex<Option<tauri::async_runtime::JoinHandle<()>>>);


pub(crate) struct GalleryLocked(pub std::sync::atomic::AtomicBool);

/// Tri-state cache of the macOS Screen Recording permission: 0 = not checked
/// yet, 1 = granted, 2 = denied. Avoids re-probing (which performs a real,
/// tiny capture) on every shortcut press; only re-checked when the gallery is
/// opened while the cached state isn't "granted".
#[cfg(target_os = "macos")]
pub(crate) struct ScreenPermission(pub std::sync::atomic::AtomicU8);

// ---------------------------------------------------------------------------
// Notification helpers
// ---------------------------------------------------------------------------

pub(crate) fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

pub(crate) fn notify_error(app: &AppHandle, body: &str) {
    notify(app, "Shotcove — Error", body);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    let _ = env_logger::try_init();
    win_util::set_app_user_model_id();
    if !win_util::acquire_single_instance() {
        return;
    }
    tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_filter(|label| {
                    label != "overlay" && !label.starts_with("overlay-")
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Pending::default())
        .manage(PendingEdit::default())
        .manage(PendingEditMeta::default())
        .manage(PendingEditFilename::default())
        .manage(Arc::new(commands::update::PendingUpdate::default()))
        .invoke_handler(tauri::generate_handler![
            commands::app::window_ready,
            commands::app::is_gallery_open,
            commands::app::has_builtin_credentials,
            commands::app::is_store_screenshot_mode,
            commands::app::test_custom_provider,
            commands::app::flash_settings,
            commands::app::is_gallery_locked,
            commands::app::platform_capabilities,
            commands::app::get_settings,
            commands::app::save_settings,
            commands::app::get_drive_status,
            commands::app::connect_drive,
            commands::app::disconnect_drive,
            commands::app::list_drive_folders,
            commands::app::direct_link_upload,
            commands::app::sync_now,
            commands::app::open_screenshots_folder,
            commands::app::pick_folder,
            commands::app::take_screenshot,
            commands::app::quick_capture,
            commands::app::start_bg_template_capture,
            commands::app::save_bg_template,
            commands::app::get_app_icon,
            commands::app::open_settings,
            commands::app::get_tags,
            commands::app::save_tags,
            commands::app::set_image_tags,
            commands::app::get_is_elevated,
            commands::app::is_packaged_install,
            commands::app::request_admin,
            commands::app::check_screen_permission,
            commands::app::open_screen_recording_settings,
            commands::overlay_cmd::get_overlay_image,
            commands::overlay_cmd::get_overlay_setup,
            commands::overlay_cmd::area_selected,
            commands::overlay_cmd::set_area_live_mode,
            commands::overlay_cmd::reopen_overlay_live,
            commands::overlay_cmd::window_selected,
            commands::overlay_cmd::overlay_cancel,
            commands::overlay_cmd::overlay_ready,
            commands::overlay_cmd::set_native_highlight,
            commands::overlay_cmd::main_ready,
            commands::editor::get_editor_meta,
            commands::editor::get_editor_image,
            commands::editor::editor_save,
            commands::editor::editor_share,
            commands::editor::editor_direct_link,
            commands::editor::editor_copy,
            commands::editor::editor_copy_file,
            commands::editor::editor_close,
            commands::editor::editor_ready,
            commands::editor::open_editor_file,
            library::list_library,
            library::list_recent_local,
            library::refresh_library,
            library::get_offline_ops_count,
            library::delete_item,
            library::read_thumbnail,
            library::read_full_image,
            library::open_item,
            library::reveal_item,
            library::copy_local_image,
            library::upload_items,
            library::read_drive_thumbnail,
            library::direct_link_copy_link,
            library::drive_copy_link,
            library::get_storage_info,
            library::clear_app_cache,
            library::copy_text,
            library::open_url,
            translate::translate_text,
            library::download_drive_item,
            library::delete_local_copy,
            sync::get_transfers,
            sync::toggle_sync_pause,
            sync::clear_sync_queue,
            commands::update::get_app_version,
            commands::update::check_for_update,
            commands::update::get_pending_update,
            commands::update::download_and_install_update,
            commands::update::get_release_history,
        ])
        .setup(|app| {
            // Tray-only on macOS: avoids a Dock/Cmd+Tab entry, and sidesteps a
            // quirk where focusing any window brings every window of the app
            // (including a backgrounded gallery) to the front.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let config_dir = app.path().app_config_dir()?;
            #[cfg(debug_assertions)]
            let (config_dir, store_screenshots_mode) = if store_screenshots::requested() {
                let dir = store_screenshots::temp_config_dir();
                store_screenshots::prepare_temp_config(&dir);
                (dir, true)
            } else {
                (config_dir, false)
            };
            #[cfg(not(debug_assertions))]
            let _store_screenshots_mode = false;

            let store = Arc::new(ConfigStore::load(config_dir.clone()));
            app.manage(store.clone());
            #[cfg(debug_assertions)]
            let drive = Arc::new(if store_screenshots_mode {
                DriveClient::new_isolated(config_dir.clone())
            } else {
                DriveClient::new(config_dir.clone())
            });
            #[cfg(not(debug_assertions))]
            let drive = Arc::new(DriveClient::new(config_dir.clone()));
            app.manage(drive.clone());
            app.manage(Arc::new(SyncState::load(config_dir.clone())));
            app.manage(Arc::new(meta::MetaStore::load(config_dir.clone())));
            app.manage(Arc::new(tag::TagStore::load(config_dir.clone())));
            app.manage(Arc::new(icon_cache::IconCache::new(&config_dir)));
            app.manage(library::LibraryCache::default());
            app.manage(GalleryLocked(std::sync::atomic::AtomicBool::new(false)));
            #[cfg(target_os = "macos")]
            app.manage(ScreenPermission(std::sync::atomic::AtomicU8::new(0)));
            app.manage(PopupJustHidden::default());
            app.manage(PopupDestroyTimer::default());
            app.manage(PopupHideTimer::default());
            win_util::start_single_instance_listener(app.handle().clone());
            if let Some(icon) = app.default_window_icon() {
                let rgba = icon.rgba().to_vec();
                let (w, h) = (icon.width(), icon.height());
                let icon_path = config_dir.join("notification-icon.ico");
                std::thread::spawn(move || {
                    if let Some(img) = image::RgbaImage::from_raw(w, h, rgba) {
                        let resized = image::imageops::resize(&img, 256, 256, image::imageops::FilterType::Lanczos3);
                        let _ = resized.save(&icon_path);
                    }
                    win_util::register_notification_aumid(&icon_path);
                });
            }
            // Validate stored Drive token in background before sync starts.
            // Network error → keep tokens (offline). Auth error → clear tokens (logged out).
            {
                let drive_ref = drive.clone();
                let settings  = store.get();
                let cid  = settings.effective_google_client_id().to_string();
                let csec = settings.effective_google_client_secret().to_string();
                tauri::async_runtime::spawn(async move {
                    drive_ref.validate_on_startup(&cid, &csec).await;
                });
            }
            sync::start(app.handle());
            tray::build_tray(app.handle())?;
            tray::register_hotkeys(app.handle());
            if !cfg!(debug_assertions) {
                let s = store.get();
                win_util::update_start_menu_shortcut(s.run_as_admin);
                if s.run_as_admin && win_util::is_elevated() {
                    // Ensure registry-based autostart is off; use Task Scheduler instead
                    let _ = app.autolaunch().disable();
                    if s.autostart {
                        if let Err(e) = win_util::create_admin_autostart() {
                            log::warn!("failed to create admin autostart task on startup: {e}");
                        }
                    }
                } else if s.autostart && !s.run_as_admin {
                    let _ = app.autolaunch().enable();
                }
            }
            let launched_at_boot = std::env::args().any(|a| a == "--autostart");
            let gallery_will_open = !launched_at_boot && store.get().start_with_gallery;
            if gallery_will_open {
                tray::show_main(app.app_handle());
            }
            if store.get().auto_update && !win_util::is_packaged() {
                let update_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_updater::UpdaterExt;
                    let Ok(updater) = update_app.updater() else { return };
                    if let Ok(Some(update)) = updater.check().await {
                        let version = update.version.clone();
                        let pending = update_app.state::<Arc<commands::update::PendingUpdate>>();
                        *pending.0.lock().await = Some(update);
                        let _ = update_app.emit("update-available", version.clone());
                        // No gallery window to surface the modal in — at least
                        // let the user know; it'll be waiting next time they
                        // open the gallery from the tray (see get_pending_update).
                        if !gallery_will_open {
                            notify(
                                &update_app,
                                "Shotcove",
                                &format!("Update available: v{version}. Open Shotcove from the tray to install."),
                            );
                        }
                    }
                });
            }
            #[cfg(debug_assertions)]
            if store_screenshots_mode {
                store_screenshots::run(app.handle().clone());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // macOS: stay tray-only (Accessory, no Dock icon) while no real
            // window is open, but switch to Regular so open windows show up
            // in Cmd+Tab.
            #[cfg(target_os = "macos")]
            if matches!(event, WindowEvent::Focused(_) | WindowEvent::Destroyed | WindowEvent::CloseRequested { .. }) {
                let app = window.app_handle();
                let closing_label = matches!(event, WindowEvent::Destroyed).then(|| window.label());
                // Existence, not visibility: a minimized window must still
                // count as "present" or its Dock icon (and thus its
                // minimized thumbnail) disappears along with it. The window
                // that just got Destroyed is excluded since it's still in
                // the map for this event but is on its way out.
                let has_real_window = app.webview_windows().keys().any(|label| {
                    !label.starts_with("overlay") && label != "loading" && Some(label.as_str()) != closing_label
                });
                let _ = app.set_activation_policy(if has_real_window {
                    tauri::ActivationPolicy::Regular
                } else {
                    tauri::ActivationPolicy::Accessory
                });
            }
            if window.label() == "main" {
                if let WindowEvent::Destroyed = event {
                    let _ = window.app_handle().emit("gallery-closed", ());
                }
            }
            if window.label() == "transfers-popup" {
                match event {
                    WindowEvent::Focused(focused) => {
                        let is_visible = window.is_visible().unwrap_or(false);
                        tray::handle_popup_focus_events(window.app_handle(), *focused, is_visible);
                    }
                    _ => {}
                }
            }
            if window.label().starts_with("editor-") {
                if let WindowEvent::Destroyed = event {
                    let app = window.app_handle();
                    app.state::<PendingEdit>().0.lock().unwrap().remove(window.label());
                    app.state::<PendingEditMeta>().0.lock().unwrap().remove(window.label());
                    app.state::<PendingEditFilename>().0.lock().unwrap().remove(window.label());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

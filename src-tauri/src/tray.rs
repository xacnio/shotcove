use crate::{config::{ConfigStore, ShortcutCapture}, library, overlay, sync, PopupDestroyTimer, PopupHideTimer, PopupJustHidden};
use std::sync::Arc;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri::window::Color;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Native macOS rounded window corners via Tauri's window-effects API (the
/// CSS-clip + `transparent(true)` approach doesn't actually mask the
/// WKWebView's own backing layer, so corners stay square without this).
#[cfg(target_os = "macos")]
pub(crate) fn mac_rounded_effects() -> tauri::utils::config::WindowEffectsConfig {
    tauri::window::EffectsBuilder::new()
        .effect(tauri::window::Effect::WindowBackground)
        .radius(10.0)
        .build()
}

#[cfg(target_os = "windows")]
fn hwnd_of(w: &tauri::WebviewWindow) -> Option<windows::Win32::Foundation::HWND> {
    let h = w.hwnd().ok()?;
    Some(windows::Win32::Foundation::HWND(h.0 as usize as *mut _))
}

/// macOS equivalent of the Windows `GWLP_HWNDPARENT` owner trick: makes
/// `owned` a true child window of `owner` in the window server, so it always
/// stacks above its owner and can never end up hidden behind it.
#[cfg(target_os = "macos")]
fn set_window_owner(owned: &tauri::WebviewWindow, owner: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowOrderingMode};
    let (Ok(owned_ptr), Ok(owner_ptr)) = (owned.ns_window(), owner.ns_window()) else { return };
    unsafe {
        let owned_ns: &NSWindow = &*owned_ptr.cast();
        let owner_ns: &NSWindow = &*owner_ptr.cast();
        owner_ns.addChildWindow_ordered(owned_ns, NSWindowOrderingMode::Above);
    }
}

#[cfg(target_os = "windows")]
fn set_window_owner(owned: &tauri::WebviewWindow, owner: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, GWL_STYLE,
        GWLP_HWNDPARENT, WS_EX_APPWINDOW, WS_MINIMIZEBOX,
    };
    let Some(owned_hwnd) = hwnd_of(owned) else { return };
    let Some(owner_hwnd) = hwnd_of(owner) else { return };
    unsafe {
        SetWindowLongPtrW(owned_hwnd, GWLP_HWNDPARENT, owner_hwnd.0 as _);
        let ex = GetWindowLongPtrW(owned_hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(owned_hwnd, GWL_EXSTYLE, ex & !(WS_EX_APPWINDOW.0 as isize));
        // Remove minimize box — Settings is modal when gallery is open
        let style = GetWindowLongPtrW(owned_hwnd, GWL_STYLE);
        SetWindowLongPtrW(owned_hwnd, GWL_STYLE, style & !(WS_MINIMIZEBOX.0 as isize));
    }
}

#[cfg(target_os = "windows")]
fn restore_minimize_box(w: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_STYLE, WS_MINIMIZEBOX,
    };
    let Some(hwnd) = hwnd_of(w) else { return };
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        SetWindowLongPtrW(hwnd, GWL_STYLE, style | WS_MINIMIZEBOX.0 as isize);
    }
}

#[cfg(target_os = "linux")]
fn set_transient_parent(owned: &tauri::WebviewWindow, owner: &tauri::WebviewWindow) {
    use gtk::prelude::GtkWindowExt;
    if let (Ok(owned_gtk), Ok(owner_gtk)) = (owned.gtk_window(), owner.gtk_window()) {
        owned_gtk.set_transient_for(Some(&owner_gtk));
    }
}

fn enable_window(w: &tauri::WebviewWindow, enable: bool) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
        use windows::Win32::Foundation::BOOL;
        if let Some(hwnd) = hwnd_of(w) {
            unsafe { let _ = EnableWindow(hwnd, BOOL(enable as i32)); }
        }
    }
    use std::sync::atomic::Ordering;
    // Persist locked state so gallery can query it on mount
    if let Some(s) = w.app_handle().try_state::<crate::GalleryLocked>() {
        s.0.store(!enable, Ordering::Relaxed);
    }
    // Notify the gallery frontend to show/hide the click-blocking overlay
    let event = if enable { "gallery-unlocked" } else { "gallery-locked" };
    let _ = w.emit(event, ());
}

pub fn register_hotkeys(app: &AppHandle) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let settings = app.state::<Arc<ConfigStore>>().get();
    if !settings.hotkeys_enabled {
        return;
    }
    for slot in &settings.shortcuts {
        if slot.combo.trim().is_empty() {
            continue;
        }
        let capture = slot.capture.clone();
        let actions = slot.actions.clone();
        let multi_monitor = slot.multi_monitor;
        let bg_template = slot.bg_template.clone();
        let result = gs.on_shortcut(slot.combo.as_str(), move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                overlay::trigger(app, capture.clone(), actions.clone(), multi_monitor, bg_template.clone());
            }
        });
        if let Err(e) = result {
            log::warn!("failed to register shortcut ({}): {e}", slot.combo);
        }
    }
    if settings.printscreen_enabled {
        let ps_actions = settings.printscreen_actions.clone();
        let ps_multi_monitor = settings.printscreen_multi_monitor;
        let ps_bg_template = settings.printscreen_bg_template.clone();
        let result = gs.on_shortcut("PrintScreen", move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                overlay::trigger(
                    app,
                    ShortcutCapture::Fullscreen,
                    ps_actions.clone(),
                    ps_multi_monitor,
                    ps_bg_template.clone(),
                );
            }
        });
        if let Err(e) = result {
            log::warn!("failed to register PrintScreen shortcut: {e}");
        }
    }
}

#[derive(serde::Deserialize)]
struct TrayLocale {
    open_gallery:               String,
    open_folder:                String,
    sync_now:                   String,
    settings:                   String,
    shortcuts_enabled:          String,
    quit:                       String,
    #[allow(dead_code)]
    transfers:                  String,
    capture_area:               String,
    capture_window:             String,
    capture_fullscreen:         String,
    capture_fullscreen_current: String,
    action_open_editor:         String,
    action_save:                String,
    action_copy_image:          String,
    action_direct_link:         String,
    action_drive_link:          String,
}

/// Single source of truth for tray menu strings, shared across languages —
/// keeps translation in one file instead of a Rust match arm per language.
static TRAY_LOCALES: std::sync::LazyLock<std::collections::HashMap<String, TrayLocale>> =
    std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("../locales/tray-locale.json"))
            .expect("tray-locale.json must be valid")
    });

fn tray_locale(lang: &str) -> &'static TrayLocale {
    TRAY_LOCALES.get(lang).unwrap_or_else(|| &TRAY_LOCALES["en"])
}

fn slot_default_label(slot: &crate::config::ShortcutSlot, loc: &TrayLocale) -> String {
    use crate::config::{ShortcutAction, ShortcutCapture};
    let capture = match slot.capture {
        ShortcutCapture::Area => &loc.capture_area,
        ShortcutCapture::Window => &loc.capture_window,
        ShortcutCapture::Fullscreen => &loc.capture_fullscreen,
        ShortcutCapture::FullscreenCurrent => &loc.capture_fullscreen_current,
    };
    let actions: Vec<&str> = slot.actions.iter().map(|a| match a {
        ShortcutAction::OpenEditor => loc.action_open_editor.as_str(),
        ShortcutAction::Save => loc.action_save.as_str(),
        ShortcutAction::CopyImage => loc.action_copy_image.as_str(),
        ShortcutAction::DirectLink => loc.action_direct_link.as_str(),
        ShortcutAction::DriveLink => loc.action_drive_link.as_str(),
    }).collect();
    format!("{} — {}", capture, actions.join(" + "))
}

fn menu_item(app: &AppHandle, id: &str, text: &str, accelerator: &str) -> tauri::Result<MenuItem<tauri::Wry>> {
    if !accelerator.trim().is_empty() {
        if let Ok(item) = MenuItem::with_id(app, id, text, true, Some(accelerator)) {
            return Ok(item);
        }
    }
    MenuItem::with_id(app, id, text, true, None::<&str>)
}

pub fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let s = app.state::<Arc<ConfigStore>>().get();
    let loc = tray_locale(&s.language);

    // Build dynamic slot items first
    let slot_items: Vec<MenuItem<tauri::Wry>> = s
        .shortcuts
        .iter()
        .filter(|slot| slot.show_in_menu)
        .map(|slot| {
            let label = if slot.label.trim().is_empty() {
                slot_default_label(slot, loc)
            } else {
                slot.label.clone()
            };
            menu_item(app, &slot.id, &label, &slot.combo)
        })
        .collect::<tauri::Result<_>>()?;

    // Build the full menu: slot items + separator + static items
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = Vec::new();
    for item in &slot_items {
        items.push(item);
    }
    let sep1 = PredefinedMenuItem::separator(app)?;
    #[cfg(target_os = "linux")]
    let transfers = menu_item(app, "transfers", &loc.transfers, "")?;
    let gallery = menu_item(app, "gallery",  &loc.open_gallery, "")?;
    let sep_group = PredefinedMenuItem::separator(app)?;
    let folder  = menu_item(app, "folder",   &loc.open_folder,  "")?;
    let sync    = menu_item(app, "sync_now", &loc.sync_now,     "")?;
    let setts   = menu_item(app, "settings", &loc.settings,     "")?;
    let sep2    = PredefinedMenuItem::separator(app)?;
    let hotkeys = CheckMenuItem::with_id(app, "hotkeys_toggle", &loc.shortcuts_enabled, true, s.hotkeys_enabled, None::<&str>)?;
    let sep3    = PredefinedMenuItem::separator(app)?;
    let quit    = menu_item(app, "quit", &loc.quit, "")?;

    if !slot_items.is_empty() {
        items.push(&sep1);
    }
    items.push(&folder);
    items.push(&sync);
    items.push(&sep2);
    items.push(&hotkeys);
    items.push(&sep3);
    items.push(&gallery);
    #[cfg(target_os = "linux")]
    items.push(&transfers);
    items.push(&sep_group);
    items.push(&setts);
    items.push(&quit);

    Menu::with_items(app, &items)
}

pub fn refresh_tray_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(menu) = build_tray_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

pub fn show_settings(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        let app = app.clone();
        std::thread::spawn(move || {
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                #[allow(unused_variables)]
                let gallery = app2.get_webview_window("main");
                let mut settings_builder = WebviewWindowBuilder::new(
                    &app2, "settings", WebviewUrl::App("pages/index.html".into()),
                )
                .title("Shotcove Settings")
                .inner_size(560.0, 640.0)
                .resizable(false)
                .decorations(false)
                .transparent(cfg!(target_os = "macos"))
                .visible(false)
                .center();
                #[cfg(target_os = "macos")]
                {
                    settings_builder = settings_builder.effects(mac_rounded_effects());
                }
                #[cfg(not(target_os = "macos"))]
                {
                    settings_builder = settings_builder.background_color(Color(15, 15, 15, 255));
                }
                let settings_win = settings_builder.build();

                if let Ok(ref sw) = settings_win {
                    if let Some(ref gw) = gallery {
                        #[cfg(any(target_os = "windows", target_os = "macos"))]
                        set_window_owner(sw, gw);

                        #[cfg(target_os = "linux")]
                        set_transient_parent(sw, gw);
                        
                        enable_window(gw, false);
                        
                        // When gallery closes before settings, restore minimize box on settings
                        #[cfg(target_os = "windows")]
                        {
                            let sw2 = sw.clone();
                            gw.on_window_event(move |ev| {
                                if matches!(ev, tauri::WindowEvent::Destroyed) {
                                    restore_minimize_box(&sw2);
                                }
                            });
                        }
                    }

                    // Re-enable before Destroyed, not after — otherwise Windows activates
                    // whatever's next in z-order instead of the disabled owner, and
                    // yanking it back on Destroyed causes a visible flicker.
                    let app3 = app2.clone();
                    sw.on_window_event(move |ev| {
                        match ev {
                            tauri::WindowEvent::CloseRequested { .. } => {
                                if let Some(gw) = app3.get_webview_window("main") {
                                    enable_window(&gw, true);
                                }
                            }
                            tauri::WindowEvent::Destroyed => {
                                if let Some(gw) = app3.get_webview_window("main") {
                                    let _ = gw.set_focus();
                                }
                            }
                            _ => {}
                        }
                    });
                }
            });
        });
    }
}

/// If Settings is open, make it modal over `gallery`: lock gallery, set owner, wire close events.
fn attach_settings_modal(app: &AppHandle, gallery: &tauri::WebviewWindow) {
    let Some(_sw) = app.get_webview_window("settings") else { return };
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    set_window_owner(&_sw, gallery);

    #[cfg(target_os = "linux")]
    set_transient_parent(&_sw, gallery);
    
    enable_window(gallery, false);
    // Gallery close → restore minimize box on Settings
    #[cfg(target_os = "windows")]
    {
        let sw2 = _sw.clone();
        gallery.on_window_event(move |ev| {
            if matches!(ev, tauri::WindowEvent::Destroyed) {
                restore_minimize_box(&sw2);
            }
        });
    }
}

/// Tries a real (tiny, discarded) capture in the background so the gallery
/// opening is what naturally surfaces the macOS Screen Recording permission
/// prompt, rather than the user's first real shortcut press silently coming
/// back with a blank screenshot. Skipped once the permission is known granted
/// so reopening the gallery doesn't re-capture every time.
#[cfg(target_os = "macos")]
fn maybe_probe_screen_permission(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    let state = app.state::<crate::ScreenPermission>();
    if state.0.load(Ordering::Relaxed) == 1 {
        return;
    }
    let app2 = app.clone();
    std::thread::spawn(move || {
        let granted = crate::capture_macos::probe_permission();
        let state = app2.state::<crate::ScreenPermission>();
        state.0.store(if granted { 1 } else { 2 }, Ordering::Relaxed);
        if !granted {
            let _ = app2.emit("screen-permission-needed", ());
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn maybe_probe_screen_permission(_app: &AppHandle) {}

pub fn show_main(app: &AppHandle) {
    let _ = app.emit("gallery-opened", ());
    maybe_probe_screen_permission(app);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(gw) = app2.get_webview_window("main") {
                attach_settings_modal(&app2, &gw);
            }
        });
    } else {
        let app_inner = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Compute a safe initial size from the primary monitor so Windows never
            // auto-maximizes the window because it exceeds the available work area.
            let (win_w, win_h, min_w, min_h) = app_inner
                .primary_monitor()
                .ok()
                .flatten()
                .map(|m| {
                    let sf = m.scale_factor();
                    let ps = m.size();
                    // Convert physical → logical, then subtract ~48 logical px for taskbar
                    let lw = ps.width  as f64 / sf;
                    let lh = ps.height as f64 / sf - 48.0;
                    
                    // If the screen's usable size is smaller than the target minimum window
                    // size, shrink the minimum constraints dynamically to avoid a tao/winit
                    // panic (it asserts min size <= available size).
                    let min_w = lw.min(1150.0);
                    let min_h = lh.min(720.0);
                    
                    let w = (lw * 0.72).clamp(min_w, lw.min(1200.0));
                    let h = (lh * 0.84).clamp(min_h, lh.min(900.0));
                    (w, h, min_w, min_h)
                })
                .unwrap_or((1150.0, 720.0, 1150.0, 720.0));

            let mut gallery_builder = WebviewWindowBuilder::new(
                &app_inner, "main", WebviewUrl::App("pages/gallery.html".into()),
            )
            .title("Shotcove")
            .inner_size(win_w, win_h)
            .min_inner_size(min_w, min_h)
            .resizable(true)
            .decorations(false)
            .transparent(cfg!(target_os = "macos"))
            .visible(false)
            .center();
            #[cfg(target_os = "macos")]
            {
                gallery_builder = gallery_builder.effects(mac_rounded_effects());
            }
            #[cfg(not(target_os = "macos"))]
            {
                gallery_builder = gallery_builder.background_color(Color(15, 15, 15, 255));
            }
            #[allow(unused_variables)]
            let result = gallery_builder.build();
            if let Ok(ref gw) = result {
                attach_settings_modal(&app_inner, gw);
            }
        });
    }
}

pub fn open_folder(app: &AppHandle) {
    let dir = app.state::<Arc<ConfigStore>>().get().resolved_screenshots_dir();
    let _ = std::fs::create_dir_all(&dir);
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_path(dir.to_string_lossy().to_string(), None::<&str>);
}

pub fn show_transfers_popup(app: &AppHandle, cursor_x: f64, cursor_y: f64) {
    const W: i32 = 300;
    const H: i32 = 440;
    #[allow(unused_mut)]
    let mut x = (cursor_x as i32) - W / 2;
    #[allow(unused_mut)]
    let mut y = if (cursor_y as i32) < H + 50 {
        (cursor_y as i32) + 8
    } else {
        (cursor_y as i32) - H - 8
    };

    #[cfg(target_os = "linux")]
    {
        // Identify which monitor the click happened on
        let monitor = app.monitor_from_point(cursor_x, cursor_y).ok().flatten()
            .or_else(|| app.primary_monitor().ok().flatten());
        
        if let Some(m) = monitor {
            let m_pos = m.position();
            let m_size = m.size();
            let sf = m.scale_factor();
            
            // Get physical dimensions of popup
            let physical_w = (W as f64 * sf) as i32;
            let physical_h = (H as f64 * sf) as i32;
            
            let rel_x = cursor_x - m_pos.x as f64;
            let rel_y = cursor_y - m_pos.y as f64;
            let is_top = rel_y < (m_size.height as f64 / 2.0);
            let is_right = rel_x > (m_size.width as f64 / 2.0);
            
            let margin_x = (12.0 * sf) as i32;
            let margin_y = (36.0 * sf) as i32;
            
            let target_x = if is_right {
                m_pos.x + m_size.width as i32 - physical_w - margin_x
            } else {
                m_pos.x + margin_x
            };
            let target_y = if is_top {
                m_pos.y + margin_y
            } else {
                m_pos.y + (m_size.height as i32) - physical_h - margin_y
            };
            
            x = target_x;
            y = target_y;
        }
    }

    {
        let state = app.state::<PopupJustHidden>();
        let mut guard = state.0.lock().unwrap();
        if let Some(t) = *guard {
            if t.elapsed() < std::time::Duration::from_millis(300) {
                *guard = None;
                return;
            }
        }
    }

    if let Some(timer) = app.try_state::<PopupDestroyTimer>() {
        if let Some(task) = timer.0.lock().unwrap().take() {
            task.abort();
        }
    }

    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = app2.get_webview_window("transfers-popup") {
            if win.is_visible().unwrap_or(false) {
                let _ = win.hide();
            } else {
                let _ = win.set_position(PhysicalPosition::new(x, y));
                let _ = win.show();
                let _ = win.set_focus();
            }
            return;
        }
        let build = || -> tauri::Result<()> {
            let win = WebviewWindowBuilder::new(
                &app2,
                "transfers-popup",
                WebviewUrl::App("pages/transfers.html".into()),
            )
            .title("Transfers")
            .inner_size(W as f64, H as f64)
            .resizable(false)
            .decorations(false)
            .skip_taskbar(true)
            .background_color(Color(15, 15, 15, 255))
            .visible(false)
            .build()?;
            win.set_position(PhysicalPosition::new(x, y))?;
            Ok(())
        };
        if let Err(e) = build() {
            log::warn!("failed to open transfers popup: {e}");
        }
    });
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Shotcove")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            match event {
                TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
                    show_main(app);
                }
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    position,
                    ..
                } => {
                    show_transfers_popup(app, position.x, position.y);
                }
                _ => {}
            }
        })
        .on_menu_event(|app, event| {
            use tauri::Emitter;
            let id = event.id().as_ref();
            match id {
                "gallery"        => show_main(app),
                "transfers"      => {
                    #[cfg(target_os = "linux")]
                    {
                        if let Ok(cursor_pos) = app.cursor_position() {
                            show_transfers_popup(app, cursor_pos.x, cursor_pos.y);
                        } else {
                            show_transfers_popup(app, 100.0, 100.0);
                        }
                    }
                }
                "folder"         => open_folder(app),
                "sync_now"       => sync::scan_and_enqueue(app),
                "settings"       => show_settings(app),
                "hotkeys_toggle" => {
                    let config = app.state::<Arc<ConfigStore>>();
                    let mut s = config.get();
                    s.hotkeys_enabled = !s.hotkeys_enabled;
                    let _ = config.save(s);
                    register_hotkeys(app);
                    refresh_tray_menu(app);
                    let _ = app.emit("settings-changed", ());
                }
                "quit" => app.exit(0),
                slot_id => {
                    // Look up the slot by ID and trigger the capture
                    let settings = app.state::<Arc<ConfigStore>>().get();
                    if let Some(slot) = settings.shortcuts.iter().find(|s| s.id == slot_id) {
                        overlay::trigger(app, slot.capture.clone(), slot.actions.clone(), slot.multi_monitor, slot.bg_template.clone());
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}

pub fn handle_popup_focus_events(app: &AppHandle, focused: bool, is_visible: bool) {
    use std::time::Instant;

    if focused {
        if let Some(t) = app.try_state::<PopupHideTimer>() {
            if let Some(task) = t.0.lock().unwrap().take() {
                task.abort();
            }
        }
    } else {
        if !is_visible {
            return;
        }
        let app_h = app.clone();
        let task = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let app_h2 = app_h.clone();
            let _ = app_h.run_on_main_thread(move || {
                let Some(win) = app_h2.get_webview_window("transfers-popup") else { return };
                if !win.is_visible().unwrap_or(false) { return; }
                if win.is_focused().unwrap_or(false) { return; }
                if let Some(s) = app_h2.try_state::<PopupJustHidden>() {
                    *s.0.lock().unwrap() = Some(Instant::now());
                }
                let _ = win.hide();
                if let Some(dt) = app_h2.try_state::<PopupDestroyTimer>() {
                    let mut g = dt.0.lock().unwrap();
                    if let Some(old) = g.take() { old.abort(); }
                    let app_h3 = app_h2.clone();
                    *g = Some(tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        let app_h4 = app_h3.clone();
                        let _ = app_h3.run_on_main_thread(move || {
                            if let Some(w) = app_h4.get_webview_window("transfers-popup") {
                                if !w.is_visible().unwrap_or(true) {
                                    let _ = w.destroy();
                                }
                            }
                        });
                    }));
                }
            });
        });
        if let Some(t) = app.try_state::<PopupHideTimer>() {
            let mut g = t.0.lock().unwrap();
            if let Some(old) = g.take() { old.abort(); }
            *g = Some(task);
        }
    }
}

pub fn on_library_folder_change(app: &AppHandle) {
    let drive = app.state::<Arc<crate::drive::DriveClient>>();
    drive.clear_folder_id();
    drive.clear_cache();
    app.state::<library::LibraryCache>().clear();
    app.state::<Arc<sync::SyncState>>().clear();
    let _ = app.emit("library-changed", ());
    sync::scan_and_enqueue(app);
    let sync_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = sync::sync_metadata_and_icons(&sync_app).await;
    });
}

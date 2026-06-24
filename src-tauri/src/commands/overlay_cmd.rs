use crate::{
    capture, icon_cache, overlay,
    CaptureMeta, OverlayMode, Pending,
};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewWindow};

#[tauri::command]
pub async fn get_overlay_image(app: AppHandle, mon_index: u32) -> Result<String, String> {
    let pending = app.state::<Pending>();
    for _ in 0..200 {
        {
            let guard = pending.0.lock().unwrap();
            if let Some(p) = guard.as_ref() {
                match p.mode {
                    OverlayMode::AreaMulti | OverlayMode::Window if !p.mon_jpegs.is_empty() => {
                        if let Some(jpeg) = p.mon_jpegs.get(mon_index as usize) {
                            if !jpeg.is_empty() {
                                return Ok(jpeg.clone());
                            }
                        }
                    }
                    _ => {
                        if let Some(jpeg) = &p.image_jpeg {
                            return Ok(jpeg.clone());
                        }
                    }
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    Err("image encoding timeout".into())
}

#[derive(Serialize)]
pub struct PickWindow {
    id: u32,
    title: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Serialize)]
pub struct OverlaySetup {
    mode: String,
    windows: Vec<PickWindow>,
    mon_w: f64,
    mon_h: f64,
    live_mode: bool,
}

#[tauri::command]
pub async fn get_overlay_setup(app: AppHandle, mon_index: u32) -> Result<OverlaySetup, String> {
    let pending = app.state::<Pending>();
    for _ in 0..200 {
        {
            let guard = pending.0.lock().unwrap();
            if let Some(p) = guard.as_ref() {
                let idx = mon_index as usize;
                match p.mode {
                    OverlayMode::Window if !p.monitors.is_empty() => {
                        let mon = p.monitors.get(idx)
                            .ok_or_else(|| format!("monitor index {idx} out of range"))?;
                        let scale = mon.scale as f64;
                        let mon_w = mon.w as f64 / scale;
                        let mon_h = mon.h as f64 / scale;
                        let windows = p.windows.iter()
                            .filter(|w| {
                                let mx2 = mon.x + mon.w as i32;
                                let my2 = mon.y + mon.h as i32;
                                w.x < mx2 && w.x + w.w > mon.x && w.y < my2 && w.y + w.h > mon.y
                            })
                            .map(|w| PickWindow {
                                id: w.id,
                                title: w.title.clone(),
                                x: (w.x - mon.x) as f64 / scale,
                                y: (w.y - mon.y) as f64 / scale,
                                w: w.w as f64 / scale,
                                h: w.h as f64 / scale,
                            })
                            .collect();
                        return Ok(OverlaySetup { mode: "window".into(), windows, mon_w, mon_h, live_mode: p.live_mode });
                    }
                    OverlayMode::AreaMulti if !p.monitors.is_empty() => {
                        let mon = p.monitors.get(idx)
                            .ok_or_else(|| format!("monitor index {idx} out of range"))?;
                        let scale = mon.scale as f64;
                        let mon_w = mon.w as f64 / scale;
                        let mon_h = mon.h as f64 / scale;
                        // "area_multi" tells JS not to cancel on blur (other overlays steal focus)
                        return Ok(OverlaySetup { mode: "area_multi".into(), windows: Vec::new(), mon_w, mon_h, live_mode: p.live_mode });
                    }
                    _ => {
                        // Single-monitor area mode
                        let scale = p.scale as f64;
                        let mon_w = p.mon_w as f64 / scale;
                        let mon_h = p.mon_h as f64 / scale;
                        return Ok(OverlaySetup { mode: "area".into(), windows: Vec::new(), mon_w, mon_h, live_mode: p.live_mode });
                    }
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    Err("overlay setup timeout".into())
}

#[tauri::command]
pub async fn window_selected(app: AppHandle, id: u32) -> Result<(), String> {
    // Hide all overlays immediately so the screen clears before capture.
    if let Some(win) = app.get_webview_window("overlay") { let _ = win.hide(); }
    for i in 0..8u32 {
        if let Some(win) = app.get_webview_window(&format!("overlay-{i}")) { let _ = win.hide(); }
    }
    let pending = app.state::<Pending>().0.lock().unwrap().take();
    let Some(p) = pending else {
        overlay::close_all_overlays(&app);
        return Ok(());
    };
    let actions = p.actions.clone();
    let bg_template = p.bg_template.clone();
    let Some(w) = p.windows.iter().find(|w| w.id == id).cloned() else {
        overlay::close_all_overlays(&app);
        return Ok(());
    };
    let meta = CaptureMeta {
        title: Some(w.title.clone()).filter(|t| !t.is_empty()),
        app: Some(w.app.clone()).filter(|a| !a.is_empty()),
        is_window: true,
        tags: vec![],
        monitor_rects: vec![],
        monitor_names: vec![],
        window_crops: vec![],
        bg_template: bg_template.clone(),
    };
    let app_name_ic = w.app.clone();
    let hwnd_ic = w.id;
    let mon_x = p.mon_x;
    let mon_y = p.mon_y;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let mut cropped = tauri::async_runtime::spawn_blocking(move || {
        capture::capture_window_raw(&w, mon_x, mon_y)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let auto_bg = bg_template.is_some() && actions.contains(&crate::config::ShortcutAction::OpenEditor);
    if !actions.contains(&crate::config::ShortcutAction::OpenEditor) {
        if let Some(tpl) = &bg_template {
            cropped = overlay::apply_background_padding(cropped, tpl);
        }
    }
    overlay::close_all_overlays(&app);
    {
        let ic = app.state::<Arc<icon_cache::IconCache>>().inner().clone();
        tauri::async_runtime::spawn(async move {
            tauri::async_runtime::spawn_blocking(move || {
                ic.cache_from_hwnd(&app_name_ic, hwnd_ic);
            })
            .await
            .ok();
        });
    }
    overlay::execute_post_capture(&app, cropped, meta, &actions, auto_bg).await;
    Ok(())
}

#[tauri::command]
pub async fn area_selected(app: AppHandle, x: f64, y: f64, w: f64, h: f64, mon_index: u32) -> Result<(), String> {
    // Hide all overlays so they don't appear in any live-mode capture.
    if let Some(win) = app.get_webview_window("overlay") { let _ = win.hide(); }
    for i in 0..8u32 {
        if let Some(win) = app.get_webview_window(&format!("overlay-{i}")) { let _ = win.hide(); }
    }
    let pending = app.state::<Pending>().0.lock().unwrap().take();
    let Some(p) = pending else {
        overlay::close_all_overlays(&app);
        return Ok(());
    };
    let actions = p.actions.clone();
    let bg_template = p.bg_template.clone();
    let mut meta = p.meta.clone();
    meta.bg_template = bg_template.clone();

    let cropped = if !p.live_mode {
        // Frozen mode: crop from the pre-captured image — no delay or fresh capture needed.
        match p.mode {
            OverlayMode::AreaMulti => {
                let idx = mon_index as usize;
                let mon = p.monitors.get(idx)
                    .ok_or_else(|| format!("monitor index {idx} out of range for area selection"))?;
                let scale = mon.scale as f64;
                let px = (x.max(0.0) * scale).round() as u32;
                let py = (y.max(0.0) * scale).round() as u32;
                let pw = ((w * scale).round() as u32).max(1);
                let ph = ((h * scale).round() as u32).max(1);
                let mon_img = p.mon_images.into_iter().nth(idx)
                    .unwrap_or_else(|| image::ImageBuffer::new(0, 0));
                tauri::async_runtime::spawn_blocking(move || {
                    capture::crop(&mon_img, px, py, pw, ph)
                })
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?
            }
            _ => {
                let scale = p.scale as f64;
                let px = (x.max(0.0) * scale).round() as u32;
                let py = (y.max(0.0) * scale).round() as u32;
                let pw = ((w * scale).round() as u32).max(1);
                let ph = ((h * scale).round() as u32).max(1);
                let pre_img = p.image;
                tauri::async_runtime::spawn_blocking(move || {
                    capture::crop(&pre_img, px, py, pw, ph)
                })
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?
            }
        }
    } else {
        // Live mode: overlays are hidden; give the OS time to process the hide
        // before capturing so it doesn't get baked into the screenshot.
        // Linux/Mutter needs more margin here than Windows — 100ms still left
        // a visible trace of the overlay.
        #[cfg(target_os = "linux")]
        tokio::time::sleep(std::time::Duration::from_millis(280)).await;
        #[cfg(not(target_os = "linux"))]
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        match p.mode {
            OverlayMode::AreaMulti => {
                let idx = mon_index as usize;
                let mon = p.monitors.get(idx)
                    .ok_or_else(|| format!("monitor index {idx} out of range for area selection"))?;
                let scale = mon.scale as f64;
                let px = (x.max(0.0) * scale).round() as u32;
                let py = (y.max(0.0) * scale).round() as u32;
                let pw = ((w * scale).round() as u32).max(1);
                let ph = ((h * scale).round() as u32).max(1);
                let sample_x = mon.x + (mon.w / 2) as i32;
                let sample_y = mon.y + (mon.h / 2) as i32;
                tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<image::RgbaImage> {
                    let shot = capture::capture_monitor_at(sample_x, sample_y)?;
                    capture::crop(&shot.image, px, py, pw, ph)
                })
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?
            }
            _ => {
                let scale = p.scale as f64;
                let px = (x.max(0.0) * scale).round() as u32;
                let py = (y.max(0.0) * scale).round() as u32;
                let pw = ((w * scale).round() as u32).max(1);
                let ph = ((h * scale).round() as u32).max(1);
                let sample_x = p.mon_x + (p.mon_w / 2) as i32;
                let sample_y = p.mon_y + (p.mon_h / 2) as i32;
                tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<image::RgbaImage> {
                    let shot = capture::capture_monitor_at(sample_x, sample_y)?;
                    capture::crop(&shot.image, px, py, pw, ph)
                })
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?
            }
        }
    };

    // Apply background padding only when not opening the editor; the editor has its own background tool.
    let auto_bg = bg_template.is_some() && actions.contains(&crate::config::ShortcutAction::OpenEditor);
    let cropped = if !actions.contains(&crate::config::ShortcutAction::OpenEditor) {
        match &bg_template {
            Some(tpl) => overlay::apply_background_padding(cropped, tpl),
            None => cropped,
        }
    } else {
        cropped
    };
    // Close overlays before post-capture; the Ok(()) PostMessage to the now-closed window is benign.
    overlay::close_all_overlays(&app);
    overlay::execute_post_capture(&app, cropped, meta, &actions, auto_bg).await;
    Ok(())
}

#[tauri::command]
pub fn set_area_live_mode(app: AppHandle) {
    let state = app.state::<Pending>();
    let mut guard = state.0.lock().unwrap();
    if let Some(p) = guard.as_mut() {
        p.live_mode = true;
    }
    
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = app_clone.get_webview_window("overlay") {
            if let Ok(size) = win.inner_size() {
                let _ = win.set_size(tauri::PhysicalSize::new(size.width - 1, size.height));
                let _ = win.set_size(tauri::PhysicalSize::new(size.width, size.height));
            }
        }
        for i in 0..8 {
            if let Some(win) = app_clone.get_webview_window(&format!("overlay-{i}")) {
                if let Ok(size) = win.inner_size() {
                    let _ = win.set_size(tauri::PhysicalSize::new(size.width - 1, size.height));
                    let _ = win.set_size(tauri::PhysicalSize::new(size.width, size.height));
                }
            }
        }
    });
}

/// Linux-only alternative to `set_area_live_mode`: closes and reopens the
/// overlay window(s) already in live mode, instead of toggling an
/// already-opaque window transparent in place (see `overlay::open_overlays_live`).
#[tauri::command]
pub fn reopen_overlay_live(app: AppHandle) {
    let Some(info) = overlay::live_reopen_info(&app) else { return; };
    overlay::close_all_overlays(&app);
    // Closing and immediately reusing the same window label can silently
    // fail to rebuild — the close is dispatched through the same event loop
    // queue, so give it a tick to actually destroy the old window first.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        overlay::open_overlays_live(&app, info);
    });
}

#[tauri::command]
pub fn overlay_cancel(app: AppHandle) {
    overlay::close_all_overlays(&app);
    *app.state::<Pending>().0.lock().unwrap() = None;
}

#[tauri::command]
pub fn overlay_ready(window: WebviewWindow, _app: AppHandle) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{BOOL, HWND};
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
        if let Ok(hwnd) = window.hwnd() {
            let hwnd = HWND(hwnd.0 as usize as *mut _);
            let value: BOOL = true.into();
            unsafe {
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_TRANSITIONS_FORCEDISABLED,
                    std::ptr::addr_of!(value).cast(),
                    std::mem::size_of::<BOOL>() as u32,
                );
            }
        }
        
        // On Windows, emit overlay-positioned immediately since it opens full size instantly
        use tauri::Emitter;
        let _ = window.emit("overlay-positioned", ());
    }

    // On Linux/GNOME (Mutter), set_position on a hidden window is ignored;
    // the WM re-places it on show(). We read the target monitor from Pending
    // state and re-apply after show().
    #[cfg(not(windows))]
    let monitor_pos: Option<(i32, i32, u32, u32)> = {
        let label = window.label().to_string();
        let pending = _app.state::<crate::Pending>();
        let guard = pending.0.lock().unwrap();
        guard.as_ref().and_then(|p| {
            if label == "overlay" {
                Some((p.mon_x, p.mon_y, p.mon_w, p.mon_h))
            } else {
                let idx: usize = label.strip_prefix("overlay-")?.parse().ok()?;
                p.monitors.get(idx)
                    .map(|m| (m.x, m.y, m.w, m.h))
                    .or(Some((p.mon_x, p.mon_y, p.mon_w, p.mon_h)))
            }
        })
    };

    #[cfg(not(windows))]
    if let Some((x, y, w, h)) = monitor_pos {
        use tauri::{PhysicalPosition, PhysicalSize};
        // Pre-position at full size before show() so GNOME/Mutter has the
        // right geometry from the first paint instead of jumping from 200×200.
        let _ = window.set_position(PhysicalPosition::new(x, y));
        let _ = window.set_size(PhysicalSize::new(w, h));
    }
    // Visuals (dim + selection rect) are drawn by JS via Canvas API on all
    // platforms. On Linux this avoids any with_webview calls that would break
    // WebKitGTK's mouse event delivery to the webview.


    let _ = window.show();
    let _ = window.set_focus();

    // Re-apply position + size AFTER show() so GNOME/Mutter honours them.
    // We do it twice — at 50 ms and 120 ms — because Mutter sometimes
    // ignores the first post-show resize if the compositor hasn't fully
    // mapped the window yet.
    #[cfg(not(windows))]
    if let Some((x, y, w, h)) = monitor_pos {
        use tauri::{PhysicalPosition, PhysicalSize, Emitter};
        let window_clone = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let _ = window_clone.set_position(PhysicalPosition::new(x, y));
            let _ = window_clone.set_size(PhysicalSize::new(w, h));
            let _ = window_clone.set_focus();
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            let _ = window_clone.set_position(PhysicalPosition::new(x, y));
            let _ = window_clone.set_size(PhysicalSize::new(w, h));
            let _ = window_clone.set_focus();
            let _ = window_clone.emit("overlay-positioned", ());
        });
    }
}

/// Updates the native GTK DrawingArea highlight on Linux.
/// A no-op on all platforms.
#[tauri::command]
pub fn set_native_highlight(window: WebviewWindow, rect: Option<overlay::HighlightRect>) {
    let _ = (window, rect);
}

#[tauri::command]
pub fn main_ready(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

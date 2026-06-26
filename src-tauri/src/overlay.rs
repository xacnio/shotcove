use crate::{
    capture,
    config::{BgTemplate, ConfigStore, ImageFormat, ShortcutAction, ShortcutCapture},
    drive::DriveClient,
    direct_link, library, meta, sync,
    CaptureMeta, OverlayMode, Pending, PendingCapture,
    PendingEdit, PendingEditMeta,
};
use image::RgbaImage;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
#[allow(unused_imports)]
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(not(target_os = "macos"))]
use tauri::window::Color;

#[cfg(target_os = "linux")]
use gtk::prelude::*;
#[cfg(target_os = "linux")]
use std::rc::Rc;
#[cfg(target_os = "linux")]
use std::cell::RefCell;
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Copies an RGBA screenshot to the system clipboard as an image (cross-platform).
fn copy_image_to_clipboard(app: &AppHandle, image: &RgbaImage) {
    let (w, h) = (image.width(), image.height());
    let img = tauri::image::Image::new(image.as_raw(), w, h);
    if let Err(e) = app.clipboard().write_image(&img) {
        log::warn!("failed to copy screenshot to clipboard: {e}");
    }
}

pub(crate) enum LinkTarget {
    None,
    DirectLink,
    Drive,
}

fn encode_overlay_jpeg(image: &RgbaImage) -> Option<String> {
    use base64::Engine;
    let (w, h) = (image.width(), image.height());
    let mut buf = Vec::new();
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    let raw = image.as_raw();
    for chunk in raw.chunks_exact(4) {
        rgb.push(chunk[0]);
        rgb.push(chunk[1]);
        rgb.push(chunk[2]);
    }
    let rgb_buf = image::ImageBuffer::<image::Rgb<u8>, Vec<u8>>::from_raw(w, h, rgb)?;
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 60);
    encoder.encode_image(&rgb_buf).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(buf))
}

/// Parses a "#rrggbb" string into (r, g, b); falls back to black on malformed input.
fn parse_hex_color(s: &str) -> (f32, f32, f32) {
    let s = s.trim_start_matches('#');
    if s.len() != 6 {
        return (0.0, 0.0, 0.0);
    }
    let part = |i: usize| u8::from_str_radix(&s[i..i + 2], 16).unwrap_or(0) as f32;
    (part(0), part(2), part(4))
}

/// Linear-gradient blend factor (0..1) at `(x, y)` within a `w`x`h` canvas,
/// projected along `angle_deg` (CSS `linear-gradient` convention: 0° points
/// up, increasing clockwise).
fn gradient_t(x: f32, y: f32, w: f32, h: f32, angle_deg: f32) -> f32 {
    let rad = (angle_deg - 90.0).to_radians();
    let (dx, dy) = (rad.cos(), rad.sin());
    let cx = x - w / 2.0;
    let cy = y - h / 2.0;
    let proj = cx * dx + cy * dy;
    let max_proj = (w.abs() * dx.abs() + h.abs() * dy.abs()) / 2.0;
    if max_proj <= 0.0 { 0.5 } else { ((proj / max_proj) + 1.0) / 2.0 }
}

/// Rounds the corners of `image` in place by zeroing alpha outside the radius.
fn round_corners_alpha(image: &mut RgbaImage, radius: u32) {
    if radius == 0 { return; }
    let (w, h) = (image.width() as i32, image.height() as i32);
    let r = (radius as i32).min(w / 2).min(h / 2);
    for py in 0..h {
        for px in 0..w {
            if capture::is_outside_rounded_corner(px, py, w, h, r) {
                image.get_pixel_mut(px as u32, py as u32).0[3] = 0;
            }
        }
    }
}

/// Adds a solid/gradient background and uniform padding around the captured image,
/// per `tpl`. Transparent pixels in `image` (e.g. alignment gaps in multi-monitor
/// stitches) are composited against the background so no transparency leaks into
/// the output.
pub fn apply_background_padding(mut image: RgbaImage, tpl: &BgTemplate) -> RgbaImage {
    round_corners_alpha(&mut image, tpl.border_radius);

    let (w, h) = (image.width(), image.height());
    let padding = tpl.padding.max(1);
    let new_w = w + 2 * padding;
    let new_h = h + 2 * padding;
    let (r1, g1, b1) = parse_hex_color(&tpl.color1);
    let (r2, g2, b2) = parse_hex_color(&tpl.color2);
    let solid = tpl.bg_type == "solid";

    let mut bg = RgbaImage::new(new_w, new_h);
    for (x, y, pixel) in bg.enumerate_pixels_mut() {
        let (r, g, b) = if solid {
            (r1, g1, b1)
        } else {
            let t = gradient_t(x as f32, y as f32, new_w as f32, new_h as f32, tpl.angle);
            (r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t)
        };
        *pixel = image::Rgba([r as u8, g as u8, b as u8, 255]);
    }

    // Cheap drop shadow: a handful of shrinking, increasingly opaque rounded
    // rects behind the image approximate a blurred shadow without a real
    // (and much slower) gaussian blur pass.
    if tpl.shadow {
        let steps = 10;
        for i in 0..steps {
            let spread = (steps - i) as i32 * 2;
            let alpha = (10 + i * 6).min(120) as u32;
            let (x0, y0) = (padding as i32 - spread, padding as i32 - spread);
            let (x1, y1) = ((padding + w) as i32 + spread, (padding + h) as i32 + spread);
            for y in y0.max(0)..y1.min(new_h as i32) {
                for x in x0.max(0)..x1.min(new_w as i32) {
                    let dst = bg.get_pixel_mut(x as u32, y as u32);
                    let inv = 255 - alpha;
                    dst.0[0] = ((dst.0[0] as u32 * inv) / 255) as u8;
                    dst.0[1] = ((dst.0[1] as u32 * inv) / 255) as u8;
                    dst.0[2] = ((dst.0[2] as u32 * inv) / 255) as u8;
                }
            }
        }
    }

    // Manual composite so that alpha=0 gap pixels (e.g. below a shorter monitor in
    // a multi-monitor stitch, or rounded-off corners) are skipped and the
    // background shows through.
    for (x, y, src) in image.enumerate_pixels() {
        let a = src[3] as u32;
        if a == 0 { continue; }
        let bx = x + padding;
        let by = y + padding;
        if a == 255 {
            bg.put_pixel(bx, by, *src);
        } else {
            let dst = *bg.get_pixel(bx, by);
            let inv = 255 - a;
            bg.put_pixel(bx, by, image::Rgba([
                ((src[0] as u32 * a + dst[0] as u32 * inv) / 255) as u8,
                ((src[1] as u32 * a + dst[1] as u32 * inv) / 255) as u8,
                ((src[2] as u32 * a + dst[2] as u32 * inv) / 255) as u8,
                255,
            ]));
        }
    }
    bg
}

pub fn encode_editor_png(image: RgbaImage) -> Result<Vec<u8>, String> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ImageEncoder;
    let (w, h) = (image.width(), image.height());
    let mut buf = Vec::new();
    PngEncoder::new_with_quality(&mut buf, CompressionType::Fast, FilterType::NoFilter)
        .write_image(image.as_raw(), w, h, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

pub fn trigger(app: &AppHandle, capture: ShortcutCapture, actions: Vec<ShortcutAction>, multi_monitor: bool, bg_template: Option<BgTemplate>) {
    #[cfg(target_os = "macos")]
    {
        let denied = app.state::<crate::ScreenPermission>().0.load(std::sync::atomic::Ordering::Relaxed) == 2;
        if denied {
            // Don't bother attempting a capture we already know will come back
            // blank — surface the gallery + permission modal instead so the
            // user re-grants it rather than silently getting an empty shot.
            crate::tray::show_main(app);
            let _ = app.emit("screen-permission-needed", ());
            return;
        }
    }
    match capture {
        ShortcutCapture::Area              => trigger_area(app, actions, multi_monitor, bg_template),
        ShortcutCapture::Window            => trigger_window(app, actions, multi_monitor, bg_template),
        ShortcutCapture::Fullscreen        => trigger_fullscreen(app, actions, multi_monitor, bg_template),
        ShortcutCapture::FullscreenCurrent => trigger_fullscreen(app, actions, false, bg_template), // legacy
    }
}

/// Subtracts rectangle `b` from rectangle `a` [x, y, w, h], returning the remaining pieces.
fn subtract_rect(a: [i32; 4], b: [i32; 4]) -> Vec<[i32; 4]> {
    let [ax, ay, aw, ah] = a;
    let [bx, by, bw, bh] = b;
    let (ax2, ay2, bx2, by2) = (ax + aw, ay + ah, bx + bw, by + bh);
    if bx >= ax2 || bx2 <= ax || by >= ay2 || by2 <= ay {
        return vec![a]; // no overlap
    }
    let mut out = Vec::with_capacity(4);
    if by > ay   { out.push([ax, ay, aw, by - ay]); }           // top strip
    if by2 < ay2 { out.push([ax, by2, aw, ay2 - by2]); }        // bottom strip
    let (sy, sy2) = (by.max(ay), by2.min(ay2));
    if bx > ax   { out.push([ax, sy, bx - ax, sy2 - sy]); }     // left strip
    if bx2 < ax2 { out.push([bx2, sy, ax2 - bx2, sy2 - sy]); } // right strip
    out
}

/// Returns true when `target` is completely covered by the union of `covers`.
fn is_fully_occluded(target: [i32; 4], covers: &[[i32; 4]]) -> bool {
    let mut uncovered = vec![target];
    for &cover in covers {
        uncovered = uncovered.into_iter().flat_map(|r| subtract_rect(r, cover)).collect();
        if uncovered.is_empty() {
            return true;
        }
    }
    false
}

pub fn trigger_fullscreen(app: &AppHandle, actions: Vec<ShortcutAction>, multi_monitor: bool, bg_template: Option<BgTemplate>) {
    let app = app.clone();
    let ic = app.state::<std::sync::Arc<crate::icon_cache::IconCache>>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(
            move || -> anyhow::Result<(RgbaImage, CaptureMeta, Vec<(String, u32)>)> {
                let (title, app_name) = capture::foreground_info();
                let cap = if multi_monitor {
                    capture::capture_all_monitors()?
                } else {
                    capture::capture_current_monitor()?
                };
                let canvas_w = cap.image.width() as i32;
                let canvas_h = cap.image.height() as i32;
                let all_windows = capture::list_windows();
                let all_rects: Vec<[i32; 4]> = all_windows.iter()
                    .map(|w| [w.x, w.y, w.w, w.h])
                    .collect();
                let mut icon_targets = Vec::new();
                let window_crops = all_windows.into_iter()
                    .enumerate()
                    .filter(|(_, w)| w.w > 100 && w.h > 100)
                    .filter_map(|(idx, w)| {
                        let x = w.x - cap.origin_x;
                        let y = w.y - cap.origin_y;
                        if x + w.w <= 0 || x >= canvas_w || y + w.h <= 0 || y >= canvas_h {
                            return None;
                        }
                        if is_fully_occluded([w.x, w.y, w.w, w.h], &all_rects[..idx]) {
                            return None;
                        }
                        icon_targets.push((w.app.clone(), w.id));
                        Some(crate::WindowCropInfo {
                            x, y, w: w.w, h: w.h,
                            label: if !w.title.is_empty() { w.title } else { w.app.clone() },
                            app: w.app,
                        })
                    })
                    .collect();
                Ok((cap.image, CaptureMeta {
                    title, app: app_name, is_window: false, tags: vec![],
                    monitor_rects: if multi_monitor { cap.monitor_rects } else { vec![] },
                    monitor_names: if multi_monitor { cap.monitor_names } else { vec![] },
                    window_crops,
                    bg_template: None,
                }, icon_targets))
            },
        )
        .await;
        match result {
            Ok(Ok((mut image, mut meta, icon_targets))) => {
                // Cache window icons in the background, off the capture path: on
                // macOS this shells out to `qlmanage`, which can hang for several
                // seconds on some app bundles and would otherwise stall capture → editor.
                tauri::async_runtime::spawn(async move {
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        for (app_name, id) in icon_targets {
                            ic.cache_from_hwnd(&app_name, id);
                        }
                    })
                    .await;
                });
                let auto_bg = bg_template.is_some() && actions.contains(&ShortcutAction::OpenEditor);
                if actions.contains(&ShortcutAction::OpenEditor) {
                    meta.bg_template = bg_template.clone();
                } else if let Some(tpl) = &bg_template {
                    image = apply_background_padding(image, tpl);
                }
                execute_post_capture(&app, image, meta, &actions, auto_bg).await;
            }
            Ok(Err(e)) => crate::notify_error(&app, &format!("Screen capture failed: {e}")),
            Err(e) => crate::notify_error(&app, &e.to_string()),
        }
    });
}

/// Execute all post-capture actions. OpenEditor is exclusive; all others can combine
/// (subject to the constraint that only one clipboard-copy action fires at a time).
/// `auto_bg` signals the editor to auto-apply its background tool on startup (only
/// meaningful when OpenEditor is in actions and the per-type padding setting is on).
pub async fn execute_post_capture(
    app: &AppHandle,
    image: RgbaImage,
    meta: CaptureMeta,
    actions: &[ShortcutAction],
    auto_bg: bool,
) {
    if actions.contains(&ShortcutAction::OpenEditor) {
        open_editor(app, image, meta, auto_bg);
        return;
    }

    let has_save   = actions.contains(&ShortcutAction::Save);
    let has_copy   = actions.contains(&ShortcutAction::CopyImage);
    let has_direct = actions.contains(&ShortcutAction::DirectLink);
    let has_drive  = actions.contains(&ShortcutAction::DriveLink);

    // Determine cloud/link action (at most one)
    #[derive(PartialEq)]
    enum LinkOp { None, Direct, Drive }
    let link_op = if has_direct { LinkOp::Direct } else if has_drive { LinkOp::Drive } else { LinkOp::None };

    let needs_disk = has_save || link_op != LinkOp::None;

    if needs_disk {
        // Clone for clipboard before moving into save_and_finish
        let clip_img = if has_copy { Some(image.clone()) } else { None };

        let lt = match link_op {
            LinkOp::Direct => LinkTarget::DirectLink,
            LinkOp::Drive  => LinkTarget::Drive,
            LinkOp::None   => LinkTarget::None,
        };
        save_and_finish(app, image, lt, meta, None).await;

        if let Some(img) = clip_img {
            copy_image_to_clipboard(app, &img);
        }
    } else if has_copy {
        // Copy-only: skip disk entirely
        copy_image_to_clipboard(app, &image);
        crate::notify(app, "Shotcove", "Screenshot copied to clipboard");
    } else {
        // No actions specified — fall back to save
        save_and_finish(app, image, LinkTarget::None, meta, None).await;
    }
}

pub fn open_editor(app: &AppHandle, image: RgbaImage, meta: CaptureMeta, auto_bg: bool) -> String {
    open_editor_inner(app, image, meta, auto_bg, None)
}

/// Opens the editor pinned to designing a shortcut's background template:
/// only the background tool is usable, and the toolbar offers "save as
/// template" instead of the normal export actions.
pub fn open_editor_for_template(app: &AppHandle, image: RgbaImage, meta: CaptureMeta, slot_id: String) -> String {
    open_editor_inner(app, image, meta, true, Some(slot_id))
}

fn open_editor_inner(app: &AppHandle, image: RgbaImage, meta: CaptureMeta, auto_bg: bool, template_for: Option<String>) -> String {
    let editor_url = {
        let mut q = vec![];
        if auto_bg { q.push("auto_bg=1".to_string()); }
        if let Some(id) = &template_for {
            q.push(format!("template_for={id}"));
            // Embedded directly in the URL (instead of round-tripping through
            // get_editor_meta) so the editor can apply it synchronously at
            // canvas-init time — no race with its own "load last-used bg
            // prefs" logic, which runs at the same moment.
            if let Some(tpl) = &meta.bg_template {
                if let Ok(json) = serde_json::to_string(tpl) {
                    use base64::Engine;
                    let b64 = base64::engine::general_purpose::URL_SAFE.encode(json);
                    q.push(format!("template_data={b64}"));
                }
            }
        }
        if q.is_empty() { "pages/editor.html".to_string() } else { format!("pages/editor.html?{}", q.join("&")) }
    };
    // Each call gets its own window so several screenshots can be edited at
    // once — labels must stay unique for the lifetime of the app.
    static NEXT_EDITOR_ID: AtomicU32 = AtomicU32::new(0);
    let editor_id = NEXT_EDITOR_ID.fetch_add(1, Ordering::Relaxed);
    let label = format!("editor-{editor_id}");
    app.state::<PendingEditMeta>()
        .0
        .lock()
        .unwrap()
        .insert(label.clone(), meta);
    let app_enc = app.clone();
    let label_enc = label.clone();
    tauri::async_runtime::spawn(async move {
        match tauri::async_runtime::spawn_blocking(move || encode_editor_png(image)).await {
            Ok(Ok(b64)) => {
                app_enc
                    .state::<PendingEdit>()
                    .0
                    .lock()
                    .unwrap()
                    .insert(label_enc, b64);
            }
            _ => log::warn!("editor image could not be encoded"),
        }
    });
    let app2 = app.clone();
    let label_win = label.clone();
    // Cascade new editor windows diagonally so several opened in a row
    // don't land perfectly on top of one another.
    let cascade = (editor_id % 8) as f64 * 32.0;
    let _ = app.run_on_main_thread(move || {
        // Clamp the editor's size/position to the screen's usable work area —
        // on small screens (e.g. a 13" MacBook at 1280x800 logical) the fixed
        // 1280x800 size used to fill the whole screen, and the cascade offset
        // then pushed it off-screen (or under the Dock on macOS) entirely.
        #[cfg(target_os = "macos")]
        let usable = crate::tray::mac_visible_frame();
        #[cfg(not(target_os = "macos"))]
        let usable = app2.primary_monitor().ok().flatten().map(|m| {
            let sf = m.scale_factor();
            let ps = m.size();
            let lw = ps.width as f64 / sf;
            let lh = ps.height as f64 / sf - 48.0; // taskbar margin
            (0.0, 0.0, lw, lh)
        });
        // (area_x, area_y, area_w, area_h): the usable work area's origin + size.
        let (area_x, area_y, area_w, area_h) = usable.unwrap_or((0.0, 0.0, 1280.0, 800.0));
        let min_w = area_w.min(1000.0);
        let min_h = area_h.min(620.0);
        let win_w = area_w.min(1280.0).max(min_w);
        let win_h = area_h.min(800.0).max(min_h);
        let pos_x = (area_x + 80.0 + cascade).min(area_x + area_w - win_w).max(area_x);
        let pos_y = (area_y + 60.0 + cascade).min(area_y + area_h - win_h).max(area_y);
        let build = || -> tauri::Result<()> {
            let mut b = WebviewWindowBuilder::new(&app2, &label_win, WebviewUrl::App(editor_url.clone().into()))
                .title("Shotcove")
                .inner_size(win_w, win_h)
                .min_inner_size(min_w, min_h)
                .position(pos_x, pos_y)
                .decorations(false)
                .transparent(cfg!(target_os = "macos"))
                .visible(false);
            #[cfg(target_os = "macos")]
            {
                b = b.effects(crate::tray::mac_rounded_effects());
            }
            #[cfg(not(target_os = "macos"))]
            {
                b = b.background_color(Color(15, 15, 15, 255));
            }
            #[allow(unused_variables)]
            let win = b.build()?;
            // `mac_visible_frame()`'s NSScreen::mainScreen() can be unreliable
            // right after launch (e.g. the very first shortcut press triggers
            // capture before AppKit has settled), so re-clamp against the real
            // NSWindow's own screen now that it has one assigned.
            #[cfg(target_os = "macos")]
            {
                use objc2_app_kit::NSWindow;
                if let Ok(ns_ptr) = win.ns_window() {
                    unsafe {
                        let ns: &NSWindow = &*ns_ptr.cast();
                        if let Some(screen) = ns.screen() {
                            let full = screen.frame();
                            let vf = screen.visibleFrame();
                            let area_x = vf.origin.x;
                            let area_y = full.size.height - (vf.origin.y + vf.size.height);
                            let area_w = vf.size.width;
                            let area_h = vf.size.height;
                            let min_w = area_w.min(1000.0);
                            let min_h = area_h.min(620.0);
                            let win_w = area_w.min(1280.0).max(min_w);
                            let win_h = area_h.min(800.0).max(min_h);
                            let pos_x = (area_x + 80.0 + cascade).min(area_x + area_w - win_w).max(area_x);
                            let pos_y = (area_y + 60.0 + cascade).min(area_y + area_h - win_h).max(area_y);
                            let _ = win.set_size(tauri::LogicalSize::new(win_w, win_h));
                            let _ = win.set_position(tauri::LogicalPosition::new(pos_x, pos_y));
                        }
                    }
                }
            }
            Ok(())
        };
        if let Err(e) = build() {
            log::warn!("editor could not be opened: {e}");
        }
    });
    label
}

#[cfg(not(target_os = "linux"))]
pub fn open_overlay(app: &AppHandle, mx: i32, my: i32, mw: u32, mh: u32, scale: f32, _live: bool) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(loading) = app2.get_webview_window("loading") {
            let _ = loading.close();
        }
        let build = || -> tauri::Result<()> {
            // On macOS, xcap's monitor x/y/width/height are already in points
            // (CGDisplayBounds), matching the logical units Tauri's window
            // position/size expect — dividing by `scale` again would shrink
            // and mis-position the overlay. On Windows they're physical
            // pixels, so the division is needed there.
            #[cfg(target_os = "macos")]
            let (lx, ly, lw, lh) = { let _ = scale; (mx as f64, my as f64, mw as f64, mh as f64) };
            #[cfg(not(target_os = "macos"))]
            let (lx, ly, lw, lh) = (mx as f64 / scale as f64, my as f64 / scale as f64, mw as f64 / scale as f64, mh as f64 / scale as f64);

            let url = "pages/overlay.html";
            #[allow(unused_variables)]
            let win = WebviewWindowBuilder::new(
                &app2,
                "overlay",
                WebviewUrl::App(url.into()),
            )
            .title("Shotcove")
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(true)
            .transparent(true)
            .visible(false)
            .position(lx, ly)
            .inner_size(lw, lh)
            .build()?;
            // On macOS, position()/inner_size() applied during the builder can be
            // overridden by AppKit's own placement before the window has a real
            // NSScreen assigned (same root cause fixed for the editor window in
            // open_editor_inner) — re-apply now that it has settled.
            #[cfg(target_os = "macos")]
            {
                let _ = win.set_size(tauri::LogicalSize::new(lw, lh));
                let _ = win.set_position(tauri::LogicalPosition::new(lx, ly));
            }
            Ok(())
        };
        if let Err(e) = build() {
            log::warn!("overlay could not be opened: {e}");
        }
    });
}

#[cfg(not(target_os = "linux"))]
fn open_overlay_for_monitor(app: &AppHandle, label: String, mon_index: usize, mx: i32, my: i32, mw: u32, mh: u32, scale: f32, _live: bool) {
    let app2 = app.clone();
    let url = "pages/overlay.html";
    let _ = app.run_on_main_thread(move || {
        let build = || -> tauri::Result<()> {
            // See open_overlay() above for why macOS skips the scale division.
            #[cfg(target_os = "macos")]
            let (lx, ly, lw, lh) = { let _ = scale; (mx as f64, my as f64, mw as f64, mh as f64) };
            #[cfg(not(target_os = "macos"))]
            let (lx, ly, lw, lh) = (mx as f64 / scale as f64, my as f64 / scale as f64, mw as f64 / scale as f64, mh as f64 / scale as f64);

            #[allow(unused_variables)]
            let win = WebviewWindowBuilder::new(
                &app2,
                &label,
                WebviewUrl::App(url.into()),
            )
            .title("Shotcove")
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(true)
            .transparent(true)
            .visible(false)
            .position(lx, ly)
            .inner_size(lw, lh)
            .build()?;
            // See open_overlay() above for why this re-apply is needed on macOS.
            #[cfg(target_os = "macos")]
            {
                let _ = win.set_size(tauri::LogicalSize::new(lw, lh));
                let _ = win.set_position(tauri::LogicalPosition::new(lx, ly));
            }
            Ok(())
        };
        if let Err(e) = build() {
            log::warn!("overlay-{mon_index} could not be opened: {e}");
        }
    });
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn close_all_overlays(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") { let _ = w.close(); }
    for i in 0..8 {
        if let Some(w) = app.get_webview_window(&format!("overlay-{i}")) { let _ = w.close(); }
    }
}

#[cfg(target_os = "linux")]
struct OverlayState {
    app: AppHandle,
    _label: String,
    mon_index: usize,
    mode: OverlayMode,
    scale: f64,
    mon_x: i32,
    mon_y: i32,
    _mon_w: u32,
    _mon_h: u32,
    live_mode: bool,
    pixbuf: Option<gtk::gdk_pixbuf::Pixbuf>,
    start_x: f64,
    start_y: f64,
    current_x: f64,
    current_y: f64,
    is_dragging: bool,
    selection_rect: Option<(f64, f64, f64, f64)>,
    windows: Vec<capture::WinInfo>,
    hovered_window: Option<capture::WinInfo>,
    done: bool,
    lang: String,
}

#[cfg(target_os = "linux")]
pub fn open_overlay(app: &AppHandle, mx: i32, my: i32, mw: u32, mh: u32, scale: f32, live: bool) {
    let monitors = capture::list_monitors();
    let mon_index = monitors.iter().position(|m| {
        mx >= m.x && mx < m.x + m.w as i32 && my >= m.y && my < m.y + m.h as i32
    }).unwrap_or(0);
    open_native_gtk_overlay(app, "overlay".to_string(), mon_index, mx, my, mw, mh, scale, live);
}

#[cfg(target_os = "linux")]
fn open_overlay_for_monitor(app: &AppHandle, label: String, mon_index: usize, mx: i32, my: i32, mw: u32, mh: u32, scale: f32, live: bool) {
    open_native_gtk_overlay(app, label, mon_index, mx, my, mw, mh, scale, live);
}

#[cfg(target_os = "linux")]
pub(crate) fn close_all_overlays(app: &AppHandle) {
    let _ = app;
    // Drain and destroy all windows on the main thread
    let _ = app.run_on_main_thread(|| {
        let windows = NATIVE_WINDOWS.with(|list| {
            list.replace(Vec::new())
        });
        for win in windows {
            unsafe { win.destroy(); }
        }
    });
}

#[cfg(target_os = "linux")]
fn rgba_image_to_pixbuf(img: &RgbaImage) -> Option<gtk::gdk_pixbuf::Pixbuf> {
    let w = img.width();
    let h = img.height();
    if w == 0 || h == 0 {
        return None;
    }
    let row_stride = w * 4;
    let bytes = gtk::glib::Bytes::from(img.as_raw());
    Some(gtk::gdk_pixbuf::Pixbuf::from_bytes(
        &bytes,
        gtk::gdk_pixbuf::Colorspace::Rgb,
        true,
        8,
        w as i32,
        h as i32,
        row_stride as i32,
    ))
}

#[cfg(target_os = "linux")]
fn rounded_rectangle(cr: &gtk::cairo::Context, x: f64, y: f64, width: f64, height: f64, radius: f64) {
    if width <= 0.0 || height <= 0.0 {
        return;
    }
    let degrees = std::f64::consts::PI / 180.0;
    cr.new_sub_path();
    cr.arc(x + width - radius, y + radius, radius, -90.0 * degrees, 0.0 * degrees);
    cr.arc(x + width - radius, y + height - radius, radius, 0.0 * degrees, 90.0 * degrees);
    cr.arc(x + radius, y + height - radius, radius, 90.0 * degrees, 180.0 * degrees);
    cr.arc(x + radius, y + radius, radius, 180.0 * degrees, 270.0 * degrees);
    cr.close_path();
}

#[cfg(target_os = "linux")]
fn get_selection_bounds(state: &OverlayState, max_w: f64, max_h: f64) -> (f64, f64, f64, f64) {
    let rx = state.start_x.min(state.current_x).max(0.0);
    let ry = state.start_y.min(state.current_y).max(0.0);
    let rw = (state.start_x - state.current_x).abs().min(max_w - rx);
    let rh = (state.start_y - state.current_y).abs().min(max_h - ry);
    (rx, ry, rw, rh)
}

#[cfg(target_os = "linux")]
fn draw_badge(cr: &gtk::cairo::Context, x: f64, y: f64, text: &str, follow_mouse: bool) {
    cr.select_font_face("sans-serif", gtk::cairo::FontSlant::Normal, gtk::cairo::FontWeight::Bold);
    cr.set_font_size(12.0);
    
    let extents = match cr.text_extents(text) {
        Ok(e) => e,
        Err(_) => return,
    };
    
    let padding_x = 10.0;
    let padding_y = 6.0;
    let badge_w = extents.width() + padding_x * 2.0;
    let badge_h = extents.height() + padding_y * 2.0;
    
    let bx = x;
    let mut by = y;
    if !follow_mouse {
        if by < 0.0 {
            by = 0.0;
        }
    }
    
    cr.set_source_rgba(28.0 / 255.0, 25.0 / 255.0, 23.0 / 255.0, 0.95);
    rounded_rectangle(cr, bx, by, badge_w, badge_h, 4.0);
    let _ = cr.fill();
    
    cr.set_source_rgba(1.0, 1.0, 1.0, 1.0);
    cr.move_to(bx + padding_x - extents.x_bearing(), by + padding_y - extents.y_bearing());
    let _ = cr.show_text(text);
}

#[cfg(target_os = "linux")]
fn draw_hint(cr: &gtk::cairo::Context, win_w: f64, win_h: f64, text: &str) {
    cr.select_font_face("sans-serif", gtk::cairo::FontSlant::Normal, gtk::cairo::FontWeight::Normal);
    cr.set_font_size(14.0);
    
    let extents = match cr.text_extents(text) {
        Ok(e) => e,
        Err(_) => return,
    };
    
    let padding_x = 16.0;
    let padding_y = 10.0;
    let w = extents.width() + padding_x * 2.0;
    let h = extents.height() + padding_y * 2.0;
    
    let bx = (win_w - w) / 2.0;
    let by = (win_h - h) / 2.0;
    
    cr.set_source_rgba(28.0 / 255.0, 25.0 / 255.0, 23.0 / 255.0, 0.85);
    rounded_rectangle(cr, bx, by, w, h, 6.0);
    let _ = cr.fill();
    
    cr.set_source_rgba(1.0, 1.0, 1.0, 1.0);
    cr.move_to(bx + padding_x - extents.x_bearing(), by + padding_y - extents.y_bearing());
    let _ = cr.show_text(text);
}

#[cfg(target_os = "linux")]
fn draw_overlay(
    area: &gtk::DrawingArea,
    cr: &gtk::cairo::Context,
    state_rc: &Rc<RefCell<OverlayState>>,
) -> gtk::glib::Propagation {
    let state = state_rc.borrow();
    let w = area.allocated_width() as f64;
    let h = area.allocated_height() as f64;
    
    cr.set_source_rgba(0.0, 0.0, 0.0, 0.0);
    cr.set_operator(gtk::cairo::Operator::Source);
    let _ = cr.paint();
    
    if !state.live_mode {
        if let Some(ref pixbuf) = state.pixbuf {
            cr.set_operator(gtk::cairo::Operator::Over);
            let pw = pixbuf.width() as f64;
            let ph = pixbuf.height() as f64;
            let _ = cr.save();
            cr.scale(w / pw, h / ph);
            cr.set_source_pixbuf(pixbuf, 0.0, 0.0);
            let _ = cr.paint();
            let _ = cr.restore();
        }
    }
    
    if !state.live_mode {
        cr.set_operator(gtk::cairo::Operator::Over);
        cr.set_source_rgba(0.0, 0.0, 0.0, 0.45);
        
        if state.mode == OverlayMode::Window {
            if let Some(ref win) = state.hovered_window {
                let wx = (win.x - state.mon_x) as f64 / state.scale;
                let wy = (win.y - state.mon_y) as f64 / state.scale;
                let ww = win.w as f64 / state.scale;
                let wh = win.h as f64 / state.scale;
                
                cr.rectangle(0.0, 0.0, w, h);
                cr.rectangle(wx, wy, ww, wh);
                cr.set_fill_rule(gtk::cairo::FillRule::EvenOdd);
                let _ = cr.fill();
            } else {
                cr.rectangle(0.0, 0.0, w, h);
                let _ = cr.fill();
            }
        } else {
            if state.is_dragging || state.selection_rect.is_some() {
                let (rx, ry, rw, rh) = get_selection_bounds(&state, w, h);
                cr.rectangle(0.0, 0.0, w, h);
                cr.rectangle(rx, ry, rw, rh);
                cr.set_fill_rule(gtk::cairo::FillRule::EvenOdd);
                let _ = cr.fill();
            } else {
                cr.rectangle(0.0, 0.0, w, h);
                let _ = cr.fill();
            }
        }
    }
    
    cr.set_operator(gtk::cairo::Operator::Over);
    
    if state.mode == OverlayMode::Window {
        if let Some(ref win) = state.hovered_window {
            let wx = (win.x - state.mon_x) as f64 / state.scale;
            let wy = (win.y - state.mon_y) as f64 / state.scale;
            let ww = win.w as f64 / state.scale;
            let wh = win.h as f64 / state.scale;
            
            cr.set_source_rgba(1.0, 1.0, 1.0, 0.35);
            cr.rectangle(wx, wy, ww, wh);
            let _ = cr.fill();
            
            cr.set_source_rgba(245.0 / 255.0, 158.0 / 255.0, 11.0 / 255.0, 0.85);
            cr.set_line_width(2.0);
            cr.rectangle(wx, wy, ww, wh);
            let _ = cr.stroke();
            
            let badge_text = if win.title.chars().count() > 70 {
                format!("{}…", win.title.chars().take(70).collect::<String>())
            } else {
                win.title.clone()
            };
            draw_badge(cr, wx, wy - 28.0, &badge_text, false);
        } else {
            let hint_text = if state.live_mode {
                if state.lang == "tr" {
                    "Canlı ekran — pencere seçin · İptal için Esc"
                } else {
                    "Live screen — select window · Esc to cancel"
                }
            } else {
                if state.lang == "tr" {
                    "Ekran donduruldu — pencere seçin · Canlı için orta tuş · İptal için Esc"
                } else {
                    "Screen frozen — select window · Middle mouse for live · Esc to cancel"
                }
            };
            draw_hint(cr, w, h, hint_text);
        }
    } else {
        if state.is_dragging || state.selection_rect.is_some() {
            let (rx, ry, rw, rh) = get_selection_bounds(&state, w, h);
            
            if rw > 0.0 && rh > 0.0 {
                if state.live_mode {
                    cr.set_operator(gtk::cairo::Operator::Clear);
                    cr.rectangle(rx, ry, rw, rh);
                    let _ = cr.fill();
                    cr.set_operator(gtk::cairo::Operator::Over);
                }
                
                cr.set_source_rgba(245.0 / 255.0, 158.0 / 255.0, 11.0 / 255.0, 1.0);
                cr.set_line_width(1.5);
                cr.rectangle(rx, ry, rw, rh);
                let _ = cr.stroke();
                
                let phys_w = (rw * state.scale).round() as i32;
                let phys_h = (rh * state.scale).round() as i32;
                let badge_text = format!("{} × {}", phys_w, phys_h);
                draw_badge(cr, state.current_x + 14.0, state.current_y + 14.0, &badge_text, true);
            }
        } else {
            let hint_text = if state.live_mode {
                if state.lang == "tr" {
                    "Canlı ekran — alan seçin · İptal için Esc"
                } else {
                    "Live screen — select area · Esc to cancel"
                }
            } else {
                if state.lang == "tr" {
                    "Ekran donduruldu — alan seçin · Canlı için orta tuş · İptal için Esc"
                } else {
                    "Screen frozen — select area · Middle mouse for live · Esc to cancel"
                }
            };
            draw_hint(cr, w, h, hint_text);
        }
    }
    
    gtk::glib::Propagation::Proceed
}

#[cfg(target_os = "linux")]
fn handle_button_press(
    win: &gtk::Window,
    event: &gtk::gdk::EventButton,
    state_rc: &Rc<RefCell<OverlayState>>,
) -> gtk::glib::Propagation {
    let mut state = state_rc.borrow_mut();
    if state.done {
        return gtk::glib::Propagation::Proceed;
    }
    
    let button = event.button();
    let (x, y) = event.position();
    
    if button == 3 {
        state.done = true;
        drop(state);
        trigger_cancel(win, state_rc);
        return gtk::glib::Propagation::Stop;
    }
    
    if button == 2 {
        if !state.live_mode {
            state.live_mode = true;
            state.pixbuf = None;
            win.queue_draw();
            let app = state.app.clone();
            tauri::async_runtime::spawn(async move {
                let pending = app.state::<Pending>();
                let mut guard = pending.0.lock().unwrap();
                if let Some(p) = guard.as_mut() {
                    p.live_mode = true;
                }
            });
        }
        return gtk::glib::Propagation::Stop;
    }
    
    if button == 1 {
        if state.mode == OverlayMode::Window {
            let win_id_opt = state.hovered_window.as_ref().map(|w| w.id);
            if let Some(win_id) = win_id_opt {
                state.done = true;
                let app = state.app.clone();
                drop(state);
                unsafe { win.destroy(); }
                
                tauri::async_runtime::spawn(async move {
                    let _ = crate::commands::overlay_cmd::window_selected(app, win_id).await;
                });
            }
        } else {
            state.is_dragging = true;
            state.start_x = x;
            state.start_y = y;
            state.current_x = x;
            state.current_y = y;
            win.queue_draw();
        }
        return gtk::glib::Propagation::Stop;
    }
    
    gtk::glib::Propagation::Proceed
}

#[cfg(target_os = "linux")]
fn handle_button_release(
    win: &gtk::Window,
    event: &gtk::gdk::EventButton,
    state_rc: &Rc<RefCell<OverlayState>>,
) -> gtk::glib::Propagation {
    let mut state = state_rc.borrow_mut();
    if state.done {
        return gtk::glib::Propagation::Proceed;
    }
    
    let button = event.button();
    if button == 1 && state.is_dragging {
        state.is_dragging = false;
        let w = win.allocated_width() as f64;
        let h = win.allocated_height() as f64;
        let (rx, ry, rw, rh) = get_selection_bounds(&state, w, h);
        
        if rw < 4.0 || rh < 4.0 {
            state.selection_rect = None;
            win.queue_draw();
            return gtk::glib::Propagation::Stop;
        }
        
        state.done = true;
        let mon_index = state.mon_index as u32;
        let app = state.app.clone();
        drop(state);
        
        unsafe { win.destroy(); }
        
        tauri::async_runtime::spawn(async move {
            let _ = crate::commands::overlay_cmd::area_selected(app, rx, ry, rw, rh, mon_index).await;
        });
        return gtk::glib::Propagation::Stop;
    }
    
    gtk::glib::Propagation::Proceed
}

#[cfg(target_os = "linux")]
fn handle_motion_notify(
    win: &gtk::Window,
    event: &gtk::gdk::EventMotion,
    state_rc: &Rc<RefCell<OverlayState>>,
) -> gtk::glib::Propagation {
    let mut state = state_rc.borrow_mut();
    if state.done {
        return gtk::glib::Propagation::Proceed;
    }
    
    let (x, y) = event.position();
    state.current_x = x;
    state.current_y = y;
    
    if state.mode == OverlayMode::Window {
        let px = state.mon_x + (x * state.scale).round() as i32;
        let py = state.mon_y + (y * state.scale).round() as i32;
        
        let mut new_hover = None;
        for w in &state.windows {
            if px >= w.x && px <= w.x + w.w && py >= w.y && py <= w.y + w.h {
                new_hover = Some(w.clone());
                break;
            }
        }
        
        if new_hover.as_ref().map(|w| w.id) != state.hovered_window.as_ref().map(|w| w.id) {
            state.hovered_window = new_hover;
            win.queue_draw();
        }
    } else if state.is_dragging {
        win.queue_draw();
    }
    
    gtk::glib::Propagation::Proceed
}

#[cfg(target_os = "linux")]
fn handle_key_press(
    win: &gtk::Window,
    event: &gtk::gdk::EventKey,
    state_rc: &Rc<RefCell<OverlayState>>,
) -> gtk::glib::Propagation {
    let keyval = event.keyval();
    if keyval.name().as_ref().map(|s| s.as_str()) == Some("Escape") {
        let mut state = state_rc.borrow_mut();
        if !state.done {
            state.done = true;
            drop(state);
            trigger_cancel(win, state_rc);
            return gtk::glib::Propagation::Stop;
        }
    }
    gtk::glib::Propagation::Proceed
}



#[cfg(target_os = "linux")]
fn trigger_cancel(win: &gtk::Window, state_rc: &Rc<RefCell<OverlayState>>) {
    let state = state_rc.borrow();
    let app = state.app.clone();
    drop(state);
    
    unsafe { win.destroy(); }
    
    crate::commands::overlay_cmd::overlay_cancel(app);
}

#[cfg(target_os = "linux")]
fn open_native_gtk_overlay(
    app: &AppHandle,
    label: String,
    mon_index: usize,
    mx: i32,
    my: i32,
    mw: u32,
    mh: u32,
    scale: f32,
    live: bool,
) {
    let app2 = app.clone();
    let label_clone = label.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(loading) = app2.get_webview_window("loading") {
            let _ = loading.close();
        }
        
        let settings = app2.state::<std::sync::Arc<ConfigStore>>().get();
        let lang = settings.language.clone();
        
        let pending = app2.state::<Pending>();
        let guard = pending.0.lock().unwrap();
        let (mode, windows, pixbuf, live_mode) = if let Some(p) = guard.as_ref() {
            let pixbuf = if !live {
                match p.mode {
                    OverlayMode::AreaMulti | OverlayMode::Window => {
                        p.mon_images.get(mon_index).and_then(rgba_image_to_pixbuf)
                    }
                    _ => rgba_image_to_pixbuf(&p.image),
                }
            } else {
                None
            };
            (p.mode, p.windows.clone(), pixbuf, p.live_mode || live)
        } else {
            (OverlayMode::Area, Vec::new(), None, live)
        };
        drop(guard);
        
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        window.set_title("Shotcove");
        window.set_decorated(false);
        window.set_keep_above(true);
        window.set_skip_taskbar_hint(true);
        window.set_skip_pager_hint(true);
        window.set_type_hint(gtk::gdk::WindowTypeHint::Normal);
        
        if let Some(screen) = gtk::prelude::GtkWindowExt::screen(&window) {
            if let Some(visual) = screen.rgba_visual() {
                window.set_visual(Some(&visual));
            }
        }
        window.set_app_paintable(true);

        let display = window.display();
        let n_monitors = display.n_monitors();

        // Collect and sort monitors by logical x, y to match the sorting in capture::list_monitors()
        let mut gdk_monitors = Vec::new();
        for i in 0..n_monitors {
            if let Some(m) = display.monitor(i) {
                let geom = m.geometry();
                gdk_monitors.push((i, geom.x(), geom.y(), m));
            }
        }
        gdk_monitors.sort_by_key(|&(_, x, y, _)| (x, y));

        let target_entry = gdk_monitors.get(mon_index).or_else(|| gdk_monitors.first());
        let (target_gdk_mon_index, monitor) = if let Some(&(gdk_idx, _, _, ref m)) = target_entry {
            (gdk_idx, Some(m.clone()))
        } else {
            (mon_index as i32, None)
        };
        
        let (lx, ly, lw, lh, monitor_scale) = if let Some(ref m) = monitor {
            let geom = m.geometry();
            (
                geom.x() as f64,
                geom.y() as f64,
                geom.width() as f64,
                geom.height() as f64,
                m.scale_factor() as f64,
            )
        } else {
            (
                mx as f64 / scale as f64,
                my as f64 / scale as f64,
                mw as f64 / scale as f64,
                mh as f64 / scale as f64,
                scale as f64,
            )
        };
        
        window.move_(lx as i32, ly as i32);
        window.resize(lw as i32, lh as i32);
        
        let state = Rc::new(RefCell::new(OverlayState {
            app: app2.clone(),
            _label: label_clone,
            mon_index,
            mode,
            scale: monitor_scale,
            mon_x: mx,
            mon_y: my,
            _mon_w: mw,
            _mon_h: mh,
            live_mode,
            pixbuf,
            start_x: 0.0,
            start_y: 0.0,
            current_x: 0.0,
            current_y: 0.0,
            is_dragging: false,
            selection_rect: None,
            windows,
            hovered_window: None,
            done: false,
            lang,
        }));
        
        let area = gtk::DrawingArea::new();
        window.add(&area);
        
        window.add_events(
            gtk::gdk::EventMask::BUTTON_PRESS_MASK
            | gtk::gdk::EventMask::BUTTON_RELEASE_MASK
            | gtk::gdk::EventMask::POINTER_MOTION_MASK
            | gtk::gdk::EventMask::KEY_PRESS_MASK
            | gtk::gdk::EventMask::FOCUS_CHANGE_MASK
            | gtk::gdk::EventMask::LEAVE_NOTIFY_MASK
        );
        
        let state_draw = Rc::clone(&state);
        area.connect_draw(move |area, cr| {
            draw_overlay(area, cr, &state_draw)
        });
        
        let state_press = Rc::clone(&state);
        window.connect_button_press_event(move |win, event| {
            handle_button_press(win, event, &state_press)
        });
        
        let state_release = Rc::clone(&state);
        window.connect_button_release_event(move |win, event| {
            handle_button_release(win, event, &state_release)
        });
        
        let state_motion = Rc::clone(&state);
        window.connect_motion_notify_event(move |win, event| {
            handle_motion_notify(win, event, &state_motion)
        });
        
        let state_leave = Rc::clone(&state);
        window.connect_leave_notify_event(move |win, _event| {
            let mut state = state_leave.borrow_mut();
            if state.hovered_window.is_some() {
                state.hovered_window = None;
                win.queue_draw();
            }
            gtk::glib::Propagation::Proceed
        });
        
        let state_key = Rc::clone(&state);
        window.connect_key_press_event(move |win, event| {
            handle_key_press(win, event, &state_key)
        });
        

        let win_weak = window.clone();
        window.connect_destroy(move |_| {
            NATIVE_WINDOWS.with(|list| {
                if let Ok(mut borrow) = list.try_borrow_mut() {
                    borrow.retain(|w| w != &win_weak);
                }
            });
        });

        window.realize();
        window.show_all();
        if let Some(screen) = gtk::prelude::GtkWindowExt::screen(&window) {
            window.fullscreen_on_monitor(&screen, target_gdk_mon_index);
        }
        window.present();
        window.grab_focus();
        
        let win_clone = window.clone();
        gtk::glib::timeout_add_local(std::time::Duration::from_millis(50), move || {
            if let Some(screen) = gtk::prelude::GtkWindowExt::screen(&win_clone) {
                win_clone.fullscreen_on_monitor(&screen, target_gdk_mon_index);
            }
            win_clone.present();
            gtk::glib::ControlFlow::Break
        });
        
        let win_clone2 = window.clone();
        gtk::glib::timeout_add_local(std::time::Duration::from_millis(150), move || {
            if let Some(screen) = gtk::prelude::GtkWindowExt::screen(&win_clone2) {
                win_clone2.fullscreen_on_monitor(&screen, target_gdk_mon_index);
            }
            win_clone2.present();
            gtk::glib::ControlFlow::Break
        });

        let win_clone3 = window.clone();
        gtk::glib::timeout_add_local(std::time::Duration::from_millis(300), move || {
            if let Some(screen) = gtk::prelude::GtkWindowExt::screen(&win_clone3) {
                win_clone3.fullscreen_on_monitor(&screen, target_gdk_mon_index);
            }
            win_clone3.present();
            gtk::glib::ControlFlow::Break
        });
        
        NATIVE_WINDOWS.with(|list| {
            list.borrow_mut().push(window);
        });
    });
}


/// Snapshot of what's needed to reopen the overlay window(s), taken before
/// closing them (see `reopen_overlay_live` command).
pub(crate) struct LiveReopenInfo {
    mode: OverlayMode,
    monitors: Vec<crate::MonitorInfo>,
    mon_x: i32,
    mon_y: i32,
    mon_w: u32,
    mon_h: u32,
    scale: f32,
}

pub(crate) fn live_reopen_info(app: &AppHandle) -> Option<LiveReopenInfo> {
    let pending = app.state::<Pending>();
    let mut guard = pending.0.lock().unwrap();
    let p = guard.as_mut()?;
    p.live_mode = true;
    Some(LiveReopenInfo {
        mode: p.mode,
        monitors: p.monitors.clone(),
        mon_x: p.mon_x,
        mon_y: p.mon_y,
        mon_w: p.mon_w,
        mon_h: p.mon_h,
        scale: p.scale,
    })
}

/// Reopens the overlay window(s) already in "live" mode, so the very first
/// paint is transparent instead of toggling an already-opaque window to
/// transparent after the fact. WebKitGTK on Linux doesn't reliably re-clear
/// an already-opaque transparent window to show the real desktop through —
/// recreating the window sidesteps that.
pub(crate) fn open_overlays_live(app: &AppHandle, info: LiveReopenInfo) {
    match info.mode {
        OverlayMode::Area => open_overlay(app, info.mon_x, info.mon_y, info.mon_w, info.mon_h, info.scale, true),
        OverlayMode::AreaMulti | OverlayMode::Window => {
            if info.monitors.is_empty() {
                open_overlay_for_monitor(app, "overlay-0".into(), 0, info.mon_x, info.mon_y, info.mon_w, info.mon_h, info.scale, true);
            } else {
                for (i, mon) in info.monitors.iter().enumerate() {
                    open_overlay_for_monitor(app, format!("overlay-{i}"), i, mon.x, mon.y, mon.w, mon.h, mon.scale, true);
                }
            }
        }
    }
}

#[allow(dead_code)]
#[derive(serde::Deserialize)]
pub(crate) struct HighlightRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

fn is_any_overlay_open(app: &AppHandle) -> bool {
    if app.get_webview_window("overlay").is_some() { return true; }
    for i in 0..8 {
        if app.get_webview_window(&format!("overlay-{i}")).is_some() { return true; }
    }
    false
}

fn trigger_area(app: &AppHandle, actions: Vec<ShortcutAction>, multi_monitor: bool, bg_template: Option<BgTemplate>) {
    if is_any_overlay_open(app) {
        return;
    }
    if multi_monitor {
        trigger_area_multi(app, actions, bg_template);
    } else {
        trigger_area_single(app, actions, bg_template);
    }
}

fn trigger_area_single(app: &AppHandle, actions: Vec<ShortcutAction>, bg_template: Option<BgTemplate>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (cx, cy) = capture::cursor_position();

        // Capture screenshot and foreground info in parallel.
        // The screenshot is taken before the overlay opens so the frozen bg shows
        // the screen state at the moment the shortcut was pressed.
        let (shot_res, meta_res) = tokio::join!(
            tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<(i32, i32, u32, u32, f32, RgbaImage, Option<String>)> {
                let shot = capture::capture_monitor_at(cx, cy)?;
                let mx = shot.x;
                let my = shot.y;
                let mw = shot.width;
                let mh = shot.height;
                let scale = shot.scale;
                let jpeg = encode_overlay_jpeg(&shot.image)
                    .map(|b64| format!("data:image/jpeg;base64,{b64}"));
                Ok((mx, my, mw, mh, scale, shot.image, jpeg))
            }),
            tauri::async_runtime::spawn_blocking(capture::foreground_info),
        );

        let (mx, my, mw, mh, scale, image, image_jpeg) = match shot_res {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => { crate::notify_error(&app, &format!("Screen capture failed: {e}")); return; }
            Err(e)     => { crate::notify_error(&app, &e.to_string()); return; }
        };
        let (title, app_name) = meta_res.unwrap_or((None, None));

        *app.state::<Pending>().0.lock().unwrap() = Some(PendingCapture {
            image,
            image_jpeg,
            scale,
            actions,
            meta: CaptureMeta { title, app: app_name, is_window: false, tags: vec![], monitor_rects: vec![], monitor_names: vec![], window_crops: vec![], bg_template: None },
            mode: OverlayMode::Area,
            windows: Vec::new(),
            mon_x: mx,
            mon_y: my,
            mon_w: mw,
            mon_h: mh,
            monitors: Vec::new(),
            mon_jpegs: Vec::new(),
            live_mode: false,
            mon_images: Vec::new(),
            bg_template,
        });

        open_overlay(&app, mx, my, mw, mh, scale, false);
    });
}

fn trigger_area_multi(app: &AppHandle, actions: Vec<ShortcutAction>, bg_template: Option<BgTemplate>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Capture all monitors and get foreground info in parallel.
        // Screenshots are taken before overlays open so each overlay shows a frozen bg.
        let (capture_res, meta_res) = tokio::join!(
            tauri::async_runtime::spawn_blocking(|| {
                let monitors = capture::list_monitors();
                let mut mon_images: Vec<RgbaImage> = Vec::new();
                let mut mon_jpegs: Vec<String> = Vec::new();
                for mon in &monitors {
                    let cx = mon.x + (mon.w / 2) as i32;
                    let cy = mon.y + (mon.h / 2) as i32;
                    match capture::capture_monitor_at(cx, cy) {
                        Ok(shot) => {
                            let jpeg = encode_overlay_jpeg(&shot.image)
                                .map(|b64| format!("data:image/jpeg;base64,{b64}"))
                                .unwrap_or_default();
                            mon_jpegs.push(jpeg);
                            mon_images.push(shot.image);
                        }
                        Err(_) => {
                            mon_jpegs.push(String::new());
                            mon_images.push(image::ImageBuffer::new(mon.w, mon.h));
                        }
                    }
                }
                (monitors, mon_images, mon_jpegs)
            }),
            tauri::async_runtime::spawn_blocking(capture::foreground_info),
        );

        let Ok((monitors, mon_images, mon_jpegs)) = capture_res else {
            crate::notify_error(&app, "Screen capture failed");
            return;
        };
        let (title, app_name) = meta_res.unwrap_or((None, None));

        if monitors.is_empty() {
            crate::notify_error(&app, "No monitors found");
            return;
        }

        let first = &monitors[0];
        let first_image = mon_images.first().cloned().unwrap_or_else(|| image::ImageBuffer::new(0, 0));
        *app.state::<Pending>().0.lock().unwrap() = Some(PendingCapture {
            image: first_image,
            image_jpeg: None,
            scale: first.scale,
            actions,
            meta: CaptureMeta {
                title, app: app_name, is_window: false, tags: vec![],
                monitor_rects: vec![],
                monitor_names: vec![],
                window_crops: vec![],
                bg_template: None,
            },
            mode: OverlayMode::AreaMulti,
            windows: Vec::new(),
            mon_x: first.x,
            mon_y: first.y,
            mon_w: first.w,
            mon_h: first.h,
            monitors: monitors.clone(),
            mon_jpegs,
            live_mode: false,
            mon_images,
            bg_template,
        });

        // Open one overlay per monitor
        for (i, mon) in monitors.iter().enumerate() {
            open_overlay_for_monitor(&app, format!("overlay-{i}"), i, mon.x, mon.y, mon.w, mon.h, mon.scale, false);
        }
    });
}

fn trigger_window(app: &AppHandle, actions: Vec<ShortcutAction>, multi_monitor: bool, bg_template: Option<BgTemplate>) {
    if is_any_overlay_open(app) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (monitors, windows) = tokio::join!(
            tauri::async_runtime::spawn_blocking(capture::list_monitors),
            tauri::async_runtime::spawn_blocking(capture::list_windows),
        );

        let mut monitors = monitors.unwrap_or_default();
        let windows = match windows {
            Ok(w) => w,
            Err(e) => {
                crate::notify_error(&app, &e.to_string());
                return;
            }
        };

        if monitors.is_empty() {
            crate::notify_error(&app, "No monitors found");
            return;
        }

        if !multi_monitor {
            // Limit overlay to the monitor under the cursor
            let (cx, cy) = capture::cursor_position();
            if let Some(pos) = monitors.iter().position(|m| {
                cx >= m.x && cx < m.x + m.w as i32 && cy >= m.y && cy < m.y + m.h as i32
            }) {
                monitors = vec![monitors.swap_remove(pos)];
            } else {
                monitors.truncate(1);
            }
        }

        // Capture screenshots of the selected monitors
        let monitors_clone = monitors.clone();
        let capture_res = tauri::async_runtime::spawn_blocking(move || {
            let mut mon_images = Vec::new();
            let mut mon_jpegs = Vec::new();
            for mon in &monitors_clone {
                let cx = mon.x + (mon.w / 2) as i32;
                let cy = mon.y + (mon.h / 2) as i32;
                match capture::capture_monitor_at(cx, cy) {
                    Ok(shot) => {
                        let jpeg = encode_overlay_jpeg(&shot.image)
                            .map(|b64| format!("data:image/jpeg;base64,{b64}"))
                            .unwrap_or_default();
                        mon_jpegs.push(jpeg);
                        mon_images.push(shot.image);
                    }
                    Err(_) => {
                        mon_jpegs.push(String::new());
                        mon_images.push(image::ImageBuffer::new(mon.w, mon.h));
                    }
                }
            }
            (mon_images, mon_jpegs)
        })
        .await
        .unwrap_or_else(|_| (Vec::new(), Vec::new()));

        let (mon_images, mon_jpegs) = capture_res;

        let first = &monitors[0];
        let first_image = mon_images.first().cloned().unwrap_or_else(|| image::ImageBuffer::new(0, 0));
        let first_jpeg = mon_jpegs.first().cloned();

        *app.state::<Pending>().0.lock().unwrap() = Some(PendingCapture {
            image: first_image,
            image_jpeg: if multi_monitor { None } else { first_jpeg },
            scale: first.scale,
            actions,
            meta: CaptureMeta::default(),
            mode: OverlayMode::Window,
            windows,
            mon_x: first.x,
            mon_y: first.y,
            mon_w: first.w,
            mon_h: first.h,
            monitors: if multi_monitor { monitors.clone() } else { Vec::new() },
            mon_jpegs: if multi_monitor { mon_jpegs } else { Vec::new() },
            live_mode: false,
            mon_images: if multi_monitor { mon_images } else { Vec::new() },
            bg_template,
        });

        // Open one overlay per (selected) monitor
        for (i, mon) in monitors.iter().enumerate() {
            open_overlay_for_monitor(&app, format!("overlay-{i}"), i, mon.x, mon.y, mon.w, mon.h, mon.scale, false);
        }
    });
}

pub async fn save_and_finish(
    app: &AppHandle,
    image: RgbaImage,
    target: LinkTarget,
    meta: CaptureMeta,
    override_format: Option<ImageFormat>,
) {
    let settings = app.state::<Arc<ConfigStore>>().get();
    let dir = settings.resolved_screenshots_dir();
    let format = override_format.unwrap_or_else(|| settings.format.clone());
    let is_avif = matches!(format, ImageFormat::Avif);
    let format2 = format.clone();
    let jpeg_quality = settings.jpeg_quality;

    // Phase 1 (fast ~20 ms): generate the destination path + encode JPEG thumbnail from raw RGBA.
    // This runs before the slow format encoder (AVIF can take several seconds) so the gallery
    // card and tray thumbnail appear immediately.
    let phase1 = tauri::async_runtime::spawn_blocking(move || {
        capture::make_save_path(&dir, &format).map(|path| {
            let thumb = encode_overlay_jpeg(&image);
            (path, thumb, image) // return image so phase 2 can consume it
        })
    })
    .await;
    let (path, thumb_b64, image) = match phase1 {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => { crate::notify_error(app, &format!("Could not create file: {e}")); return; }
        Err(e)     => { crate::notify_error(app, &e.to_string()); return; }
    };

    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
    let captured_ts = chrono::Utc::now().timestamp();

    app.state::<Arc<meta::MetaStore>>().set(
        file_name.clone(),
        meta::ScreenshotMeta {
            title: meta.title.clone(),
            app: meta.app.clone(),
            created: Some(captured_ts),
            tags: meta.tags.clone(),
        },
    );
    app.state::<library::LibraryCache>().clear();

    // Emit immediately — the file is not yet on disk, but the path and thumbnail are ready.
    // The gallery/tray use thumb_b64 for display, so the item appears right away.
    // modified/size are omitted here; list_library fills them in after library-changed.
    let _ = app.emit("screenshot-saved", serde_json::json!({
        "name": file_name,
        "local_path": path.to_string_lossy(),
        "thumb_b64": thumb_b64,
        "modified": serde_json::Value::Null,
        "size": serde_json::Value::Null,
        "title": meta.title,
        "app": meta.app,
        "captured": captured_ts,
        "tags": meta.tags,
    }));

    // Cache a JPEG sidecar for AVIF so thumbnails work without a WIC AVIF decoder.
    // Read back by list_recent_local/list_library via library::local_thumb_path.
    if is_avif {
        if let Some(ref b64) = thumb_b64 {
            use base64::Engine;
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                crate::library::write_local_thumb(app, &file_name, &bytes);
            }
        }
    }

    // Phase 2 (slow for AVIF): encode and write the actual file.
    let path_write = path.clone();
    let phase2 = tauri::async_runtime::spawn_blocking(move || {
        capture::write_image(&image, &path_write, &format2, jpeg_quality)
    })
    .await;
    match phase2 {
        Ok(Ok(())) => {}
        Ok(Err(e)) => { crate::notify_error(app, &format!("Could not save: {e}")); return; }
        Err(e)     => { crate::notify_error(app, &e.to_string()); return; }
    }

    let _ = app.emit("library-changed", ());

    match target {
        LinkTarget::None => {
            let engine = app.state::<Arc<sync::SyncEngine>>();
            let _ = engine.tx.send(path.clone());
            crate::notify(app, "Shotcove", &format!("Screenshot saved: {file_name}"));
        }
        LinkTarget::DirectLink => {
            if !direct_link::any_provider_enabled(&settings) {
                crate::notify(
                    app, "Shotcove",
                    &format!("{file_name} saved. Enable Direct Link provider in Settings to get a link."),
                );
                return;
            }
            let is_avif = path.extension()
                .map(|e| e.eq_ignore_ascii_case("avif"))
                .unwrap_or(false);

            let (upload_bytes, upload_name) = if is_avif {
                let sidecar_bytes = crate::library::local_thumb_path(app, &file_name)
                    .and_then(|s| std::fs::read(s).ok());
                if let Some(jpeg_bytes) = sidecar_bytes {
                    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("screenshot");
                    (jpeg_bytes, format!("{stem}.jpg"))
                } else {
                    match std::fs::read(&path) {
                        Ok(b) => (b, file_name.clone()),
                        Err(e) => { crate::notify_error(app, &format!("File could not be read: {e}")); return; }
                    }
                }
            } else {
                match std::fs::read(&path) {
                    Ok(b) => (b, file_name.clone()),
                    Err(e) => { crate::notify_error(app, &format!("File could not be read: {e}")); return; }
                }
            };

            match direct_link::upload_to_provider(&settings, &upload_name, &upload_bytes).await {
                Ok(url) => {
                    let _ = app.clipboard().write_text(&url);
                    crate::notify(app, "Shotcove", "Direct link copied to clipboard ✓");
                }
                Err(e) => crate::notify_error(app, &format!("Upload failed: {e}")),
            }
        }
        LinkTarget::Drive => {
            let drive = app.state::<Arc<DriveClient>>();
            if !drive.is_connected() {
                crate::notify(
                    app, "Shotcove",
                    &format!("{file_name} saved. Connect Google Drive in Settings to get a Drive link."),
                );
                return;
            }
            match sync::upload_and_record(app, &path).await {
                Ok(_) => {
                    let state = app.state::<Arc<sync::SyncState>>();
                    match state.get(&file_name) {
                        Some(id) => {
                            match drive.share_link(settings.effective_google_client_id(), settings.effective_google_client_secret(), &id).await {
                                Ok(url) => {
                                    let _ = app.clipboard().write_text(url);
                                    crate::notify(app, "Shotcove", "Drive link copied to clipboard ✓");
                                }
                                Err(e) => crate::notify_error(app, &format!("Failed to get Drive link: {e}")),
                            }
                        }
                        None => crate::notify_error(app, "Drive file ID not found"),
                    }
                }
                Err(e) => crate::notify_error(app, &format!("Failed to upload to Drive: {e}")),
            }
        }
    }
}

#[cfg(target_os = "linux")]
thread_local! {
    static NATIVE_WINDOWS: std::cell::RefCell<Vec<gtk::Window>> = std::cell::RefCell::new(Vec::new());
}





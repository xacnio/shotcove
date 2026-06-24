use crate::config::ImageFormat;
use anyhow::{anyhow, Context, Result};
use chrono::Local;
use image::RgbaImage;
use std::path::PathBuf;
use xcap::Monitor;

/// Captures a monitor's image. On macOS this goes through ScreenCaptureKit
/// instead of xcap's `capture_image()` (which calls the deprecated
/// `CGWindowListCreateImage` and returns blank images on newer macOS).
fn monitor_capture_image(monitor: &Monitor) -> Result<RgbaImage> {
    #[cfg(target_os = "macos")]
    {
        if crate::capture_macos::is_available() {
            let id = monitor.id().context("failed to get monitor id")?;
            return crate::capture_macos::capture_display(id);
        }
    }
    monitor.capture_image().context("failed to capture monitor image")
}

/// Full image of a monitor + position/scale information.
#[allow(dead_code)]
pub struct MonitorShot {
    pub image: RgbaImage,
    pub scale: f32,
    /// Monitor position in screen coordinates (physical pixels)
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn capture_monitor_at(px: i32, py: i32) -> Result<MonitorShot> {
    let monitor = monitor_at(px, py)?;
    let image = monitor_capture_image(&monitor)?;
    let scale = monitor.scale_factor().unwrap_or(1.0);
    let x = monitor.x().unwrap_or(0);
    let y = monitor.y().unwrap_or(0);
    let width = monitor.width().unwrap_or_else(|_| image.width());
    let height = monitor.height().unwrap_or_else(|_| image.height());
    Ok(MonitorShot {
        image,
        scale,
        x,
        y,
        width,
        height,
    })
}

pub struct VirtualScreenCapture {
    pub image: RgbaImage,
    pub monitor_rects: Vec<[u32; 4]>,
    pub monitor_names: Vec<String>,
    pub origin_x: i32,
    pub origin_y: i32,
}

/// Captures every monitor and stitches them into a single virtual-screen image.
pub fn capture_all_monitors() -> Result<VirtualScreenCapture> {
    let monitors = Monitor::all().context("failed to list monitors")?;
    if monitors.is_empty() {
        return Err(anyhow!("no monitors found"));
    }

    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;

    let mut captures: Vec<(i32, i32, String, RgbaImage)> = Vec::with_capacity(monitors.len());
    for m in &monitors {
        let x = m.x().unwrap_or(0);
        let y = m.y().unwrap_or(0);
        let name_str = m.name().ok().unwrap_or_default();
        let name = if m.is_primary().unwrap_or(false) {
            format!("{} (Primary)", name_str)
        } else {
            name_str
        };
        let img = monitor_capture_image(m)?;
        let (iw, ih) = (img.width() as i32, img.height() as i32);
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x + iw);
        max_y = max_y.max(y + ih);
        captures.push((x, y, name, img));
    }

    // Sort left-to-right, top-to-bottom so monitor_rects[0] == leftmost monitor.
    captures.sort_by_key(|&(x, y, _, _)| (x, y));

    let canvas_w = (max_x - min_x) as u32;
    let canvas_h = (max_y - min_y) as u32;
    let mut canvas = RgbaImage::new(canvas_w, canvas_h);
    let mut rects: Vec<[u32; 4]> = Vec::with_capacity(captures.len());
    let mut names: Vec<String> = Vec::with_capacity(captures.len());

    for (x, y, name, img) in &captures {
        let ox = (x - min_x) as u32;
        let oy = (y - min_y) as u32;
        rects.push([ox, oy, img.width(), img.height()]);
        names.push(name.clone());
        image::imageops::replace(&mut canvas, img, ox as i64, oy as i64);
    }

    Ok(VirtualScreenCapture { image: canvas, monitor_rects: rects, monitor_names: names, origin_x: min_x, origin_y: min_y })
}


/// Captures only the monitor that the cursor is currently on.
pub fn capture_current_monitor() -> Result<VirtualScreenCapture> {
    let (cx, cy) = cursor_position_fallback();
    let mon = monitor_at(cx, cy)?;
    let origin_x = mon.x().unwrap_or(0);
    let origin_y = mon.y().unwrap_or(0);
    let name_str = mon.name().ok().unwrap_or_default();
    let name = if mon.is_primary().unwrap_or(false) {
        format!("{} (Primary)", name_str)
    } else {
        name_str
    };
    let img = monitor_capture_image(&mon).context("failed to capture current monitor")?;
    Ok(VirtualScreenCapture { image: img, monitor_rects: vec![], monitor_names: vec![name], origin_x, origin_y })
}

pub fn list_monitors() -> Vec<crate::MonitorInfo> {
    let mut monitors: Vec<crate::MonitorInfo> = Monitor::all().unwrap_or_default().into_iter().map(|m| crate::MonitorInfo {
        x: m.x().unwrap_or(0),
        y: m.y().unwrap_or(0),
        w: m.width().unwrap_or(1920),
        h: m.height().unwrap_or(1080),
        scale: m.scale_factor().unwrap_or(1.0),
    }).collect();
    // Sort left-to-right, top-to-bottom so Monitor 1 is always the leftmost monitor.
    monitors.sort_by_key(|m| (m.x, m.y));
    monitors
}

pub fn monitor_at(px: i32, py: i32) -> Result<Monitor> {
    if let Ok(m) = Monitor::from_point(px, py) {
        return Ok(m);
    }
    Monitor::all()
        .context("failed to list monitors")?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("no monitor found"))
}

/// Information about a visible, top-level window (physical pixel coordinates).
#[derive(Clone)]
pub struct WinInfo {
    pub id: u32,
    pub title: String,
    pub app: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Returns the executable name (without extension) of a window.
#[cfg(windows)]
fn window_exe(hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, FALSE};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid).ok()?;
        let mut buf = [0u16; 512];
        let mut size = buf.len() as u32;
        let res = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(handle);
        res.ok()?;
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        std::path::Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
    }
}

#[cfg(windows)]
fn window_title(hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, &mut buf);
        let t = String::from_utf16_lossy(&buf[..n as usize]);
        if t.trim().is_empty() {
            None
        } else {
            Some(t)
        }
    }
}

/// Returns the foreground window's (title, app name) info. Called when taking
/// a screenshot; stored as metadata.
pub fn foreground_info() -> (Option<String>, Option<String>) {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        unsafe {
            let hwnd = GetForegroundWindow();
            if !hwnd.is_invalid() {
                return (window_title(hwnd), window_exe(hwnd));
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(windows) = xcap::Window::all() {
            if let Some(w) = windows.into_iter().find(|w| w.is_focused().unwrap_or(false)) {
                let title = w.title().ok().filter(|t| !t.trim().is_empty());
                let app = w.app_name().ok().filter(|a| !a.is_empty());
                return (title, app);
            }
        }
    }
    (None, None)
}

/// Lists visible, top-level windows in z-order (topmost first).
/// Used for highlighting in the window-picker overlay.
pub fn list_windows() -> Vec<WinInfo> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowLongW, GetWindowRect, IsIconic, IsWindowVisible, GWL_EXSTYLE,
        };

        extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
            unsafe {
                let out = &mut *(lparam.0 as *mut Vec<WinInfo>);
                if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                    return TRUE;
                }
                let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
                // Skip floating toolbars and non-activatable system UI (e.g. input panel)
                use windows::Win32::UI::WindowsAndMessaging::{WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW};
                if ex & WS_EX_TOOLWINDOW.0 != 0 || ex & WS_EX_NOACTIVATE.0 != 0 {
                    return TRUE;
                }
                let Some(title) = window_title(hwnd) else {
                    return TRUE;
                };
                let mut rect = RECT::default();
                if GetWindowRect(hwnd, &mut rect).is_err() {
                    return TRUE;
                }
                use windows::Win32::Graphics::Dwm::{
                    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
                };
                // Skip cloaked windows: virtual desktops, shell-managed hidden windows
                let mut cloaked: u32 = 0;
                let _ = DwmGetWindowAttribute(
                    hwnd,
                    DWMWA_CLOAKED,
                    &mut cloaked as *mut _ as *mut _,
                    std::mem::size_of::<u32>() as u32,
                );
                if cloaked != 0 {
                    return TRUE;
                }
                // Prefer DWM frame bounds — strips the invisible shadow margin that
                // GetWindowRect includes, giving accurate visual coordinates.
                let mut frame = rect;
                let _ = DwmGetWindowAttribute(
                    hwnd,
                    DWMWA_EXTENDED_FRAME_BOUNDS,
                    &mut frame as *mut _ as *mut _,
                    std::mem::size_of::<RECT>() as u32,
                );
                let (w, h) = (frame.right - frame.left, frame.bottom - frame.top);
                if w < 48 || h < 48 {
                    return TRUE;
                }
                out.push(WinInfo {
                    id: hwnd.0 as u32,
                    title,
                    app: window_exe(hwnd).unwrap_or_default(),
                    x: frame.left,
                    y: frame.top,
                    w,
                    h,
                });
                TRUE
            }
        }

        let mut out: Vec<WinInfo> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(cb), LPARAM(&mut out as *mut _ as isize));
        }
        return out;
    }
    #[cfg(not(windows))]
    {
        return list_windows_xcap();
    }
    #[allow(unreachable_code)]
    Vec::new()
}

/// Cross-platform window enumeration via `xcap::Window` (macOS, Linux/X11+XWayland).
/// Returns an empty list on native Wayland sessions, where per-window introspection
/// isn't available — callers should fall back to monitor-level capture there.
#[cfg(not(windows))]
fn list_windows_xcap() -> Vec<WinInfo> {
    /// Returns true for system/desktop windows that should never appear in the picker.
    fn is_system_window(title: &str, app: &str) -> bool {
        // Desktop icon overlays (GNOME, Nemo, KDE Plasma, etc.)
        let title_lc = title.to_lowercase();
        let app_lc   = app.to_lowercase();
        if title_lc.starts_with("desktop icons") {
            return true;
        }
        // Taskbars / panels / docks
        if app_lc.contains("panel")
            || app_lc.contains("plank")
            || app_lc.contains("xfce4-panel")
            || app_lc.contains("lxpanel")
            || app_lc.contains("tint2")
            || app_lc.contains("polybar")
            || app_lc.contains("waybar")
        {
            return true;
        }
        // macOS system chrome that shows up in the window list but isn't a
        // real pickable window.
        if app_lc == "dock"
            || app_lc == "window server"
            || app_lc == "control center"
            || app_lc == "control centre"
            || app_lc == "notification center"
            || app_lc == "notification centre"
            || app_lc == "spotlight"
            || app_lc == "loginwindow"
        {
            return true;
        }
        false
    }

    let Ok(windows) = xcap::Window::all() else { return Vec::new() };
    windows
        .into_iter()
        .filter_map(|w| {
            if w.is_minimized().unwrap_or(false) {
                return None;
            }
            let id = w.id().ok()?;
            let mut x = w.x().ok()?;
            let mut y = w.y().ok()?;
            let mut width  = w.width().ok()? as i32;
            let mut height = w.height().ok()? as i32;
            if width < 48 || height < 48 {
                return None;
            }
            if let Some((left, right, top, bottom)) = gtk_frame_extents(id) {
                x += left;
                y += top;
                width -= left + right;
                height -= top + bottom;
            }
            let app_name = w.app_name().unwrap_or_default();
            // Many macOS apps never set a CGWindowName, so fall back to the
            // app name rather than dropping the window entirely.
            let title = w.title().ok().filter(|t| !t.trim().is_empty()).unwrap_or_else(|| app_name.clone());
            if title.is_empty() && app_name.is_empty() {
                return None;
            }
            if is_system_window(&title, &app_name) {
                return None;
            }
            Some(WinInfo {
                id,
                title,
                app: app_name,
                x,
                y,
                w: width,
                h: height,
            })
        })
        .collect()
}

#[cfg(windows)]
fn cursor_position_fallback() -> (i32, i32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    (p.x, p.y)
}

#[cfg(not(windows))]
fn cursor_position_fallback() -> (i32, i32) {
    use mouse_position::mouse_position::Mouse;
    match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => (x, y),
        Mouse::Error => (0, 0),
    }
}

pub fn cursor_position() -> (i32, i32) {
    cursor_position_fallback()
}

/// Generates a collision-free destination path without writing any data.
/// Creates the output directory if it does not already exist.
pub fn make_save_path(dir: &PathBuf, format: &ImageFormat) -> Result<PathBuf> {
    std::fs::create_dir_all(dir).context("failed to create screenshots folder")?;
    let now = Local::now();
    let stamp = format!("{}", now.format("%Y-%m-%d_%H-%M-%S-%3f"));
    let mut path = dir.join(format!("{stamp}.{}", format.extension()));
    let mut counter = 1;
    while path.exists() {
        path = dir.join(format!("{stamp}_{counter}.{}", format.extension()));
        counter += 1;
    }
    Ok(path)
}

/// Encodes `image` and writes it to `path` in the requested format.
pub fn write_image(image: &RgbaImage, path: &PathBuf, format: &ImageFormat, jpeg_quality: u8) -> Result<()> {
    match format {
        ImageFormat::Png => image.save(path).context("failed to save png")?,
        ImageFormat::Jpg => {
            let rgb = image::DynamicImage::ImageRgba8(image.clone()).to_rgb8();
            let file = std::fs::File::create(path).context("failed to create jpg file")?;
            let mut writer = std::io::BufWriter::new(file);
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, jpeg_quality);
            encoder.encode_image(&rgb).context("failed to encode jpg")?;
        }
        ImageFormat::Webp => {
            use image::ImageEncoder;
            let file = std::fs::File::create(path).context("failed to create webp file")?;
            let mut writer = std::io::BufWriter::new(file);
            let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut writer);
            encoder.write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgba8).context("failed to encode webp")?;
        }
        ImageFormat::Avif => {
            use image::ImageEncoder;
            let file = std::fs::File::create(path).context("failed to create avif file")?;
            let mut writer = std::io::BufWriter::new(file);
            let encoder = image::codecs::avif::AvifEncoder::new_with_speed_quality(&mut writer, 7, 95);
            encoder.write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgba8).context("failed to encode avif")?;
        }
        ImageFormat::Bmp => {
            use image::ImageEncoder;
            let file = std::fs::File::create(path).context("failed to create bmp file")?;
            let mut writer = std::io::BufWriter::new(file);
            let encoder = image::codecs::bmp::BmpEncoder::new(&mut writer);
            encoder.write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgba8).context("failed to encode bmp")?;
        }
    }
    Ok(())
}

/// Saves the image to a folder using the format selected in settings, with a Date+Time filename.
pub fn save_image(image: &RgbaImage, dir: &PathBuf, format: &ImageFormat, jpeg_quality: u8) -> Result<PathBuf> {
    let path = make_save_path(dir, format)?;
    write_image(image, &path, format, jpeg_quality)?;
    Ok(path)
}


/// Captures the selected window directly without adding any padding or background (preserves transparent corners).
pub fn capture_window_raw(win: &WinInfo, _mon_x: i32, _mon_y: i32) -> Result<RgbaImage> {
    let (wx, wy, ww, wh) = dwm_frame_bounds(win);
    // `win.x/y/w/h` are themselves DWM-trimmed (see `list_windows`), so they can't be used
    // to find the shadow-margin offset — re-fetch the untrimmed rect directly for that.
    let (rx, ry, rw, rh) = match raw_window_bounds(win.id) {
        (rx, ry, rw, rh) if rw > 0 && rh > 0 => (rx, ry, rw, rh),
        _ => (win.x, win.y, win.w, win.h),
    };
    let offset_x = (wx - rx).max(0) as u32;
    let offset_y = (wy - ry).max(0) as u32;
    let full_w = rw.max(ww);
    let full_h = rh.max(wh);
    capture_window_pixels(win.id, wx, wy, ww, wh, full_w, full_h, offset_x, offset_y)
}


/// Windows: captures window pixels directly via PrintWindow(PW_RENDERFULLCONTENT).
/// Falls back to screen capture + crop on failure.
#[cfg(windows)]
fn capture_window_pixels(
    hwnd_id: u32,
    wx: i32,
    wy: i32,
    ww: i32,
    wh: i32,
    full_w: i32,
    full_h: i32,
    offset_x: u32,
    offset_y: u32,
) -> Result<RgbaImage> {
    match capture_via_print_window(hwnd_id, full_w, full_h, offset_x, offset_y, ww, wh) {
        Ok(img) => return Ok(img),
        Err(e) => log::warn!("PrintWindow failed ({e}), falling back to screen capture"),
    }
    let shot = capture_monitor_at(wx, wy)?;
    let ix = (wx - shot.x).max(0) as u32;
    let iy = (wy - shot.y).max(0) as u32;
    crop(&shot.image, ix, iy, ww.max(1) as u32, wh.max(1) as u32)
}

/// Non-Windows: captures the window directly via `xcap::Window::capture_image()`
/// (CGWindowList on macOS, XComposite/XShm on Linux/X11). Falls back to screen
/// capture + crop if the window can't be found or its capture fails (e.g. the
/// window is on a native Wayland surface that xcap can't introspect).
#[cfg(not(windows))]
#[allow(unused_variables)]
fn capture_window_pixels(
    hwnd_id: u32,
    wx: i32,
    wy: i32,
    ww: i32,
    wh: i32,
    _full_w: i32,
    _full_h: i32,
    _offset_x: u32,
    _offset_y: u32,
) -> Result<RgbaImage> {
    #[cfg(target_os = "macos")]
    if crate::capture_macos::is_available() {
        match crate::capture_macos::capture_window(hwnd_id) {
            Ok(img) => {
                log::info!("capture_macos::capture_window (stream) ok: {}x{}", img.width(), img.height());
                return Ok(img);
            }
            Err(e) => log::warn!("capture_macos::capture_window failed, falling back to monitor crop: {e}"),
        }
    }
    // xcap's CGWindowList-based `capture_image()` is the deprecated legacy
    // path; on newer macOS it comes back blank, and we don't use it there
    // (see the macOS branch above instead).
    #[cfg(not(target_os = "macos"))]
    if let Ok(windows) = xcap::Window::all() {
        if let Some(win) = windows.into_iter().find(|w| w.id().map(|id| id == hwnd_id).unwrap_or(false)) {
            if let Ok(img) = win.capture_image() {
                log::info!("xcap::Window::capture_image ok (fallback): {}x{}", img.width(), img.height());
                if let Some((left, _right, top, _bottom)) = gtk_frame_extents(hwnd_id) {
                    return crop(&img, left as u32, top as u32, ww as u32, wh as u32);
                }
                return Ok(img);
            }
        }
    }
    log::info!("capture_window_pixels: falling back to monitor capture + crop. win=({wx},{wy},{ww},{wh})");
    let shot = capture_monitor_at(wx, wy)?;
    log::info!("monitor shot: pos=({},{}) size={}x{} scale={}", shot.x, shot.y, shot.width, shot.height, shot.scale);
    let ix = (wx - shot.x).max(0) as u32;
    let iy = (wy - shot.y).max(0) as u32;
    log::info!("crop origin in monitor image: ({ix},{iy})");
    let mut cropped = crop(&shot.image, ix, iy, ww.max(1) as u32, wh.max(1) as u32)?;
    // A flat crop of the screen doesn't know about the window's actual rounded
    // corners — it just shows whatever was behind them. Mask them to match
    // macOS's standard window corner radius instead of leaking background in.
    #[cfg(target_os = "macos")]
    {
        let (cw, ch) = (cropped.width(), cropped.height());
        let radius = macos_rounded_corner_radius(shot.scale);
        log::info!("cropped image: {cw}x{ch}, corner radius={radius}");
        apply_rounded_corners(cropped.as_mut(), cw, ch, radius);
    }
    Ok(cropped)
}

/// Returns the rounded corner radius (physical pixels) based on the DPI scale Windows uses for the window.
#[cfg(windows)]
fn rounded_corner_radius(hwnd_id: u32) -> u32 {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    let hwnd = HWND(hwnd_id as usize as *mut _);
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    let dpi = if dpi == 0 { 96 } else { dpi };
    // Windows 11 DWM rounded corner radius = 8 DIP
    ((8.0 * dpi as f32 / 96.0).round() as u32).max(1)
}

/// macOS standard window corner radius is 10pt, scaled to physical pixels.
#[cfg(target_os = "macos")]
fn macos_rounded_corner_radius(scale: f32) -> u32 {
    ((10.0 * scale).round() as u32).max(1)
}

/// True if `(px, py)` falls outside the rounded-corner radius `r` of a `w`x`h` rect
/// (i.e. should be masked out when rounding corners).
pub(crate) fn is_outside_rounded_corner(px: i32, py: i32, w: i32, h: i32, r: i32) -> bool {
    let in_left = px < r;
    let in_right = px >= w - r;
    let in_top = py < r;
    let in_bottom = py >= h - r;
    if !((in_left || in_right) && (in_top || in_bottom)) {
        return false;
    }
    let cx = if in_left { r - 1 } else { w - r };
    let cy = if in_top { r - 1 } else { h - r };
    let dx = (px - cx) as f32;
    let dy = (py - cy) as f32;
    dx * dx + dy * dy > (r as f32 - 0.5).powi(2)
}

/// Rounded corner mask: sets the alpha of pixels in corner regions to 0.
/// The pixel buffer must be in RGBA format.
#[cfg(any(windows, target_os = "macos"))]
fn apply_rounded_corners(pixels: &mut [u8], w: u32, h: u32, radius: u32) {
    let r = radius as i32;
    let iw = w as i32;
    let ih = h as i32;
    for py in 0..ih {
        for px in 0..iw {
            if is_outside_rounded_corner(px, py, iw, ih, r) {
                let idx = (py * iw + px) as usize * 4;
                pixels[idx + 3] = 0;
            }
        }
    }
}

/// Captures window content directly via Win32 PrintWindow + GetDIBits.
/// Does not read the DWM screen; works independently of overlay or other window visibility.
#[cfg(windows)]
fn capture_via_print_window(
    hwnd_id: u32,
    full_w: i32,
    full_h: i32,
    offset_x: u32,
    offset_y: u32,
    visible_w: i32,
    visible_h: i32,
) -> Result<RgbaImage> {
    use windows::Win32::Foundation::{COLORREF, HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, CreateSolidBrush, DeleteDC, DeleteObject,
        FillRect, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};

    let w = full_w.max(1);
    let h = full_h.max(1);
    let hwnd = HWND(hwnd_id as usize as *mut _);

    unsafe {
        let hdc_screen = GetDC(None);
        let hdc_mem = CreateCompatibleDC(hdc_screen);
        let hbm = CreateCompatibleBitmap(hdc_screen, w, h);
        let old = SelectObject(hdc_mem, HGDIOBJ(hbm.0));

        // Fill background white (rounded corners and transparent areas stay white)
        let brush = CreateSolidBrush(COLORREF(0x00FF_FFFF));
        let rc = RECT { left: 0, top: 0, right: w, bottom: h };
        let _ = FillRect(hdc_mem, &rc, brush);
        let _ = DeleteObject(HGDIOBJ(brush.0));

        // Render window content directly (including GPU-accelerated content)
        let ok = PrintWindow(hwnd, hdc_mem, PRINT_WINDOW_FLAGS(2u32)); // 2 = PW_RENDERFULLCONTENT

        // Read raw pixels from bitmap
        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h; // negative = top-down row order
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB.0;
        bi.bmiHeader.biSizeImage = (w * h * 4) as u32;

        let mut pixels = vec![0u8; (w * h * 4) as usize];
        let rows = GetDIBits(
            hdc_mem,
            hbm,
            0,
            h as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut bi,
            DIB_RGB_COLORS,
        );

        SelectObject(hdc_mem, old);
        let _ = DeleteObject(HGDIOBJ(hbm.0));
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(None, hdc_screen);

        if !ok.as_bool() || rows == 0 {
            anyhow::bail!("PrintWindow returned ok={} rows={}", ok.as_bool(), rows);
        }

        // GDI BGRA → image RGBA conversion
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2); // B↔R
            chunk[3] = 255;   // set alpha channel to fully opaque
        }

        let full_img = image::RgbaImage::from_raw(w as u32, h as u32, pixels)
            .ok_or_else(|| anyhow::anyhow!("failed to create RgbaImage"))?;

        // Crop to the visible area only
        let mut cropped_img = crop(&full_img, offset_x, offset_y, visible_w as u32, visible_h as u32)?;

        // Apply Windows 11 DWM rounded corners with software mask
        let radius = rounded_corner_radius(hwnd_id);
        apply_rounded_corners(cropped_img.as_mut(), visible_w as u32, visible_h as u32, radius);

        Ok(cropped_img)
    }
}

/// Windows: shadow-free bounds via DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS).
/// Falls back to GetWindowRect bounds on other platforms or DWM failure.
#[cfg(windows)]
fn dwm_frame_bounds(win: &WinInfo) -> (i32, i32, i32, i32) {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    let target = HWND(win.id as usize as *mut _);
    let mut frame = RECT::default();
    unsafe {
        let _ = DwmGetWindowAttribute(
            target,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            std::ptr::addr_of_mut!(frame).cast(),
            std::mem::size_of::<RECT>() as u32,
        );
    }
    if frame.right > frame.left && frame.bottom > frame.top {
        (frame.left, frame.top, frame.right - frame.left, frame.bottom - frame.top)
    } else {
        (win.x, win.y, win.w, win.h)
    }
}

#[cfg(not(windows))]
fn dwm_frame_bounds(win: &WinInfo) -> (i32, i32, i32, i32) {
    (win.x, win.y, win.w, win.h)
}

/// Windows: raw `GetWindowRect` bounds — includes the invisible resize-border/shadow
/// margin that `dwm_frame_bounds` trims off. `PrintWindow` always renders relative to
/// this raw rect, so the capture canvas must be sized to it (not to the DWM-trimmed
/// bounds) or the rendered content ends up shifted within an undersized bitmap.
#[cfg(windows)]
fn raw_window_bounds(hwnd_id: u32) -> (i32, i32, i32, i32) {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    let hwnd = HWND(hwnd_id as usize as *mut _);
    let mut rect = RECT::default();
    unsafe {
        let _ = GetWindowRect(hwnd, &mut rect);
    }
    (rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)
}

#[cfg(not(windows))]
fn raw_window_bounds(_hwnd_id: u32) -> (i32, i32, i32, i32) {
    (0, 0, 0, 0)
}

#[cfg(not(windows))]
fn gtk_frame_extents(window_id: u32) -> Option<(i32, i32, i32, i32)> {
    let output = std::process::Command::new("xprop")
        .args(&["-id", &window_id.to_string(), "_GTK_FRAME_EXTENTS"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = stdout.split('=').collect();
    if parts.len() < 2 {
        return None;
    }
    let values_str = parts[1].trim();
    let values: Vec<i32> = values_str
        .split(',')
        .map(|s| s.trim().parse::<i32>().unwrap_or(0))
        .collect();
    if values.len() == 4 {
        Some((values[0], values[1], values[2], values[3]))
    } else {
        None
    }
}

/// Crop with physical pixel coordinates. Bounds are clamped within the image.
pub fn crop(image: &RgbaImage, x: u32, y: u32, w: u32, h: u32) -> Result<RgbaImage> {
    let (iw, ih) = (image.width(), image.height());
    let x = x.min(iw.saturating_sub(1));
    let y = y.min(ih.saturating_sub(1));
    let w = w.min(iw - x).max(1);
    let h = h.min(ih - y).max(1);
    Ok(image::imageops::crop_imm(image, x, y, w, h).to_image())
}

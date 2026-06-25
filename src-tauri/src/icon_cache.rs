use std::path::{Path, PathBuf};

pub struct IconCache {
    pub dir: PathBuf,
}

impl IconCache {
    pub fn new(config_dir: &Path) -> Self {
        let dir = config_dir.join("icon_cache");
        let _ = std::fs::create_dir_all(&dir);
        Self { dir }
    }

    fn cache_path(&self, app: &str) -> PathBuf {
        let safe: String = app
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        self.dir.join(format!("{safe}.png"))
    }

    pub fn get_base64(&self, app: &str) -> Option<String> {
        use base64::Engine;
        let bytes = std::fs::read(self.cache_path(app)).ok()?;
        Some(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub fn has(&self, app: &str) -> bool {
        self.cache_path(app).exists()
    }

    /// Extracts an icon directly from an exe path and caches it. Used by the
    /// store-screenshot automation, which has no live window to sample from.
    #[cfg(debug_assertions)]
    #[allow(unused_variables)]
    pub fn cache_from_exe_path(&self, app: &str, exe_path: &str) {
        if app.is_empty() || self.has(app) {
            return;
        }
        #[cfg(windows)]
        if let Some(png) = extract_png_from_exe_path(exe_path) {
            let _ = std::fs::write(self.cache_path(app), png);
        }
    }

    /// Extracts the icon from a window handle and caches it to disk.
    #[allow(unused_variables)]
    pub fn cache_from_hwnd(&self, app: &str, hwnd_u32: u32) {
        if app.is_empty() || self.has(app) {
            return;
        }
        #[cfg(windows)]
        if let Some(png) = extract_png_from_hwnd(hwnd_u32) {
            let _ = std::fs::write(self.cache_path(app), png);
        }
        #[cfg(target_os = "macos")]
        if let Some(png) = extract_png_from_macos_app(app) {
            let _ = std::fs::write(self.cache_path(app), png);
        }
        #[cfg(target_os = "linux")]
        if let Some(png) = extract_png_from_x11(hwnd_u32) {
            let _ = std::fs::write(self.cache_path(app), png);
        }
    }
}

// Windows icon extraction

#[cfg(windows)]
fn extract_png_from_hwnd(hwnd_u32: u32) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::{CloseHandle, FALSE, HWND, LPARAM, WPARAM};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassLongPtrW, GetWindowThreadProcessId, SendMessageW, HICON, WM_GETICON,
    };
    use windows::core::PWSTR;

    unsafe {
        let hwnd = HWND(hwnd_u32 as usize as *mut _);

        // Ask via WM_GETICON (ICON_BIG = 1) first
        let res = SendMessageW(hwnd, WM_GETICON, WPARAM(1), LPARAM(0));
        let h = HICON(res.0 as *mut _);
        if !h.is_invalid() {
            if let Some(png) = render_hicon_to_png(h) {
                return Some(png);
            }
        }

        // Class icon (GCLP_HICON = -14)
        let lp = GetClassLongPtrW(hwnd, windows::Win32::UI::WindowsAndMessaging::GET_CLASS_LONG_INDEX(-14i32));
        let h = HICON(lp as *mut _);
        if !h.is_invalid() {
            if let Some(png) = render_hicon_to_png(h) {
                return Some(png);
            }
        }

        // SHGetFileInfoW ile EXE'den ikon al
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid).ok()?;
        let mut buf = [0u16; 512];
        let mut size = buf.len() as u32;
        let res = QueryFullProcessImageNameW(proc, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(proc);
        res.ok()?;
        let exe_path = String::from_utf16_lossy(&buf[..size as usize]);

        extract_png_from_exe_path(&exe_path)
    }
}

#[cfg(windows)]
fn extract_png_from_exe_path(exe_path: &str) -> Option<Vec<u8>> {
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;
    use windows::core::PCWSTR;

    let hicon = unsafe {
        let wide: Vec<u16> = exe_path.encode_utf16().chain([0u16]).collect();
        let mut shfi: SHFILEINFOW = std::mem::zeroed();
        let r = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_FLAGS(0x100), // SHGFI_ICON | SHGFI_LARGEICON(0)
        );
        if r == 0 || shfi.hIcon.is_invalid() {
            return None;
        }
        shfi.hIcon
    };

    let result = render_hicon_to_png(hicon);
    unsafe { let _ = DestroyIcon(hicon); }
    result
}

#[cfg(windows)]
fn render_hicon_to_png(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject,
        HGDIOBJ, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_USAGE, RGBQUAD,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DI_FLAGS, DrawIconEx};

    const SIZE: i32 = 32;

    unsafe {
        let dc = CreateCompatibleDC(None);
        if dc.0.is_null() {
            return None;
        }

        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: SIZE,
                biHeight: -SIZE, // negative = top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0, // BI_RGB
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [RGBQUAD::default()],
        };

        let mut bits_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let hbm = match CreateDIBSection(
            dc,
            &bmi,
            DIB_USAGE(0), // DIB_RGB_COLORS
            &mut bits_ptr,
            HANDLE::default(),
            0,
        ) {
            Ok(h) => h,
            Err(_) => {
                let _ = DeleteDC(dc);
                return None;
            }
        };

        if bits_ptr.is_null() {
            let _ = DeleteObject(HGDIOBJ(hbm.0 as *mut _));
            let _ = DeleteDC(dc);
            return None;
        }

        let old = SelectObject(dc, HGDIOBJ(hbm.0 as *mut _));
        let _ = DrawIconEx(dc, 0, 0, hicon, SIZE, SIZE, 0, None, DI_FLAGS(3)); // DI_NORMAL = 3

        let pixel_count = (SIZE * SIZE) as usize;
        let pixels_bgra = std::slice::from_raw_parts(bits_ptr as *const u8, pixel_count * 4);

        // If there is no alpha channel (legacy-style icon), make all pixels opaque
        let has_alpha = pixels_bgra.chunks_exact(4).any(|c| c[3] != 0);

        let mut pixels_rgba = vec![0u8; pixel_count * 4];
        for (i, chunk) in pixels_bgra.chunks_exact(4).enumerate() {
            pixels_rgba[i * 4] = chunk[2];     // R
            pixels_rgba[i * 4 + 1] = chunk[1]; // G
            pixels_rgba[i * 4 + 2] = chunk[0]; // B
            pixels_rgba[i * 4 + 3] = if has_alpha { chunk[3] } else { 255 };
        }

        let _ = SelectObject(dc, old);
        let _ = DeleteObject(HGDIOBJ(hbm.0 as *mut _));
        let _ = DeleteDC(dc);

        let img = image::ImageBuffer::<image::Rgba<u8>, Vec<u8>>::from_raw(
            SIZE as u32,
            SIZE as u32,
            pixels_rgba,
        )?;
        let mut buf = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .ok()?;
        Some(buf)
    }
}

/// Locates an app's `.app` bundle by name, probing standard install
/// locations directly before falling back to Spotlight (`mdfind`), since
/// Spotlight indexing can be disabled or incomplete (common in fresh VMs).
#[cfg(target_os = "macos")]
fn find_macos_app_bundle(app_name: &str) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    // Direct path probing first — doesn't depend on Spotlight indexing,
    // which can be disabled or incomplete (common in fresh VMs).
    let mut candidates = vec![
        format!("/Applications/{app_name}.app"),
        format!("/System/Applications/{app_name}.app"),
        format!("/System/Applications/Utilities/{app_name}.app"),
        format!("/Applications/Utilities/{app_name}.app"),
    ];
    if !home.is_empty() {
        candidates.push(format!("{home}/Applications/{app_name}.app"));
    }
    if let Some(path) = candidates.into_iter().find(|p| std::path::Path::new(p).exists()) {
        return Some(path);
    }

    // Fall back to Spotlight for apps in non-standard locations.
    let mut search_dirs = vec!["/Applications".to_string(), "/System/Applications".to_string()];
    if !home.is_empty() {
        search_dirs.push(format!("{home}/Applications"));
    }
    let mut mdfind = std::process::Command::new("mdfind");
    for dir in &search_dirs {
        mdfind.arg("-onlyin").arg(dir);
    }
    mdfind.arg("-name").arg(format!("{app_name}.app"));
    let output = mdfind.output().ok()?;
    let app_path = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    if app_path.is_empty() { None } else { Some(app_path) }
}

/// macOS: renders the app's icon via `qlmanage` (the same QuickLook service
/// Finder uses for icon previews). Works regardless of whether the app ships
/// its icon as a standalone `.icns` file or only as an Xcode asset catalog
/// (most modern first-party Apple apps, e.g. Safari, use the latter).
#[cfg(target_os = "macos")]
fn extract_png_from_macos_app(app_name: &str) -> Option<Vec<u8>> {
    let app_path = find_macos_app_bundle(app_name)?;

    let tmp_dir = std::env::temp_dir().join(format!("shotcove_icon_{}_{}", std::process::id(), app_name.len()));
    std::fs::create_dir_all(&tmp_dir).ok()?;

    let mut child = std::process::Command::new("qlmanage")
        .args(["-t", "-s", "128", "-o"])
        .arg(&tmp_dir)
        .arg(&app_path)
        .spawn()
        .ok();

    // `qlmanage` is known to hang indefinitely for some app bundles (observed
    // with the app's own bundle while it's running) — poll instead of a plain
    // `.wait()`/`.status()` so a stuck process can't tie up this thread forever.
    let status = child.as_mut().and_then(|c| {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match c.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                _ => {
                    let _ = c.kill();
                    let _ = c.wait();
                    return None;
                }
            }
        }
    });

    let result = status.filter(|s| s.success()).and_then(|_| {
        let base = std::path::Path::new(&app_path).file_name()?.to_str()?;
        std::fs::read(tmp_dir.join(format!("{base}.png"))).ok()
    });
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

#[cfg(target_os = "linux")]
fn extract_png_from_x11(window_id: u32) -> Option<Vec<u8>> {
    let output = std::process::Command::new("xprop")
        .args(&["-id", &window_id.to_string(), "-notype", "32c", "_NET_WM_ICON"])
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

    let values_str = parts[1].trim().replace("\n", "");
    if values_str.is_empty() {
        return None;
    }

    let numbers: Vec<u32> = values_str
        .split(',')
        .map(|s| s.trim().parse::<i64>().unwrap_or(0) as u32)
        .collect();

    let mut best_index = None;
    let mut best_score = -1;
    let mut idx = 0;
    
    while idx < numbers.len() {
        if idx + 2 > numbers.len() {
            break;
        }
        let w = numbers[idx];
        let h = numbers[idx + 1];
        if w == 0 || h == 0 || w > 512 || h > 512 {
            break;
        }
        let pixel_count = (w * h) as usize;
        if idx + 2 + pixel_count > numbers.len() {
            break;
        }
        
        let size = w.min(h);
        let score = if size == 48 {
            100
        } else if size == 32 {
            90
        } else if size == 64 {
            85
        } else if size > 16 && size < 128 {
            70
        } else if size == 16 {
            50
        } else {
            30
        };
        
        if score > best_score {
            best_score = score;
            best_index = Some((idx, w, h));
        }
        
        idx += 2 + pixel_count;
    }

    let (start_idx, w, h) = match best_index {
        Some(v) => v,
        None => return None,
    };

    let pixel_count = (w * h) as usize;
    let mut pixels = Vec::with_capacity(pixel_count * 4);
    
    for i in 0..pixel_count {
        let argb = numbers[start_idx + 2 + i];
        let a = ((argb >> 24) & 0xFF) as u8;
        let r = ((argb >> 16) & 0xFF) as u8;
        let g = ((argb >> 8) & 0xFF) as u8;
        let b = (argb & 0xFF) as u8;
        pixels.push(r);
        pixels.push(g);
        pixels.push(b);
        pixels.push(a);
    }

    let img = image::ImageBuffer::<image::Rgba<u8>, Vec<u8>>::from_raw(w, h, pixels)?;

    let mut buf = Vec::new();
    if img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png).is_err() {
        return None;
    }

    Some(buf)
}

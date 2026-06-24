#[cfg(windows)]
#[repr(C)]
pub struct DROPFILES {
    pub p_files: u32,
    pub pt: windows::Win32::Foundation::POINT,
    pub f_nc: windows::Win32::Foundation::BOOL,
    pub f_wide: windows::Win32::Foundation::BOOL,
}

#[cfg(windows)]
pub fn copy_files_to_clipboard(paths: &[std::path::PathBuf]) -> Result<(), String> {
    use windows::Win32::Foundation::{HANDLE, HWND, POINT, TRUE, GlobalFree};
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT};

    let dropfiles_size = std::mem::size_of::<DROPFILES>();
    let mut encoded_paths: Vec<u16> = Vec::new();
    for path in paths {
        let path_str = path.to_string_lossy();
        let mut wide: Vec<u16> = path_str.encode_utf16().collect();
        wide.push(0);
        encoded_paths.extend_from_slice(&wide);
    }
    encoded_paths.push(0);
    let total_size = dropfiles_size + encoded_paths.len() * 2;

    unsafe {
        let h_global = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_size)
            .map_err(|e| format!("GlobalAlloc failed: {}", e))?;
        let ptr = GlobalLock(h_global);
        if ptr.is_null() {
            let _ = GlobalFree(h_global);
            return Err("GlobalLock failed".to_string());
        }
        let dropfiles = DROPFILES {
            p_files: dropfiles_size as u32,
            pt: POINT { x: 0, y: 0 },
            f_nc: windows::Win32::Foundation::BOOL(0),
            f_wide: TRUE,
        };
        std::ptr::copy_nonoverlapping(
            &dropfiles as *const DROPFILES as *const u8,
            ptr as *mut u8,
            dropfiles_size,
        );
        std::ptr::copy_nonoverlapping(
            encoded_paths.as_ptr() as *const u8,
            (ptr as *mut u8).add(dropfiles_size),
            encoded_paths.len() * 2,
        );
        let _ = GlobalUnlock(h_global);
        if OpenClipboard(HWND(std::ptr::null_mut())).is_err() {
            let _ = GlobalFree(h_global);
            return Err("OpenClipboard failed".to_string());
        }
        if EmptyClipboard().is_err() {
            let _ = CloseClipboard();
            let _ = GlobalFree(h_global);
            return Err("EmptyClipboard failed".to_string());
        }
        // 15 = CF_HDROP
        if SetClipboardData(15, HANDLE(h_global.0)).is_err() {
            let _ = CloseClipboard();
            let _ = GlobalFree(h_global);
            return Err("SetClipboardData failed".to_string());
        }
        let _ = CloseClipboard();
    }
    Ok(())
}

#[cfg(windows)]
pub fn decode_via_wic(path: &std::path::Path) -> anyhow::Result<image::RgbaImage> {
    use anyhow::Context;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::GENERIC_ACCESS_RIGHTS;
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICBitmapSource,
        IWICFormatConverter, IWICImagingFactory, WICBitmapDitherTypeNone,
        WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::core::Interface;

    unsafe {
        let com_ok = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let result = (|| -> anyhow::Result<image::RgbaImage> {
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                    .context("failed to create WIC factory")?;
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0u16]).collect();
            let decoder = factory
                .CreateDecoderFromFilename(
                    windows::core::PCWSTR(wide.as_ptr()),
                    None,
                    GENERIC_ACCESS_RIGHTS(0x80000000u32),
                    WICDecodeMetadataCacheOnDemand,
                )
                .context("failed to open file (WIC decoder)")?;
            let frame = decoder.GetFrame(0).context("failed to get WIC frame")?;
            let mut w = 0u32;
            let mut h = 0u32;
            frame.GetSize(&mut w, &mut h).context("failed to get WIC size")?;
            let converter: IWICFormatConverter = factory
                .CreateFormatConverter()
                .context("failed to create WIC format converter")?;
            let source: IWICBitmapSource = frame.cast().context("IWICBitmapSource cast")?;
            converter
                .Initialize(
                    &source,
                    &GUID_WICPixelFormat32bppRGBA,
                    WICBitmapDitherTypeNone,
                    None,
                    0.0f64,
                    WICBitmapPaletteTypeCustom,
                )
                .context("failed to initialize WIC format conversion")?;
            let stride = w * 4;
            let buf_size = stride * h;
            let mut pixels = vec![0u8; buf_size as usize];
            let out: IWICBitmapSource = converter.cast().context("WIC output cast")?;
            out.CopyPixels(std::ptr::null(), stride, &mut pixels)
                .context("failed to copy WIC pixel data")?;
            image::RgbaImage::from_raw(w, h, pixels).context("failed to create RgbaImage")
        })();
        if com_ok {
            CoUninitialize();
        }
        result
    }
}

/// Returns true if the current process is running with elevated (administrator) privileges.
#[cfg(windows)]
pub fn is_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut return_len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut return_len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    false
}

/// Re-launches the current executable with UAC elevation ("runas") then exits this process.
#[cfg(windows)]
pub fn restart_as_admin() {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let exe = std::env::current_exe().unwrap_or_default();
    let exe_wide: Vec<u16> = exe.to_string_lossy().encode_utf16().chain([0u16]).collect();
    let verb: Vec<u16> = "runas".encode_utf16().chain([0u16]).collect();
    unsafe {
        ShellExecuteW(
            None,
            windows::core::PCWSTR(verb.as_ptr()),
            windows::core::PCWSTR(exe_wide.as_ptr()),
            windows::core::PCWSTR(std::ptr::null()),
            windows::core::PCWSTR(std::ptr::null()),
            SW_SHOWNORMAL,
        );
    }
    std::process::exit(0);
}

#[cfg(not(windows))]
pub fn restart_as_admin() {}

/// Creates a Windows Task Scheduler logon task that launches the app with highest privileges.
/// Requires the caller to already be running elevated.
#[cfg(windows)]
pub fn create_admin_autostart() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe.to_string_lossy();
    let status = std::process::Command::new("schtasks")
        .args([
            "/create",
            "/f",
            "/tn",
            "Shotcove",
            "/tr",
            &format!("\"{}\"", exe_str),
            "/sc",
            "onlogon",
            "/rl",
            "highest",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("schtasks /create failed".into())
    }
}

#[cfg(not(windows))]
pub fn create_admin_autostart() -> Result<(), String> {
    Ok(())
}

/// Removes the Shotcove Task Scheduler logon task if it exists.
#[cfg(windows)]
pub fn remove_admin_autostart() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("schtasks")
        .args(["/delete", "/f", "/tn", "Shotcove"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(not(windows))]
pub fn remove_admin_autostart() {}

/// Returns true if the process is running from an installed MSIX/AppX package
/// (e.g. Microsoft Store). Such installs already get a Start Menu entry from
/// their manifest and are updated by the Store, not by our own logic.
#[cfg(windows)]
pub fn is_packaged() -> bool {
    extern "system" {
        fn GetCurrentPackageFullName(length: *mut u32, full_name: *mut u16) -> u32;
    }
    const APPMODEL_ERROR_NO_PACKAGE: u32 = 15700;

    let mut length: u32 = 0;
    let result = unsafe { GetCurrentPackageFullName(&mut length, std::ptr::null_mut()) };
    result != APPMODEL_ERROR_NO_PACKAGE
}

#[cfg(not(windows))]
pub fn is_packaged() -> bool {
    false
}

#[cfg(all(windows, not(debug_assertions)))]
pub fn register_app_shortcut(run_as_admin: bool) -> Result<(), Box<dyn std::error::Error>> {
    use std::env;
    use std::path::PathBuf;

    if is_packaged() {
        log::info!("Running as a packaged app (MSIX); skipping Start Menu shortcut creation");
        return Ok(());
    }
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        IPersistFile,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::core::{Interface, PCWSTR, PROPVARIANT};

    let current_exe = env::current_exe()?;
    let appdata = env::var("APPDATA")?;
    let shortcut_dir = PathBuf::from(appdata).join("Microsoft\\Windows\\Start Menu\\Programs");
    let shortcut_path = shortcut_dir.join("Shotcove.lnk");

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        let exe_path_u16: Vec<u16> = current_exe
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        shell_link.SetPath(PCWSTR(exe_path_u16.as_ptr()))?;
        if let Some(parent) = current_exe.parent() {
            let working_dir_u16: Vec<u16> = parent
                .to_string_lossy()
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            shell_link.SetWorkingDirectory(PCWSTR(working_dir_u16.as_ptr()))?;
        }
        let prop_store: IPropertyStore = shell_link.cast()?;
        let app_id = PROPVARIANT::from("dev.xacnio.shotcove");
        prop_store.SetValue(&PKEY_AppUserModel_ID, &app_id)?;
        prop_store.Commit()?;
        let persist_file: IPersistFile = shell_link.cast()?;
        let shortcut_path_u16: Vec<u16> = shortcut_path
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        persist_file.Save(PCWSTR(shortcut_path_u16.as_ptr()), true)?;
    }

    // Set/clear the SLDF_RUNAS_USER (0x2000) bit in the .lnk LinkFlags field at offset 0x14.
    // This controls "Run as administrator" on the Start Menu shortcut.
    if let Ok(mut data) = std::fs::read(&shortcut_path) {
        if data.len() >= 0x18 {
            let flags = u32::from_le_bytes([data[0x14], data[0x15], data[0x16], data[0x17]]);
            let new_flags = if run_as_admin { flags | 0x2000 } else { flags & !0x2000 };
            if new_flags != flags {
                data[0x14..0x18].copy_from_slice(&new_flags.to_le_bytes());
                std::fs::write(&shortcut_path, &data)?;
            }
        }
    }

    Ok(())
}

/// Creates or updates the Start Menu shortcut with the current exe path and admin flag.
/// No-op in debug builds or on non-Windows.
pub fn update_start_menu_shortcut(run_as_admin: bool) {
    let _ = run_as_admin;
    #[cfg(all(windows, not(debug_assertions)))]
    if let Err(e) = register_app_shortcut(run_as_admin) {
        log::warn!("failed to update start menu shortcut: {e}");
    }
}

/// Loopback port used to signal a running instance to open its gallery window.
/// Arbitrary but fixed so a second launch can find the first instance's listener.
const SINGLE_INSTANCE_PORT: u16 = 51823;

/// Tries to claim a process-wide named mutex. Returns `true` if this is the first/only
/// instance (mutex acquired and kept alive for the process lifetime). Returns `false` if
/// another instance already owns it — in that case the running instance is signaled (via
/// [`start_single_instance_listener`]) to open its gallery window, whether or not that
/// window currently exists.
///
/// Replaces `tauri-plugin-single-instance`, which silently failed to stop a second
/// launch (likely an elevation mismatch with `run_as_admin`), leaving two processes
/// fighting over the tray icon.
#[cfg(windows)]
pub fn acquire_single_instance() -> bool {
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;

    let Ok(handle) = (unsafe { CreateMutexW(None, true, windows::core::w!("Local\\ShotcoveSingleInstanceMutex")) }) else {
        return true; // couldn't create the mutex — don't block startup over it
    };
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        notify_running_instance();
        return false;
    }
    // Never closed — the mutex stays held for the lifetime of this process;
    // Windows releases it automatically on process exit.
    let _ = handle;
    true
}

#[cfg(not(windows))]
pub fn acquire_single_instance() -> bool {
    true
}

/// Connects to the running instance's listener to ask it to open its gallery window.
/// A few short retries cover the brief startup window where the mutex is already held
/// but the listener (started later, from `setup()`) hasn't bound its socket yet.
#[cfg(windows)]
fn notify_running_instance() {
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    let addr: SocketAddr = ([127, 0, 0, 1], SINGLE_INSTANCE_PORT).into();
    for _ in 0..5 {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// Starts a background listener that opens the gallery window (creating it if needed)
/// whenever a second instance signals via [`notify_running_instance`].
pub fn start_single_instance_listener(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        use std::net::{Ipv4Addr, TcpListener};
        let Ok(listener) = TcpListener::bind((Ipv4Addr::LOCALHOST, SINGLE_INSTANCE_PORT)) else {
            return; // port unavailable — best effort only, doesn't affect normal operation
        };
        for stream in listener.incoming() {
            if stream.is_err() {
                continue;
            }
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                crate::tray::show_main(&app2);
            });
        }
    });
}

/// Explicitly sets this process's AppUserModelID, used for taskbar grouping/jump lists.
/// Does *not* affect toast notifications — those resolve their displayed name/icon via
/// [`register_notification_aumid`] instead (see its doc comment for why).
#[cfg(windows)]
pub fn set_app_user_model_id() {
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(windows::core::w!("dev.xacnio.shotcove"));
    }
}

#[cfg(not(windows))]
pub fn set_app_user_model_id() {}

/// Registers the "dev.xacnio.shotcove" AppUserModelID in the registry with a display name
/// and icon, so Windows toast notifications show "Shotcove" instead of the launching host
/// process (e.g. "Windows PowerShell" when started from a terminal).
///
/// `tauri-plugin-notification` calls `ToastNotificationManager::CreateToastNotifierWithId`
/// with our app identifier directly — that bypasses `SetCurrentProcessExplicitAppUserModelID`
/// entirely and instead looks up the ID's metadata via a matching Start Menu shortcut (release
/// builds only, see [`register_app_shortcut`]) or this registry entry (works in every build,
/// regardless of how the process was launched). `icon_path` must point to a real `.ico` file
/// on disk; pass the path written by the caller after exporting `app.default_window_icon()`.
#[cfg(windows)]
pub fn register_notification_aumid(icon_path: &std::path::Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let key = r"HKCU\Software\Classes\AppUserModelId\dev.xacnio.shotcove";
    let run = |args: &[&str]| {
        let _ = std::process::Command::new("reg")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    };
    run(&["add", key, "/v", "DisplayName", "/t", "REG_SZ", "/d", "Shotcove", "/f"]);
    if let Some(icon_str) = icon_path.to_str() {
        run(&["add", key, "/v", "IconUri", "/t", "REG_SZ", "/d", icon_str, "/f"]);
    }
}

#[cfg(not(windows))]
pub fn register_notification_aumid(_icon_path: &std::path::Path) {}

//! Microsoft Store screenshot automation — dev builds only.
//!
//! Triggered by `--store-screenshots`: drives the real gallery/editor/
//! settings windows (plus a real Chrome capture) through a fixed sequence
//! of scenes in English then Turkish, saving 1366x768 PNGs under
//! `<repo>/store-screenshots/{lang}/`.
//!
//! Uses an isolated config dir under the OS temp folder and only synthetic
//! demo content — never the user's real library, settings, or Google account.

use crate::capture::{self, WinInfo};
use crate::config::{BgTemplate, ConfigStore};
use crate::icon_cache::IconCache;
use crate::library::LibraryCache;
use crate::meta::{MetaStore, ScreenshotMeta};
use crate::overlay;
use crate::tag::{Tag, TagStore};
use crate::CaptureMeta;
use anyhow::{Context, Result};
use chrono::{Duration as ChronoDuration, Local};
use image::{Rgba, RgbaImage};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Listener, Manager, Position, Size, WebviewWindow};

const TARGET_W: u32 = 1366;
const TARGET_H: u32 = 768;
const WIN_X: f64 = 40.0;
const WIN_Y: f64 = 40.0;

pub fn requested() -> bool {
    std::env::args().any(|a| a == "--store-screenshots")
}

fn root_dir() -> PathBuf {
    std::env::temp_dir().join("shotcove-store-screenshots")
}

pub fn temp_config_dir() -> PathBuf {
    root_dir().join("config")
}

fn library_dir() -> PathBuf {
    root_dir().join("library")
}

fn output_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("store-screenshots")
}

/// Writes a settings.json with sane defaults before `ConfigStore::load`
/// reads it, so startup skips onboarding, update checks, and hotkeys.
pub fn prepare_temp_config(config_dir: &Path) {
    let _ = std::fs::remove_dir_all(config_dir);
    let _ = std::fs::create_dir_all(config_dir);
    let mut settings = crate::config::Settings::default();
    settings.onboarded = true;
    settings.start_with_gallery = false;
    settings.sync_enabled = false;
    settings.auto_update = false;
    settings.hotkeys_enabled = false;
    settings.printscreen_enabled = false;
    settings.screenshots_dir = library_dir().to_string_lossy().into_owned();
    if let Ok(json) = serde_json::to_string_pretty(&settings) {
        let _ = std::fs::write(config_dir.join("settings.json"), json);
    }
}

/// Kicks off the full automation as a background task and exits the
/// process once it's done (success or failure).
pub fn run(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_inner(&app).await {
            log::error!("store screenshots automation failed: {e}");
        }
        app.exit(0);
    });
}

async fn run_inner(app: &AppHandle) -> Result<()> {
    let out_root = output_dir();
    for lang in ["en", "tr"] {
        let lang_dir = out_root.join(lang);
        std::fs::create_dir_all(&lang_dir)?;
        switch_language(app, lang)?;
        seed_demo_tags(app, lang);
        seed_demo_library(app, &library_dir(), lang)?;
        app.state::<LibraryCache>().clear();

        capture_gallery(app, &lang_dir).await?;
        capture_styled_editor(app, &lang_dir).await?;
        capture_settings(app, &lang_dir, "03-settings-shortcuts.png", &[json!({"action":"goto-tab","tab":"shortcuts"})]).await?;
        capture_settings(
            app,
            &lang_dir,
            "04-settings-drive.png",
            &[
                json!({"action":"goto-tab","tab":"drive"}),
                json!({
                    "action":"set-drive-demo",
                    "connected": true,
                    "email": "shotcove@xacnio.dev",
                    "name": if lang == "tr" { "Demo Kullanıcı" } else { "Demo User" },
                }),
            ],
        )
        .await?;
        capture_live_chrome_capture(app, &lang_dir).await?;
    }
    Ok(())
}

fn switch_language(app: &AppHandle, lang: &str) -> Result<()> {
    let store = app.state::<std::sync::Arc<ConfigStore>>();
    let mut settings = store.get();
    settings.language = lang.into();
    store.save(settings)?;
    let _ = app.emit("settings-changed", ());
    Ok(())
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

async fn wait_for_window(app: &AppHandle, label: &str) -> Result<WebviewWindow> {
    for _ in 0..200 {
        if let Some(w) = app.get_webview_window(label) {
            return Ok(w);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    anyhow::bail!("window `{label}` did not appear in time")
}

fn position_window(window: &WebviewWindow) -> Result<()> {
    let _ = window.set_size(Size::Logical(LogicalSize::new(TARGET_W as f64, TARGET_H as f64)));
    let _ = window.set_position(Position::Logical(LogicalPosition::new(WIN_X, WIN_Y)));
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// Sends a `store-screenshot-cmd` and waits (with a timeout) for the
/// frontend's ack. Uses `.listen()` not `.once()`: tauri's `.once()` panics
/// if a second delivery races in (e.g. React double-effects), so this
/// guards idempotency itself by taking the oneshot sender at most once.
async fn send_cmd_and_wait(app: &AppHandle, payload: serde_json::Value) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = std::sync::Mutex::new(Some(tx));
    let handler_id = app.listen("store-screenshot-ready", move |_event| {
        if let Some(tx) = tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
    });
    let _ = app.emit("store-screenshot-cmd", payload);
    let _ = tokio::time::timeout(Duration::from_secs(2), rx).await;
    app.unlisten(handler_id);
}

#[cfg(windows)]
fn capture_native(window: &WebviewWindow) -> Result<RgbaImage> {
    let hwnd_id = window.hwnd().ok().map(|h| h.0 as usize as u32).context("no hwnd for window")?;
    let pos = window.outer_position().unwrap_or(tauri::PhysicalPosition::new(WIN_X as i32, WIN_Y as i32));
    let size = window.outer_size().unwrap_or(tauri::PhysicalSize::new(TARGET_W, TARGET_H));
    let win = WinInfo {
        id: hwnd_id,
        title: String::new(),
        app: String::new(),
        x: pos.x,
        y: pos.y,
        w: size.width as i32,
        h: size.height as i32,
    };
    capture::capture_window_raw(&win, 0, 0)
}

#[cfg(not(windows))]
fn capture_native(_window: &WebviewWindow) -> Result<RgbaImage> {
    anyhow::bail!("store screenshot automation is currently Windows-only")
}

fn save_resized(img: &RgbaImage, out_path: &Path) -> Result<()> {
    let resized = if img.width() == TARGET_W && img.height() == TARGET_H {
        img.clone()
    } else {
        image::imageops::resize(img, TARGET_W, TARGET_H, image::imageops::FilterType::Lanczos3)
    };
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    resized.save(out_path)?;
    Ok(())
}

/// Positions, captures, saves, then closes the window and waits for it to
/// actually disappear — otherwise the next scene's reuse-if-open check can
/// race and grab a handle whose native HWND is already gone.
async fn finish_capture(app: &AppHandle, window: &WebviewWindow, out_path: &Path) -> Result<()> {
    position_window(window)?;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let img = capture_native(window)?;
    save_resized(&img, out_path)?;
    let label = window.label().to_string();
    let _ = window.close();
    for _ in 0..100 {
        if app.get_webview_window(&label).is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

async fn capture_gallery(app: &AppHandle, lang_dir: &Path) -> Result<()> {
    crate::tray::show_main(app);
    let window = wait_for_window(app, "main").await?;
    // Give the initial library scan + thumbnail generation time to finish,
    // so the screenshot isn't a "scanning..." placeholder.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    finish_capture(app, &window, &lang_dir.join("01-gallery.png")).await
}

async fn capture_styled_editor(app: &AppHandle, lang_dir: &Path) -> Result<()> {
    let image = gradient_image(1600, 1000, [40, 70, 130], [120, 50, 170]);
    let meta = CaptureMeta {
        bg_template: Some(BgTemplate::default()),
        ..CaptureMeta::default()
    };
    let label = overlay::open_editor(app, image, meta, true);
    let window = wait_for_window(app, &label).await?;
    finish_capture(app, &window, &lang_dir.join("02-editor.png")).await
}

async fn capture_settings(app: &AppHandle, lang_dir: &Path, filename: &str, cmds: &[serde_json::Value]) -> Result<()> {
    crate::tray::show_settings(app);
    let window = wait_for_window(app, "settings").await?;
    position_window(&window)?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    for cmd in cmds {
        send_cmd_and_wait(app, cmd.clone()).await;
    }
    finish_capture(app, &window, &lang_dir.join(filename)).await
}

/// Captures Chrome incognito on the project's own public page (no personal
/// data) and opens it in the editor, as an authentic capture demo.
async fn capture_live_chrome_capture(app: &AppHandle, lang_dir: &Path) -> Result<()> {
    let Some(mut chrome) = launch_chrome_incognito() else {
        log::warn!("store screenshots: Chrome not found, skipping live-capture scene");
        return Ok(());
    };
    tokio::time::sleep(Duration::from_secs(3)).await;
    let chrome_win = find_chrome_window();
    let result: Result<()> = async {
        let win = chrome_win.context("Chrome window not found after launch")?;
        let image = capture::capture_window_raw(&win, 0, 0)?;
        let label = overlay::open_editor(app, image, CaptureMeta::default(), true);
        let window = wait_for_window(app, &label).await?;
        finish_capture(app, &window, &lang_dir.join("05-live-capture.png")).await
    }
    .await;
    let _ = chrome.kill();
    result
}

fn launch_chrome_incognito() -> Option<std::process::Child> {
    let candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "chrome",
    ];
    let args = [
        "--incognito",
        "--new-window",
        "--window-size=1366,768",
        "--window-position=40,40",
        "https://xacnio.github.io/shotcove/",
    ];
    candidates.iter().find_map(|exe| std::process::Command::new(exe).args(args).spawn().ok())
}

fn find_chrome_window() -> Option<WinInfo> {
    capture::list_windows().into_iter().find(|w| w.app.to_ascii_lowercase().contains("chrome"))
}

// ---------------------------------------------------------------------------
// Synthetic demo data
// ---------------------------------------------------------------------------

fn gradient_image(w: u32, h: u32, c1: [u8; 3], c2: [u8; 3]) -> RgbaImage {
    let mut img = RgbaImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let t = ((x as f32 / w.max(1) as f32) + (y as f32 / h.max(1) as f32)) / 2.0;
            let lerp = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t) as u8;
            img.put_pixel(x, y, Rgba([lerp(c1[0], c2[0]), lerp(c1[1], c2[1]), lerp(c1[2], c2[2]), 255]));
        }
    }
    img
}

struct DemoItem {
    title_en: &'static str,
    title_tr: &'static str,
    /// Icon-cache key the gallery groups screenshots by.
    app: &'static str,
    /// Exe paths to try in order; falls back to stock Windows binaries.
    exe_candidates: &'static [&'static str],
    tag: Option<&'static str>,
    days_ago: i64,
    colors: ([u8; 3], [u8; 3]),
}

const DEMO_ITEMS: &[DemoItem] = &[
    DemoItem {
        title_en: "Landing page hero",
        title_tr: "Açılış sayfası görseli",
        app: "chrome",
        exe_candidates: &[
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        ],
        tag: Some("design"),
        days_ago: 1,
        colors: ([40, 60, 120], [90, 40, 160]),
    },
    DemoItem {
        title_en: "Code review",
        title_tr: "Kod incelemesi",
        app: "Code",
        exe_candidates: &[
            "%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe",
            r"C:\Windows\System32\notepad.exe",
        ],
        tag: Some("work"),
        days_ago: 2,
        colors: ([20, 120, 100], [10, 60, 60]),
    },
    DemoItem {
        title_en: "Downloads folder",
        title_tr: "İndirilenler klasörü",
        app: "explorer",
        exe_candidates: &[r"C:\Windows\explorer.exe"],
        tag: None,
        days_ago: 4,
        colors: ([160, 80, 40], [200, 140, 60]),
    },
    DemoItem {
        title_en: "Meeting notes",
        title_tr: "Toplantı notları",
        app: "notepad",
        exe_candidates: &[r"C:\Windows\System32\notepad.exe"],
        tag: Some("work"),
        days_ago: 6,
        colors: ([60, 60, 60], [120, 120, 120]),
    },
    DemoItem {
        title_en: "Quick sketch",
        title_tr: "Hızlı taslak",
        app: "mspaint",
        exe_candidates: &[r"C:\Windows\System32\mspaint.exe"],
        tag: Some("design"),
        days_ago: 9,
        colors: ([120, 30, 60], [200, 60, 100]),
    },
    DemoItem {
        title_en: "Deploy log",
        title_tr: "Dağıtım günlüğü",
        app: "powershell",
        exe_candidates: &[r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"],
        tag: Some("bug"),
        days_ago: 13,
        colors: ([30, 90, 140], [60, 160, 200]),
    },
];

fn expand_env_path(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("%LOCALAPPDATA%\\") {
        if let Ok(base) = std::env::var("LOCALAPPDATA") {
            return format!("{base}\\{rest}");
        }
    }
    p.to_string()
}

fn first_existing_exe(candidates: &[&str]) -> Option<String> {
    candidates.iter().map(|p| expand_env_path(p)).find(|p| Path::new(p).exists())
}

/// Three small demo tags (localized) so the gallery scene has something
/// to show in its tag filter sidebar.
fn seed_demo_tags(app: &AppHandle, lang: &str) {
    let tags = if lang == "tr" {
        vec![
            Tag { id: "work".into(), name: "İş".into(), color: "#f59e0b".into() },
            Tag { id: "design".into(), name: "Tasarım".into(), color: "#8b5cf6".into() },
            Tag { id: "bug".into(), name: "Hata".into(), color: "#ef4444".into() },
        ]
    } else {
        vec![
            Tag { id: "work".into(), name: "Work".into(), color: "#f59e0b".into() },
            Tag { id: "design".into(), name: "Design".into(), color: "#8b5cf6".into() },
            Tag { id: "bug".into(), name: "Bug".into(), color: "#ef4444".into() },
        ]
    };
    app.state::<Arc<TagStore>>().save(tags);
}

/// Seeds the demo library: synthetic gradients spread across different
/// days, each tagged and attributed to a real app icon. Never touches the
/// user's actual library.
fn seed_demo_library(app: &AppHandle, dir: &Path, lang: &str) -> Result<()> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir)?;
    let meta_store = app.state::<Arc<MetaStore>>();
    let icon_cache = app.state::<Arc<IconCache>>();
    let now = Local::now();
    for item in DEMO_ITEMS {
        let ts = now - ChronoDuration::days(item.days_ago) - ChronoDuration::hours((item.days_ago * 3) % 17);
        let filename = format!("{}.png", ts.format("%Y-%m-%d_%H-%M-%S-%3f"));
        let (c1, c2) = item.colors;
        let img = gradient_image(1280, 800, c1, c2);
        img.save(dir.join(&filename))?;

        let title = if lang == "tr" { item.title_tr } else { item.title_en };
        meta_store.set(
            filename,
            ScreenshotMeta {
                title: Some(title.to_string()),
                app: Some(item.app.to_string()),
                created: Some(ts.timestamp()),
                tags: item.tag.map(|t| vec![t.to_string()]).unwrap_or_default(),
            },
        );

        if let Some(exe) = first_existing_exe(item.exe_candidates) {
            icon_cache.cache_from_exe_path(item.app, &exe);
        }
    }
    Ok(())
}

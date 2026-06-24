use crate::{
    capture, config::{ConfigStore, ImageFormat}, library, meta,
    overlay, sync::SyncEngine,
    CaptureMeta, PendingEdit, PendingEditFilename, PendingEditMeta,
};
use image::RgbaImage;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

fn decode_png_base64(data: &str) -> Result<RgbaImage, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    Ok(img.to_rgba8())
}

fn close_editor_window(window: tauri::WebviewWindow) {
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
    let _ = window.app_handle().save_window_state(StateFlags::all());
    let _ = window.close();
}

pub fn take_editor_meta(app: &AppHandle, label: &str) -> CaptureMeta {
    app.state::<PendingEditMeta>().0.lock().unwrap().remove(label).unwrap_or_default()
}

fn get_editor_meta_clone(app: &AppHandle, label: &str) -> CaptureMeta {
    app.state::<PendingEditMeta>().0.lock().unwrap().get(label).cloned().unwrap_or_default()
}

#[derive(Serialize, Clone)]
pub struct WindowCropDto {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    label: String,
    icon_b64: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct EditorMetaDto {
    pub title: Option<String>,
    pub app: Option<String>,
    pub is_window: bool,
    pub filename: Option<String>,
    pub tags: Vec<String>,
    pub monitor_rects: Vec<[u32; 4]>,
    pub monitor_names: Vec<String>,
    pub window_crops: Vec<WindowCropDto>,
    pub bg_template: Option<crate::config::BgTemplate>,
}

#[tauri::command]
pub fn get_editor_meta(app: AppHandle, window: tauri::WebviewWindow) -> Result<EditorMetaDto, String> {
    let label = window.label();
    let meta = app.state::<PendingEditMeta>().0.lock().unwrap().get(label).cloned().unwrap_or_default();
    let filename = app.state::<PendingEditFilename>().0.lock().unwrap().get(label).cloned();
    let tags = filename.as_deref()
        .and_then(|f| app.state::<Arc<meta::MetaStore>>().get(f))
        .map(|m| m.tags)
        .unwrap_or_default();
    let ic = app.state::<std::sync::Arc<crate::icon_cache::IconCache>>();
    let window_crops = meta.window_crops.into_iter()
        .map(|wc| {
            let icon_b64 = ic.get_base64(&wc.app);
            WindowCropDto { x: wc.x, y: wc.y, w: wc.w, h: wc.h, label: wc.label, icon_b64 }
        })
        .collect();
    Ok(EditorMetaDto {
        title: meta.title,
        app: meta.app,
        is_window: meta.is_window,
        filename,
        tags,
        monitor_rects: meta.monitor_rects,
        monitor_names: meta.monitor_names,
        window_crops,
        bg_template: meta.bg_template,
    })
}

#[tauri::command]
pub async fn get_editor_image(app: AppHandle, window: tauri::WebviewWindow) -> Result<tauri::ipc::Response, String> {
    let label = window.label().to_string();
    for _ in 0..400 {
        let ready = app.state::<PendingEdit>().0.lock().unwrap().get(&label).cloned();
        if let Some(bytes) = ready {
            return Ok(tauri::ipc::Response::new(bytes));
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    Err("no pending image".into())
}

fn apply_tags_to_meta(app: &AppHandle, label: &str, tag_ids: Vec<String>) {
    if let Some(m) = app.state::<PendingEditMeta>().0.lock().unwrap().get_mut(label) {
        m.tags = tag_ids;
    }
}

#[tauri::command]
pub async fn editor_save(
    app: AppHandle,
    window: tauri::WebviewWindow,
    data: String,
    format: Option<String>,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    let image = decode_png_base64(&data)?;
    apply_tags_to_meta(&app, window.label(), tag_ids);
    let meta = take_editor_meta(&app, window.label());
    close_editor_window(window);
    let override_format = match format.as_deref() {
        Some("png")  => Some(ImageFormat::Png),
        Some("jpg")  => Some(ImageFormat::Jpg),
        Some("webp") => Some(ImageFormat::Webp),
        Some("avif") => Some(ImageFormat::Avif),
        Some("bmp")  => Some(ImageFormat::Bmp),
        _ => None,
    };
    overlay::save_and_finish(&app, image, crate::overlay::LinkTarget::None, meta, override_format).await;
    Ok(())
}

#[tauri::command]
pub async fn editor_share(
    app: AppHandle,
    window: tauri::WebviewWindow,
    data: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    let image = decode_png_base64(&data)?;
    apply_tags_to_meta(&app, window.label(), tag_ids);
    let meta = take_editor_meta(&app, window.label());
    close_editor_window(window);
    overlay::save_and_finish(&app, image, crate::overlay::LinkTarget::Drive, meta, None).await;
    Ok(())
}

#[tauri::command]
pub async fn editor_direct_link(
    app: AppHandle,
    window: tauri::WebviewWindow,
    data: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    let image = decode_png_base64(&data)?;
    apply_tags_to_meta(&app, window.label(), tag_ids);
    let meta = take_editor_meta(&app, window.label());
    close_editor_window(window);
    overlay::save_and_finish(&app, image, crate::overlay::LinkTarget::DirectLink, meta, None).await;
    Ok(())
}

#[tauri::command]
pub async fn editor_copy_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    data: String,
    format: Option<String>,
) -> Result<(), String> {
    let image = decode_png_base64(&data)?;
    let meta = get_editor_meta_clone(&app, window.label());
    let settings = app.state::<Arc<ConfigStore>>().get();
    let dir = settings.resolved_screenshots_dir();
    let fmt_str = format.as_deref().unwrap_or("png");
    let fmt = match fmt_str {
        "png"  => ImageFormat::Png,
        "jpg"  => ImageFormat::Jpg,
        "webp" => ImageFormat::Webp,
        "avif" => ImageFormat::Avif,
        "bmp"  => ImageFormat::Bmp,
        _ => settings.format.clone(),
    };
    let jpeg_quality = settings.jpeg_quality;
    let saved = tauri::async_runtime::spawn_blocking(move || {
        capture::save_image(&image, &dir, &fmt, jpeg_quality)
    })
    .await;
    let path = match saved {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => return Err(format!("Could not save: {e}")),
        Err(e) => return Err(e.to_string()),
    };
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
    app.state::<Arc<meta::MetaStore>>().set(
        file_name.clone(),
        meta::ScreenshotMeta {
            title: meta.title,
            app: meta.app,
            created: Some(chrono::Utc::now().timestamp()),
            tags: vec![],
        },
    );
    let _ = app.emit("library-changed", ());
    app.state::<library::LibraryCache>().clear();
    let engine = app.state::<Arc<SyncEngine>>();
    let _ = engine.tx.send(path.clone());

    crate::clipboard_file::copy_files_to_clipboard(&app, &[path])?;
    let _ = app.notification().builder()
        .title("Shotcove")
        .body(&format!("File copied to clipboard ✓ ({})", file_name))
        .show();
    Ok(())
}

#[tauri::command]
pub async fn editor_copy(app: AppHandle, data: String) -> Result<(), String> {
    let image = decode_png_base64(&data)?;
    let (w, h) = (image.width(), image.height());
    let img = tauri::image::Image::new_owned(image.into_raw(), w, h);
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_image(&img).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn editor_close(window: tauri::WebviewWindow) {
    close_editor_window(window);
}

#[tauri::command]
pub fn editor_ready(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let _ = window.set_always_on_top(false);
    let _ = window.set_focus();
}

#[tauri::command]
pub async fn open_editor_file(app: AppHandle, path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let sidecar = p.file_name().and_then(|n| n.to_str())
        .and_then(|name| crate::library::local_thumb_path(&app, name));
    let image = tauri::async_runtime::spawn_blocking(move || -> Result<RgbaImage, String> {
        if ext == "avif" {
            if sidecar.as_ref().is_some_and(|s| s.exists()) {
                image::open(sidecar.unwrap()).map(|img| img.to_rgba8()).map_err(|e| e.to_string())
            } else {
                #[cfg(windows)]
                {
                    crate::win_util::decode_via_wic(&p).map_err(|e| e.to_string())
                }
                #[cfg(not(windows))]
                {
                    Err("AVIF files cannot be edited on this platform (no JPEG sidecar found)".to_string())
                }
            }
        } else {
            image::open(&p).map(|img| img.to_rgba8()).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    let file_name = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let sm = app.state::<Arc<meta::MetaStore>>().get(&file_name);
    let tags = sm.as_ref().map(|m| m.tags.clone()).unwrap_or_default();
    let meta = CaptureMeta {
        title: sm.as_ref().and_then(|m| m.title.clone()),
        app:   sm.as_ref().and_then(|m| m.app.clone()),
        is_window: false,
        tags,
        monitor_rects: vec![],
        monitor_names: vec![],
        window_crops: vec![],
        bg_template: None,
    };
    let label = overlay::open_editor(&app, image, meta, false);
    app.state::<PendingEditFilename>().0.lock().unwrap().insert(label, file_name);
    Ok(())
}

use crate::config::ConfigStore;
use crate::drive::DriveClient;
use crate::meta::MetaStore;
use crate::sync::SyncState;
use base64::Engine;
use unicode_normalization::UnicodeNormalization;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

/// Normalizes a filename to Unicode NFC: the Drive API sometimes returns NFD
/// (decomposed), while the Windows filesystem uses NFC (composed), which
/// breaks matching for characters like ğ, ş, İ.
fn nfc(s: &str) -> String {
    s.nfc().collect()
}

/// Extracts a Unix timestamp from a Shotcove filename (YYYY-MM-DD_HH-MM-SS[-mmm]).
/// Supported formats:
///   Shotcove    : 2026-06-11_16-36-58[.png]  or  2026-06-11_16-36-58-123[.png]
///   macOS new   : Screenshot 2026-06-11 at 16.36.58[.png]
///   macOS old   : Screen Shot 2026-06-11 at 01.36.58 AM[.png]  (AM/PM)
///   Android     : Screenshot_20260611-163658[.png]
///   Android alt : Screenshot_2026-06-11-16-36-58[.png]
///   Compact     : 20260611_163658[.png]
///   Windows     : Screenshot 2026-06-11 163658[.png]
///   General scan: if YYYY-MM-DD + HH:MM:SS or HH-MM-SS is found anywhere in the filename
pub(crate) fn parse_timestamp_from_filename(name: &str) -> Option<i64> {
    use chrono::NaiveDateTime;

    let stem = std::path::Path::new(name).file_stem()?.to_str()?;

    let try_parse = |s: &str, fmt: &str| -> Option<i64> {
        NaiveDateTime::parse_from_str(s, fmt)
            .ok()
            .map(|dt| dt.and_utc().timestamp())
    };

    // 1. Shotcove: "2026-06-11_16-36-58" (ignore milliseconds if present)
    if stem.len() >= 19 && stem.is_char_boundary(19) {
        if let Some(ts) = try_parse(&stem[..19], "%Y-%m-%d_%H-%M-%S") {
            return Some(ts);
        }
    }

    // 2. macOS " at " format:
    //    "Screenshot 2026-06-11 at 16.36.58"
    //    "Screen Shot 2026-06-11 at 01.36.58.564 AM"
    if let Some(at_idx) = stem.find(" at ") {
        if stem.is_char_boundary(at_idx) && stem.is_char_boundary(at_idx + 4) {
            let before = stem[..at_idx].trim();
            let rest   = stem[at_idx + 4..].trim();
            // Date: last 10 characters of before are "YYYY-MM-DD"
            if before.len() >= 10 && before.is_char_boundary(before.len() - 10) {
                let date_str = &before[before.len() - 10..];
                let tokens: Vec<&str> = rest.split_whitespace().collect();
                if let Some(raw_time) = tokens.first() {
                    // If there's a third dot, trim milliseconds
                    let time_str = {
                        let third_dot = raw_time.match_indices('.').nth(2).map(|(i, _)| i);
                        if let Some(pos) = third_dot { &raw_time[..pos] } else { raw_time }
                    };
                    let ampm = tokens.get(1).map(|s| s.to_ascii_uppercase());
                    // If AM/PM present, use 12-hour format
                    if matches!(ampm.as_deref(), Some("AM") | Some("PM")) {
                        let combined = format!("{} {} {}", date_str, time_str, ampm.unwrap());
                        if let Some(ts) = try_parse(&combined, "%Y-%m-%d %I.%M.%S %p") {
                            return Some(ts);
                        }
                    }
                    // 24-hour
                    let combined = format!("{} {}", date_str, time_str);
                    if let Some(ts) = try_parse(&combined, "%Y-%m-%d %H.%M.%S") {
                        return Some(ts);
                    }
                }
            }
        }
    }

    // 3. Look after underscore (Screenshot_... formats)
    if let Some(uidx) = stem.find('_') {
        if stem.is_char_boundary(uidx + 1) {
            let after = &stem[uidx + 1..];
            // Android compact: "20260611-163658"
            if after.len() >= 15 && after.is_char_boundary(15) {
                if let Some(ts) = try_parse(&after[..15], "%Y%m%d-%H%M%S") {
                    return Some(ts);
                }
            }
            // Android alt: "2026-06-11-16-36-58"
            if after.len() >= 19 && after.is_char_boundary(19) {
                if let Some(ts) = try_parse(&after[..19], "%Y-%m-%d-%H-%M-%S") {
                    return Some(ts);
                }
            }
        }
    }

    // 4. Compact "20260611_163658"
    if stem.len() >= 15 && stem.is_char_boundary(15) {
        if let Some(ts) = try_parse(&stem[..15], "%Y%m%d_%H%M%S") {
            return Some(ts);
        }
    }

    // 5. General scan: find "YYYY-MM-DD" anywhere in the filename
    //    then look for a time separated by space/dash/colon
    let bytes = stem.as_bytes();
    let mut i = 0usize;
    while i + 10 <= bytes.len() {
        if !stem.is_char_boundary(i) || !stem.is_char_boundary(i + 10) {
            i += 1;
            continue;
        }
        // "YYYY-MM-DD" pattern: digit(4) - digit(2) - digit(2)
        if bytes[i+4] == b'-' && bytes[i+7] == b'-'
            && bytes[i..i+4].iter().all(|b| b.is_ascii_digit())
            && bytes[i+5..i+7].iter().all(|b| b.is_ascii_digit())
            && bytes[i+8..i+10].iter().all(|b| b.is_ascii_digit())
        {
            let date_str = &stem[i..i + 10];
            let rest = stem[i + 10..].trim_start_matches(|c: char| c == ' ' || c == '_' || c == 'T');

            // "HH-MM-SS" or "HH:MM:SS"
            if rest.len() >= 8 && rest.is_char_boundary(8) {
                for sep in ['-', ':'] {
                    let cand = format!("{} {}", date_str,
                        &rest[..8].replace(sep, ":"));
                    if let Some(ts) = try_parse(&cand, "%Y-%m-%d %H:%M:%S") {
                        return Some(ts);
                    }
                }
            }
            // "HHMMSS" (6 consecutive digits)
            if rest.len() >= 6 && rest.is_char_boundary(6) && rest[..6].chars().all(|c| c.is_ascii_digit()) {
                let cand = format!("{} {}", date_str, &rest[..6]);
                if let Some(ts) = try_parse(&cand, "%Y-%m-%d %H%M%S") {
                    return Some(ts);
                }
            }
        }
        i += 1;
    }

    None
}

fn is_image(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()),
        Some(ref e) if e == "png" || e == "jpg" || e == "jpeg" || e == "webp" || e == "avif" || e == "bmp"
    )
}

/// Reads the JPEG sidecar thumbnail cached for an AVIF file (see `local_thumb_path`).
/// Returns base64-encoded JPEG bytes, or None if no sidecar exists.
fn read_avif_sidecar(app: &AppHandle, path: &Path) -> Option<String> {
    use base64::Engine;
    let name = path.file_name()?.to_str()?;
    let sidecar = local_thumb_path(app, name)?;
    std::fs::read(sidecar).ok()
        .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
}

// ---------------------------------------------------------------------------
// Drive file-list disk cache — persists Drive listing across offline sessions
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
struct CachedDriveFile {
    id: String,
    name: String,
    created_time: Option<String>,
    web_view_link: Option<String>,
    size: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct DriveListDiskCache {
    /// Unix timestamp (seconds) when this cache was written.
    cached_at: i64,
    files: Vec<CachedDriveFile>,
}

fn drive_cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
        .map(|d| d.join("cache").join("drive_list.json"))
}

fn read_drive_cache(app: &AppHandle) -> Option<DriveListDiskCache> {
    let path = drive_cache_path(app)?;
    let bytes = std::fs::read(&path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn remove_from_drive_cache(app: &AppHandle, name: &str) {
    let Some(path) = drive_cache_path(app) else { return };
    let Ok(bytes) = std::fs::read(&path) else { return };
    let Ok(mut cache) = serde_json::from_slice::<DriveListDiskCache>(&bytes) else { return };
    cache.files.retain(|f| f.name != name);
    if let Ok(json) = serde_json::to_vec(&cache) {
        let _ = std::fs::write(&path, json);
    }
}

fn write_drive_cache(app: &AppHandle, files: &[crate::drive::DriveFile]) {
    let Some(path) = drive_cache_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let cached_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let cache = DriveListDiskCache {
        cached_at,
        files: files.iter().map(|f| CachedDriveFile {
            id: f.id.clone(),
            name: f.name.clone(),
            created_time: f.created_time.clone(),
            web_view_link: f.web_view_link.clone(),
            size: f.size.clone(),
        }).collect(),
    };
    if let Ok(json) = serde_json::to_vec(&cache) {
        let _ = std::fs::write(&path, json);
    }
}

// ---------------------------------------------------------------------------
// Offline Drive operation queue — persists ops that couldn't run without network
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
struct OfflineOp {
    op: String,       // "delete"
    drive_id: String,
    name: String,
}

fn offline_ops_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
        .map(|d| d.join("offline_ops.json"))
}

fn load_offline_ops(app: &AppHandle) -> Vec<OfflineOp> {
    let Some(path) = offline_ops_path(app) else { return Vec::new() };
    let Ok(bytes) = std::fs::read(&path) else { return Vec::new() };
    serde_json::from_slice::<Vec<OfflineOp>>(&bytes).unwrap_or_default()
}

fn save_offline_ops(app: &AppHandle, ops: &[OfflineOp]) {
    let Some(path) = offline_ops_path(app) else { return };
    if let Ok(json) = serde_json::to_vec(ops) {
        let _ = std::fs::write(path, json);
    }
}

fn queue_drive_delete(app: &AppHandle, drive_id: String, name: String) {
    let mut ops = load_offline_ops(app);
    // Deduplicate: skip if same drive_id already queued
    if ops.iter().any(|o| o.op == "delete" && o.drive_id == drive_id) {
        return;
    }
    ops.push(OfflineOp { op: "delete".into(), drive_id, name });
    save_offline_ops(app, &ops);
}

/// Called on startup and after Drive reconnect — executes any queued offline ops.
pub async fn drain_offline_ops(app: &AppHandle) {
    let drive = app.state::<Arc<DriveClient>>();
    if !drive.is_connected() {
        return;
    }
    let ops = load_offline_ops(app);
    if ops.is_empty() {
        return;
    }
    let config = app.state::<Arc<ConfigStore>>();
    let s = config.get();
    let cid  = s.effective_google_client_id().to_string();
    let csec = s.effective_google_client_secret().to_string();
    let mut remaining = Vec::new();
    let mut drained = 0usize;
    for op in ops {
        match op.op.as_str() {
            "delete" => {
                match drive.delete_file(&cid, &csec, &op.drive_id).await {
                    Ok(()) => {
                        log::info!("Offline delete drained: {}", op.name);
                        drained += 1;
                    }
                    Err(e) => {
                        log::warn!("Offline delete drain failed for {}: {e}", op.name);
                        remaining.push(op);
                    }
                }
            }
            _ => { /* unknown op — discard */ }
        }
    }
    save_offline_ops(app, &remaining);
    if drained > 0 {
        let cache = app.state::<LibraryCache>();
        cache.clear();
        let _ = app.emit("library-changed", ());
    }
}

// ---------------------------------------------------------------------------
// Unified library (local + Drive single list)
// ---------------------------------------------------------------------------

/// Gallery data stays in the Rust process; no re-fetch when the window opens or closes.
pub struct LibraryCache {
    data: Mutex<Option<Vec<LibraryItem>>>,
    /// Serializes concurrent Drive scans — the second call waits, gets the first
    /// call's result from cache; prevents duplicate Drive API requests.
    fetch_lock: tokio::sync::Mutex<()>,
}

impl Default for LibraryCache {
    fn default() -> Self {
        Self {
            data: Mutex::new(None),
            fetch_lock: tokio::sync::Mutex::new(()),
        }
    }
}

impl LibraryCache {
    pub fn get(&self) -> Option<Vec<LibraryItem>> {
        self.data.lock().unwrap().clone()
    }
    pub fn set(&self, items: Vec<LibraryItem>) {
        *self.data.lock().unwrap() = Some(items);
    }
    pub fn clear(&self) {
        *self.data.lock().unwrap() = None;
    }
}

#[derive(Serialize, Clone, Default)]
pub struct LibraryItem {
    name: String,
    local_path: Option<String>,
    /// Local modification time, Unix milliseconds
    modified: Option<u64>,
    size: Option<u64>,
    drive_id: Option<String>,
    drive_link: Option<String>,
    /// Drive creation time (ISO 8601)
    created: Option<String>,
    title: Option<String>,
    app: Option<String>,
    /// Capture time (Unix seconds, from metadata)
    captured: Option<i64>,
    /// Tag IDs assigned to this item
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tags: Vec<String>,
    /// Pre-encoded JPEG thumbnail (base64). Set for AVIF files via sidecar,
    /// because WebView2 cannot render AVIF via the asset protocol.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb_b64: Option<String>,
}

/// Returns the most reliable date in seconds for sorting.
fn date_key(it: &LibraryItem) -> i64 {
    if let Some(ts) = parse_timestamp_from_filename(&it.name) {
        return ts;
    }
    if let Some(c) = it.captured {
        return c;
    }
    if let Some(m) = it.modified {
        return (m / 1000) as i64;
    }
    if let Some(created) = &it.created {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(created) {
            return dt.timestamp();
        }
    }
    0
}

#[tauri::command]
pub async fn list_library(
    app: AppHandle,
    config: State<'_, Arc<ConfigStore>>,
    sync: State<'_, Arc<SyncState>>,
    drive: State<'_, Arc<DriveClient>>,
    meta: State<'_, Arc<MetaStore>>,
    cache: State<'_, LibraryCache>,
) -> Result<Vec<LibraryItem>, String> {
    // Fast path: if cache is populated, return directly without acquiring lock
    if let Some(cached) = cache.get() {
        return Ok(cached);
    }

    // Serialize concurrent Drive scans.
    // The second call waits here; once the first finishes the cache is populated
    // and the second call returns immediately after re-checking after acquiring the lock.
    let _fetch_guard = cache.fetch_lock.lock().await;

    // Re-check cache after acquiring lock — a previous fetch may have populated it
    if let Some(cached) = cache.get() {
        return Ok(cached);
    }

    let settings = config.get();
    let drive = drive.inner().clone();
    let connected = drive.is_connected();
    let dir = settings.resolved_screenshots_dir();

    let mut items: HashMap<String, LibraryItem> = HashMap::new();

    // Local files — send progress every 200 files
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || !is_image(&path) {
                continue;
            }
            let Ok(m) = entry.metadata() else { continue };
            let raw_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            let name = nfc(&raw_name);
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            let is_avif = path.extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("avif"))
                .unwrap_or(false);
            let thumb_b64 = if is_avif { read_avif_sidecar(&app, &path) } else { None };
            items.insert(
                name.clone(),
                LibraryItem {
                    drive_id: sync.get(&name).or_else(|| sync.get(&raw_name)),
                    local_path: Some(path.to_string_lossy().to_string()),
                    modified,
                    size: Some(m.len()),
                    name,
                    thumb_b64,
                    ..Default::default()
                },
            );
            // Emit an instant count every 200 files
            let n = items.len();
            if n % 200 == 0 {
                let _ = app.emit("loading-progress", serde_json::json!({
                    "step": "local-scan", "count": n
                }));
            }
        }
    }

    // Local scan complete
    let local_count = items.len();
    let _ = app.emit("loading-progress", serde_json::json!({
        "step": "local", "count": local_count
    }));

    // Drive files (authoritative source when connected)
    if connected {
        let _ = app.emit("loading-progress", serde_json::json!({
            "step": "drive-start", "count": 0
        }));
        let app_ref = app.clone();
        let list_result = drive
            .list_files(
                settings.effective_google_client_id(),
                settings.effective_google_client_secret(),
                &settings.drive_folder_name,
                |fetched, page| {
                    let _ = app_ref.emit("loading-progress", serde_json::json!({
                        "step": "drive-scan", "count": fetched, "page": page
                    }));
                },
            )
            .await;
        if let Ok((files, from_cache)) = list_result {
            // Persist the fresh Drive list to disk before consuming the Vec.
            if !from_cache {
                write_drive_cache(&app, &files);
            }

            // NFC-normalize Drive file names too (for matching)
            let drive_names: std::collections::HashSet<String> =
                files.iter().map(|f| nfc(&f.name)).collect();

            // Merge files from Drive and sync with uploaded.json.
            // Since Drive is the authoritative source, write back files that exist there
            // but are missing from uploaded.json — so the same files don't re-queue every session.
            let mut missing_in_uploaded: Vec<(String, String)> = Vec::new();
            for f in files {
                let drive_id = f.id.clone();
                // NFC normalize: match NFD name from Drive with local NFC name
                let name = nfc(&f.name);
                // Ignore files without an image extension (metadata.json, icons, etc.)
                if !is_image(std::path::Path::new(&name)) { continue; }
                let entry = items.entry(name.clone()).or_insert_with(|| LibraryItem {
                    name: name.clone(),
                    ..Default::default()
                });
                entry.drive_id = Some(drive_id.clone());
                entry.drive_link = f.web_view_link;
                entry.created = f.created_time;
                if entry.size.is_none() {
                    entry.size = f.size.and_then(|s| s.parse().ok());
                }
                // Write back if not in uploaded.json (Drive → uploaded.json sync)
                if sync.get(&name).is_none() {
                    missing_in_uploaded.push((name, drive_id));
                }
            }
            if !missing_in_uploaded.is_empty() {
                log::info!(
                    "Writing back {} files from Drive to uploaded.json (sync)",
                    missing_in_uploaded.len()
                );
                sync.record_batch(missing_in_uploaded);
            }

            // Clean up uploaded.json records for files manually deleted from Drive.
            // SAFETY: if the Drive list has far fewer files than uploaded.json
            // (possible network error / missing pagination), skip the prune.
            // Never prune on a cached result — cache can be 30 s stale and files
            // uploaded in that window won't appear in drive_names, causing accidental removal.
            let uploaded_count = sync.len();
            let drive_count = drive_names.len();
            let prune_safe = !from_cache && (
                drive_count == 0
                || drive_count >= uploaded_count.saturating_sub(uploaded_count / 4)
            );

            let pruned = if prune_safe {
                sync.prune(&drive_names)
            } else {
                log::warn!(
                    "Drive list ({drive_count}) has far fewer files than uploaded.json ({uploaded_count}); \
                     skipping prune (possible network/pagination issue)"
                );
                0
            };

            // Drop drive_ids that are not confirmed by a fresh Drive listing.
            // A cached list may be 30 s stale and will not contain files uploaded just now,
            // so skip this cleanup when the list came from cache to avoid clearing a valid id.
            // drive_names is already NFC-normalized; item.name is also NFC so compare directly.
            if !from_cache {
                for item in items.values_mut() {
                    if item.drive_id.is_some() && !drive_names.contains(&item.name) {
                        // Remove from uploaded.json so the file can be re-uploaded if needed.
                        // This cleans up stale entries left by interrupted batch-delete operations.
                        sync.remove(&item.name);
                        item.drive_id = None;
                        item.drive_link = None;
                    }
                }
            }

            // Files whose records were cleaned must be re-uploaded
            if pruned > 0 {
                log::info!("{pruned} records not found in Drive were cleaned, restarting scan");
                crate::sync::scan_and_enqueue(&app);
            }

            // Drive scan complete
            let _ = app.emit("loading-progress", serde_json::json!({
                "step": "drive",
                "count": items.len()
            }));
        } else {
            // Token valid but API call failed → no internet. Fall back to disk cache.
            if let Some(disk_cache) = read_drive_cache(&app) {
                let _ = app.emit("loading-progress", serde_json::json!({
                    "step": "drive-cached",
                    "cached_at": disk_cache.cached_at,
                    "count": disk_cache.files.len()
                }));
                for f in disk_cache.files {
                    let name = nfc(&f.name);
                    if !is_image(std::path::Path::new(&name)) { continue; }
                    let entry = items.entry(name.clone()).or_insert_with(|| LibraryItem {
                        name: name.clone(),
                        ..Default::default()
                    });
                    entry.drive_id = Some(f.id);
                    entry.drive_link = f.web_view_link;
                    entry.created = f.created_time;
                    if entry.size.is_none() {
                        entry.size = f.size.and_then(|s| s.parse().ok());
                    }
                }
            }
        }
    }
    // If !connected (no tokens) → show nothing from Drive; disk cache is NOT read.

    // Secondary matching: merge local+Drive pairs that are the same file but have different names.
    // Criterion: same size (≥1 KB) AND same Unix timestamp parsed from the filename.
    {
        let local_only: Vec<(String, Option<u64>)> = items.iter()
            .filter(|(_, v)| v.local_path.is_some() && v.drive_id.is_none())
            .map(|(k, v)| (k.clone(), v.size))
            .collect();

        let drive_only: Vec<(String, Option<u64>)> = items.iter()
            .filter(|(_, v)| v.local_path.is_none() && v.drive_id.is_some())
            .map(|(k, v)| (k.clone(), v.size))
            .collect();

        if !local_only.is_empty() && !drive_only.is_empty() {
            let mut merge_pairs: Vec<(String, String)> = Vec::new();
            let mut used_drive = std::collections::HashSet::<usize>::new();

            for (local_key, local_size) in &local_only {
                let Some(local_ts) = parse_timestamp_from_filename(local_key) else { continue };

                for (di, (drive_key, drive_size)) in drive_only.iter().enumerate() {
                    if used_drive.contains(&di) { continue; }
                    // Size must match and must not be trivially small
                    match (local_size, drive_size) {
                        (Some(ls), Some(ds)) if ls == ds && *ls >= 1024 => {}
                        _ => continue,
                    }
                    let Some(drive_ts) = parse_timestamp_from_filename(drive_key) else { continue };
                    if local_ts == drive_ts {
                        merge_pairs.push((local_key.clone(), drive_key.clone()));
                        used_drive.insert(di);
                        break;
                    }
                }
            }

            for (local_key, drive_key) in merge_pairs {
                if let Some(drive_item) = items.remove(&drive_key) {
                    if let Some(local_item) = items.get_mut(&local_key) {
                        local_item.drive_id = drive_item.drive_id;
                        local_item.drive_link = drive_item.drive_link;
                        if local_item.created.is_none() { local_item.created = drive_item.created; }
                        if local_item.size.is_none() { local_item.size = drive_item.size; }
                    }
                }
            }
        }
    }

    // Metadata
    for (name, item) in items.iter_mut() {
        if let Some(md) = meta.get(name) {
            item.title = md.title;
            item.app = md.app;
            item.captured = md.created;
            item.tags = md.tags;
        }
    }

    let mut list: Vec<LibraryItem> = items.into_values().collect();
    list.sort_by(|a, b| {
        date_key(b).cmp(&date_key(a))
            .then_with(|| a.name.cmp(&b.name))
    });
    cache.set(list.clone());
    Ok(list)
}

/// Fast local scan for the popup — makes no Drive API call, does not wait for cache.
/// Reads only the screenshots folder and returns the newest `n` files (~5–15ms).
#[tauri::command]
pub fn list_recent_local(
    app: AppHandle,
    config: State<'_, Arc<ConfigStore>>,
    sync: State<'_, Arc<SyncState>>,
    meta: State<'_, Arc<MetaStore>>,
    n: usize,
) -> Vec<LibraryItem> {
    let dir = config.get().resolved_screenshots_dir();
    let mut items: Vec<LibraryItem> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || !is_image(&path) { continue; }
            let Ok(m) = entry.metadata() else { continue };
            let raw_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            let name = nfc(&raw_name);
            let modified = m.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            let drive_id = sync.get(&name).or_else(|| sync.get(&raw_name));
            let (title, app_name, captured, tags) = meta.get(&name)
                .map(|md| (md.title, md.app, md.created, md.tags))
                .unwrap_or_default();
            let is_avif = path.extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("avif"))
                .unwrap_or(false);
            let thumb_b64 = if is_avif { read_avif_sidecar(&app, &path) } else { None };
            items.push(LibraryItem {
                name,
                local_path: Some(path.to_string_lossy().to_string()),
                modified,
                size: Some(m.len()),
                drive_id,
                title,
                app: app_name,
                captured,
                tags,
                thumb_b64,
                ..Default::default()
            });
        }
    }
    items.sort_by(|a, b| date_key(b).cmp(&date_key(a)));
    items.truncate(n);
    items
}

#[tauri::command]
pub async fn refresh_library(
    app: AppHandle,
    config: State<'_, Arc<ConfigStore>>,
    sync: State<'_, Arc<SyncState>>,
    drive: State<'_, Arc<DriveClient>>,
    meta: State<'_, Arc<MetaStore>>,
    cache: State<'_, LibraryCache>,
) -> Result<Vec<LibraryItem>, String> {
    cache.clear();
    drive.clear_cache();
    list_library(app, config, sync, drive, meta, cache).await
}

#[tauri::command]
pub fn get_offline_ops_count(app: AppHandle) -> usize {
    load_offline_ops(&app).len()
}

/// Deletes a screenshot from local storage and from Drive (if present).
#[tauri::command]
pub async fn delete_item(
    app: AppHandle,
    config: State<'_, Arc<ConfigStore>>,
    sync: State<'_, Arc<SyncState>>,
    drive: State<'_, Arc<DriveClient>>,
    meta: State<'_, Arc<MetaStore>>,
    cache: State<'_, LibraryCache>,
    name: String,
    local_path: Option<String>,
    drive_id: Option<String>,
) -> Result<(), String> {
    let mut drive_err = None;

    if let Some(p) = local_path {
        trash::delete(&p).map_err(|e| e.to_string())?;
        delete_local_thumb(&app, &name);
    }

    if let Some(id) = drive_id {
        let drive = drive.inner().clone();
        if drive.is_connected() {
            let s = config.get();
            match drive
                .delete_file(s.effective_google_client_id(), s.effective_google_client_secret(), &id)
                .await
            {
                // Purge from the on-disk Drive-list cache so a later reload can't
                // resurrect the item before Drive's list becomes consistent.
                Ok(()) => remove_from_drive_cache(&app, &name),
                Err(e) => drive_err = Some(e.to_string()),
            }
        } else {
            // Offline: queue deletion for when connection is restored.
            // Also purge from the local Drive-list cache so the item doesn't
            // reappear as "Drive only" during the offline session.
            queue_drive_delete(&app, id, name.clone());
            remove_from_drive_cache(&app, &name);
        }
    }

    sync.remove(&name);
    meta.remove(&name);
    cache.clear();

    match drive_err {
        Some(e) => Err(format!("Deleted locally, but could not delete from Drive: {e}")),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Thumbnail / preview
// ---------------------------------------------------------------------------

fn encode_jpeg(img: image::DynamicImage, max: u32, quality: u8) -> Result<String, String> {
    let scaled = if img.width() > max || img.height() > max {
        img.thumbnail(max, max)
    } else {
        img
    };
    let rgb = scaled.to_rgb8();
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality)
        .encode_image(&rgb)
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(buf))
}

#[tauri::command]
pub async fn read_thumbnail(
    app: tauri::AppHandle,
    sync: tauri::State<'_, Arc<SyncState>>,
    drive: tauri::State<'_, Arc<DriveClient>>,
    config: tauri::State<'_, Arc<ConfigStore>>,
    path: String,
    max: Option<u32>,
) -> Result<String, String> {
    let max = max.unwrap_or(360);
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    if ext == "avif" {
        let filename = std::path::Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();

        // First, check the cached JPEG sidecar
        if let Some(sidecar) = local_thumb_path(&app, &filename) {
            if let Ok(bytes) = std::fs::read(&sidecar) {
                use base64::Engine;
                return Ok(base64::engine::general_purpose::STANDARD.encode(bytes));
            }
        }

        // If the sidecar is missing, check if it's synced to Google Drive
        if let Some(drive_id) = sync.get(&filename) {
            let drive_client = drive.inner().clone();
            if drive_client.is_connected() {
                let settings = config.get();
                let client_id = settings.effective_google_client_id().to_string();
                let client_secret = settings.effective_google_client_secret().to_string();

                // Fetch the thumbnail from Google Drive
                if let Ok(thumb_bytes) = drive_client.thumbnail(&client_id, &client_secret, &drive_id, max).await {
                    // Cache it so we don't need to fetch it again next time
                    write_local_thumb(&app, &filename, &thumb_bytes);
                    use base64::Engine;
                    return Ok(base64::engine::general_purpose::STANDARD.encode(thumb_bytes));
                }
            }
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        let img = if ext == "avif" {
            #[cfg(windows)]
            {
                match crate::win_util::decode_via_wic(std::path::Path::new(&path)) {
                    Ok(rgba) => image::DynamicImage::ImageRgba8(rgba),
                    Err(_) => {
                        return Err("AVIF decode failed and no sidecar thumbnail found".into());
                    }
                }
            }
            #[cfg(not(windows))]
            {
                image::open(&path).map_err(|e| e.to_string())?
            }
        } else {
            image::open(&path).map_err(|e| e.to_string())?
        };
        encode_jpeg(img, max, 78)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_full_image(
    app: tauri::AppHandle,
    sync: tauri::State<'_, Arc<SyncState>>,
    drive: tauri::State<'_, Arc<DriveClient>>,
    config: tauri::State<'_, Arc<ConfigStore>>,
    path: String,
) -> Result<String, String> {
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    if ext == "avif" {
        let filename = std::path::Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();

        // First, check the cached JPEG sidecar
        if let Some(sidecar) = local_thumb_path(&app, &filename) {
            if let Ok(bytes) = std::fs::read(&sidecar) {
                use base64::Engine;
                return Ok(base64::engine::general_purpose::STANDARD.encode(bytes));
            }
        }

        // If the sidecar is missing, check if it's synced to Google Drive
        if let Some(drive_id) = sync.get(&filename) {
            let drive_client = drive.inner().clone();
            if drive_client.is_connected() {
                let settings = config.get();
                let client_id = settings.effective_google_client_id().to_string();
                let client_secret = settings.effective_google_client_secret().to_string();

                // Fetch a high-res thumbnail (1600px) from Google Drive
                if let Ok(thumb_bytes) = drive_client.thumbnail(&client_id, &client_secret, &drive_id, 1600).await {
                    // Cache it so we don't need to fetch it again next time
                    write_local_thumb(&app, &filename, &thumb_bytes);
                    use base64::Engine;
                    return Ok(base64::engine::general_purpose::STANDARD.encode(thumb_bytes));
                }
            }
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        let img = image::open(&path).map_err(|e| e.to_string())?;
        encode_jpeg(img, 2000, 90)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_drive_thumbnail(
    app: AppHandle,
    config: State<'_, Arc<ConfigStore>>,
    drive: State<'_, Arc<DriveClient>>,
    id: String,
    size: Option<u32>,
) -> Result<String, String> {
    let cache_dir = app.path().app_config_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("thumbnails");
    
    let _ = std::fs::create_dir_all(&cache_dir);
    let target_size = size.unwrap_or(480);
    let cache_path = cache_dir.join(format!("{}_{}.jpg", id, target_size));
    
    let mut actual_path = cache_path.clone();
    // Backward compatibility: fallback to legacy `{id}.jpg` for 480px thumbnails
    if !actual_path.exists() && target_size == 480 {
        let legacy_path = cache_dir.join(format!("{}.jpg", id));
        if legacy_path.exists() {
            actual_path = legacy_path;
        }
    }
    
    if actual_path.exists() {
        if let Ok(bytes) = std::fs::read(&actual_path) {
            return Ok(base64::engine::general_purpose::STANDARD.encode(bytes));
        }
    }
    
    let drive = drive.inner().clone();
    let s = config.get();
    
    let bytes = if target_size > 1000 {
        drive
            .download_file(
                s.effective_google_client_id(),
                s.effective_google_client_secret(),
                &id,
            )
            .await
            .map_err(|e| {
                log::error!("read_drive_thumbnail (download_file) error (id={id}): {e}");
                e.to_string()
            })?
    } else {
        drive
            .thumbnail(
                s.effective_google_client_id(),
                s.effective_google_client_secret(),
                &id,
                target_size,
            )
            .await
            .map_err(|e| {
                log::warn!("read_drive_thumbnail (thumbnail) id={id}: {e}");
                e.to_string()
            })?
    };
    
    let _ = std::fs::write(&cache_path, &bytes);
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn open_item(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_item(app: AppHandle, path: String) -> Result<(), String> {
    let _ = &app;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        if let Some(parent) = Path::new(&path).parent() {
            app.opener()
                .open_path(parent.to_string_lossy().to_string(), None::<&str>)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn copy_local_image(app: AppHandle, path: String) -> Result<(), String> {
    let (raw, w, h) = tauri::async_runtime::spawn_blocking(move || {
        let img = image::open(&path).map_err(|e| e.to_string())?.to_rgba8();
        let (w, h) = (img.width(), img.height());
        Ok::<_, String>((img.into_raw(), w, h))
    })
    .await
    .map_err(|e| e.to_string())??;
    let image = tauri::image::Image::new_owned(raw, w, h);
    app.clipboard().write_image(&image).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_items(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    {
        let drive = app.state::<Arc<DriveClient>>();
        if !drive.is_connected() {
            return Err("Google Drive not connected".into());
        }
    }
    let path_bufs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    crate::sync::inspect_and_enqueue_background(app, path_bufs);
    Ok(())
}

/// Uploads a local file to the selected direct link provider, copies the link to the clipboard, and returns.
#[tauri::command]
pub async fn direct_link_copy_link(
    app: AppHandle,
    config: State<'_, Arc<ConfigStore>>,
    path: String,
) -> Result<String, String> {
    let settings = config.get();
    if !crate::direct_link::any_provider_enabled(&settings) {
        return Err("No direct link provider is enabled (Settings → Direct Link)".into());
    }
    
    let path_buf = std::path::PathBuf::from(&path);
    let ext = path_buf.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
        
    let (bytes, file_name) = if ext == "avif" {
        let basename = path_buf.file_name().and_then(|f| f.to_str()).unwrap_or_default();
        let sidecar_bytes = local_thumb_path(&app, basename).and_then(|s| std::fs::read(s).ok());
        if let Some(jpeg_bytes) = sidecar_bytes {
            let stem = path_buf.file_stem().and_then(|s| s.to_str()).unwrap_or("screenshot");
            (jpeg_bytes, format!("{stem}.jpg"))
        } else {
            let avif_bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            let name = path_buf.file_name().and_then(|f| f.to_str()).unwrap_or("screenshot.avif").to_string();
            (avif_bytes, name)
        }
    } else {
        let file_bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let name = path_buf.file_name().and_then(|f| f.to_str()).unwrap_or("screenshot.png").to_string();
        (file_bytes, name)
    };
    
    let url = crate::direct_link::upload_to_provider(&settings, &file_name, &bytes)
        .await
        .map_err(|e| e.to_string())?;
        
    app.clipboard()
        .write_text(&url)
        .map_err(|e| e.to_string())?;
    Ok(url)
}

/// Shares a Drive file, copies the link to the clipboard, and returns.
#[tauri::command]
pub async fn drive_copy_link(
    app: AppHandle,
    config: State<'_, Arc<ConfigStore>>,
    drive: State<'_, Arc<DriveClient>>,
    id: String,
) -> Result<String, String> {
    let drive = drive.inner().clone();
    let s = config.get();
    let url = drive
        .share_link(s.effective_google_client_id(), s.effective_google_client_secret(), &id)
        .await
        .map_err(|e| e.to_string())?;
    app.clipboard()
        .write_text(url.clone())
        .map_err(|e| e.to_string())?;
    Ok(url)
}

#[derive(Serialize)]
pub struct StorageInfo {
    pub local_bytes: u64,
    pub drive_limit: Option<u64>,
    pub drive_usage: u64,
    pub cache_bytes: u64,
}

/// Cache directories that only hold disposable, re-derivable data (downloaded Drive
/// thumbnails/previews and extracted app icons) — safe to wipe entirely at any time.
fn cache_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let Ok(config_dir) = app.path().app_config_dir() else { return Vec::new() };
    vec![config_dir.join("cache").join("thumbnails"), config_dir.join("icon_cache")]
}

/// Cache directory for JPEG thumbnail sidecars of AVIF files (Windows' image
/// stack has no AVIF decoder). Deliberately NOT part of `cache_dirs()`: a
/// locally captured AVIF's sidecar can't be re-derived without an AVIF
/// decoder, so wiping it on Windows would permanently break that thumbnail.
fn local_thumb_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("cache").join("local_thumbs"))
}

/// Sidecar JPEG path for a screenshot, keyed by file name (not the original's
/// full path) so callers don't need to track where the screenshot itself lives.
pub(crate) fn local_thumb_path(app: &AppHandle, file_name: &str) -> Option<PathBuf> {
    Some(local_thumb_dir(app)?.join(file_name).with_extension("thumb"))
}

pub(crate) fn write_local_thumb(app: &AppHandle, file_name: &str, bytes: &[u8]) {
    let Some(path) = local_thumb_path(app, file_name) else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, bytes);
}

pub(crate) fn delete_local_thumb(app: &AppHandle, file_name: &str) {
    if let Some(path) = local_thumb_path(app, file_name) {
        let _ = std::fs::remove_file(path);
    }
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    rd.flatten()
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

#[tauri::command]
pub async fn get_storage_info(
    app: AppHandle,
    config: State<'_, Arc<ConfigStore>>,
    drive: State<'_, Arc<DriveClient>>,
) -> Result<StorageInfo, String> {
    let settings = config.get();
    let dir = settings.resolved_screenshots_dir();

    let local_bytes = std::fs::read_dir(&dir)
        .map(|rd| rd.flatten()
            .filter_map(|e| e.metadata().ok().map(|m| m.len()))
            .sum())
        .unwrap_or(0);

    let (drive_limit, drive_usage) = if drive.is_connected() {
        drive
            .storage_quota(settings.effective_google_client_id(), settings.effective_google_client_secret())
            .await
            .unwrap_or((None, 0))
    } else {
        (None, 0)
    };

    let cache_bytes = cache_dirs(&app).iter().map(|d| dir_size(d)).sum();

    Ok(StorageInfo { local_bytes, drive_limit, drive_usage, cache_bytes })
}

/// Wipes the disposable thumbnail/icon caches and returns the number of bytes freed.
/// Everything removed here is re-downloaded or re-extracted on demand, so this is safe
/// to run at any time without affecting the user's actual screenshots or app settings.
#[tauri::command]
pub fn clear_app_cache(app: AppHandle) -> Result<u64, String> {
    let mut freed = 0u64;
    for dir in cache_dirs(&app) {
        freed += dir_size(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
    }
    Ok(freed)
}

#[tauri::command]
pub fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(&text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn download_drive_item(
    app: AppHandle,
    config: State<'_, Arc<ConfigStore>>,
    drive: State<'_, Arc<DriveClient>>,
    sync: State<'_, Arc<SyncState>>,
    cache: State<'_, LibraryCache>,
    name: String,
    drive_id: String,
) -> Result<String, String> {
    if !drive.is_connected() {
        return Err("Google Drive not connected".into());
    }
    let s = config.get();
    let dir = s.resolved_screenshots_dir();
    let dest_path = dir.join(&name);

    let engine = app.state::<Arc<crate::sync::SyncEngine>>();
    engine.transfers_manager.update_transfer(
        &app,
        name.clone(),
        "uploading".into(),
        Some("Downloading…".into()),
        None,
    );

    let progress_app = app.clone();
    let progress_name = name.clone();
    let on_progress = move |received: u64, total: u64, bps: u64| {
        if let Some(engine) = progress_app.try_state::<Arc<crate::sync::SyncEngine>>() {
            engine.transfers_manager.update_transfer(
                &progress_app,
                progress_name.clone(),
                "uploading".into(),
                Some("Downloading…".into()),
                Some((received, total, bps)),
            );
        }
    };

    let result = drive
        .download_file_with_progress(s.effective_google_client_id(), s.effective_google_client_secret(), &drive_id, on_progress)
        .await;

    let bytes = match result {
        Ok(b) => b,
        Err(e) => {
            engine.transfers_manager.update_transfer(
                &app,
                name.clone(),
                "error".into(),
                Some(e.to_string()),
                None,
            );
            return Err(e.to_string());
        }
    };

    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Record first so the watcher doesn't re-upload when it sees the file
    sync.record(name.clone(), drive_id.clone());
    std::fs::write(&dest_path, &bytes).map_err(|e| e.to_string())?;

    // Download Google Drive thumbnail for AVIF file as the .thumb sidecar in the background
    let path_buf = std::path::PathBuf::from(&name);
    let ext = path_buf.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if ext == "avif" {
        let drive_clone = drive.inner().clone();
        let client_id = s.effective_google_client_id().to_string();
        let client_secret = s.effective_google_client_secret().to_string();
        let drive_id_clone = drive_id.clone();
        let app_clone = app.clone();
        let file_name = name.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(thumb_bytes) = drive_clone.thumbnail(&client_id, &client_secret, &drive_id_clone, 1600).await {
                write_local_thumb(&app_clone, &file_name, &thumb_bytes);
            }
        });
    }

    // Preserve original timestamp:
    // 1. From local metadata.json (most reliable, Shotcove's own record)
    // 2. From Drive modifiedTime (we stored mtime on upload, may have come from another device)
    // 3. Parsed from filename (YYYY-MM-DD_HH-MM-SS format)
    {
        let original_secs: Option<i64> = {
            let meta_store = app.state::<Arc<crate::meta::MetaStore>>();
            meta_store.get(&name)
                .and_then(|m| m.created)
                .or_else(|| parse_timestamp_from_filename(&name))
        };
        let secs = if let Some(s) = original_secs {
            Some(s)
        } else {
            drive.get_file_modified_time(s.effective_google_client_id(), s.effective_google_client_secret(), &drive_id)
                .await
                .ok()
                .flatten()
        };
        if let Some(secs) = secs {
            let ft = filetime::FileTime::from_unix_time(secs, 0);
            let _ = filetime::set_file_mtime(&dest_path, ft);
        }
    }

    engine.transfers_manager.update_transfer(
        &app,
        name.clone(),
        "done".into(),
        Some("Downloaded to local copy".into()),
        None,
    );
    cache.clear();
    let _ = app.emit("library-changed", ());
    Ok(dest_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_local_copy(
    app: AppHandle,
    cache: State<'_, LibraryCache>,
    local_path: String,
) -> Result<(), String> {
    let p = std::path::Path::new(&local_path);
    if p.exists() {
        trash::delete(p).map_err(|e| e.to_string())?;
        if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
            delete_local_thumb(&app, name);
        }
    }
    cache.clear();
    let _ = app.emit("library-changed", ());
    Ok(())
}

use crate::config::{ConfigStore, SyncMode};
use crate::drive::DriveClient;
use crate::library::LibraryCache;
use crate::meta::MetaStore;
use anyhow::Result;
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult, DebouncedEvent};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// Persistent upload queue — survives restarts and offline sessions
// ---------------------------------------------------------------------------

fn pending_queue_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
        .map(|d| d.join("pending_uploads.json"))
}

/// Atomically overwrites the on-disk queue with the current in-memory list.
fn save_pending_queue(app: &AppHandle, names: &[String]) {
    let Some(path) = pending_queue_path(app) else { return };
    if let Ok(json) = serde_json::to_vec(names) {
        let _ = std::fs::write(path, json);
    }
}

/// Reads the persisted queue; returns drive-sanitized file names.
fn load_pending_queue(app: &AppHandle) -> Vec<String> {
    let Some(path) = pending_queue_path(app) else { return Vec::new() };
    let Ok(bytes) = std::fs::read(&path) else { return Vec::new() };
    serde_json::from_slice::<Vec<String>>(&bytes).unwrap_or_default()
}

/// Record of uploaded files: file name -> Drive file id.
/// This prevents the same file from being uploaded twice even after a restart.
pub struct SyncState {
    path: PathBuf,
    map: Mutex<HashMap<String, String>>,
    /// File names currently being actively uploaded — prevents double-uploading the same file.
    uploading: Mutex<HashSet<String>>,
    /// Last upload time: protects files not yet indexed in Drive during pruning.
    recently_recorded: Mutex<HashMap<String, std::time::Instant>>,
}

impl SyncState {
    pub fn load(config_dir: PathBuf) -> Self {
        let path = config_dir.join("uploaded.json");
        let map = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            map: Mutex::new(map),
            uploading: Mutex::new(HashSet::new()),
            recently_recorded: Mutex::new(HashMap::new()),
        }
    }

    pub fn get(&self, file_name: &str) -> Option<String> {
        self.map.lock().unwrap().get(file_name).cloned()
    }

    pub fn record(&self, file_name: String, drive_id: String) {
        let json = {
            let mut map = self.map.lock().unwrap();
            map.insert(file_name.clone(), drive_id);
            serde_json::to_string_pretty(&*map).unwrap_or_default()
        };
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&self.path, json);
        // Against Drive indexing delay: let prune skip this file for 90 seconds.
        self.recently_recorded.lock().unwrap().insert(file_name, std::time::Instant::now());
    }

    /// Adds multiple records with a single disk write (for bulk sync).
    pub fn record_batch(&self, entries: Vec<(String, String)>) {
        if entries.is_empty() { return; }
        let json = {
            let mut map = self.map.lock().unwrap();
            for (name, id) in entries {
                map.insert(name, id);
            }
            serde_json::to_string_pretty(&*map).unwrap_or_default()
        };
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&self.path, json);
    }


    pub fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }

    pub fn remove(&self, file_name: &str) {
        let json = {
            let mut map = self.map.lock().unwrap();
            map.remove(file_name);
            serde_json::to_string_pretty(&*map).unwrap_or_default()
        };
        let _ = std::fs::write(&self.path, json);
    }

    pub fn load_metadata_hash(&self) -> Option<u64> {
        let path = self.path.with_file_name("metadata_sync_hash.txt");
        std::fs::read_to_string(path).ok()?.trim().parse().ok()
    }

    pub fn save_metadata_hash(&self, hash: u64) {
        let path = self.path.with_file_name("metadata_sync_hash.txt");
        let _ = std::fs::write(path, hash.to_string());
    }

    /// Removes files no longer present in Drive from uploaded.json.
    /// Returns the number of deleted records.
    pub fn prune(&self, valid_names: &HashSet<String>) -> usize {
        let now = std::time::Instant::now();
        let grace = std::time::Duration::from_secs(90);
        let recent = self.recently_recorded.lock().unwrap();
        let stale: Vec<String> = {
            let map = self.map.lock().unwrap();
            map.keys()
                .filter(|k| !valid_names.contains(*k))
                .filter(|k| {
                    // Drive indexing delay: skip files uploaded within the last 90 seconds.
                    recent.get(*k).map(|t| now.duration_since(*t) > grace).unwrap_or(true)
                })
                .cloned()
                .collect()
        };
        if stale.is_empty() {
            return 0;
        }
        let json = {
            let mut map = self.map.lock().unwrap();
            for name in &stale {
                map.remove(name);
            }
            serde_json::to_string_pretty(&*map).unwrap_or_default()
        };
        let _ = std::fs::write(&self.path, json);
        stale.len()
    }

    pub fn clear(&self) {
        let json = {
            let mut map = self.map.lock().unwrap();
            map.clear();
            serde_json::to_string_pretty(&*map).unwrap_or_default()
        };
        let _ = std::fs::write(&self.path, json);
        self.uploading.lock().unwrap().clear();
        self.recently_recorded.lock().unwrap().clear();
        let hash_path = self.path.with_file_name("metadata_sync_hash.txt");
        let _ = std::fs::remove_file(hash_path);
    }
}

use std::time::{SystemTime, UNIX_EPOCH};


#[derive(Clone, Serialize)]
pub struct TransferInfo {
    pub file: String,
    pub status: String, // "queued" | "uploading" | "done" | "error"
    pub message: Option<String>,
    pub time: u64,
    pub sent: u64,
    pub total: u64,
    pub bps: u64,
}

#[derive(Clone, Serialize)]
pub struct TransfersPayload {
    pub active: Vec<TransferInfo>,
    pub queued: Vec<TransferInfo>,
    pub history: Vec<TransferInfo>,
    pub queued_count: usize,
    pub total_done: usize,
    pub total_error: usize,
    pub is_paused: bool,
}

pub struct TransfersManager {
    pub transfers: Mutex<Vec<TransferInfo>>,
    last_emit: Mutex<u64>,
    pending_emit: Mutex<bool>,
    /// Real total completion/error count — so it isn't lost when the history list is capped at 50.
    total_done: std::sync::atomic::AtomicUsize,
    total_error: std::sync::atomic::AtomicUsize,
    /// Upload queue pause flag; shares the same Arc as SyncEngine.is_paused.
    pub is_paused: Arc<std::sync::atomic::AtomicBool>,
}

impl TransfersManager {
    pub fn new() -> Self {
        Self {
            transfers: Mutex::new(Vec::new()),
            last_emit: Mutex::new(0),
            pending_emit: Mutex::new(false),
            total_done: std::sync::atomic::AtomicUsize::new(0),
            total_error: std::sync::atomic::AtomicUsize::new(0),
            is_paused: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub fn update_transfer(&self, app: &AppHandle, file: String, status: String, message: Option<String>, progress: Option<(u64, u64, u64)>) {
        let mut transfers = self.transfers.lock().unwrap();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;

        let mut found = false;
        for t in transfers.iter_mut() {
            if t.file == file {
                // Update total counter if status changes
                if t.status != status {
                    if status == "done" {
                        self.total_done.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    } else if status == "error" {
                        self.total_error.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                }
                t.status = status.clone();
                t.message = message.clone();
                t.time = now;
                if let Some((sent, total, bps)) = progress {
                    t.sent = sent;
                    t.total = total;
                    t.bps = bps;
                }
                found = true;
                break;
            }
        }

        if !found {
            if status == "done" {
                self.total_done.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            } else if status == "error" {
                self.total_error.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            let (sent, total, bps) = progress.unwrap_or((0, 0, 0));
            transfers.insert(0, TransferInfo {
                file,
                status,
                message,
                time: now,
                sent,
                total,
                bps,
            });
        }

        // Cap the history list — the panel shows all via virtual scroll,
        // a reasonable upper bound is sufficient for memory.
        let mut history_count = 0;
        transfers.retain(|t| {
            if t.status == "done" || t.status == "error" {
                history_count += 1;
                history_count <= 5000
            } else {
                true
            }
        });

        drop(transfers);
        self.emit_throttled(app);
    }

    pub fn remove_transfer(&self, app: &AppHandle, file: &str) {
        let mut transfers = self.transfers.lock().unwrap();
        transfers.retain(|t| t.file != file);
        drop(transfers);
        self.emit_throttled(app);
    }

    pub fn emit_throttled(&self, app: &AppHandle) {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let mut last_emit = self.last_emit.lock().unwrap();
        let mut pending_emit = self.pending_emit.lock().unwrap();

        if now - *last_emit >= 300 {
            *last_emit = now;
            *pending_emit = false;
            self.emit_now(app);
        } else if !*pending_emit {
            *pending_emit = true;
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                if let Some(engine) = app_clone.try_state::<Arc<SyncEngine>>() {
                    let manager = &engine.transfers_manager;
                    let mut pending = manager.pending_emit.lock().unwrap();
                    if *pending {
                        *pending = false;
                        let mut last = manager.last_emit.lock().unwrap();
                        *last = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                        manager.emit_now(&app_clone);
                    }
                }
            });
        }
    }

    pub fn emit_now(&self, app: &AppHandle) {
        let transfers = self.transfers.lock().unwrap();

        let mut active = Vec::new();
        let mut queued = Vec::new();
        let mut history = Vec::new();

        for t in transfers.iter() {
            if t.status == "uploading" {
                active.push(t.clone());
            } else if t.status == "queued" {
                queued.push(t.clone());
            } else {
                history.push(t.clone());
            }
        }

        let queued_count = queued.len();

        let payload = TransfersPayload {
            active,
            queued,
            history,
            queued_count,
            total_done: self.total_done.load(std::sync::atomic::Ordering::Relaxed),
            total_error: self.total_error.load(std::sync::atomic::Ordering::Relaxed),
            is_paused: self.is_paused.load(std::sync::atomic::Ordering::Relaxed),
        };

        let _ = app.emit("sync-transfers-changed", payload);
    }
}

#[tauri::command]
pub fn get_transfers(engine: tauri::State<'_, Arc<SyncEngine>>) -> TransfersPayload {
    let transfers = engine.transfers_manager.transfers.lock().unwrap();
    let mut active = Vec::new();
    let mut queued = Vec::new();
    let mut history = Vec::new();

    for t in transfers.iter() {
        if t.status == "uploading" {
            active.push(t.clone());
        } else if t.status == "queued" {
            queued.push(t.clone());
        } else {
            history.push(t.clone());
        }
    }

    let queued_count = queued.len();

    TransfersPayload {
        active,
        queued,
        history,
        queued_count,
        total_done: engine.transfers_manager.total_done.load(std::sync::atomic::Ordering::Relaxed),
        total_error: engine.transfers_manager.total_error.load(std::sync::atomic::Ordering::Relaxed),
        is_paused: engine.transfers_manager.is_paused.load(std::sync::atomic::Ordering::Relaxed),
    }
}

#[tauri::command]
pub fn toggle_sync_pause(
    engine: tauri::State<'_, Arc<SyncEngine>>,
    config: tauri::State<'_, Arc<ConfigStore>>,
    app: AppHandle,
) -> bool {
    let was_paused = engine.is_paused.load(std::sync::atomic::Ordering::SeqCst);
    let new_paused = !was_paused;
    engine.is_paused.store(new_paused, std::sync::atomic::Ordering::SeqCst);
    // Save pause state to settings (so it persists across restarts)
    let mut settings = config.get();
    settings.sync_paused = new_paused;
    let _ = config.save(settings);
    engine.transfers_manager.emit_throttled(&app);
    new_paused
}

/// Removes all queued (not yet uploading) transfers from the queue.
/// Active (currently uploading) transfers finish on their own.
#[tauri::command]
pub fn clear_sync_queue(engine: tauri::State<'_, Arc<SyncEngine>>, app: AppHandle) {
    engine.pending.lock().unwrap().clear();
    save_pending_queue(&app, &[]);
    {
        let mut transfers = engine.transfers_manager.transfers.lock().unwrap();
        transfers.retain(|t| t.status != "queued");
    }
    engine.transfers_manager.emit_throttled(&app);
}

struct InspectorGuard {
    counter: Arc<std::sync::atomic::AtomicUsize>,
}

impl Drop for InspectorGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

pub struct SyncEngine {
    pub tx: mpsc::UnboundedSender<PathBuf>,
    /// File names waiting in the channel (not yet processed).
    pub pending: Mutex<Vec<String>>,
    watcher: Mutex<Option<notify_debouncer_full::Debouncer<notify::RecommendedWatcher, notify_debouncer_full::RecommendedCache>>>,
    pub transfers_manager: Arc<TransfersManager>,
    pub metadata_sync_lock: tokio::sync::Mutex<()>,
    pub active_inspectors: Arc<std::sync::atomic::AtomicUsize>,
    /// Flag to throttle metadata sync during bulk upload.
    /// If true, a sync task is already waiting/running.
    pub sync_metadata_pending: Arc<std::sync::atomic::AtomicBool>,
    /// Pauses the upload queue; shares the same Arc as transfers_manager.is_paused.
    pub is_paused: Arc<std::sync::atomic::AtomicBool>,
}

fn fnv1a(data: &[u8]) -> u64 {
    let mut h: u64 = 14695981039346656037;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    h
}

fn is_image(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()),
        Some(ref e) if e == "png" || e == "jpg" || e == "jpeg" || e == "webp" || e == "avif" || e == "bmp"
    )
}

/// Uploads a file to Drive (if not already uploaded).
/// Ok(true) = actually uploaded, Ok(false) = already existed (no upload performed).
pub async fn upload_and_record(app: &AppHandle, path: &Path) -> Result<bool> {
    let state = app.state::<Arc<SyncState>>();
    let config = app.state::<Arc<ConfigStore>>();
    let drive = app.state::<Arc<DriveClient>>();

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();

    // Clean name to be uploaded to Drive and recorded in uploaded.json.
    // All state/Drive operations use this name; the UI shows the original name.
    let drive_name = crate::drive::sanitize_filename(&file_name);

    let settings = config.get();
    // Per-file duplicate guard: skip if the same file is already uploading/uploaded.
    {
        let mut set = state.uploading.lock().unwrap();
        if set.contains(&drive_name) { return Ok(false); }
        set.insert(drive_name.clone());
    }
    // Search by sanitized name; if not found, search by old (original) name — migration.
    let existing_id = state.get(&drive_name).or_else(|| state.get(&file_name));
    if let Some(id) = existing_id {
        if drive.is_connected() {
            match drive.file_exists(settings.effective_google_client_id(), settings.effective_google_client_secret(), &id).await {
                Ok(true) => {
                    // If recorded under original name, migrate to sanitized name (once).
                    if state.get(&drive_name).is_none() {
                        state.record(drive_name.clone(), id);
                        state.remove(&file_name);
                    }
                    state.uploading.lock().unwrap().remove(&drive_name);
                    return Ok(false);
                }
                Ok(false) => {
                    state.remove(&drive_name);
                    state.remove(&file_name);
                }
                Err(e) => {
                    state.uploading.lock().unwrap().remove(&drive_name);
                    return Err(anyhow::anyhow!("could not verify Drive file: {}", e));
                }
            }
        } else {
            state.uploading.lock().unwrap().remove(&drive_name);
            return Ok(false);
        }
    }
    let engine = app.state::<Arc<SyncEngine>>();
    engine.transfers_manager.update_transfer(app, drive_name.clone(), "uploading".into(), None, None);

    let progress_app = app.clone();
    let progress_dn = drive_name.clone();
    let on_progress = move |sent: u64, total: u64, bps: u64| {
        if let Some(engine) = progress_app.try_state::<Arc<SyncEngine>>() {
            engine.transfers_manager.update_transfer(
                &progress_app,
                progress_dn.clone(),
                "uploading".into(),
                None,
                Some((sent, total, bps)),
            );
        }
    };

    let mut result = drive
        .upload_file_with_progress(
            settings.effective_google_client_id(),
            settings.effective_google_client_secret(),
            &settings.drive_folder_name,
            path,
            &drive_name,
            on_progress,
        )
        .await;

    // If the response was lost (timeout, 5xx) Drive may have created the file anyway.
    // A blind retry would create a second copy with the same name — verify by name first.
    if result.is_err() {
        if let Ok(Some(existing_id)) = drive
            .find_file_by_name(
                settings.effective_google_client_id(),
                settings.effective_google_client_secret(),
                &settings.drive_folder_name,
                &drive_name,
            )
            .await
        {
            log::info!("file found in Drive after upload error, adopting record: {drive_name}");
            result = Ok(existing_id);
        }
    }

    // IMPORTANT: stay in `uploading` set until record is written —
    // early exit would allow a second task to pass the guards and upload a duplicate.
    match result {
        Ok(id) => {
            let state_clone = Arc::clone(&*state);
            let dn_clone = drive_name.clone();
            let id_for_event = id.clone();
            tokio::task::spawn_blocking(move || state_clone.record(dn_clone, id)).await
                .unwrap_or_else(|e| log::warn!("record spawn_blocking error: {e}"));
            state.uploading.lock().unwrap().remove(&drive_name);
            // Clear library cache so any subsequent list_library reflects the new drive_id.
            app.state::<LibraryCache>().clear();
            // Emit targeted event so the gallery card updates without a full reload.
            let _ = app.emit("item-synced", serde_json::json!({
                "name": file_name,
                "drive_id": id_for_event,
            }));
            engine.transfers_manager.update_transfer(
                app,
                drive_name,
                "done".into(),
                None,
                None,
            );
            Ok(true)
        }
        Err(e) => {
            state.uploading.lock().unwrap().remove(&drive_name);
            engine.transfers_manager.update_transfer(
                app,
                drive_name,
                "error".into(),
                Some(e.to_string()),
                None,
            );
            Err(e)
        }
    }
}


/// Enqueues files in bulk (under a single lock to avoid lock contention).
pub fn enqueue_files_batch(app: &AppHandle, paths: Vec<PathBuf>) {
    let config = app.state::<Arc<ConfigStore>>();
    let state  = app.state::<Arc<SyncState>>();
    let engine = app.state::<Arc<SyncEngine>>();

    let cfg = config.get();
    if !cfg.sync_enabled || cfg.sync_mode == SyncMode::Manual { return; }

    let mut pending = engine.pending.lock().unwrap();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let mut transfers = engine.transfers_manager.transfers.lock().unwrap();

    for path in paths {
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let drive_name = crate::drive::sanitize_filename(&name);

        // Files uploaded before sanitization may be recorded under original name — check both.
        if state.get(&drive_name).is_some() || state.get(&name).is_some() { continue; }
        if pending.contains(&drive_name) { continue; }

        pending.push(drive_name.clone());

        let mut found = false;
        for t in transfers.iter_mut() {
            if t.file == drive_name {
                t.status = "queued".into();
                t.message = None;
                t.time = now;
                found = true;
                break;
            }
        }
        if !found {
            // Append to end: queue panel should show real upload order (FIFO)
            transfers.push(TransferInfo {
                file: drive_name,
                status: "queued".into(),
                message: None,
                time: now,
                sent: 0,
                total: 0,
                bps: 0,
            });
        }

        let _ = engine.tx.send(path);
    }

    let mut history_count = 0;
    transfers.retain(|t| {
        if t.status == "done" || t.status == "error" {
            history_count += 1;
            history_count <= 5000
        } else {
            true
        }
    });

    // Persist the updated queue so items survive a restart.
    save_pending_queue(app, &pending);
    drop(transfers);
    drop(pending);
    engine.transfers_manager.emit_throttled(app);
}

fn is_file_ready(path: &Path) -> bool {
    if std::fs::OpenOptions::new().write(true).open(path).is_ok() {
        return true;
    }
    if let Ok(metadata) = std::fs::metadata(path) {
        if metadata.permissions().readonly() {
            return std::fs::File::open(path).is_ok();
        }
    }
    false
}

/// Inspects files in the background, calculates their dates, saves to metadata.json, then enqueues for upload.
pub fn inspect_and_enqueue_background(app: AppHandle, paths: Vec<PathBuf>) {
    tauri::async_runtime::spawn(async move {
        let config = app.state::<Arc<ConfigStore>>();
        let state  = app.state::<Arc<SyncState>>();
        let engine = app.state::<Arc<SyncEngine>>();
        let meta_store = app.state::<Arc<MetaStore>>();

        {
            let cfg = config.get();
            if !cfg.sync_enabled || cfg.sync_mode == SyncMode::Manual { return; }
        }

        engine.active_inspectors.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _inspector_guard = InspectorGuard {
            counter: engine.active_inspectors.clone(),
        };

        // Only trigger early if there are genuinely new (metadata-less) files.
        // Prevents unnecessary refreshes e.g. when the watcher fires again during upload.
        let has_new = paths.iter().any(|p| {
            if !is_image(p) { return false; }
            let name = match p.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => return false,
            };
            meta_store.get(name).and_then(|m| m.created).is_none()
        });
        if has_new {
            let _ = app.emit("library-changed", ());
        }

        let _guard = engine.metadata_sync_lock.lock().await;

        let mut missing_meta_paths = Vec::new();
        let dir = config.get().resolved_screenshots_dir();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() || !is_image(&path) { continue; }
                if !is_file_ready(&path) { continue; }
                let name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                let has_created = meta_store.get(&name).and_then(|m| m.created).is_some();
                if !has_created {
                    missing_meta_paths.push((name, path));
                }
            }
        }

        let total_files = missing_meta_paths.len();
        if total_files > 0 {
            let mut updates = Vec::new();
            let mut last_update_time = std::time::Instant::now();

            for (idx, (name, path)) in missing_meta_paths.iter().enumerate() {
                let current = idx + 1;

                if current == 1 || current == total_files || last_update_time.elapsed() >= Duration::from_millis(150) {
                    engine.transfers_manager.update_transfer(
                        &app,
                        "File Scan".to_string(),
                        "uploading".to_string(),
                        Some(format!("Calculating dates ({} / {})", current, total_files)),
                        Some((current as u64, total_files as u64, 0)),
                    );
                    last_update_time = std::time::Instant::now();
                }

                let ts = if let Some(t) = crate::library::parse_timestamp_from_filename(name) {
                    t
                } else if let Ok(m) = std::fs::metadata(path) {
                    if let Ok(modified) = m.modified() {
                        modified.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64
                    } else {
                        chrono::Utc::now().timestamp()
                    }
                } else {
                    chrono::Utc::now().timestamp()
                };

                let mut meta = meta_store.get(name).unwrap_or_default();
                meta.created = Some(ts);
                updates.push((name.clone(), meta));
            }

            if !updates.is_empty() {
                meta_store.set_batch(updates);
                let _ = app.emit("library-changed", ());
            }
        }

        engine.transfers_manager.remove_transfer(&app, "File Scan");

        // Enqueue only the paths that were passed to this function
        let mut candidates = Vec::new();
        {
            let pending = engine.pending.lock().unwrap();
            for path in paths {
                if !path.is_file() || !is_image(&path) { continue; }
                if !is_file_ready(&path) { continue; }
                let name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                let drive_name = crate::drive::sanitize_filename(&name);
                // Files uploaded before sanitization may be recorded under original name — check both.
                if state.get(&drive_name).is_some() || state.get(&name).is_some() { continue; }
                if pending.contains(&drive_name) { continue; }

                // Sort key: capture date (metadata) → file mtime → now
                let ts = meta_store.get(&name).and_then(|m| m.created)
                    .or_else(|| std::fs::metadata(&path).ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64))
                    .unwrap_or_else(|| chrono::Utc::now().timestamp());
                candidates.push((ts, path));
            }
        }

        // Upload from oldest to newest
        candidates.sort_by_key(|(ts, _)| *ts);
        let sorted_paths: Vec<PathBuf> = candidates.into_iter().map(|(_, p)| p).collect();

        enqueue_files_batch(&app, sorted_paths);
    });
}

/// Scans all images in the folder and enqueues them for inspection in the background.
pub fn scan_and_enqueue(app: &AppHandle) {
    let config = app.state::<Arc<ConfigStore>>();
    let settings = config.get();
    let dir = settings.resolved_screenshots_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else { return; };
    let mut paths = Vec::new();
    for entry in entries.flatten() {
        paths.push(entry.path());
    }
    inspect_and_enqueue_background(app.clone(), paths);

    if settings.sync_enabled && settings.sync_mode == SyncMode::Full {
        let app2 = app.clone();
        tauri::async_runtime::spawn(auto_download_drive_files(app2));
    }
}

async fn auto_download_drive_files(app: AppHandle) {
    let config = app.state::<Arc<ConfigStore>>();
    let drive  = app.state::<Arc<DriveClient>>();
    let state  = app.state::<Arc<SyncState>>();

    if !drive.is_connected() { return; }

    let settings = config.get();
    let cid  = settings.effective_google_client_id().to_string();
    let csec = settings.effective_google_client_secret().to_string();
    let dir  = settings.resolved_screenshots_dir();
    let folder = settings.drive_folder_name.clone();

    let (files, _) = match drive.list_files(&cid, &csec, &folder, |_, _| {}).await {
        Ok(f) => f,
        Err(e) => { log::warn!("Full sync list error: {e}"); return; }
    };

    let _ = std::fs::create_dir_all(&dir);

    for f in files {
        let local_path = dir.join(&f.name);
        if local_path.exists() { continue; }
        // Previously uploaded (recorded in state) but missing locally — download
        if state.get(&f.name).is_none() && state.get(&crate::drive::sanitize_filename(&f.name)).is_none() {
            // Came from Drive, not yet local → download
        }
        // In any case, present in Drive but missing locally → download
        match drive.download_file(&cid, &csec, &f.id).await {
            Ok(bytes) => {
                if let Err(e) = std::fs::write(&local_path, &bytes) {
                    log::warn!("Full sync download write error {}: {e}", f.name);
                } else {
                    log::info!("Full sync downloaded: {}", f.name);
                    state.record(f.name.clone(), f.id.clone());
                }
            }
            Err(e) => log::warn!("Full sync download error {}: {e}", f.name),
        }
    }
}

/// Starts the background task that processes the upload queue + the folder watcher.
pub fn start(app: &AppHandle) {
    let (tx, mut rx) = mpsc::unbounded_channel::<PathBuf>();
    let transfers_manager = Arc::new(TransfersManager::new());
    let is_paused = transfers_manager.is_paused.clone();
    // Load saved pause state
    let saved_paused = app.state::<Arc<ConfigStore>>().get().sync_paused;
    if saved_paused {
        is_paused.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    let engine = Arc::new(SyncEngine {
        tx,
        pending: Mutex::new(Vec::new()),
        watcher: Mutex::new(None),
        transfers_manager,
        metadata_sync_lock: tokio::sync::Mutex::new(()),
        active_inspectors: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        sync_metadata_pending: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        is_paused,
    });
    app.manage(engine.clone());

    let worker_app = app.clone();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(10)); // 10 concurrent, auto-throttled with 429 retry
    tauri::async_runtime::spawn(async move {
        while let Some(path) = rx.recv().await {
            let worker_app = worker_app.clone();
            let sem_clone = semaphore.clone();
            tauri::async_runtime::spawn(async move {
                // Wait if date calculation is running or queue is paused
                if let Some(engine) = worker_app.try_state::<Arc<SyncEngine>>() {
                    while engine.active_inspectors.load(std::sync::atomic::Ordering::SeqCst) > 0 {
                        tokio::time::sleep(Duration::from_millis(150)).await;
                    }
                    while engine.is_paused.load(std::sync::atomic::Ordering::SeqCst) {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                }

                let _permit = sem_clone.acquire_owned().await.unwrap();

                // Re-check pause after acquiring semaphore —
                // pause may have started while waiting in the semaphore queue.
                if let Some(engine) = worker_app.try_state::<Arc<SyncEngine>>() {
                    while engine.is_paused.load(std::sync::atomic::Ordering::SeqCst) {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                }

                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
                let drive_name = crate::drive::sanitize_filename(&name);

                // Remove from the pending waiting list (pending and transfers were recorded with drive_name)
                if let Some(engine) = worker_app.try_state::<Arc<SyncEngine>>() {
                    let updated = {
                        let mut p = engine.pending.lock().unwrap();
                        p.retain(|n| n != &drive_name);
                        p.clone()
                    };
                    save_pending_queue(&worker_app, &updated);
                }

                let config = worker_app.state::<Arc<ConfigStore>>();
                let drive  = worker_app.state::<Arc<DriveClient>>();
                let settings = config.get();
                if !settings.sync_enabled || !drive.is_connected() {
                    // Sync disabled or not connected — remove transfer from queue
                    if let Some(engine) = worker_app.try_state::<Arc<SyncEngine>>() {
                        engine.transfers_manager.remove_transfer(&worker_app, &drive_name);
                    }
                    return;
                }
                if !path.exists() {
                    if let Some(engine) = worker_app.try_state::<Arc<SyncEngine>>() {
                        engine.transfers_manager.remove_transfer(&worker_app, &drive_name);
                    }
                    return;
                }

                for attempt in 0..3 {
                    match upload_and_record(&worker_app, &path).await {
                        Ok(true) => {
                            // Prevent thousands of sync tasks during bulk upload:
                            // If a task is already pending, don't spawn a new one; otherwise run once after 5 s.
                            if let Some(engine) = worker_app.try_state::<Arc<SyncEngine>>() {
                                let was_pending = engine.sync_metadata_pending
                                    .swap(true, std::sync::atomic::Ordering::SeqCst);
                                if !was_pending {
                                    let sync_app = worker_app.clone();
                                    let flag = engine.sync_metadata_pending.clone();
                                    tauri::async_runtime::spawn(async move {
                                        tokio::time::sleep(Duration::from_secs(5)).await;
                                        flag.store(false, std::sync::atomic::Ordering::SeqCst);
                                        if let Err(e) = sync_metadata_and_icons(&sync_app).await {
                                            log::warn!("Metadata and icon sync error: {e}");
                                        }
                                    });
                                }
                            }
                            break;
                        }
                        Ok(false) => {
                            // Already uploaded — clear transfer from queue (don't leave "queued" in UI)
                            if let Some(engine) = worker_app.try_state::<Arc<SyncEngine>>() {
                                engine.transfers_manager.remove_transfer(&worker_app, &drive_name);
                            }
                            break;
                        }
                        Err(e) => {
                            log::warn!("upload error ({}): {e}", path.display());
                            if attempt < 2 {
                                tokio::time::sleep(Duration::from_secs(5 * (attempt + 1) as u64)).await;
                            }
                        }
                    }
                }
            });
        }
    });

    restart_watcher(app);

    // Restore items that were waiting in the queue when the app last closed.
    // Reconstruct file paths from the screenshots folder; items already in uploaded.json
    // are silently skipped by inspect_and_enqueue_background.
    {
        let saved = load_pending_queue(app);
        if !saved.is_empty() {
            let dir = app.state::<Arc<ConfigStore>>().get().resolved_screenshots_dir();
            let paths: Vec<PathBuf> = saved.into_iter()
                .map(|name| dir.join(&name))
                .filter(|p| p.exists())
                .collect();
            if !paths.is_empty() {
                log::info!("Restoring {} pending upload(s) from disk queue", paths.len());
                inspect_and_enqueue_background(app.clone(), paths);
            }
        }
    }

    scan_and_enqueue(app);

    // Drain any Drive ops that were queued while offline in a previous session.
    let drain_app = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::library::drain_offline_ops(&drain_app).await;
    });

    // Start metadata/icon sync on app startup
    let sync_app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sync_metadata_and_icons(&sync_app).await {
            log::warn!("Metadata and icon sync error: {e}");
        }
    });
}

/// Restarts the folder watcher — called when the folder setting changes.
pub fn restart_watcher(app: &AppHandle) {
    let config = app.state::<Arc<ConfigStore>>();
    let engine = app.state::<Arc<SyncEngine>>();
    let dir = config.get().resolved_screenshots_dir();
    let _ = std::fs::create_dir_all(&dir);

    let watcher_app = app.clone();
    let debouncer = new_debouncer(
        Duration::from_secs(5),
        None,
        move |result: DebounceEventResult| {
            if let Ok(events) = result {
                let mut paths = Vec::new();
                for event in events.iter() {
                    let DebouncedEvent { event, .. } = event;
                    if !(event.kind.is_create() || event.kind.is_modify()) {
                        continue;
                    }
                    for path in &event.paths {
                        paths.push(path.clone());
                    }
                }
                if !paths.is_empty() {
                    inspect_and_enqueue_background(watcher_app.clone(), paths);
                }
            }
        },
    );
    match debouncer {
        Ok(mut d) => {
            if let Err(e) = d.watch(&dir, RecursiveMode::NonRecursive) {
                log::warn!("cannot watch folder ({}): {e}", dir.display());
            }
            *engine.watcher.lock().unwrap() = Some(d);
        }
        Err(e) => log::warn!("failed to start watcher: {e}"),
    }
}

/// Syncs metadata.json and app icons with Google Drive.
/// Does not emit a UI event if there are no real changes.
pub async fn sync_metadata_and_icons(app: &AppHandle) -> Result<()> {
    let config = app.state::<Arc<ConfigStore>>();
    let drive = app.state::<Arc<DriveClient>>();
    let meta = app.state::<Arc<crate::meta::MetaStore>>();
    let icon_cache = app.state::<Arc<crate::icon_cache::IconCache>>();
    let sync = app.state::<Arc<SyncState>>();

    let engine = app.state::<Arc<SyncEngine>>();
    let _guard = engine.metadata_sync_lock.lock().await;

    if !drive.is_connected() {
        return Ok(());
    }
    let settings = config.get();
    if !settings.sync_enabled {
        return Ok(());
    }

    let client_id = settings.effective_google_client_id().to_string();
    let client_secret = settings.effective_google_client_secret().to_string();
    let folder_name = settings.drive_folder_name.clone();

    let main_folder_id = drive.ensure_folder(&client_id, &client_secret, &folder_name).await?;
    let data_folder_id = drive.ensure_subfolder(&client_id, &client_secret, &main_folder_id, "data").await?;

    let mut metadata_changed = false;

    // metadata.json
    {
        let drive_metadata_id = drive
            .find_item_in_folder(&client_id, &client_secret, &data_folder_id, "metadata.json")
            .await
            .unwrap_or(None);

        // Active file set (local + Drive)
        let mut active_files: HashSet<String> = HashSet::new();
        let local_dir = settings.resolved_screenshots_dir();
        if let Ok(entries) = std::fs::read_dir(&local_dir) {
            for entry in entries.flatten() {
                if entry.path().is_file() && is_image(&entry.path()) {
                    if let Some(name) = entry.path().file_name().and_then(|n| n.to_str()) {
                        active_files.insert(name.to_string());
                    }
                }
            }
        }
        if let Ok(drive_files) = drive.list_files_in_folder(&client_id, &client_secret, &main_folder_id).await {
            for f in drive_files {
                let is_img_mime = f.mime_type.as_deref().map(|m| m.starts_with("image/")).unwrap_or(false);
                let is_img_ext = is_image(std::path::Path::new(&f.name));
                if is_img_mime || is_img_ext {
                    active_files.insert(f.name);
                }
            }
        }

        let mut local_metadata = meta.get_all();

        // If metadata exists in Drive, download and merge with local
        if let Some(ref file_id) = drive_metadata_id {
            if let Ok(drive_bytes) = drive.download_file(&client_id, &client_secret, file_id).await {
                if let Ok(drive_metadata) = serde_json::from_slice::<HashMap<String, crate::meta::ScreenshotMeta>>(&drive_bytes) {
                    for (k, v) in drive_metadata {
                        // If a date can be parsed from the filename, it is always authoritative;
                        // Drive's incorrectly derived mtime-based date must not override it.
                        let filename_ts = crate::library::parse_timestamp_from_filename(&k);
                        local_metadata
                            .entry(k)
                            .and_modify(|local| {
                                if let Some(ts) = filename_ts {
                                    local.created = Some(ts);
                                    if local.title.is_none() { local.title = v.title.clone(); }
                                    if local.app.is_none()   { local.app   = v.app.clone(); }
                                } else if local.created.unwrap_or(0) < v.created.unwrap_or(0) {
                                    *local = v.clone();
                                } else {
                                    if local.title.is_none() { local.title = v.title.clone(); }
                                    if local.app.is_none()   { local.app   = v.app.clone(); }
                                }
                            })
                            .or_insert_with(|| {
                                let mut meta = v;
                                if let Some(ts) = filename_ts {
                                    meta.created = Some(ts);
                                }
                                meta
                            });
                    }
                }
            }
        }

        let prev_len = meta.get_all().len();
        local_metadata.retain(|k, _| active_files.contains(k));
        if drive_metadata_id.is_some() || local_metadata.len() != prev_len {
            metadata_changed = true;
        }
        meta.overwrite(local_metadata.clone());

        // Compute content to upload and check hash
        if let Ok(merged_bytes) = serde_json::to_vec_pretty(&local_metadata) {
            let new_hash = fnv1a(&merged_bytes);
            let needs_upload = drive_metadata_id.is_none() || sync.load_metadata_hash() != Some(new_hash);

            if needs_upload {
                let engine = app.state::<Arc<SyncEngine>>();
                engine.transfers_manager.update_transfer(app, "metadata.json".into(), "uploading".into(), None, None);
                let result = match drive_metadata_id {
                    Some(ref fid) => drive.update_bytes(&client_id, &client_secret, fid, merged_bytes).await.map(|_| ()),
                    None => drive.upload_bytes(&client_id, &client_secret, &data_folder_id, "metadata.json", "application/json", merged_bytes).await.map(|_| ()),
                };
                match result {
                    Ok(_) => {
                        sync.save_metadata_hash(new_hash);
                        // System transfer — don't count in total_done, remove silently.
                        engine.transfers_manager.remove_transfer(app, "metadata.json");
                    }
                    Err(e) => {
                        engine.transfers_manager.update_transfer(app, "metadata.json".into(), "error".into(), Some(e.to_string()), None);
                    }
                }
            }
        }
    }

    // Icon cache
    {
        let Ok(icon_cache_folder_id) = drive
            .ensure_subfolder(&client_id, &client_secret, &data_folder_id, "icon_cache")
            .await else { return Ok(()); };

        let drive_files = drive
            .list_files_in_folder(&client_id, &client_secret, &icon_cache_folder_id)
            .await
            .unwrap_or_default();

        let drive_icons: HashSet<String> = drive_files.iter()
            .filter(|f| f.name.ends_with(".png"))
            .map(|f| f.name.clone())
            .collect();

        let icon_dir = icon_cache.dir.clone();
        let local_icons: Vec<String> = std::fs::read_dir(&icon_dir)
            .map(|rd| rd.flatten()
                .filter(|e| e.path().is_file() && e.path().extension().and_then(|x| x.to_str()) == Some("png"))
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect())
            .unwrap_or_default();

        // Upload only what is missing from Drive
        let to_upload: Vec<&String> = local_icons.iter().filter(|n| !drive_icons.contains(*n)).collect();
        if !to_upload.is_empty() {
            let engine = app.state::<Arc<SyncEngine>>();
            engine.transfers_manager.update_transfer(app, "App icons".into(), "uploading".into(), None, None);
            let mut any_err = false;
            for icon_name in &to_upload {
                let path = icon_dir.join(icon_name);
                if let Ok(bytes) = std::fs::read(&path) {
                    if drive.upload_bytes(&client_id, &client_secret, &icon_cache_folder_id, icon_name, "image/png", bytes).await.is_err() {
                        any_err = true;
                    }
                }
            }
            if any_err {
                engine.transfers_manager.update_transfer(app, "App icons".into(), "error".into(), None, None);
            } else {
                // System transfer — don't count in total_done, remove silently.
                engine.transfers_manager.remove_transfer(app, "App icons");
            }
        }

        // Download files present in Drive but missing locally (silently)
        let mut icons_downloaded = false;
        for f in drive_files.iter().filter(|f| f.name.ends_with(".png")) {
            let dest_path = icon_dir.join(&f.name);
            if !dest_path.exists() {
                if let Ok(bytes) = drive.download_file(&client_id, &client_secret, &f.id).await {
                    let _ = std::fs::write(&dest_path, bytes);
                    icons_downloaded = true;
                }
            }
        }
        if icons_downloaded {
            let _ = app.emit("library-changed", ());
        }
    }

    // Only emit library-changed and clear cache if something actually changed.
    // Unconditional emit was triggering a second Drive scan on first launch.
    if metadata_changed {
        app.state::<LibraryCache>().clear();
        let _ = app.emit("library-changed", ());
    }
    Ok(())
}

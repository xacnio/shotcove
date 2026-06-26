mod api;
mod auth;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use zeroize::{Zeroize, ZeroizeOnDrop};

pub(super) const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub(super) const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub(super) const API: &str = "https://www.googleapis.com/drive/v3";
pub(super) const UPLOAD_API: &str = "https://www.googleapis.com/upload/drive/v3";

// ---------------------------------------------------------------------------
// Token structs
// ---------------------------------------------------------------------------

/// Full in-memory token set. ZeroizeOnDrop ensures sensitive strings are wiped
/// from the heap when this value is dropped (None assignment, scope exit, etc.).
#[derive(Debug, Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub account_email: Option<String>,
    #[serde(default)]
    pub account_name: Option<String>,
    /// Not encrypted separately — stored in photo_cache file (not sensitive).
    #[serde(default)]
    pub account_photo: Option<String>,
}

// ---------------------------------------------------------------------------
// Secure token store.
// Windows  → Windows Credential Manager (CredWriteW / CredReadW / CredDeleteW)
//             Entry appears in Control Panel → Credential Manager → Windows Credentials.
// Other OS → macOS Keychain / Linux+BSD Secret Service, via the `keyring` crate.
//             Falls back to a plain local file only if no such store is reachable.
// ---------------------------------------------------------------------------

pub(super) fn token_store_write(data: &[u8], fallback_path: &std::path::Path) -> anyhow::Result<()> {
    platform::write(data, fallback_path)
}

pub(super) fn token_store_read(fallback_path: &std::path::Path) -> anyhow::Result<Vec<u8>> {
    platform::read(fallback_path)
}

pub(super) fn token_store_delete(fallback_path: &std::path::Path) {
    platform::delete(fallback_path);
}

// Windows: Windows Credential Manager

#[cfg(target_os = "windows")]
mod platform {
    use anyhow::Result;
    use std::path::Path;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW,
        CREDENTIALW, CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    // Name visible in Control Panel → Credential Manager → Windows Credentials.
    const TARGET: &str = "Shotcove/google-tokens";
    const USERNAME: &str = "google-tokens";

    // Max blob for CRED_TYPE_GENERIC: 5 * 512 = 2560 bytes.
    const CRED_MAX_BLOB: usize = 2560;

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn write(data: &[u8], _fallback_path: &Path) -> Result<()> {
        if data.len() > CRED_MAX_BLOB {
            anyhow::bail!(
                "token data too large for Credential Manager ({} bytes, max {})",
                data.len(),
                CRED_MAX_BLOB
            );
        }
        let target = to_wide(TARGET);
        let username = to_wide(USERNAME);
        unsafe {
            let cred = CREDENTIALW {
                Flags: CRED_FLAGS(0),
                Type: CRED_TYPE_GENERIC,
                TargetName: PWSTR(target.as_ptr() as *mut u16),
                Comment: PWSTR::null(),
                CredentialBlobSize: data.len() as u32,
                CredentialBlob: data.as_ptr() as *mut u8,
                Persist: CRED_PERSIST_LOCAL_MACHINE,
                AttributeCount: 0,
                Attributes: std::ptr::null_mut(),
                TargetAlias: PWSTR::null(),
                UserName: PWSTR(username.as_ptr() as *mut u16),
                ..Default::default()
            };
            CredWriteW(&cred, 0)
                .map_err(|e| anyhow::anyhow!("CredWriteW failed: {e}"))?;
        }
        Ok(())
    }

    pub fn read(_fallback_path: &Path) -> Result<Vec<u8>> {
        let target = to_wide(TARGET);
        unsafe {
            let mut pcred: *mut CREDENTIALW = std::ptr::null_mut();
            CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, 0, &mut pcred)
                .map_err(|e| anyhow::anyhow!("CredReadW failed: {e}"))?;
            let cred = &*pcred;
            let data = std::slice::from_raw_parts(
                cred.CredentialBlob,
                cred.CredentialBlobSize as usize,
            )
            .to_vec();
            CredFree(pcred as *const core::ffi::c_void);
            Ok(data)
        }
    }

    pub fn delete(_fallback_path: &Path) {
        let target = to_wide(TARGET);
        unsafe {
            let _ = CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, 0);
        }
    }
}

// Non-Windows: OS credential store via the `keyring` crate (see header comment above).

#[cfg(not(target_os = "windows"))]
mod platform {
    use anyhow::Result;
    use keyring::Entry;
    use std::path::Path;

    const SERVICE: &str = "Shotcove";
    const USERNAME: &str = "google-tokens";

    fn entry() -> keyring::Result<Entry> {
        Entry::new(SERVICE, USERNAME)
    }

    pub fn write(data: &[u8], fallback_path: &Path) -> Result<()> {
        match entry().and_then(|e| e.set_secret(data)) {
            Ok(()) => Ok(()),
            Err(e) => {
                log::warn!("no OS credential store available ({e}); storing tokens in a local file instead");
                write_fallback(data, fallback_path)
            }
        }
    }

    pub fn read(fallback_path: &Path) -> Result<Vec<u8>> {
        match entry().and_then(|e| e.get_secret()) {
            Ok(data) => Ok(data),
            Err(keyring::Error::NoEntry) => read_fallback(fallback_path),
            Err(e) => {
                log::warn!("no OS credential store available ({e}); reading tokens from a local file instead");
                read_fallback(fallback_path)
            }
        }
    }

    pub fn delete(fallback_path: &Path) {
        if let Ok(e) = entry() {
            let _ = e.delete_credential();
        }
        let _ = std::fs::remove_file(fallback_path);
    }

    fn write_fallback(data: &[u8], path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, data)?;
        Ok(())
    }

    fn read_fallback(path: &Path) -> Result<Vec<u8>> {
        Ok(std::fs::read(path)?)
    }
}

// ---------------------------------------------------------------------------
// Other types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(super) struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdTime")]
    pub created_time: Option<String>,
    #[serde(rename = "webViewLink")]
    pub web_view_link: Option<String>,
    pub size: Option<String>,
    #[serde(rename = "mimeType")]
    pub mime_type: Option<String>,
}

/// Makes a filename compatible with all platforms.
pub fn sanitize_filename(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        match ch {
            '\\' | '/' | ':' | '*' | '?' | '<' | '>' | '|' => out.push('_'),
            '"' => out.push('_'),
            c if (c as u32) < 32 || c as u32 == 127 => out.push('_'),
            '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}' | '\u{00AD}' => {}
            '\u{2018}' | '\u{2019}' => out.push('\''),
            '\u{201C}' | '\u{201D}' => out.push('"'),
            c => out.push(c),
        }
    }
    let trimmed = out.trim_end_matches(|c: char| c == '.' || c == ' ');
    let trimmed = trimmed.trim_start_matches(' ');
    if trimmed.is_empty() { "file".to_string() } else { trimmed.to_string() }
}

// ---------------------------------------------------------------------------
// DriveClient
// ---------------------------------------------------------------------------

pub struct DriveClient {
    pub(super) http: reqwest::Client,
    /// Fallback token file path (used on non-Windows only; ignored on Windows).
    pub(super) tokens_file_path: PathBuf,
    /// Profile photo — large base64 blob, not sensitive, stored plain.
    pub(super) photo_cache_path: PathBuf,
    /// Disk cache for Drive file list (cache/drive_list.json).
    pub(super) drive_list_cache_path: PathBuf,
    pub(super) tokens: Mutex<Option<Tokens>>,
    pub(super) folder_id: Mutex<Option<String>>,
    pub(super) folder_init_lock: tokio::sync::Mutex<()>,
    pub(super) cached_files: Mutex<Option<(Vec<DriveFile>, std::time::Instant)>>,
    /// Set while an OAuth `authorize()` call is waiting for the browser
    /// redirect; lets `cancel_authorize` interrupt it early.
    pub(super) auth_cancel: Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
}

impl DriveClient {
    pub fn new(config_dir: PathBuf) -> Self {
        let tokens_file_path      = config_dir.join("tokens.dat");
        let photo_cache_path      = config_dir.join("profile_photo.cache");
        let drive_list_cache_path = config_dir.join("cache").join("drive_list.json");

        let tokens: Option<Tokens> = token_store_read(&tokens_file_path)
            .ok()
            .and_then(|mut bytes| {
                let result = serde_json::from_slice::<Tokens>(&bytes).ok();
                bytes.zeroize();
                result
            })
            .map(|mut t| {
                t.account_photo = std::fs::read_to_string(&photo_cache_path).ok();
                t
            });

        Self {
            http: reqwest::Client::new(),
            tokens_file_path,
            photo_cache_path,
            drive_list_cache_path,
            tokens: Mutex::new(tokens),
            folder_id: Mutex::new(None),
            folder_init_lock: tokio::sync::Mutex::new(()),
            cached_files: Mutex::new(None),
            auth_cancel: Mutex::new(None),
        }
    }

    /// Like `new`, but never reads real saved tokens (Windows' Credential
    /// Manager is machine-wide, not per-`config_dir`). Used by the
    /// store-screenshot automation to avoid surfacing a real account.
    #[cfg(debug_assertions)]
    pub fn new_isolated(config_dir: PathBuf) -> Self {
        Self {
            http: reqwest::Client::new(),
            tokens_file_path: config_dir.join("tokens.dat"),
            photo_cache_path: config_dir.join("profile_photo.cache"),
            drive_list_cache_path: config_dir.join("cache").join("drive_list.json"),
            tokens: Mutex::new(None),
            folder_id: Mutex::new(None),
            folder_init_lock: tokio::sync::Mutex::new(()),
            cached_files: Mutex::new(None),
            auth_cancel: Mutex::new(None),
        }
    }

    /// Interrupts an in-flight `authorize()` call, if any, so the UI doesn't
    /// stay stuck on "waiting for browser approval" when the user closed the
    /// tab without finishing the OAuth flow.
    pub fn cancel_authorize(&self) {
        if let Some(flag) = self.auth_cancel.lock().unwrap().as_ref() {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }

    pub fn is_connected(&self) -> bool {
        self.tokens.lock().unwrap().is_some()
    }

    pub fn account_email(&self) -> Option<String> {
        self.tokens.lock().unwrap().as_ref().and_then(|t| t.account_email.clone())
    }

    pub fn account_name(&self) -> Option<String> {
        self.tokens.lock().unwrap().as_ref().and_then(|t| t.account_name.clone())
    }

    pub fn account_photo(&self) -> Option<String> {
        self.tokens.lock().unwrap().as_ref().and_then(|t| t.account_photo.clone())
    }

    pub fn disconnect(&self) {
        *self.tokens.lock().unwrap() = None; // ZeroizeOnDrop fires here
        *self.folder_id.lock().unwrap() = None;
        token_store_delete(&self.tokens_file_path);
        let _ = std::fs::remove_file(&self.photo_cache_path);
        let _ = std::fs::remove_file(&self.drive_list_cache_path);
        self.clear_cache();
    }

    pub fn clear_cache(&self) {
        *self.cached_files.lock().unwrap() = None;
    }

    pub fn clear_folder_id(&self) {
        *self.folder_id.lock().unwrap() = None;
    }
}

pub(super) fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

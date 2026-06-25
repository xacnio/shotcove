use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// Shortcut system
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutCapture {
    #[default]
    Area,
    Window,
    Fullscreen,
    FullscreenCurrent, // capture only the monitor under the cursor
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutAction {
    OpenEditor,
    Save,
    CopyImage,
    DirectLink,
    DriveLink,
}

fn default_true() -> bool { true }
fn default_printscreen_actions() -> Vec<ShortcutAction> { vec![ShortcutAction::OpenEditor] }

/// Background/padding template applied when a shortcut saves directly
/// (no editor) and the relevant "*_padding" toggle is on. `None` on a slot
/// means "use the app-wide default" (see `BgTemplate::default()`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BgTemplate {
    #[serde(default = "default_bg_type")]
    pub bg_type: String, // "solid" | "gradient"
    #[serde(default = "default_color1")]
    pub color1: String,
    #[serde(default = "default_color2")]
    pub color2: String,
    #[serde(default = "default_angle")]
    pub angle: f32,
    #[serde(default = "default_padding")]
    pub padding: u32,
    #[serde(default)]
    pub border_radius: u32,
    #[serde(default = "default_true")]
    pub shadow: bool,
}

fn default_bg_type() -> String { "gradient".into() }
fn default_color1() -> String { "#14141e".into() }
fn default_color2() -> String { "#282840".into() }
fn default_angle() -> f32 { 135.0 }
fn default_padding() -> u32 { 60 }

impl Default for BgTemplate {
    fn default() -> Self {
        Self {
            bg_type: default_bg_type(),
            color1: default_color1(),
            color2: default_color2(),
            angle: default_angle(),
            padding: default_padding(),
            border_radius: 0,
            shadow: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortcutSlot {
    pub id: String,
    pub combo: String,
    pub capture: ShortcutCapture,
    /// Ordered action list; see ShortcutAction for valid combinations.
    pub actions: Vec<ShortcutAction>,
    pub show_in_menu: bool,
    pub label: String,
    /// When true, overlays span all monitors; when false, only the monitor under the cursor.
    #[serde(default = "default_true")]
    pub multi_monitor: bool,
    /// Per-shortcut background override; `None` uses the app-wide default.
    #[serde(default)]
    pub bg_template: Option<BgTemplate>,
    /// Icon shown for this shortcut in the gallery sidebar's Capture
    /// section; `None` falls back to one matching the capture type.
    #[serde(default)]
    pub icon: Option<String>,
}

pub fn default_shortcuts() -> Vec<ShortcutSlot> {
    let combo = |n: u8| format!("Ctrl+Shift+{n}");
    vec![
        ShortcutSlot {
            id: "area_editor".into(),
            combo: combo(1),
            capture: ShortcutCapture::Area,
            actions: vec![ShortcutAction::OpenEditor],
            show_in_menu: true,
            label: String::new(),
            multi_monitor: true,
            bg_template: None,
            icon: None,
        },
        ShortcutSlot {
            id: "area_link".into(),
            combo: combo(2),
            capture: ShortcutCapture::Area,
            actions: vec![ShortcutAction::Save, ShortcutAction::DirectLink],
            show_in_menu: true,
            label: String::new(),
            multi_monitor: true,
            bg_template: None,
            // Same capture type as area_editor (#1) — give it its own icon
            // (matches its Direct Link action) so the two aren't identical.
            icon: Some("link".into()),
        },
        ShortcutSlot {
            id: "fullscreen_editor".into(),
            combo: combo(3),
            capture: ShortcutCapture::Fullscreen,
            actions: vec![ShortcutAction::OpenEditor],
            show_in_menu: true,
            label: String::new(),
            multi_monitor: true,
            bg_template: None,
            icon: None,
        },
        ShortcutSlot {
            id: "window_editor".into(),
            combo: combo(4),
            capture: ShortcutCapture::Window,
            actions: vec![ShortcutAction::OpenEditor],
            show_in_menu: true,
            label: String::new(),
            multi_monitor: true,
            bg_template: None,
            icon: None,
        },
    ]
}

// ---------------------------------------------------------------------------
// Image format
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ImageFormat {
    Png,
    Jpg,
    Webp,
    Avif,
    Bmp,
}

impl ImageFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpg => "jpg",
            ImageFormat::Webp => "webp",
            ImageFormat::Avif => "avif",
            ImageFormat::Bmp => "bmp",
        }
    }
}


#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SyncMode {
    Full,
    #[default]
    LocalFirst,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CustomMethod {
    Get,
    Post,
    Put,
    Patch,
}

impl Default for CustomMethod {
    fn default() -> Self { Self::Post }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CustomBodyType {
    /// multipart/form-data — file sent as a form part
    Multipart,
    /// application/x-www-form-urlencoded — file as base64 in a form field
    FormData,
    /// application/json — file as base64 string in a JSON field
    Json,
    /// Raw binary body (Content-Type set to image/*)
    Binary,
}

impl Default for CustomBodyType {
    fn default() -> Self { Self::Multipart }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CustomResponseType {
    /// Response body is the URL (plain text)
    PlainText,
    /// Extract URL from JSON using dot/bracket path (e.g. "data.url" or "files[0].url")
    JsonPath,
    /// URL is in a response header (e.g. "Location")
    Header,
    /// Extract first capture group from a regex applied to the response body
    Regex,
}

impl Default for CustomResponseType {
    fn default() -> Self { Self::JsonPath }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CustomProvider {
    /// Unique slug used as provider id (e.g. "custom_0")
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub method: CustomMethod,
    pub url: String,
    /// Extra headers as "Key: Value" lines
    pub headers: String,
    pub body_type: CustomBodyType,
    /// Form field / JSON key that holds the file (multipart, form_data, json)
    pub file_field: String,
    /// Extra static fields: "key=value" lines (multipart, form_data, json)
    pub extra_fields: String,
    pub response_type: CustomResponseType,
    /// Meaning depends on response_type:
    ///   JsonPath → dot/bracket path e.g. "data.url"
    ///   Header   → header name e.g. "Location"
    ///   Regex    → pattern with one capture group e.g. r#""url":"([^"]+)""#
    ///   PlainText → ignored
    pub response_value: String,
    /// Accepted image formats (extensions without dot). Empty = accept all.
    /// Files in other formats are automatically converted to the first listed format.
    #[serde(default)]
    pub accepted_formats: Vec<String>,
}

impl Default for CustomProvider {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            method: CustomMethod::Post,
            url: String::new(),
            headers: String::new(),
            body_type: CustomBodyType::Multipart,
            file_field: "file".into(),
            extra_fields: String::new(),
            response_type: CustomResponseType::JsonPath,
            response_value: String::new(),
            accepted_formats: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub hotkeys_enabled: bool,
    pub shortcuts: Vec<ShortcutSlot>,
    pub format: ImageFormat,
    /// Local screenshots folder. Falls back to Pictures\Shotcove when empty.
    pub screenshots_dir: String,
    pub autostart: bool,
    pub sync_enabled: bool,
    /// Name of the folder to create in Google Drive
    pub drive_folder_name: String,
    pub google_client_id: String,
    pub google_client_secret: String,
    /// Ordered provider list; enabled providers are tried in order
    pub direct_link_providers: Vec<ProviderConfig>,
    pub imgbb_api_key: String,
    pub freeimage_api_key: String,
    pub catbox_userhash: String,
    #[serde(default)]
    pub custom_providers: Vec<CustomProvider>,
    /// Display + upload order for all providers (built-in and custom IDs).
    #[serde(default)]
    pub provider_order: Vec<String>,
    pub jpeg_quality: u8,
    /// Whether the sync queue is paused (persists across restarts)
    pub sync_paused: bool,
    /// Whether to open the gallery window automatically on startup
    pub start_with_gallery: bool,
    pub sync_mode: SyncMode,
    pub language: String,
    pub run_as_admin: bool,
    pub printscreen_enabled: bool,
    /// PrintScreen's own action list, multi-monitor flag and background
    /// template — configured separately from `shortcuts` since it's a fixed
    /// key (not a rebindable combo), not a regular slot.
    #[serde(default = "default_printscreen_actions")]
    pub printscreen_actions: Vec<ShortcutAction>,
    #[serde(default = "default_true")]
    pub printscreen_multi_monitor: bool,
    #[serde(default)]
    pub printscreen_bg_template: Option<BgTemplate>,
    /// Whether the user has completed the first-run onboarding wizard
    #[serde(default)]
    pub onboarded: bool,
    /// Whether to automatically check for app updates on startup
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// Version string of the Terms/Privacy the user has last accepted (see
    /// `src/lib/legal.js`'s `LEGAL_VERSION`). Mismatch prompts re-acceptance.
    #[serde(default)]
    pub accepted_legal_version: String,
    /// Last app version the user has seen "What's New" for.
    #[serde(default)]
    pub last_seen_version: String,
    /// Update version the user has already been notified about, so the
    /// "update available" modal doesn't reappear on every gallery open.
    #[serde(default)]
    pub last_notified_update_version: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkeys_enabled: true,
            shortcuts: default_shortcuts(),
            format: ImageFormat::Png,
            screenshots_dir: String::new(),
            autostart: false,
            sync_enabled: true,
            drive_folder_name: "Shotcove".into(),
            google_client_id: String::new(),
            google_client_secret: String::new(),
            direct_link_providers: vec![
                ProviderConfig { id: "prntscr".into(),   enabled: true },
                ProviderConfig { id: "imgbb".into(),     enabled: false },
                ProviderConfig { id: "freeimage".into(), enabled: false },
                ProviderConfig { id: "catbox".into(),    enabled: false },
            ],
            imgbb_api_key: String::new(),
            freeimage_api_key: String::new(),
            catbox_userhash: String::new(),
            custom_providers: vec![],
            provider_order: vec![],
            jpeg_quality: 95,
            sync_paused: false,
            start_with_gallery: true,
            sync_mode: SyncMode::LocalFirst,
            language: "en".into(),
            run_as_admin: false,
            printscreen_enabled: true,
            printscreen_actions: default_printscreen_actions(),
            printscreen_multi_monitor: true,
            printscreen_bg_template: None,
            onboarded: false,
            auto_update: true,
            accepted_legal_version: String::new(),
            last_seen_version: String::new(),
            last_notified_update_version: String::new(),
        }
    }
}

// Credentials are XOR-obfuscated at build time by build.rs (read from .env).
// The key and ciphertext live in separate locations in the binary so that a
// simple `strings` scan cannot recover the plaintext.
mod embedded_creds {
    include!(concat!(env!("OUT_DIR"), "/credentials.rs"));
}

fn xor_decrypt(enc: &[u8], key: &[u8]) -> String {
    enc.iter()
        .zip(key.iter().cycle())
        .map(|(b, k)| (b ^ k) as char)
        .collect()
}

/// Returns true when the app was built with embedded OAuth credentials.
/// When false, users must supply their own Google client ID / secret.
pub fn has_builtin_credentials() -> bool {
    !default_client_id().is_empty()
}

fn default_client_id() -> &'static str {
    static V: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    V.get_or_init(|| xor_decrypt(embedded_creds::_ENC_CLIENT_ID, embedded_creds::_CRED_KEY))
}

fn default_client_secret() -> &'static str {
    static V: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    V.get_or_init(|| xor_decrypt(embedded_creds::_ENC_CLIENT_SECRET, embedded_creds::_CRED_KEY))
}

impl Settings {
    pub fn effective_google_client_id(&self) -> &str {
        let id = self.google_client_id.trim();
        if id.is_empty() { default_client_id() } else { id }
    }

    pub fn effective_google_client_secret(&self) -> &str {
        let s = self.google_client_secret.trim();
        if s.is_empty() { default_client_secret() } else { s }
    }

    pub fn resolved_screenshots_dir(&self) -> PathBuf {
        if !self.screenshots_dir.trim().is_empty() {
            return PathBuf::from(self.screenshots_dir.trim());
        }
        let pictures = dirs_pictures().unwrap_or_else(|| PathBuf::from("."));
        pictures.join("Shotcove")
    }
}

fn dirs_pictures() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("Pictures"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(|p| PathBuf::from(p).join("Pictures"))
    }
}

pub struct ConfigStore {
    path: PathBuf,
    pub settings: Mutex<Settings>,
}

/// Reverts the brief Cmd-default experiment back to Ctrl — only touches
/// combos that exactly match that short-lived default, so any shortcut the
/// user customized themselves is left alone.
#[cfg(target_os = "macos")]
fn migrate_legacy_ctrl_shortcuts(settings: &mut Settings) {
    for slot in &mut settings.shortcuts {
        if let Some(n) = slot.combo.strip_prefix("Cmd+Shift+") {
            if n.len() == 1 && n.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                slot.combo = format!("Ctrl+Shift+{n}");
            }
        }
    }
}
#[cfg(not(target_os = "macos"))]
fn migrate_legacy_ctrl_shortcuts(_settings: &mut Settings) {}

/// One-time fixup for configs saved before `area_link`'s default icon was
/// set to "link" — only applies if the user hasn't already picked an icon
/// for it themselves.
fn migrate_area_link_icon(settings: &mut Settings) {
    if let Some(slot) = settings.shortcuts.iter_mut().find(|s| s.id == "area_link") {
        if slot.icon.is_none() {
            slot.icon = Some("link".into());
        }
    }
}

impl ConfigStore {
    pub fn load(config_dir: PathBuf) -> Self {
        let path = config_dir.join("settings.json");
        let mut settings: Settings = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        migrate_legacy_ctrl_shortcuts(&mut settings);
        migrate_area_link_icon(&mut settings);
        Self {
            path,
            settings: Mutex::new(settings),
        }
    }

    pub fn get(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn save(&self, new: Settings) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&new)?;
        std::fs::write(&self.path, json)?;
        *self.settings.lock().unwrap() = new;
        Ok(())
    }
}

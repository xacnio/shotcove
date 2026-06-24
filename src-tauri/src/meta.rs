use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Metadata collected at the moment a screenshot is captured.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScreenshotMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    /// Capture time (Unix seconds)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<i64>,
    /// Tag IDs assigned to this screenshot
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

/// Filename -> metadata map; persisted in `metadata.json`.
pub struct MetaStore {
    path: PathBuf,
    map: Mutex<HashMap<String, ScreenshotMeta>>,
}

impl MetaStore {
    pub fn load(config_dir: PathBuf) -> Self {
        let path = config_dir.join("metadata.json");
        let map = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            map: Mutex::new(map),
        }
    }

    pub fn get(&self, name: &str) -> Option<ScreenshotMeta> {
        self.map.lock().unwrap().get(name).cloned()
    }

    pub fn set(&self, name: String, meta: ScreenshotMeta) {
        let json = {
            let mut map = self.map.lock().unwrap();
            map.insert(name, meta);
            serde_json::to_string_pretty(&*map).unwrap_or_default()
        };
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&self.path, json);
    }

    pub fn set_batch(&self, updates: Vec<(String, ScreenshotMeta)>) {
        let json = {
            let mut map = self.map.lock().unwrap();
            for (name, meta) in updates {
                map.insert(name, meta);
            }
            serde_json::to_string_pretty(&*map).unwrap_or_default()
        };
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&self.path, json);
    }

    pub fn remove(&self, name: &str) {
        let json = {
            let mut map = self.map.lock().unwrap();
            map.remove(name);
            serde_json::to_string_pretty(&*map).unwrap_or_default()
        };
        let _ = std::fs::write(&self.path, json);
    }

    pub fn get_all(&self) -> HashMap<String, ScreenshotMeta> {
        self.map.lock().unwrap().clone()
    }

    pub fn overwrite(&self, new_map: HashMap<String, ScreenshotMeta>) {
        let json = {
            let mut map = self.map.lock().unwrap();
            *map = new_map;
            serde_json::to_string_pretty(&*map).unwrap_or_default()
        };
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&self.path, json);
    }
}

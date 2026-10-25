//! What the app remembers between starts: the server it shows. One small JSON file.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Settings {
    /// The server's origin, as `server::parse` left it.
    pub server: Option<String>,
}

pub fn file(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

/// A missing or broken file is a first start: the app asks for the server again.
pub fn load(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Written to a temporary file and renamed: a crash never leaves half a file.
pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_loads_and_a_broken_file_is_a_first_start() {
        let dir = std::env::temp_dir().join(format!("owni-desktop-test-{}", std::process::id()));
        let path = file(&dir);
        assert_eq!(load(&path), Settings::default());
        let settings = Settings {
            server: Some("https://owni.example.it".into()),
        };
        save(&path, &settings).unwrap();
        assert_eq!(load(&path), settings);
        fs::write(&path, "{not json").unwrap();
        assert_eq!(load(&path), Settings::default());
        fs::remove_dir_all(&dir).unwrap();
    }
}

//! Shared, transport-independent backup engine. Every mutation uses an explicit plan.
pub mod credentials;
mod engine;
pub mod models;
pub mod providers;

pub use engine::Engine;

pub fn default_data_dir() -> std::path::PathBuf {
    if let Some(path) = std::env::var_os("BACKURAU_DATA_DIR") {
        return path.into();
    }
    #[cfg(target_os = "windows")]
    let root = std::env::var_os("APPDATA");
    #[cfg(target_os = "macos")]
    let root = std::env::var_os("HOME")
        .map(|home| std::path::PathBuf::from(home).join("Library/Application Support").into_os_string());
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let root = std::env::var_os("XDG_CONFIG_HOME").or_else(|| {
        std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".config").into_os_string())
    });
    std::path::PathBuf::from(root.unwrap_or_else(|| ".".into())).join("backurau")
}

#[cfg(test)]
mod tests;

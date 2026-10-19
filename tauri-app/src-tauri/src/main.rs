// Prevents an extra console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The desktop adapter: one `api` command over the shared engine (same methods as the web
// service's POST /api/{method}), a native folder picker, and the automation ticker.
use backurau_core::Engine;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn api(engine: State<'_, Engine>, method: String, args: Value) -> Result<Value, String> {
    let engine = engine.inner().clone();
    // Runs can take minutes; a blocking worker keeps activity polling and cancel responsive.
    tauri::async_runtime::spawn_blocking(move || engine.dispatch(&method, args))
        .await
        .map_err(|e| e.to_string())?
}

/// Returns the chosen folder, or null when the dialog is canceled.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let engine = match Engine::new(backurau_core::default_data_dir()) {
                Ok(engine) => engine,
                Err(e) => {
                    app.dialog().message(e).title("Backurau cannot start").show(|_| std::process::exit(1));
                    return Ok(());
                }
            };
            let start_minimized = engine
                .dispatch("get_state", json!({}))
                .ok()
                .and_then(|s| s.pointer("/settings/start_minimized").and_then(Value::as_bool))
                .unwrap_or(false);
            if start_minimized {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.minimize();
                }
            }
            let ticker = engine.clone();
            std::thread::spawn(move || loop {
                if let Err(e) = ticker.tick() {
                    eprintln!("automation: {e}");
                }
                std::thread::sleep(Duration::from_secs(5));
            });
            app.manage(engine);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![api, pick_folder])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

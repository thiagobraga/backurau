// backurau-server: the shared Backurau engine behind an authenticated HTTP API, plus the web UI.
//
//   cargo run --release                      # http://127.0.0.1:8787, UI from ../tauri-app/ui
//   PORT=9000 cargo run --release            # different port
//   BACKURAU_TOKEN=... cargo run --release   # fixed token instead of the generated one
//
// Every /api call needs `Authorization: Bearer <token>`. The token is generated once into
// `<data dir>/service-token` (owner-only) and printed at startup. Binding beyond loopback
// requires BACKURAU_ALLOW_REMOTE=1; put TLS in front (e.g. a reverse proxy) when you do.
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use backurau_core::Engine;
use serde_json::{json, Value};
use std::{net::IpAddr, path::PathBuf, sync::Arc, time::Duration};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
struct App {
    engine: Engine,
    token: Arc<String>,
    origins: Arc<Vec<String>>,
}

fn load_token(engine: &Engine) -> std::io::Result<String> {
    if let Ok(token) = std::env::var("BACKURAU_TOKEN") {
        if token.len() >= 16 {
            return Ok(token);
        }
        eprintln!("BACKURAU_TOKEN is shorter than 16 characters; ignoring it");
    }
    let path = engine.data_dir().join("service-token");
    if let Ok(token) = std::fs::read_to_string(&path) {
        if token.trim().len() >= 16 {
            return Ok(token.trim().to_string());
        }
    }
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    std::io::Write::write_all(&mut options.open(&path)?, token.as_bytes())?;
    Ok(token)
}

/// Constant-time comparison so the token cannot be guessed byte by byte from timing.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

async fn api(State(app): State<App>, Path(method): Path<String>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    // Browsers always send Origin on cross-site POSTs; reject any origin we do not serve.
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) {
        let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or_default();
        let same_host = origin.split_once("://").is_some_and(|(_, rest)| rest == host);
        if !same_host && !app.origins.iter().any(|o| o == origin) {
            return error(StatusCode::FORBIDDEN, "Origin not allowed");
        }
    }
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !same(presented.as_bytes(), app.token.as_bytes()) {
        return error(StatusCode::UNAUTHORIZED, "Missing or invalid access token");
    }
    // Parsed after authentication so unauthenticated callers learn nothing about the body format.
    let args: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => return error(StatusCode::BAD_REQUEST, "Request body must be JSON"),
        }
    };
    if !args.is_object() {
        return error(StatusCode::BAD_REQUEST, "Request body must be a JSON object");
    }
    let engine = app.engine.clone();
    // Runs can take minutes; keep them off the async workers so status calls stay responsive.
    match tokio::task::spawn_blocking(move || engine.dispatch(&method, args)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(message)) if message.starts_with("Unknown method") => error(StatusCode::NOT_FOUND, message),
        Ok(Err(message)) => error(StatusCode::UNPROCESSABLE_ENTITY, message),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8787);
    let bind: IpAddr = std::env::var("BIND").ok().and_then(|b| b.parse().ok()).unwrap_or([127, 0, 0, 1].into());
    if !bind.is_loopback() && std::env::var("BACKURAU_ALLOW_REMOTE").as_deref() != Ok("1") {
        eprintln!("Refusing to listen on {bind}: set BACKURAU_ALLOW_REMOTE=1 to expose the service beyond this computer.");
        std::process::exit(2);
    }
    let ui_dir: PathBuf = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tauri-app/ui"));

    let engine = Engine::new(backurau_core::default_data_dir()).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1)
    });
    let token = load_token(&engine).expect("cannot create the service token");
    let origins = std::env::var("BACKURAU_ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(|o| o.trim().trim_end_matches('/').to_string())
        .filter(|o| !o.is_empty())
        .collect();

    let ticker = engine.clone();
    std::thread::spawn(move || loop {
        if let Err(e) = ticker.tick() {
            eprintln!("automation: {e}");
        }
        std::thread::sleep(Duration::from_secs(5));
    });

    let app = App { engine: engine.clone(), token: Arc::new(token.clone()), origins: Arc::new(origins) };
    let static_files = ServeDir::new(&ui_dir).not_found_service(ServeFile::new(ui_dir.join("index.html")));
    let router = Router::new()
        .route("/health", get(|| async { Json(json!({ "ok": true })) }))
        .route("/api/{method}", post(api))
        .fallback_service(static_files)
        .with_state(app);

    let listener = tokio::net::TcpListener::bind((bind, port)).await.unwrap_or_else(|e| panic!("could not bind {bind}:{port}: {e}"));
    println!("Backurau service  ->  http://{bind}:{port}/   (data {}, UI {})", engine.data_dir().display(), ui_dir.display());
    if std::env::var("BACKURAU_TOKEN").is_err() {
        println!("Access token: {}   (stored in {})", token, engine.data_dir().join("service-token").display());
    }
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server error");
}

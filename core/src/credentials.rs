//! Connection secrets live only in the OS credential store (Secret Service, Keychain,
//! Windows Credential Manager), keyed by connection id. Never in state, logs or exports.
use keyring::{Entry, Error};
use serde_json::{json, Value};

const SERVICE: &str = "dev.backurau.app";

fn entry(id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, id).map_err(|e| format!("Credential store unavailable: {e}"))
}

pub fn set(id: &str, secret: &str) -> Result<(), String> {
    entry(id)?.set_password(secret).map_err(|e| format!("Cannot save credential: {e}"))
}

pub fn get(id: &str) -> Result<Option<String>, String> {
    match entry(id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Cannot read credential: {e}")),
    }
}

pub fn delete(id: &str) -> Result<(), String> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Cannot delete credential: {e}")),
    }
}

/// Probes the store without writing. Headless services often have no Secret Service session.
pub fn status() -> Value {
    match entry("backurau-probe").and_then(|e| match e.get_password() {
        Ok(_) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }) {
        Ok(()) => json!({"store": "os", "available": true, "message": "Using the operating system credential store."}),
        Err(e) => json!({"store": "os", "available": false, "message": e}),
    }
}

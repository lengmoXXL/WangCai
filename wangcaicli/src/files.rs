use anyhow::{Result, bail};
use base64::Engine;
use serde_json::{Value, json};
use std::io::Read;
use std::path::Path;

// Keep the base64 response within the WebSocket message limit.
const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024;

pub async fn read(op: &str, path: &str) -> Result<Value> {
    let op = op.to_owned();
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || -> Result<Value> {
        if !Path::new(&path).is_absolute() {
            bail!("File path must be absolute");
        }
        if op == "stat" {
            return match std::fs::metadata(&path) {
                Ok(metadata) => Ok(json!({"isDirectory": metadata.is_dir()})),
                Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => Ok(Value::Null),
                Err(error) => Err(error.into()),
            };
        }
        if op == "read_directory" {
            let mut entries = Vec::new();
            for entry in std::fs::read_dir(&path)? {
                let entry = entry?;
                entries.push(json!({"name":entry.file_name().to_string_lossy(),"isDirectory":entry.path().is_dir()}));
            }
            return Ok(json!(entries));
        }
        let mut bytes = Vec::new();
        std::fs::File::open(&path)?
            .take(MAX_FILE_SIZE + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_FILE_SIZE {
            bail!("File exceeds 16 MiB");
        }
        Ok(json!({"data":base64::engine::general_purpose::STANDARD.encode(bytes)}))
    })
    .await?
}

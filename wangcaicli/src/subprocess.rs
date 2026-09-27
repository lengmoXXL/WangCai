use anyhow::{Context, Result, bail};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

#[derive(Deserialize)]
struct ExecRequest {
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    #[serde(default)]
    env: HashMap<String, String>,
}

struct ProcessGroup(u32);

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

async fn read_output(reader: impl AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > 8 * 1024 * 1024 {
        bail!("Process output exceeds 8 MiB");
    }
    Ok(bytes)
}

pub async fn exec(request: Value) -> Result<Value> {
    let request: ExecRequest = serde_json::from_value(request)?;
    if !request.cwd.is_absolute() {
        bail!("Process cwd must be absolute");
    }
    let mut child = Command::new(&request.program)
        .args(request.args)
        .current_dir(request.cwd)
        .envs(request.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("Cannot start {}", request.program))?;
    let _group = ProcessGroup(child.id().unwrap());
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (status, stdout, stderr) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::try_join!(
            async { child.wait().await.map_err(anyhow::Error::from) },
            read_output(stdout),
            read_output(stderr),
        )
    })
    .await
    .context("Process timed out")??;
    let code = status.code().context("Process terminated by signal")?;
    Ok(json!({
        "stdout": base64::engine::general_purpose::STANDARD.encode(stdout),
        "stderr": base64::engine::general_purpose::STANDARD.encode(stderr),
        "code": code,
    }))
}

use anyhow::{Context, Result, bail};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap, os::unix::process::ExitStatusExt, path::PathBuf, process::Stdio,
    sync::Arc,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{ChildStdin, Command},
    sync::{Mutex, broadcast},
};

const MAX_WRITE: usize = 64 * 1024;
const READ_CHUNK: usize = 8 * 1024;
// A consumer this far behind has missed part of a byte stream, which cannot be repaired by a reattach.
const BUFFER: usize = 1024;

#[derive(Deserialize)]
struct SpawnRequest {
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    #[serde(default)]
    env: HashMap<String, String>,
}

/// `seq` orders everything one process produced.
#[derive(Clone)]
pub enum Event {
    Stdout { seq: u64, data: Vec<u8> },
    Stderr { seq: u64, data: Vec<u8> },
    Exit { seq: u64, code: u32 },
}

/// A program the node holds open: its stdin stays writable and its two output streams arrive as they
/// are produced, so a client that speaks a protocol over pipes can drive it for as long as it runs.
pub struct Process {
    id: String,
    pid: u32,
    stdin: ChildStdin,
    output: broadcast::Sender<Event>,
    seq: u64,
    exit_code: Option<u32>,
}

impl Process {
    pub fn summary(&self) -> Value {
        json!({"id":self.id,"pid":self.pid,"exit_code":self.exit_code})
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.output.subscribe()
    }

    pub async fn write(&mut self, data: &str) -> Result<()> {
        if self.exit_code.is_some() {
            bail!("Process has exited");
        }
        if data.len() > MAX_WRITE {
            bail!("Input chunk is too large");
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .context("Input is not base64")?;
        self.stdin.write_all(&bytes).await?;
        Ok(())
    }

    pub fn terminate(&mut self) {
        if self.exit_code.is_some() || self.pid <= 1 {
            return;
        }
        // The child was spawned as its own process group leader, so its group holds the helpers it
        // started itself.
        unsafe {
            libc::kill(-(self.pid as i32), libc::SIGKILL);
            libc::kill(self.pid as i32, libc::SIGKILL);
        }
    }
}

pub fn spawn(request: Value) -> Result<(String, Arc<Mutex<Process>>)> {
    let request: SpawnRequest = serde_json::from_value(request)?;
    if !request.cwd.is_absolute() {
        bail!("Process cwd must be absolute");
    }
    if !request.cwd.is_dir() {
        bail!("Not a directory: {}", request.cwd.display());
    }
    let mut child = Command::new(&request.program)
        .args(request.args)
        .current_dir(&request.cwd)
        .envs(request.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .with_context(|| format!("Cannot start {}", request.program))?;
    let pid = child.id().context("Process has no PID")?;
    let stdin = child.stdin.take().context("Process has no stdin")?;
    let stdout = child.stdout.take().context("Process has no stdout")?;
    let stderr = child.stderr.take().context("Process has no stderr")?;
    let (output, _) = broadcast::channel(BUFFER);
    let id = uuid::Uuid::new_v4().to_string();
    let process = Arc::new(Mutex::new(Process {
        id: id.clone(),
        pid,
        stdin,
        output,
        seq: 0,
        exit_code: None,
    }));
    tokio::spawn(forward(stdout, process.clone(), |seq, data| {
        Event::Stdout { seq, data }
    }));
    tokio::spawn(forward(stderr, process.clone(), |seq, data| {
        Event::Stderr { seq, data }
    }));
    let exited = process.clone();
    tokio::spawn(async move {
        // A signaled process reports what a shell reports for it, so every ending carries a code.
        let code = child
            .wait()
            .await
            .map(|status| {
                status
                    .code()
                    .map(|code| code as u32)
                    .or_else(|| status.signal().map(|signal| 128 + signal as u32))
                    .unwrap_or(1)
            })
            .unwrap_or(1);
        let mut process = exited.lock().await;
        process.exit_code = Some(code);
        process.seq += 1;
        let _ = process.output.send(Event::Exit {
            seq: process.seq,
            code,
        });
    });
    Ok((id, process))
}

async fn forward(
    mut reader: impl AsyncRead + Unpin,
    process: Arc<Mutex<Process>>,
    build: fn(u64, Vec<u8>) -> Event,
) {
    let mut bytes = [0; READ_CHUNK];
    loop {
        let read = match reader.read(&mut bytes).await {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let mut process = process.lock().await;
        process.seq += 1;
        let _ = process
            .output
            .send(build(process.seq, bytes[..read].to_vec()));
    }
}

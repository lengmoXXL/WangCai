use crate::lock;
use anyhow::{Context, Result, bail};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    os::unix::process::ExitStatusExt,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex as StdMutex},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{ChildStdin, Command},
    sync::{Mutex, mpsc},
};

const MAX_WRITE: usize = 64 * 1024;
const READ_CHUNK: usize = 8 * 1024;
// How far a client may lag before the output waits for it.
const BUFFER: usize = 4096;
// Writes waiting for the process to read its stdin. A process that stops reading fills this queue, and
// the client's next write waits for room in it, which is backpressure rather than a stalled process.
const WRITE_QUEUE: usize = 32;

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

/// Where one process' output goes: a queue per subscriber, whose sender waits for room instead of
/// overrunning, so a client that cannot keep up holds the process back rather than missing bytes.
struct Subscribers(StdMutex<Vec<mpsc::Sender<Event>>>);

impl Subscribers {
    fn new() -> Self {
        Self(StdMutex::new(Vec::new()))
    }

    fn subscribe(&self) -> mpsc::Receiver<Event> {
        let (sender, receiver) = mpsc::channel(BUFFER);
        lock(&self.0).push(sender);
        receiver
    }

    /// The senders are cloned out before the first wait, so a stalled client never holds their lock.
    async fn deliver(&self, event: Event) {
        let senders = lock(&self.0).clone();
        for sender in senders {
            let _ = sender.send(event.clone()).await;
        }
        // A queue whose reader is gone belongs to a client that detached.
        lock(&self.0).retain(|sender| !sender.is_closed());
    }
}

/// A program the node holds open: its stdin stays writable and its two output streams arrive as they
/// are produced, so a client that speaks a protocol over pipes can drive it for as long as it runs.
pub struct Process {
    id: String,
    pid: u32,
    // The process' stdin belongs to its writer task rather than to this struct.
    input: mpsc::Sender<Vec<u8>>,
    output: Arc<Subscribers>,
    seq: u64,
    exit_code: Option<u32>,
}

pub struct Input(mpsc::Sender<Vec<u8>>);

impl Input {
    pub async fn write(&self, data: &str) -> Result<()> {
        if data.len() > MAX_WRITE {
            bail!("Input chunk is too large");
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .context("Input is not base64")?;
        // A queue whose receiver is gone belongs to a process that has ended, which its exit event tells.
        self.0.send(bytes).await.context("Process has exited")
    }
}

impl Process {
    pub fn summary(&self) -> Value {
        json!({"id":self.id,"pid":self.pid,"exit_code":self.exit_code})
    }

    pub fn subscribe(&self) -> mpsc::Receiver<Event> {
        self.output.subscribe()
    }

    pub fn input(&self) -> Result<Input> {
        if self.exit_code.is_some() {
            bail!("Process has exited");
        }
        Ok(Input(self.input.clone()))
    }

    pub fn terminate(&mut self) {
        if self.exit_code.is_some() {
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
    let (input, queue) = mpsc::channel(WRITE_QUEUE);
    let id = uuid::Uuid::new_v4().to_string();
    let process = Arc::new(Mutex::new(Process {
        id: id.clone(),
        pid,
        input,
        output: Arc::new(Subscribers::new()),
        seq: 0,
        exit_code: None,
    }));
    tokio::spawn(write_stdin(stdin, queue));
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
        let (output, seq) = {
            let mut process = exited.lock().await;
            process.exit_code = Some(code);
            process.seq += 1;
            (process.output.clone(), process.seq)
        };
        output.deliver(Event::Exit { seq, code }).await;
    });
    Ok((id, process))
}

async fn write_stdin(mut stdin: ChildStdin, mut queue: mpsc::Receiver<Vec<u8>>) {
    while let Some(bytes) = queue.recv().await {
        // A pipe that refuses the bytes belongs to a process that closed its stdin, whose ending the
        // wait task reports; the queued writes that follow fail against the closed queue.
        if stdin.write_all(&bytes).await.is_err() {
            break;
        }
    }
}

async fn forward(
    mut reader: impl AsyncRead + Unpin,
    process: Arc<Mutex<Process>>,
    build: fn(u64, Vec<u8>) -> Event,
) {
    let output = process.lock().await.output.clone();
    let mut bytes = [0; READ_CHUNK];
    loop {
        let read = match reader.read(&mut bytes).await {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let event = {
            let mut process = process.lock().await;
            process.seq += 1;
            build(process.seq, bytes[..read].to_vec())
        };
        output.deliver(event).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_subscriber_that_reads_late_gets_every_event() {
        let subscribers = Subscribers::new();
        let mut receiver = subscribers.subscribe();
        // Two events past what the queue holds: they wait for room rather than being dropped.
        let total = BUFFER as u64 + 2;
        let deliver = tokio::spawn(async move {
            for seq in 1..=total {
                subscribers
                    .deliver(Event::Stdout { seq, data: vec![0] })
                    .await;
            }
        });
        for seq in 1..=total {
            match receiver.recv().await {
                Some(Event::Stdout { seq: got, .. }) => {
                    assert_eq!(got, seq, "events arrived out of order")
                }
                _ => panic!("event {seq} went missing"),
            }
        }
        deliver.await.unwrap();
    }
}

use crate::ServerInfo;
use crate::process::{Event, Process};
use crate::watch::Batch;
use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex, MutexGuard, PoisonError, atomic::{AtomicU64, Ordering}},
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{Mutex as AsyncMutex, Notify, broadcast, mpsc},
    task::JoinHandle,
};
use tokio_tungstenite::{accept_async, tungstenite::Message};

// A node outlives the windows that speak to it, so a process one of them started is kept until nobody
// has come back for it: a window that reconnects attaches its processes again and keeps them running.
const REAP: Duration = Duration::from_secs(60);

// Writes waiting for the pty to take them. A terminal that stops reading its input fills this queue, and the
// next write waits for room in it, which is backpressure rather than a stalled node.
const WRITE_QUEUE: usize = 32;

/// A lock whose holder panicked is not a reason to end the node: the terminals the panic did not touch are
/// still the ones a window expects to find, and only the request that panicked is gone.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Terminal {
    id: String,
    title: String,
    pid: u32,
    master: Box<dyn MasterPty + Send>,
    // The terminal's input belongs to its writer thread rather than to this struct.
    input: mpsc::Sender<Vec<u8>>,
    parser: vt100::Parser,
    seq: u64,
    exit_code: Option<u32>,
    output: broadcast::Sender<Message>,
}

struct Input(mpsc::Sender<Vec<u8>>);

impl Input {
    async fn write(&self, data: &str) -> Result<()> {
        if data.len() > 65_536 {
            bail!("Input chunk is too large");
        }
        // A queue whose receiver is gone belongs to a terminal that has ended, which its exit event tells.
        self.0.send(data.as_bytes().to_vec()).await.context("Shell has exited")
    }
}

impl Terminal {
    fn summary(&self) -> Value {
        let (rows, cols) = self.parser.screen().size();
        json!({"id":self.id,"title":self.title,"pid":self.pid,"rows":rows,"cols":cols,"exit_code":self.exit_code})
    }

    fn input(&self) -> Result<Input> {
        if self.exit_code.is_some() {
            bail!("Shell has exited");
        }
        Ok(Input(self.input.clone()))
    }

    fn cwd(&self) -> Result<std::path::PathBuf> {
        if self.exit_code.is_some() {
            bail!("Shell has exited");
        }
        #[cfg(target_os = "linux")]
        {
            Ok(std::fs::read_link(format!("/proc/{}/cwd", self.pid))?)
        }
        #[cfg(target_os = "macos")]
        {
            let mut info = std::mem::MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
            let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as i32;
            let result = unsafe {
                libc::proc_pidinfo(
                    self.pid as i32,
                    libc::PROC_PIDVNODEPATHINFO,
                    0,
                    info.as_mut_ptr().cast(),
                    size,
                )
            };
            if result != size {
                return Err(std::io::Error::last_os_error().into());
            }
            let info = unsafe { info.assume_init() };
            let path = unsafe { std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr().cast()) };
            use std::os::unix::ffi::OsStrExt;
            Ok(std::path::PathBuf::from(std::ffi::OsStr::from_bytes(
                path.to_bytes(),
            )))
        }
    }

    fn snapshot(&self) -> Message {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let mut normal = vt100::Parser::new(rows, cols, 0);
        *normal.screen_mut() = screen.clone();
        if screen.alternate_screen() {
            normal.process(b"\x1b[?1049l");
        }
        let normal = normal.screen_mut();
        normal.set_scrollback(usize::MAX);
        let history = normal.scrollback();
        let mut bytes = b"\x1bc".to_vec();
        for offset in (1..=history).rev() {
            normal.set_scrollback(offset);
            if let Some(line) = normal.rows(0, cols).next() {
                bytes.extend(line.as_bytes());
            }
            bytes.extend(b"\r\n");
        }
        if history > 0 {
            for _ in 1..rows {
                bytes.extend(b"\r\n");
            }
        }
        normal.set_scrollback(0);
        bytes.extend(normal.state_formatted());
        if screen.alternate_screen() {
            bytes.extend(b"\x1b[?1049h");
            bytes.extend(screen.state_formatted());
        }
        packet(
            json!({"event":"snapshot","session_id":self.id,"seq":self.seq,"rows":rows,"cols":cols}),
            &bytes,
        )
    }

    fn terminate(&mut self) {
        if self.exit_code.is_none() {
            // Background jobs may have their own process groups. Collect descendants
            // before killing the shell, while their parent links still exist.
            if let Ok(output) = std::process::Command::new("ps")
                .args(["-axo", "pid=,ppid="])
                .output()
            {
                let processes: Vec<(i32, i32)> = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter_map(|line| {
                        let mut fields = line.split_whitespace();
                        Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
                    })
                    .collect();
                let mut descendants = vec![self.pid as i32];
                let mut index = 0;
                while index < descendants.len() {
                    let parent = descendants[index];
                    for &(pid, ppid) in &processes {
                        if ppid == parent && !descendants.contains(&pid) {
                            descendants.push(pid);
                        }
                    }
                    index += 1;
                }
                for &pid in descendants.iter().skip(1).rev() {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            }
        }
        // The foreground job may have a different process group from its shell.
        if let Some(group) = self.master.process_group_leader()
            && group > 1
        {
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        }
        if self.exit_code.is_none() && self.pid > 1 {
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGKILL);
                libc::kill(self.pid as i32, libc::SIGKILL);
            }
        }
    }
}

fn packet(header: Value, data: &[u8]) -> Message {
    let header = header.to_string();
    let mut bytes = Vec::with_capacity(4 + header.len() + data.len());
    bytes.extend((header.len() as u32).to_be_bytes());
    bytes.extend(header.as_bytes());
    bytes.extend(data);
    Message::Binary(bytes.into())
}

/// A process the node holds, and the connection that started or last attached it: only that connection's
/// end takes it away.
struct Held {
    process: Arc<AsyncMutex<Process>>,
    connection: u64,
}

struct Node {
    info: ServerInfo,
    sessions: Mutex<HashMap<String, Arc<Mutex<Terminal>>>>,
    processes: Mutex<HashMap<String, Held>>,
    // Names one client socket, so the node can tell which window a process was left by.
    serial: AtomicU64,
    changed: broadcast::Sender<()>,
    stop: Notify,
}

impl Node {
    fn session(&self, id: &str) -> Result<Arc<Mutex<Terminal>>> {
        lock(&self.sessions)
            .get(id)
            .cloned()
            .context("Terminal no longer exists")
    }

    fn process(&self, id: &str) -> Result<Arc<AsyncMutex<Process>>> {
        lock(&self.processes)
            .get(id)
            .map(|held| held.process.clone())
            .context("Process no longer exists")
    }

    /// The processes one connection's end leaves behind: the ones it started that no later connection
    /// attached again.
    fn abandoned(&self, connection: u64) -> Vec<Arc<AsyncMutex<Process>>> {
        let mut processes = lock(&self.processes);
        let ids: Vec<String> = processes
            .iter()
            .filter(|(_, held)| held.connection == connection)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| processes.remove(&id))
            .map(|held| held.process)
            .collect()
    }

    fn create(&self, rows: u16, cols: u16, cwd: Option<&str>, env: &HashMap<String, String>) -> Result<Value> {
        let pty = native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command = CommandBuilder::new_default_prog();
        let shell = command.get_shell();
        command.cwd(match cwd {
            Some(cwd) => {
                let path = std::path::PathBuf::from(cwd);
                if !path.is_dir() {
                    bail!("Not a directory: {}", path.display());
                }
                path
            }
            // A session opens in the real home: the profile decides where the agent keeps its own files, not where a terminal starts.
            None => std::env::var("HOME").context("HOME is not set")?.into(),
        });
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "Wangcai");
        for (name, value) in env {
            command.env(name, value);
        }
        let mut child = pty.slave.spawn_command(command)?;
        drop(pty.slave);
        let pid = child.process_id().context("Shell has no PID")?;
        let mut reader = pty.master.try_clone_reader()?;
        let writer = pty.master.take_writer()?;
        let id = uuid::Uuid::new_v4().to_string();
        let (output, _) = broadcast::channel(256);
        let (input, queue) = mpsc::channel(WRITE_QUEUE);
        let terminal = Arc::new(Mutex::new(Terminal {
            id: id.clone(),
            title: format!("{} · {}", shell.rsplit('/').next().unwrap(), pid),
            pid,
            master: pty.master,
            input,
            parser: vt100::Parser::new(rows, cols, 10_000),
            seq: 0,
            exit_code: None,
            output,
        }));
        std::thread::spawn(move || write_input(writer, queue));
        let summary = lock(&terminal).summary();
        lock(&self.sessions).insert(id, terminal.clone());
        let read_terminal = terminal.clone();
        let reader_thread = std::thread::spawn(move || {
            let mut bytes = [0; 8192];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut terminal = lock(&read_terminal);
                        terminal.parser.process(&bytes[..n]);
                        terminal.seq += 1;
                        let _ = terminal.output.send(packet(
                            json!({"event":"output","session_id":terminal.id,"seq":terminal.seq}),
                            &bytes[..n],
                        ));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
        let changed = self.changed.clone();
        std::thread::spawn(move || {
            let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
            // Consume trailing output before announcing exit.
            let _ = reader_thread.join();
            let mut terminal = lock(&terminal);
            terminal.exit_code = Some(code);
            let _ = changed.send(());
        });
        let _ = self.changed.send(());
        Ok(summary)
    }
}

fn write_input(mut writer: Box<dyn Write + Send>, mut queue: mpsc::Receiver<Vec<u8>>) {
    while let Some(bytes) = queue.blocking_recv() {
        // A pty that refuses the bytes belongs to a terminal that has ended, which its exit event tells.
        if writer.write_all(&bytes).is_err() {
            break;
        }
    }
}

fn dimensions(request: &Value) -> Result<(u16, u16)> {
    let rows = request["rows"].as_u64().unwrap_or(24);
    let cols = request["cols"].as_u64().unwrap_or(80);
    if !(2..=300).contains(&rows) || !(2..=500).contains(&cols) {
        bail!("Terminal size must be 2–300 rows and 2–500 columns");
    }
    Ok((rows as u16, cols as u16))
}

async fn connection(stream: TcpStream, node: Arc<Node>) -> Result<()> {
    let connection = node.serial.fetch_add(1, Ordering::Relaxed);
    // The renderer speaks to this socket itself, so the origin it was loaded from is never checked.
    let socket = tokio::time::timeout(Duration::from_secs(5), accept_async(stream)).await??;
    let (mut sink, mut source) = socket.split();
    let (out, mut incoming) = mpsc::channel::<Message>(128);
    let (batches, mut reported) = mpsc::channel::<Batch>(16);
    let mut attachments: HashMap<String, JoinHandle<()>> = HashMap::new();
    let mut watchers: HashMap<String, JoinHandle<()>> = HashMap::new();
    let mut commands = tokio::task::JoinSet::new();
    let mut changed = node.changed.subscribe();
    let writer = tokio::spawn(async move {
        while let Some(message) = incoming.recv().await {
            if !matches!(
                tokio::time::timeout(Duration::from_secs(10), sink.send(message)).await,
                Ok(Ok(()))
            ) {
                break;
            }
        }
    });
    loop {
        tokio::select! {
            _ = out.closed() => break,
            _ = commands.join_next(), if !commands.is_empty() => {},
            _ = changed.recv() => {
                if out.send(Message::text(json!({"event":"sessions_changed"}).to_string())).await.is_err() { break; }
            }
            Some(batch) = reported.recv() => {
                let event = json!({"event":"fs_changed","watch_id":batch.watch_id,"created":batch.created,"modified":batch.modified,"removed":batch.removed});
                if out.send(Message::text(event.to_string())).await.is_err() { break; }
            }
            message = source.next() => {
                let Some(Ok(message)) = message else { break; };
                match message {
                    Message::Ping(bytes) => { let _ = out.send(Message::Pong(bytes)).await; continue; }
                    Message::Close(_) => break,
                    Message::Text(_) => {},
                    _ => continue,
                }
                let request: Value = match serde_json::from_str(message.to_text()?) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let op = request["op"].as_str().unwrap_or("");
                if op == "exec" {
                    let out = out.clone();
                    commands.spawn(async move {
                        let id = request["id"].clone();
                        let reply = match crate::subprocess::exec(request).await {
                            Ok(value) => json!({"id":id,"result":value}),
                            Err(error) => json!({"id":id,"error":error.to_string()}),
                        };
                        let _ = out.send(Message::text(reply.to_string())).await;
                    });
                    continue;
                }
                if op == "watch" || op == "unwatch" {
                    let watch_id = request["watch_id"].as_str().unwrap_or("").to_owned();
                    let reply = if op == "watch" {
                        match crate::watch::start(request["path"].as_str().unwrap_or(""), request["recursive"].as_bool().unwrap_or(false), &watch_id, batches.clone()) {
                            Ok(task) => {
                                if let Some(previous) = watchers.insert(watch_id, task) { previous.abort(); }
                                json!({"id":request["id"],"result":{}})
                            }
                            Err(error) => json!({"id":request["id"],"error":error.to_string()}),
                        }
                    } else {
                        if let Some(task) = watchers.remove(&watch_id) { task.abort(); }
                        json!({"id":request["id"],"result":{}})
                    };
                    if out.send(Message::text(reply.to_string())).await.is_err() { break; }
                    continue;
                }
                if op == "read_file" || op == "read_directory" || op == "stat" {
                    let reply = match crate::files::read(op, request["path"].as_str().unwrap_or("")).await {
                        Ok(value) => json!({"id":request["id"],"result":value}),
                        Err(error) => json!({"id":request["id"],"error":error.to_string()}),
                    };
                    if out.send(Message::text(reply.to_string())).await.is_err() { break; }
                    continue;
                }
                let id = request["session_id"].as_str().unwrap_or("");
                let result: Result<Value> = async {
                    match op {
                        "info" => Ok(serde_json::to_value(&node.info)?),
                        "stop" => {
                            if request["instance_id"].as_str() != Some(&node.info.instance_id) { bail!("Node instance changed"); }
                            Ok(json!({}))
                        }
                        "list" => {
                            // The session map lock goes before any terminal is read, so a terminal that is busy for a moment
                            // cannot hold up create, close and cwd, which need the map.
                            let terminals: Vec<_> = lock(&node.sessions).values().cloned().collect();
                            let mut sessions: Vec<_> = terminals.iter().map(|s| lock(&s).summary()).collect();
                            sessions.sort_by_key(|s| s["pid"].as_u64());
                            Ok(json!(sessions))
                        }
                        "cwd" => {
                            let session = node.session(id)?;
                            Ok(json!(lock(&session).cwd()?))
                        }
                        "create" => {
                            let (rows, cols) = dimensions(&request)?;
                            // The caller's variables for this shell, on top of the node's own environment.
                            let env: HashMap<String, String> = request["env"].as_object().map(|env| {
                                env.iter().filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_owned()))).collect()
                            }).unwrap_or_default();
                            node.create(rows, cols, request["cwd"].as_str(), &env)
                        }
                        "attach" => {
                            let session = node.session(id)?;
                            let terminal = lock(&session);
                            if let Some(task) = attachments.remove(id) { task.abort(); }
                            // Subscribe under the same lock as the snapshot's sequence boundary.
                            let mut events = terminal.output.subscribe();
                            let snapshot = terminal.snapshot();
                            let out = out.clone();
                            let session = session.clone();
                            let task = tokio::spawn(async move {
                                if out.send(snapshot).await.is_err() { return; }
                                loop {
                                    let message = match events.recv().await {
                                        Ok(message) => message,
                                        Err(broadcast::error::RecvError::Lagged(_)) => {
                                            let terminal = lock(&session);
                                            events = terminal.output.subscribe();
                                            terminal.snapshot()
                                        }
                                        Err(_) => break,
                                    };
                                    if out.send(message).await.is_err() { break; }
                                }
                            });
                            attachments.insert(id.into(), task);
                            Ok(terminal.summary())
                        }
                        "detach" => {
                            if let Some(task) = attachments.remove(id) { task.abort(); }
                            Ok(json!({}))
                        }
                        "input" | "resize" => {
                            let session = node.session(id)?;
                            if !attachments.contains_key(id) { bail!("Attach the terminal before writing or resizing"); }
                            if op == "input" {
                                let data = request["data"].as_str().context("Missing input data")?;
                                // The lock goes before the bytes are queued: a terminal that is slow to read its
                                // input delays this reply without ever holding up its own output or its close.
                                let input = lock(&session).input()?;
                                input.write(data).await?;
                            } else {
                                let mut terminal = lock(&session);
                                let (rows, cols) = dimensions(&request)?;
                                terminal.master.resize(PtySize {rows, cols, pixel_width: 0, pixel_height: 0})?;
                                terminal.parser.screen_mut().set_size(rows, cols);
                            }
                            Ok(json!({}))
                        }
                        "close" => {
                            let session = node.session(id)?;
                            lock(&session).terminate();
                            lock(&node.sessions).remove(id);
                            if let Some(task) = attachments.remove(id) { task.abort(); }
                            let _ = node.changed.send(());
                            Ok(json!({}))
                        }
                        "spawn" => {
                            let (id, process) = crate::process::spawn(request.clone())?;
                            let summary = process.lock().await.summary();
                            lock(&node.processes).insert(id, Held { process, connection });
                            Ok(summary)
                        }
                        "process_attach" => {
                            let process = node.process(id)?;
                            if let Some(task) = attachments.remove(id) { task.abort(); }
                            // Subscribe before reading the summary, so no output slips between the two.
                            let mut events = process.lock().await.subscribe();
                            let out = out.clone();
                            let session = id.to_owned();
                            let task = tokio::spawn(async move {
                                loop {
                                    match events.recv().await {
                                        Ok(event) => {
                                            let (header, data) = match event {
                                                Event::Stdout { seq, data } => (json!({"event":"stdout","session_id":session,"seq":seq}), data),
                                                Event::Stderr { seq, data } => (json!({"event":"stderr","session_id":session,"seq":seq}), data),
                                                Event::Exit { seq, code } => (json!({"event":"exit","session_id":session,"seq":seq,"code":code}), Vec::new()),
                                            };
                                            if out.send(packet(header, &data)).await.is_err() { break; }
                                        }
                                        Err(broadcast::error::RecvError::Lagged(_)) => {
                                            // A byte stream that lost a frame cannot be resumed; say so and stop.
                                            let header = json!({"event":"lost","session_id":session});
                                            let _ = out.send(packet(header, &[])).await;
                                            break;
                                        }
                                        Err(_) => break,
                                    }
                                }
                            });
                            attachments.insert(id.into(), task);
                            if let Some(held) = lock(&node.processes).get_mut(id) { held.connection = connection; }
                            Ok(process.lock().await.summary())
                        }
                        "process_write" => {
                            let process = node.process(id)?;
                            if !attachments.contains_key(id) { bail!("Attach the process before writing to it"); }
                            let data = request["data"].as_str().context("Missing input data")?;
                            // The lock goes before the bytes are queued: a process that is slow to read its
                            // stdin delays this reply without ever holding up its own output or its close.
                            let input = process.lock().await.input()?;
                            input.write(data).await?;
                            Ok(json!({}))
                        }
                        "process_close" => {
                            let process = node.process(id)?;
                            process.lock().await.terminate();
                            lock(&node.processes).remove(id);
                            if let Some(task) = attachments.remove(id) { task.abort(); }
                            Ok(json!({}))
                        }
                        _ => bail!("Unknown operation: {op}"),
                    }
                }.await;
                let should_stop = op == "stop" && result.is_ok();
                let reply = match result {
                    Ok(value) => json!({"id":request["id"],"result":value}),
                    Err(error) => json!({"id":request["id"],"error":error.to_string()}),
                };
                if out.send(Message::text(reply.to_string())).await.is_err() { break; }
                if should_stop {
                    let node = node.clone();
                    tokio::spawn(async move { tokio::time::sleep(Duration::from_millis(100)).await; node.stop.notify_one(); });
                }
            }
        }
    }
    for task in attachments.into_values() {
        task.abort();
    }
    for task in watchers.into_values() {
        task.abort();
    }
    commands.shutdown().await;
    writer.abort();
    tokio::spawn(async move {
        tokio::time::sleep(REAP).await;
        for process in node.abandoned(connection) {
            process.lock().await.terminate();
        }
    });
    Ok(())
}

pub async fn run(listener: TcpListener, info: ServerInfo) -> Result<()> {
    let (changed, _) = broadcast::channel(64);
    let node = Arc::new(Node {
        info,
        sessions: Mutex::new(HashMap::new()),
        processes: Mutex::new(HashMap::new()),
        serial: AtomicU64::new(0),
        changed,
        stop: Notify::new(),
    });
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            _ = node.stop.notified() => break,
            _ = terminate.recv() => break,
            _ = tokio::signal::ctrl_c() => break,
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let node = node.clone();
                tokio::spawn(async move {
                    if let Err(error) = connection(stream, node).await { eprintln!("Connection: {error}"); }
                });
            }
        }
    }
    for session in lock(&node.sessions).values() {
        lock(&session).terminate();
    }
    let processes: Vec<_> = lock(&node.processes).values().map(|held| held.process.clone()).collect();
    for process in processes {
        process.lock().await.terminate();
    }
    Ok(())
}

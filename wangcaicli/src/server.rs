use crate::ServerInfo;
use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{Notify, broadcast, mpsc},
    task::JoinHandle,
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};

struct Terminal {
    id: String,
    title: String,
    pid: u32,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    parser: vt100::Parser,
    seq: u64,
    exit_code: Option<u32>,
    owner: Option<String>,
    output: broadcast::Sender<Message>,
}

impl Terminal {
    fn summary(&self) -> Value {
        let (rows, cols) = self.parser.screen().size();
        json!({"id":self.id,"title":self.title,"pid":self.pid,"rows":rows,"cols":cols,"exit_code":self.exit_code})
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

struct Node {
    info: ServerInfo,
    sessions: Mutex<HashMap<String, Arc<Mutex<Terminal>>>>,
    changed: broadcast::Sender<()>,
    stop: Notify,
}

impl Node {
    fn session(&self, id: &str) -> Result<Arc<Mutex<Terminal>>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .context("Terminal no longer exists")
    }

    fn create(&self, rows: u16, cols: u16, cwd: Option<&str>) -> Result<Value> {
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
        let mut child = pty.slave.spawn_command(command)?;
        drop(pty.slave);
        let pid = child.process_id().context("Shell has no PID")?;
        let mut reader = pty.master.try_clone_reader()?;
        let writer = pty.master.take_writer()?;
        let id = uuid::Uuid::new_v4().to_string();
        let (output, _) = broadcast::channel(256);
        let terminal = Arc::new(Mutex::new(Terminal {
            id: id.clone(),
            title: format!("{} · {}", shell.rsplit('/').next().unwrap(), pid),
            pid,
            master: pty.master,
            writer,
            parser: vt100::Parser::new(rows, cols, 10_000),
            seq: 0,
            exit_code: None,
            owner: None,
            output,
        }));
        let summary = terminal.lock().unwrap().summary();
        self.sessions.lock().unwrap().insert(id, terminal.clone());
        let read_terminal = terminal.clone();
        let reader_thread = std::thread::spawn(move || {
            let mut bytes = [0; 8192];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut terminal = read_terminal.lock().unwrap();
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
            let mut terminal = terminal.lock().unwrap();
            terminal.exit_code = Some(code);
            let _ = changed.send(());
        });
        let _ = self.changed.send(());
        Ok(summary)
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

#[allow(clippy::result_large_err)] // tungstenite's handshake callback requires an HTTP error response.
async fn connection(stream: TcpStream, node: Arc<Node>) -> Result<()> {
    let socket = tokio::time::timeout(
        Duration::from_secs(5),
        accept_hdr_async(stream, |request: &Request, response: Response| {
            if request.headers().contains_key("origin") {
                return Err(tokio_tungstenite::tungstenite::http::Response::builder()
                    .status(403)
                    .body(Some("Connect using the Wangcai desktop client".into()))
                    .unwrap());
            }
            Ok(response)
        }),
    )
    .await??;
    let (mut sink, mut source) = socket.split();
    let (out, mut incoming) = mpsc::channel::<Message>(128);
    let connection_id = uuid::Uuid::new_v4().to_string();
    let mut attachments: HashMap<String, JoinHandle<()>> = HashMap::new();
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
                if op == "read_file" || op == "read_directory" || op == "stat" {
                    let reply = match crate::files::read(op, request["path"].as_str().unwrap_or("")).await {
                        Ok(value) => json!({"id":request["id"],"result":value}),
                        Err(error) => json!({"id":request["id"],"error":error.to_string()}),
                    };
                    if out.send(Message::text(reply.to_string())).await.is_err() { break; }
                    continue;
                }
                let id = request["session_id"].as_str().unwrap_or("");
                let result: Result<Value> = (|| {
                    match op {
                        "info" => Ok(serde_json::to_value(&node.info)?),
                        "stop" => {
                            if request["instance_id"].as_str() != Some(&node.info.instance_id) { bail!("Node instance changed"); }
                            Ok(json!({}))
                        }
                        "list" => {
                            let mut sessions: Vec<_> = node.sessions.lock().unwrap().values().map(|s| s.lock().unwrap().summary()).collect();
                            sessions.sort_by_key(|s| s["pid"].as_u64());
                            Ok(json!(sessions))
                        }
                        "cwd" => Ok(json!(node.session(id)?.lock().unwrap().cwd()?)),
                        "create" => { let (rows, cols) = dimensions(&request)?; node.create(rows, cols, request["cwd"].as_str()) }
                        "attach" => {
                            let session = node.session(id)?;
                            let mut terminal = session.lock().unwrap();
                            if terminal.owner.as_ref().is_some_and(|owner| owner != &connection_id) { bail!("Terminal is attached to another client"); }
                            if let Some(task) = attachments.remove(id) { task.abort(); }
                            terminal.owner = Some(connection_id.clone());
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
                                            let terminal = session.lock().unwrap();
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
                            if let Ok(session) = node.session(id) {
                                let mut terminal = session.lock().unwrap();
                                if terminal.owner.as_ref() == Some(&connection_id) { terminal.owner = None; }
                            }
                            Ok(json!({}))
                        }
                        "input" | "resize" => {
                            let session = node.session(id)?;
                            let mut terminal = session.lock().unwrap();
                            if terminal.owner.as_ref() != Some(&connection_id) { bail!("Attach the terminal before writing or resizing"); }
                            if op == "input" {
                                if terminal.exit_code.is_some() { bail!("Shell has exited"); }
                                let data = request["data"].as_str().context("Missing input data")?;
                                if data.len() > 65_536 { bail!("Input chunk is too large"); }
                                terminal.writer.write_all(data.as_bytes())?;
                            } else {
                                let (rows, cols) = dimensions(&request)?;
                                terminal.master.resize(PtySize {rows, cols, pixel_width: 0, pixel_height: 0})?;
                                terminal.parser.screen_mut().set_size(rows, cols);
                            }
                            Ok(json!({}))
                        }
                        "close" => {
                            let session = node.session(id)?;
                            session.lock().unwrap().terminate();
                            node.sessions.lock().unwrap().remove(id);
                            if let Some(task) = attachments.remove(id) { task.abort(); }
                            let _ = node.changed.send(());
                            Ok(json!({}))
                        }
                        _ => bail!("Unknown operation: {op}"),
                    }
                })();
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
    for (id, task) in attachments {
        task.abort();
        if let Ok(session) = node.session(&id) {
            let mut terminal = session.lock().unwrap();
            if terminal.owner.as_ref() == Some(&connection_id) {
                terminal.owner = None;
            }
        }
    }
    commands.shutdown().await;
    writer.abort();
    Ok(())
}

pub async fn run(listener: TcpListener, info: ServerInfo) -> Result<()> {
    let (changed, _) = broadcast::channel(64);
    let node = Arc::new(Node {
        info,
        sessions: Mutex::new(HashMap::new()),
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
    for session in node.sessions.lock().unwrap().values() {
        session.lock().unwrap().terminate();
    }
    Ok(())
}

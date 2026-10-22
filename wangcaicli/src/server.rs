use crate::ServerInfo;
use crate::lock;
use crate::process::{Event, Process};
use crate::protocol::{DEFAULT_COLS, DEFAULT_ROWS, MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS, packet};
use crate::terminal::{self, Terminal};
use crate::watch::Batch;
use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
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

// A serial no connection carries: the terminal waits for a viewer to answer for it.
const NOBODY: u64 = u64::MAX;

fn snapshot_packet(id: &str, snapshot: terminal::Snapshot) -> Message {
    packet(
        json!({"event":"snapshot","session_id":id,"seq":snapshot.seq,"rows":snapshot.rows,"cols":snapshot.cols}),
        &snapshot.data,
    )
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
    // The connection that answers for a terminal: the last one to show activity on it.
    primaries: Mutex<HashMap<String, Arc<AtomicU64>>>,
    // Names one client socket.
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

    fn claim(&self, id: &str, connection: u64) -> Arc<AtomicU64> {
        let primary = lock(&self.primaries)
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(AtomicU64::new(NOBODY)))
            .clone();
        primary.store(connection, Ordering::Relaxed);
        primary
    }

    fn release(&self, id: &str, connection: u64) {
        if let Some(primary) = lock(&self.primaries)
            .get(id)
            .filter(|primary| primary.load(Ordering::Relaxed) == connection)
        {
            primary.store(NOBODY, Ordering::Relaxed);
        }
    }
}

fn dimensions(request: &Value) -> Result<(u16, u16)> {
    let rows = request["rows"].as_u64().unwrap_or(u64::from(DEFAULT_ROWS));
    let cols = request["cols"].as_u64().unwrap_or(u64::from(DEFAULT_COLS));
    let rows_fit = (u64::from(MIN_ROWS)..=u64::from(MAX_ROWS)).contains(&rows);
    let cols_fit = (u64::from(MIN_COLS)..=u64::from(MAX_COLS)).contains(&cols);
    if !rows_fit || !cols_fit {
        bail!("Terminal size must be {MIN_ROWS}-{MAX_ROWS} rows and {MIN_COLS}-{MAX_COLS} columns");
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
                let id = request["session_id"].as_str().unwrap_or("");
                let result: Result<Value> = async {
                    match op {
                        // The requests that need no session: exec answers from the task that runs it, since
                        // that is where its end is known; the rest read or watch the machine here.
                        "exec" => {
                            let request = request.clone();
                            let out = out.clone();
                            commands.spawn(async move {
                                let id = request["id"].clone();
                                let reply = match crate::subprocess::exec(request).await {
                                    Ok(value) => json!({"id":id,"result":value}),
                                    Err(error) => json!({"id":id,"error":error.to_string()}),
                                };
                                let _ = out.send(Message::text(reply.to_string())).await;
                            });
                            Ok(Value::Null)
                        }
                        "watch" => {
                            let watch_id = request["watch_id"].as_str().unwrap_or("").to_owned();
                            let task = crate::watch::start(request["path"].as_str().unwrap_or(""), request["recursive"].as_bool().unwrap_or(false), &watch_id, batches.clone())?;
                            if let Some(previous) = watchers.insert(watch_id, task) { previous.abort(); }
                            Ok(json!({}))
                        }
                        "unwatch" => {
                            if let Some(task) = watchers.remove(request["watch_id"].as_str().unwrap_or("")) { task.abort(); }
                            Ok(json!({}))
                        }
                        "read_file" | "read_directory" | "stat" => Ok(crate::files::read(op, request["path"].as_str().unwrap_or("")).await?),
                        "info" => Ok(serde_json::to_value(&node.info)?),
                        "stop" => {
                            if request["instance_id"].as_str() != Some(&node.info.instance_id) { bail!("Node instance changed"); }
                            Ok(json!({}))
                        }
                        "list" => {
                            // The session map lock goes before any terminal is read, so a terminal that is busy for a moment
                            // cannot hold up create, close and cwd, which need the map.
                            let terminals: Vec<_> = lock(&node.sessions).values().cloned().collect();
                            let mut sessions: Vec<_> = terminals.iter().map(|s| lock(s).summary()).collect();
                            sessions.sort_by_key(|s| s.pid);
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
                            let session = terminal::create(
                                rows,
                                cols,
                                request["cwd"].as_str(),
                                &env,
                                request["label"].as_str(),
                                node.changed.clone(),
                            )?;
                            let summary = lock(&session).summary();
                            lock(&node.sessions).insert(summary.id.clone(), session);
                            let _ = node.changed.send(());
                            Ok(json!(summary))
                        }
                        "attach" => {
                            let session = node.session(id)?;
                            let terminal = lock(&session);
                            if let Some(task) = attachments.remove(id) { task.abort(); }
                            // Subscribe under the same lock as the snapshot's sequence boundary.
                            let mut events = terminal.subscribe();
                            let snapshot = snapshot_packet(id, terminal.snapshot());
                            let out = out.clone();
                            let session = session.clone();
                            let session_id = id.to_owned();
                            let primary = node.claim(id, connection);
                            let task = tokio::spawn(async move {
                                if out.send(snapshot).await.is_err() { return; }
                                loop {
                                    let message = match events.recv().await {
                                        Ok(output) => {
                                            let mut data = output.data.to_vec();
                                            if primary.load(Ordering::Relaxed) == connection {
                                                data.extend_from_slice(&output.queries);
                                            }
                                            if data.is_empty() { continue; }
                                            packet(json!({"event":"output","session_id":session_id,"seq":output.seq}), &data)
                                        }
                                        Err(broadcast::error::RecvError::Lagged(_)) => {
                                            let terminal = lock(&session);
                                            events = terminal.subscribe();
                                            snapshot_packet(&session_id, terminal.snapshot())
                                        }
                                        Err(_) => break,
                                    };
                                    if out.send(message).await.is_err() { break; }
                                }
                            });
                            attachments.insert(id.into(), task);
                            Ok(json!(terminal.summary()))
                        }
                        "detach" => {
                            node.release(id, connection);
                            if let Some(task) = attachments.remove(id) { task.abort(); }
                            Ok(json!({}))
                        }
                        "input" | "resize" => {
                            let session = node.session(id)?;
                            if !attachments.contains_key(id) { bail!("Attach the terminal before writing or resizing"); }
                            node.claim(id, connection);
                            if op == "input" {
                                let data = request["data"].as_str().context("Missing input data")?;
                                // The lock goes before the bytes are queued: a terminal that is slow to read its
                                // input delays this reply without ever holding up its own output or its close.
                                let input = lock(&session).input()?;
                                input.write(data).await?;
                            } else {
                                let mut terminal = lock(&session);
                                let (rows, cols) = dimensions(&request)?;
                                terminal.resize(rows, cols)?;
                            }
                            Ok(json!({}))
                        }
                        "close" => {
                            let session = node.session(id)?;
                            lock(&session).terminate();
                            lock(&node.sessions).remove(id);
                            lock(&node.primaries).remove(id);
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
                                while let Some(event) = events.recv().await {
                                    let (header, data) = match event {
                                        Event::Stdout { seq, data } => (json!({"event":"stdout","session_id":session,"seq":seq}), data),
                                        Event::Stderr { seq, data } => (json!({"event":"stderr","session_id":session,"seq":seq}), data),
                                        Event::Exit { seq, code } => (json!({"event":"exit","session_id":session,"seq":seq,"code":code}), Vec::new()),
                                    };
                                    if out.send(packet(header, &data)).await.is_err() { break; }
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
                // exec answers from its own task, so nothing is due here.
                if op != "exec" {
                    let reply = match result {
                        Ok(value) => json!({"id":request["id"],"result":value}),
                        Err(error) => json!({"id":request["id"],"error":error.to_string()}),
                    };
                    if out.send(Message::text(reply.to_string())).await.is_err() { break; }
                }
                if should_stop {
                    let node = node.clone();
                    tokio::spawn(async move { tokio::time::sleep(Duration::from_millis(100)).await; node.stop.notify_one(); });
                }
            }
        }
    }
    for id in attachments.keys() {
        node.release(id, connection);
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
        primaries: Mutex::new(HashMap::new()),
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
    let processes: Vec<_> = lock(&node.processes)
        .values()
        .map(|held| held.process.clone())
        .collect();
    for process in processes {
        process.lock().await.terminate();
    }
    Ok(())
}

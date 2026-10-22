use crate::protocol::{
    DEFAULT_COLS, DEFAULT_ROWS, MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS, Summary, endpoint, payload,
    request,
};
use crate::{ServerInfo, rpc};
use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    time::Duration,
};
use tokio::{
    signal::unix::{SignalKind, signal},
    sync::mpsc,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

// Ctrl-] (0x1d).
const DETACH: u8 = 0x1d;

fn held(info: &ServerInfo) -> Result<Vec<Summary>> {
    Ok(serde_json::from_value(rpc(info, "list")?)?)
}

fn row(id: &str, title: &str, size: &str, pid: &str, state: &str) -> String {
    format!("{id:<8}  {title:<30}  {size:<11}  {pid:<7}  {state}")
}

fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

pub fn list(info: &ServerInfo, as_json: bool) -> Result<()> {
    let sessions = held(info)?;
    if as_json {
        println!("{}", serde_json::to_string_pretty(&sessions)?);
        return Ok(());
    }
    if sessions.is_empty() {
        println!("No terminals");
        return Ok(());
    }
    println!("{}", row("ID", "TITLE", "SIZE", "PID", "STATE"));
    for session in sessions {
        let size = format!("{}x{}", session.rows, session.cols);
        let pid = session.pid.to_string();
        let state = match session.exit_code {
            Some(code) => format!("exit {code}"),
            None => "running".to_owned(),
        };
        let title = session.label.as_deref().unwrap_or(&session.title);
        println!("{}", row(short(&session.id), title, &size, &pid, &state));
    }
    Ok(())
}

pub fn attach(info: &ServerInfo, wanted: &str) -> Result<()> {
    let id = resolve(info, wanted)?;
    let terminal = RawTerminal::enable()?;
    let attached = tokio::runtime::Runtime::new()?.block_on(run(info, &id));
    drop(terminal);
    // The shell's last line need not end in one of its own.
    println!();
    attached
}

fn resolve(info: &ServerInfo, wanted: &str) -> Result<String> {
    let sessions = held(info)?;
    let ids: Vec<&str> = sessions.iter().map(|session| session.id.as_str()).collect();
    Ok(pick(&ids, wanted)?.to_owned())
}

fn pick<'a>(ids: &[&'a str], wanted: &str) -> Result<&'a str> {
    if let Some(exact) = ids.iter().find(|id| **id == wanted) {
        return Ok(exact);
    }
    let matching: Vec<&str> = ids
        .iter()
        .copied()
        .filter(|id| id.starts_with(wanted))
        .collect();
    match matching.as_slice() {
        [] => bail!("No terminal starts with {wanted}. Run: wangcai terminal list"),
        [id] => Ok(id),
        _ => bail!("{wanted} names more than one terminal; give more of its id"),
    }
}

async fn run(info: &ServerInfo, id: &str) -> Result<()> {
    let socket = tokio::time::timeout(Duration::from_secs(2), connect_async(endpoint(info)))
        .await
        .context("Node did not accept the connection within 2 seconds")?
        .context("Node refused the connection")?;
    let (mut sink, mut source) = socket.0.split();
    sink.send(request("attach", [("session_id", json!(id))]))
        .await?;
    sink.send(resize_request(id, window_size())).await?;
    let (keystrokes, mut input) = mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || read_stdin(keystrokes));
    let mut resized = signal(SignalKind::window_change())?;
    let mut stdout = std::io::stdout();
    loop {
        tokio::select! {
            message = source.next() => {
                let Some(message) = message else { break };
                match message? {
                    // A snapshot and a frame of output are both bytes drawn as they come.
                    Message::Binary(bytes) => {
                        let Some(data) = payload(&bytes) else { continue };
                        stdout.write_all(data)?;
                        stdout.flush()?;
                    }
                    Message::Text(text) => {
                        let event: Value = serde_json::from_str(&text)?;
                        if event["event"] == "sessions_changed" && gone(info, id) { break }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            Some(bytes) = input.recv() => {
                let leave = bytes.iter().position(|byte| *byte == DETACH);
                let text = &bytes[..leave.unwrap_or(bytes.len())];
                if !text.is_empty() {
                    sink.send(request(
                        "input",
                        [
                            ("session_id", json!(id)),
                            ("data", json!(String::from_utf8_lossy(text))),
                        ],
                    ))
                    .await?;
                }
                if leave.is_some() {
                    sink.send(request("detach", [("session_id", json!(id))])).await?;
                    break;
                }
            }
            _ = resized.recv() => {
                sink.send(resize_request(id, window_size())).await?;
            }
        }
    }
    Ok(())
}

fn resize_request(id: &str, (rows, cols): (u16, u16)) -> Message {
    request(
        "resize",
        [
            ("session_id", json!(id)),
            ("rows", json!(rows)),
            ("cols", json!(cols)),
        ],
    )
}

/// Whether the shell is over.
fn gone(info: &ServerInfo, id: &str) -> bool {
    let Ok(sessions) = held(info) else {
        return false;
    };
    match sessions.iter().find(|session| session.id == id) {
        Some(session) => session.exit_code.is_some(),
        None => true,
    }
}

fn read_stdin(keystrokes: mpsc::Sender<Vec<u8>>) {
    let mut stdin = std::io::stdin();
    let mut bytes = [0; 4096];
    loop {
        match stdin.read(&mut bytes) {
            Ok(0) => break,
            Ok(read) => {
                if keystrokes.blocking_send(bytes[..read].to_vec()).is_err() {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

fn window_size() -> (u16, u16) {
    let mut window = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    match unsafe { libc::ioctl(libc::STDIN_FILENO, libc::TIOCGWINSZ, &mut window) } {
        0 if window.ws_row > 0 && window.ws_col > 0 => (
            window.ws_row.clamp(MIN_ROWS, MAX_ROWS),
            window.ws_col.clamp(MIN_COLS, MAX_COLS),
        ),
        _ => (DEFAULT_ROWS, DEFAULT_COLS),
    }
}

/// The terminal in raw mode while it is attached: every keystroke is the shell's.
struct RawTerminal(libc::termios);

impl RawTerminal {
    fn enable() -> Result<Self> {
        let mut current = std::mem::MaybeUninit::<libc::termios>::zeroed();
        if unsafe { libc::tcgetattr(libc::STDIN_FILENO, current.as_mut_ptr()) } != 0 {
            bail!(
                "Attaching needs a terminal: {}",
                std::io::Error::last_os_error()
            );
        }
        let original = unsafe { current.assume_init() };
        let mut raw = original;
        unsafe {
            libc::cfmakeraw(&mut raw);
            if libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &raw) != 0 {
                bail!(
                    "Cannot put the terminal in raw mode: {}",
                    std::io::Error::last_os_error()
                );
            }
        }
        Ok(RawTerminal(original))
    }
}

impl Drop for RawTerminal {
    fn drop(&mut self) {
        unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::pick;

    const IDS: [&str; 2] = ["aabbccdd-1111", "aabbccdd-2222"];

    #[test]
    fn a_whole_id_names_it() {
        assert_eq!(pick(&IDS, "aabbccdd-2222").unwrap(), "aabbccdd-2222");
    }

    #[test]
    fn a_prefix_names_the_one_it_is_alone_in() {
        assert_eq!(pick(&IDS, "aabbccdd-1").unwrap(), "aabbccdd-1111");
    }

    #[test]
    fn a_prefix_two_of_them_share_names_none() {
        assert!(pick(&IDS, "aabb").is_err());
    }

    #[test]
    fn a_prefix_of_no_terminal_names_none() {
        assert!(pick(&IDS, "zz").is_err());
    }
}

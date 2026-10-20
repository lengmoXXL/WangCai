use crate::lock;
use anyhow::{Context, Result, bail};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
};
use tokio::sync::{broadcast, mpsc};

// Writes waiting for the pty to take them. A terminal that stops reading its input fills this queue, and the
// next write waits for room in it, which is backpressure rather than a stalled node.
const WRITE_QUEUE: usize = 32;

#[derive(Serialize)]
pub struct Summary {
    pub id: String,
    title: String,
    pub pid: u32,
    rows: u16,
    cols: u16,
    exit_code: Option<u32>,
}

#[derive(Clone)]
pub struct Output {
    pub seq: u64,
    pub data: Arc<[u8]>,
}

pub struct Snapshot {
    pub seq: u64,
    pub rows: u16,
    pub cols: u16,
    pub data: Vec<u8>,
}

pub struct Terminal {
    id: String,
    title: String,
    pid: u32,
    master: Box<dyn MasterPty + Send>,
    // The terminal's input belongs to its writer thread rather than to this struct.
    input: mpsc::Sender<Vec<u8>>,
    parser: vt100::Parser,
    seq: u64,
    exit_code: Option<u32>,
    output: broadcast::Sender<Output>,
}

pub struct Input(mpsc::Sender<Vec<u8>>);

impl Input {
    pub async fn write(&self, data: &str) -> Result<()> {
        if data.len() > 65_536 {
            bail!("Input chunk is too large");
        }
        // A queue whose receiver is gone belongs to a terminal that has ended, which its exit event tells.
        self.0
            .send(data.as_bytes().to_vec())
            .await
            .context("Shell has exited")
    }
}

impl Terminal {
    pub fn summary(&self) -> Summary {
        let (rows, cols) = self.parser.screen().size();
        Summary {
            id: self.id.clone(),
            title: self.title.clone(),
            pid: self.pid,
            rows,
            cols,
            exit_code: self.exit_code,
        }
    }

    pub fn input(&self) -> Result<Input> {
        if self.exit_code.is_some() {
            bail!("Shell has exited");
        }
        Ok(Input(self.input.clone()))
    }

    pub fn cwd(&self) -> Result<std::path::PathBuf> {
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

    pub fn snapshot(&self) -> Snapshot {
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
        Snapshot {
            seq: self.seq,
            rows,
            cols,
            data: bytes,
        }
    }

    pub fn terminate(&mut self) {
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

    pub fn subscribe(&self) -> broadcast::Receiver<Output> {
        self.output.subscribe()
    }

    pub fn resize(&mut self, rows: u16, cols: u16) -> Result<()> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        self.parser.screen_mut().set_size(rows, cols);
        Ok(())
    }
}

pub fn create(
    rows: u16,
    cols: u16,
    cwd: Option<&str>,
    env: &HashMap<String, String>,
    changed: broadcast::Sender<()>,
) -> Result<Arc<Mutex<Terminal>>> {
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
    // A viewer this far behind is handed a fresh snapshot instead of the frames it missed, so the queue is
    // long enough that an ordinary burst of output does not cost one.
    let (output, _) = broadcast::channel(1024);
    let (input, queue) = mpsc::channel(WRITE_QUEUE);
    let terminal = Arc::new(Mutex::new(Terminal {
        id,
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
                    let _ = terminal.output.send(Output {
                        seq: terminal.seq,
                        data: Arc::from(&bytes[..n]),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });
    let exited = terminal.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
        // Consume trailing output before announcing exit.
        let _ = reader_thread.join();
        let mut terminal = lock(&exited);
        terminal.exit_code = Some(code);
        let _ = changed.send(());
    });
    Ok(terminal)
}

fn write_input(mut writer: Box<dyn Write + Send>, mut queue: mpsc::Receiver<Vec<u8>>) {
    while let Some(bytes) = queue.blocking_recv() {
        // A pty that refuses the bytes belongs to a terminal that has ended, which its exit event tells.
        if writer.write_all(&bytes).is_err() {
            break;
        }
    }
}

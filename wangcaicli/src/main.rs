mod server;
mod subprocess;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    net::{SocketAddr, TcpStream},
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};
use tokio_tungstenite::tungstenite::{self, Message};

#[derive(Parser)]
#[command(name = "wangcai", version, about = "Persistent terminal node")]
struct Cli {
    #[command(subcommand)]
    command: RootCommand,
}

#[derive(Subcommand)]
enum RootCommand {
    Server {
        #[command(subcommand)]
        command: ServerCommand,
    },
}

#[derive(Subcommand)]
enum ServerCommand {
    Start {
        #[arg(long, hide = true)]
        foreground: bool,
        #[arg(long)]
        json: bool,
    },
    Status {
        #[arg(long)]
        json: bool,
    },
    Stop,
}

#[derive(Serialize, Deserialize)]
pub struct ServerInfo {
    pid: u32,
    port: u16,
    instance_id: String,
    protocol: u32,
}

fn config_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    Ok(PathBuf::from(home).join(".config/wangcai"))
}

fn rpc(info: &ServerInfo, op: &str) -> Result<Value> {
    let addr = SocketAddr::from(([127, 0, 0, 1], info.port));
    let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let (mut ws, _) = tungstenite::client(format!("ws://{addr}"), stream)?;
    ws.send(Message::text(
        json!({"id":"cli", "op":op, "instance_id":info.instance_id}).to_string(),
    ))?;
    let value: Value = serde_json::from_str(ws.read()?.to_text()?)?;
    if value["error"].is_string() {
        bail!("{}", value["error"]);
    }
    Ok(value["result"].clone())
}

fn running_info() -> Result<ServerInfo> {
    let path = config_dir()?.join("server.json");
    let info: ServerInfo = serde_json::from_slice(
        &fs::read(path).context("Node is not running. Run: wangcai server start")?,
    )?;
    let actual: ServerInfo = serde_json::from_value(
        rpc(&info, "info")
            .context("Node is unreachable; its state file may be stale. Run: wangcai server start")?,
    )?;
    if actual.instance_id != info.instance_id || actual.pid != info.pid || actual.protocol != 1 {
        bail!("Node instance does not match server.json");
    }
    Ok(actual)
}

fn main() -> Result<()> {
    let Cli {
        command: RootCommand::Server { command },
    } = Cli::parse();
    match command {
        ServerCommand::Status { json: as_json } => {
            let info = running_info()?;
            if as_json {
                println!("{}", serde_json::to_string(&info)?);
            } else {
                println!("Wangcai running: pid {}, 127.0.0.1:{}", info.pid, info.port);
            }
        }
        ServerCommand::Stop => {
            let info = running_info()?;
            rpc(&info, "stop")?;
            for _ in 0..50 {
                if running_info().is_err() {
                    println!("Wangcai stopped");
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            bail!("Node did not stop within 5 seconds");
        }
        ServerCommand::Start {
            foreground: false,
            json: as_json,
        } => {
            let dir = config_dir()?;
            fs::create_dir_all(&dir)?;
            let startup = fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(dir.join("startup.lock"))?;
            startup.lock_exclusive()?;
            if let Ok(info) = running_info() {
                if as_json {
                    println!("{}", serde_json::to_string(&info)?);
                } else {
                    println!("Wangcai already running on 127.0.0.1:{}", info.port);
                }
                return Ok(());
            }
            let log = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("server.log"))?;
            let mut cmd = Command::new(std::env::current_exe()?);
            cmd.args(["server", "start", "--foreground"])
                .stdin(Stdio::null())
                .stdout(log.try_clone()?)
                .stderr(log);
            unsafe {
                cmd.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let mut child = cmd.spawn()?;
            for _ in 0..100 {
                if let Ok(info) = running_info() {
                    if as_json {
                        println!("{}", serde_json::to_string(&info)?);
                    } else {
                        println!("Wangcai started on 127.0.0.1:{}", info.port);
                    }
                    return Ok(());
                }
                if let Some(status) = child.try_wait()? {
                    bail!(
                        "Node exited ({status}); see {}",
                        dir.join("server.log").display()
                    );
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            bail!(
                "Node startup timed out; see {}",
                dir.join("server.log").display()
            );
        }
        ServerCommand::Start {
            foreground: true, ..
        } => {
            let dir = config_dir()?;
            fs::create_dir_all(&dir)?;
            let lock = fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(dir.join("server.lock"))?;
            lock.try_lock_exclusive()
                .context("Wangcai node is already running")?;
            tokio::runtime::Runtime::new()?.block_on(async {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
                let info = ServerInfo {
                    pid: std::process::id(),
                    port: listener.local_addr()?.port(),
                    instance_id: uuid::Uuid::new_v4().to_string(),
                    protocol: 1,
                };
                let tmp = dir.join("server.json.tmp");
                let mut file = fs::File::create(&tmp)?;
                file.write_all(serde_json::to_string(&info)?.as_bytes())?;
                file.sync_all()?;
                fs::rename(tmp, dir.join("server.json"))?;
                let result = server::run(listener, info).await;
                let _ = fs::remove_file(dir.join("server.json"));
                result
            })?;
        }
    }
    Ok(())
}

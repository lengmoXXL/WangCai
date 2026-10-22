//! What a terminal and the node say to each other over their socket: where it is, the text that
//! asks, the record that describes a terminal, the packets that carry a header and the bytes it
//! describes, and what a size may be.

use crate::ServerInfo;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::net::SocketAddr;
use tokio_tungstenite::tungstenite::Message;

pub fn address(info: &ServerInfo) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], info.port))
}

pub fn endpoint(info: &ServerInfo) -> String {
    format!("ws://{}", address(info))
}

/// A request, in the shape every operation shares.
pub fn request(op: &str, fields: impl IntoIterator<Item = (&'static str, Value)>) -> Message {
    let mut request = Map::new();
    request.insert("id".to_owned(), json!("cli"));
    request.insert("op".to_owned(), json!(op));
    request.extend(
        fields
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value)),
    );
    Message::text(Value::Object(request).to_string())
}

#[derive(Serialize, Deserialize)]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub label: Option<String>,
    pub pid: u32,
    pub rows: u16,
    pub cols: u16,
    pub exit_code: Option<u32>,
}

pub fn packet(header: Value, data: &[u8]) -> Message {
    let header = header.to_string();
    let mut bytes = Vec::with_capacity(4 + header.len() + data.len());
    bytes.extend((header.len() as u32).to_be_bytes());
    bytes.extend(header.as_bytes());
    bytes.extend(data);
    Message::Binary(bytes.into())
}

pub fn payload(bytes: &[u8]) -> Option<&[u8]> {
    let length = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
    bytes.get(4 + length..)
}

pub const MIN_ROWS: u16 = 2;
pub const MAX_ROWS: u16 = 300;
pub const MIN_COLS: u16 = 2;
pub const MAX_COLS: u16 = 500;
pub const DEFAULT_ROWS: u16 = 24;
pub const DEFAULT_COLS: u16 = 80;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

pub const MCP_REQUEST_EVENT: &str = "mcp:request";
const PROTOCOL_VERSION: u8 = 1;
const MAX_FRAME_BYTES: u64 = 1024 * 1024;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(100);
const READ_POLL_TIMEOUT: Duration = Duration::from_millis(500);

static SESSION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpBridgeSessionInfo {
    pub session_id: String,
    pub port: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpBridgeRequestEvent {
    session_id: String,
    request_id: String,
    method: String,
    params: Value,
}

#[derive(Debug, Deserialize)]
struct IncomingRequest {
    version: u8,
    id: String,
    token: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct OutgoingResponse {
    version: u8,
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<McpBridgeError>,
}

#[derive(Debug, Serialize)]
struct McpBridgeError {
    code: String,
    message: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpBridgeResponseInput {
    session_id: String,
    request_id: String,
    ok: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug)]
struct FrontendResponse {
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
}

struct BridgeSession {
    info: McpBridgeSessionInfo,
    active: Arc<AtomicBool>,
    pending: Arc<Mutex<HashMap<String, mpsc::SyncSender<FrontendResponse>>>>,
}

#[derive(Default)]
pub struct McpBridgeState {
    session: Mutex<Option<BridgeSession>>,
}

fn validate_token(token: &str) -> Result<(), String> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("MCP 会话令牌必须是 256 位十六进制字符串".to_string());
    }
    Ok(())
}

fn token_matches(expected: &str, provided: &str) -> bool {
    if expected.len() != provided.len() {
        return false;
    }
    expected
        .bytes()
        .zip(provided.bytes())
        .fold(0_u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

fn validate_method(method: &str) -> Result<(), String> {
    match method {
        "tools/list" | "tools/call" | "requests/cancel" => Ok(()),
        _ => Err(format!("不支持的 MCP bridge 方法: {method}")),
    }
}

fn parse_request(line: &str, expected_token: &str) -> Result<IncomingRequest, String> {
    let request: IncomingRequest =
        serde_json::from_str(line).map_err(|_| "MCP bridge 请求不是有效 JSON".to_string())?;
    if request.version != PROTOCOL_VERSION {
        return Err("MCP bridge 内部协议版本不兼容".to_string());
    }
    if request.id.is_empty() || request.id.len() > 128 {
        return Err("MCP bridge 请求 ID 无效".to_string());
    }
    if !token_matches(expected_token, &request.token) {
        return Err("MCP bridge 会话认证失败".to_string());
    }
    validate_method(&request.method)?;
    Ok(request)
}

fn response_error(id: impl Into<String>, code: &str, message: impl Into<String>) -> OutgoingResponse {
    OutgoingResponse {
        version: PROTOCOL_VERSION,
        id: id.into(),
        ok: false,
        result: None,
        error: Some(McpBridgeError {
            code: code.to_string(),
            message: message.into(),
        }),
    }
}

fn write_response(stream: &mut TcpStream, response: &OutgoingResponse) -> std::io::Result<()> {
    let mut encoded = serde_json::to_vec(response)?;
    encoded.push(b'\n');
    stream.write_all(&encoded)?;
    stream.flush()
}

fn handle_connection(
    app: AppHandle,
    mut stream: TcpStream,
    info: McpBridgeSessionInfo,
    token: String,
    active: Arc<AtomicBool>,
    client_connected: Arc<AtomicBool>,
    pending: Arc<Mutex<HashMap<String, mpsc::SyncSender<FrontendResponse>>>>,
) {
    let _connection_guard = ClientConnectionGuard(client_connected);
    let Ok(read_stream) = stream.try_clone() else {
        return;
    };
    let _ = read_stream.set_read_timeout(Some(READ_POLL_TIMEOUT));
    let mut reader = BufReader::new(read_stream);

    while active.load(Ordering::Acquire) {
        let mut line = String::new();
        let read_result = reader
            .by_ref()
            .take(MAX_FRAME_BYTES + 1)
            .read_line(&mut line);
        let bytes_read = match read_result {
            Ok(0) => break,
            Ok(bytes_read) => bytes_read as u64,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(_) => break,
        };
        if bytes_read > MAX_FRAME_BYTES || !line.ends_with('\n') {
            let _ = write_response(
                &mut stream,
                &response_error("invalid", "MCP_FRAME_TOO_LARGE", "MCP bridge 请求超过 1 MiB 上限"),
            );
            break;
        }

        let raw_id = serde_json::from_str::<Value>(&line)
            .ok()
            .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| "invalid".to_string());
        let request = match parse_request(line.trim_end(), &token) {
            Ok(request) => request,
            Err(message) => {
                let code = if message.contains("认证") {
                    "MCP_AUTH_FAILED"
                } else {
                    "MCP_REQUEST_INVALID"
                };
                let _ = write_response(&mut stream, &response_error(raw_id, code, message));
                if code == "MCP_AUTH_FAILED" {
                    break;
                }
                continue;
            }
        };

        let request_id = format!("{}:{}", info.session_id, request.id);
        let (sender, receiver) = mpsc::sync_channel(1);
        let inserted = pending
            .lock()
            .map(|mut requests| requests.insert(request_id.clone(), sender).is_none())
            .unwrap_or(false);
        if !inserted {
            let _ = write_response(
                &mut stream,
                &response_error(request.id, "MCP_DUPLICATE_ID", "MCP bridge 请求 ID 重复"),
            );
            continue;
        }

        let emitted = app.emit_to(
            "main",
            MCP_REQUEST_EVENT,
            McpBridgeRequestEvent {
                session_id: info.session_id.clone(),
                request_id: request_id.clone(),
                method: request.method,
                params: request.params,
            },
        );
        if emitted.is_err() {
            if let Ok(mut requests) = pending.lock() {
                requests.remove(&request_id);
            }
            let _ = write_response(
                &mut stream,
                &response_error(request.id, "MCP_FRONTEND_UNAVAILABLE", "AI Canvas 主窗口尚未就绪"),
            );
            continue;
        }

        let frontend_response = receiver.recv_timeout(RESPONSE_TIMEOUT);
        if let Ok(mut requests) = pending.lock() {
            requests.remove(&request_id);
        }
        let response = match frontend_response {
            Ok(frontend) if frontend.ok => OutgoingResponse {
                version: PROTOCOL_VERSION,
                id: request.id,
                ok: true,
                result: frontend.result.or(Some(Value::Null)),
                error: None,
            },
            Ok(frontend) => response_error(
                request.id,
                "MCP_FRONTEND_ERROR",
                frontend.error.unwrap_or_else(|| "AI Canvas MCP 请求失败".to_string()),
            ),
            Err(mpsc::RecvTimeoutError::Timeout) => response_error(
                request.id,
                "MCP_RESPONSE_TIMEOUT",
                "AI Canvas MCP 请求等待超时",
            ),
            Err(mpsc::RecvTimeoutError::Disconnected) => response_error(
                request.id,
                "MCP_SESSION_STOPPED",
                "AI Canvas MCP 会话已停止",
            ),
        };
        if write_response(&mut stream, &response).is_err() {
            break;
        }
    }
}

struct ClientConnectionGuard(Arc<AtomicBool>);

impl Drop for ClientConnectionGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn stop_session(session: BridgeSession) {
    session.active.store(false, Ordering::Release);
    if let Ok(mut requests) = session.pending.lock() {
        for (_, sender) in requests.drain() {
            let _ = sender.try_send(FrontendResponse {
                ok: false,
                result: None,
                error: Some("AI Canvas MCP 会话已停止".to_string()),
            });
        }
    }
}

#[tauri::command]
pub fn mcp_bridge_start(
    app: AppHandle,
    state: State<'_, McpBridgeState>,
    token: String,
) -> Result<McpBridgeSessionInfo, String> {
    validate_token(&token)?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("无法启动 MCP loopback bridge: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("无法配置 MCP loopback bridge: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("无法读取 MCP loopback 端口: {error}"))?
        .port();
    let epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = SESSION_SEQUENCE.fetch_add(1, Ordering::AcqRel) + 1;
    let info = McpBridgeSessionInfo {
        session_id: format!("mcp-{epoch_ms:x}-{sequence:x}"),
        port,
    };
    let active = Arc::new(AtomicBool::new(true));
    let client_connected = Arc::new(AtomicBool::new(false));
    let pending = Arc::new(Mutex::new(HashMap::new()));

    let mut current = state
        .session
        .lock()
        .map_err(|_| "MCP bridge 会话锁不可用".to_string())?;
    if let Some(previous) = current.take() {
        stop_session(previous);
    }
    *current = Some(BridgeSession {
        info: info.clone(),
        active: Arc::clone(&active),
        pending: Arc::clone(&pending),
    });
    drop(current);

    let thread_info = info.clone();
    thread::Builder::new()
        .name("ai-canvas-mcp-bridge".to_string())
        .spawn(move || {
            while active.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if client_connected
                            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                            .is_err()
                        {
                            let mut stream = stream;
                            let _ = write_response(
                                &mut stream,
                                &response_error(
                                    "connect",
                                    "MCP_CLIENT_ALREADY_CONNECTED",
                                    "当前 MCP 会话已有适配器连接",
                                ),
                            );
                            continue;
                        }
                        let connection_app = app.clone();
                        let connection_info = thread_info.clone();
                        let connection_token = token.clone();
                        let connection_active = Arc::clone(&active);
                        let connection_connected = Arc::clone(&client_connected);
                        let connection_pending = Arc::clone(&pending);
                        let _ = thread::Builder::new()
                            .name("ai-canvas-mcp-client".to_string())
                            .spawn(move || {
                                handle_connection(
                                    connection_app,
                                    stream,
                                    connection_info,
                                    connection_token,
                                    connection_active,
                                    connection_connected,
                                    connection_pending,
                                );
                            });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(ACCEPT_RETRY_DELAY);
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|error| format!("无法启动 MCP bridge 线程: {error}"))?;

    Ok(info)
}

#[tauri::command]
pub fn mcp_bridge_stop(state: State<'_, McpBridgeState>) -> Result<(), String> {
    let session = state
        .session
        .lock()
        .map_err(|_| "MCP bridge 会话锁不可用".to_string())?
        .take();
    if let Some(session) = session {
        stop_session(session);
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_bridge_status(
    state: State<'_, McpBridgeState>,
) -> Result<Option<McpBridgeSessionInfo>, String> {
    state
        .session
        .lock()
        .map_err(|_| "MCP bridge 会话锁不可用".to_string())
        .map(|session| session.as_ref().map(|current| current.info.clone()))
}

#[tauri::command]
pub fn mcp_bridge_respond(
    state: State<'_, McpBridgeState>,
    response: McpBridgeResponseInput,
) -> Result<(), String> {
    let session = state
        .session
        .lock()
        .map_err(|_| "MCP bridge 会话锁不可用".to_string())?;
    let Some(session) = session.as_ref() else {
        return Err("MCP bridge 会话未开启".to_string());
    };
    if session.info.session_id != response.session_id {
        return Err("MCP bridge 响应属于已失效会话".to_string());
    }
    let sender = session
        .pending
        .lock()
        .map_err(|_| "MCP bridge 请求锁不可用".to_string())?
        .remove(&response.request_id)
        .ok_or_else(|| "MCP bridge 请求不存在或已结束".to_string())?;
    sender
        .try_send(FrontendResponse {
            ok: response.ok,
            result: response.result,
            error: response.error,
        })
        .map_err(|_| "MCP bridge 请求已经结束".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "abababababababababababababababababababababababababababababababab";

    #[test]
    fn validates_256_bit_hex_tokens() {
        assert!(validate_token(TOKEN).is_ok());
        assert!(validate_token("short").is_err());
        assert!(validate_token(&"z".repeat(64)).is_err());
    }

    #[test]
    fn parses_only_authenticated_whitelisted_requests() {
        let valid = serde_json::json!({
            "version": 1,
            "id": "mcp-1",
            "token": TOKEN,
            "method": "tools/list",
            "params": {}
        })
        .to_string();
        assert_eq!(parse_request(&valid, TOKEN).unwrap().method, "tools/list");

        let wrong_token = valid.replace(TOKEN, &"cd".repeat(32));
        assert!(parse_request(&wrong_token, TOKEN)
            .unwrap_err()
            .contains("认证失败"));

        let unknown = valid.replace("tools/list", "shell/run");
        assert!(parse_request(&unknown, TOKEN)
            .unwrap_err()
            .contains("不支持"));
    }

    #[test]
    fn rejects_incompatible_protocol_and_invalid_ids() {
        let incompatible = serde_json::json!({
            "version": 2,
            "id": "mcp-1",
            "token": TOKEN,
            "method": "tools/list"
        })
        .to_string();
        assert!(parse_request(&incompatible, TOKEN)
            .unwrap_err()
            .contains("版本不兼容"));

        let invalid_id = serde_json::json!({
            "version": 1,
            "id": "",
            "token": TOKEN,
            "method": "tools/list"
        })
        .to_string();
        assert!(parse_request(&invalid_id, TOKEN)
            .unwrap_err()
            .contains("请求 ID 无效"));
    }
}

//! MCP 控制桥：本机 stdio 走 loopback 适配器，远程模式走 Streamable HTTP。
//! 两种传输共用前端 Tool Registry、Policy、审计与响应通道。

use axum::{
    body::Body,
    extract::{Request, State as AxumState},
    http::{
        header::{AUTHORIZATION, HOST, ORIGIN},
        HeaderMap, StatusCode,
    },
    middleware::{self, Next},
    response::Response,
    Router,
};
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ListToolsResult,
        ServerCapabilities, ServerInfo,
    },
    service::{RequestContext, RoleServer},
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;
use tower::limit::ConcurrencyLimitLayer;

pub const MCP_REQUEST_EVENT: &str = "mcp:request";
const PROTOCOL_VERSION: u8 = 1;
const MAX_FRAME_BYTES: u64 = 1024 * 1024;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(100);
/// 固定端口后同时接多个客户端（Claude Desktop、Cursor…）是常态，仍留上限防跑飞。
const MAX_CLIENTS: usize = 4;
const READ_POLL_TIMEOUT: Duration = Duration::from_millis(500);
const HTTP_ENDPOINT_PATH: &str = "/mcp";

static SESSION_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static CONNECTION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpTransport {
    #[default]
    Stdio,
    StreamableHttp,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpBridgeSessionInfo {
    pub session_id: String,
    pub port: u16,
    pub transport: McpTransport,
    pub bind_address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_path: Option<String>,
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
    cancellation: CancellationToken,
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
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
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

fn response_error(
    id: impl Into<String>,
    code: &str,
    message: impl Into<String>,
) -> OutgoingResponse {
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

fn write_shared_response(
    writer: &Arc<Mutex<TcpStream>>,
    response: &OutgoingResponse,
) -> std::io::Result<()> {
    let mut stream = writer
        .lock()
        .map_err(|_| std::io::Error::other("MCP bridge 响应锁不可用"))?;
    write_response(&mut stream, response)
}

fn handle_connection(
    app: AppHandle,
    stream: TcpStream,
    info: McpBridgeSessionInfo,
    token: String,
    active: Arc<AtomicBool>,
    connections: Arc<AtomicUsize>,
    pending: Arc<Mutex<HashMap<String, mpsc::SyncSender<FrontendResponse>>>>,
) {
    let _connection_guard = ClientConnectionGuard(connections);
    let connection_seq = CONNECTION_SEQUENCE.fetch_add(1, Ordering::AcqRel);
    let Ok(read_stream) = stream.try_clone() else {
        return;
    };
    let writer = Arc::new(Mutex::new(stream));
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
            let _ = write_shared_response(
                &writer,
                &response_error(
                    "invalid",
                    "MCP_FRAME_TOO_LARGE",
                    "MCP bridge 请求超过 1 MiB 上限",
                ),
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
                let _ = write_shared_response(&writer, &response_error(raw_id, code, message));
                if code == "MCP_AUTH_FAILED" {
                    break;
                }
                continue;
            }
        };

        let request_id = scope_request_id(&info.session_id, connection_seq, &request.id);
        // 取消请求指向的也是同一连接内的请求键，前端直接按键取消即可。
        let mut params = request.params;
        if request.method == "requests/cancel" {
            let target = params
                .get("requestId")
                .and_then(Value::as_str)
                .map(|target| scope_request_id(&info.session_id, connection_seq, target));
            if let (Some(target), Some(map)) = (target, params.as_object_mut()) {
                map.insert("requestId".to_string(), Value::String(target));
            }
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let inserted = pending
            .lock()
            .map(|mut requests| requests.insert(request_id.clone(), sender).is_none())
            .unwrap_or(false);
        if !inserted {
            let _ = write_shared_response(
                &writer,
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
                params,
            },
        );
        if emitted.is_err() {
            if let Ok(mut requests) = pending.lock() {
                requests.remove(&request_id);
            }
            let _ = write_shared_response(
                &writer,
                &response_error(
                    request.id,
                    "MCP_FRONTEND_UNAVAILABLE",
                    "AI Canvas 主窗口尚未就绪",
                ),
            );
            continue;
        }
        let response_writer = Arc::clone(&writer);
        let response_pending = Arc::clone(&pending);
        let _ = thread::Builder::new()
            .name("ai-canvas-mcp-response".to_string())
            .spawn(move || {
                let frontend_response = receiver.recv_timeout(RESPONSE_TIMEOUT);
                if let Ok(mut requests) = response_pending.lock() {
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
                        frontend
                            .error
                            .unwrap_or_else(|| "AI Canvas MCP 请求失败".to_string()),
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
                let _ = write_shared_response(&response_writer, &response);
            });
    }
}

struct ClientConnectionGuard(Arc<AtomicUsize>);

impl Drop for ClientConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// 请求键要带连接号：多个客户端各自生成 ID，重名会被误判成重复请求。
fn scope_request_id(session_id: &str, connection: u64, request_id: &str) -> String {
    format!("{session_id}:{connection:x}:{request_id}")
}

/// 占一个客户端名额；超上限时立刻退回，由调用方拒绝该连接。
fn try_acquire_client_slot(connections: &AtomicUsize) -> bool {
    if connections.fetch_add(1, Ordering::AcqRel) < MAX_CLIENTS {
        return true;
    }
    connections.fetch_sub(1, Ordering::AcqRel);
    false
}

fn forward_frontend_request(
    app: &AppHandle,
    info: &McpBridgeSessionInfo,
    pending: &Arc<Mutex<HashMap<String, mpsc::SyncSender<FrontendResponse>>>>,
    request_id: String,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let inserted = pending
        .lock()
        .map_err(|_| "MCP bridge 请求锁不可用".to_string())?
        .insert(request_id.clone(), sender)
        .is_none();
    if !inserted {
        return Err("MCP bridge 请求 ID 重复".to_string());
    }
    if app
        .emit_to(
            "main",
            MCP_REQUEST_EVENT,
            McpBridgeRequestEvent {
                session_id: info.session_id.clone(),
                request_id: request_id.clone(),
                method: method.to_string(),
                params,
            },
        )
        .is_err()
    {
        if let Ok(mut requests) = pending.lock() {
            requests.remove(&request_id);
        }
        return Err("AI Canvas 主窗口尚未就绪".to_string());
    }
    let received = receiver.recv_timeout(RESPONSE_TIMEOUT);
    if let Ok(mut requests) = pending.lock() {
        requests.remove(&request_id);
    }
    match received {
        Ok(response) if response.ok => Ok(response.result.unwrap_or(Value::Null)),
        Ok(response) => Err(response
            .error
            .unwrap_or_else(|| "AI Canvas MCP 请求失败".to_string())),
        Err(mpsc::RecvTimeoutError::Timeout) => Err("AI Canvas MCP 请求等待超时".to_string()),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("AI Canvas MCP 会话已停止".to_string()),
    }
}

#[derive(Clone)]
struct HttpMcpHandler {
    app: AppHandle,
    info: McpBridgeSessionInfo,
    pending: Arc<Mutex<HashMap<String, mpsc::SyncSender<FrontendResponse>>>>,
}

impl HttpMcpHandler {
    async fn request_frontend(
        &self,
        method: &'static str,
        params: Value,
        cancellation: CancellationToken,
    ) -> Result<Value, ErrorData> {
        let sequence = CONNECTION_SEQUENCE.fetch_add(1, Ordering::AcqRel);
        let request_id = format!("{}:http:{sequence:x}", self.info.session_id);
        let app = self.app.clone();
        let info = self.info.clone();
        let pending = Arc::clone(&self.pending);
        let target_id = request_id.clone();
        let request = tokio::task::spawn_blocking(move || {
            forward_frontend_request(&app, &info, &pending, request_id, method, params)
        });
        tokio::select! {
            result = request => result
                .map_err(|_| ErrorData::internal_error("AI Canvas MCP 转发任务异常结束", None))?
                .map_err(|message| ErrorData::internal_error(message, None)),
            _ = cancellation.cancelled() => {
                let app = self.app.clone();
                let info = self.info.clone();
                let pending = Arc::clone(&self.pending);
                let cancel_id = format!("{}:http-cancel:{sequence:x}", self.info.session_id);
                tokio::task::spawn_blocking(move || {
                    let _ = forward_frontend_request(
                        &app,
                        &info,
                        &pending,
                        cancel_id,
                        "requests/cancel",
                        serde_json::json!({ "requestId": target_id }),
                    );
                });
                Err(ErrorData::internal_error("AI Canvas MCP 请求已取消", None))
            }
        }
    }
}

impl ServerHandler for HttpMcpHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
    }

    async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let value = self
            .request_frontend("tools/list", serde_json::json!({}), context.ct)
            .await?;
        serde_json::from_value(value)
            .map_err(|_| ErrorData::internal_error("AI Canvas 返回了无效的工具列表", None))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let params = serde_json::json!({
            "name": request.name,
            "arguments": request.arguments.unwrap_or_default(),
        });
        let value = self
            .request_frontend("tools/call", params, context.ct)
            .await?;
        let result: CallToolResult = serde_json::from_value(value)
            .map_err(|_| ErrorData::internal_error("AI Canvas 返回了无效的工具结果", None))?;
        Ok(result.into())
    }
}

#[derive(Clone)]
struct HttpSecurity {
    token: String,
    port: u16,
}

fn parse_allowed_host(value: &str, port: u16) -> Option<String> {
    let parsed = url::Url::parse(&format!("http://{value}")).ok()?;
    let host = parsed.host_str()?;
    let normalized = host.to_ascii_lowercase();
    if !matches!(
        normalized.as_str(),
        "localhost" | "host.docker.internal" | "gateway.docker.internal"
    ) && host.parse::<Ipv4Addr>().is_err()
    {
        return None;
    }
    if parsed.port_or_known_default()? != port {
        return None;
    }
    Some(normalized)
}

fn validate_http_headers(headers: &HeaderMap, security: &HttpSecurity) -> Result<(), StatusCode> {
    let authorization = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !token_matches(&security.token, authorization) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let host_header = headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::BAD_REQUEST)?;
    let host = parse_allowed_host(host_header, security.port).ok_or(StatusCode::FORBIDDEN)?;
    if let Some(origin_header) = headers.get(ORIGIN) {
        let origin = origin_header.to_str().map_err(|_| StatusCode::FORBIDDEN)?;
        let parsed = url::Url::parse(origin).map_err(|_| StatusCode::FORBIDDEN)?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().map(str::to_ascii_lowercase).as_deref() != Some(host.as_str())
            || parsed.port_or_known_default() != Some(security.port)
        {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok(())
}

async fn authorize_http_request(
    AxumState(security): AxumState<HttpSecurity>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    validate_http_headers(request.headers(), &security)?;
    Ok(next.run(request).await)
}

fn run_streamable_http_server(
    listener: TcpListener,
    app: AppHandle,
    info: McpBridgeSessionInfo,
    pending: Arc<Mutex<HashMap<String, mpsc::SyncSender<FrontendResponse>>>>,
    token: String,
    cancellation: CancellationToken,
) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .thread_name("ai-canvas-mcp-http-worker")
        .build()
        .map_err(|error| format!("无法启动 MCP HTTP 运行时: {error}"))?;
    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::from_std(listener)
            .map_err(|error| format!("无法接管 MCP HTTP 监听器: {error}"))?;
        let handler = HttpMcpHandler {
            app,
            info: info.clone(),
            pending,
        };
        let service: StreamableHttpService<HttpMcpHandler, LocalSessionManager> =
            StreamableHttpService::new(
                move || Ok(handler.clone()),
                Default::default(),
                StreamableHttpServerConfig::default()
                    .with_json_response(true)
                    // 外层 middleware 只允许 IP/localhost Host，并校验同源 Origin。
                    // 关闭 SDK 的默认 loopback Host 列表，否则合法局域网 IP 会被二次拒绝。
                    .disable_allowed_hosts()
                    .with_max_request_body_bytes(MAX_FRAME_BYTES as usize)
                    .with_cancellation_token(cancellation.child_token()),
            );
        let security = HttpSecurity {
            token,
            port: info.port,
        };
        let router = Router::new()
            .nest_service(HTTP_ENDPOINT_PATH, service)
            .layer(ConcurrencyLimitLayer::new(MAX_CLIENTS))
            .layer(middleware::from_fn_with_state(
                security,
                authorize_http_request,
            ));
        axum::serve(listener, router)
            .with_graceful_shutdown(cancellation.cancelled_owned())
            .await
            .map_err(|error| format!("MCP HTTP 服务异常退出: {error}"))
    })
}

fn stop_session(session: BridgeSession) {
    session.active.store(false, Ordering::Release);
    session.cancellation.cancel();
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

/// 绑定回环监听：端口 0 表示随机。
///
/// 固定端口重启时旧 accept 线程最多还要 ACCEPT_RETRY_DELAY 才会退出并释放监听，
/// 所以固定端口失败后重试几次，避免「刚停就开」必然报端口占用。
fn bind_loopback(port: u16) -> Result<TcpListener, String> {
    let mut last_error = None;
    for _ in 0..10 {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
            Ok(listener) => return Ok(listener),
            Err(error) => {
                last_error = Some(error);
                if port == 0 {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
    let error = last_error.expect("bind 失败必然带错误");
    Err(if port == 0 {
        format!("无法启动 MCP loopback bridge: {error}")
    } else {
        format!("无法绑定 MCP 固定端口 {port}: {error}")
    })
}

fn bind_streamable_http(port: u16) -> Result<TcpListener, String> {
    let mut last_error = None;
    for _ in 0..10 {
        match TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)) {
            Ok(listener) => return Ok(listener),
            Err(error) => {
                last_error = Some(error);
                if port == 0 {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
    let error = last_error.expect("bind 失败必然带错误");
    Err(if port == 0 {
        format!("无法启动 MCP Streamable HTTP 服务: {error}")
    } else {
        format!("无法绑定 MCP HTTP 固定端口 {port}: {error}")
    })
}

#[tauri::command]
pub fn mcp_bridge_start(
    app: AppHandle,
    state: State<'_, McpBridgeState>,
    token: String,
    port: Option<u16>,
    transport: Option<McpTransport>,
) -> Result<McpBridgeSessionInfo, String> {
    validate_token(&token)?;
    let transport = transport.unwrap_or_default();
    // 固定端口要先放掉旧会话，否则新监听必然撞上自己上一次的端口。
    let previous = state
        .session
        .lock()
        .map_err(|_| "MCP bridge 会话锁不可用".to_string())?
        .take();
    if let Some(previous) = previous {
        stop_session(previous);
    }
    let listener = match transport {
        McpTransport::Stdio => bind_loopback(port.unwrap_or(0))?,
        McpTransport::StreamableHttp => bind_streamable_http(port.unwrap_or(0))?,
    };
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("无法配置 MCP loopback bridge: {error}"))?;
    let bound_port = listener
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
        port: bound_port,
        transport,
        bind_address: match transport {
            McpTransport::Stdio => Ipv4Addr::LOCALHOST.to_string(),
            McpTransport::StreamableHttp => Ipv4Addr::UNSPECIFIED.to_string(),
        },
        endpoint_path: (transport == McpTransport::StreamableHttp)
            .then(|| HTTP_ENDPOINT_PATH.to_string()),
        adapter_path: (transport == McpTransport::Stdio)
            .then(|| resolve_adapter_path(&app))
            .flatten(),
    };
    let active = Arc::new(AtomicBool::new(true));
    let connections = Arc::new(AtomicUsize::new(0));
    let pending = Arc::new(Mutex::new(HashMap::new()));
    let cancellation = CancellationToken::new();

    let mut current = state
        .session
        .lock()
        .map_err(|_| "MCP bridge 会话锁不可用".to_string())?;
    *current = Some(BridgeSession {
        info: info.clone(),
        active: Arc::clone(&active),
        pending: Arc::clone(&pending),
        cancellation: cancellation.clone(),
    });
    drop(current);

    let thread_info = info.clone();
    let thread_name = match transport {
        McpTransport::Stdio => "ai-canvas-mcp-bridge",
        McpTransport::StreamableHttp => "ai-canvas-mcp-http",
    };
    thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || match transport {
            McpTransport::Stdio => {
                while active.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            if !try_acquire_client_slot(&connections) {
                                let mut stream = stream;
                                let _ = write_response(
                                    &mut stream,
                                    &response_error(
                                        "connect",
                                        "MCP_CLIENT_LIMIT_REACHED",
                                        format!("当前 MCP 会话已连接 {MAX_CLIENTS} 个适配器"),
                                    ),
                                );
                                continue;
                            }
                            let connection_app = app.clone();
                            let connection_info = thread_info.clone();
                            let connection_token = token.clone();
                            let connection_active = Arc::clone(&active);
                            let connection_connected = Arc::clone(&connections);
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
            }
            McpTransport::StreamableHttp => {
                let _ = run_streamable_http_server(
                    listener,
                    app,
                    thread_info,
                    pending,
                    token,
                    cancellation,
                );
            }
        })
        .map_err(|error| format!("无法启动 MCP bridge 线程: {error}"))?;

    Ok(info)
}

fn resolve_adapter_path(app: &AppHandle) -> Option<String> {
    let roots = [
        std::env::current_dir().ok(),
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf)),
        app.path().resource_dir().ok(),
    ]
    .into_iter()
    .flatten();
    adapter_candidates(roots)
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

fn adapter_candidates(roots: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    roots
        .into_iter()
        .flat_map(|root| {
            let mut candidates = vec![
                root.join("ai-canvas-mcp.mjs"),
                root.join("resources").join("ai-canvas-mcp.mjs"),
            ];
            candidates.extend(
                root.ancestors()
                    .take(6)
                    .map(|directory| directory.join("scripts").join("ai-canvas-mcp.mjs")),
            );
            candidates
        })
        .collect()
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

    #[test]
    fn stopping_a_session_releases_pending_requests() {
        let active = Arc::new(AtomicBool::new(true));
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut requests = HashMap::new();
        requests.insert("session:request".to_string(), sender);
        let session = BridgeSession {
            info: McpBridgeSessionInfo {
                session_id: "session".to_string(),
                port: 43123,
                transport: McpTransport::Stdio,
                bind_address: "127.0.0.1".to_string(),
                endpoint_path: None,
                adapter_path: None,
            },
            active: Arc::clone(&active),
            pending: Arc::new(Mutex::new(requests)),
            cancellation: CancellationToken::new(),
        };

        stop_session(session);

        assert!(!active.load(Ordering::Acquire));
        let response = receiver.recv_timeout(Duration::from_millis(50)).unwrap();
        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some("AI Canvas MCP 会话已停止"));
    }

    #[test]
    fn client_slots_are_capped_and_released() {
        let connections = Arc::new(AtomicUsize::new(0));
        for _ in 0..MAX_CLIENTS {
            assert!(try_acquire_client_slot(&connections));
        }
        assert!(!try_acquire_client_slot(&connections));
        // 被拒的连接不能占用名额，否则一次超限就永久少一个位置
        assert_eq!(connections.load(Ordering::Acquire), MAX_CLIENTS);

        // 连接结束时 guard 归还名额
        drop(ClientConnectionGuard(Arc::clone(&connections)));
        assert!(try_acquire_client_slot(&connections));
    }

    #[test]
    fn request_ids_are_scoped_per_connection() {
        // 两个客户端各自生成的 ID 可能撞车，键必须靠连接号分开
        assert_ne!(
            scope_request_id("session", 0, "mcp-1"),
            scope_request_id("session", 1, "mcp-1"),
        );
        assert_eq!(scope_request_id("session", 10, "mcp-1"), "session:a:mcp-1");
    }

    #[test]
    fn binds_fixed_port_and_reports_conflict_clearly() {
        let random = bind_loopback(0).unwrap();
        let port = random.local_addr().unwrap().port();

        let error = bind_loopback(port).unwrap_err();
        assert!(error.contains(&format!("固定端口 {port}")), "{error}");

        // 释放后同一固定端口必须能重新绑定，对应「停止后按固定端口重开」
        drop(random);
        let rebound = bind_loopback(port).unwrap();
        assert_eq!(rebound.local_addr().unwrap().port(), port);
    }

    #[test]
    fn binds_remote_http_on_all_ipv4_interfaces() {
        let listener = bind_streamable_http(0).unwrap();
        let address = listener.local_addr().unwrap();
        assert_eq!(address.ip(), std::net::IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert_ne!(address.port(), 0);
    }

    #[test]
    fn http_security_requires_bearer_ip_host_and_matching_origin() {
        let security = HttpSecurity {
            token: TOKEN.to_string(),
            port: 43123,
        };
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, format!("Bearer {TOKEN}").parse().unwrap());
        headers.insert(HOST, "192.168.1.8:43123".parse().unwrap());
        assert_eq!(validate_http_headers(&headers, &security), Ok(()));

        headers.insert(HOST, "host.docker.internal:43123".parse().unwrap());
        assert_eq!(validate_http_headers(&headers, &security), Ok(()));
        headers.insert(HOST, "192.168.1.8:43123".parse().unwrap());

        headers.insert(ORIGIN, "http://192.168.1.8:43123".parse().unwrap());
        assert_eq!(validate_http_headers(&headers, &security), Ok(()));

        headers.insert(ORIGIN, "http://attacker.example:43123".parse().unwrap());
        assert_eq!(
            validate_http_headers(&headers, &security),
            Err(StatusCode::FORBIDDEN)
        );
        headers.remove(ORIGIN);

        headers.insert(HOST, "attacker.example:43123".parse().unwrap());
        assert_eq!(
            validate_http_headers(&headers, &security),
            Err(StatusCode::FORBIDDEN)
        );
        headers.insert(HOST, "192.168.1.8:43123".parse().unwrap());
        headers.insert(AUTHORIZATION, "Bearer wrong".parse().unwrap());
        assert_eq!(
            validate_http_headers(&headers, &security),
            Err(StatusCode::UNAUTHORIZED)
        );
    }

    #[test]
    fn adapter_lookup_walks_up_from_tauri_build_directories() {
        let candidates = adapter_candidates([PathBuf::from(
            "D:/workspace/AI-Canvas-tauri/src-tauri/target/debug",
        )]);
        assert!(candidates.contains(&PathBuf::from(
            "D:/workspace/AI-Canvas-tauri/scripts/ai-canvas-mcp.mjs",
        )));
        assert!(candidates.contains(&PathBuf::from(
            "D:/workspace/AI-Canvas-tauri/src-tauri/target/debug/ai-canvas-mcp.mjs",
        )));
    }
}

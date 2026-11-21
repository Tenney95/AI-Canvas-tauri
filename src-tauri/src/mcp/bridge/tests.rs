use super::*;

const TOKEN: &str = "abababababababababababababababababababababababababababababababab";

struct FragmentedReader {
    chunks: std::collections::VecDeque<std::io::Result<std::io::Cursor<Vec<u8>>>>,
}

impl Read for FragmentedReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        loop {
            match self.chunks.front_mut() {
                Some(Ok(chunk)) => match chunk.read(buffer)? {
                    0 => {
                        self.chunks.pop_front();
                    }
                    count => return Ok(count),
                },
                Some(Err(_)) => {
                    return Err(self.chunks.pop_front().unwrap().unwrap_err());
                }
                None => return Ok(0),
            }
        }
    }
}

fn fragmented_reader(chunks: Vec<std::io::Result<Vec<u8>>>) -> BufReader<FragmentedReader> {
    BufReader::new(FragmentedReader {
        chunks: chunks
            .into_iter()
            .map(|chunk| chunk.map(std::io::Cursor::new))
            .collect(),
    })
}

fn encoded_request(id: &str, params: Value) -> Vec<u8> {
    format!(
        "{}\n",
        serde_json::json!({
            "version": 1,
            "id": id,
            "token": TOKEN,
            "method": "tools/call",
            "params": params,
        })
    )
    .into_bytes()
}

#[test]
fn versioned_expected_context_stays_inside_arguments_without_connection_identity() {
    let context = serde_json::json!({
        "kind": "canvas", "schemaVersion": 2, "modelGeneration": 0,
        "runtimeEpoch": "runtime-epoch", "projectId": "owner", "projectEpoch": 3,
        "canvasId": "legacy-canvas", "episodeId": null, "canvasEpoch": 4, "canvasRevision": 9
    });
    let params = serde_json::json!({
        "name": "tools_call", "arguments": {
            "schemaVersion": 2, "name": "canvas_update_nodes", "arguments": {},
            "expectedContext": context, "operationKey": "original-intent"
        }
    });
    for id in ["first-connection", "second-connection"] {
        let encoded = encoded_request(id, params.clone());
        let line = String::from_utf8(encoded).unwrap();
        let request = parse_request(line.trim_end(), TOKEN).unwrap();
        assert_eq!(request.params, params);
        assert_eq!(request.params["arguments"]["expectedContext"], context);
    }
}

#[test]
fn upload_frame_preserves_bytes_across_would_block_and_timeout() {
    let data = format!("{}==", "A".repeat(349_526));
    let encoded = encoded_request(
        "upload",
        serde_json::json!({
            "name": "file_media_upload",
            "arguments": { "action": "append", "data": data },
        }),
    );
    let split = 200_000;
    let mut reader = fragmented_reader(vec![
        Ok(encoded[..8_191].to_vec()),
        Err(std::io::ErrorKind::WouldBlock.into()),
        Ok(encoded[8_191..split].to_vec()),
        Err(std::io::ErrorKind::TimedOut.into()),
        Ok(encoded[split..].to_vec()),
    ]);
    let mut partial = Vec::new();

    for (kind, length) in [
        (std::io::ErrorKind::WouldBlock, 8_191),
        (std::io::ErrorKind::TimedOut, split),
    ] {
        assert_eq!(
            read_request_frame(&mut reader, &mut partial)
                .unwrap_err()
                .kind(),
            kind
        );
        assert_eq!(partial, encoded[..length]);
    }
    let received = read_request_frame(&mut reader, &mut partial).unwrap();
    assert_eq!(received, encoded);
    assert!(partial.is_empty());
    let line = String::from_utf8(received).unwrap();
    let request = parse_request(line.trim_end(), TOKEN).unwrap();
    assert_eq!(
        request.params["arguments"]["data"].as_str(),
        Some(data.as_str())
    );
}

#[test]
fn request_frame_decodes_utf8_only_after_the_complete_line_arrives() {
    let encoded = encoded_request("utf8", serde_json::json!({ "name": "图片🙂" }));
    let split = encoded
        .windows(3)
        .position(|bytes| bytes == "图".as_bytes())
        .unwrap()
        + 1;
    let mut reader = fragmented_reader(vec![
        Ok(encoded[..split].to_vec()),
        Err(std::io::ErrorKind::TimedOut.into()),
        Ok(encoded[split..].to_vec()),
    ]);
    let mut partial = Vec::new();
    assert_eq!(
        read_request_frame(&mut reader, &mut partial)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::TimedOut
    );
    assert!(std::str::from_utf8(&partial).is_err());
    let received = read_request_frame(&mut reader, &mut partial).unwrap();
    let line = String::from_utf8(received).unwrap();
    assert_eq!(
        parse_request(line.trim_end(), TOKEN).unwrap().params["name"],
        "图片🙂"
    );
}

#[test]
fn request_frame_keeps_coalesced_requests_separate() {
    let first = encoded_request("first", serde_json::json!({}));
    let second = encoded_request("second", serde_json::json!({}));
    let mut reader = BufReader::new(std::io::Cursor::new(
        [first.clone(), second.clone()].concat(),
    ));
    let mut partial = Vec::new();
    assert_eq!(read_request_frame(&mut reader, &mut partial).unwrap(), first);
    assert_eq!(read_request_frame(&mut reader, &mut partial).unwrap(), second);
    assert!(read_request_frame(&mut reader, &mut partial)
        .unwrap()
        .is_empty());
}

#[test]
fn request_frame_limit_counts_retained_bytes_and_the_newline() {
    let request = encoded_request("limit", serde_json::json!({}));
    let mut encoded = vec![b' '; MAX_FRAME_BYTES as usize - request.len()];
    encoded.extend_from_slice(&request);
    let mut reader = BufReader::new(std::io::Cursor::new(encoded.clone()));
    let mut partial = Vec::new();
    let received = read_request_frame(&mut reader, &mut partial).unwrap();
    assert_eq!(received, encoded);
    assert_eq!(received.len() as u64, MAX_FRAME_BYTES);
    assert!(received.ends_with(b"\n"));

    let mut oversized = vec![b' '; MAX_FRAME_BYTES as usize];
    oversized.push(b'\n');
    let mut reader = fragmented_reader(vec![
        Ok(oversized[..4_096].to_vec()),
        Err(std::io::ErrorKind::TimedOut.into()),
        Ok(oversized[4_096..].to_vec()),
    ]);
    assert_eq!(
        read_request_frame(&mut reader, &mut partial)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::TimedOut
    );
    assert_eq!(partial.len(), 4_096);
    let received = read_request_frame(&mut reader, &mut partial).unwrap();
    assert_eq!(received.len() as u64, MAX_FRAME_BYTES + 1);
    assert!(received.ends_with(b"\n"));
    assert!(partial.is_empty());
}

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
fn disconnecting_only_releases_requests_from_that_connection() {
    let (own_sender, own_receiver) = mpsc::sync_channel(1);
    let (other_sender, other_receiver) = mpsc::sync_channel(1);
    let pending = Mutex::new(HashMap::from([
        ("session:a:request".to_string(), own_sender),
        ("session:ab:request".to_string(), other_sender),
    ]));

    let cancelled = remove_connection_requests(&pending, "session:a:");

    assert_eq!(cancelled, vec!["session:a:request".to_string()]);
    assert!(!own_receiver.try_recv().unwrap().ok);
    assert!(matches!(
        other_receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    assert_eq!(pending.lock().unwrap().len(), 1);
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
fn request_slots_limit_connections_and_the_whole_session_without_leaking_rejections() {
    let session = Arc::new(AtomicUsize::new(0));
    let first = Arc::new(AtomicUsize::new(0));
    let second = Arc::new(AtomicUsize::new(0));
    let third = Arc::new(AtomicUsize::new(0));
    let mut first_slots: Vec<_> = (0..MAX_CONNECTION_REQUESTS)
        .map(|_| try_acquire_request_slot(&session, &first).unwrap())
        .collect();
    assert!(try_acquire_request_slot(&session, &first).is_none());
    assert_eq!(session.load(Ordering::Acquire), MAX_CONNECTION_REQUESTS);

    let second_slots: Vec<_> = (0..MAX_CONNECTION_REQUESTS)
        .map(|_| try_acquire_request_slot(&session, &second).unwrap())
        .collect();
    assert_eq!(session.load(Ordering::Acquire), MAX_SESSION_REQUESTS);
    assert!(try_acquire_request_slot(&session, &third).is_none());
    assert_eq!(third.load(Ordering::Acquire), 0);

    drop(first_slots.pop());
    let replacement = try_acquire_request_slot(&session, &third).unwrap();
    drop(first_slots);
    drop(second_slots);
    drop(replacement);
    assert_eq!(session.load(Ordering::Acquire), 0);
    assert_eq!(first.load(Ordering::Acquire), 0);
    assert_eq!(second.load(Ordering::Acquire), 0);
    assert_eq!(third.load(Ordering::Acquire), 0);
}

#[test]
fn receiving_a_frontend_response_does_not_release_its_response_thread_slot() {
    let session = Arc::new(AtomicUsize::new(0));
    let connection = Arc::new(AtomicUsize::new(0));
    let slots: Vec<_> = (0..MAX_CONNECTION_REQUESTS)
        .map(|_| try_acquire_request_slot(&session, &connection).unwrap())
        .collect();
    let pending = Mutex::new(HashMap::new());
    let (sender, receiver) = mpsc::sync_channel(1);
    register_pending_request(&pending, "response-writing".to_string(), sender).unwrap();
    let sender = pending
        .lock()
        .unwrap()
        .get("response-writing")
        .unwrap()
        .clone();
    sender
        .try_send(FrontendResponse {
            ok: true,
            result: None,
            error: None,
        })
        .unwrap();
    assert!(receiver.try_recv().unwrap().ok);
    // 会话停止甚至可以清掉 pending；响应线程仍占额度，不能靠空 map 绕过上限。
    pending.lock().unwrap().clear();
    assert!(try_acquire_request_slot(&session, &connection).is_none());
    drop(slots);
    assert!(try_acquire_request_slot(&session, &connection).is_some());
}

#[test]
fn duplicate_request_keeps_the_original_sender_and_response() {
    let pending = Mutex::new(HashMap::new());
    let (original, original_receiver) = mpsc::sync_channel(1);
    let (duplicate, duplicate_receiver) = mpsc::sync_channel(1);
    register_pending_request(&pending, "same-id".to_string(), original).unwrap();

    assert!(register_pending_request(&pending, "same-id".to_string(), duplicate)
        .unwrap_err()
        .contains("重复"));
    assert!(matches!(
        original_receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    assert!(matches!(
        duplicate_receiver.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    ));
    let original = pending.lock().unwrap().get("same-id").unwrap().clone();
    original
        .try_send(FrontendResponse {
            ok: true,
            result: Some(serde_json::json!({ "original": true })),
            error: None,
        })
        .unwrap();
    assert_eq!(
        original_receiver.try_recv().unwrap().result,
        Some(serde_json::json!({ "original": true }))
    );
    // frontend 已返回也不允许同 ID 插队，直到原响应写完由等待线程清理。
    let (replacement, _) = mpsc::sync_channel(1);
    assert!(register_pending_request(&pending, "same-id".to_string(), replacement).is_err());
}

#[test]
fn cancellation_is_forwarded_once_only_for_a_known_connection_request() {
    let pending = Mutex::new(HashMap::new());
    let (sender, _receiver) = mpsc::sync_channel(1);
    register_pending_request(&pending, "session:a:request".to_string(), sender).unwrap();
    let mut cancelled = HashSet::new();
    assert_eq!(
        claim_connection_cancellation(&pending, &mut cancelled, "session:a:request"),
        (true, true)
    );
    assert_eq!(
        claim_connection_cancellation(&pending, &mut cancelled, "session:a:request"),
        (true, false)
    );
    assert_eq!(
        claim_connection_cancellation(&pending, &mut cancelled, "session:b:request"),
        (false, false)
    );
    assert_eq!(cancelled.len(), 1);
    assert_eq!(pending.lock().unwrap().len(), 1);
    pending.lock().unwrap().clear();
    assert_eq!(
        claim_connection_cancellation(&pending, &mut cancelled, "unknown"),
        (false, false)
    );
    assert!(cancelled.is_empty());
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

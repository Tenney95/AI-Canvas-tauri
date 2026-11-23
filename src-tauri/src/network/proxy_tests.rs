use super::*;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

fn test_request(url: String, method: &str) -> ProxyFetchRequest {
    ProxyFetchRequest {
        request_id: None, upload_diagnostic_id: None, url, method: method.into(), headers: Vec::new(),
        body: None, text_body: None,
    }
}

#[test]
fn macos_proxy_fallback_is_scoped_to_the_fixed_uguu_upload_endpoints() {
    for endpoint in ["https://uguu.se/upload.php", "https://uguu.se/upload"] {
        assert!(is_uguu_upload(&test_request(endpoint.into(), "POST")));
        assert!(!is_uguu_upload(&test_request(endpoint.into(), "GET")));
    }
    for url in [
        "http://uguu.se/upload",
        "http://uguu.se/upload.php",
        "https://uguu.se/upload?output=text",
        "https://uguu.se/upload.php?output=text",
        "https://uguu.se/upload.php/",
        "https://uguu.se.example/upload",
        "https://api.example/upload",
    ] {
        assert!(!is_uguu_upload(&test_request(url.into(), "POST")));
    }
}

#[test]
fn upload_diagnostics_remove_proxy_secrets_and_response_url_credentials() {
    assert_eq!(sanitized_upload_proxy("http://user:private-key@127.0.0.1:18719/path?token=private#fragment"),
        "http://127.0.0.1:18719");
    assert_eq!(sanitized_upload_proxy("127.0.0.1:18719"), "http://127.0.0.1:18719");
    assert_eq!(sanitized_upload_proxy("https://user:private-key@proxy.example/path"), "https://proxy.example:443");
    assert_eq!(sanitized_upload_proxy("socks5h://user:private-key@[::1]:1081/path"), "socks5h://[::1]:1081");
    for invalid in ["", "not a valid proxy", "file:///private/credentials", "http://proxy.example\nprivate"] {
        assert_eq!(sanitized_upload_proxy(invalid), "configured");
    }
    let response_url = Url::parse("https://user:private-key@upload.example/upload?token=private#private").unwrap();
    assert_eq!(sanitized_upload_response_url(&response_url), "https://upload.example/upload");
}

#[test]
fn upload_diagnostics_are_optional_and_use_camel_case_in_both_response_modes() {
    let legacy: ProxyFetchRequest = serde_json::from_value(serde_json::json!({
        "url": "https://upload.example/upload", "method": "POST", "headers": [], "body": null,
    })).unwrap();
    assert!(upload_diagnostic_user_agent(&legacy).is_none());
    let mut request = legacy;
    for invalid in [String::new(), "upload diagnostic".into(), "x".repeat(129)] {
        request.upload_diagnostic_id = Some(invalid);
        assert!(upload_diagnostic_user_agent(&request).is_none());
    }
    request.upload_diagnostic_id = Some("upload:diagnostic-1".into());
    assert_eq!(upload_diagnostic_user_agent(&request).as_deref(), Some("AI-Canvas/0.1"));
    request.headers.push(("uSeR-aGeNt".into(), "upload-fixture".into()));
    assert_eq!(upload_diagnostic_user_agent(&request).as_deref(), Some("upload-fixture"));
    let legacy_response = serde_json::to_value(ProxyFetchResponse {
        status: 502, body: String::new(), headers: Vec::new(), upload_diagnostics: None,
    }).unwrap();
    assert!(legacy_response.get("uploadDiagnostics").is_none());
    let legacy_meta = serde_json::to_value(ProxyFetchStreamEvent::Meta {
        status: 502, headers: Vec::new(), upload_diagnostics: None,
    }).unwrap();
    assert!(legacy_meta.get("uploadDiagnostics").is_none());
    let diagnostics = UploadDiagnostics {
        http_version: "HTTP/2.0".into(), remote_address: Some("127.0.0.1:18719".into()),
        final_url: "https://upload.example/upload".into(), proxy_environment: Vec::new(),
        no_proxy_present: false, proxy_snapshot_time_ms: 123, user_agent: "upload-fixture".into(),
        proxy_policy: "reqwest automatic; actual route not exposed",
    };
    let response = serde_json::to_value(ProxyFetchResponse {
        status: 502, body: String::new(), headers: Vec::new(), upload_diagnostics: Some(diagnostics.clone()),
    }).unwrap();
    let meta = serde_json::to_value(ProxyFetchStreamEvent::Meta {
        status: 502, headers: Vec::new(), upload_diagnostics: Some(diagnostics),
    }).unwrap();
    assert_eq!(meta["event"], "meta");
    assert_eq!(response["uploadDiagnostics"], meta["uploadDiagnostics"]);
    assert_eq!(response["uploadDiagnostics"]["proxySnapshotTimeMs"], 123);
    assert_eq!(response["uploadDiagnostics"]["httpVersion"], "HTTP/2.0");
    assert!(response.get("upload_diagnostics").is_none());
}

fn read_test_request(listener: &TcpListener) -> (TcpStream, String) {
    listener.set_nonblocking(true).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(std::time::Instant::now() < deadline, "未收到预期测试请求");
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("接收测试请求失败: {error}"),
        }
    };
    stream.set_nonblocking(false).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 16 * 1024, "测试请求头超过上限");
    }
    let headers = String::from_utf8(bytes.clone()).unwrap();
    let body_len = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().unwrap())
    }).unwrap_or(0);
    assert!(body_len < 1024, "测试请求体超过上限");
    let mut body = vec![0; body_len];
    stream.read_exact(&mut body).unwrap();
    bytes.extend_from_slice(&body);
    (stream, String::from_utf8(bytes).unwrap())
}

fn serve_test_responses(
    listener: TcpListener,
    responses: Vec<String>,
) -> std::thread::JoinHandle<Vec<String>> {
    std::thread::spawn(move || responses.into_iter().map(|response| {
        let (mut stream, request) = read_test_request(&listener);
        stream.write_all(response.as_bytes()).unwrap();
        request
    }).collect())
}

#[test]
fn only_headerless_and_queryless_get_or_head_downloads_are_public() {
    for method in ["GET", "HEAD"] {
        let request = test_request("https://cdn.example/image.png".into(), method);
        assert!(is_public_proxy_download(&request));
    }
    for url in [
        "https://cdn.example/image.png?arbitrary-name=private-key",
        "https://cdn.example/image.png?",
        "https://user:secret@cdn.example/image.png",
        "ftp://cdn.example/image.png",
        "not a URL",
    ] {
        assert!(!is_public_proxy_download(&test_request(url.into(), "GET")));
    }
    for header in ["Authorization", "X-API-Key", "X-Goog-Api-Key", "X-Private-Token", "Accept", "Range"] {
        let mut request = test_request("https://cdn.example/image.png".into(), "GET");
        request.headers.push((header.into(), "private-key".into()));
        assert!(!is_public_proxy_download(&request));
    }
    let mut request = test_request("https://api.example/generate".into(), "POST");
    assert!(!is_public_proxy_download(&request));
    request.method = "GET".into();
    request.text_body = Some(String::new());
    assert!(!is_public_proxy_download(&request));
    request.text_body = None;
    request.body = Some(String::new());
    assert!(!is_public_proxy_download(&request));
}

#[test]
fn redirect_policy_checks_origins_downgrades_target_credentials_and_hop_limit() {
    let origin = reqwest::Url::parse("https://api.example/start").unwrap();
    for strict in [true, false] {
        for target in [
            "http://api.example/final", "file:///private/resource",
            "https://user:secret@api.example/final",
        ] {
            let target = reqwest::Url::parse(target).unwrap();
            assert!(proxy_redirect_rejection(&target, &[origin.clone()], strict).is_some());
        }
        let target = reqwest::Url::parse("https://api.example/final").unwrap();
        assert!(proxy_redirect_rejection(&target, &[], strict).is_some());
        assert!(proxy_redirect_rejection(&target, &vec![origin.clone(); 11], strict).is_some());
        assert!(proxy_redirect_rejection(&target, &vec![origin.clone(); 10], strict).is_none());
    }
    for target in ["https://other.example/final", "https://api.example:444/final"] {
        let target = reqwest::Url::parse(target).unwrap();
        assert!(proxy_redirect_rejection(&target, &[origin.clone()], true).is_some());
        assert!(proxy_redirect_rejection(&target, &[origin.clone()], false).is_none());
    }
    let default_port = reqwest::Url::parse("https://api.example:443/final").unwrap();
    assert!(proxy_redirect_rejection(&default_port, &[origin], true).is_none());
    let upgraded = reqwest::Url::parse("https://cdn.example/final").unwrap();
    let insecure = reqwest::Url::parse("http://download.example/start").unwrap();
    assert!(proxy_redirect_rejection(&upgraded, &[insecure], false).is_none());
}

#[tokio::test]
async fn explicit_headers_queries_and_post_bodies_never_reach_a_redirected_origin() {
    let state = ProxyHttpState::new().unwrap();
    let mut cases = Vec::new();
    for header in ["Authorization", "X-API-Key", "X-Goog-Api-Key", "X-Private-Token", "aCcEpT", "Range"] {
        for status in ["302 Found", "307 Temporary Redirect"] {
            cases.push((Some(header), "GET", status, false));
        }
    }
    cases.extend([(None, "GET", "302 Found", true), (None, "POST", "307 Temporary Redirect", false)]);
    for (header, method, status, query) in cases {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut request = test_request(format!("http://{}/start", source.local_addr().unwrap()), method);
        if let Some(header) = header { request.headers.push((header.into(), "private-key".into())); }
        if query { request.url.push_str("?arbitrary-name=private-key"); }
        if method == "POST" { request.text_body = Some("private request body".into()); }
        let server = serve_test_responses(source, vec![format!(
            "HTTP/1.1 {status}\r\nLocation: http://{}/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            target.local_addr().unwrap(),
        )]);
        let message = send_proxy_request(&state, request).await.unwrap_err();
        assert!(message.contains("请求失败"));
        assert!(message.contains("重定向被安全策略拒绝"));
        assert!(!message.contains("private-key"));
        assert!(!message.contains("127.0.0.1"));
        assert_eq!(server.join().unwrap().len(), 1);
        assert!(matches!(target.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock));
    }
}

#[tokio::test]
async fn public_downloads_follow_cross_origin_redirects_without_automatic_referer() {
    let state = ProxyHttpState::new().unwrap();
    for method in ["GET", "HEAD"] {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let request = test_request(format!("http://{}/start", source.local_addr().unwrap()), method);
        let source_server = serve_test_responses(source, vec![format!(
            "HTTP/1.1 302 Found\r\nLocation: http://{}/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            target.local_addr().unwrap(),
        )]);
        let target_server = serve_test_responses(target, vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".into(),
        ]);
        let (response, _) = send_proxy_request(&state, request).await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(source_server.join().unwrap().len(), 1);
        let requests = target_server.join().unwrap();
        assert!(requests[0].starts_with(&format!("{method} /final ")));
        assert!(!requests[0].to_ascii_lowercase().contains("\r\nreferer:"));
    }
}

#[tokio::test]
async fn same_origin_307_preserves_headers_and_post_body() {
    let state = ProxyHttpState::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut request = test_request(format!("http://{}/start", listener.local_addr().unwrap()), "POST");
    request.headers.push(("X-Private-Token".into(), "private-key".into()));
    request.text_body = Some("private request body".into());
    let server = serve_test_responses(listener, vec![
        "HTTP/1.1 307 Temporary Redirect\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".into(),
    ]);
    let (response, _) = send_proxy_request(&state, request).await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].starts_with("POST /final "));
    assert!(requests[1].to_ascii_lowercase().contains("\r\nx-private-token: private-key\r\n"));
    assert!(requests[1].ends_with("private request body"));
    assert!(!requests[1].to_ascii_lowercase().contains("\r\nreferer:"));
}

#[tokio::test]
async fn duplicate_bodies_are_rejected_before_waiting_for_a_slot() {
    let req: ProxyFetchRequest = serde_json::from_value(serde_json::json!({
        "url": "http://127.0.0.1:1/", "method": "POST", "headers": [],
        "body": "YQ==", "textBody": "文本"
    })).unwrap();
    let state = ProxyHttpState { body_slots: tokio::sync::Semaphore::new(0), ..ProxyHttpState::new().unwrap() };
    let result = tokio::time::timeout(
        Duration::from_millis(200), send_proxy_request(&state, req),
    ).await.expect("格式错误不应排队或发送");
    assert!(result.unwrap_err().contains("格式重复"));
}

#[tokio::test]
async fn invalid_legacy_base64_releases_its_slot_without_sending() {
    let req: ProxyFetchRequest = serde_json::from_value(serde_json::json!({
        "url": "http://127.0.0.1:1/", "method": "POST", "headers": [], "body": "invalid!"
    })).unwrap();
    assert!(req.text_body.is_none());
    let state = ProxyHttpState { body_slots: tokio::sync::Semaphore::new(1), ..ProxyHttpState::new().unwrap() };
    let result = send_proxy_request(&state, req).await;
    assert!(result.unwrap_err().contains("base64"));
    assert_eq!(state.body_slots.available_permits(), 1);
}

#[tokio::test]
async fn transport_errors_do_not_expose_request_url_or_credentials() {
    let error = reqwest::Client::new()
        .get("http://user:secret@127.0.0.1:1/?api_key=private-key")
        .header("invalid header", "value")
        .send()
        .await
        .unwrap_err();
    let message = proxy_transport_error(error);
    assert!(message.contains("提交结果尚未确认"));
    assert!(!message.contains("secret"));
    assert!(!message.contains("private-key"));
    assert!(!message.contains("127.0.0.1"));
}

#[test]
fn response_size_limit_accepts_exact_limit_and_rejects_overflow() {
    assert_eq!(checked_response_size(60, 4, 64, "测试响应"), Ok(64));
    assert!(checked_response_size(60, 5, 64, "测试响应").is_err());
    assert!(checked_response_size(usize::MAX, 1, usize::MAX, "测试响应").is_err());
}

#[test]
fn cancellation_registration_cleans_up_when_dropped() {
    let cancellations = Mutex::default();
    let (sender, _receiver) = tokio::sync::oneshot::channel();

    {
        let _registration = ProxyFetchCancellationRegistration::register(
            &cancellations,
            "request-1".to_string(),
            sender,
        )
        .expect("应成功注册取消句柄");
        assert!(lock_proxy_fetch_cancellations(&cancellations)
            .active
            .contains_key("request-1"));
    }

    assert!(lock_proxy_fetch_cancellations(&cancellations).active.is_empty());
}

#[test]
fn early_cancellation_waits_for_registration_without_expiring_or_growing_on_duplicates() {
    let cancellations = Mutex::default();
    cancel_proxy_request(&cancellations, "delayed-request").unwrap();
    cancel_proxy_request(&cancellations, "delayed-request").unwrap();
    let (sender, _receiver) = tokio::sync::oneshot::channel();
    let other = ProxyFetchCancellationRegistration::register(
        &cancellations,
        "other-request".into(),
        sender,
    )
    .unwrap();
    drop(other);
    assert_eq!(
        lock_proxy_fetch_cancellations(&cancellations).early_cancelled.len(),
        1
    );

    let (sender, _receiver) = tokio::sync::oneshot::channel();
    let error = ProxyFetchCancellationRegistration::register(
        &cancellations,
        "delayed-request".into(),
        sender,
    )
    .err()
    .expect("提前取消的请求不能开始发送");
    assert_eq!(error, "请求已取消");
    let registry = lock_proxy_fetch_cancellations(&cancellations);
    assert!(registry.active.is_empty());
    assert!(registry.early_cancelled.is_empty());
    assert!(!registry.overflowed);
}

#[test]
fn cancelled_active_id_remains_reserved_until_its_registration_drops() {
    let cancellations = Mutex::default();
    let (sender, mut receiver) = tokio::sync::oneshot::channel();
    let registration = ProxyFetchCancellationRegistration::register(
        &cancellations,
        "active-request".into(),
        sender,
    )
    .unwrap();
    cancel_proxy_request(&cancellations, "active-request").unwrap();
    assert_eq!(receiver.try_recv(), Ok(()));
    cancel_proxy_request(&cancellations, "active-request").unwrap();
    let (sender, _receiver) = tokio::sync::oneshot::channel();
    let error = ProxyFetchCancellationRegistration::register(
        &cancellations,
        "active-request".into(),
        sender,
    )
    .err()
    .expect("旧请求结束前不能复用 ID");
    assert!(error.contains("重复"));
    assert!(lock_proxy_fetch_cancellations(&cancellations)
        .early_cancelled
        .is_empty());
    drop(registration);
    assert!(lock_proxy_fetch_cancellations(&cancellations).active.is_empty());
    let (sender, _receiver) = tokio::sync::oneshot::channel();
    let replacement = ProxyFetchCancellationRegistration::register(
        &cancellations,
        "active-request".into(),
        sender,
    )
    .unwrap();
    drop(replacement);
    assert!(lock_proxy_fetch_cancellations(&cancellations).active.is_empty());
}

#[test]
fn early_cancellation_overflow_fails_closed_even_after_known_ids_are_consumed() {
    let cancellations = Mutex::default();
    let (sender, mut receiver) = tokio::sync::oneshot::channel();
    let active = ProxyFetchCancellationRegistration::register(
        &cancellations,
        "active-request".into(),
        sender,
    )
    .unwrap();
    for index in 0..PROXY_MAX_EARLY_CANCELLATIONS {
        cancel_proxy_request(&cancellations, &format!("early-{index}")).unwrap();
    }
    cancel_proxy_request(&cancellations, "early-0").unwrap();
    assert!(cancel_proxy_request(&cancellations, "unrecorded-cancellation")
        .unwrap_err()
        .contains("重启"));
    // 饱和后仍要接收已有请求的取消，不能因保护状态锁住停止入口。
    cancel_proxy_request(&cancellations, "active-request").unwrap();
    assert_eq!(receiver.try_recv(), Ok(()));
    drop(active);
    let (sender, _receiver) = tokio::sync::oneshot::channel();
    let consumed = ProxyFetchCancellationRegistration::register(
        &cancellations,
        "early-0".into(),
        sender,
    )
    .err()
    .expect("已记录的提前取消仍应消费");
    assert_eq!(consumed, "请求已取消");
    for index in 0..1024 {
        assert!(cancel_proxy_request(&cancellations, &format!("overflow-{index}")).is_err());
    }
    for id in ["new-request", "unrecorded-cancellation"] {
        let (sender, _receiver) = tokio::sync::oneshot::channel();
        let error =
            ProxyFetchCancellationRegistration::register(&cancellations, id.into(), sender)
                .err()
                .expect("无法还原的取消必须让后续注册保持关闭");
        assert!(error.contains("重启"));
    }
    let registry = lock_proxy_fetch_cancellations(&cancellations);
    assert!(registry.active.is_empty());
    assert_eq!(
        registry.early_cancelled.len(),
        PROXY_MAX_EARLY_CANCELLATIONS - 1
    );
    assert!(registry.overflowed);
}

#[test]
fn active_request_limit_recovers_when_an_existing_registration_drops() {
    let cancellations = Mutex::default();
    let mut registrations = Vec::new();
    for index in 0..PROXY_MAX_ACTIVE_REQUESTS {
        let (sender, _receiver) = tokio::sync::oneshot::channel();
        registrations.push(
            ProxyFetchCancellationRegistration::register(
                &cancellations,
                format!("active-{index}"),
                sender,
            )
            .unwrap(),
        );
    }
    let (sender, _receiver) = tokio::sync::oneshot::channel();
    let error = ProxyFetchCancellationRegistration::register(
        &cancellations,
        "over-capacity".into(),
        sender,
    )
    .err()
    .expect("在途请求必须有界");
    assert!(error.contains("等待已有请求"));
    drop(registrations.pop());
    let (sender, _receiver) = tokio::sync::oneshot::channel();
    registrations.push(
        ProxyFetchCancellationRegistration::register(
            &cancellations,
            "after-capacity-released".into(),
            sender,
        )
        .unwrap(),
    );
    drop(registrations);
    let registry = lock_proxy_fetch_cancellations(&cancellations);
    assert!(registry.active.is_empty());
    assert!(!registry.overflowed);
}

#[test]
fn invalid_request_ids_never_allocate_cancellation_state() {
    let cancellations = Mutex::default();
    for id in [
        String::new(),
        "a".repeat(PROXY_MAX_REQUEST_ID_BYTES + 1),
        "中".repeat(86),
    ] {
        assert!(cancel_proxy_request(&cancellations, &id).is_err());
        let (sender, _receiver) = tokio::sync::oneshot::channel();
        assert!(
            ProxyFetchCancellationRegistration::register(&cancellations, id, sender).is_err()
        );
    }
    let boundary = format!("{}a", "中".repeat(85));
    assert_eq!(boundary.len(), PROXY_MAX_REQUEST_ID_BYTES);
    let (sender, _receiver) = tokio::sync::oneshot::channel();
    let valid =
        ProxyFetchCancellationRegistration::register(&cancellations, boundary, sender).unwrap();
    drop(valid);
    let registry = lock_proxy_fetch_cancellations(&cancellations);
    assert!(registry.active.is_empty());
    assert!(registry.early_cancelled.is_empty());
    assert!(!registry.overflowed);
}

#[tokio::test]
async fn registered_cancellation_is_checked_before_polling_the_network_request() {
    let cancellations = Mutex::default();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let registration = ProxyFetchCancellationRegistration::register(
        &cancellations,
        "not-started".into(),
        sender,
    )
    .unwrap();
    cancel_proxy_request(&cancellations, "not-started").unwrap();
    let mut polled = false;
    let request = async {
        polled = true;
        Ok(())
    };
    let result = run_cancellable_proxy_request(receiver, request).await;
    assert_eq!(result.unwrap_err(), "请求已取消");
    assert!(!polled);
    drop(registration);
    assert!(lock_proxy_fetch_cancellations(&cancellations).active.is_empty());
}

use super::*;
use std::io::Cursor;

#[test]
fn generated_image_format_uses_actual_gif_container_without_rewriting_animation() {
    let directory = test_directory("gif-original");
    let path = directory.join("opaque.png");
    // GIF 逻辑画布可不同于单帧和生成请求的尺寸。
    let bytes = b"GIF89a\x40\x01\xc8\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x21\xf9\x04\x01\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b";
    fs::write(&path, bytes).unwrap();
    assert_eq!(validate_downloaded_image(&path).unwrap(), "image/gif");
    assert_eq!(image::ImageReader::open(&path).unwrap().with_guessed_format().unwrap().into_dimensions().unwrap(), (320, 200));
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn generated_svg_checks_image_root_dimensions_and_keeps_original_bytes() {
    let bytes = b"<?xml version=\"1.0\"?>\n<!-- original -->\n<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 320 200\"><path d=\"M0 0h1\"/></svg>";
    assert_eq!(validate_svg_image_bytes(bytes).unwrap(), (320, 200));
    let directory = test_directory("svg-original");
    let path = directory.join("opaque.png");
    fs::write(&path, bytes).unwrap();
    assert_eq!(validate_downloaded_image(&path).unwrap(), "image/svg+xml");
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn generated_svg_rejects_invalid_image_context_and_excessive_dimensions() {
    for source in [
        "<html><svg width=\"1\" height=\"1\"/></html>",
        "<!DOCTYPE svg><svg width=\"1\" height=\"1\"/>",
        "<!ENTITY value 'x'><svg width=\"1\" height=\"1\"/>",
        "<svg-fake width=\"1\" height=\"1\"/>",
        "<svg width=\"1\" height=\"1\"><path/>",
        "<svg width=\"1\" height=\"1\"/><svg width=\"1\" height=\"1\"/>",
        "<svg width=\"0\" height=\"1\"/>",
        "<svg width=\"100000\" height=\"100000\"/>",
        "<svg viewBox=\"0 0 NaN 1\"/>",
        "<svg width=\"1\" width=\"2\" height=\"1\"/>",
    ] { assert!(validate_svg_image_bytes(source.as_bytes()).is_err(), "{source}"); }
    assert!(validate_svg_image_bytes(b"<svg width='1' height='1'>\xff</svg>").is_err());
    assert_eq!(validate_svg_image_bytes(b"<svg width='1.5px' height='2.5px'/>").unwrap(), (2, 3));
}

fn serve_media_responses(listener: std::net::TcpListener, responses: Vec<String>) -> std::thread::JoinHandle<Vec<String>> {
    std::thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        let mut requests = Vec::new();
        for response in responses {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
                    Err(error) => panic!("test HTTP accept failed: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0_u8; 1];
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() < 64 * 1024);
            }
            requests.push(String::from_utf8(request).unwrap());
            stream.write_all(response.as_bytes()).unwrap();
        }
        requests
    })
}

fn serve_media_connection(serve: impl FnOnce(std::net::TcpStream) + Send + 'static) -> (String, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/media?signature=fixture-private", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
                Err(error) => panic!("test media accept failed: {error}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        stream.set_nodelay(true).unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let mut byte = [0_u8; 1];
            stream.read_exact(&mut byte).unwrap();
            request.push(byte[0]);
            assert!(request.len() < 64 * 1024);
        }
        serve(stream);
    });
    (url, server)
}

#[test]
fn media_download_times_out_waiting_for_response_headers() {
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let (url, server) = serve_media_connection(move |_| { let _ = wait.recv_timeout(Duration::from_secs(3)); });
    let error = fetch_media_download(&url, None, || Ok(false), Duration::from_millis(100)).unwrap_err();
    release.send(()).unwrap();
    server.join().unwrap();
    assert_eq!(error, "媒体下载等待超时，请继续取回原结果");
    assert!(!error.contains("fixture-private"));
}

#[test]
fn media_download_times_out_stalled_body_and_removes_partial_file() {
    let directory = test_directory("media-body-timeout");
    let destination = directory.join("result.mp4");
    let task_id = "media-body-timeout";
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let (url, server) = serve_media_connection(move |mut stream| {
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nok").unwrap();
        let _ = wait.recv_timeout(Duration::from_secs(3));
    });
    let response = fetch_media_download(&url, None, || Ok(false), MEDIA_DOWNLOAD_IDLE_TIMEOUT).unwrap();
    let mut progress = Vec::new();
    let error = download_media_response_to_file(task_id, response, &destination, None, Duration::from_millis(100),
        |_, _| Ok(()), |bytes, _| progress.push(bytes)).err().expect("正文停滞应超时");
    release.send(()).unwrap();
    server.join().unwrap();
    assert!(error.contains("媒体下载等待超时"));
    assert!(progress.contains(&2));
    assert!(!destination.exists());
    assert!(!part_path(&destination, task_id).exists());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn media_download_cancels_while_waiting_for_response_headers() {
    use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let (url, server) = serve_media_connection(move |_| {
        flag.store(true, Ordering::Release);
        let _ = wait.recv_timeout(Duration::from_secs(3));
    });
    let started = std::time::Instant::now();
    let error = fetch_media_download(&url, None, || Ok(cancelled.load(Ordering::Acquire)), MEDIA_DOWNLOAD_IDLE_TIMEOUT).unwrap_err();
    release.send(()).unwrap();
    server.join().unwrap();
    assert_eq!(error, "文件传输已取消");
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn media_download_cancels_stalled_body_and_removes_partial_file() {
    let directory = test_directory("media-body-cancel");
    let destination = directory.join("result.mp4");
    let task_id = "media-body-cancel";
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let (url, server) = serve_media_connection(move |mut stream| {
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nok").unwrap();
        let _ = wait.recv_timeout(Duration::from_secs(3));
    });
    let response = fetch_media_download(&url, None, || Ok(false), MEDIA_DOWNLOAD_IDLE_TIMEOUT).unwrap();
    let (body_started, body_wait) = std::sync::mpsc::channel::<()>();
    let cancel = std::thread::spawn(move || {
        body_wait.recv_timeout(Duration::from_secs(3)).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        cancelled_transfers().lock().unwrap().insert(task_id.to_owned());
    });
    let mut notified = false;
    let started = std::time::Instant::now();
    let error = download_media_response_to_file(task_id, response, &destination, None, MEDIA_DOWNLOAD_IDLE_TIMEOUT,
        |_, _| Ok(()), |bytes, _| {
            if bytes > 0 && !notified { notified = true; body_started.send(()).unwrap(); }
        }).err().expect("正文等待中取消应结束");
    cancel.join().unwrap();
    clear_cancelled(task_id);
    release.send(()).unwrap();
    server.join().unwrap();
    assert!(error.contains("文件传输已取消"));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(!destination.exists());
    assert!(!part_path(&destination, task_id).exists());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn media_download_keeps_streaming_beyond_one_idle_timeout() {
    let directory = test_directory("media-active-body");
    let destination = directory.join("result.mp4");
    let body = b"abcdefghijkl";
    let (url, server) = serve_media_connection(move |mut stream| {
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\n").unwrap();
        for byte in body {
            std::thread::sleep(Duration::from_millis(40));
            stream.write_all(&[*byte]).unwrap();
        }
    });
    let response = fetch_media_download(&url, None, || Ok(false), MEDIA_DOWNLOAD_IDLE_TIMEOUT).unwrap();
    let idle_timeout = Duration::from_millis(200);
    let started = std::time::Instant::now();
    let result = download_media_response_to_file("media-active-body", response, &destination, None, idle_timeout, |_, _| Ok(()), |_, _| {}).unwrap();
    server.join().unwrap();
    assert!(started.elapsed() > idle_timeout);
    assert_eq!(result.total_bytes, body.len() as u64);
    assert_eq!(fs::read(&destination).unwrap(), body);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn media_download_preserves_bytes_across_small_buffers_and_pending_tails() {
    let expected: Vec<u8> = (0..4099).map(|index| (index % 251) as u8).collect();
    let body = expected.clone();
    let (url, server) = serve_media_connection(move |mut stream| {
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
        stream.write_all(&body).unwrap();
    });
    let response = fetch_media_download(&url, None, || Ok(false), MEDIA_DOWNLOAD_IDLE_TIMEOUT).unwrap();
    let mut reader = MediaDownloadReader {
        response, pending: Cursor::new(Vec::new()), idle_timeout: MEDIA_DOWNLOAD_IDLE_TIMEOUT,
        cancelled: || Ok(false),
    };
    let mut actual = Vec::new();
    let mut first = [0_u8; 3];
    let count = reader.read(&mut first).unwrap();
    actual.extend_from_slice(&first[..count]);
    assert_eq!(reader.read(&mut []).unwrap(), 0);
    let mut buffer = [0_u8; 7];
    loop {
        let count = reader.read(&mut buffer).unwrap();
        if count == 0 { break; }
        actual.extend_from_slice(&buffer[..count]);
    }
    assert_eq!(reader.read(&mut buffer).unwrap(), 0);
    server.join().unwrap();
    assert_eq!(actual, expected);
}

#[test]
fn media_download_reports_redacted_connection_failure() {
    let (url, server) = serve_media_connection(|_| {});
    let error = fetch_media_download(&url, None, || Ok(false), MEDIA_DOWNLOAD_IDLE_TIMEOUT).unwrap_err();
    server.join().unwrap();
    assert_eq!(error, "媒体下载连接失败，请检查网络后继续取回原结果");
    assert!(!error.contains("fixture-private"));
}

#[test]
fn media_download_only_sends_access_headers_before_leaving_the_origin() {
    let origin_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let cdn_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", origin_listener.local_addr().unwrap());
    let cdn = format!("http://{}", cdn_listener.local_addr().unwrap());
    let origin_server = serve_media_responses(origin_listener, vec![
        format!("HTTP/1.1 302 Found\r\nLocation: {cdn}/public?key=fixture-query&sig=opaque%2F%20%2b\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nvideo".into(),
    ]);
    let cdn_server = serve_media_responses(cdn_listener, vec![format!(
        "HTTP/1.1 302 Found\r\nLocation: {origin}/final?key=fixture-query\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )]);
    let access = MediaDownloadAccess { origin: origin.clone(), query_auth_name: Some("key".into()), headers: HashMap::from([
        ("Authorization".into(), "Bearer fixture".into()), ("X-API-Key".into(), "fixture-custom".into()),
    ]) };
    let response = fetch_media_download(&format!("{origin}/content?key=fixture-query"), Some(&access), || Ok(false), MEDIA_DOWNLOAD_IDLE_TIMEOUT).unwrap();
    assert_eq!(tauri::async_runtime::block_on(response.text()).unwrap(), "video");
    let requests = origin_server.join().unwrap();
    let initial = requests[0].to_ascii_lowercase();
    assert!(initial.contains("authorization: bearer fixture"));
    assert!(initial.contains("x-api-key: fixture-custom"));
    assert!(initial.contains("key=fixture-query"));
    let cdn_requests = cdn_server.join().unwrap();
    assert!(cdn_requests[0].contains("/public?sig=opaque%2F%20%2b "));
    for request in cdn_requests.into_iter().chain(requests.into_iter().skip(1)) {
        let request = request.to_ascii_lowercase();
        assert!(!request.contains("authorization:"));
        assert!(!request.contains("x-api-key:"));
        assert!(!request.contains("referer:"));
        assert!(!request.contains("fixture-query"));
    }
}

#[test]
fn media_download_rejects_unbound_origin_credentials_and_unsafe_headers() {
    let access = MediaDownloadAccess { origin: "https://provider.example".into(), query_auth_name: None, headers: HashMap::new() };
    assert!(fetch_media_download("https://cdn.example/result", Some(&access), || Ok(false), MEDIA_DOWNLOAD_IDLE_TIMEOUT).is_err());
    assert!(fetch_media_download("https://user:pass@provider.example/content", Some(&access), || Ok(false), MEDIA_DOWNLOAD_IDLE_TIMEOUT).is_err());
    let base = reqwest::Url::parse("https://provider.example/content").unwrap();
    for target in ["http://cdn.example/result", "file:///result", "https://user:pass@cdn.example/result"] {
        assert!(media_download_redirect_target(&base, target).is_err());
    }
    assert!(media_download_redirect_target(&base, "https://cdn.example/result").is_ok());
    for name in ["Host", "Cookie", "Connection", "Transfer-Encoding", "Proxy-Authorization"] {
        let access = MediaDownloadAccess { origin: "https://provider.example".into(), query_auth_name: None, headers: HashMap::from([(name.into(), "fixture".into())]) };
        assert!(media_download_headers(&access).is_err());
    }
    assert!(fetch_media_download("https://provider.example/content", Some(&access), || Ok(true), MEDIA_DOWNLOAD_IDLE_TIMEOUT).is_err());
}

#[test]
fn model_download_only_retries_transient_http_responses() {
    assert!(model_download_status(reqwest::StatusCode::OK).is_ok());
    for code in [403, 404, 408, 410, 429, 500, 502, 503, 504] {
        let failure = model_download_status(reqwest::StatusCode::from_u16(code).unwrap()).unwrap_err();
        assert!(failure.retryable, "HTTP {code} 应允许切源");
    }
    for code in [206, 301, 400, 401] {
        let failure = model_download_status(reqwest::StatusCode::from_u16(code).unwrap()).unwrap_err();
        assert!(!failure.retryable, "HTTP {code} 不应触发网络重试");
    }
}

#[test]
fn model_download_cancellation_overrides_a_simultaneous_network_failure() {
    let cancelled = model_transfer_failure(true, true, false);
    assert!(!cancelled.retryable);
    assert_eq!(cancelled.message, "文件传输已取消");
    assert!(model_transfer_failure(true, false, false).retryable);
    let invalid = model_transfer_failure(false, false, true);
    assert!(!invalid.retryable);
    assert_eq!(invalid.message, "模型文件大小或 SHA-256 校验失败，文件未安装；请重试或检查下载源");
    assert!(!model_transfer_failure(false, false, false).retryable);
}

#[test]
fn model_download_cancel_marker_remains_until_the_outer_task_cleans_it() {
    let task_id = "model-download-cancel-lifecycle";
    cancel_file_transfer(task_id.into()).unwrap();
    assert!(is_cancelled(task_id).unwrap());
    let failure = model_transfer_failure(true, is_cancelled(task_id).unwrap(), false);
    assert!(!failure.retryable);
    assert!(is_cancelled(task_id).unwrap());
    clear_cancelled(task_id);
    assert!(!is_cancelled(task_id).unwrap());
}

#[test]
fn video_download_accepts_recognizable_containers_without_requiring_a_decoder() {
    let root = test_directory("video-containers");
    let path = root.join("video.part");
    let metadata = DownloadMetadata { content_length: None, content_type: Some("application/octet-stream".into()) };
    for bytes in [
        &b"\0\0\0\x18ftypisom\0\0\0\0isommp42"[..],
        &b"\x1a\x45\xdf\xa3\x01\x02\x03\x04"[..],
        &b"RIFF\x04\0\0\0AVI "[..],
        &b"\0\0\0\x08wide\0\0\0\x10mdat12345678"[..],
    ] {
        fs::write(&path, bytes).unwrap();
        assert!(validate_downloaded_video(&path, &metadata).is_ok());
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn invalid_video_download_never_publishes_an_empty_file_error_page_or_preview() {
    let root = test_directory("invalid-video-download");
    let destination = root.join("video.mp4");
    let metadata = DownloadMetadata { content_length: None, content_type: Some("video/mp4".into()) };
    for bytes in [
        &b""[..], &b"<html>upstream error</html>"[..],
        &b"{\"error\":\"not found\"}"[..], &b"\x89PNG\r\n\x1a\npreview"[..],
        &b"GIF89apreview"[..], &b"\0\0\x04\0ftypisom\0\0\0\0"[..],
    ] {
        let result = stream_to_file(
            "invalid-video", &mut Cursor::new(bytes), &destination,
            Some(bytes.len() as u64), None, None, || Ok(false), |_| {},
            |path| validate_downloaded_video(path, &metadata),
        );
        assert!(result.is_err());
        assert!(!destination.exists());
        assert!(!part_path(&destination, "invalid-video").exists());
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn project_media_reuse_keeps_the_existing_file_without_creating_a_copy() {
    let root = test_directory("project-media-reuse");
    let folder = root.join("Library");
    fs::create_dir(&folder).unwrap();
    let source = folder.join("角色.png");
    fs::write(&source, b"shared-media").unwrap();
    let result = reusable_project_media(&source, &source, &root).unwrap();
    assert_eq!(result.path, source.to_string_lossy().into_owned());
    assert_eq!(result.total_bytes, 12);
    assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
    assert_eq!(fs::read(&source).unwrap(), b"shared-media");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn project_media_reuse_rejects_other_roots_directories_and_different_destinations() {
    let root = test_directory("project-media-reuse-boundary");
    let project = root.join("series");
    let other_project = root.join("series-other");
    fs::create_dir(&project).unwrap();
    fs::create_dir(&other_project).unwrap();
    let source = project.join("角色.png");
    let other = other_project.join("角色.png");
    fs::write(&source, b"shared-media").unwrap();
    fs::write(&other, b"other-media").unwrap();
    assert!(reusable_project_media(&other, &other, &project).is_err());
    assert!(reusable_project_media(&source, &other, &project).is_err());
    assert!(reusable_project_media(&project, &project, &root).is_err());
    assert!(reusable_project_media(&source, &source, &source).is_err());
    let missing = project.join("missing.png");
    assert!(reusable_project_media(&missing, &missing, &project).is_err());
    assert_eq!(fs::read(&source).unwrap(), b"shared-media");
    assert_eq!(fs::read(&other).unwrap(), b"other-media");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn asset_move_requires_identical_copy_and_never_overwrites_conflicts() {
    let root = test_directory("asset-file-move");
    let source = root.join("图片.png");
    fs::write(&source, b"original").unwrap();
    let destination = asset_file_destination(&source, &root, &[]).unwrap();
    assert!(valid_asset_move_name(&source, &destination));
    assert!(!valid_asset_move_name(&source, &root.join("other.png")));
    assert!(!valid_asset_move_name(&source, &root.join("图片 (1).txt")));
    assert_eq!(asset_file_destination(&source, &root, &["图片 (1).png".into()]).unwrap(), root.join("图片 (2).png"));
    assert_eq!(
        destination.file_name().unwrap().to_string_lossy(),
        "图片 (1).png"
    );
    fs::write(&destination, b"original").unwrap();
    let digest = file_digest(&source, || Ok(false)).unwrap();
    assert!(verify_move_copy(&source, &destination, &digest, 8).is_ok());
    assert!(verify_move_copy(&source, &source, &digest, 8).is_err());
    fs::write(&destination, b"modified").unwrap();
    assert!(verify_move_copy(&source, &destination, &digest, 8).is_err());
    assert_eq!(fs::read(&source).unwrap(), b"original");
    assert!(file_digest(&source, || Ok(true)).is_err());
    assert!(verify_move_copy(&source, &destination, "invalid", 8).is_err());
    fs::write(&destination, b"original").unwrap();
    fs::remove_file(&source).unwrap();
    assert!(verify_move_copy(&source, &destination, &digest, 8).is_ok());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn transfer_never_overwrites_or_removes_an_existing_part_file() {
    let root = test_directory("existing-part");
    let destination = root.join("image.png");
    let partial = temporary_path(&destination, "fixed-task").unwrap();
    fs::write(&partial, b"existing").unwrap();
    assert!(stream_to_file(
        "fixed-task",
        &mut Cursor::new(b"replacement"),
        &destination,
        None,
        None,
        None,
        || Ok(false),
        |_| {},
        |_| Ok(())
    )
    .is_err());
    assert_eq!(fs::read(&partial).unwrap(), b"existing");
    assert!(!destination.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn folder_plan_preserves_nested_and_empty_directories() {
    let root = test_directory("folder-plan");
    fs::create_dir_all(root.join("人物/空目录")).unwrap();
    fs::write(root.join("人物/image.png"), b"data").unwrap();
    let plan = plan_folder_copy(&root, || Ok(false), |_, _| Ok(())).unwrap();
    assert_eq!(plan.bytes, 4);
    assert_eq!(plan.directories.len(), 3);
    assert_eq!(plan.files[0].0, PathBuf::from("人物/image.png"));
    assert!(plan_folder_copy(&root, || Ok(true), |_, _| Ok(())).is_err());
    assert!(folder_copy_destination(&root, &root.join("人物")).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn folder_destination_uses_exclusive_creation_and_keeps_existing_content() {
    let parent = test_directory("folder-conflict");
    let source = parent.join("素材");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("original"), b"original").unwrap();
    let destination = folder_copy_destination(&source, &parent).unwrap();
    assert_ne!(destination, source);
    assert!(destination
        .file_name()
        .unwrap()
        .to_string_lossy()
        .contains("副本"));
    assert_eq!(fs::read(source.join("original")).unwrap(), b"original");
    fs::remove_dir_all(parent).unwrap();
}

#[cfg(unix)]
#[test]
fn folder_plan_rejects_symlinks_before_copying() {
    let root = test_directory("folder-link");
    std::os::unix::fs::symlink(&root, root.join("cycle")).unwrap();
    assert!(plan_folder_copy(&root, || Ok(false), |_, _| Ok(())).is_err());
    fs::remove_dir_all(root).unwrap();
}

struct GeneratedReader {
    remaining: u64,
}

impl Read for GeneratedReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.remaining.min(buffer.len() as u64) as usize;
        buffer[..read].fill(0x5a);
        self.remaining -= read as u64;
        Ok(read)
    }
}

struct ShortReader<'a> {
    remaining: &'a [u8],
    max_read: usize,
}

impl Read for ShortReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.remaining.len().min(buffer.len()).min(self.max_read);
        buffer[..count].copy_from_slice(&self.remaining[..count]);
        self.remaining = &self.remaining[count..];
        Ok(count)
    }
}

struct RecordingReader {
    remaining: u64,
    requests: Vec<usize>,
}

impl Read for RecordingReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.requests.push(buffer.len());
        let count = self.remaining.min(buffer.len() as u64) as usize;
        buffer[..count].fill(0x5a);
        self.remaining -= count as u64;
        Ok(count)
    }
}

fn test_directory(name: &str) -> PathBuf {
    let unique = format!(
        "ai-canvas-file-transfer-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时间应晚于 UNIX epoch")
            .as_nanos()
    );
    let directory = std::env::temp_dir().join(unique);
    fs::create_dir_all(&directory).expect("应创建测试目录");
    directory
}

fn part_path(destination: &Path, task_id: &str) -> PathBuf {
    temporary_path(destination, task_id).expect("应生成临时路径")
}

#[test]
fn reserves_at_least_sixty_four_megabytes() {
    assert_eq!(required_free_space(100), 100 + MIN_FREE_SPACE_RESERVE);
}

#[test]
fn never_overwrites_a_destination_created_during_transfer() {
    let directory = test_directory("no-clobber");
    let destination = directory.join("result.png");
    let mut reader = Cursor::new(b"new result".to_vec());
    let result = stream_to_file(
        "race",
        &mut reader,
        &destination,
        None,
        None,
        None,
        || Ok(false),
        |_| {},
        |_| {
            fs::write(&destination, b"existing result").unwrap();
            Ok(())
        },
    );
    assert!(result.is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"existing result");
    assert!(!part_path(&destination, "race").exists());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn reserves_five_percent_for_large_files() {
    let size = 2 * 1024 * 1024 * 1024_u64;
    assert_eq!(required_free_space(size), size + size / 20);
}

#[test]
fn streams_then_atomically_promotes_complete_file() {
    let directory = test_directory("complete");
    let destination = directory.join("model.onnx");
    let task_id = "complete-task";
    let bytes = vec![7_u8; BUFFER_SIZE + 17];
    let mut reader = Cursor::new(bytes.clone());

    let transferred = stream_to_file(
        task_id,
        &mut reader,
        &destination,
        Some(bytes.len() as u64),
        Some(bytes.len() as u64),
        Some((bytes.len() + 1) as u64),
        || Ok(false),
        |_| {},
        |_| Ok(()),
    )
    .expect("完整传输应成功");

    assert_eq!(transferred, bytes.len() as u64);
    assert_eq!(fs::read(&destination).expect("应读取正式文件"), bytes);
    assert!(!part_path(&destination, task_id).exists());
    fs::remove_dir_all(directory).expect("应清理测试目录");
}

#[test]
fn uses_bounded_buffers_for_zero_small_large_and_unknown_lengths() {
    for (expected, total, capacity) in [
        (Some(0), 0, 1),
        (Some(1), 1, 1),
        (Some(31), 31, 31),
        (Some(BUFFER_SIZE as u64 + 17), BUFFER_SIZE as u64 + 17, BUFFER_SIZE),
        (None, 17, BUFFER_SIZE),
    ] {
        let directory = test_directory("buffer-size");
        let destination = directory.join("result.bin");
        let mut reader = RecordingReader { remaining: total, requests: Vec::new() };
        let actual = stream_to_file(
            "buffer-size", &mut reader, &destination, expected, Some(total), None,
            || Ok(false), |_| {},
            |temporary| { assert_eq!(fs::metadata(temporary).unwrap().len(), total); Ok(()) },
        ).unwrap();
        assert_eq!(actual, total);
        assert!(reader.requests.iter().all(|size| *size == capacity));
        assert_eq!(fs::read(&destination).unwrap(), vec![0x5a; total as usize]);
        assert!(!part_path(&destination, "buffer-size").exists());
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn refuses_a_grown_source_after_bounded_reads_for_zero_and_one_byte_expectations() {
    for expected in [0_u64, 1] {
        let directory = test_directory("grown-source");
        let destination = directory.join("result.bin");
        let initial = BUFFER_SIZE as u64 * 2;
        let mut reader = RecordingReader { remaining: initial, requests: Vec::new() };
        let validated = std::cell::Cell::new(false);
        let result = stream_to_file(
            "grown-source", &mut reader, &destination, Some(expected), None, None,
            || Ok(false), |_| {}, |_| { validated.set(true); Ok(()) },
        );
        assert!(result.unwrap_err().contains("下载不完整"));
        assert_eq!(reader.requests, vec![1; expected as usize + 1]);
        assert_eq!(initial - reader.remaining, expected + 1);
        assert!(!validated.get());
        assert!(!destination.exists());
        assert!(!part_path(&destination, "grown-source").exists());
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn short_reads_flush_before_validation_and_report_first_and_final_progress() {
    let directory = test_directory("short-reads");
    let destination = directory.join("result.bin");
    let bytes = b"short chunks leave buffered data";
    let mut reader = ShortReader { remaining: bytes, max_read: 3 };
    let mut progress = Vec::new();
    let transferred = stream_to_file(
        "short-reads", &mut reader, &destination, Some(bytes.len() as u64),
        Some(bytes.len() as u64), None, || Ok(false), |current| progress.push(current),
        |temporary| {
            assert_eq!(fs::read(temporary).unwrap(), bytes);
            assert!(!destination.exists());
            Ok(())
        },
    ).unwrap();
    assert_eq!(transferred, bytes.len() as u64);
    assert_eq!(progress.first(), Some(&3));
    assert_eq!(progress.last(), Some(&transferred));
    assert!(progress.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(fs::read(&destination).unwrap(), bytes);
    assert!(!part_path(&destination, "short-reads").exists());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn first_short_read_progress_can_cancel_without_reading_or_publishing_more() {
    let directory = test_directory("short-read-cancel");
    let destination = directory.join("result.bin");
    let bytes = b"cancel after the first short chunk";
    let mut reader = ShortReader { remaining: bytes, max_read: 3 };
    let cancelled = std::cell::Cell::new(false);
    let validated = std::cell::Cell::new(false);
    let mut progress = Vec::new();
    let result = stream_to_file(
        "short-read-cancel", &mut reader, &destination, None, None, None,
        || Ok(cancelled.get()),
        |current| { progress.push(current); cancelled.set(true); },
        |_| { validated.set(true); Ok(()) },
    );
    assert!(result.unwrap_err().contains("已取消"));
    assert_eq!(reader.remaining.len(), bytes.len() - 3);
    assert_eq!(progress, [3]);
    assert!(!validated.get());
    assert!(!destination.exists());
    assert!(!part_path(&destination, "short-read-cancel").exists());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn read_failure_discards_buffered_output_without_publishing() {
    struct FailedReader;
    impl Read for FailedReader {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("fixture read failure"))
        }
    }
    let directory = test_directory("buffered-read-error");
    let destination = directory.join("result.bin");
    let mut reader = Cursor::new(b"buffered data").chain(FailedReader);
    let result = stream_to_file(
        "buffered-read-error", &mut reader, &destination, None, None, None,
        || Ok(false), |_| {}, |_| Ok(()),
    );
    assert!(result.unwrap_err().contains("fixture read failure"));
    assert!(!destination.exists());
    assert!(!part_path(&destination, "buffered-read-error").exists());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn removes_part_when_actual_length_differs() {
    let directory = test_directory("length-mismatch");
    let destination = directory.join("model.onnx");
    let task_id = "length-task";
    let mut reader = Cursor::new(vec![1_u8; 32]);

    let result = stream_to_file(
        task_id,
        &mut reader,
        &destination,
        Some(64),
        Some(64),
        None,
        || Ok(false),
        |_| {},
        |_| Ok(()),
    );

    assert!(result.expect_err("长度不符应失败").contains("下载不完整"));
    assert!(!destination.exists());
    assert!(!part_path(&destination, task_id).exists());
    fs::remove_dir_all(directory).expect("应清理测试目录");
}

#[test]
fn removes_part_when_transfer_exceeds_limit() {
    let directory = test_directory("too-large");
    let destination = directory.join("model.onnx");
    let task_id = "limit-task";
    let mut reader = Cursor::new(vec![2_u8; 65]);

    let result = stream_to_file(
        task_id,
        &mut reader,
        &destination,
        None,
        Some(64),
        Some(64),
        || Ok(false),
        |_| {},
        |_| Ok(()),
    );

    assert!(result.expect_err("超过上限应失败").contains("体积上限"));
    assert!(!destination.exists());
    assert!(!part_path(&destination, task_id).exists());
    fs::remove_dir_all(directory).expect("应清理测试目录");
}

#[test]
fn removes_part_when_cancelled_mid_transfer() {
    let directory = test_directory("cancelled");
    let destination = directory.join("model.onnx");
    let task_id = "cancel-task";
    let mut reader = Cursor::new(vec![3_u8; BUFFER_SIZE * 2]);
    let mut checks = 0_u8;

    let result = stream_to_file(
        task_id,
        &mut reader,
        &destination,
        None,
        Some((BUFFER_SIZE * 2) as u64),
        None,
        || {
            checks += 1;
            Ok(checks >= 3)
        },
        |_| {},
        |_| Ok(()),
    );

    assert!(result.expect_err("取消应失败").contains("已取消"));
    assert!(!destination.exists());
    assert!(!part_path(&destination, task_id).exists());
    fs::remove_dir_all(directory).expect("应清理测试目录");
}

#[test]
#[ignore = "176 MiB 磁盘与内存压力验收"]
fn streams_176_mib_without_allocating_the_model_in_memory() {
    let directory = test_directory("176-mib");
    let destination = directory.join("model.onnx");
    let task_id = "memory-task";
    let total_bytes = 176 * 1024 * 1024_u64;
    let mut reader = GeneratedReader {
        remaining: total_bytes,
    };

    let transferred = stream_to_file(
        task_id,
        &mut reader,
        &destination,
        Some(total_bytes),
        Some(total_bytes),
        Some(total_bytes),
        || Ok(false),
        |_| {},
        |_| Ok(()),
    )
    .expect("176 MiB 流式传输应成功");

    assert_eq!(transferred, total_bytes);
    assert_eq!(
        fs::metadata(&destination).expect("应读取正式文件").len(),
        total_bytes
    );
    assert!(!part_path(&destination, task_id).exists());
    fs::remove_dir_all(directory).expect("应清理测试目录");
}

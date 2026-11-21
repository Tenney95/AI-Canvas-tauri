use super::*;
use image::{ImageBuffer, Rgb};
use serde_json::{json, Value};

struct TestStorage {
    root: PathBuf,
    storage: Arc<SharedStorage>,
}

impl TestStorage {
    fn new() -> Self {
        let nonce: [u8; 16] = crate::secure_random::random_bytes().unwrap();
        let root = std::env::temp_dir().join(format!("canvas-wsagent-{}", digest(&nonce)));
        let storage = Arc::new(SharedStorage::new(
            root.join("agent-private").join(DIRECTORY),
        ));
        Self { root, storage }
    }
}

impl Drop for TestStorage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn image_fixture(color: u8, format: ImageFormat) -> String {
    let image = DynamicImage::ImageRgb8(ImageBuffer::from_pixel(12, 10, Rgb([color, 44, 99])));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, format).unwrap();
    STANDARD.encode(bytes.into_inner())
}

async fn send(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
    request: Value,
    origin: Option<&str>,
) -> (StatusCode, Value) {
    let mut request = client
        .post(endpoint)
        .bearer_auth(token)
        .header("content-type", "application/json")
        .body(request.to_string());
    if let Some(origin) = origin {
        request = request.header("origin", origin);
    }
    let response = request.send().await.unwrap();
    let status = response.status();
    let body = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    (status, body)
}

#[tokio::test]
async fn http_pair_publish_read_switch_rotate_and_revoke() {
    let test = TestStorage::new();
    let storage = test.storage.clone();
    let first = storage.authorize("canvas-a").unwrap();
    let server = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = server.local_addr().unwrap().port();
    let router = router(storage.clone(), port);
    let task = tokio::spawn(async move { axum::serve(server, router).await.unwrap() });
    let endpoint = format!("http://127.0.0.1:{port}/v1");
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let pair = json!({"action":"pair","peerProjectId":"ws-a"});
    let list = json!({"action":"list","peerProjectId":"ws-a","offset":0});
    assert_eq!(
        send(&client, &endpoint, &first.token, pair.clone(), None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    storage.activate(Some("canvas-a".into())).unwrap();
    assert_eq!(
        send(&client, &endpoint, &"a".repeat(64), pair.clone(), None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send(&client, &endpoint, &first.token, pair.clone(), Some("null"))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        send(&client, &endpoint, &first.token, list.clone(), None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (status, reply) = send(&client, &endpoint, &first.token, pair.clone(), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reply, json!({"ownerId":"canvas-a","peerProjectId":"ws-a"}));
    assert_eq!(
        send(
            &client,
            &endpoint,
            &first.token,
            json!({"action":"pair","peerProjectId":"ws-b"}),
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );

    let original = image_fixture(42, ImageFormat::Png);
    let malformed = STANDARD.encode(b"\x89PNG\r\n\x1a\nnot-an-image");
    let publish_request = |mime: &str, bytes: &str| json!({"action":"publish","peerProjectId":"ws-a","name":".. 雨夜\n/ 入口", "mime":mime, "base64":bytes });
    for bad in [
        publish_request("image/jpeg", &original),
        publish_request("image/png", &malformed),
    ] {
        assert_eq!(
            send(&client, &endpoint, &first.token, bad, None).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let (status, published) = send(
        &client,
        &endpoint,
        &first.token,
        publish_request("image/png", &original),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let asset = &published["asset"];
    let id = asset["id"].as_str().unwrap();
    assert_eq!(id, digest(&STANDARD.decode(&original).unwrap()));
    assert_eq!(asset["name"], "雨夜 入口");
    assert_eq!(asset["source"], "wsagent");
    assert_eq!(asset["id"], asset["sha256"]);
    let read_remote =
        |asset_id: &str| json!({"action":"read","peerProjectId":"ws-a","assetId":asset_id});
    assert_eq!(
        send(&client, &endpoint, &first.token, read_remote(id), None)
            .await
            .1["base64"],
        original
    );
    assert_eq!(
        read(&storage.db().unwrap(), "canvas-a", id).unwrap().base64,
        original
    );
    assert_eq!(
        read(&storage.db().unwrap(), "canvas-b", id)
            .err()
            .unwrap()
            .0,
        StatusCode::NOT_FOUND
    );
    let thumbnail = preview(&storage.db().unwrap(), "canvas-a", id)
        .unwrap()
        .data_url;
    let thumbnail = thumbnail.strip_prefix("data:image/jpeg;base64,").unwrap();
    assert!(thumbnail.len() <= MAX_PREVIEW_CHARS);
    let thumbnail = decode("image/jpeg", &STANDARD.decode(thumbnail).unwrap()).unwrap();
    assert!(thumbnail.width() <= 640 && thumbnail.height() <= 640);

    let mut db = storage.db().unwrap();
    let transaction = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let duplicate = publish(
        &transaction,
        "canvas-a",
        Upload::new("别名", "image/png", &original).unwrap(),
        "canvas",
    )
    .unwrap();
    assert_eq!(duplicate.asset.id, id);
    assert_eq!(duplicate.asset.source, "wsagent");
    let local = image_fixture(89, ImageFormat::Jpeg);
    let local_asset = publish(
        &transaction,
        "canvas-a",
        Upload::new("本地图片", "image/jpeg", &local).unwrap(),
        "canvas",
    )
    .unwrap();
    transaction.commit().unwrap();
    let readback = send(
        &client,
        &endpoint,
        &first.token,
        read_remote(&local_asset.asset.id),
        None,
    )
    .await
    .1;
    assert_eq!(readback["asset"]["source"], "canvas");
    assert_eq!(readback["base64"], local);
    let assets = send(&client, &endpoint, &first.token, list.clone(), None)
        .await
        .1;
    assert_eq!(assets["assets"].as_array().unwrap().len(), 2);
    assert_eq!(assets["nextOffset"], Value::Null);

    let (snapshot, _) = storage.peer_scope(&digest(first.token.as_bytes())).unwrap();
    storage.activate(Some("canvas-b".into())).unwrap();
    assert_eq!(
        send(&client, &endpoint, &first.token, list.clone(), None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    storage.activate(Some("canvas-a".into())).unwrap();
    let stale = storage.peer_request(
        &digest(first.token.as_bytes()),
        snapshot,
        PeerRequest::List {
            peer_project_id: "ws-a".into(),
            offset: 0,
        },
    );
    assert_eq!(stale.err().unwrap().0, StatusCode::CONFLICT);

    let reopened = SharedStorage::new(storage.root.clone());
    let saved = reopened.status("canvas-a").unwrap();
    assert_eq!(saved.peer_project_id.as_deref(), Some("ws-a"));
    assert!(saved.enabled);
    assert_eq!(
        reopened
            .peer_scope(&digest(first.token.as_bytes()))
            .err()
            .unwrap()
            .0,
        StatusCode::CONFLICT
    );
    let second = reopened.authorize("canvas-a").unwrap();
    assert_eq!(second.status.peer_project_id.as_deref(), Some("ws-a"));
    assert_ne!(second.token, first.token);
    assert_eq!(
        send(&client, &endpoint, &first.token, list.clone(), None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send(&client, &endpoint, &second.token, pair, None).await.0,
        StatusCode::OK
    );
    let revoked = reopened.revoke("canvas-a").unwrap();
    assert!(!revoked.enabled);
    assert_eq!(revoked.peer_project_id, None);
    assert_eq!(
        send(&client, &endpoint, &second.token, list, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        read(&reopened.db().unwrap(), "canvas-a", id)
            .unwrap()
            .base64,
        original
    );
    task.abort();
}

#[test]
fn auto_pair_is_read_only_until_confirmed_and_never_replaces_a_working_link_on_failure() {
    let test = TestStorage::new();
    let storage = &test.storage;
    storage.activate(Some("canvas-a".into())).unwrap();
    let scope = storage.active_scope("canvas-a").unwrap();
    let old_token = digest(storage.authorize("canvas-a").unwrap().token.as_bytes());
    let pair = |peer: &str| PeerRequest::Pair {
        peer_project_id: peer.to_owned(),
    };
    let list = || PeerRequest::List {
        peer_project_id: "ws-a".into(),
        offset: 0,
    };
    let receipt = |peer: &str, reused| AutoPairReceipt {
        owner_id: "canvas-a".into(),
        peer_project_id: peer.to_owned(),
        reused,
    };
    storage
        .peer_request(&old_token, scope.clone(), pair("ws-a"))
        .unwrap();

    let pending_token = digest(b"staged token");
    assert_eq!(
        storage
            .stage_pairing(&scope, &pending_token)
            .unwrap()
            .as_deref(),
        Some("ws-a")
    );
    assert!(storage.peer_scope(&pending_token).unwrap().1);
    assert_eq!(
        storage
            .peer_request(&pending_token, scope.clone(), list())
            .err()
            .unwrap()
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        storage
            .peer_request(&pending_token, scope.clone(), pair("ws-b"))
            .err()
            .unwrap()
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        storage
            .commit_pairing(&scope, &pending_token, receipt("ws-a", false))
            .err()
            .unwrap()
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert!(
        storage
            .commit_pairing(&scope, &pending_token, receipt("ws-a", true))
            .unwrap()
            .enabled
    );
    storage
        .peer_request(&old_token, scope.clone(), list())
        .unwrap();

    storage
        .peer_request(&pending_token, scope.clone(), pair("ws-a"))
        .unwrap();
    storage.activate(Some("other".into())).unwrap();
    storage.activate(Some("canvas-a".into())).unwrap();
    assert_eq!(
        storage
            .commit_pairing(&scope, &pending_token, receipt("ws-a", false))
            .err()
            .unwrap()
            .0,
        StatusCode::CONFLICT
    );
    let latest = storage.active_scope("canvas-a").unwrap();
    storage
        .peer_request(&old_token, latest.clone(), list())
        .unwrap();

    *storage.pending_pairing.lock().unwrap() = None;
    let retry = digest(b"retried token");
    storage.stage_pairing(&latest, &retry).unwrap();
    storage
        .peer_request(&retry, latest.clone(), pair("ws-a"))
        .unwrap();
    assert!(
        storage
            .commit_pairing(&latest, &retry, receipt("ws-a", false))
            .unwrap()
            .enabled
    );
    *storage.pending_pairing.lock().unwrap() = None;
    storage.peer_request(&retry, latest, list()).unwrap();
    assert_eq!(
        storage.peer_scope(&old_token).err().unwrap().0,
        StatusCode::UNAUTHORIZED
    );
}

#[cfg(target_os = "macos")]
#[test]
fn auto_pair_discovery_rejects_shared_files_and_symlinks() {
    use std::{
        io::Write,
        os::unix::fs::{symlink, OpenOptionsExt, PermissionsExt},
    };

    let test = TestStorage::new();
    plain_directory(&test.root).unwrap();
    let private = test.root.join(RENDEZVOUS_DIRECTORY);
    plain_directory(&private).unwrap();
    let descriptor = private.join("wsagent-v1.json");
    let token = "a".repeat(64);
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&descriptor)
        .unwrap()
        .write_all(
            json!({ "version": 1, "port": 43123, "token": token })
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    assert_eq!(read_pairing_discovery(&test.root).unwrap().port, 43123);
    fs::set_permissions(&descriptor, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read_pairing_discovery(&test.root).is_err());
    fs::set_permissions(&descriptor, fs::Permissions::from_mode(0o600)).unwrap();
    let moved = private.join("other.json");
    fs::rename(&descriptor, &moved).unwrap();
    symlink(&moved, &descriptor).unwrap();
    assert!(read_pairing_discovery(&test.root).is_err());
}

#[test]
fn stored_assets_paginate_by_timestamp_and_digest() {
    let test = TestStorage::new();
    let mut db = test.storage.db().unwrap();
    let transaction = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    for n in 0..83u8 {
        let original = image_fixture(n, ImageFormat::Png);
        let upload = Upload::new("图片", "image/png", &original).unwrap();
        publish(&transaction, "canvas-a", upload, "canvas").unwrap();
    }
    transaction.commit().unwrap();
    db.execute("UPDATE asset SET created_at = 1", []).unwrap();
    let first = list(&db, "canvas-a", 0).unwrap();
    assert_eq!(first.assets.len(), 80);
    assert_eq!(first.next_offset, Some(80));
    assert!(first.assets.windows(2).all(|pair| pair[0].id < pair[1].id));
    let final_page = list(&db, "canvas-a", first.next_offset.unwrap()).unwrap();
    assert_eq!(final_page.assets.len(), 3);
    assert_eq!(final_page.next_offset, None);
    assert!(first.assets.last().unwrap().id < final_page.assets[0].id);
}

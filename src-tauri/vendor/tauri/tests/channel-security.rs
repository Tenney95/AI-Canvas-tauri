// SPDX-License-Identifier: Apache-2.0 OR MIT
// Run from the host manifest so all dependency versions stay locked and offline.
use tauri::test::channel_security;

const ACL: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/gen/schemas/acl-manifests.json"
));

#[test]
fn streaming_large_json() {
  channel_security::round_trip(ACL, false, true);
}
#[test]
fn streaming_large_raw() {
  channel_security::round_trip(ACL, true, true);
}
#[test]
fn invoke_callback_large_json() {
  channel_security::round_trip(ACL, false, false);
}
#[test]
fn invoke_callback_large_raw() {
  channel_security::round_trip(ACL, true, false);
}
#[test]
fn plugin_and_remote_fetch_denied() {
  channel_security::ungranted_and_remote_denied(ACL);
}
#[test]
fn explicit_deny_overrides_core_default() {
  channel_security::explicit_deny(ACL);
}
#[test]
fn invalid_ids_and_headers_preserve_pending_data() {
  channel_security::invalid_headers(ACL);
}
#[test]
fn destroyed_window_revokes_queue() {
  channel_security::close_and_reopen(ACL, true);
}
#[test]
fn closed_webview_revokes_queue() {
  channel_security::close_and_reopen(ACL, false);
}
#[test]
fn small_messages_keep_direct_callbacks() {
  channel_security::small_callbacks(ACL);
}

#[test]
fn actual_host_capability_preserves_all_first_party_windows() {
  channel_security::first_party_capability(
    ACL,
    include_str!(concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/capabilities/default.json"
    )),
  );
}

#[test]
fn missing_app_acl_does_not_exempt_channel_fetch() {
  channel_security::no_capability_denied();
}

#[test]
fn host_file_scope_preserves_project_access_and_requires_external_grants() {
  use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
  };
  use tauri::{
    ipc::{CallbackFn, InvokeBody, InvokeResponseBody, RuntimeAuthority},
    test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
    utils::{
      acl::{capability::Capability, manifest::Manifest, resolved::Resolved},
      platform::Target,
    },
    webview::InvokeRequest,
    Manager, WebviewWindowBuilder,
  };
  use tauri_plugin_fs::FsExt;

  struct FixtureDirectory(PathBuf);

  impl FixtureDirectory {
    fn create(path: PathBuf) -> Self {
      fs::create_dir_all(path.parent().unwrap()).expect("create fixture parent");
      fs::create_dir(&path).expect("create isolated fixture directory");
      Self(path)
    }
  }

  impl Drop for FixtureDirectory {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  let acl: BTreeMap<String, Manifest> = serde_json::from_str(ACL).unwrap();
  let capability: Capability = serde_json::from_str(include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/capabilities/default.json"
  )))
  .unwrap();
  let resolved = Resolved::resolve(
    &acl,
    BTreeMap::from([(capability.identifier.clone(), capability)]),
    Target::current(),
  )
  .unwrap();
  let mut context = mock_context(noop_assets());
  // 使用独立应用目录，真实应用的数据和凭据不参与测试。
  let timestamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap()
    .as_nanos();
  let identifier = format!("com.aicanvas.scope-test-{}-{timestamp}", std::process::id());
  context.config_mut().identifier = identifier.clone();
  *context.runtime_authority_mut() = RuntimeAuthority::new(acl, resolved);
  let app = mock_builder()
    .plugin(tauri_plugin_fs::init())
    .build(context)
    .unwrap();
  let window = WebviewWindowBuilder::new(&app, "main", Default::default())
    .build()
    .unwrap();
  let root = FixtureDirectory::create(app.path().app_data_dir().unwrap());
  let directory = root.0.join("data").join("项目 2-0af10eef");
  let scope = app.fs_scope();
  scope
    .forbid_directory(root.0.join("secrets"), true)
    .unwrap();

  let cache = app.path().app_cache_dir().unwrap();
  let cache_parent = cache.parent().unwrap();
  fs::create_dir_all(cache_parent).unwrap();
  let canonical_root = root.0.canonicalize().unwrap();
  let canonical_cache = cache_parent
    .canonicalize()
    .unwrap()
    .join(cache.file_name().unwrap());
  // Some platforms resolve multiple app directory names to the same physical path.
  let outside = if canonical_cache.starts_with(&canonical_root) {
    app.path().temp_dir().unwrap().join(format!("{identifier}-external"))
  } else {
    cache
  };
  let outside = FixtureDirectory::create(outside);
  assert!(!outside.0.canonicalize().unwrap().starts_with(&canonical_root));

  let ipc_path = |path: &Path| path.to_string_lossy().replace('\\', "/");
  let call = |command: &str, body: InvokeBody, path: Option<&Path>| {
    let mut request = InvokeRequest {
      cmd: format!("plugin:fs|{command}"),
      callback: CallbackFn(1),
      error: CallbackFn(2),
      url: window.url().unwrap(),
      body,
      headers: Default::default(),
      invoke_key: INVOKE_KEY.into(),
    };
    if let Some(path) = path {
      let path = ipc_path(path);
      let encoded = url::form_urlencoded::byte_serialize(path.as_bytes())
        .collect::<String>()
        .replace('+', "%20");
      request.headers.insert("path", encoded.parse().unwrap());
    }
    get_ipc_response(&window, request)
  };
  let mkdir = |path: &Path| {
    call(
      "mkdir",
      InvokeBody::Json(serde_json::json!({
        "path": ipc_path(path), "options": { "recursive": true }
      })),
      None,
    )
  };
  let read = |path: &Path| {
    call(
      "read_file",
      InvokeBody::Json(serde_json::json!({ "path": ipc_path(path) })),
      None,
    )
  };
  let write = |path: &Path, bytes: &[u8]| {
    call("write_file", InvokeBody::Raw(bytes.to_vec()), Some(path))
  };

  mkdir(&directory).expect("default project directory must be creatable");
  let file = directory.join("embedded-image-1d8233577d4ea0.png");
  write(&file, &[1, 2, 3]).expect("default project directory must be writable");
  assert!(matches!(read(&file), Ok(InvokeResponseBody::Raw(bytes)) if bytes == [1, 2, 3]));
  assert!(write(&root.0.join("secrets").join("blocked"), &[1]).is_err());

  let outside_file = outside.0.join("fixture.bin");
  let outside_subdirectory = outside.0.join("new");
  fs::write(&outside_file, [4, 5, 6]).unwrap();
  assert!(read(&outside_file).is_err(), "external reads require a grant");
  assert!(
    write(&outside_file, &[7, 8]).is_err(),
    "external writes require a grant"
  );
  assert!(
    mkdir(&outside_subdirectory).is_err(),
    "external mkdir requires a grant"
  );

  scope.allow_directory(&outside.0, true).unwrap();
  assert!(matches!(read(&outside_file), Ok(InvokeResponseBody::Raw(bytes)) if bytes == [4, 5, 6]));
  write(&outside_file, &[7, 8]).expect("explicitly granted directory must be writable");
  mkdir(&outside_subdirectory).expect("explicitly granted directory must permit mkdir");

  scope.forbid_directory(&outside.0, true).unwrap();
  assert!(
    read(&outside_file).is_err(),
    "deny must override the existing read grant"
  );
  assert!(
    write(&outside_file, &[9]).is_err(),
    "deny must override the existing write grant"
  );
  assert!(mkdir(&outside_subdirectory.join("blocked")).is_err());
  assert_eq!(fs::read(&outside_file).unwrap(), [7, 8]);
}

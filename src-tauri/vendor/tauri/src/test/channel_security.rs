// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! MockRuntime regressions for the locally patched Channel transport.
//! Compiled only with Tauri's existing `test` feature.

use std::{collections::BTreeMap, sync::mpsc, time::Duration};

use super::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use crate::{
  ipc::{
    channel::FETCH_CHANNEL_DATA_COMMAND, CallbackFn, Channel, InvokeError, InvokeResponse,
    InvokeResponseBody, JavaScriptChannelId, RuntimeAuthority,
  },
  sealed::ManagerBase,
  utils::{
    acl::{capability::Capability, manifest::Manifest, resolved::Resolved},
    platform::Target,
  },
  webview::InvokeRequest,
  App, Webview, WebviewWindowBuilder,
};

fn app(manifests: &str, deny: bool) -> App<MockRuntime> {
  let acl: BTreeMap<String, Manifest> = serde_json::from_str(manifests).unwrap();
  let mut capabilities: BTreeMap<String, Capability> = BTreeMap::new();
  let first_party: Capability = serde_json::from_value(serde_json::json!({
    "identifier": "first-party-channel-test",
    "windows": ["main", "chat-assistant"],
    "permissions": ["core:default"]
  }))
  .unwrap();
  capabilities.insert(first_party.identifier.clone(), first_party);
  if deny {
    let denied: Capability = serde_json::from_value(serde_json::json!({
      "identifier": "explicit-channel-deny-test",
      "webviews": ["main"],
      "permissions": ["core:channel:deny-fetch"]
    }))
    .unwrap();
    capabilities.insert(denied.identifier.clone(), denied);
  }
  let resolved = Resolved::resolve(&acl, capabilities, Target::current()).unwrap();
  let mut context = mock_context(noop_assets());
  *context.runtime_authority_mut() = RuntimeAuthority::new(acl, resolved);
  mock_builder().build(context).unwrap()
}

fn window(app: &App<MockRuntime>, label: &str) -> Webview<MockRuntime> {
  let window = WebviewWindowBuilder::new(app, label, Default::default())
    .build()
    .unwrap();
  let webview: &Webview<MockRuntime> = window.as_ref();
  webview.clone()
}

fn script(webview: &Webview<MockRuntime>) -> String {
  webview.webview.dispatcher.last_evaluated_script().unwrap()
}

fn pending_id(webview: &Webview<MockRuntime>) -> u32 {
  let script = script(webview);
  assert!(script.contains(FETCH_CHANNEL_DATA_COMMAND));
  script
    .split("'Tauri-Channel-Id': '")
    .nth(1)
    .unwrap()
    .split('\'')
    .next()
    .unwrap()
    .parse()
    .unwrap()
}

fn fetch(
  webview: &Webview<MockRuntime>,
  id: Option<&str>,
  origin: Option<&str>,
) -> Result<InvokeResponseBody, serde_json::Value> {
  let mut headers = http::HeaderMap::new();
  if let Some(id) = id {
    headers.insert("Tauri-Channel-Id", id.parse().unwrap());
  }
  let request = InvokeRequest {
    cmd: FETCH_CHANNEL_DATA_COMMAND.into(),
    callback: CallbackFn(11),
    error: CallbackFn(12),
    url: origin
      .map(|url| url.parse().unwrap())
      .unwrap_or_else(|| webview.url().unwrap()),
    body: Default::default(),
    headers,
    invoke_key: INVOKE_KEY.into(),
  };
  let (tx, rx) = mpsc::sync_channel(1);
  webview.clone().on_message(
    request,
    Box::new(move |_, _, response, _, _| {
      tx.send(response).unwrap();
    }),
  );
  match rx
    .recv_timeout(Duration::from_secs(5))
    .expect("IPC response timed out")
  {
    InvokeResponse::Ok(body) => Ok(body),
    InvokeResponse::Err(InvokeError(error)) => Err(error),
  }
}

fn payload(raw: bool) -> InvokeResponseBody {
  if raw {
    InvokeResponseBody::Raw(vec![37; 16_384])
  } else {
    InvokeResponseBody::Json(serde_json::json!({ "data": "x".repeat(16_384) }).to_string())
  }
}

fn assert_body(body: InvokeResponseBody, raw: bool) {
  match (body, payload(raw)) {
    (InvokeResponseBody::Raw(actual), InvokeResponseBody::Raw(expected)) => {
      assert_eq!(actual, expected)
    }
    (InvokeResponseBody::Json(actual), InvokeResponseBody::Json(expected)) => {
      assert_eq!(actual, expected)
    }
    _ => panic!("response type changed"),
  }
}

/// Both ordinary invoke callbacks and streaming Channels retain their wire shape.
pub fn round_trip(manifests: &str, raw: bool, streaming: bool) {
  let app = app(manifests, false);
  let main = window(&app, "main");
  let other = window(&app, "chat-assistant");
  let channel: Channel = if streaming {
    "__CHANNEL__:42"
      .parse::<JavaScriptChannelId>()
      .unwrap()
      .channel_on(main.clone())
  } else {
    Channel::from_callback_fn(main.clone(), CallbackFn(42))
  };
  channel.send(payload(raw)).unwrap();
  let id = pending_id(&main).to_string();
  let first_script = script(&main);
  assert_eq!(
    first_script.contains("message: response, index: 0"),
    streaming
  );
  assert!(fetch(&other, Some(&id), None).is_err());
  assert_body(fetch(&main, Some(&id), None).unwrap(), raw);
  assert!(fetch(&main, Some(&id), None).is_err(), "replay must fail");
  channel.send(payload(raw)).unwrap();
  let second_id = pending_id(&main).to_string();
  assert_ne!(id, second_id);
  assert_eq!(
    script(&main).contains("message: response, index: 1"),
    streaming
  );
  assert_body(fetch(&main, Some(&second_id), None).unwrap(), raw);
  drop(channel);
  if streaming {
    assert!(script(&main).contains("end: true, index: 2"));
  }
}

/// Plugin windows and opaque/remote documents cannot bypass ACL, even for owned data.
pub fn ungranted_and_remote_denied(manifests: &str) {
  let app = app(manifests, false);
  let main = window(&app, "main");
  let plugin = window(&app, "plugin-ui-test");
  let channel: Channel = Channel::from_callback_fn(main.clone(), CallbackFn(42));
  channel.send(payload(false)).unwrap();
  let id = pending_id(&main).to_string();
  for origin in [
    "blob:http://tauri.localhost/test",
    "https://untrusted.invalid/",
  ] {
    assert!(fetch(&main, Some(&id), Some(origin)).is_err());
  }
  assert!(fetch(&plugin, Some(&id), None).is_err());
  assert_body(fetch(&main, Some(&id), None).unwrap(), false);
  let plugin_channel: Channel = Channel::from_callback_fn(plugin.clone(), CallbackFn(43));
  plugin_channel.send(payload(true)).unwrap();
  let own_id = pending_id(&plugin);
  assert!(fetch(&plugin, Some(&own_id.to_string()), None).is_err());
  assert_body(plugin.channel_data.take(own_id).unwrap(), true);
}

/// Explicit deny wins over core:default and does not consume the pending payload.
pub fn explicit_deny(manifests: &str) {
  let app = app(manifests, true);
  let main = window(&app, "main");
  let channel: Channel = Channel::from_callback_fn(main.clone(), CallbackFn(42));
  channel.send(payload(false)).unwrap();
  let id = pending_id(&main);
  assert!(fetch(&main, Some(&id.to_string()), None).is_err());
  assert_body(main.channel_data.take(id).unwrap(), false);
}

/// Unknown and malformed headers do not remove unrelated queued responses.
pub fn invalid_headers(manifests: &str) {
  let app = app(manifests, false);
  let main = window(&app, "main");
  let channel: Channel = Channel::from_callback_fn(main.clone(), CallbackFn(42));
  channel.send(payload(false)).unwrap();
  let id = pending_id(&main).to_string();
  for header in [
    None,
    Some("not-a-number"),
    Some("4294967296"),
    Some("4294967295"),
  ] {
    assert!(fetch(&main, header, None).is_err());
  }
  assert_body(fetch(&main, Some(&id), None).unwrap(), false);
}

/// Both native window removal and child-Webview close revoke outstanding clones.
pub fn close_and_reopen(manifests: &str, window_close: bool) {
  let app = app(manifests, false);
  let old = window(&app, "main");
  let channel: Channel = Channel::from_callback_fn(old.clone(), CallbackFn(42));
  channel.send(payload(false)).unwrap();
  let id = pending_id(&old).to_string();
  if window_close {
    app.manager().on_window_close("main");
  } else {
    old.close().unwrap();
  }
  assert!(fetch(&old, Some(&id), None).is_err());
  assert!(channel.send(payload(false)).is_err());
  assert!(channel.send(InvokeResponseBody::Raw(vec![1])).is_err());
  // Test a new instance with the same label, even if the mock runtime retains its window.
  let reopened = Webview::new(old.window(), old.webview.clone(), old.use_https_scheme());
  assert!(fetch(&reopened, Some(&id), None).is_err());
  let fresh: Channel = Channel::from_callback_fn(reopened.clone(), CallbackFn(43));
  fresh.send(payload(true)).unwrap();
  let fresh_id = pending_id(&reopened).to_string();
  assert_ne!(id, fresh_id);
  assert_body(fetch(&reopened, Some(&fresh_id), None).unwrap(), true);
}

/// Small payloads still use direct callbacks rather than allocating fetch entries.
pub fn small_callbacks(manifests: &str) {
  let app = app(manifests, false);
  let main = window(&app, "main");
  let channel: Channel = "__CHANNEL__:42"
    .parse::<JavaScriptChannelId>()
    .unwrap()
    .channel_on(main.clone());
  channel
    .send(InvokeResponseBody::Json("{\"ok\":true}".into()))
    .unwrap();
  assert!(!script(&main).contains(FETCH_CHANNEL_DATA_COMMAND));
  assert!(script(&main).contains("index: 0"));
  channel
    .send(InvokeResponseBody::Raw(vec![1, 2, 3]))
    .unwrap();
  assert!(!script(&main).contains(FETCH_CHANNEL_DATA_COMMAND));
  assert!(script(&main).contains("index: 1"));
}

/// Resolve the host's actual capability, not a test-only copy of its window list.
pub fn first_party_capability(manifests: &str, capability: &str) {
  let acl: BTreeMap<String, Manifest> = serde_json::from_str(manifests).unwrap();
  let capability: Capability = serde_json::from_str(capability).unwrap();
  let labels = capability.windows.clone();
  let capabilities = BTreeMap::from([(capability.identifier.clone(), capability)]);
  let resolved = Resolved::resolve(&acl, capabilities, Target::current()).unwrap();
  let mut context = mock_context(noop_assets());
  *context.runtime_authority_mut() = RuntimeAuthority::new(acl, resolved);
  let app = mock_builder().build(context).unwrap();
  for label in labels {
    let view = window(&app, &label);
    let channel: Channel = Channel::from_callback_fn(view.clone(), CallbackFn(42));
    channel.send(payload(false)).unwrap();
    let id = pending_id(&view).to_string();
    assert_body(fetch(&view, Some(&id), None).unwrap(), false);
  }
  let plugin = window(&app, "plugin-ui-ungranted");
  assert!(fetch(&plugin, Some("0"), None).is_err());
}

/// Absence of an app ACL must not revive the former internal-command exemption.
pub fn no_capability_denied() {
  let app = mock_builder().build(mock_context(noop_assets())).unwrap();
  let plugin = window(&app, "plugin-ui-test");
  let channel: Channel = Channel::from_callback_fn(plugin.clone(), CallbackFn(42));
  channel.send(payload(false)).unwrap();
  let id = pending_id(&plugin);
  assert!(fetch(&plugin, Some(&id.to_string()), None).is_err());
  assert_body(plugin.channel_data.take(id).unwrap(), false);
}

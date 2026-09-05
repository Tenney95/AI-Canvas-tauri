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

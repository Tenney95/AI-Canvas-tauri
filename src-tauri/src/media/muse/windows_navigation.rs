//! Native Windows navigation evidence. Never stores a URI, page text or credentials.
use super::{muse_url, AUTH_EPOCH, LOGIN_LABEL, SESSION_LABEL, WINDOW_LOADS};
use serde::Serialize;
use std::{collections::BTreeMap, sync::{atomic::{AtomicBool, Ordering}, Arc, LazyLock, Mutex}, time::Duration};
use tauri::WebviewWindow;
use tokio::sync::oneshot;
use url::Url;
use webview2_com::{
    CoTaskMemPWSTR, NavigationCompletedEventHandler, NavigationStartingEventHandler,
    Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2NavigationCompletedEventArgs2, COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED},
};
use windows_core::{BOOL, Interface, PCWSTR, PWSTR};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    stage: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")] hresult: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] is_success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] web_error_status: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")] http_status_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")] failure_stage: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")] starting_cancel: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] local_policy: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")] blocked_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] download_blocked: Option<bool>,
}

#[derive(Clone)]
struct Binding { label: String, epoch: u64, instance: u64 }
#[derive(Clone)]
struct Record { binding: Binding, snapshot: Snapshot, navigation_id: Option<u64> }
static RECORDS: LazyLock<Mutex<BTreeMap<String, Record>>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));
// Kept separately so destruction of a failed login window does not erase the evidence.
static LAST_AUTH: Mutex<Option<Record>> = Mutex::new(None);

fn current(binding: &Binding) -> bool {
    AUTH_EPOCH.load(Ordering::SeqCst) == binding.epoch && WINDOW_LOADS.lock().ok().is_some_and(|loads|
        loads.get(&binding.label).is_some_and(|load| load.epoch == binding.epoch && load.instance == binding.instance && load.native_ready))
}

fn update(binding: &Binding, change: impl FnOnce(&mut Record)) {
    if !current(binding) { return; }
    let record = {
        let Ok(mut records) = RECORDS.lock() else { return; };
        let Some(record) = records.get_mut(&binding.label).filter(|record|
            record.binding.epoch == binding.epoch && record.binding.instance == binding.instance) else { return; };
        change(record);
        record.clone()
    };
    if record.snapshot.stage == "failed" {
        if let Ok(mut loads) = WINDOW_LOADS.lock() { if let Some(load) = loads.get_mut(&binding.label)
            .filter(|load| load.epoch == binding.epoch && load.instance == binding.instance) { load.state = "failed"; } }
    }
    if matches!(binding.label.as_str(), LOGIN_LABEL | SESSION_LABEL) && AUTH_EPOCH.load(Ordering::SeqCst) == binding.epoch {
        if let Ok(mut last) = LAST_AUTH.lock() {
            if AUTH_EPOCH.load(Ordering::SeqCst) != binding.epoch { return; }
            if last.as_ref().is_none_or(|last| last.binding.epoch != binding.epoch || last.binding.instance <= binding.instance) { *last = Some(record); }
        }
    }
}

fn failed(binding: &Binding, stage: &'static str, hresult: Option<i32>) {
    update(binding, |record| {
        record.snapshot.stage = "failed";
        record.snapshot.failure_stage = Some(stage);
        if let Some(code) = hresult { record.snapshot.hresult = Some(format!("0x{:08X}", code as u32)); }
    });
}

fn install(core: &ICoreWebView2, binding: &Binding) -> windows_core::Result<()> {
    let starting = binding.clone();
    let mut token = 0;
    unsafe {
        core.add_NavigationStarting(&NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()); };
            let mut id = 0;
            let mut uri = PWSTR::null();
            let mut cancelled = BOOL(0);
            let values = args.NavigationId(&mut id).and_then(|_| args.Uri(&mut uri)).and_then(|_| args.Cancel(&mut cancelled));
            // SDK allocation is released immediately; the URI is only a transient classifier.
            let uri = if uri.0.is_null() { String::new() } else { CoTaskMemPWSTR::from(uri).to_string() };
            if let Err(error) = values { failed(&starting, "event", Some(error.code().0)); return Ok(()); }
            let Ok(url) = Url::parse(&uri) else { return Ok(()); };
            if url.as_str() == "about:blank" || url.scheme() == "aicanvas-muse" {
                update(&starting, |record| { if record.navigation_id == Some(id) { record.navigation_id = None; } });
                return Ok(());
            }
            let (policy, blocked_host) = WINDOW_LOADS.lock().ok().and_then(|loads| loads.get(&starting.label)
                .filter(|load| load.epoch == starting.epoch && load.instance == starting.instance)
                .map(|load| (load.local_policy, load.blocked_host.clone()))).unwrap_or((None, None));
            if !muse_url(&url) && policy != Some("deny-redirect") {
                // Allowed OAuth navigation is observable, but its completed document
                // must not masquerade as a completed Muse page.
                update(&starting, |record| {
                    record.navigation_id = None;
                    record.snapshot.starting_cancel = Some(cancelled.as_bool());
                    record.snapshot.local_policy = policy;
                    record.snapshot.blocked_host = None;
                });
                return Ok(());
            }
            update(&starting, |record| {
                record.navigation_id = Some(id);
                record.snapshot.is_success = None;
                record.snapshot.web_error_status = None;
                record.snapshot.http_status_code = None;
                record.snapshot.failure_stage = None;
                record.snapshot.stage = "starting";
                record.snapshot.starting_cancel = Some(cancelled.as_bool());
                record.snapshot.local_policy = policy;
                record.snapshot.blocked_host = blocked_host;
                record.snapshot.download_blocked = Some(false);
                if cancelled.as_bool() {
                    record.snapshot.stage = "failed";
                    record.snapshot.web_error_status = Some(COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED.0);
                    record.snapshot.failure_stage = Some("navigate");
                }
            });
            Ok(())
        })), &mut token)?;
        let completed = binding.clone();
        core.add_NavigationCompleted(&NavigationCompletedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()); };
            let mut id = 0;
            if args.NavigationId(&mut id).is_err() { return Ok(()); }
            let tracked = RECORDS.lock().ok().is_some_and(|records| records.get(&completed.label).is_some_and(|record|
                record.binding.epoch == completed.epoch && record.binding.instance == completed.instance && record.navigation_id == Some(id)));
            if !tracked { return Ok(()); }
            let mut success = BOOL(0);
            let mut status = Default::default();
            if let Err(error) = args.IsSuccess(&mut success).and_then(|_| args.WebErrorStatus(&mut status)) {
                failed(&completed, "event", Some(error.code().0)); return Ok(());
            }
            let http = args.cast::<ICoreWebView2NavigationCompletedEventArgs2>().ok().and_then(|args| {
                let mut status = 0;
                args.HttpStatusCode(&mut status).ok().and_then(|_| (100..=599).contains(&status).then_some(status))
            });
            update(&completed, |record| {
                if record.navigation_id != Some(id) { return; }
                record.snapshot.stage = if success.as_bool() { "completed" } else { "failed" };
                record.snapshot.is_success = Some(success.as_bool());
                record.snapshot.web_error_status = Some(status.0);
                record.snapshot.http_status_code = http;
                record.snapshot.failure_stage = if success.as_bool() { None } else { Some("navigate") };
            });
            Ok(())
        })), &mut token)?;
    }
    Ok(())
}

struct CancelCall(Arc<AtomicBool>);
impl Drop for CancelCall { fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); } }

pub(super) async fn navigate(window: &WebviewWindow, target: &Url, epoch: u64, instance: u64) -> Result<(), String> {
    let binding = Binding { label: window.label().into(), epoch, instance };
    if !current(&binding) || !muse_url(target) { return Err("muse_webview_navigation_cancelled".into()); }
    RECORDS.lock().map_err(|_| "muse_webview_navigation_failed")?.insert(binding.label.clone(), Record {
        binding: binding.clone(), navigation_id: None, snapshot: Snapshot {
            stage: "waiting", hresult: None, is_success: None, web_error_status: None, http_status_code: None, failure_stage: None,
            starting_cancel: None, local_policy: None, blocked_host: None, download_blocked: Some(false),
        },
    });
    update(&binding, |_| {});
    let wide: Vec<u16> = target.as_str().encode_utf16().chain(Some(0)).collect();
    let cancel = Arc::new(AtomicBool::new(false));
    let _cancel_on_drop = CancelCall(cancel.clone());
    let callback_binding = binding.clone();
    let (sender, receiver) = oneshot::channel();
    window.with_webview(move |platform| {
        let result = (|| {
            if cancel.load(Ordering::SeqCst) || !current(&callback_binding) { return Err("muse_webview_navigation_cancelled".to_string()); }
            let core = unsafe { platform.controller().CoreWebView2() }.map_err(|error| {
                failed(&callback_binding, "controller", Some(error.code().0)); "muse_webview_controller_failed".to_string()
            })?;
            install(&core, &callback_binding).map_err(|error| {
                failed(&callback_binding, "register", Some(error.code().0)); "muse_webview_navigation_observer_failed".to_string()
            })?;
            if cancel.load(Ordering::SeqCst) || !current(&callback_binding) { return Err("muse_webview_navigation_cancelled".to_string()); }
            // Real WebView2 HRESULT, unlike the success of enqueuing Tauri Navigate.
            unsafe { core.Navigate(PCWSTR(wide.as_ptr())) }.map_err(|error| {
                failed(&callback_binding, "navigate", Some(error.code().0)); "muse_webview_navigation_failed".to_string()
            })?;
            update(&callback_binding, |record| {
                record.snapshot.hresult = Some("0x00000000".into());
                if record.snapshot.stage == "waiting" { record.snapshot.stage = "accepted"; }
            });
            Ok(())
        })();
        let _ = sender.send(result);
    }).map_err(|_| { failed(&binding, "controller", None); "muse_webview_controller_failed" })?;
    match tokio::time::timeout(Duration::from_secs(10), receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => { failed(&binding, "controller", None); Err("muse_webview_controller_failed".into()) },
        Err(_) => { failed(&binding, "navigate", None); Err("muse_webview_navigation_timeout".into()) },
    }
}

pub(super) fn snapshot(epoch: u64) -> Option<Snapshot> {
    LAST_AUTH.lock().ok()?.as_ref().filter(|record| record.binding.epoch == epoch).map(|record| record.snapshot.clone())
}

pub(super) fn download_blocked(label: &str, epoch: u64, instance: u64) {
    let binding = Binding { label: label.into(), epoch, instance };
    update(&binding, |record| { record.snapshot.download_blocked = Some(true); });
}

pub(super) fn clear() {
    if let Ok(mut records) = RECORDS.lock() { records.clear(); }
    if let Ok(mut last) = LAST_AUTH.lock() { *last = None; }
}

pub(super) fn forget(label: &str, epoch: u64, instance: u64) {
    if let Ok(mut records) = RECORDS.lock() {
        if records.get(label).is_some_and(|record| record.binding.epoch == epoch && record.binding.instance == instance) { records.remove(label); }
    }
}

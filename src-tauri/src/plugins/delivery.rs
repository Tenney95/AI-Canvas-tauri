//! Receives versioned local plugin packages opened by the operating system.
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, Webview};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryStatus {
    Added,
    Installed,
    Unchanged,
    Failed,
    Cancelled,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ResourcePayload {
    id: String,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryPackage {
    request_id: String,
    manifest_text: String,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ui_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resource_payloads: Option<Vec<ResourcePayload>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trusted_publisher: Option<String>,
}

#[derive(Default)]
pub struct DeliveryState {
    #[cfg(any(target_os = "macos", windows))]
    queue: std::sync::Arc<std::sync::Mutex<desktop::Queue>>,
    #[cfg(windows)]
    wake_worker: std::sync::Mutex<Option<desktop::windows_platform::WakeWorker>>,
}

fn ensure_main(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("插件包交付只允许主窗口处理".into());
    }
    crate::path_policy::ensure_local_frontend_caller(webview)
}

#[tauri::command]
pub async fn plugin_delivery_take(
    app: AppHandle,
    webview: Webview,
    state: State<'_, DeliveryState>,
    session_id: String,
) -> Result<Option<DeliveryPackage>, String> {
    ensure_main(&webview)?;
    #[cfg(any(target_os = "macos", windows))]
    return desktop::take(&app, &state, &session_id)
        .await
        .map_err(str::to_owned);
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, state, session_id);
        Ok(None)
    }
}

#[tauri::command]
pub async fn plugin_delivery_check(
    webview: Webview,
    state: State<'_, DeliveryState>,
    request_id: String,
    session_id: String,
) -> Result<bool, String> {
    ensure_main(&webview)?;
    #[cfg(any(target_os = "macos", windows))]
    return Ok(desktop::check(&state, &request_id, &session_id).await);
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (state, request_id, session_id);
        Ok(false)
    }
}

#[tauri::command]
pub async fn plugin_delivery_finish(
    app: AppHandle,
    webview: Webview,
    state: State<'_, DeliveryState>,
    request_id: String,
    session_id: String,
    status: DeliveryStatus,
) -> Result<(), String> {
    ensure_main(&webview)?;
    #[cfg(any(target_os = "macos", windows))]
    return desktop::finish(&app, &state, &request_id, &session_id, status)
        .await
        .map_err(str::to_owned);
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, state, request_id, session_id, status);
        Err("当前系统不支持通过桌面打开插件包".into())
    }
}

#[cfg(target_os = "macos")]
pub(crate) use desktop::on_opened;

#[cfg(windows)]
pub(crate) use desktop::windows_platform::{
    prepare_windows_launch, stop_windows_wake, WindowsLaunch,
};

#[cfg(any(target_os = "macos", windows))]
mod desktop {
    use super::{DeliveryPackage, DeliveryState, DeliveryStatus, ResourcePayload};
    use serde::{Deserialize, Serialize};
    use sha2::{Digest, Sha256};
    use std::{
        collections::{HashSet, VecDeque},
        fs::File,
        io::{self, Read},
        path::{Path, PathBuf},
        sync::{Arc, OnceLock},
        time::{Duration, Instant},
    };
    use tauri::{AppHandle, Emitter, Manager};

    #[cfg(target_os = "macos")]
    use macos_platform::{file_stamp, FileStamp, PinnedDirectory};
    #[cfg(windows)]
    use windows_platform::{file_stamp, FileStamp, PinnedDirectory};

    const DIRECTORY: &str = "ai-canvas-plugin-delivery-v1";
    const EVENT: &str = "plugin-delivery-requested";
    const INVALID: &str = "外部插件包无效或已失效";
    const IO_ERROR: &str = "无法访问外部插件包交付目录";
    const MAX_QUEUE: usize = 8;
    const MAX_COMPLETED: usize = 32;
    const QUEUE_TTL: Duration = Duration::from_secs(120);
    const CLAIM_TTL: Duration = Duration::from_secs(300);
    const MAX_ENVELOPE_BYTES: u64 = 16 * 1024 * 1024;
    const MAX_MANIFEST_BYTES: usize = 64 * 1024;
    const MAX_SOURCE_BYTES: usize = 512 * 1024;
    const MAX_UI_SOURCE_BYTES: usize = 2 * 1024 * 1024;
    const MAX_PACKAGE_RESOURCES: usize = 64;
    const MAX_PACKAGE_RESOURCE_BYTES: usize = 16 * 1024 * 1024;
    const MAX_PACKAGE_TOTAL_BYTES: usize = 64 * 1024 * 1024;

    type DeliveryResult<T> = Result<T, &'static str>;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Envelope {
        format_version: u8,
        manifest_text: String,
        source: String,
        ui_source: Option<String>,
        resource_payloads: Option<Vec<ResourcePayload>>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct TrustedBundles {
        schema_version: u8,
        bundles: Vec<TrustedBundle>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct TrustedBundle {
        sha256: String,
        publisher: String,
    }

    fn trusted_publisher(bytes: &[u8]) -> Option<String> {
        static BUNDLES: OnceLock<Option<TrustedBundles>> = OnceLock::new();
        let index = BUNDLES
            .get_or_init(|| {
                serde_json::from_str(include_str!(
                    "../../resources/trusted-external-plugin-bundles.json"
                ))
                .ok()
            })
            .as_ref()?;
        if index.schema_version != 1 {
            return None;
        }
        let digest = format!("{:x}", Sha256::digest(bytes));
        Some(
            index
                .bundles
                .iter()
                .find(|bundle| bundle.sha256 == digest)?
                .publisher
                .clone(),
        )
    }

    fn parse_package(request_id: String, bytes: &[u8]) -> DeliveryResult<DeliveryPackage> {
        let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| INVALID)?;
        if envelope.format_version != 1
            || envelope.manifest_text.trim().is_empty()
            || envelope.manifest_text.len() > MAX_MANIFEST_BYTES
            || envelope.source.trim().is_empty()
            || envelope.source.len() > MAX_SOURCE_BYTES
            || envelope.ui_source.as_ref().is_some_and(|source| {
                source.trim().is_empty() || source.len() > MAX_UI_SOURCE_BYTES
            })
        {
            return Err(INVALID);
        }
        if let Some(resources) = &envelope.resource_payloads {
            if resources.len() > MAX_PACKAGE_RESOURCES {
                return Err(INVALID);
            }
            let mut ids = HashSet::new();
            let mut total_bytes = 0;
            for resource in resources {
                if resource.id.is_empty()
                    || resource.id.len() > 96
                    || !ids.insert(&resource.id)
                    || resource.bytes.is_empty()
                    || resource.bytes.len() > MAX_PACKAGE_RESOURCE_BYTES
                {
                    return Err(INVALID);
                }
                total_bytes += resource.bytes.len();
                if total_bytes > MAX_PACKAGE_TOTAL_BYTES {
                    return Err(INVALID);
                }
            }
        }
        Ok(DeliveryPackage {
            request_id,
            manifest_text: envelope.manifest_text,
            source: envelope.source,
            ui_source: envelope.ui_source,
            resource_payloads: envelope.resource_payloads,
            trusted_publisher: trusted_publisher(bytes),
        })
    }

    fn request_id<'a>(filename: &'a str, suffix: &str) -> Option<&'a str> {
        let id = filename.strip_suffix(suffix)?;
        (id.len() == 32
            && id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
        .then_some(id)
    }

    fn valid_session_id(id: &str) -> bool {
        match id.len() {
            32 => request_id(id, "").is_some(),
            36 => id.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                }
            }),
            _ => false,
        }
    }

    fn base_dir(app: &AppHandle) -> DeliveryResult<PathBuf> {
        app.path().temp_dir().map_err(|_| IO_ERROR)
    }

    fn id_from_path<'a>(path: &'a Path, base: &Path) -> Option<&'a str> {
        let parent = path.parent()?;
        let parent_matches = parent == base.join(DIRECTORY);
        #[cfg(target_os = "macos")]
        let parent_matches = parent_matches
            || base
                .canonicalize()
                .is_ok_and(|canonical| parent == canonical.join(DIRECTORY));
        if !path.is_absolute() || !parent_matches {
            return None;
        }
        request_id(path.file_name()?.to_str()?, ".aicplugin")
    }

    fn read_package(file: &mut File) -> DeliveryResult<Vec<u8>> {
        let size = file.metadata().map_err(|_| IO_ERROR)?.len();
        if !(1..=MAX_ENVELOPE_BYTES).contains(&size) {
            return Err(INVALID);
        }
        let mut bytes = Vec::new();
        (&mut *file)
            .take(size + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| IO_ERROR)?;
        if bytes.len() as u64 != size || file.metadata().map_err(|_| IO_ERROR)?.len() != size {
            return Err(INVALID);
        }
        Ok(bytes)
    }

    struct Request {
        id: String,
        expires: Instant,
    }

    struct Claim {
        request: Request,
        target: Option<Arc<ClaimTarget>>,
    }

    struct ClaimTarget {
        directory: PinnedDirectory,
        stamp: FileStamp,
    }

    impl ClaimTarget {
        fn open_current(&self, id: &str) -> Option<File> {
            let file = self.directory.open_file(&format!("{id}.aicplugin")).ok()?;
            (file_stamp(&file).ok()? == self.stamp).then_some(file)
        }
    }

    #[derive(Default)]
    pub(super) struct Queue {
        waiting: VecDeque<Request>,
        active: Option<Claim>,
        completed: VecDeque<Request>,
        session: Option<String>,
        retired_sessions: VecDeque<String>,
    }

    impl Queue {
        fn prune(&mut self, now: Instant) {
            self.waiting.retain(|item| item.expires > now);
            self.completed.retain(|item| item.expires > now);
            if self
                .active
                .as_ref()
                .is_some_and(|claim| claim.request.expires <= now)
            {
                self.active = None;
            }
        }

        fn enqueue(&mut self, id: &str, now: Instant) -> bool {
            self.prune(now);
            if self.waiting.len() >= MAX_QUEUE
                || self
                    .waiting
                    .iter()
                    .chain(&self.completed)
                    .any(|request| request.id == id)
                || self
                    .active
                    .as_ref()
                    .is_some_and(|claim| claim.request.id == id)
            {
                return false;
            }
            self.waiting.push_back(Request {
                id: id.into(),
                expires: now + QUEUE_TTL,
            });
            true
        }

        fn claim(&mut self, session_id: &str, now: Instant) -> Option<String> {
            self.prune(now);
            if self.session.as_deref() != Some(session_id) {
                if self
                    .retired_sessions
                    .iter()
                    .any(|retired| retired == session_id)
                {
                    return None;
                }
                if let Some(previous) = self.session.replace(session_id.into()) {
                    if self.retired_sessions.len() >= MAX_COMPLETED {
                        self.retired_sessions.pop_front();
                    }
                    self.retired_sessions.push_back(previous);
                    self.discard();
                }
            }
            if self.active.is_some() {
                return None;
            }
            let mut request = self.waiting.pop_front()?;
            let id = request.id.clone();
            request.expires = now + CLAIM_TTL;
            self.active = Some(Claim {
                request,
                target: None,
            });
            Some(id)
        }

        fn active(&mut self, id: &str, session_id: &str, now: Instant) -> Option<&mut Claim> {
            self.prune(now);
            if self.session.as_deref() != Some(session_id) {
                return None;
            }
            self.active.as_mut().filter(|claim| claim.request.id == id)
        }

        fn discard(&mut self) -> Option<Claim> {
            let active = self.active.take()?;
            if self.completed.len() >= MAX_COMPLETED {
                self.completed.pop_front();
            }
            self.completed.push_back(Request {
                id: active.request.id.clone(),
                expires: active.request.expires,
            });
            Some(active)
        }
    }

    fn notify(app: &AppHandle) {
        let _ = app.emit_to("main", EVENT, ());
    }

    fn enqueue(app: &AppHandle, ids: impl IntoIterator<Item = String>) {
        let state = app.state::<DeliveryState>();
        let Ok(mut queue) = state.queue.lock() else {
            return;
        };
        let mut changed = false;
        for id in ids.into_iter().take(MAX_QUEUE) {
            changed |= queue.enqueue(&id, Instant::now());
        }
        drop(queue);
        if changed {
            notify(app);
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn on_opened(app: &AppHandle, urls: &[tauri::Url]) {
        let Ok(base) = base_dir(app) else { return };
        enqueue(
            app,
            urls.iter().filter_map(|url| {
                id_from_path(&url.to_file_path().ok()?, &base).map(str::to_owned)
            }),
        );
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Receipt<'a> {
        request_id: &'a str,
        status: DeliveryStatus,
    }

    fn write_receipt(
        directory: &PinnedDirectory,
        id: &str,
        status: DeliveryStatus,
    ) -> DeliveryResult<()> {
        let bytes = serde_json::to_vec(&Receipt {
            request_id: id,
            status,
        })
        .map_err(|_| IO_ERROR)?;
        let nonce = crate::secure_random::random_bytes::<8>().map_err(|_| IO_ERROR)?;
        let nonce = nonce
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        directory
            .publish(
                &format!(".{id}.{nonce}.tmp"),
                &format!("{id}.result.json"),
                &bytes,
            )
            .map_err(|_| IO_ERROR)
    }

    fn claim_package(
        base: &Path,
        id: &str,
    ) -> DeliveryResult<Option<(ClaimTarget, DeliveryResult<DeliveryPackage>)>> {
        let directory = PinnedDirectory::open(base).map_err(|_| IO_ERROR)?;
        match directory.open_file(&format!("{id}.result.json")) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            _ => return Ok(None),
        }
        let mut file = match directory.open_file(&format!("{id}.aicplugin")) {
            Ok(file) => file,
            Err(_) => return Err(INVALID),
        };
        let stamp = file_stamp(&file).map_err(|_| INVALID)?;
        let package = read_package(&mut file).and_then(|bytes| {
            if file_stamp(&file).map_err(|_| INVALID)? != stamp {
                return Err(INVALID);
            }
            parse_package(id.into(), &bytes)
        });
        Ok(Some((ClaimTarget { directory, stamp }, package)))
    }

    pub(super) async fn take(
        app: &AppHandle,
        state: &DeliveryState,
        session_id: &str,
    ) -> DeliveryResult<Option<DeliveryPackage>> {
        if !valid_session_id(session_id) {
            return Err(INVALID);
        }
        let base = base_dir(app)?;
        let claim = state
            .queue
            .lock()
            .map_err(|_| IO_ERROR)?
            .claim(session_id, Instant::now());
        let Some(id) = claim else { return Ok(None) };
        let accepted_id = id.clone();
        let package = tokio::task::spawn_blocking(move || claim_package(&base, &accepted_id))
            .await
            .unwrap_or(Err(IO_ERROR));
        let parsed = {
            let mut queue = state.queue.lock().map_err(|_| IO_ERROR)?;
            let claim = queue
                .active(&id, session_id, Instant::now())
                .ok_or(INVALID)?;
            match package {
                Ok(Some((target, package))) => {
                    claim.target = Some(Arc::new(target));
                    package
                }
                result => {
                    queue.discard();
                    let more = !queue.waiting.is_empty();
                    drop(queue);
                    if more {
                        notify(app);
                    }
                    return result.map(|_| None);
                }
            }
        };
        let package = match parsed {
            Ok(package) => package,
            Err(error) => {
                let _ = finish(app, state, &id, session_id, DeliveryStatus::Failed).await;
                return Err(error);
            }
        };
        #[cfg(windows)]
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        Ok(Some(package))
    }

    pub(super) async fn check(state: &DeliveryState, id: &str, session_id: &str) -> bool {
        let target = state
            .queue
            .lock()
            .ok()
            .and_then(|mut queue| queue.active(id, session_id, Instant::now())?.target.clone());
        let Some(target) = target else { return false };
        let id_to_check = id.to_owned();
        let opened_target = Arc::clone(&target);
        let current =
            tokio::task::spawn_blocking(move || opened_target.open_current(&id_to_check).is_some())
                .await
                .unwrap_or(false);
        current
            && state
                .queue
                .lock()
                .ok()
                .and_then(|mut queue| queue.active(id, session_id, Instant::now())?.target.clone())
                .is_some_and(|active| Arc::ptr_eq(&active, &target))
    }

    pub(super) async fn finish(
        app: &AppHandle,
        state: &DeliveryState,
        id: &str,
        session_id: &str,
        status: DeliveryStatus,
    ) -> DeliveryResult<()> {
        let queue = Arc::clone(&state.queue);
        let id = id.to_owned();
        let session_id = session_id.to_owned();
        let result = tokio::task::spawn_blocking(move || {
            let mut queue = queue.lock().map_err(|_| IO_ERROR)?;
            finish_claim(&mut queue, &id, &session_id, status)
        })
        .await
        .unwrap_or(Err(IO_ERROR));
        if state
            .queue
            .lock()
            .is_ok_and(|queue| !queue.waiting.is_empty())
        {
            notify(app);
        }
        result
    }

    fn finish_claim(
        queue: &mut Queue,
        id: &str,
        session_id: &str,
        status: DeliveryStatus,
    ) -> DeliveryResult<()> {
        let target = queue
            .active(id, session_id, Instant::now())
            .and_then(|claim| claim.target.take())
            .ok_or(INVALID)?;
        queue.discard();
        // The sender may remove its package to withdraw the delivery. Keep the reopened
        // file live while publishing so Windows cannot replace it during this transaction.
        match target.open_current(id) {
            Some(_file) => write_receipt(&target.directory, id, status),
            None => Ok(()),
        }
    }

    #[cfg(target_os = "macos")]
    mod macos_platform {
        use super::DIRECTORY;
        use std::{
            ffi::CString,
            fs::{File, OpenOptions},
            io::{self, Write},
            os::{
                fd::{AsRawFd, FromRawFd},
                raw::{c_char, c_int, c_uint},
                unix::fs::{MetadataExt, OpenOptionsExt},
            },
            path::Path,
        };

        const DIRECTORY_FLAG: c_int = 0x100000;
        const NOFOLLOW: c_int = 0x100;
        const CLOEXEC: c_int = 0x1000000;
        const NONBLOCK: c_int = 0x4;
        const CREATE_EXCLUSIVE: c_int = 0x200 | 0x800 | 1;
        const RENAME_EXCLUSIVE: c_uint = 0x00000004;

        extern "C" {
            fn geteuid() -> u32;
            fn openat(directory: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
            fn renameatx_np(
                from: c_int,
                source: *const c_char,
                to: c_int,
                target: *const c_char,
                flags: c_uint,
            ) -> c_int;
            fn unlinkat(directory: c_int, path: *const c_char, flags: c_int) -> c_int;
        }

        pub(super) struct PinnedDirectory(File);

        #[derive(PartialEq, Eq)]
        pub(super) struct FileStamp {
            device: u64,
            inode: u64,
            length: u64,
            modified: (i64, i64),
            changed: (i64, i64),
        }

        pub(super) fn file_stamp(file: &File) -> io::Result<FileStamp> {
            let metadata = file.metadata()?;
            if metadata.nlink() != 1 {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            Ok(FileStamp {
                device: metadata.dev(),
                inode: metadata.ino(),
                length: metadata.len(),
                modified: (metadata.mtime(), metadata.mtime_nsec()),
                changed: (metadata.ctime(), metadata.ctime_nsec()),
            })
        }

        fn name(value: &str) -> io::Result<CString> {
            CString::new(value).map_err(|_| io::ErrorKind::InvalidInput.into())
        }

        fn open_entry(parent: &File, entry: &CString, flags: c_int) -> io::Result<File> {
            // Open only fixed or validated components relative to an already pinned directory.
            let descriptor = unsafe {
                openat(
                    parent.as_raw_fd(),
                    entry.as_ptr(),
                    NOFOLLOW | CLOEXEC | NONBLOCK | flags,
                    0o600 as c_uint,
                )
            };
            if descriptor < 0 {
                return Err(io::Error::last_os_error());
            }
            // The successful descriptor transfers to exactly one owning File.
            Ok(unsafe { File::from_raw_fd(descriptor) })
        }

        impl PinnedDirectory {
            pub(super) fn open(base: &Path) -> io::Result<Self> {
                let parent = OpenOptions::new()
                    .read(true)
                    .custom_flags(DIRECTORY_FLAG | NOFOLLOW | CLOEXEC)
                    .open(base.canonicalize()?)?;
                let directory = open_entry(&parent, &name(DIRECTORY)?, DIRECTORY_FLAG)?;
                let metadata = directory.metadata()?;
                if !metadata.is_dir()
                    || metadata.uid() != unsafe { geteuid() }
                    || metadata.mode() & 0o7777 != 0o700
                {
                    return Err(io::ErrorKind::PermissionDenied.into());
                }
                Ok(Self(directory))
            }

            pub(super) fn open_file(&self, leaf: &str) -> io::Result<File> {
                let file = open_entry(&self.0, &name(leaf)?, 0)?;
                let metadata = file.metadata()?;
                if !metadata.is_file()
                    || metadata.nlink() != 1
                    || metadata.uid() != unsafe { geteuid() }
                    || metadata.mode() & !0o600 & 0o7777 != 0
                {
                    return Err(io::ErrorKind::PermissionDenied.into());
                }
                Ok(file)
            }

            pub(super) fn publish(
                &self,
                temporary: &str,
                target: &str,
                bytes: &[u8],
            ) -> io::Result<()> {
                let temporary = name(temporary)?;
                let target = name(target)?;
                let mut file = open_entry(&self.0, &temporary, CREATE_EXCLUSIVE)?;
                let fd = self.0.as_raw_fd();
                let result = file
                    .write_all(bytes)
                    .and_then(|()| file.sync_all())
                    .and_then(|()| {
                        // renameatx_np is atomic and fails if a receipt already exists.
                        if unsafe {
                            renameatx_np(
                                fd,
                                temporary.as_ptr(),
                                fd,
                                target.as_ptr(),
                                RENAME_EXCLUSIVE,
                            )
                        } == 0
                        {
                            Ok(())
                        } else {
                            Err(io::Error::last_os_error())
                        }
                    });
                if result.is_err() {
                    // Remove only the reserved staging name created by this call.
                    let _ = unsafe { unlinkat(fd, temporary.as_ptr(), 0) };
                }
                result
            }
        }
    }
    #[cfg(windows)]
    pub(super) mod windows_platform {
        use super::{
            enqueue, id_from_path, request_id, AppHandle, DeliveryState, Manager, DIRECTORY,
            MAX_QUEUE, QUEUE_TTL,
        };
        use crate::plugin_delivery::windows_security::{
            verify_private_handle, verify_profile_file, CurrentUser,
        };
        use std::{
            ffi::OsString,
            fs::{self, File, OpenOptions},
            io::{self, Write},
            mem::size_of,
            os::windows::{
                ffi::{OsStrExt, OsStringExt},
                fs::OpenOptionsExt,
                io::{AsRawHandle, FromRawHandle, OwnedHandle},
            },
            path::{Component, Path, PathBuf, Prefix},
            sync::{
                atomic::{AtomicBool, Ordering},
                Arc,
            },
        };
        use windows::{
            core::{PCWSTR, PWSTR},
            Win32::{
                Foundation::{
                    GetLastError, LocalFree, SetLastError, ERROR_ALREADY_EXISTS, ERROR_SUCCESS,
                    HANDLE, HLOCAL, WAIT_OBJECT_0,
                },
                Security::{
                    Authorization::{
                        ConvertSidToStringSidW,
                        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
                        SE_KERNEL_OBJECT,
                    },
                    PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
                },
                Storage::FileSystem::{
                    GetFileInformationByHandle, GetFileType, MoveFileExW,
                    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
                    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
                    FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_DISK, MOVEFILE_WRITE_THROUGH,
                    READ_CONTROL,
                },
                System::{
                    Com::CoTaskMemFree,
                    Threading::{
                        CreateEventW, SetEvent, WaitForSingleObject, EVENT_ALL_ACCESS, INFINITE,
                    },
                },
                UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath, KF_FLAG_DEFAULT},
            },
        };

        // A signal is an empty reserved file. Higher-level package and receipt files are never scanned.
        const MAX_SCANNED_ENTRIES: usize = 256;

        pub(super) struct PinnedDirectory {
            path: PathBuf,
            directory: File,
            user: CurrentUser,
            _ancestors: Vec<File>,
        }

        #[derive(PartialEq, Eq)]
        pub(super) struct FileStamp {
            identity: (u32, u32, u32),
            length: (u32, u32),
            created: (u32, u32),
            modified: (u32, u32),
        }

        fn file_information(file: &File) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            // The file owns a live handle and the output buffer matches the Win32 ABI.
            unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
                .map_err(io::Error::other)?;
            Ok(info)
        }

        fn file_identity(info: &BY_HANDLE_FILE_INFORMATION) -> (u32, u32, u32) {
            (
                info.dwVolumeSerialNumber,
                info.nFileIndexHigh,
                info.nFileIndexLow,
            )
        }

        fn local_app_data() -> io::Result<PathBuf> {
            // A null token selects this process's current Windows account. The returned
            // path belongs to the Win32 task allocator and is copied before release.
            let path = unsafe {
                SHGetKnownFolderPath(&FOLDERID_LocalAppData, KF_FLAG_DEFAULT, HANDLE::default())
            }
            .map_err(io::Error::other)?;
            if path.is_null() {
                return Err(io::ErrorKind::NotFound.into());
            }
            let local = PathBuf::from(OsString::from_wide(unsafe { path.as_wide() }));
            unsafe { CoTaskMemFree(Some(path.0.cast())) };
            Ok(local)
        }

        pub(super) fn file_stamp(file: &File) -> io::Result<FileStamp> {
            let info = file_information(file)?;
            if info.nNumberOfLinks != 1 {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            Ok(FileStamp {
                identity: file_identity(&info),
                length: (info.nFileSizeHigh, info.nFileSizeLow),
                created: (
                    info.ftCreationTime.dwHighDateTime,
                    info.ftCreationTime.dwLowDateTime,
                ),
                modified: (
                    info.ftLastWriteTime.dwHighDateTime,
                    info.ftLastWriteTime.dwLowDateTime,
                ),
            })
        }

        fn open_pinned(path: &Path, is_directory: bool, access: u32) -> io::Result<File> {
            let sharing = if is_directory {
                FILE_SHARE_READ | FILE_SHARE_WRITE
            } else {
                FILE_SHARE_READ
            };
            let file = OpenOptions::new()
                .access_mode(access)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0 | FILE_FLAG_BACKUP_SEMANTICS.0)
                .share_mode(sharing.0)
                .open(path)?;
            let handle = HANDLE(file.as_raw_handle());
            let info = file_information(&file)?;
            if unsafe { GetFileType(handle) } != FILE_TYPE_DISK
                || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0) != is_directory
                || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
                || (!is_directory && info.nNumberOfLinks != 1)
            {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            Ok(file)
        }

        impl PinnedDirectory {
            pub(super) fn open(base: &Path) -> io::Result<Self> {
                if !base.is_absolute()
                    || !matches!(base.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
                {
                    return Err(io::ErrorKind::PermissionDenied.into());
                }
                let path = base.join(DIRECTORY);
                let mut parents: Vec<_> = base
                    .ancestors()
                    .filter(|parent| parent.is_absolute())
                    .collect();
                parents.reverse();
                // No DELETE sharing keeps each checked directory from being swapped during use.
                let ancestors = parents
                    .into_iter()
                    .map(|parent| open_pinned(parent, true, FILE_READ_ATTRIBUTES.0))
                    .collect::<io::Result<Vec<_>>>()?;
                let local = open_pinned(&local_app_data()?, true, FILE_READ_ATTRIBUTES.0)?;
                let local_identity = file_identity(&file_information(&local)?);
                // Resolve containment by pinned file identity, independent of path casing.
                if !ancestors.iter().any(|parent| {
                    file_information(parent)
                        .is_ok_and(|info| file_identity(&info) == local_identity)
                }) {
                    return Err(io::ErrorKind::PermissionDenied.into());
                }
                let directory = open_pinned(&path, true, FILE_READ_ATTRIBUTES.0 | READ_CONTROL.0)?;
                let user = CurrentUser::read().map_err(|_| io::ErrorKind::PermissionDenied)?;
                verify_profile_file(HANDLE(directory.as_raw_handle()), &user)
                    .map_err(|_| io::ErrorKind::PermissionDenied)?;
                Ok(Self {
                    path,
                    directory,
                    user,
                    _ancestors: ancestors,
                })
            }

            pub(super) fn open_file(&self, leaf: &str) -> io::Result<File> {
                self.verify_directory()?;
                let file = open_pinned(&self.path.join(leaf), false, FILE_GENERIC_READ.0)?;
                verify_profile_file(HANDLE(file.as_raw_handle()), &self.user)
                    .map_err(|_| io::ErrorKind::PermissionDenied)?;
                Ok(file)
            }

            fn verify_directory(&self) -> io::Result<()> {
                verify_profile_file(HANDLE(self.directory.as_raw_handle()), &self.user)
                    .map_err(|_| io::ErrorKind::PermissionDenied.into())
            }

            fn create_file(&self, leaf: &str) -> io::Result<File> {
                self.verify_directory()?;
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
                    .share_mode(FILE_SHARE_READ.0)
                    .open(self.path.join(leaf))
            }

            pub(super) fn publish(
                &self,
                temporary: &str,
                target: &str,
                bytes: &[u8],
            ) -> io::Result<()> {
                let mut file = self.create_file(temporary)?;
                let written = file.write_all(bytes).and_then(|()| file.sync_all());
                drop(file);
                let staging = self.path.join(temporary);
                let result = written.and_then(|()| {
                    let source: Vec<_> = staging.as_os_str().encode_wide().chain(Some(0)).collect();
                    let destination: Vec<_> = self
                        .path
                        .join(target)
                        .as_os_str()
                        .encode_wide()
                        .chain(Some(0))
                        .collect();
                    // Same-directory rename without MOVEFILE_REPLACE_EXISTING is atomic and exclusive.
                    unsafe {
                        MoveFileExW(
                            PCWSTR(source.as_ptr()),
                            PCWSTR(destination.as_ptr()),
                            MOVEFILE_WRITE_THROUGH,
                        )
                    }
                    .map_err(io::Error::other)
                });
                if result.is_err() {
                    let _ = fs::remove_file(staging);
                }
                result
            }

            fn stage_wake(&self, id: &str) -> io::Result<()> {
                self.open_file(&format!("{id}.aicplugin"))?;
                match self.create_file(&format!("{id}.wake")) {
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
                    result => result.map(drop),
                }
            }

            fn take_wakes(&self) -> io::Result<Vec<String>> {
                let mut ids = Vec::new();
                for entry in fs::read_dir(&self.path)?
                    .take(MAX_SCANNED_ENTRIES)
                    .flatten()
                {
                    let filename = entry.file_name();
                    let Some((leaf, id)) = filename
                        .to_str()
                        .and_then(|leaf| request_id(leaf, ".wake").map(|id| (leaf, id)))
                    else {
                        continue;
                    };
                    let Ok(marker) = self.open_file(leaf) else {
                        continue;
                    };
                    let fresh = marker.metadata().is_ok_and(|metadata| {
                        metadata.len() == 0
                            && metadata
                                .modified()
                                .ok()
                                .and_then(|value| value.elapsed().ok())
                                .is_some_and(|age| age <= QUEUE_TTL)
                    });
                    drop(marker);
                    if fs::remove_file(entry.path()).is_ok() && fresh {
                        ids.push(id.to_owned());
                        if ids.len() == MAX_QUEUE {
                            break;
                        }
                    }
                }
                Ok(ids)
            }
        }

        pub(crate) enum WindowsLaunch {
            EndPackageInvocation,
            Continue(Option<WindowsWake>),
        }

        pub(crate) struct WindowsWake {
            event: OwnedHandle,
            base: PathBuf,
            startup_request: Option<String>,
        }

        struct Signal {
            event: OwnedHandle,
            stopped: AtomicBool,
        }

        pub(in super::super) struct WakeWorker(Arc<Signal>);

        impl Drop for WakeWorker {
            fn drop(&mut self) {
                self.0.stopped.store(true, Ordering::Release);
                let _ = unsafe { SetEvent(HANDLE(self.0.event.as_raw_handle())) };
            }
        }

        struct LocalAllocation(HLOCAL);

        impl Drop for LocalAllocation {
            fn drop(&mut self) {
                // The conversion helpers both allocate their result with LocalAlloc.
                let _ = unsafe { LocalFree(self.0) };
            }
        }

        fn create_event(app_id: &str) -> Result<(OwnedHandle, bool), ()> {
            let user = CurrentUser::read()?;
            let mut sid = PWSTR::null();
            unsafe { ConvertSidToStringSidW(user.sid(), &mut sid) }.map_err(|_| ())?;
            let sid_memory = LocalAllocation(HLOCAL(sid.0.cast()));
            let sid_string = unsafe { sid.to_string() }.map_err(|_| ())?;
            drop(sid_memory);

            let access = EVENT_ALL_ACCESS.0;
            let sddl = format!(
                "O:{sid_string}D:P(A;;0x{access:08x};;;{sid_string})(A;;0x{access:08x};;;SY)"
            );
            let sddl: Vec<_> = sddl.encode_utf16().chain(Some(0)).collect();
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    PCWSTR(sddl.as_ptr()),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    None,
                )
            }
            .map_err(|_| ())?;
            let descriptor_memory = LocalAllocation(HLOCAL(descriptor.0));
            let attributes = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0,
                bInheritHandle: false.into(),
            };
            let name: Vec<_> = format!("Local\\{app_id}.plugin-delivery-v1.{sid_string}")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            // CreateEvent atomically determines ownership; existing objects ignore attributes.
            let (event, existed) = unsafe {
                SetLastError(ERROR_SUCCESS);
                let event = CreateEventW(Some(&attributes), false, false, PCWSTR(name.as_ptr()))
                    .map_err(|_| ())?;
                (event, GetLastError() == ERROR_ALREADY_EXISTS)
            };
            drop(descriptor_memory);
            let owned = unsafe { OwnedHandle::from_raw_handle(event.0) };
            verify_private_handle(event, SE_KERNEL_OBJECT, &user, 0, access)?;
            Ok((owned, existed))
        }

        pub(crate) fn prepare_windows_launch(app_id: &str) -> WindowsLaunch {
            let base = std::env::temp_dir();
            let mut args = std::env::args_os().skip(1);
            let startup_request = args
                .next()
                .filter(|_| args.next().is_none())
                .and_then(|argument| id_from_path(Path::new(&argument), &base).map(str::to_owned));
            match create_event(app_id) {
                Ok((event, false)) => WindowsLaunch::Continue(Some(WindowsWake {
                    event,
                    base,
                    startup_request,
                })),
                Ok((event, true)) if startup_request.is_some() => {
                    if let Some(id) = startup_request {
                        if PinnedDirectory::open(&base)
                            .and_then(|directory| directory.stage_wake(&id))
                            .is_ok()
                        {
                            let _ = unsafe { SetEvent(HANDLE(event.as_raw_handle())) };
                        }
                    }
                    WindowsLaunch::EndPackageInvocation
                }
                Err(()) if startup_request.is_some() => WindowsLaunch::EndPackageInvocation,
                _ => WindowsLaunch::Continue(None),
            }
        }

        impl WindowsWake {
            pub(crate) fn start(self, app: &AppHandle) {
                enqueue(app, self.startup_request);
                let state = app.state::<DeliveryState>();
                let Ok(mut slot) = state.wake_worker.lock() else {
                    return;
                };
                let signal = Arc::new(Signal {
                    event: self.event,
                    stopped: AtomicBool::new(false),
                });
                let background = Arc::clone(&signal);
                let owner = app.clone();
                if std::thread::Builder::new()
                    .name("plugin-delivery-wake".into())
                    .spawn(move || {
                        // The event carries no path or data. Consume only valid signal files in the pinned inbox.
                        while unsafe {
                            WaitForSingleObject(HANDLE(background.event.as_raw_handle()), INFINITE)
                        } == WAIT_OBJECT_0
                            && !background.stopped.load(Ordering::Acquire)
                        {
                            if let Ok(ids) = PinnedDirectory::open(&self.base)
                                .and_then(|directory| directory.take_wakes())
                            {
                                enqueue(&owner, ids);
                            }
                        }
                    })
                    .is_ok()
                {
                    *slot = Some(WakeWorker(signal));
                }
            }
        }

        pub(crate) fn stop_windows_wake(app: &AppHandle) {
            let state = app.state::<DeliveryState>();
            if let Ok(mut slot) = state.wake_worker.lock() {
                slot.take();
            };
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const ID: &str = "0123456789abcdef0123456789abcdef";
        const OTHER_ID: &str = "0123456789abcdef0123456789abcdea";
        const SESSION: &str = "01234567-89ab-cdef-0123-456789abcdef";
        const NEW_SESSION: &str = "01234567-89ab-cdef-0123-456789abcdea";

        #[test]
        fn only_exact_managed_package_paths_supply_a_request_id() {
            let base = std::env::temp_dir();
            let path = base.join(DIRECTORY).join(format!("{ID}.aicplugin"));
            assert_eq!(id_from_path(&path, &base), Some(ID));
            assert!(id_from_path(&path.with_extension("zip"), &base).is_none());
            assert!(id_from_path(
                &path.with_file_name(format!("{}.aicplugin", ID.to_uppercase())),
                &base
            )
            .is_none());
            assert!(id_from_path(&base.join(format!("{ID}.aicplugin")), &base).is_none());
        }

        #[test]
        fn envelope_cannot_declare_publisher_trust_or_a_request_id() {
            let safe = br#"{"formatVersion":1,"manifestText":"{}","source":"script","resourcePayloads":[{"id":"reference","bytes":[42]}]}"#;
            let decoded = parse_package(ID.into(), safe).unwrap();
            assert_eq!(decoded.request_id, ID);
            assert_eq!(decoded.resource_payloads.unwrap()[0].bytes, [42]);
            assert!(decoded.trusted_publisher.is_none());
            for invalid in [
                br#"{"formatVersion":1,"manifestText":"{}","source":"script","trustedPublisher":"spoofed"}"#.as_slice(),
                br#"{"formatVersion":1,"manifestText":"{}","source":"script","requestId":"not-the-filename"}"#.as_slice(),
                br#"{"formatVersion":2,"manifestText":"{}","source":"script"}"#.as_slice(),
            ] {
                assert!(parse_package(ID.into(), invalid).is_err());
            }
        }

        #[test]
        fn queue_is_single_flight_and_rejects_replayed_completions() {
            let now = Instant::now();
            let mut queue = Queue::default();
            assert!(queue.enqueue(ID, now));
            assert!(!queue.enqueue(ID, now));
            assert_eq!(queue.claim(SESSION, now).as_deref(), Some(ID));
            assert!(queue.claim(SESSION, now).is_none());
            assert!(queue.discard().is_some());
            assert!(queue.discard().is_none());
            assert!(!queue.enqueue(ID, now));
            assert!(queue.enqueue(ID, now + CLAIM_TTL));
        }

        #[test]
        fn a_new_renderer_releases_the_old_claim_and_retires_its_session() {
            assert!(valid_session_id(SESSION));
            assert!(valid_session_id(ID));
            assert!(!valid_session_id(&SESSION.to_uppercase()));
            assert!(!valid_session_id("main"));
            let now = Instant::now();
            let mut queue = Queue::default();
            assert!(queue.enqueue(ID, now));
            assert!(queue.enqueue(OTHER_ID, now));
            assert_eq!(queue.claim(SESSION, now).as_deref(), Some(ID));
            assert_eq!(queue.claim(NEW_SESSION, now).as_deref(), Some(OTHER_ID));
            assert!(queue.active(OTHER_ID, SESSION, now).is_none());
            assert!(queue.claim(SESSION, now).is_none());
            assert!(queue.active(OTHER_ID, NEW_SESSION, now).is_some());
        }

        #[cfg(target_os = "macos")]
        struct TempRoot(PathBuf);

        #[cfg(target_os = "macos")]
        impl TempRoot {
            fn create() -> Self {
                use std::{fs, os::unix::fs::DirBuilderExt};
                let nonce = crate::secure_random::random_bytes::<8>().unwrap();
                let root = Self(std::env::temp_dir().join(format!(
                    "plugin-delivery-test-{:x}",
                    u64::from_ne_bytes(nonce)
                )));
                fs::DirBuilder::new().mode(0o700).create(&root.0).unwrap();
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(root.0.join(DIRECTORY))
                    .unwrap();
                root
            }
        }

        #[cfg(target_os = "macos")]
        impl Drop for TempRoot {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn a_removed_or_replaced_package_cannot_receive_a_receipt() {
            use std::fs;

            let root = TempRoot::create();
            let directory = PinnedDirectory::open(&root.0).unwrap();
            let leaf = format!("{ID}.aicplugin");
            let body = br#"{"formatVersion":1,"manifestText":"{}","source":"script"}"#;
            directory.publish(".staged", &leaf, body).unwrap();
            let (target, parsed) = claim_package(&root.0, ID).unwrap().unwrap();
            assert!(parsed.is_ok());
            assert!(target.open_current(ID).is_some());
            let expected_file = root.0.join(DIRECTORY).join(&leaf);
            fs::remove_file(&expected_file).unwrap();
            assert!(target.open_current(ID).is_none());
            directory.publish(".staged", &leaf, body).unwrap();
            assert!(target.open_current(ID).is_none());

            let mut queue = Queue::default();
            let now = Instant::now();
            assert!(queue.enqueue(ID, now));
            assert_eq!(queue.claim(SESSION, now).as_deref(), Some(ID));
            queue.active(ID, SESSION, now).unwrap().target = Some(Arc::new(target));
            assert!(finish_claim(&mut queue, ID, NEW_SESSION, DeliveryStatus::Installed).is_err());
            assert!(finish_claim(&mut queue, ID, SESSION, DeliveryStatus::Cancelled).is_ok());
            assert!(!root
                .0
                .join(DIRECTORY)
                .join(format!("{ID}.result.json"))
                .exists());
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn anchored_receipt_never_overwrites_an_existing_result() {
            use std::fs;

            let root = TempRoot::create();
            let directory = PinnedDirectory::open(&root.0).unwrap();
            write_receipt(&directory, ID, DeliveryStatus::Installed).unwrap();
            assert!(write_receipt(&directory, ID, DeliveryStatus::Cancelled).is_err());
            let value = serde_json::from_reader::<_, serde_json::Value>(
                directory.open_file(&format!("{ID}.result.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(
                value,
                serde_json::json!({ "requestId": ID, "status": "installed" })
            );
            assert_eq!(fs::read_dir(root.0.join(DIRECTORY)).unwrap().count(), 1);
        }
    }
}

#[cfg(windows)]
pub(crate) mod windows_security {
    use std::{
        mem::{offset_of, size_of},
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr,
    };
    use windows::Win32::{
        Foundation::{LocalFree, HANDLE, HLOCAL},
        Security::{
            Authorization::{GetSecurityInfo, SE_FILE_OBJECT, SE_OBJECT_TYPE},
            EqualSid, GetAce, GetSecurityDescriptorControl, GetTokenInformation, IsValidAcl,
            IsValidSid, IsWellKnownSid, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid,
            ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION,
            OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED, TOKEN_QUERY,
            TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    pub(crate) struct CurrentUser(Vec<usize>);

    impl CurrentUser {
        pub(crate) fn read() -> Result<Self, ()> {
            let mut handle = HANDLE::default();
            // SAFETY: OpenProcessToken writes one handle into a valid out parameter.
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) }
                .map_err(|_| ())?;
            // SAFETY: the successful call transfers ownership of the token handle.
            let token = unsafe { OwnedHandle::from_raw_handle(handle.0) };
            let mut bytes = 0;
            // SAFETY: the zero-length call only obtains the required buffer size.
            let _ = unsafe {
                GetTokenInformation(
                    HANDLE(token.as_raw_handle()),
                    TokenUser,
                    None,
                    0,
                    &mut bytes,
                )
            };
            if !(size_of::<TOKEN_USER>() as u32..=4096).contains(&bytes) {
                return Err(());
            }
            let mut storage = vec![0_usize; (bytes as usize).div_ceil(size_of::<usize>())];
            // SAFETY: the aligned buffer is at least `bytes` long and the token remains valid.
            unsafe {
                GetTokenInformation(
                    HANDLE(token.as_raw_handle()),
                    TokenUser,
                    Some(storage.as_mut_ptr().cast()),
                    bytes,
                    &mut bytes,
                )
            }
            .map_err(|_| ())?;
            let user = Self(storage);
            // SAFETY: `sid` points into the successful TokenUser result.
            if !unsafe { IsValidSid(user.sid()) }.as_bool() {
                return Err(());
            }
            Ok(user)
        }

        pub(crate) fn sid(&self) -> PSID {
            // SAFETY: the successful TokenUser result and its SID share this allocation.
            unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
        }
    }

    struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

    impl Drop for SecurityDescriptor {
        fn drop(&mut self) {
            // SAFETY: GetSecurityInfo allocates this buffer with LocalAlloc.
            if !self.0 .0.is_null() {
                let _ = unsafe { LocalFree(HLOCAL(self.0 .0)) };
            }
        }
    }

    #[derive(PartialEq, Eq)]
    enum AllowedPrincipal {
        User,
        System,
        Administrators,
    }

    struct AllowEntry {
        principal: AllowedPrincipal,
        flags: u8,
        access: u32,
    }

    fn owned_allow_acl(
        handle: HANDLE,
        object_type: SE_OBJECT_TYPE,
        user: &CurrentUser,
    ) -> Result<(bool, Vec<AllowEntry>), ()> {
        let mut owner = PSID::default();
        let mut acl: *mut ACL = ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        // SAFETY: the call borrows a live handle with READ_CONTROL and valid out parameters.
        let status = unsafe {
            GetSecurityInfo(
                handle,
                object_type,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                Some(&mut owner),
                None,
                Some(&mut acl),
                None,
                Some(&mut descriptor),
            )
        };
        let descriptor = SecurityDescriptor(descriptor);
        if status.0 != 0 || owner.0.is_null() || acl.is_null() {
            return Err(());
        }
        let mut control = 0;
        let mut revision = 0;
        // SAFETY: the OS-provided owner and ACL live as long as `descriptor`.
        unsafe {
            GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision)
                .map_err(|_| ())?;
            if !IsValidSid(owner).as_bool()
                || EqualSid(owner, user.sid()).is_err()
                || !IsValidAcl(acl).as_bool()
            {
                return Err(());
            }
        }
        let count = unsafe { (*acl).AceCount };
        if !(1..=64).contains(&count) {
            return Err(());
        }
        let mut allowed = Vec::with_capacity(count.into());
        for index in 0..u32::from(count) {
            let mut raw = ptr::null_mut();
            // SAFETY: GetAce returns an entry within the validated, still-owned ACL.
            unsafe { GetAce(acl, index, &mut raw) }.map_err(|_| ())?;
            if raw.is_null() {
                return Err(());
            }
            // SAFETY: a validated ACE includes its header. Check the full SID extent before use.
            let header = unsafe { &*raw.cast::<ACE_HEADER>() };
            const SID_OFFSET: usize = offset_of!(ACCESS_ALLOWED_ACE, SidStart);
            const SID_HEADER: usize = 8;
            let length = usize::from(header.AceSize);
            if header.AceType != 0 || length < SID_OFFSET + SID_HEADER {
                return Err(());
            }
            // SAFETY: the checked ACE size covers the fixed mask and SID header.
            let (mask, sid_bytes) = unsafe {
                (
                    (*raw.cast::<ACCESS_ALLOWED_ACE>()).Mask,
                    raw.cast::<u8>().add(SID_OFFSET),
                )
            };
            let count = usize::from(unsafe { sid_bytes.add(1).read() });
            if length != SID_OFFSET + SID_HEADER + count * size_of::<u32>() {
                return Err(());
            }
            let sid = PSID(sid_bytes.cast());
            // SAFETY: the SID's declared extent is within the validated ACE.
            let principal = unsafe {
                if !IsValidSid(sid).as_bool() {
                    return Err(());
                }
                if EqualSid(sid, user.sid()).is_ok() {
                    AllowedPrincipal::User
                } else if IsWellKnownSid(sid, WinLocalSystemSid).as_bool() {
                    AllowedPrincipal::System
                } else if IsWellKnownSid(sid, WinBuiltinAdministratorsSid).as_bool() {
                    AllowedPrincipal::Administrators
                } else {
                    return Err(());
                }
            };
            allowed.push(AllowEntry {
                principal,
                flags: header.AceFlags,
                access: mask,
            });
        }
        Ok((control & SE_DACL_PROTECTED.0 != 0, allowed))
    }

    pub(crate) fn verify_private_handle(
        handle: HANDLE,
        object_type: SE_OBJECT_TYPE,
        user: &CurrentUser,
        expected_flags: u8,
        expected_access: u32,
    ) -> Result<(), ()> {
        let (protected, allowed) = owned_allow_acl(handle, object_type, user)?;
        if !protected
            || allowed.len() != 2
            || !allowed
                .iter()
                .any(|entry| entry.principal == AllowedPrincipal::User)
            || !allowed
                .iter()
                .any(|entry| entry.principal == AllowedPrincipal::System)
            || allowed
                .iter()
                .any(|entry| entry.flags != expected_flags || entry.access != expected_access)
        {
            return Err(());
        }
        Ok(())
    }

    pub(crate) fn verify_profile_file(handle: HANDLE, user: &CurrentUser) -> Result<(), ()> {
        // Profile files may inherit permissions; only these three validated principals may appear.
        owned_allow_acl(handle, SE_FILE_OBJECT, user).map(|_| ())
    }
}

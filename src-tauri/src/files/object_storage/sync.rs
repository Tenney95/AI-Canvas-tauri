//! Explicit manual sync. Every effect is scoped by a native binding generation.
use super::{catalog, client, journal::{self, Journal, Record, Root}, protocol::*, transfer::{self, Verify}, assert_current, current_credentials, ensure_main, now_ms, scope_for, ErrorStage, ObjectStorageState, RemoteProjectScope, StorageError, TaskGuard};
use futures_util::TryStreamExt;
use object_store::{aws::AmazonS3, path::Path as ObjectPath, ObjectStore, PutMode, PutOptions, UpdateVersion};
use std::{collections::{HashMap, HashSet}, hash::{BuildHasher, Hasher}, sync::Arc};
use tauri::{AppHandle, State, Webview};
use tokio_util::sync::CancellationToken;

fn random_lock_secret() -> Result<String, StorageError> {
    let mut bytes = [0_u8; 32];
    #[cfg(windows)]
    {
        #[link(name = "advapi32")]
        unsafe extern "system" {
            #[link_name = "SystemFunction036"]
            fn rtl_gen_random(buffer: *mut std::ffi::c_void, length: u32) -> u8;
        }
        if unsafe { rtl_gen_random(bytes.as_mut_ptr().cast(), bytes.len() as u32) } == 0 {
            return Err(StorageError::new("unavailable"));
        }
    }
    #[cfg(unix)]
    {
        use std::io::Read;
        std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes))
            .map_err(|_| StorageError::new("unavailable"))?;
    }
    #[cfg(not(any(windows, unix)))]
    return Err(StorageError::new("unavailable"));
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

struct Lease {
    _task: TaskGuard, context: Context, generation: u64, scope: RemoteProjectScope,
    metadata: AmazonS3, content: AmazonS3, cancel: CancellationToken, verify: Verify,
    apply_locks: Arc<std::sync::Mutex<HashMap<String, std::fs::File>>>,
}
fn verify_binding(app: &AppHandle, context: &Context, generation: u64) -> Result<(), StorageError> {
    catalog::access(app, |catalog| {
        let binding = catalog.bindings.iter().find(|binding| binding.owner_id == context.owner_id).ok_or_else(|| StorageError::new("binding_not_found"))?;
        if catalog.owner_revision(&context.owner_id) != generation || binding.connection_id != context.connection_id
            || binding.connection_revision != context.connection_revision || binding.library_id != context.library_id
            || binding.shared_project_id != context.shared_project_id || catalog.connection(&context.connection_id)?.revision != context.connection_revision
            || !binding.capabilities.multiplayer_writable { return Err(StorageError::new("conflict")); }
        Ok(((), false))
    })
}
impl Lease {
    async fn begin(app: &AppHandle, state: &ObjectStorageState, context: Context) -> Result<Self, StorageError> {
        Self::begin_for(app, state, context, None).await
    }
    async fn begin_for(app: &AppHandle, state: &ObjectStorageState, context: Context, _operation: Option<&str>) -> Result<Self, StorageError> {
        let lease = Self::initialize(app, state, context).await?;
        let (bytes, _) = read_small(&lease, &lease.root_key("project.json")?, 16 * 1024).await?;
        let descriptor = client::parse_descriptor(&bytes, &lease.scope)?;
        if descriptor.generation() != "legacy" || descriptor.status.is_some_and(|status| status != client::ProjectStatus::Active) { return Err(StorageError::new("conflict")); }
        Ok(lease)
    }
    async fn initialize(app: &AppHandle, state: &ObjectStorageState, context: Context) -> Result<Self, StorageError> {
        context.validate()?;
        let task = state.start(&context.task_id, &context.connection_id, &context.owner_id)?;
        let read_app = app.clone(); let read_context = context.clone();
        let (connection, credentials, generation) = tauri::async_runtime::spawn_blocking(move || catalog::access(&read_app, |catalog| {
            let binding = catalog.bindings.iter().find(|binding| binding.owner_id == read_context.owner_id).ok_or_else(|| StorageError::new("binding_not_found"))?;
            let connection = catalog.connection(&read_context.connection_id)?.clone();
            if binding.connection_id != read_context.connection_id || binding.connection_revision != read_context.connection_revision
                || binding.library_id != read_context.library_id || binding.shared_project_id != read_context.shared_project_id
                || connection.revision != read_context.connection_revision || !binding.capabilities.multiplayer_writable { return Err(StorageError::new("conflict")); }
            let credentials = current_credentials(&read_app, &connection)?.ok_or_else(|| StorageError::new("credentials_missing"))?;
            Ok(((connection, credentials, catalog.owner_revision(&read_context.owner_id)), false))
        })).await.map_err(|_| StorageError::new("unavailable"))??;
        let cancel = task.cancel.clone(); let verify_app = app.clone(); let verify_context = context.clone(); let verify_cancel = cancel.clone();
        let verify: Verify = Arc::new(move || { assert_current(&verify_cancel)?; verify_binding(&verify_app, &verify_context, generation) });
        verify()?;
        let scope = scope_for(&connection.connection, &context.library_id, &context.shared_project_id)?;
        let metadata = client::sync_client(&connection.connection, credentials.clone(), false)?;
        let content = client::sync_client(&connection.connection, credentials, true)?;
        Ok(Self { _task: task, context, generation, scope, metadata, content, cancel, verify, apply_locks: Arc::clone(&state.apply_locks) })
    }
    fn root_key(&self, suffix: &str) -> Result<ObjectPath, StorageError> {
        ObjectPath::parse(format!("{}/{}", self.scope.project_prefix, suffix)).map_err(|_| invalid())
    }
    fn data_prefix(&self) -> String { self.scope.project_prefix.clone() }
    fn key(&self, suffix: &str) -> Result<ObjectPath, StorageError> {
        ObjectPath::parse(format!("{}/{}", self.data_prefix(), suffix)).map_err(|_| invalid())
    }
    fn check_record(&self, record: &Record, operation: &str, revision: &str, asset: &str) -> Result<(), StorageError> {
        (self.verify)()?; record.validate()?;
        if !record.context.same_binding(&self.context) || record.owner_revision != self.generation || record.operation_id != operation
            || record.revision.revision_id != revision || record.revision.shared_asset_id != asset { return Err(StorageError::new("conflict")); } Ok(())
    }
    fn root_verify(&self, app: &AppHandle, root: Root) -> Verify {
        let verify = Arc::clone(&self.verify); let app = app.clone();
        Arc::new(move || { verify()?; root.resolve(&app)?; Ok(()) })
    }
}

fn cleanup_mode(mode: &str) -> Result<(), StorageError> {
    if mode != "clear" && mode != "delete" { return Err(invalid()); }
    Ok(())
}

fn cleanup_contains(project_prefix: &str, path: &str) -> bool {
    path.strip_prefix(project_prefix).is_some_and(|suffix| suffix.starts_with('/'))
}

async fn cleanup_snapshot(lease: &Lease) -> Result<Vec<object_store::ObjectMeta>, StorageError> {
    (lease.verify)()?;
    let prefix = lease.root_key("")?;
    let mut stream = lease.metadata.list(Some(&prefix));
    let mut objects = Vec::new();
    while let Some(item) = transfer::request(&lease.cancel, stream.try_next()).await? {
        if !cleanup_contains(&lease.scope.project_prefix, item.location.as_ref()) { continue; }
        if item.e_tag.as_ref().is_none_or(|etag| etag.is_empty()) || objects.len() >= 100_000 { return Err(StorageError::new("unavailable")); }
        objects.push(item);
    }
    objects.sort_by(|a, b| a.location.cmp(&b.location));
    if objects.windows(2).any(|pair| pair[0].location == pair[1].location) { return Err(invalid()); }
    (lease.verify)()?;
    Ok(objects)
}

fn same_cleanup_snapshot(a: &[object_store::ObjectMeta], b: &[object_store::ObjectMeta]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(a, b)| a.location == b.location && a.e_tag == b.e_tag && a.version == b.version && a.size == b.size)
}

fn cleanup_targets(objects: &[object_store::ObjectMeta], descriptor: &ObjectPath, mode: &str) -> Vec<object_store::ObjectMeta> {
    let mut selected: Vec<_> = objects.iter().filter(|item| mode == "delete" || item.location != *descriptor).cloned().collect();
    selected.sort_by_key(|item| item.location == *descriptor);
    selected
}

#[tauri::command]
pub async fn project_asset_storage_preview_cleanup(app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>, input: CleanupPreviewInput) -> Result<CleanupPreviewResult, StorageError> {
    ensure_main(&webview)?; cleanup_mode(&input.mode)?;
    let lease = Lease::initialize(&app, &state, input.context()).await?;
    let objects = cleanup_snapshot(&lease).await?;
    let descriptor = lease.root_key("project.json")?;
    if objects.iter().any(|item| item.location == descriptor) {
        let (bytes, _) = read_small(&lease, &descriptor, 16 * 1024).await?;
        let parsed = client::parse_descriptor(&bytes, &lease.scope)?;
        if input.mode == "clear" && (parsed.generation() != "legacy" || parsed.status.is_some_and(|status| status != client::ProjectStatus::Active)) {
            return Err(StorageError::new("cleanup_requires_recreate"));
        }
    }
    let mut selected = objects.iter().filter(|item| input.mode == "delete" || item.location != descriptor);
    let (object_count, bytes) = selected.try_fold((0_u64, 0_u64), |(count, bytes), item| {
        Ok::<_, StorageError>((count + 1, bytes.checked_add(item.size).filter(|n| *n <= 9_007_199_254_740_991).ok_or_else(invalid)?))
    })?;
    let preview_token = random_lock_secret()?;
    let session = super::CleanupPreviewSession { context: lease.context.clone(), owner_revision: lease.generation,
        mode: input.mode.clone(), token_digest: digest(preview_token.as_bytes()), expires_at: now_ms().saturating_add(120_000), objects };
    let mut sessions = state.cleanup_previews.lock().map_err(|_| StorageError::new("unavailable"))?;
    if sessions.len() >= 64 && !sessions.contains_key(&lease.context.owner_id) { return Err(StorageError::new("busy")); }
    sessions.insert(lease.context.owner_id.clone(), session);
    Ok(CleanupPreviewResult { mode: input.mode, object_count, bytes, preview_token })
}

#[tauri::command]
pub async fn project_asset_storage_apply_cleanup(app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>, input: CleanupApplyInput) -> Result<CleanupApplyResult, StorageError> {
    ensure_main(&webview)?; cleanup_mode(&input.mode)?;
    let context = input.context();
    let lease = Lease::initialize(&app, &state, context.clone()).await?;
    let session = {
        let mut sessions = state.cleanup_previews.lock().map_err(|_| StorageError::new("unavailable"))?;
        let session = sessions.get(&context.owner_id).ok_or_else(|| StorageError::new("apply_expired"))?;
        if !session.context.same_binding(&context) || session.owner_revision != lease.generation || session.mode != input.mode
            || session.expires_at <= now_ms() || session.token_digest != digest(input.preview_token.as_bytes()) { return Err(StorageError::new("conflict")); }
        sessions.remove(&context.owner_id).ok_or_else(|| StorageError::new("conflict"))?
    };
    let descriptor = lease.root_key("project.json")?;
    let selected = cleanup_targets(&session.objects, &descriptor, &input.mode);
    let total_count = selected.len() as u64;
    let current = match cleanup_snapshot(&lease).await {
        Ok(value) => value,
        Err(error) => return Ok(CleanupApplyResult { status: if error.code == "cancelled" { "cancelled" } else { "failed" }, deleted_count: 0, total_count, error_code: Some(error.code) }),
    };
    if !same_cleanup_snapshot(&session.objects, &current) { return Ok(CleanupApplyResult { status: "changed", deleted_count: 0, total_count, error_code: None }); }
    let mut deleted_count = 0;
    transfer::progress(&app, &context, &context.task_id, "cleanup", 0, total_count);
    for item in selected {
        if let Err(error) = (lease.verify)() {
            return Ok(CleanupApplyResult { status: if error.code == "cancelled" { "cancelled" } else { "failed" }, deleted_count, total_count, error_code: Some(error.code) });
        }
        if let Err(error) = transfer::request(&lease.cancel, lease.metadata.delete(&item.location)).await {
            return Ok(CleanupApplyResult { status: if error.code == "cancelled" { "cancelled" } else { "failed" }, deleted_count, total_count, error_code: Some(error.code) });
        }
        deleted_count += 1;
        transfer::progress(&app, &context, &context.task_id, "cleanup", deleted_count, total_count);
    }
    Ok(CleanupApplyResult { status: "completed", deleted_count, total_count, error_code: None })
}

fn check_asset_delete_preview(preview: &super::AssetDeletePreviewSession, context: &Context, owner_revision: u64,
    input: &AssetDeleteApplyInput, now: u64) -> Result<(), StorageError> {
    if preview.expires_at <= now { return Err(StorageError::new("apply_expired")); }
    if !preview.context.same_binding(context) || preview.owner_revision != owner_revision
        || preview.operation_id != input.operation_id || preview.head.shared_asset_id != input.shared_asset_id
        || preview.token_digest != digest(input.preview_token.as_bytes()) { return Err(StorageError::new("conflict")); }
    Ok(())
}

/// The head remains present so stale Create and Update requests cannot recreate the asset.
fn deleted_by_preview(head: &Head, preview: &super::AssetDeletePreviewSession) -> bool {
    head.deleted == Some(true) && head.operation_id == preview.operation_id && head.shared_asset_id == preview.head.shared_asset_id
        && head.revision_id == preview.head.revision_id && head.revision_digest == preview.head.revision_digest && head.kind == preview.head.kind
}
async fn delete_asset_head(store: &dyn ObjectStore, key: &ObjectPath, preview: &super::AssetDeletePreviewSession,
    cancel: &CancellationToken, verify: &Verify) -> Result<&'static str, StorageError> {
    let Some((current, etag)) = read_head_at(store, key, &preview.head.shared_asset_id, cancel, verify).await? else { return Ok("conflict"); };
    if current.deleted == Some(true) {
        return Ok(if deleted_by_preview(&current, preview) { "deleted" } else { "conflict" });
    }
    if etag != preview.etag || current != preview.head { return Ok("conflict"); }
    let tombstone = Head { operation_id: preview.operation_id.clone(), updated_at: now_ms(), deleted: Some(true), ..current };
    tombstone.validate()?; let bytes = encode(&tombstone)?; verify()?;
    let result = transfer::request(cancel, store.put_opts(key, bytes.into(), PutOptions::from(PutMode::Update(UpdateVersion {
        e_tag: Some(preview.etag.clone()), version: None,
    })))).await;
    // Once a write was attempted, cancellation/network failure can mean the response was lost.
    let observed = read_head_at(store, key, &preview.head.shared_asset_id, cancel, verify).await;
    Ok(asset_delete_commit_status(result.map(|_| ()), observed, preview))
}
fn asset_delete_commit_status(result: Result<(), StorageError>, observed: Result<Option<(Head, String)>, StorageError>,
    preview: &super::AssetDeletePreviewSession) -> &'static str {
    if let Ok(Some((head, _))) = &observed {
        if deleted_by_preview(head, preview) { return "deleted"; }
    }
    match result {
        Err(error) if error.code == "conflict" => "conflict",
        Err(_) => "uncertain",
        Ok(_) => match observed {
            Ok(Some((head, _))) if head.deleted == Some(true) => "conflict",
            _ => "uncertain",
        },
    }
}

#[tauri::command]
pub async fn project_asset_storage_preview_asset_delete(app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>,
    input: AssetDeletePreviewInput) -> Result<AssetDeletePreviewResult, StorageError> {
    ensure_main(&webview)?;
    for id in [&input.operation_id, &input.shared_asset_id, &input.expected_revision_id] { super::validate_id(id)?; }
    if !valid_etag(&input.expected_e_tag) { return Err(invalid()); }
    let lease = Lease::begin(&app, &state, input.context()).await?;
    let (head, etag) = read_head(&lease, &input.shared_asset_id).await?.ok_or_else(|| StorageError::new("conflict"))?;
    require_live_head(&head)?;
    if head.revision_id != input.expected_revision_id || etag != input.expected_e_tag { return Err(StorageError::new("conflict")); }
    let preview_token = random_lock_secret()?;
    let preview = super::AssetDeletePreviewSession { context: lease.context.clone(), owner_revision: lease.generation,
        operation_id: input.operation_id.clone(), head: head.clone(), etag, token_digest: digest(preview_token.as_bytes()),
        expires_at: now_ms().saturating_add(120_000) };
    (lease.verify)()?;
    let mut previews = state.asset_delete_previews.lock().map_err(|_| StorageError::new("unavailable"))?;
    previews.retain(|_, preview| preview.expires_at > now_ms());
    if previews.len() >= 64 && !previews.contains_key(&input.owner_id) { return Err(StorageError::new("busy")); }
    previews.insert(input.owner_id, preview);
    Ok(AssetDeletePreviewResult { shared_asset_id: input.shared_asset_id, revision_id: head.revision_id,
        operation_id: input.operation_id, preview_token })
}

#[tauri::command]
pub async fn project_asset_storage_apply_asset_delete(app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>,
    input: AssetDeleteApplyInput) -> Result<AssetDeleteApplyResult, StorageError> {
    ensure_main(&webview)?;
    for id in [&input.operation_id, &input.shared_asset_id] { super::validate_id(id)?; }
    if !valid_digest(&input.preview_token) { return Err(invalid()); }
    let context = input.context(); let lease = Lease::begin(&app, &state, context.clone()).await?;
    let preview = state.asset_delete_previews.lock().map_err(|_| StorageError::new("unavailable"))?.get(&input.owner_id)
        .cloned().ok_or_else(|| StorageError::new("apply_expired"))?;
    check_asset_delete_preview(&preview, &context, lease.generation, &input, now_ms())?;
    // Retain the bounded preview until expiry so the same operation can confirm a lost response.
    let status = delete_asset_head(&lease.metadata, &lease.key(&format!("heads/{}.json", input.shared_asset_id))?,
        &preview, &lease.cancel, &lease.verify).await?;
    Ok(AssetDeleteApplyResult { status, shared_asset_id: input.shared_asset_id, operation_id: input.operation_id })
}

async fn read_small(lease: &Lease, location: &ObjectPath, limit: usize) -> Result<(Vec<u8>, object_store::ObjectMeta), StorageError> {
    (lease.verify)()?;
    let result = transfer::request(&lease.cancel, lease.metadata.get(location)).await?;
    if result.meta.size > limit as u64 { return Err(StorageError::new("response_too_large")); }
    let meta = result.meta.clone(); let mut stream = result.into_stream(); let mut bytes = Vec::new();
    while let Some(chunk) = transfer::request(&lease.cancel, stream.try_next()).await? {
        if chunk.len() > limit.saturating_sub(bytes.len()) { return Err(StorageError::new("response_too_large")); } bytes.extend_from_slice(&chunk);
    }
    if bytes.len() as u64 != meta.size { return Err(StorageError::new("unknown")); } Ok((bytes, meta))
}

async fn read_revision(lease: &Lease, asset: &str, revision: &str, expected: Option<&str>) -> Result<(Revision, String), StorageError> {
    async {
        super::validate_id(asset)?; super::validate_id(revision)?;
        let (bytes, _) = read_small(lease, &lease.key(&format!("revisions/{asset}/{revision}.json"))?, MANIFEST_LIMIT).await?;
        let digest = digest(&bytes); if expected.is_some_and(|expected| expected != digest) { return Err(StorageError::new("conflict")); }
        let value: Revision = serde_json::from_slice(&bytes).map_err(|_| invalid())?; value.validate(false)?;
        if value.library_id != lease.context.library_id || value.shared_project_id != lease.context.shared_project_id || value.shared_asset_id != asset || value.revision_id != revision { return Err(StorageError::new("project_mismatch")); }
        Ok((value, digest))
    }.await.map_err(|error: StorageError| error.at_stage(ErrorStage::RevisionRead))
}
fn valid_etag(value: &str) -> bool { !value.is_empty() && value.len() <= 1024 && !value.chars().any(char::is_control) }
fn require_live_head(head: &Head) -> Result<(), StorageError> {
    if head.deleted == Some(true) { return Err(StorageError::new("remote_deleted")); }
    Ok(())
}
async fn read_head_at(store: &dyn ObjectStore, key: &ObjectPath, asset: &str, cancel: &CancellationToken,
    verify: &Verify) -> Result<Option<(Head, String)>, StorageError> {
    verify()?; super::validate_id(asset)?;
    let result = match transfer::request(cancel, store.get(key)).await {
        Ok(result) => result, Err(error) if error.code == "project_not_found" => return Ok(None), Err(error) => return Err(error),
    };
    if result.meta.size > 16 * 1024 { return Err(StorageError::new("response_too_large")); }
    let size = result.meta.size;
    let etag = result.meta.e_tag.clone().filter(|etag| valid_etag(etag)).ok_or_else(|| StorageError::new("conditional_write_unsupported"))?;
    let mut stream = result.into_stream(); let mut bytes = Vec::new();
    while let Some(chunk) = transfer::request(cancel, stream.try_next()).await? {
        if chunk.len() > (16_usize * 1024).saturating_sub(bytes.len()) { return Err(StorageError::new("response_too_large")); }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() as u64 != size { return Err(StorageError::new("unknown")); }
    let head: Head = serde_json::from_slice(&bytes).map_err(|_| invalid())?; head.validate()?;
    if head.shared_asset_id != asset { return Err(StorageError::new("project_mismatch")); }
    verify()?; Ok(Some((head, etag)))
}
async fn read_head(lease: &Lease, asset: &str) -> Result<Option<(Head, String)>, StorageError> {
    read_head_at(&lease.metadata, &lease.key(&format!("heads/{asset}.json"))?, asset, &lease.cancel, &lease.verify).await
        .map_err(|error| error.at_stage(ErrorStage::HeadRead))
}
async fn asset_from_head(lease: &Lease, head: Head, etag: String) -> Result<RemoteAsset, StorageError> {
    async {
        require_live_head(&head)?;
        let (revision, _) = read_revision(lease, &head.shared_asset_id, &head.revision_id, Some(&head.revision_digest)).await?;
        if revision.operation_id != head.operation_id || revision.kind() != head.kind { return Err(invalid()); }
        Ok(RemoteAsset { head, etag, revision })
    }.await.map_err(|error: StorageError| error.at_stage(ErrorStage::HeadRead))
}
async fn read_asset(lease: &Lease, asset: &str) -> Result<Option<RemoteAsset>, StorageError> {
    match read_head(lease, asset).await? {
        Some((head, etag)) => Ok(Some(asset_from_head(lease, head, etag).await?)), None => Ok(None),
    }
}
fn token(expires_at: u64) -> String {
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher(); hasher.write_u64(now_ms());
    format!("{expires_at}.{}", digest(format!("{}:{}", hasher.finish(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()).as_bytes()))
}
fn issue_apply(app: &AppHandle, lease: &Lease, record: &Record) -> Result<String, StorageError> {
    let expires_at = now_ms().saturating_add(120_000); let value = token(expires_at);
    catalog::access(app, |catalog| {
        assert_current(&lease.cancel)?;
        if catalog.owner_revision(&lease.context.owner_id) != lease.generation || catalog.connection(&lease.context.connection_id)?.revision != lease.context.connection_revision { return Err(StorageError::new("conflict")); }
        let mut locks = lease.apply_locks.lock().map_err(|_| StorageError::new("unavailable"))?;
        let newly_locked = !locks.contains_key(&lease.context.owner_id);
        if newly_locked {
            // A free OS lock also proves that a previous process has exited, so its
            // lost token need not delay explicit recovery until the old TTL expires.
            locks.insert(lease.context.owner_id.clone(), journal::lock_apply(app, &lease.context.owner_id)?);
        // Expiry does not prove a renderer transaction has stopped; only an
        // explicit acknowledgement or the OS lock disappearing can release it.
        } else if journal::read_apply(app, &lease.context.owner_id)?.is_some() { return Err(StorageError::new("busy")); }
        let result = journal::write_apply(app, &journal::ApplyLease { context: lease.context.clone(), owner_revision: lease.generation,
            operation_id: record.operation_id.clone(), revision_id: record.revision.revision_id.clone(), shared_asset_id: record.revision.shared_asset_id.clone(), token_digest: digest(value.as_bytes()), expires_at });
        if result.is_err() && newly_locked { locks.remove(&lease.context.owner_id); } result?;
        Ok(((), false))
    })?; Ok(value)
}
fn apply_matches_ack(apply: &journal::ApplyLease, context: &Context, record: &Record, value: &str, owner_revision: u64, connection_revision: &str, has_os_lock: bool) -> bool {
    // Expiry limits starting an IndexedDB transaction. It does not establish
    // that an already-started transaction has finished, so its matching ACK
    // must remain valid while this process still owns the OS lock.
    has_os_lock && apply.context.same_binding(context) && apply.owner_revision == owner_revision
        && connection_revision == context.connection_revision && apply.operation_id == record.operation_id
        && apply.revision_id == record.revision.revision_id && apply.shared_asset_id == record.revision.shared_asset_id
        && apply.token_digest == digest(value.as_bytes())
}
fn check_apply(app: &AppHandle, state: &ObjectStorageState, context: &Context, record: &Record, value: &str) -> Result<(), StorageError> {
    catalog::access(app, |catalog| {
        let apply = journal::read_apply(app, &context.owner_id)?.ok_or_else(|| StorageError::new("conflict"))?;
        let has_os_lock = state.apply_locks.lock().map_err(|_| StorageError::new("unavailable"))?.contains_key(&context.owner_id);
        if !apply_matches_ack(&apply, context, record, value, catalog.owner_revision(&context.owner_id), &catalog.connection(&context.connection_id)?.revision, has_os_lock) { return Err(StorageError::new("conflict")); }
        Ok(((), false))
    })
}
pub(super) fn revoke_task_apply(_app: &AppHandle, _state: &ObjectStorageState, _task: &str) -> Result<(), StorageError> {
    // Cancellation is not evidence that an IndexedDB transaction has stopped.
    // The matching acknowledgement releases the local lease; if the renderer
    // lost the token, a process restart drops the OS lock and enables recovery.
    Ok(())
}

#[tauri::command]
pub async fn project_asset_storage_list_heads(app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>, input: ListInput) -> Result<ListResult, StorageError> {
    ensure_main(&webview)?;
    let lease = Lease::begin(&app, &state, input.context()).await?;
    if let Some(cursor) = &input.cursor { super::validate_id(cursor)?; }
    let prefix = lease.key("heads/")?;
    let offset = input.cursor.as_ref().map(|cursor| lease.key(&format!("heads/{cursor}.json"))).transpose()?;
    let mut entries = match offset.as_ref() { Some(offset) => lease.metadata.list_with_offset(Some(&prefix), offset), None => lease.metadata.list(Some(&prefix)) };
    let mut assets = Vec::new(); let mut deleted_assets = Vec::new(); let mut total = 0;
    let mut seen = HashSet::new(); let mut next_cursor = None;
    while let Some(entry) = transfer::request(&lease.cancel, entries.try_next()).await? {
        let name = entry.location.as_ref().strip_prefix(&format!("{}/heads/", lease.data_prefix())).and_then(|name| name.strip_suffix(".json")).ok_or_else(invalid)?;
        super::validate_id(name)?; if !seen.insert(name.to_string()) { return Err(invalid()); }
        if assets.len() + deleted_assets.len() >= 32 { return Ok(ListResult { assets, deleted_assets, complete: false, next_cursor }); }
        let (head, etag) = read_head(&lease, name).await?.ok_or_else(|| StorageError::new("conflict"))?;
        if head.deleted == Some(true) {
            total += encode(&head)?.len();
            if total > MANIFEST_LIMIT && (!assets.is_empty() || !deleted_assets.is_empty()) {
                return Ok(ListResult { assets, deleted_assets, complete: false, next_cursor });
            }
            deleted_assets.push(head);
        } else {
            let asset = asset_from_head(&lease, head, etag).await?;
            total += encode(&asset.revision)?.len();
            if total > MANIFEST_LIMIT && (!assets.is_empty() || !deleted_assets.is_empty()) {
                return Ok(ListResult { assets, deleted_assets, complete: false, next_cursor });
            }
            assets.push(asset);
        }
        next_cursor = Some(name.to_owned());
    }
    (lease.verify)()?; Ok(ListResult { assets, deleted_assets, complete: true, next_cursor: None })
}

#[tauri::command]
pub async fn project_asset_storage_prepare_publish(app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>, input: PrepareInput) -> Result<PreparedResult, StorageError> {
    ensure_main(&webview)?; input.draft.validate(true)?;
    let context = input.context(); let lease = Lease::begin(&app, &state, context.clone()).await?;
    if input.draft.library_id != context.library_id || input.draft.shared_project_id != context.shared_project_id || input.sources.len() != input.draft.media.len()
        || input.draft.parent_revision_id.is_some() != input.base_e_tag.is_some()
        || input.base_e_tag.as_ref().is_some_and(|etag| etag.is_empty() || etag.len() > 1024 || etag.chars().any(char::is_control)) { return Err(invalid()); }
    let current = read_head(&lease, &input.draft.shared_asset_id).await?;
    if let Some((head, etag)) = &current {
        require_live_head(head)?;
        let same_operation = head.revision_id == input.draft.revision_id && head.operation_id == input.draft.operation_id;
        if !same_operation && (Some(etag) != input.base_e_tag.as_ref() || Some(&head.revision_id) != input.draft.parent_revision_id.as_ref()) {
            return Err(StorageError::new("conflict"));
        }
    } else if input.base_e_tag.is_some() { return Err(StorageError::new("conflict")); }
    let (root, root_path) = Root::capture(&app, &input.root_directory)?;
    let verify = lease.root_verify(&app, root.clone()); verify()?;
    let journal = Journal::open(&app, &context.owner_id, &input.draft.operation_id)?;
    if let Some(record) = journal.load()? {
        lease.check_record(&record, &input.draft.operation_id, &input.draft.revision_id, &input.draft.shared_asset_id)?;
        let mut old_draft = record.revision.clone(); for media in &mut old_draft.media { media.sha256.clear(); media.bytes = 0; }
        if encode(&old_draft)? != encode(&input.draft)? || record.root.fingerprint != root.fingerprint || record.base_e_tag != input.base_e_tag { return Err(StorageError::new("conflict")); }
        for media in &record.revision.media { transfer::verified_file(&app, &journal.media(media), media, &lease.cancel)?; }
        return Ok(PreparedResult { revision: record.revision, revision_digest: record.revision_digest });
    }
    let mut sources = HashMap::new(); for source in input.sources { super::validate_id(&source.media_id)?; if sources.insert(source.media_id, source.file_path).is_some() { return Err(invalid()); } }
    let worker_app = app.clone(); let worker_context = context.clone(); let cancel = lease.cancel.clone(); let generation = lease.generation;
    tauri::async_runtime::spawn_blocking(move || {
        let mut revision = input.draft;
        let mut total = 0_u64;
        for media in &revision.media {
            let source = sources.get(&media.id).ok_or_else(invalid)?;
            let source = crate::path_policy::authorize_existing_plain_file(&worker_app, source).map_err(|_| invalid())?;
            if !source.starts_with(&root_path) { return Err(invalid()); }
            total = total.checked_add(std::fs::metadata(source).map_err(|_| StorageError::new("unavailable"))?.len()).ok_or_else(invalid)?;
            if total > MEDIA_LIMIT { return Err(StorageError::new("response_too_large")); }
        }
        for media in &mut revision.media {
            let source = sources.get(&media.id).ok_or_else(invalid)?;
            let destination = journal.media(media);
            // Partial preparation may reuse only byte-identical, reauthorized material.
            let operation = revision.operation_id.clone();
            transfer::stage(&worker_app, &worker_context, &operation, &root_path, source, &destination, media, &cancel, &verify)?;
        }
        revision.validate(false)?; verify()?;
        let revision_digest = digest(&encode(&revision)?);
        let record = Record { operation_id: revision.operation_id.clone(), context: worker_context, owner_revision: generation, root, direction: "upload".into(), revision: revision.clone(), revision_digest: revision_digest.clone(), base_e_tag: input.base_e_tag, phase: "prepared".into(), uploads: Default::default(), downloaded: Vec::new(), cleanup_pending: false, untracked_upload: false, remote_mutation_attempted: false, apply_issued: false, conflict_released: false };
        journal.save(&record)?; Ok(PreparedResult { revision, revision_digest })
    }).await.map_err(|_| StorageError::new("unavailable"))?
}

async fn recover(lease: &Lease, record: &Record) -> Result<PublishResult, StorageError> {
    let asset = read_asset(lease, &record.revision.shared_asset_id).await?;
    let Some(asset) = asset else { return Ok(PublishResult { status: if record.untracked_upload { "uncertain" } else if record.base_e_tag.is_none() { "retryable" } else { "conflict" }, lock_retained: None, asset: None, apply_token: None, prepared: Some(PreparedResult { revision: record.revision.clone(), revision_digest: record.revision_digest.clone() }) }); };
    if asset.head.revision_id == record.revision.revision_id {
        let status = if asset.head.revision_digest == record.revision_digest && asset.head.operation_id == record.revision.operation_id { "published" } else { "conflict" };
        return Ok(PublishResult { status, lock_retained: None, asset: Some(asset), apply_token: None, prepared: None });
    }
    // An unchanged base needs no ancestry walk, even after thousands of versions.
    let unchanged = record.base_e_tag.as_ref() == Some(&asset.etag) && record.revision.parent_revision_id.as_ref() == Some(&asset.head.revision_id);
    if unchanged {
        return Ok(PublishResult { status: if record.untracked_upload { "uncertain" } else { "retryable" }, lock_retained: None, asset: Some(asset), apply_token: None,
            prepared: Some(PreparedResult { revision: record.revision.clone(), revision_digest: record.revision_digest.clone() }) });
    }
    let mut parent = asset.revision.parent_revision_id.clone(); let mut seen = HashSet::new();
    for _ in 0..64 {
        let Some(id) = parent.take() else { break; }; if !seen.insert(id.clone()) { return Err(invalid()); }
        let (revision, revision_digest) = read_revision(lease, &record.revision.shared_asset_id, &id, None).await?;
        if id == record.revision.revision_id {
            if revision_digest == record.revision_digest && revision.operation_id == record.revision.operation_id {
                // Return the exact published candidate, not a later version the user did not approve.
                let head = Head { shared_asset_id: revision.shared_asset_id.clone(), kind: revision.kind().into(), revision_id: revision.revision_id.clone(), revision_digest, operation_id: revision.operation_id.clone(), updated_at: revision.created_at, deleted: None };
                return Ok(PublishResult { status: "published", lock_retained: None, asset: Some(RemoteAsset { head, etag: asset.etag, revision }), apply_token: None, prepared: None });
            } return Ok(PublishResult { status: "conflict", lock_retained: None, asset: Some(asset), apply_token: None, prepared: None });
        }
        parent = revision.parent_revision_id;
    }
    if parent.is_some() { return Ok(PublishResult { status: "uncertain", lock_retained: None, asset: Some(asset), apply_token: None, prepared: None }); }
    Ok(PublishResult { status: if record.untracked_upload { "uncertain" } else { "conflict" }, lock_retained: None, asset: Some(asset), apply_token: None, prepared: None })
}

#[tauri::command]
pub async fn project_asset_storage_publish_revision(app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>, input: OperationInput) -> Result<PublishResult, StorageError> {
    ensure_main(&webview)?; let lease = Lease::begin_for(&app, &state, input.context(), Some(&input.operation_id)).await?;
    let journal = Journal::open(&app, &input.owner_id, &input.operation_id)?; let mut record = journal.load()?.ok_or_else(|| StorageError::new("operation_not_found"))?;
    lease.check_record(&record, &input.operation_id, &input.revision_id, &input.shared_asset_id)?;
    if record.direction != "upload" { return Err(invalid()); }
    if record.phase == "completed" && !record.remote_mutation_attempted { return Err(StorageError::new("conflict")); }
    let verify = lease.root_verify(&app, record.root.clone()); verify().map_err(|error| error.at_stage(ErrorStage::StagingVerify))?;
    let mut result = recover(&lease, &record).await?;
    if result.status == "published" { record.apply_issued = true; journal.save(&record)?; result.apply_token = Some(issue_apply(&app, &lease, &record)?); return Ok(result); }
    if result.status != "retryable" { return Ok(result); }
    record.phase = "uploading".into(); record.remote_mutation_attempted = true; journal.save(&record)?;
    for media in record.revision.media.clone() {
        verify().map_err(|error| error.at_stage(ErrorStage::StagingVerify))?; let key = lease.key(&format!("objects/sha256/{}", media.sha256))?;
        transfer::upload(&app, &lease.context, &lease.content, &lease.content, &key, &media, &journal, &mut record, &lease.cancel, &verify).await?;
    }
    verify().map_err(|error| error.at_stage(ErrorStage::RevisionWrite))?;
    let bytes = encode(&record.revision).map_err(|error| error.at_stage(ErrorStage::RevisionWrite))?; let revision_key = lease.key(&format!("revisions/{}/{}.json", input.shared_asset_id, input.revision_id)).map_err(|error| error.at_stage(ErrorStage::RevisionWrite))?;
    match transfer::request(&lease.cancel, lease.metadata.put_opts(&revision_key, bytes.clone().into(), PutOptions::from(PutMode::Create))).await.map_err(|error| error.at_stage(ErrorStage::RevisionWrite)) {
        Ok(_) => {}, Err(error) if error.code == "conflict" => { let (existing, _) = read_small(&lease, &revision_key, MANIFEST_LIMIT).await.map_err(|error| error.at_stage(ErrorStage::RevisionRead))?; if digest(&existing) != record.revision_digest { return Err(StorageError::new("conflict").at_stage(ErrorStage::RevisionWrite)); } },
        Err(error) => return Err(error),
    }
    record.phase = "checkingCommit".into(); journal.save(&record)?; verify()?;
    let head = Head { shared_asset_id: input.shared_asset_id.clone(), kind: record.revision.kind().into(), revision_id: input.revision_id.clone(), revision_digest: record.revision_digest.clone(), operation_id: input.operation_id.clone(), updated_at: record.revision.created_at, deleted: None };
    let mode = match &record.base_e_tag { Some(etag) => PutMode::Update(UpdateVersion { e_tag: Some(etag.clone()), version: None }), None => PutMode::Create };
    transfer::progress(&app, &lease.context, &input.operation_id, "publishing", 0, 1);
    let key = lease.key(&format!("heads/{}.json", input.shared_asset_id))?;
    let committed = transfer::request(&lease.cancel, lease.metadata.put_opts(&key, encode(&head)?.into(), PutOptions::from(mode))).await;
    if let Err(error) = committed {
        if error.code != "conflict" { record.phase = "checkingCommit".into(); journal.save(&record)?; return Ok(PublishResult { status: "uncertain", lock_retained: None, asset: None, apply_token: None, prepared: None }); }
    }
    result = recover(&lease, &record).await?;
    if result.status == "published" { record.phase = "published".into(); record.apply_issued = true; journal.save(&record)?; result.apply_token = Some(issue_apply(&app, &lease, &record)?); transfer::progress(&app, &lease.context, &input.operation_id, "publishing", 1, 1); }
    Ok(result)
}

#[tauri::command]
pub async fn project_asset_storage_recover_operation(app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>, input: OperationInput) -> Result<PublishResult, StorageError> {
    ensure_main(&webview)?; let lease = Lease::begin(&app, &state, input.context()).await?;
    if let Some((head, _)) = read_head(&lease, &input.shared_asset_id).await? { require_live_head(&head)?; }
    let journal = Journal::open(&app, &input.owner_id, &input.operation_id)?; let mut record = journal.load()?.ok_or_else(|| StorageError::new("operation_not_found"))?;
    lease.check_record(&record, &input.operation_id, &input.revision_id, &input.shared_asset_id)?; record.root.resolve(&app)?;
    if record.direction == "download" {
        if !["awaitingApply", "completed"].contains(&record.phase.as_str()) || record.downloaded.len() != record.revision.media.len() {
            return Ok(PublishResult { status: "retryable", lock_retained: None, asset: None, apply_token: None, prepared: Some(PreparedResult { revision: record.revision.clone(), revision_digest: record.revision_digest.clone() }) });
        }
        let root = record.root.resolve(&app)?;
        for media in &record.revision.media { transfer::verified_file(&app, &root.join(journal::media_destination(&record.revision, media)), media, &lease.cancel)?; }
    }
    let mut result = recover(&lease, &record).await?;
    if result.status == "published" { record.apply_issued = true; journal.save(&record)?; result.apply_token = Some(issue_apply(&app, &lease, &record)?); }
    Ok(result)
}

#[tauri::command]
pub async fn project_asset_storage_download_revision(app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>, input: DownloadInput) -> Result<DownloadResult, StorageError> {
    ensure_main(&webview)?; if !valid_digest(&input.expected_revision_digest) { return Err(invalid()); }
    let lease = Lease::begin_for(&app, &state, input.context(), Some(&input.operation_id)).await?;
    let current = read_head(&lease, &input.shared_asset_id).await?.ok_or_else(|| StorageError::new("conflict"))?;
    require_live_head(&current.0)?;
    if current.0.revision_id != input.revision_id || current.0.revision_digest != input.expected_revision_digest { return Err(StorageError::new("conflict")); }
    let expected_etag = current.1;
    let (revision, revision_digest) = read_revision(&lease, &input.shared_asset_id, &input.revision_id, Some(&input.expected_revision_digest)).await?;
    let (root, root_path) = Root::capture(&app, &input.root_directory)?; let verify = lease.root_verify(&app, root.clone());
    let journal = Journal::open(&app, &input.owner_id, &input.operation_id)?;
    let mut record = if let Some(record) = journal.load()? {
        // The download journal's operation is local; the revision keeps its publisher's operation.
        if !record.context.same_binding(&lease.context) || record.owner_revision != lease.generation || record.operation_id != input.operation_id || record.direction != "download" || record.revision_digest != revision_digest || record.root.fingerprint != root.fingerprint { return Err(StorageError::new("conflict")); } record
    } else { Record { operation_id: input.operation_id.clone(), context: lease.context.clone(), owner_revision: lease.generation, root, direction: "download".into(), revision: revision.clone(), revision_digest: revision_digest.clone(), base_e_tag: None, phase: "downloading".into(), uploads: Default::default(), downloaded: Vec::new(), cleanup_pending: false, untracked_upload: false, remote_mutation_attempted: false, apply_issued: false, conflict_released: false } };
    journal.save(&record)?;
    for media in &revision.media {
        verify()?; let staged = journal.media(media); let key = lease.key(&format!("objects/sha256/{}", media.sha256))?;
        transfer::download(&app, &lease.context, &lease.content, &key, media, staged.clone(), &input.operation_id, &lease.cancel, &verify).await?;
        let relative = journal::media_destination(&revision, media); let destination = root_path.join(&relative);
        let parent = destination.parent().ok_or_else(invalid)?; journal::directory(parent)?;
        let authorized = crate::path_policy::authorize_path(&app, &destination.to_string_lossy(), crate::path_policy::PathAccess::Write).map_err(|_| invalid())?;
        if authorized != destination || !authorized.starts_with(&root_path) { return Err(invalid()); }
        if destination.exists() { transfer::verified_file(&app, &destination, media, &lease.cancel)?; }
        else {
            let worker_app = app.clone(); let worker_context = lease.context.clone(); let worker_root = journal::Root::capture(&app, &root_path.to_string_lossy())?.0; let worker_media = media.clone(); let worker_cancel = lease.cancel.clone(); let worker_verify = Arc::clone(&verify);
            tauri::async_runtime::spawn_blocking(move || {
                worker_root.resolve(&worker_app)?;
                transfer::ensure_target(&worker_app, &destination)?;
                let mut reader = std::fs::File::open(&staged).map_err(|_| StorageError::new("unavailable"))?;
                crate::file_transfer::stream_to_file(&worker_context.task_id, &mut reader, &destination, Some(worker_media.bytes), Some(worker_media.bytes), Some(worker_media.bytes), || Ok(worker_cancel.is_cancelled()), |_| {},
                    |temporary| { worker_verify().map_err(|_| "sync scope changed".to_string())?;
                        transfer::ensure_target(&worker_app, &destination).map_err(|_| "target changed".to_string())?;
                        transfer::verified_file(&worker_app, temporary, &worker_media, &worker_cancel).map_err(|_| "checksum mismatch".to_string()) })
                    .map_err(|_| StorageError::new(if worker_cancel.is_cancelled() { "cancelled" } else { "conflict" }))?; Ok::<_, StorageError>(())
            }).await.map_err(|_| StorageError::new("unavailable"))??;
        }
        record.downloaded.retain(|item| item.media_id != media.id); record.downloaded.push(DownloadedMedia { media_id: media.id.clone(), relative_path: relative, bytes: media.bytes, sha256: media.sha256.clone() }); journal.save(&record)?;
    }
    verify()?; record.phase = "awaitingApply".into(); journal.save(&record)?;
    let current = read_asset(&lease, &input.shared_asset_id).await?;
    if current.as_ref().is_none_or(|current| current.head.revision_id != input.revision_id
        || current.head.revision_digest != input.expected_revision_digest || current.etag != expected_etag) {
        return Err(StorageError::new("conflict"));
    }
    record.apply_issued = true; journal.save(&record)?;
    let apply_token = issue_apply(&app, &lease, &record)?;
    Ok(DownloadResult { operation_id: input.operation_id, revision, revision_digest, media: record.downloaded, apply_token })
}

#[tauri::command]
pub async fn project_asset_storage_acknowledge_apply(app: AppHandle, webview: Webview, state: State<'_, ObjectStorageState>, input: AcknowledgeInput) -> Result<(), StorageError> {
    ensure_main(&webview)?; let context = input.context(); context.validate()?;
    let lease = if !input.applied && input.apply_token.is_some() {
        // A tokened abort only releases the local lease after its transaction ends.
        // Keep the token/binding/owner/OS-lock checks below, without requiring network access.
        Lease::initialize(&app, &state, context.clone()).await?
    } else {
        Lease::begin_for(&app, &state, context.clone(), Some(&input.operation_id)).await?
    };
    let journal = Journal::open(&app, &input.owner_id, &input.operation_id)?; let record = journal.load()?.ok_or_else(|| StorageError::new("operation_not_found"))?;
    if !record.context.same_binding(&context) || record.operation_id != input.operation_id || record.revision.revision_id != input.revision_id || record.revision.shared_asset_id != input.shared_asset_id { return Err(StorageError::new("conflict")); }
    verify_binding(&app, &context, record.owner_revision)?;
    if record.phase == "completed" && input.applied && catalog::access(&app, |_| Ok((journal::read_apply(&app, &context.owner_id)?.is_none(), false)))? {
        return Ok(());
    }
    if !input.applied && input.apply_token.is_none() {
        if record.phase == "completed" && !record.remote_mutation_attempted { return Ok(()); }
        // A hash-only preview may discard its own preparation. Once a remote write
        // was attempted the durable candidate remains recoverable instead.
        if record.direction != "upload" || record.phase != "prepared" || record.remote_mutation_attempted || !record.uploads.is_empty() || record.cleanup_pending { return Err(StorageError::new("conflict")); }
        record.root.resolve(&app)?;
        let (journal, mut record) = clean_journal(app.clone(), journal, record, lease.cancel.clone()).await?;
        verify_binding(&app, &context, record.owner_revision)?;
        record.phase = "completed".into(); journal.save(&record)?; return Ok(());
    }
    let value = input.apply_token.ok_or_else(|| StorageError::new("conflict"))?;
    check_apply(&app, &state, &context, &record, &value)?;
    let (journal, mut record) = if input.applied { record.root.resolve(&app)?; clean_journal(app.clone(), journal, record, lease.cancel.clone()).await? } else { (journal, record) };
    assert_current(&lease.cancel)?;
    if input.applied { record.phase = "completed".into(); journal.save(&record)?; }
    catalog::access(&app, |catalog| {
        let apply = journal::read_apply(&app, &context.owner_id)?.ok_or_else(|| StorageError::new("conflict"))?;
        if apply.token_digest != digest(value.as_bytes()) || apply.owner_revision != catalog.owner_revision(&context.owner_id) { return Err(StorageError::new("conflict")); }
        journal::clear_apply(&app, &context.owner_id)?;
        state.apply_locks.lock().map_err(|_| StorageError::new("unavailable"))?.remove(&context.owner_id);
        Ok(((), false))
    })
}

async fn clean_journal(app: AppHandle, journal: Journal, record: Record, cancel: CancellationToken) -> Result<(Journal, Record), StorageError> {
    tauri::async_runtime::spawn_blocking(move || { journal.clean(&app, &record, &cancel)?; Ok((journal, record)) })
        .await.map_err(|_| StorageError::new("unavailable"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn delete_context() -> Context {
        Context { task_id: "task".into(), owner_id: "owner".into(), connection_id: "connection".into(), connection_revision: "revision".into(),
            library_id: "library".into(), shared_project_id: "project".into(), generation: "legacy".into() }
    }
    fn live_head() -> Head {
        Head { shared_asset_id: "asset".into(), kind: "file".into(), revision_id: "revision".into(), revision_digest: "a".repeat(64),
            operation_id: "publish".into(), updated_at: 1, deleted: None }
    }
    fn delete_preview(head: Head, etag: String) -> super::super::AssetDeletePreviewSession {
        super::super::AssetDeletePreviewSession { context: delete_context(), owner_revision: 7, operation_id: "delete-operation".into(),
            head, etag, token_digest: digest("a".repeat(64).as_bytes()), expires_at: 100 }
    }
    fn delete_input() -> AssetDeleteApplyInput {
        let mut input = serde_json::to_value(delete_context()).unwrap();
        input["operationId"] = serde_json::json!("delete-operation"); input["sharedAssetId"] = serde_json::json!("asset");
        input["previewToken"] = serde_json::json!("a".repeat(64));
        serde_json::from_value(input).unwrap()
    }
    #[tokio::test]
    async fn single_asset_delete_is_conditional_idempotent_and_preserves_shared_content() {
        use object_store::memory::InMemory;
        let store = InMemory::new(); let head = live_head();
        let key = ObjectPath::from("project/heads/asset.json"); let sibling = ObjectPath::from("project/heads/sibling.json");
        let revision = ObjectPath::from("project/revisions/asset/revision.json"); let blob = ObjectPath::from("project/objects/sha256/shared");
        store.put(&key, encode(&head).unwrap().into()).await.unwrap();
        for path in [&sibling, &revision, &blob] { store.put(path, "keep".into()).await.unwrap(); }
        let preview = delete_preview(head.clone(), store.head(&key).await.unwrap().e_tag.unwrap());
        let verify: Verify = Arc::new(|| Ok(())); let cancel = CancellationToken::new();
        assert_eq!(delete_asset_head(&store, &key, &preview, &cancel, &verify).await.unwrap(), "deleted");
        let (deleted, etag) = read_head_at(&store, &key, "asset", &cancel, &verify).await.unwrap().unwrap();
        assert!(deleted.deleted == Some(true)); assert_eq!(deleted.operation_id, preview.operation_id);
        assert_eq!(deleted.revision_id, head.revision_id); assert_eq!(deleted.revision_digest, head.revision_digest);
        assert_eq!(require_live_head(&deleted).unwrap_err().code, "remote_deleted");
        assert_eq!(delete_asset_head(&store, &key, &preview, &cancel, &verify).await.unwrap(), "deleted");
        assert_eq!(store.head(&key).await.unwrap().e_tag.unwrap(), etag);
        assert!(store.put_opts(&key, encode(&head).unwrap().into(), PutOptions::from(PutMode::Create)).await.is_err());
        assert!(store.put_opts(&key, encode(&head).unwrap().into(), PutOptions::from(PutMode::Update(UpdateVersion {
            e_tag: Some(preview.etag), version: None,
        }))).await.is_err());
        for path in [&sibling, &revision, &blob] { assert_eq!(store.get(path).await.unwrap().bytes().await.unwrap().as_ref(), b"keep"); }
    }

    #[tokio::test]
    async fn changed_head_or_etag_blocks_asset_delete_without_touching_other_assets() {
        use object_store::memory::InMemory;
        let store = InMemory::new(); let head = live_head(); let key = ObjectPath::from("project/heads/asset.json");
        store.put(&key, encode(&head).unwrap().into()).await.unwrap();
        let preview = delete_preview(head.clone(), store.head(&key).await.unwrap().e_tag.unwrap());
        let changed = Head { updated_at: 2, ..head };
        store.put(&key, encode(&changed).unwrap().into()).await.unwrap();
        let verify: Verify = Arc::new(|| Ok(())); let cancel = CancellationToken::new();
        assert_eq!(delete_asset_head(&store, &key, &preview, &cancel, &verify).await.unwrap(), "conflict");
        let (actual, _) = read_head_at(&store, &key, "asset", &cancel, &verify).await.unwrap().unwrap();
        assert!(actual == changed);
        let mut another = preview.clone(); another.head = actual; another.etag = store.head(&key).await.unwrap().e_tag.unwrap();
        another.operation_id = "other-delete".into();
        assert_eq!(delete_asset_head(&store, &key, &another, &cancel, &verify).await.unwrap(), "deleted");
        assert_eq!(delete_asset_head(&store, &key, &preview, &cancel, &verify).await.unwrap(), "conflict");
    }

    #[tokio::test]
    async fn cancellation_or_binding_lease_change_before_cas_keeps_head_untouched() {
        use object_store::memory::InMemory;
        let store = InMemory::new(); let head = live_head(); let key = ObjectPath::from("project/heads/asset.json");
        store.put(&key, encode(&head).unwrap().into()).await.unwrap();
        let preview = delete_preview(head.clone(), store.head(&key).await.unwrap().e_tag.unwrap());
        let cancel = CancellationToken::new(); cancel.cancel(); let verify: Verify = Arc::new(|| Ok(()));
        assert_eq!(delete_asset_head(&store, &key, &preview, &cancel, &verify).await.unwrap_err().code, "cancelled");
        let stale: Verify = Arc::new(|| Err(StorageError::new("conflict")));
        assert_eq!(delete_asset_head(&store, &key, &preview, &CancellationToken::new(), &stale).await.unwrap_err().code, "conflict");
        assert_eq!(store.get(&key).await.unwrap().bytes().await.unwrap().as_ref(), encode(&head).unwrap().as_slice());
    }

    #[test]
    fn asset_delete_preview_binds_scope_generation_operation_asset_token_and_expiry() {
        let preview = delete_preview(live_head(), "etag".into()); let context = delete_context(); let input = delete_input();
        assert!(check_asset_delete_preview(&preview, &context, 7, &input, 99).is_ok());
        assert_eq!(check_asset_delete_preview(&preview, &context, 7, &input, 100).unwrap_err().code, "apply_expired");
        assert!(check_asset_delete_preview(&preview, &context, 8, &input, 99).is_err());
        for field in ["owner", "connection", "revision", "library", "project", "generation"] {
            let mut context = context.clone();
            match field {
                "owner" => context.owner_id = "other".into(), "connection" => context.connection_id = "other".into(),
                "revision" => context.connection_revision = "other".into(), "library" => context.library_id = "other".into(),
                "project" => context.shared_project_id = "other".into(), _ => context.generation = "b".repeat(64),
            }
            assert!(check_asset_delete_preview(&preview, &context, 7, &input, 99).is_err());
        }
        for field in ["operation", "asset", "token"] {
            let mut input = delete_input();
            match field { "operation" => input.operation_id = "other".into(), "asset" => input.shared_asset_id = "other".into(), _ => input.preview_token = "b".repeat(64) }
            assert!(check_asset_delete_preview(&preview, &context, 7, &input, 99).is_err());
        }
    }

    #[test]
    fn lost_delete_responses_require_matching_persisted_tombstone_to_confirm_success() {
        let preview = delete_preview(live_head(), "etag".into());
        let deleted = Head { deleted: Some(true), operation_id: "delete-operation".into(), ..live_head() };
        assert_eq!(asset_delete_commit_status(Err(StorageError::new("network")), Ok(Some((deleted.clone(), "etag".into()))), &preview), "deleted");
        assert_eq!(asset_delete_commit_status(Err(StorageError::new("conflict")), Ok(Some((deleted, "etag".into()))), &preview), "deleted");
        assert_eq!(asset_delete_commit_status(Err(StorageError::new("network")), Ok(Some((live_head(), "etag".into()))), &preview), "uncertain");
        assert_eq!(asset_delete_commit_status(Ok(()), Err(StorageError::new("cancelled")), &preview), "uncertain");
        assert_eq!(asset_delete_commit_status(Err(StorageError::new("conflict")), Ok(None), &preview), "conflict");
        let other = Head { deleted: Some(true), operation_id: "other-delete".into(), ..live_head() };
        assert_eq!(asset_delete_commit_status(Ok(()), Ok(Some((other, "etag".into()))), &preview), "conflict");
        let changed = Head { deleted: Some(true), operation_id: "delete-operation".into(), revision_id: "other-revision".into(), ..live_head() };
        assert_eq!(asset_delete_commit_status(Ok(()), Ok(Some((changed, "etag".into()))), &preview), "conflict");
    }
    #[tokio::test]
    async fn cleanup_targets_keep_descriptor_for_clear_and_delete_it_last() {
        use object_store::memory::InMemory;
        let store = InMemory::new();
        let descriptor = ObjectPath::from("project/project.json");
        let asset = ObjectPath::from("project/objects/item");
        let sibling = ObjectPath::from("project-other/objects/item");
        for key in [&descriptor, &asset, &sibling] { store.put(key, "content".into()).await.unwrap(); }
        let objects = vec![store.head(&descriptor).await.unwrap(), store.head(&asset).await.unwrap()];
        assert!(!cleanup_contains("project", sibling.as_ref()));
        let clear = cleanup_targets(&objects, &descriptor, "clear");
        assert_eq!(clear.len(), 1); assert_eq!(clear[0].location, asset);
        for item in clear { store.delete(&item.location).await.unwrap(); }
        assert!(store.head(&descriptor).await.is_ok()); assert!(store.head(&sibling).await.is_ok());
        let delete = cleanup_targets(&objects, &descriptor, "delete");
        assert_eq!(delete.last().unwrap().location, descriptor);
    }
    #[tokio::test]
    async fn cleanup_snapshot_detects_changed_and_added_objects() {
        use object_store::memory::InMemory;
        let store = InMemory::new(); let key = ObjectPath::from("project/item");
        store.put(&key, "first".into()).await.unwrap();
        let first = vec![store.head(&key).await.unwrap()];
        assert!(same_cleanup_snapshot(&first, &first));
        store.put(&key, "changed".into()).await.unwrap();
        let changed = vec![store.head(&key).await.unwrap()];
        assert!(!same_cleanup_snapshot(&first, &changed));
        assert!(!same_cleanup_snapshot(&first, &[]));
    }
    #[test]
    fn late_ack_requires_original_token_binding_and_held_os_lock() {
        let context = Context { task_id: "task".into(), owner_id: "owner".into(), connection_id: "connection".into(),
            connection_revision: "revision".into(), library_id: "library".into(), shared_project_id: "project".into(), generation: "legacy".into() };
        let revision = Revision { format: "format".into(), version: 1, library_id: "library".into(), shared_project_id: "project".into(),
            shared_asset_id: "asset".into(), revision_id: "revision-id".into(), parent_revision_id: None, operation_id: "operation".into(), created_at: 0, payload: serde_json::Value::Null, media: vec![] };
        let record = Record { operation_id: "operation".into(), context: context.clone(), owner_revision: 7,
            root: journal::Root { anchor: "app".into(), relative: "project".into(), fingerprint: "fingerprint".into() }, direction: "download".into(), revision,
            revision_digest: String::new(), base_e_tag: None, phase: "awaitingApply".into(), uploads: Default::default(), downloaded: vec![], cleanup_pending: false,
            untracked_upload: false, remote_mutation_attempted: false, apply_issued: true, conflict_released: false };
        let mut apply = journal::ApplyLease { context: context.clone(), owner_revision: 7, operation_id: "operation".into(), revision_id: "revision-id".into(),
            shared_asset_id: "asset".into(), token_digest: digest(b"token"), expires_at: 0 };
        assert!(apply_matches_ack(&apply, &context, &record, "token", 7, "revision", true));
        assert!(!apply_matches_ack(&apply, &context, &record, "token", 7, "revision", false));
        assert!(!apply_matches_ack(&apply, &context, &record, "other", 7, "revision", true));
        assert!(!apply_matches_ack(&apply, &context, &record, "token", 8, "revision", true));
        assert!(!apply_matches_ack(&apply, &context, &record, "token", 7, "other", true));
        // Offline tokened aborts retain the same complete identity checks as late ACKs.
        for field in ["owner", "connection", "connectionRevision", "library", "project", "generation"] {
            let mut wrong = context.clone();
            match field {
                "owner" => wrong.owner_id = "other".into(), "connection" => wrong.connection_id = "other".into(),
                "connectionRevision" => wrong.connection_revision = "other".into(), "library" => wrong.library_id = "other".into(),
                "project" => wrong.shared_project_id = "other".into(), _ => wrong.generation = "other".into(),
            }
            assert!(!apply_matches_ack(&apply, &wrong, &record, "token", 7, "revision", true), "{field}");
        }
        apply.revision_id = "other".into();
        assert!(!apply_matches_ack(&apply, &context, &record, "token", 7, "revision", true));
        apply.revision_id = record.revision.revision_id.clone();
        apply.shared_asset_id = "other".into();
        assert!(!apply_matches_ack(&apply, &context, &record, "token", 7, "revision", true));
        apply.shared_asset_id = record.revision.shared_asset_id.clone();
        apply.operation_id = "other".into();
        assert!(!apply_matches_ack(&apply, &context, &record, "token", 7, "revision", true));
    }
    #[test]
    fn active_apply_os_lock_cannot_be_taken_for_conflict_release() {
        use fs2::FileExt;
        let path = std::env::temp_dir().join(format!("ai-canvas-apply-lock-test-{}", random_lock_secret().unwrap()));
        let first = std::fs::OpenOptions::new().create_new(true).read(true).write(true).open(&path).unwrap();
        let second = std::fs::OpenOptions::new().read(true).write(true).open(&path).unwrap();
        FileExt::try_lock_exclusive(&first).unwrap();
        assert!(FileExt::try_lock_exclusive(&second).is_err());
        drop(first);
        FileExt::try_lock_exclusive(&second).unwrap();
        drop(second);
        std::fs::remove_file(path).unwrap();
    }
}

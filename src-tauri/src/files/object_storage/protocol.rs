//! Portable, bounded sync records. No local paths or executable configuration enter revisions.
use super::{validate_id, StorageError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub(super) const MANIFEST_LIMIT: usize = 16 * 1024 * 1024;
pub(super) const MEDIA_LIMIT: u64 = 20 * 1024 * 1024 * 1024;
pub(super) const MAX_MEDIA: usize = 5000;
fn legacy_generation() -> String { "legacy".into() }

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    pub task_id: String, pub owner_id: String, pub connection_id: String,
    pub connection_revision: String, pub library_id: String, pub shared_project_id: String,
    #[serde(default = "legacy_generation")] pub generation: String,
}
impl Context {
    pub(super) fn validate(&self) -> Result<(), StorageError> {
        for id in [&self.task_id, &self.owner_id, &self.connection_id, &self.library_id, &self.shared_project_id] { validate_id(id)?; }
        if self.connection_revision.is_empty() || self.connection_revision.len() > 128
            || (self.generation != "legacy" && !valid_digest(&self.generation)) { return Err(invalid()); }
        Ok(())
    }
    pub(super) fn same_binding(&self, other: &Self) -> bool {
        self.owner_id == other.owner_id && self.connection_id == other.connection_id
            && self.connection_revision == other.connection_revision && self.library_id == other.library_id
            && self.shared_project_id == other.shared_project_id && self.generation == other.generation
    }
}

macro_rules! request {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name {
            pub task_id: String, pub owner_id: String, pub connection_id: String,
            pub connection_revision: String, pub library_id: String, pub shared_project_id: String,
            #[serde(default = "legacy_generation")] pub generation: String,
            $(pub $field: $ty),*
        }
        impl $name { pub(super) fn context(&self) -> Context { Context {
            task_id: self.task_id.clone(), owner_id: self.owner_id.clone(), connection_id: self.connection_id.clone(),
            connection_revision: self.connection_revision.clone(), library_id: self.library_id.clone(), shared_project_id: self.shared_project_id.clone(),
            generation: self.generation.clone(),
        } } }
    }
}
request!(ListInput { cursor: Option<String> });
request!(CleanupPreviewInput { mode: String });
request!(CleanupApplyInput { mode: String, preview_token: String });
request!(AssetDeletePreviewInput { operation_id: String, shared_asset_id: String, expected_revision_id: String, expected_e_tag: String });
request!(AssetDeleteApplyInput { operation_id: String, shared_asset_id: String, preview_token: String });
request!(PrepareInput { root_directory: String, draft: Revision, base_e_tag: Option<String>, sources: Vec<Source> });
request!(OperationInput { operation_id: String, revision_id: String, shared_asset_id: String });
request!(DownloadInput { operation_id: String, revision_id: String, shared_asset_id: String, root_directory: String, expected_revision_digest: String });
request!(AcknowledgeInput { operation_id: String, revision_id: String, shared_asset_id: String, apply_token: Option<String>, applied: bool });

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source { pub media_id: String, pub file_path: String }

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Media {
    pub id: String, pub kind: String, pub extension: String,
    #[serde(default)] pub sha256: String,
    #[serde(default)] pub bytes: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Revision {
    pub format: String, pub version: u32, pub library_id: String, pub shared_project_id: String,
    pub shared_asset_id: String, pub revision_id: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub parent_revision_id: Option<String>,
    pub operation_id: String, pub created_at: u64, pub payload: Value, pub media: Vec<Media>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Head {
    pub shared_asset_id: String, pub kind: String, pub revision_id: String,
    pub revision_digest: String, pub operation_id: String, pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deleted_flag")]
    pub deleted: Option<bool>,
}
fn deleted_flag<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<bool>, D::Error> {
    if bool::deserialize(deserializer)? { Ok(Some(true)) }
    else { Err(serde::de::Error::custom("deleted must be true when present")) }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAsset { pub head: Head, pub etag: String, pub revision: Revision }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult { pub assets: Vec<RemoteAsset>, pub deleted_assets: Vec<Head>, pub complete: bool, #[serde(skip_serializing_if = "Option::is_none")] pub next_cursor: Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDeletePreviewResult { pub shared_asset_id: String, pub revision_id: String, pub operation_id: String, pub preview_token: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDeleteApplyResult { pub status: &'static str, pub shared_asset_id: String, pub operation_id: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPreviewResult { pub mode: String, pub object_count: u64, pub bytes: u64, pub preview_token: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupApplyResult { pub status: &'static str, pub deleted_count: u64, pub total_count: u64, #[serde(skip_serializing_if = "Option::is_none")] pub error_code: Option<&'static str> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedResult { pub revision: Revision, pub revision_digest: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")] pub lock_retained: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub asset: Option<RemoteAsset>,
    #[serde(skip_serializing_if = "Option::is_none")] pub apply_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub prepared: Option<PreparedResult>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadedMedia { pub media_id: String, pub relative_path: String, pub bytes: u64, pub sha256: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult { pub operation_id: String, pub revision: Revision, pub revision_digest: String, pub media: Vec<DownloadedMedia>, pub apply_token: String }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress { pub task_id: String, pub owner_id: String, pub operation_id: String, pub phase: &'static str, pub transferred_bytes: u64, pub total_bytes: u64 }

pub(super) fn invalid() -> StorageError { StorageError::new("invalid_input") }
pub(super) fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
pub(super) fn valid_digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) }
fn valid_extension(kind: &str, extension: &str) -> bool {
    match kind {
        "image" => ["jpg", "jpeg", "png", "apng", "webp", "gif", "bmp", "avif", "heic", "heif", "tif", "tiff", "svg", "ico"].contains(&extension),
        "audio" => ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "aiff", "aif", "wma", "webm", "mp4", "weba", "m4b", "caf"].contains(&extension),
        "video" => ["mp4", "webm", "mov", "mkv", "avi", "m4v", "mpeg", "mpg", "wmv", "flv", "3gp", "ts", "mts", "m2ts"].contains(&extension),
        _ => false,
    }
}
pub(super) fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, StorageError> {
    let bytes = serde_json::to_vec(value).map_err(|_| invalid())?;
    if bytes.len() > MANIFEST_LIMIT { return Err(StorageError::new("response_too_large")); }
    Ok(bytes)
}
fn object<'a>(value: &'a Value, allowed: &[&str]) -> Result<&'a Value, StorageError> {
    let map = value.as_object().ok_or_else(invalid)?;
    if map.keys().any(|key| !allowed.contains(&key.as_str())) { return Err(invalid()); }
    Ok(value)
}
fn text(value: &Value, limit: usize) -> Result<&str, StorageError> {
    let value = value.as_str().ok_or_else(invalid)?;
    if value.len() > limit || value.contains('\0') { return Err(invalid()); }
    // Execution references are local state, never portable business text.
    if ["@asset{", "@wf{", "@refmod{", "@skill{", "@model{", "@image{", "@{", "@drama{global/"].iter().any(|needle| value.contains(needle)) { return Err(invalid()); }
    Ok(value)
}
fn id(value: &Value) -> Result<&str, StorageError> { let value = text(value, 128)?; validate_id(value)?; Ok(value) }
fn array(value: &Value, limit: usize) -> Result<&Vec<Value>, StorageError> {
    let values = value.as_array().ok_or_else(invalid)?;
    if values.len() > limit { return Err(invalid()); } Ok(values)
}
fn choice(value: &Value, choices: &[&str]) -> Result<(), StorageError> { if !choices.contains(&text(value, 128)?) { return Err(invalid()); } Ok(()) }
fn number(value: &Value) -> Result<f64, StorageError> { value.as_f64().filter(|n| n.is_finite() && *n >= 0.0 && *n <= 9_007_199_254_740_991.0).ok_or_else(invalid) }
fn timestamp_fields(map: &Value) -> Result<(), StorageError> {
    for key in ["createdAt", "updatedAt"] { if !map[key].is_u64() { return Err(invalid()); } number(&map[key])?; } Ok(())
}
fn strings(values: &Value, depth: usize) -> Result<(), StorageError> {
    if depth > 12 { return Err(invalid()); }
    match values { Value::String(_) => { text(values, 64 * 1024)?; }, Value::Array(list) => { if list.len() > MAX_MEDIA { return Err(invalid()); } for item in list { strings(item, depth + 1)?; } }, Value::Object(map) => for item in map.values() { strings(item, depth + 1)?; }, _ => {} } Ok(())
}
fn display_path(value: &Value, single: bool) -> Result<(), StorageError> {
    let path = text(value, 1024)?;
    if path.is_empty() || (single && path.contains('/')) || path.chars().any(|c| c.is_control() || "\\<>:\"|?*".contains(c)) { return Err(invalid()); }
    for part in path.split('/') {
        let base = part.split('.').next().unwrap_or_default().to_ascii_lowercase();
        if part.is_empty() || part == "." || part == ".." || part.ends_with(['.', ' ']) || ["con", "prn", "aux", "nul"].contains(&base.as_str())
            || (base.len() == 4 && (base.starts_with("com") || base.starts_with("lpt")) && matches!(base.as_bytes()[3], b'1'..=b'9')) { return Err(invalid()); }
    } Ok(())
}
fn media_token(value: &Value, kind: &str, media: &HashMap<&str, &str>, used: &mut HashSet<String>) -> Result<(), StorageError> {
    let token = value.as_str().and_then(|v| v.strip_prefix("aicsync-media:")).ok_or_else(invalid)?;
    validate_id(token)?;
    if media.get(token).copied() != Some(kind) { return Err(invalid()); } used.insert(token.to_string()); Ok(())
}
fn unique_id(map: &Value, ids: &mut HashSet<String>) -> Result<String, StorageError> {
    let value = id(&map["id"])?.to_string(); if !ids.insert(value.clone()) { return Err(invalid()); } Ok(value)
}
fn optional_texts(map: &Value, fields: &[&str]) -> Result<(), StorageError> { for field in fields { if let Some(value) = map.get(*field) { text(value, 64 * 1024)?; } } Ok(()) }

impl Revision {
    pub(super) fn kind(&self) -> &str { self.payload["kind"].as_str().unwrap_or_default() }
    pub(super) fn validate(&self, draft: bool) -> Result<(), StorageError> {
        if self.format != "ai-canvas-shared-asset" || self.version != 1 || self.created_at > 9_007_199_254_740_991 || self.media.len() > MAX_MEDIA { return Err(invalid()); }
        for value in [&self.library_id, &self.shared_project_id, &self.shared_asset_id, &self.revision_id, &self.operation_id] { validate_id(value)?; }
        if let Some(parent) = &self.parent_revision_id { validate_id(parent)?; if parent == &self.revision_id { return Err(invalid()); } }
        let mut media = HashMap::new(); let mut bytes = 0_u64;
        for item in &self.media {
            validate_id(&item.id)?;
            if !valid_extension(&item.kind, &item.extension) || item.extension.is_empty() || item.extension.len() > 8
                || !item.extension.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                || media.insert(item.id.as_str(), item.kind.as_str()).is_some() { return Err(invalid()); }
            if !draft && (item.bytes == 0 || !valid_digest(&item.sha256)) { return Err(invalid()); }
            bytes = bytes.checked_add(item.bytes).ok_or_else(invalid)?;
        }
        if bytes > MEDIA_LIMIT { return Err(invalid()); }
        strings(&self.payload, 0)?;
        let mut used = HashSet::new();
        match self.kind() {
            "file" => self.validate_file(&media, &mut used)?,
            "character" | "scene" | "prop" => self.validate_card(&media, &mut used)?,
            _ => return Err(invalid()),
        }
        if used.len() != media.len() { return Err(invalid()); }
        encode(self)?; Ok(())
    }
    fn validate_file(&self, media: &HashMap<&str, &str>, used: &mut HashSet<String>) -> Result<(), StorageError> {
        let map = object(&self.payload, &["kind", "name", "displayRelativePath", "mediaId", "tags", "taggedBy", "imageMetadata"])?;
        display_path(&map["name"], true)?; display_path(&map["displayRelativePath"], false)?;
        let primary = id(&map["mediaId"])?; if !media.contains_key(primary) { return Err(invalid()); } used.insert(primary.to_string());
        let mut tags = HashSet::new(); for tag in array(&map["tags"], 16)? { let tag = text(tag, 160)?; if tag.trim().is_empty() || tag.encode_utf16().count() > 40 || !tags.insert(tag) { return Err(invalid()); } }
        if let Some(by) = map.get("taggedBy") { choice(by, &["manual", "comfyui", "vision"])?; }
        if let Some(metadata) = map.get("imageMetadata") {
            if media.get(primary).copied() != Some("image") { return Err(invalid()); }
            let metadata = object(metadata, &["prompt", "references"])?; if text(&metadata["prompt"], 64 * 1024)?.encode_utf16().count() > 30_000 { return Err(invalid()); }
            let mut ids = HashSet::new(); for value in array(&metadata["references"], 16)? {
                let reference = object(value, &["id", "name", "mediaId"])?; unique_id(reference, &mut ids)?; text(&reference["name"], 1024)?;
                let mid = id(&reference["mediaId"])?; if media.get(mid).copied() != Some("image") { return Err(invalid()); } used.insert(mid.to_string());
            }
        } Ok(())
    }
    fn validate_card(&self, media: &HashMap<&str, &str>, used: &mut HashSet<String>) -> Result<(), StorageError> {
        let payload = object(&self.payload, &["kind", "data"])?;
        let mut allowed = vec!["id", "kind", "name", "key", "summary", "visualNotes", "storyRole", "importance", "firstSeen", "appearances", "imageUrl", "confirmed", "createdAt", "updatedAt", "source", "referenceImages", "primaryReferenceImageId"];
        allowed.extend(if self.kind() == "character" { vec!["aliases", "identity", "ageBand", "gender", "personality", "relationships", "wardrobeDefault", "voiceNotes", "avatarReferenceImageId", "avatarCrop", "voiceClips", "primaryVoiceClipId", "actions", "weaponIds"] }
            else if self.kind() == "scene" { vec!["placeType", "timeOfDay", "atmosphere", "spatialNotes"] } else { vec!["ownerName", "category", "significance", "propType"] });
        let map = object(&payload["data"], &allowed)?;
        if id(&map["id"])? != self.shared_asset_id || map["kind"].as_str() != Some(self.kind()) || text(&map["name"], 64 * 1024)?.trim().is_empty() || !map["confirmed"].is_boolean() { return Err(invalid()); }
        for field in ["key", "summary", "visualNotes"] { text(&map[field], 64 * 1024)?; }
        optional_texts(map, &["storyRole", "firstSeen"])?;
        choice(&map["importance"], &["main", "supporting", "minor"])?; choice(&map["source"], &["ai", "manual", "merge"])?;
        timestamp_fields(map)?;
        if let Some(appearances) = map.get("appearances") { for appearance in array(appearances, 1000)? { text(appearance, 64 * 1024)?; } }
        optional_texts(map, &["identity", "ageBand", "gender", "personality", "wardrobeDefault", "voiceNotes", "placeType", "timeOfDay", "atmosphere", "spatialNotes", "ownerName", "category", "significance"])?;
        if self.kind() == "character" { text(&map["identity"], 64 * 1024)?; }
        if let Some(prop_type) = map.get("propType") { choice(prop_type, &["weapon"])?; }
        if let Some(weapons) = map.get("weaponIds") {
            let mut weapon_ids = HashSet::new();
            for value in array(weapons, 64)? {
                let weapon_id = id(value)?;
                if weapon_id == self.shared_asset_id || !weapon_ids.insert(weapon_id) { return Err(invalid()); }
            }
        }
        if let Some(value) = map.get("imageUrl") { media_token(value, "image", media, used)?; }
        let mut ids = HashSet::new(); let mut reference_ids = HashSet::new(); let mut voice_ids = HashSet::new();
        if let Some(references) = map.get("referenceImages") { for value in array(references, if self.kind() == "character" { 1000 } else { 32 })? {
            let fields = if self.kind() == "character" { vec!["id", "kind", "imageUrl", "prompt", "createdAt", "updatedAt"] } else { vec!["id", "label", "imageUrl", "prompt", "createdAt", "updatedAt"] };
            let reference = object(value, &fields)?; reference_ids.insert(unique_id(reference, &mut ids)?); timestamp_fields(reference)?; text(&reference["prompt"], 64 * 1024)?;
            if self.kind() == "character" { choice(&reference["kind"], &["primary", "avatar", "full_body", "expression", "turnaround", "outfit", "other"])?; } else { text(&reference["label"], 64 * 1024)?; }
            media_token(&reference["imageUrl"], "image", media, used)?;
        } }
        if let Some(voices) = map.get("voiceClips") { for value in array(voices, 1000)? {
            let voice = object(value, &["id", "kind", "label", "audioUrl", "transcript", "durationSec", "createdAt", "updatedAt"])?;
            voice_ids.insert(unique_id(voice, &mut ids)?); timestamp_fields(voice)?; choice(&voice["kind"], &["timbre", "line", "emotion", "other"])?;
            optional_texts(voice, &["label"])?; text(&voice["transcript"], 64 * 1024)?; if let Some(duration) = voice.get("durationSec") { if number(duration)? == 0.0 { return Err(invalid()); } }
            media_token(&voice["audioUrl"], "audio", media, used)?;
        } }
        if let Some(actions) = map.get("actions") { for value in array(actions, 1000)? {
            let action = object(value, &["id", "category", "customCategory", "name", "prompt", "media", "createdAt", "updatedAt"])?; unique_id(action, &mut ids)?; timestamp_fields(action)?;
            choice(&action["category"], &["standing", "walking", "running", "jumping", "sitting", "crouching", "lying", "climbing", "swimming", "attacking", "defending", "hit", "death", "casting", "interacting", "dancing", "expression", "custom"])?;
            text(&action["name"], 64 * 1024)?; text(&action["prompt"], 64 * 1024)?; optional_texts(action, &["customCategory"])?;
            if let Some(items) = action.get("media") { for value in array(items, 1000)? {
                let item = object(value, &["id", "kind", "name", "mimeType", "url", "createdAt", "updatedAt"])?; unique_id(item, &mut ids)?; timestamp_fields(item)?;
                choice(&item["kind"], &["image", "gif", "video"])?; text(&item["name"], 64 * 1024)?; optional_texts(item, &["mimeType"])?;
                media_token(&item["url"], if item["kind"] == "video" { "video" } else { "image" }, media, used)?;
            } }
        } }
        for (field, collection) in [("primaryReferenceImageId", &reference_ids), ("avatarReferenceImageId", &reference_ids), ("primaryVoiceClipId", &voice_ids)] { if let Some(value) = map.get(field) { if !collection.contains(id(value)?) { return Err(invalid()); } } }
        if let Some(crop) = map.get("avatarCrop") {
            let crop = object(crop, &["x", "y", "width", "height"])?; let x = number(&crop["x"])?; let y = number(&crop["y"])?; let width = number(&crop["width"])?; let height = number(&crop["height"])?;
            if width == 0.0 || height == 0.0 || x + width > 1.0 + 1e-9 || y + height > 1.0 + 1e-9 { return Err(invalid()); }
        }
        if let Some(aliases) = map.get("aliases") { for alias in array(aliases, 1000)? { text(alias, 64 * 1024)?; } }
        if let Some(relationships) = map.get("relationships") { for relation in array(relationships, 1000)? { let relation = object(relation, &["targetName", "relation"])?; text(&relation["targetName"], 64 * 1024)?; text(&relation["relation"], 64 * 1024)?; } }
        Ok(())
    }
}
impl Head {
    pub(super) fn validate(&self) -> Result<(), StorageError> {
        for value in [&self.shared_asset_id, &self.revision_id, &self.operation_id] { validate_id(value)?; }
        if !["file", "character", "scene", "prop"].contains(&self.kind.as_str()) || !valid_digest(&self.revision_digest)
            || self.updated_at > 9_007_199_254_740_991 || self.deleted == Some(false) { return Err(invalid()); } Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn character_weapon_links_use_card_ids_and_fixed_prop_subtype() {
        let mut revision: Revision = serde_json::from_value(serde_json::json!({"format":"ai-canvas-shared-asset","version":1,"libraryId":"l","sharedProjectId":"p","sharedAssetId":"a","revisionId":"r","operationId":"o","createdAt":1,
            "payload":{"kind":"character","data":{"id":"a","kind":"character","name":"role","key":"role","summary":"","visualNotes":"","identity":"","importance":"main","confirmed":true,"source":"manual","createdAt":1,"updatedAt":1,"weaponIds":["sword","bow"]}},"media":[]})).unwrap();
        assert!(revision.validate(false).is_ok());
        for weapons in [serde_json::json!(["sword", "sword"]), serde_json::json!(["global/sword"]), serde_json::json!(["a"]),
            serde_json::json!((0..65).map(|index| format!("weapon-{index}")).collect::<Vec<_>>())] {
            revision.payload["data"]["weaponIds"] = weapons;
            assert!(revision.validate(false).is_err());
        }
        revision.payload["kind"] = serde_json::json!("prop");
        let card = revision.payload["data"].as_object_mut().unwrap();
        card.remove("weaponIds"); card.remove("identity");
        card.insert("kind".into(), serde_json::json!("prop"));
        card.insert("propType".into(), serde_json::json!("weapon"));
        assert!(revision.validate(false).is_ok());
        revision.payload["data"]["propType"] = serde_json::json!("unsupported");
        assert!(revision.validate(false).is_err());
    }

    #[test]
    fn rejects_local_paths_and_unused_media() {
        let mut revision: Revision = serde_json::from_value(serde_json::json!({"format":"ai-canvas-shared-asset","version":1,"libraryId":"l","sharedProjectId":"p","sharedAssetId":"a","revisionId":"r","operationId":"o","createdAt":1,
            "payload":{"kind":"file","name":"a.png","displayRelativePath":"a.png","mediaId":"m","tags":[]},"media":[{"id":"m","kind":"image","extension":"png","sha256":"a".repeat(64),"bytes":1}]})).unwrap();
        assert!(revision.validate(false).is_ok());
        revision.payload["filePath"] = Value::String("private".into()); assert!(revision.validate(false).is_err());
        revision.payload.as_object_mut().unwrap().remove("filePath"); revision.media.push(Media { id:"unused".into(), kind:"image".into(), extension:"png".into(), sha256:"b".repeat(64), bytes:1 }); assert!(revision.validate(false).is_err());
    }
    #[test]
    fn missing_card_fields_fail_without_panicking_and_head_needs_a_digest() {
        let revision: Revision = serde_json::from_value(serde_json::json!({"format":"ai-canvas-shared-asset","version":1,"libraryId":"l","sharedProjectId":"p","sharedAssetId":"a","revisionId":"r","operationId":"o","createdAt":1,"payload":{"kind":"character","data":{"id":"a","kind":"character"}},"media":[]})).unwrap();
        assert!(revision.validate(false).is_err());
        let head = Head { shared_asset_id:"a".into(), kind:"file".into(), revision_id:"r".into(), revision_digest:"a".repeat(64), operation_id:"o".into(), updated_at:1, deleted: None };
        assert!(head.validate().is_ok()); assert!(Head { revision_digest:"etag-is-not-sha256".into(), ..head }.validate().is_err());
        assert!(!valid_extension("image", "lnk")); assert!(!valid_extension("video", "exe")); assert!(valid_extension("audio", "wav"));
    }

    #[test]
    fn normal_heads_keep_old_wire_shape_and_deleted_heads_fail_closed_for_old_readers() {
        let head = Head { shared_asset_id: "asset".into(), kind: "file".into(), revision_id: "revision".into(),
            revision_digest: "a".repeat(64), operation_id: "publish".into(), updated_at: 1, deleted: None };
        let normal = serde_json::to_value(&head).unwrap();
        assert!(normal.get("deleted").is_none());
        let parsed: Head = serde_json::from_value(normal.clone()).unwrap(); assert!(parsed.validate().is_ok());
        let deleted = serde_json::to_value(Head { deleted: Some(true), ..head }).unwrap();
        let tombstone: Head = serde_json::from_value(deleted.clone()).unwrap(); assert!(tombstone.validate().is_ok());
        assert!(object(&deleted, &["sharedAssetId", "kind", "revisionId", "revisionDigest", "operationId", "updatedAt"]).is_err());
        for flag in [serde_json::json!(false), serde_json::Value::Null, serde_json::json!("true")] {
            let mut invalid = normal.clone(); invalid["deleted"] = flag;
            assert!(serde_json::from_value::<Head>(invalid).is_err());
        }
        let result = ListResult { assets: vec![], deleted_assets: vec![tombstone], complete: true, next_cursor: None };
        assert!(serde_json::to_value(result).unwrap().get("deletedAssets").unwrap().is_array());
    }
}

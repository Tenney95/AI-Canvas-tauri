//! Blender Job result contracts and fail-closed structural validation.
//!
//! This module deliberately performs no filesystem writes or artifact moves. The future native
//! collector must first establish containment and stream-hash every artifact, then use the
//! validated manifest/reference returned here as the immutable commit contract.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fmt};

pub const BLENDER_RESULT_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const BLENDER_RESULT_MANIFEST_MAX_BYTES: usize = 512 * 1024;
pub const BLENDER_RESULT_MAX_ARTIFACTS: usize = 256;

const JS_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;
const MAX_ID_LENGTH: usize = 128;
const MAX_PATH_LENGTH: usize = 512;
const MAX_PATH_SEGMENT_LENGTH: usize = 240;
const MAX_PATH_DEPTH: usize = 32;
const MAX_VERSION_LENGTH: usize = 64;
const MAX_FRAME: u64 = 10_000_000;
const MAX_FPS: f64 = 240.0;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlenderResultArtifactKind {
    FrameImage,
    ReferenceVideo,
    BlendProject,
}

impl BlenderResultArtifactKind {
    pub(crate) fn expected_extension(self) -> &'static str {
        match self {
            Self::FrameImage => "png",
            Self::ReferenceVideo => "mp4",
            Self::BlendProject => "blend",
        }
    }

    pub(crate) fn expected_mime_type(self) -> &'static str {
        match self {
            Self::FrameImage => "image/png",
            Self::ReferenceVideo => "video/mp4",
            Self::BlendProject => "application/x-blender",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlenderResultRuntime {
    Blender,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlenderResultProducer {
    pub runtime: BlenderResultRuntime,
    pub adapter_version: String,
    pub blender_version: String,
}

/// The optional fields intentionally share one struct so canonical serialization preserves the
/// Phase 1-A key order (`artifactId`, `kind`, `mimeType`, path/hash/bytes, kind-specific fields).
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlenderResultArtifact {
    pub artifact_id: String,
    pub kind: BlenderResultArtifactKind,
    pub mime_type: String,
    pub relative_path: String,
    pub sha256: String,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_frame: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_frame: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<serde_json::Number>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlenderResultManifest {
    pub schema_version: u32,
    pub scene_id: String,
    pub scene_revision: u64,
    pub scene_sha256: String,
    pub manifest_revision: u64,
    pub producer: BlenderResultProducer,
    pub artifacts: Vec<BlenderResultArtifact>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlenderResultManifestReference {
    pub schema_version: u32,
    pub scene_id: String,
    pub scene_revision: u64,
    pub scene_sha256: String,
    pub manifest_revision: u64,
    pub relative_path: String,
    pub sha256: String,
    pub bytes: u64,
}

/// Immutable Scene/previous-Manifest binding captured when the Job starts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlenderResultBinding {
    pub scene_id: String,
    pub scene_revision: u64,
    pub scene_sha256: String,
    pub previous_manifest_revision: Option<u64>,
    pub previous_manifest_sha256: Option<String>,
}

/// Untrusted, size-bounded bytes produced by a runner. No declared byte count is used to allocate
/// this buffer; the runner/reader remains responsible for enforcing the read cap before creation.
#[derive(Clone, Debug)]
pub struct BlenderCollectCandidate {
    manifest_json: Vec<u8>,
}

impl BlenderCollectCandidate {
    pub fn new(manifest_json: Vec<u8>) -> Self {
        Self { manifest_json }
    }
}

/// Public collect payload. It contains project-relative, content-addressed references only.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderCollectedResult {
    pub manifest: BlenderResultManifest,
    pub manifest_reference: BlenderResultManifestReference,
}

/// The native collector will need the exact canonical bytes for immutable persistence. They are
/// retained separately and never serialized into an IPC/event payload.
#[derive(Clone, Debug)]
pub struct ValidatedBlenderCollectResult {
    collected: BlenderCollectedResult,
    canonical_manifest_bytes: Vec<u8>,
}

impl ValidatedBlenderCollectResult {
    pub fn collected(&self) -> &BlenderCollectedResult {
        &self.collected
    }

    pub fn canonical_manifest_bytes(&self) -> &[u8] {
        &self.canonical_manifest_bytes
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BlenderResultValidationErrorCode {
    InvalidBinding,
    InvalidManifestEncoding,
    InvalidManifestShape,
    ManifestLimitExceeded,
    NonCanonicalManifest,
    SceneBindingMismatch,
    ManifestRevisionMismatch,
    InvalidProducer,
    InvalidArtifact,
    DuplicateArtifact,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BlenderResultValidationError {
    pub code: BlenderResultValidationErrorCode,
}

impl BlenderResultValidationError {
    fn new(code: BlenderResultValidationErrorCode) -> Self {
        Self { code }
    }

    pub fn public_message(self) -> &'static str {
        match self.code {
            BlenderResultValidationErrorCode::ManifestLimitExceeded => {
                "Blender 结果清单超过安全上限"
            }
            BlenderResultValidationErrorCode::NonCanonicalManifest => {
                "Blender 结果清单不是规范格式"
            }
            BlenderResultValidationErrorCode::SceneBindingMismatch
            | BlenderResultValidationErrorCode::ManifestRevisionMismatch => {
                "Blender 结果清单与当前场景不匹配"
            }
            _ => "Blender 结果清单校验失败",
        }
    }
}

impl fmt::Display for BlenderResultValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.public_message())
    }
}

impl std::error::Error for BlenderResultValidationError {}

fn validation_error(code: BlenderResultValidationErrorCode) -> BlenderResultValidationError {
    BlenderResultValidationError::new(code)
}

fn is_safe_integer(value: u64, allow_zero: bool) -> bool {
    value <= JS_SAFE_INTEGER_MAX && (allow_zero || value > 0)
}

fn is_valid_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_ID_LENGTH {
        return false;
    }
    let is_edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    is_edge(bytes[0])
        && is_edge(bytes[bytes.len() - 1])
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn is_valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn is_safe_text(value: &str, max_chars: usize) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.chars().count() <= max_chars
        && !value.chars().any(char::is_control)
}

fn is_safe_project_relative_path(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_PATH_LENGTH
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains('\\')
        || value.contains(':')
        || value.chars().any(char::is_control)
    {
        return false;
    }
    let segments: Vec<_> = value.split('/').collect();
    !segments.is_empty()
        && segments.len() <= MAX_PATH_DEPTH
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && *segment != "."
                && *segment != ".."
                && segment.len() <= MAX_PATH_SEGMENT_LENGTH
        })
}

fn expected_manifest_revision(binding: &BlenderResultBinding) -> Option<u64> {
    match (
        binding.previous_manifest_revision,
        binding.previous_manifest_sha256.as_deref(),
    ) {
        (None, None) => Some(1),
        (Some(revision), Some(hash))
            if is_safe_integer(revision, false)
                && is_valid_sha256(hash)
                && revision < JS_SAFE_INTEGER_MAX =>
        {
            Some(revision + 1)
        }
        _ => None,
    }
}

fn validate_binding(binding: &BlenderResultBinding) -> Result<u64, BlenderResultValidationError> {
    if !is_valid_identifier(&binding.scene_id)
        || !is_safe_integer(binding.scene_revision, false)
        || !is_valid_sha256(&binding.scene_sha256)
    {
        return Err(validation_error(
            BlenderResultValidationErrorCode::InvalidBinding,
        ));
    }
    expected_manifest_revision(binding)
        .ok_or_else(|| validation_error(BlenderResultValidationErrorCode::InvalidBinding))
}

pub(crate) fn expected_artifact_relative_path(
    scene_id: &str,
    artifact: &BlenderResultArtifact,
) -> String {
    format!(
        "director/scenes/{scene_id}/results/{}-{}.{}",
        artifact.artifact_id,
        artifact.sha256,
        artifact.kind.expected_extension()
    )
}

fn validate_artifact(
    scene_id: &str,
    artifact: &BlenderResultArtifact,
) -> Result<(), BlenderResultValidationError> {
    if !is_valid_identifier(&artifact.artifact_id)
        || !is_valid_sha256(&artifact.sha256)
        || !is_safe_integer(artifact.bytes, false)
        || artifact.mime_type != artifact.kind.expected_mime_type()
        || !is_safe_project_relative_path(&artifact.relative_path)
        || artifact.relative_path != expected_artifact_relative_path(scene_id, artifact)
    {
        return Err(validation_error(
            BlenderResultValidationErrorCode::InvalidArtifact,
        ));
    }

    let valid_kind_fields = match artifact.kind {
        BlenderResultArtifactKind::FrameImage => {
            artifact.frame.is_some_and(|frame| frame <= MAX_FRAME)
                && artifact.start_frame.is_none()
                && artifact.end_frame.is_none()
                && artifact.fps.is_none()
        }
        BlenderResultArtifactKind::ReferenceVideo => {
            artifact.frame.is_none()
                && artifact.start_frame.is_some_and(|frame| frame <= MAX_FRAME)
                && artifact.end_frame.is_some_and(|frame| frame <= MAX_FRAME)
                && artifact
                    .start_frame
                    .zip(artifact.end_frame)
                    .is_some_and(|(start, end)| end >= start)
                && artifact.fps.as_ref().is_some_and(|fps| {
                    fps.as_f64()
                        .is_some_and(|value| value.is_finite() && (1.0..=MAX_FPS).contains(&value))
                })
        }
        BlenderResultArtifactKind::BlendProject => {
            artifact.frame.is_none()
                && artifact.start_frame.is_none()
                && artifact.end_frame.is_none()
                && artifact.fps.is_none()
        }
    };
    if !valid_kind_fields {
        return Err(validation_error(
            BlenderResultValidationErrorCode::InvalidArtifact,
        ));
    }
    Ok(())
}

fn validate_manifest_at_revision(
    binding: &BlenderResultBinding,
    manifest: &BlenderResultManifest,
    expected_revision: u64,
) -> Result<(), BlenderResultValidationError> {
    let _ = validate_binding(binding)?;
    if manifest.schema_version != BLENDER_RESULT_MANIFEST_SCHEMA_VERSION
        || !is_safe_integer(manifest.scene_revision, false)
        || !is_safe_integer(manifest.manifest_revision, false)
        || !is_valid_identifier(&manifest.scene_id)
        || !is_valid_sha256(&manifest.scene_sha256)
    {
        return Err(validation_error(
            BlenderResultValidationErrorCode::InvalidManifestShape,
        ));
    }
    if manifest.scene_id != binding.scene_id
        || manifest.scene_revision != binding.scene_revision
        || manifest.scene_sha256 != binding.scene_sha256
    {
        return Err(validation_error(
            BlenderResultValidationErrorCode::SceneBindingMismatch,
        ));
    }
    if manifest.manifest_revision != expected_revision {
        return Err(validation_error(
            BlenderResultValidationErrorCode::ManifestRevisionMismatch,
        ));
    }
    if manifest.producer.runtime != BlenderResultRuntime::Blender
        || !is_safe_text(&manifest.producer.adapter_version, MAX_VERSION_LENGTH)
        || !is_safe_text(&manifest.producer.blender_version, MAX_VERSION_LENGTH)
    {
        return Err(validation_error(
            BlenderResultValidationErrorCode::InvalidProducer,
        ));
    }
    if manifest.artifacts.len() > BLENDER_RESULT_MAX_ARTIFACTS {
        return Err(validation_error(
            BlenderResultValidationErrorCode::ManifestLimitExceeded,
        ));
    }

    let mut artifact_ids = HashSet::with_capacity(manifest.artifacts.len());
    let mut artifact_paths = HashSet::with_capacity(manifest.artifacts.len());
    for artifact in &manifest.artifacts {
        validate_artifact(&manifest.scene_id, artifact)?;
        if !artifact_ids.insert(artifact.artifact_id.as_str())
            || !artifact_paths.insert(artifact.relative_path.as_str())
        {
            return Err(validation_error(
                BlenderResultValidationErrorCode::DuplicateArtifact,
            ));
        }
    }
    Ok(())
}

pub(crate) fn canonical_manifest_bytes(
    manifest: &BlenderResultManifest,
) -> Result<Vec<u8>, BlenderResultValidationError> {
    let mut bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|_| validation_error(BlenderResultValidationErrorCode::InvalidManifestShape))?;
    bytes.push(b'\n');
    if bytes.len() > BLENDER_RESULT_MANIFEST_MAX_BYTES {
        return Err(validation_error(
            BlenderResultValidationErrorCode::ManifestLimitExceeded,
        ));
    }
    Ok(bytes)
}

pub fn validate_blender_collect_candidate(
    binding: &BlenderResultBinding,
    candidate: BlenderCollectCandidate,
) -> Result<ValidatedBlenderCollectResult, BlenderResultValidationError> {
    if candidate.manifest_json.is_empty()
        || candidate.manifest_json.len() > BLENDER_RESULT_MANIFEST_MAX_BYTES
    {
        return Err(validation_error(
            BlenderResultValidationErrorCode::ManifestLimitExceeded,
        ));
    }
    if std::str::from_utf8(&candidate.manifest_json).is_err()
        || candidate.manifest_json.starts_with(&[0xef, 0xbb, 0xbf])
    {
        return Err(validation_error(
            BlenderResultValidationErrorCode::InvalidManifestEncoding,
        ));
    }

    let manifest: BlenderResultManifest = serde_json::from_slice(&candidate.manifest_json)
        .map_err(|_| validation_error(BlenderResultValidationErrorCode::InvalidManifestShape))?;
    let expected_revision = validate_binding(binding)?;
    validate_manifest_at_revision(binding, &manifest, expected_revision)?;

    let canonical_bytes = canonical_manifest_bytes(&manifest)?;
    if canonical_bytes != candidate.manifest_json {
        return Err(validation_error(
            BlenderResultValidationErrorCode::NonCanonicalManifest,
        ));
    }

    let digest = Sha256::digest(&canonical_bytes);
    let manifest_sha256 = format!("{digest:x}");
    let manifest_reference = BlenderResultManifestReference {
        schema_version: BLENDER_RESULT_MANIFEST_SCHEMA_VERSION,
        scene_id: manifest.scene_id.clone(),
        scene_revision: manifest.scene_revision,
        scene_sha256: manifest.scene_sha256.clone(),
        manifest_revision: manifest.manifest_revision,
        relative_path: format!(
            "director/scenes/{}/results/manifest-r{}-{}.json",
            manifest.scene_id, manifest.manifest_revision, manifest_sha256
        ),
        sha256: manifest_sha256,
        bytes: canonical_bytes.len() as u64,
    };

    Ok(ValidatedBlenderCollectResult {
        collected: BlenderCollectedResult {
            manifest,
            manifest_reference,
        },
        canonical_manifest_bytes: canonical_bytes,
    })
}

/// 校验项目目录里已存在的规范 Manifest。调用方仍需逐个复核 artifact 文件内容。
pub(crate) fn validate_existing_blender_manifest(
    binding: &BlenderResultBinding,
    expected_revision: u64,
    expected_sha256: &str,
    manifest_json: &[u8],
) -> Result<BlenderResultManifest, BlenderResultValidationError> {
    if manifest_json.is_empty()
        || manifest_json.len() > BLENDER_RESULT_MANIFEST_MAX_BYTES
        || !is_safe_integer(expected_revision, false)
        || !is_valid_sha256(expected_sha256)
        || std::str::from_utf8(manifest_json).is_err()
        || manifest_json.starts_with(&[0xef, 0xbb, 0xbf])
    {
        return Err(validation_error(
            BlenderResultValidationErrorCode::InvalidManifestEncoding,
        ));
    }
    let manifest: BlenderResultManifest = serde_json::from_slice(manifest_json)
        .map_err(|_| validation_error(BlenderResultValidationErrorCode::InvalidManifestShape))?;
    validate_manifest_at_revision(binding, &manifest, expected_revision)?;
    let canonical = canonical_manifest_bytes(&manifest)?;
    if canonical != manifest_json || format!("{:x}", Sha256::digest(&canonical)) != expected_sha256
    {
        return Err(validation_error(
            BlenderResultValidationErrorCode::NonCanonicalManifest,
        ));
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> BlenderResultBinding {
        BlenderResultBinding {
            scene_id: "scene-1".to_string(),
            scene_revision: 1,
            scene_sha256: "a".repeat(64),
            previous_manifest_revision: None,
            previous_manifest_sha256: None,
        }
    }

    fn manifest() -> BlenderResultManifest {
        BlenderResultManifest {
            schema_version: 1,
            scene_id: "scene-1".to_string(),
            scene_revision: 1,
            scene_sha256: "a".repeat(64),
            manifest_revision: 1,
            producer: BlenderResultProducer {
                runtime: BlenderResultRuntime::Blender,
                adapter_version: "1.0.0".to_string(),
                blender_version: "4.5.0".to_string(),
            },
            artifacts: vec![BlenderResultArtifact {
                artifact_id: "frame-1".to_string(),
                kind: BlenderResultArtifactKind::FrameImage,
                mime_type: "image/png".to_string(),
                relative_path: format!(
                    "director/scenes/scene-1/results/frame-1-{}.png",
                    "b".repeat(64)
                ),
                sha256: "b".repeat(64),
                bytes: 16,
                frame: Some(1),
                start_frame: None,
                end_frame: None,
                fps: None,
            }],
        }
    }

    #[test]
    fn validates_canonical_manifest_and_derives_reference() {
        let manifest = manifest();
        let candidate = BlenderCollectCandidate::new(
            canonical_manifest_bytes(&manifest).expect("manifest should serialize"),
        );
        let validated = validate_blender_collect_candidate(&binding(), candidate)
            .expect("canonical manifest should validate");

        assert_eq!(validated.collected().manifest, manifest);
        assert_eq!(validated.collected().manifest_reference.schema_version, 1);
        assert_eq!(
            validated.collected().manifest_reference.bytes,
            validated.canonical_manifest_bytes().len() as u64
        );
    }

    #[test]
    fn rejects_non_canonical_or_path_mismatched_manifest() {
        let mut non_canonical =
            canonical_manifest_bytes(&manifest()).expect("manifest should serialize");
        non_canonical.extend_from_slice(b" \n");
        let error = validate_blender_collect_candidate(
            &binding(),
            BlenderCollectCandidate::new(non_canonical),
        )
        .expect_err("extra whitespace must be rejected");
        assert_eq!(
            error.code,
            BlenderResultValidationErrorCode::NonCanonicalManifest
        );

        let mut invalid_path = manifest();
        invalid_path.artifacts[0].relative_path = "director/results/frame.png".to_string();
        let error = validate_blender_collect_candidate(
            &binding(),
            BlenderCollectCandidate::new(
                canonical_manifest_bytes(&invalid_path).expect("manifest should serialize"),
            ),
        )
        .expect_err("non-content-addressed path must be rejected");
        assert_eq!(
            error.code,
            BlenderResultValidationErrorCode::InvalidArtifact
        );
    }
}

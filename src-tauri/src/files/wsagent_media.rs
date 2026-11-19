//! WSAGENT 项目媒体只经已配对的本机服务读取。原件由 Rust 流式写入，前端仅取得结果引用。
use super::{main_storage, WsagentSharedState};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, Webview};

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    #[default]
    All,
    Image,
    Video,
    Audio,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaAsset {
    id: String,
    name: String,
    kind: MediaKind,
    mime: String,
    bytes: u64,
    created_at: u64,
    generated: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPage {
    assets: Vec<MediaAsset>,
    next_offset: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaImport {
    file_path: String,
    file_name: String,
    mime: String,
    bytes: u64,
}

#[tauri::command]
pub async fn wsagent_shared_open(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
) -> Result<(), String> {
    let storage = main_storage(&webview, &app, &state, &owner_id)?;
    #[cfg(target_os = "macos")]
    return native::open_application(storage, owner_id).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = storage;
        Err("打开 WSAGENT 目前仅支持 macOS".into())
    }
}

#[tauri::command]
pub async fn wsagent_shared_media_list(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
    kind: Option<MediaKind>,
    offset: Option<u32>,
) -> Result<MediaPage, String> {
    let storage = main_storage(&webview, &app, &state, &owner_id)?;
    #[cfg(target_os = "macos")]
    return native::list(
        app,
        storage,
        owner_id,
        kind.unwrap_or_default(),
        offset.unwrap_or(0),
    )
    .await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (storage, kind, offset);
        Err("WSAGENT 项目素材目前仅支持 macOS".into())
    }
}

#[tauri::command]
pub async fn wsagent_shared_media_preview(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
    asset_id: String,
) -> Result<String, String> {
    let storage = main_storage(&webview, &app, &state, &owner_id)?;
    #[cfg(target_os = "macos")]
    return native::preview(app, storage, owner_id, asset_id).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (storage, asset_id);
        Err("WSAGENT 项目素材目前仅支持 macOS".into())
    }
}

#[tauri::command]
pub async fn wsagent_shared_media_import(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
    asset_id: String,
    project_directory: String,
    name: Option<String>,
) -> Result<MediaImport, String> {
    let storage = main_storage(&webview, &app, &state, &owner_id)?;
    #[cfg(target_os = "macos")]
    return native::import(
        webview,
        storage,
        owner_id,
        asset_id,
        project_directory,
        name,
    )
    .await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (storage, asset_id, project_directory, name);
        Err("WSAGENT 项目素材目前仅支持 macOS".into())
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::{MediaImport, MediaKind, MediaPage};
    use crate::native_project_media::{
        publish_project_media_stream, resolve_project_media_import_root,
    };
    use crate::wsagent_shared::peer::{PairedProject, PAIRING_CHANGED, UNAVAILABLE};
    use crate::wsagent_shared::{ipc, normalize_name, project_id, SharedStorage};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use reqwest::{blocking::Response, header, StatusCode};
    use serde_json::{json, Value};
    use std::{
        io::{Cursor, Read},
        path::Path,
        process::{Command, Stdio},
        sync::Arc,
    };
    use tauri::{AppHandle, Manager, Webview};
    use tokio::sync::Semaphore;

    const MAX_ORIGINAL: u64 = 4 * 1024 * 1024 * 1024;
    const MAX_PREVIEW: u64 = 512 * 1024;
    const MAX_PAGE: u64 = 512 * 1024;
    const PAGE_SIZE: usize = 30;
    const INVALID_MEDIA: &str = "WSAGENT 返回的媒体数据无效";
    static MEDIA_REQUESTS: Semaphore = Semaphore::const_new(8);
    static MEDIA_IMPORTS: Semaphore = Semaphore::const_new(1);

    fn media_request(
        pair: &PairedProject,
        app: &AppHandle,
        path: &'static str,
        fields: Value,
    ) -> Result<Response, String> {
        let response = pair.request(app, path, fields)?;
        match response.status() {
            StatusCode::OK => Ok(response),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::CONFLICT => {
                Err(PAIRING_CHANGED.into())
            }
            StatusCode::NOT_FOUND => Err("WSAGENT 中的素材或预览已不可用".into()),
            StatusCode::PAYLOAD_TOO_LARGE => Err("WSAGENT 素材超过传输大小限制".into()),
            StatusCode::TOO_MANY_REQUESTS => Err("WSAGENT 正在处理其他素材，请稍后重试".into()),
            _ => Err(UNAVAILABLE.into()),
        }
    }

    async fn worker<T: Send + 'static>(
        work: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        tokio::task::spawn_blocking(work)
            .await
            .map_err(|_| "WSAGENT 本机操作中断")?
    }

    pub(super) async fn open_application(
        storage: Arc<SharedStorage>,
        owner_id: String,
    ) -> Result<(), String> {
        let scope = ipc(storage.active_scope(&owner_id))?;
        worker(move || {
            for bundle in ["com.feifei.film-workbench", "com.wsagent.desktop"] {
                drop(ipc(storage.lock_scope(&scope))?);
                let opened = Command::new("/usr/bin/open")
                    .args(["-b", bundle])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|status| status.success());
                if opened {
                    return Ok(());
                }
            }
            Err("未找到 WSAGENT，请确认已安装 WSAGENT 桌面版".into())
        })
        .await
    }

    fn format(mime: &str) -> Option<(MediaKind, &'static str)> {
        use MediaKind::{Audio, Image, Video};
        match mime {
            "image/png" => Some((Image, "png")),
            "image/jpeg" => Some((Image, "jpg")),
            "image/webp" => Some((Image, "webp")),
            "image/gif" => Some((Image, "gif")),
            "image/bmp" => Some((Image, "bmp")),
            "image/avif" => Some((Image, "avif")),
            "video/mp4" => Some((Video, "mp4")),
            "video/quicktime" => Some((Video, "mov")),
            "video/webm" => Some((Video, "webm")),
            "video/x-matroska" => Some((Video, "mkv")),
            "audio/mpeg" => Some((Audio, "mp3")),
            "audio/wav" => Some((Audio, "wav")),
            "audio/ogg" => Some((Audio, "ogg")),
            "audio/flac" => Some((Audio, "flac")),
            "audio/aac" => Some((Audio, "aac")),
            "audio/mp4" => Some((Audio, "m4a")),
            "audio/webm" => Some((Audio, "weba")),
            _ => None,
        }
    }

    fn media_headers(response: &Response, limit: u64) -> Result<(String, u64), String> {
        let headers = response.headers();
        if headers
            .get(header::CONTENT_ENCODING)
            .is_some_and(|value| value != "identity")
        {
            return Err(INVALID_MEDIA.into());
        }
        let mime = headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .ok_or(INVALID_MEDIA)?;
        let bytes = headers
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|bytes| (1..=limit).contains(bytes))
            .ok_or(INVALID_MEDIA)?;
        Ok((mime.into(), bytes))
    }

    fn bounded_response(response: Response, limit: u64) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::new();
        response
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| UNAVAILABLE)?;
        if bytes.len() as u64 > limit {
            return Err(INVALID_MEDIA.into());
        }
        Ok(bytes)
    }

    fn original_prefix_matches(mime: &str, prefix: &[u8]) -> bool {
        let Some(first) = prefix.get(..4) else {
            return false;
        };
        let tag = prefix.get(4..8);
        let frame = u16::from_be_bytes([first[0], first[1]]);
        match mime {
            "image/avif" => {
                let header_len =
                    u32::from_be_bytes([first[0], first[1], first[2], first[3]]) as usize;
                tag == Some(b"ftyp")
                    && prefix
                        .get(8..header_len.min(prefix.len()))
                        .is_some_and(|brands| {
                            brands.chunks_exact(4).enumerate().any(|(index, brand)| {
                                index != 1 && matches!(brand, b"avif" | b"avis")
                            })
                        })
            }
            value if value.starts_with("image/") => {
                image::guess_format(prefix).is_ok_and(|format| format.to_mime_type() == mime)
            }
            "video/mp4" | "video/quicktime" | "audio/mp4" => tag.is_some_and(|tag| {
                [b"ftyp", b"moov", b"mdat", b"wide", b"free"]
                    .iter()
                    .any(|kind| tag == *kind)
            }),
            "video/webm" | "video/x-matroska" | "audio/webm" => {
                prefix.starts_with(b"\x1a\x45\xdf\xa3")
            }
            "audio/mpeg" => prefix.starts_with(b"ID3") || frame & 0xffe0 == 0xffe0,
            "audio/aac" => prefix.starts_with(b"ID3") || frame & 0xfff6 == 0xfff0,
            "audio/ogg" => prefix.starts_with(b"OggS"),
            "audio/wav" => {
                (prefix.starts_with(b"RIFF") || prefix.starts_with(b"RF64"))
                    && prefix.get(8..12) == Some(b"WAVE")
            }
            "audio/flac" => prefix.starts_with(b"fLaC"),
            _ => false,
        }
    }

    pub(super) async fn list(
        app: AppHandle,
        storage: Arc<SharedStorage>,
        owner_id: String,
        kind: MediaKind,
        offset: u32,
    ) -> Result<MediaPage, String> {
        let scope = ipc(storage.active_scope(&owner_id))?;
        let permit = MEDIA_REQUESTS.acquire().await.map_err(|_| UNAVAILABLE)?;
        worker(move || {
            let _permit = permit;
            let pair = PairedProject::open(&storage, scope)?;
            let response = media_request(
                &pair,
                &app,
                "/v1/media/list",
                json!({ "kind": kind, "offset": offset }),
            )?;
            let response = bounded_response(response, MAX_PAGE)?;
            let mut page: MediaPage =
                serde_json::from_slice(&response).map_err(|_| INVALID_MEDIA)?;
            if page.assets.len() > PAGE_SIZE || page.next_offset.is_some_and(|next| next <= offset)
            {
                return Err(INVALID_MEDIA.into());
            }
            page.assets.retain_mut(|asset| {
                if project_id(&asset.id).is_err()
                    || !(1..=MAX_ORIGINAL).contains(&asset.bytes)
                    || format(&asset.mime).is_none_or(|(format_kind, _)| format_kind != asset.kind)
                    || kind != MediaKind::All && kind != asset.kind
                {
                    return false;
                }
                asset.name = normalize_name(&asset.name);
                true
            });
            let _lease = pair.current(&storage)?;
            Ok(page)
        })
        .await
    }

    pub(super) async fn preview(
        app: AppHandle,
        storage: Arc<SharedStorage>,
        owner_id: String,
        asset_id: String,
    ) -> Result<String, String> {
        ipc(project_id(&asset_id))?;
        let scope = ipc(storage.active_scope(&owner_id))?;
        let permit = MEDIA_REQUESTS.acquire().await.map_err(|_| UNAVAILABLE)?;
        worker(move || {
            let _permit = permit;
            let pair = PairedProject::open(&storage, scope)?;
            let response = media_request(
                &pair,
                &app,
                "/v1/media/preview",
                json!({ "assetId": asset_id }),
            )?;
            let (mime, length) = media_headers(&response, MAX_PREVIEW)?;
            if !matches!(mime.as_str(), "image/jpeg" | "image/png" | "image/webp") {
                return Err(INVALID_MEDIA.into());
            }
            let bytes = bounded_response(response, length)?;
            if bytes.len() as u64 != length
                || !image::guess_format(&bytes).is_ok_and(|format| format.to_mime_type() == mime)
            {
                return Err(INVALID_MEDIA.into());
            }
            let _lease = pair.current(&storage)?;
            Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
        })
        .await
    }

    pub(super) async fn import(
        webview: Webview,
        storage: Arc<SharedStorage>,
        owner_id: String,
        asset_id: String,
        project_directory: String,
        name: Option<String>,
    ) -> Result<MediaImport, String> {
        ipc(project_id(&asset_id))?;
        let scope = ipc(storage.active_scope(&owner_id))?;
        let permit = MEDIA_IMPORTS
            .try_acquire()
            .map_err(|_| "正在取回另一份 WSAGENT 原件，请稍后重试")?;
        worker(move || {
            let _permit = permit;
            let pair = PairedProject::open(&storage, scope)?;
            let root = resolve_project_media_import_root(&webview, &owner_id, &project_directory)?;
            let mut response = media_request(
                &pair,
                webview.app_handle(),
                "/v1/media/read",
                json!({ "assetId": asset_id }),
            )?;
            let (mime, bytes) = media_headers(&response, MAX_ORIGINAL)?;
            let (_, extension) = format(&mime).ok_or(INVALID_MEDIA)?;
            let mut prefix = vec![0; bytes.min(512) as usize];
            response.read_exact(&mut prefix).map_err(|_| UNAVAILABLE)?;
            if !original_prefix_matches(&mime, &prefix) {
                return Err(INVALID_MEDIA.into());
            }
            let source_name = name
                .as_deref()
                .filter(|name| !name.trim().is_empty())
                .unwrap_or("WSAGENT 素材");
            let source_name = normalize_name(source_name);
            let stem = Path::new(&source_name)
                .file_stem()
                .and_then(|part| part.to_str())
                .unwrap_or("WSAGENT 素材")
                .chars()
                .take(36)
                .collect::<String>();
            let file_name = publish_project_media_stream(
                &root,
                &mut Cursor::new(prefix).chain(response),
                bytes,
                &stem,
                extension,
                || {
                    drop(pair.current(&storage)?);
                    Ok(())
                },
                || {
                    let lease = pair.current(&storage)?;
                    if resolve_project_media_import_root(&webview, &owner_id, &project_directory)?
                        != root
                    {
                        return Err("作品素材目录已变化，请重试".into());
                    }
                    Ok(lease)
                },
            )?;
            let file_path = root
                .join(&file_name)
                .into_os_string()
                .into_string()
                .map_err(|_| INVALID_MEDIA)?;
            Ok(MediaImport {
                file_path,
                file_name,
                mime,
                bytes,
            })
        })
        .await
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{fs, path::PathBuf};

        struct FixtureDir(PathBuf);

        impl FixtureDir {
            fn new() -> Self {
                let base = fs::canonicalize(std::env::temp_dir()).unwrap();
                let name = crate::wsagent_shared::digest(
                    &crate::secure_random::random_bytes::<32>().unwrap(),
                );
                let path = base.join(format!("wsagent-media-test-{name}"));
                fs::create_dir(&path).unwrap();
                Self(path)
            }
        }

        impl Drop for FixtureDir {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn recognizes_supported_originals_without_trusting_a_mime_label() {
            assert!(original_prefix_matches(
                "audio/wav",
                b"RIFF\x26\0\0\0WAVEfmt "
            ));
            assert!(original_prefix_matches(
                "image/avif",
                b"\0\0\0\x14ftypmif1\0\0\0\0avif"
            ));
            assert!(!original_prefix_matches(
                "image/avif",
                b"\0\0\0\x14ftypmif1avifisom"
            ));
            assert!(!original_prefix_matches(
                "image/png",
                b"<svg onload=\"alert(1)\">"
            ));
        }

        #[test]
        fn streams_once_per_content_and_cleans_incomplete_or_stale_downloads() {
            let root = FixtureDir::new();
            let original = b"fixture-original";
            let write = |bytes, still_current| {
                publish_project_media_stream(
                    &root.0,
                    &mut Cursor::new(original),
                    bytes,
                    "素材",
                    "wav",
                    || Ok(()),
                    || {
                        if still_current {
                            Ok(())
                        } else {
                            Err("scope changed".into())
                        }
                    },
                )
            };

            assert!(write(original.len() as u64 + 1, true).is_err());
            assert!(write(original.len() as u64, false).is_err());
            assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
            let name = write(original.len() as u64, true).unwrap();
            assert_eq!(fs::read(root.0.join(&name)).unwrap(), original);
            assert_eq!(write(original.len() as u64, true).unwrap(), name);
            assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
        }
    }
}

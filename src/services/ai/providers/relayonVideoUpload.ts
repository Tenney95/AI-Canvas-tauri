import { invoke } from '@tauri-apps/api/core';
import type { MediaReference, MediaReferenceKind, ProtocolJsonValue } from '../../../types/aiTypes';
import { isRemoteMediaUrl, localMediaUrlToPath } from '../../../utils/mediaUrl';
import { bytePartsToBase64, getMimeType, isTauriEnv } from '../../fs/core';
import { sha256BytesHex } from '../../mediaDataUrl';
import { getMediaReferenceUrl } from '../connectedReferenceMedia';

type UploadPart = { name: string; value: string } | { name: string; fileIndex: number; filename: string };
interface FileInfo { bytes: number; mimeType: string; sha256: string }
interface Source {
  kind: MediaReferenceKind;
  url: string;
  path?: string;
  remoteUrl?: string;
  mimeType?: string;
  dataOffset?: number;
}

export interface PreparedRelayonVideoUpload {
  references: MediaReference[];
  fingerprint(renderedBody: ProtocolJsonValue): Promise<string>;
  submit(url: string, init: RequestInit, renderedBody: ProtocolJsonValue, signal?: AbortSignal): Promise<Response>;
  release(): Promise<void>;
}

// IPC 每次只传一小块；总量取决于原文件。
const CHUNK_BYTES = 192 * 1024;
const CHUNK_BASE64_CHARS = CHUNK_BYTES / 3 * 4;

function describeSource(kind: MediaReferenceKind, url: string): Source {
  if (/^data:/i.test(url)) {
    const header = /^data:([^;,]+)(?:;[^,]*)?;base64,/i.exec(url.slice(0, 4097));
    if (!header) throw new Error('万象参考文件的 Base64 数据格式无效');
    return { kind, url, dataOffset: header[0].length, mimeType: header[1].toLowerCase() };
  }
  if (/^blob:/i.test(url)) return { kind, url };
  const path = localMediaUrlToPath(url) ?? (/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(url) ? url : undefined);
  if (path) return { kind, url, path };
  if (isRemoteMediaUrl(url)) {
    const remote = new URL(url);
    if (remote.protocol === 'https:' && !remote.username && !remote.password) return { kind, url, remoteUrl: url };
  }
  throw new Error('万象参考素材需要本地文件或可公开访问的 HTTPS 地址');
}

function* decodeDataChunks(source: Source, signal: AbortSignal): Generator<Uint8Array<ArrayBuffer>> {
  let carry = '', padded = false;
  for (let offset = source.dataOffset!; offset < source.url.length; offset += CHUNK_BASE64_CHARS) {
    signal.throwIfAborted();
    const end = offset + CHUNK_BASE64_CHARS;
    const text = carry + source.url.slice(offset, end).replace(/[\t\n\f\r ]/g, '');
    const count = end >= source.url.length ? text.length : text.length - text.length % 4;
    carry = text.slice(count);
    if (padded && text) throw new Error('万象参考文件的 Base64 数据格式无效');
    if (!count) continue;
    const part = text.slice(0, count);
    let decoded: string;
    try { decoded = atob(part); }
    catch (cause) { throw new Error('万象参考文件的 Base64 数据格式无效', { cause }); }
    padded = part.includes('=');
    yield Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }
}

function mediaType(source: Source, value: string | undefined): string {
  const mime = value?.split(';', 1)[0].trim().toLowerCase();
  if (mime?.startsWith(source.kind + '/')) return mime;
  if (!mime || mime === 'application/octet-stream') {
    const extension = (source.path ?? source.remoteUrl ?? '').split(/[?#]/, 1)[0].split('.').pop();
    const fallback = getMimeType(extension?.toLowerCase() ?? '');
    if (fallback.startsWith(source.kind + '/')) return fallback;
  }
  throw new Error('万象参考文件类型与所选素材不符');
}

async function readAsBlob(source: Source, signal: AbortSignal): Promise<Blob> {
  if (source.dataOffset !== undefined) {
    const parts: BlobPart[] = [];
    for (const chunk of decodeDataChunks(source, signal)) {
      parts.push(chunk);
      if (parts.length % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return new Blob(parts, { type: mediaType(source, source.mimeType) });
  }
  const response = await fetch(source.url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error('读取万象参考文件失败');
  const blob = await response.blob();
  const mimeType = mediaType(source, blob.type);
  return mimeType === blob.type ? blob : blob.slice(0, blob.size, mimeType);
}

async function appendBlobUrl(requestId: string, index: number, url: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal, credentials: 'omit' });
  if (!response.ok || !response.body) throw new Error('读取万象参考文件失败');
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.length; offset += CHUNK_BYTES) {
        signal.throwIfAborted();
        const chunk = bytePartsToBase64([value.subarray(offset, offset + CHUNK_BYTES)]);
        await invoke('append_relayon_video_upload', { requestId, index, chunk });
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function uploadParts(body: ProtocolJsonValue, markerIndexes: Map<string, number>): UploadPart[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('万象文件直传缺少表单字段');
  const parts: UploadPart[] = [];
  for (const [name, field] of Object.entries(body)) {
    for (const item of Array.isArray(field) ? field : [field]) {
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.hasOwn(item, '$file')) {
        const filename = typeof item.filename === 'string' ? item.filename : 'upload.bin';
        for (const marker of Array.isArray(item.$file) ? item.$file : [item.$file]) {
          const fileIndex = typeof marker === 'string' ? markerIndexes.get(marker) : undefined;
          if (fileIndex === undefined) throw new Error('万象文件字段没有对应的已准备素材');
          parts.push({ name, fileIndex, filename });
        }
      } else {
        const value = item === null ? '' : typeof item === 'object' ? JSON.stringify(item) : String(item);
        parts.push({ name, value });
      }
    }
  }
  return parts;
}

export async function prepareRelayonVideoUpload(references: readonly MediaReference[], signal?: AbortSignal): Promise<PreparedRelayonVideoUpload | undefined> {
  signal?.throwIfAborted();
  const fileKinds = new Set(references.filter((ref) => !isRemoteMediaUrl(getMediaReferenceUrl(ref))).map((ref) => ref.kind));
  if (!fileKinds.size) return;
  const sources: Source[] = [];
  const indexes = { image: new Map<string, number>(), audio: new Map<string, number>(), video: new Map<string, number>() };
  const positions = references.map((reference) => {
    if (!fileKinds.has(reference.kind)) return undefined;
    const url = getMediaReferenceUrl(reference), known = indexes[reference.kind].get(url);
    if (known !== undefined) return known;
    const index = sources.push(describeSource(reference.kind, url)) - 1;
    indexes[reference.kind].set(url, index);
    return index;
  });

  const desktop = isTauriEnv();
  const requestId = desktop ? crypto.randomUUID() : '';
  const controller = new AbortController();
  const blobs: Blob[] = [];
  const info: FileInfo[] = [];
  let nativeCleanupNeeded = false, submitted = false;
  let cleanup: Promise<void> | undefined;
  const onAbort = () => { void release(); };
  const release = (): Promise<void> => {
    if (cleanup) return cleanup;
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
    blobs.length = 0;
    // 提交的响应可能已经带回任务 ID，清理问题不能把它变成提交失败。
    cleanup = nativeCleanupNeeded ? invoke<void>('cancel_relayon_video_upload', { requestId }).catch(() => {}) : Promise.resolve();
    return cleanup;
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const active = controller.signal;
  try {
    if (desktop) {
      active.throwIfAborted();
      nativeCleanupNeeded = true;
      await invoke('prepare_relayon_video_upload', { requestId, sources: sources.map(({ kind, path, remoteUrl, mimeType }) =>
        ({ kind, path, remoteUrl, mimeType })) });
      for (const [index, source] of sources.entries()) {
        active.throwIfAborted();
        if (source.dataOffset !== undefined) {
          for (const bytes of decodeDataChunks(source, active)) {
            await invoke('append_relayon_video_upload', { requestId, index, chunk: bytePartsToBase64([bytes]) });
          }
        } else if (/^blob:/i.test(source.url)) {
          await appendBlobUrl(requestId, index, source.url, active);
        }
      }
      active.throwIfAborted();
      const sealed = await invoke<FileInfo[]>('seal_relayon_video_upload', { requestId });
      if (sealed.length !== sources.length || sealed.some((file, i) => !Number.isSafeInteger(file.bytes) || file.bytes <= 0
        || !/^[a-f0-9]{64}$/.test(file.sha256) || mediaType(sources[i], file.mimeType) !== file.mimeType)) {
        throw new Error('万象参考文件没有完整的内容摘要');
      }
      info.push(...sealed);
    } else {
      for (const source of sources) {
        active.throwIfAborted();
        const blob = await readAsBlob(source, active);
        if (blob.size === 0) throw new Error('万象参考文件为空');
        blobs.push(blob);
        info.push({ bytes: blob.size, mimeType: blob.type, sha256: '' });
      }
    }
    active.throwIfAborted();
    const markers = info.map((file, index) => `relayon-file:${index}:${file.mimeType}`);
    const markerIndexes = new Map(markers.map((value, index) => [value, index]));
    return {
      references: references.map((ref, index) => {
        const position = positions[index];
        return position === undefined ? { ...ref, url: getMediaReferenceUrl(ref) }
          : { ...ref, url: markers[position], sourceUrl: undefined, filePath: undefined };
      }),
      release,
      async fingerprint(body) {
        active.throwIfAborted();
        if (submitted) throw new Error('万象视频请求已经提交');
        const fields = [];
        for (const part of uploadParts(body, markerIndexes)) {
          if ('value' in part) fields.push([part.name, 'text', part.value]);
          else {
            const file = info[part.fileIndex];
            // 桌面直接采用原生快照摘要；Web 仅在调用方要取指纹时才读取 Blob。
            if (!file.sha256) file.sha256 = await sha256BytesHex(new Uint8Array(await blobs[part.fileIndex].arrayBuffer()));
            fields.push([part.name, 'file', part.filename, file.mimeType, file.bytes, file.sha256]);
          }
          active.throwIfAborted();
        }
        return sha256BytesHex(new TextEncoder().encode(JSON.stringify(['relayon-video-upload-v1', fields])));
      },
      async submit(url, init, body, sendSignal) {
        active.throwIfAborted();
        sendSignal?.throwIfAborted();
        if (submitted) throw new Error('万象视频请求已经提交');
        const parts = uploadParts(body, markerIndexes);
        const headers = new Headers(init.headers);
        headers.delete('Content-Type');
        headers.delete('Content-Length');
        submitted = true;
        sendSignal?.addEventListener('abort', onAbort, { once: true });
        try {
          if (desktop) {
            const pairs: [string, string][] = [];
            headers.forEach((value, key) => pairs.push([key, value]));
            const response = await invoke<{ status: number; body: string; headers?: [string, string][] }>(
              'submit_relayon_video_upload', { requestId, url, headers: pairs, parts });
            // 收到 HTTP 响应时，原生端已经回收了这次快照。
            nativeCleanupNeeded = false;
            return new Response([204, 205, 304].includes(response.status) ? null : response.body,
              { status: response.status, headers: response.headers });
          }
          const form = new FormData();
          for (const part of parts) {
            if ('value' in part) form.append(part.name, part.value);
            else form.append(part.name, blobs[part.fileIndex], part.filename);
          }
          const response = await fetch(url, { ...init, headers, body: form, credentials: 'omit',
            signal: sendSignal ? AbortSignal.any([active, sendSignal]) : active, redirect: 'error' });
          // 上传结束就放掉文件，让调用方继续读取响应里的任务 ID。
          blobs.length = 0;
          return response;
        } finally {
          sendSignal?.removeEventListener('abort', onAbort);
        }
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}

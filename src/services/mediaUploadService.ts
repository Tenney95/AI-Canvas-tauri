/** 上传字节逐块落盘；摘要、文件头和会话身份留在内存，正文不进入 Store。 */
import { open, writeFile, stat, rename, remove } from '@tauri-apps/plugin-fs';
import { ensureProjectDataDir, getAssetUrlFromPath, joinPath, notifyProjectDiskChanged } from './fs/core';
import { sha256BytesHex } from './mediaDataUrl';
import { parseRasterImageDimensions } from './rasterImageDimensions';
import { useAppStore } from '../store/useAppStore';
import type { MediaUploadContext, MediaUploadInput } from '../types/mediaUpload';

export const MEDIA_UPLOAD_CHUNK_BYTES = 256 * 1024;
export const MEDIA_UPLOAD_BASE64_CHARS = Math.ceil(MEDIA_UPLOAD_CHUNK_BYTES / 3) * 4;
const IDLE_MS = 10 * 60 * 1000;
const HEADER_BYTES = 1024 * 1024;
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
const HEX = /^[a-f0-9]{64}$/;
type Phase = 'receiving' | 'ready' | 'reserved';
interface Transfer {
  id: string;
  projectId: string;
  conversationId: string;
  revision: number;
  storageRoot: string;
  fileName: string;
  mimeType: keyof typeof MIME_EXT;
  totalBytes: number;
  received: number;
  digest: string;
  header: Uint8Array;
  path: string;
  phase: Phase;
  last?: { offset: number; size: number; checksum: string };
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<unknown>;
  cancelled: boolean;
}
const transfers = new Map<string, Transfer>();

export class MediaUploadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
function fail(code: string, message: string): never { throw new MediaUploadError(code, message); }
function fresh(context: MediaUploadContext, transfer?: Transfer): void {
  const state = useAppStore.getState();
  if (context.signal.aborted || transfer?.cancelled) fail('UPLOAD_CANCELLED', '上传已取消');
  if (state.currentProjectId !== context.projectId
    || (context.baseRevision !== undefined && state.getCurrentRevision() !== context.baseRevision)
    || (transfer && (transfer.projectId !== context.projectId || transfer.conversationId !== context.conversationId
      || transfer.revision !== state.getCurrentRevision()))) fail('UPLOAD_CONTEXT_CHANGED', '上传所属项目、对话或画布已变化');
  if (transfer && transfer.storageRoot !== (state.config.baseDataDir ?? '')) fail('UPLOAD_STORAGE_CHANGED', '上传期间项目存储设置已变化');
}
async function discard(transfer: Transfer): Promise<void> {
  transfer.cancelled = true;
  clearTimeout(transfer.timer);
  await transfer.pending?.catch(() => undefined);
  if (transfers.get(transfer.id) !== transfer) return;
  transfers.delete(transfer.id);
  transfer.header = new Uint8Array();
  // 只清理本服务随机命名、尚未交付的文件；不递归删除、不接受外部路径。
  await remove(transfer.path).catch(() => undefined);
}
function touch(transfer: Transfer): void {
  clearTimeout(transfer.timer);
  transfer.expiresAt = Date.now() + IDLE_MS;
  transfer.timer = setTimeout(() => { void discard(transfer); }, IDLE_MS);
}
function lookup(context: MediaUploadContext, id: string | undefined, checkRevision = true): Transfer {
  const transfer = id ? transfers.get(id) : undefined;
  if (!transfer || transfer.projectId !== context.projectId || transfer.conversationId !== context.conversationId) {
    fail('UPLOAD_NOT_FOUND', '上传不存在、已消费或不属于当前对话');
  }
  if (transfer.expiresAt <= Date.now()) { void discard(transfer); fail('UPLOAD_EXPIRED', '上传已过期'); }
  if (checkRevision) fresh(context, transfer);
  return transfer;
}
function snapshot(transfer: Transfer) {
  return { uploadId: transfer.id, state: transfer.phase, totalBytes: transfer.totalBytes,
    receivedBytes: transfer.received, nextOffset: transfer.received, chunkBytes: MEDIA_UPLOAD_CHUNK_BYTES,
    checksumAlgorithm: 'sha256-chain-v1', digest: transfer.digest, expiresAt: transfer.expiresAt,
    stale: transfer.revision !== useAppStore.getState().getCurrentRevision() };
}
async function textDigest(value: string): Promise<string> { return sha256BytesHex(new TextEncoder().encode(value)); }
/** H0 = SHA256(UTF8('AI-Canvas-upload-v1:' + MIME + ':' + totalBytes)). */
export function mediaUploadInitialDigest(mimeType: string, totalBytes: number): Promise<string> {
  return textDigest(`AI-Canvas-upload-v1:${mimeType}:${totalBytes}`);
}
/** Hn = SHA256(UTF8(Hn-1 + ':' + offset + ':' + SHA256(chunk))). 固定块长使摘要可重现。 */
export function mediaUploadNextDigest(previous: string, offset: number, checksum: string): Promise<string> {
  return textDigest(`${previous}:${offset}:${checksum}`);
}
function checksum(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HEX.test(value)) fail('UPLOAD_CHECKSUM_INVALID', '需要小写十六进制 SHA-256 摘要');
}
function decode(data: unknown): Uint8Array {
  if (typeof data !== 'string' || !data.length || data.length > MEDIA_UPLOAD_BASE64_CHARS
    || data.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    fail('UPLOAD_CHUNK_INVALID', '上传块不是有效的有界 Base64');
  }
  const binary = atob(data);
  if (btoa(binary) !== data || binary.length > MEDIA_UPLOAD_CHUNK_BYTES) fail('UPLOAD_CHUNK_INVALID', '上传块编码或长度无效');
  return Uint8Array.from(binary, (value) => value.charCodeAt(0));
}
function validateHeader(transfer: Transfer): void {
  const bytes = transfer.header;
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  const png = bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
    && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8) === 13 && ascii(12, 4) === 'IHDR';
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP'
    && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 === transfer.totalBytes;
  if (!({ 'image/png': png, 'image/jpeg': jpeg, 'image/webp': webp }[transfer.mimeType])
    || !parseRasterImageDimensions(bytes)) fail('UPLOAD_IMAGE_INVALID', '图片文件头、MIME 或尺寸信息无效');
}
async function exclusive<T>(transfer: Transfer, run: () => Promise<T>): Promise<T> {
  if (transfer.pending) fail('UPLOAD_BUSY', '当前上传正在写入，请先查询状态');
  const pending = run();
  transfer.pending = pending;
  try { return await pending; } finally { if (transfer.pending === pending) transfer.pending = undefined; }
}

/** 固定大小读回落盘内容，不把完整文件载入内存，也不把内存摘要冒充磁盘验证。 */
async function verifyStoredBytes(context: MediaUploadContext, transfer: Transfer): Promise<void> {
  const file = await open(transfer.path, { read: true });
  try {
    let offset = 0;
    let digest = await mediaUploadInitialDigest(transfer.mimeType, transfer.totalBytes);
    while (offset < transfer.totalBytes) {
      fresh(context, transfer);
      const bytes = new Uint8Array(Math.min(MEDIA_UPLOAD_CHUNK_BYTES, transfer.totalBytes - offset));
      let filled = 0;
      while (filled < bytes.length) {
        const count = await file.read(bytes.subarray(filled));
        if (!count) fail('UPLOAD_SIZE_CHANGED', '暂存文件内容不完整');
        filled += count;
        fresh(context, transfer);
      }
      digest = await mediaUploadNextDigest(digest, offset, await sha256BytesHex(bytes));
      offset += bytes.length;
    }
    if (digest !== transfer.digest || (await stat(transfer.path)).size !== transfer.totalBytes) {
      fail('UPLOAD_CHECKSUM_MISMATCH', '落盘图片与上传摘要不一致');
    }
  } finally { await file.close(); }
}

export async function executeMediaUpload(context: MediaUploadContext, input: MediaUploadInput) {
  fresh(context);
  if (input.action === 'begin') {
    if (!input.fileName?.trim() || /[\\/\0\r\n]/.test(input.fileName) || input.fileName.length > 180
      || !input.mimeType || !Object.hasOwn(MIME_EXT, input.mimeType)
      || !Number.isSafeInteger(input.totalBytes) || input.totalBytes! < 1) fail('UPLOAD_METADATA_INVALID', '需要有效的显示文件名、图片 MIME 和正整数文件字节数');
    const storageRoot = useAppStore.getState().config.baseDataDir ?? '';
    const root = await ensureProjectDataDir(context.projectId);
    fresh(context);
    if (!root) fail('UPLOAD_STORAGE_UNAVAILABLE', '项目存储目录不可用');
    const id = crypto.randomUUID();
    const transfer: Transfer = { id, projectId: context.projectId, conversationId: context.conversationId,
      revision: useAppStore.getState().getCurrentRevision(), storageRoot,
      fileName: input.fileName, mimeType: input.mimeType,
      totalBytes: input.totalBytes!, received: 0, digest: await mediaUploadInitialDigest(input.mimeType, input.totalBytes!),
      header: new Uint8Array(), path: joinPath(root, `mcp-upload-${id}.part`), phase: 'receiving',
      expiresAt: 0, cancelled: false };
    fresh(context);
    try { await writeFile(transfer.path, new Uint8Array(), { createNew: true }); }
    catch { fail('UPLOAD_STORAGE_FAILED', '创建上传文件失败，请检查项目磁盘空间与写入权限'); }
    transfers.set(id, transfer);
    touch(transfer);
    try { fresh(context, transfer); } catch (error) { await discard(transfer); throw error; }
    return snapshot(transfer);
  }
  const transfer = lookup(context, input.uploadId, input.action !== 'status' && input.action !== 'cancel');
  if (input.action === 'cancel') {
    if (transfer.phase === 'reserved') fail('UPLOAD_BUSY', '图片正在导入，不能取消上传');
    await discard(transfer);
    return { uploadId: transfer.id, state: 'cancelled' };
  }
  if (input.action === 'status') return snapshot(transfer);
  if (input.action !== 'append' && input.action !== 'finish') fail('UPLOAD_ACTION_INVALID', '上传操作无效');
  return exclusive(transfer, async () => {
    fresh(context, transfer);
    checksum(input.checksum);
    if (input.action === 'finish') {
      if (transfer.phase === 'reserved') fail('UPLOAD_BUSY', '图片正在导入');
      if (transfer.received !== transfer.totalBytes || transfer.digest !== input.checksum) fail('UPLOAD_INCOMPLETE', '上传尚未完成或最终分块摘要不匹配');
      if (transfer.phase === 'ready') return snapshot(transfer);
      validateHeader(transfer);
      try {
        if ((await stat(transfer.path)).size !== transfer.received) fail('UPLOAD_SIZE_CHANGED', '暂存文件大小已变化');
        await verifyStoredBytes(context, transfer);
        fresh(context, transfer);
        const target = transfer.path.replace(/\.part$/, `.${MIME_EXT[transfer.mimeType]}`);
        await rename(transfer.path, target);
        transfer.path = target;
        fresh(context, transfer);
      } catch (error) {
        if (error instanceof MediaUploadError) throw error;
        fail('UPLOAD_STORAGE_FAILED', '完成上传失败，请检查项目磁盘空间与写入权限');
      }
      transfer.phase = 'ready';
      touch(transfer);
      return snapshot(transfer);
    }
    if (transfer.phase !== 'receiving') fail('UPLOAD_STATE_INVALID', '上传已完成，不能继续追加');
    const bytes = decode(input.data);
    if (!Number.isSafeInteger(input.offset) || input.offset! < 0) fail('UPLOAD_OFFSET_INVALID', '上传偏移必须是非负整数');
    const digest = await sha256BytesHex(bytes);
    fresh(context, transfer);
    if (digest !== input.checksum) fail('UPLOAD_CHECKSUM_MISMATCH', '上传块摘要不匹配');
    const last = transfer.last;
    if (last && input.offset === last.offset && bytes.length === last.size && digest === last.checksum) {
      touch(transfer); return snapshot(transfer);
    }
    if (input.offset !== transfer.received || bytes.length !== Math.min(MEDIA_UPLOAD_CHUNK_BYTES, transfer.totalBytes - transfer.received)) {
      fail('UPLOAD_OFFSET_INVALID', '上传块错序、超出声明大小或块长度不正确，请查询 nextOffset');
    }
    const nextDigest = await mediaUploadNextDigest(transfer.digest, transfer.received, digest);
    fresh(context, transfer);
    try {
      if ((await stat(transfer.path)).size !== transfer.received) fail('UPLOAD_SIZE_CHANGED', '暂存文件大小已变化');
      fresh(context, transfer);
      await writeFile(transfer.path, bytes, { append: true, create: false });
    } catch (error) {
      if (error instanceof MediaUploadError) throw error;
      fail('UPLOAD_STORAGE_FAILED', '写入上传块失败，请检查项目磁盘空间与写入权限');
    }
    // 写入完成后先记录实际偏移，取消或上下文变化也不能重复追加同一块。
    transfer.last = { offset: transfer.received, size: bytes.length, checksum: digest };
    transfer.received += bytes.length;
    transfer.digest = nextDigest;
    if (transfer.header.length < HEADER_BYTES) {
      const add = bytes.subarray(0, HEADER_BYTES - transfer.header.length);
      const header = new Uint8Array(transfer.header.length + add.length);
      header.set(transfer.header); header.set(add, transfer.header.length); transfer.header = header;
    }
    touch(transfer);
    fresh(context, transfer);
    return snapshot(transfer);
  });
}

/** 同批校验后一次领取；路径仅返回给宿主导入服务，永不放入 MCP 结果。 */
export async function reserveUploadedMedia(context: MediaUploadContext, ids: string[]) {
  if (new Set(ids).size !== ids.length) fail('UPLOAD_DUPLICATE', '同一批不能重复导入同一个上传');
  const selected = ids.map((id) => lookup(context, id));
  for (const transfer of selected) if (transfer.phase !== 'ready' || transfer.pending) fail('UPLOAD_NOT_READY', '图片尚未上传完成或正在使用');
  for (const transfer of selected) { transfer.phase = 'reserved'; clearTimeout(transfer.timer); }
  try {
    const result = await Promise.all(selected.map(async (transfer) => {
      if ((await stat(transfer.path)).size !== transfer.totalBytes) fail('UPLOAD_SIZE_CHANGED', '上传图片不存在或大小已变化');
      return { uploadId: transfer.id, filePath: transfer.path, assetUrl: await getAssetUrlFromPath(transfer.path),
        fileName: transfer.path.split(/[\\/]/).pop()!, label: transfer.fileName };
    }));
    for (const transfer of selected) fresh(context, transfer);
    return result;
  } catch (error) { settleUploadedMedia(ids, false); throw error; }
}
export function settleUploadedMedia(ids: string[], committed: boolean): void {
  for (const id of ids) {
    const transfer = transfers.get(id);
    if (!transfer || transfer.phase !== 'reserved') continue;
    if (committed) { clearTimeout(transfer.timer); transfers.delete(id); transfer.header = new Uint8Array(); }
    else { transfer.phase = 'ready'; touch(transfer); }
  }
  if (committed && ids.length) notifyProjectDiskChanged();
}
export async function clearMediaUploads(): Promise<void> { await Promise.all([...transfers.values()].map(discard)); }
if (import.meta.hot) import.meta.hot.dispose(() => { void clearMediaUploads(); });

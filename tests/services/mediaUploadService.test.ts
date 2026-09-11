import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { useAppStore } from '../../src/store/useAppStore';
import { clearMediaUploads, executeMediaUpload, MEDIA_UPLOAD_CHUNK_BYTES,
  reserveUploadedMedia, settleUploadedMedia } from '../../src/services/mediaUploadService';
import type { MediaUploadContext, MediaUploadInput } from '../../src/types/mediaUpload';

const fs = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), write: vi.fn(), stat: vi.fn(),
  open: vi.fn(), close: vi.fn(), rename: vi.fn(), remove: vi.fn(), notify: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: fs.write, stat: fs.stat, open: fs.open,
  rename: fs.rename, remove: fs.remove }));
vi.mock('../../src/services/fs/core', () => ({
  ensureProjectDataDir: vi.fn(async () => '/project'), joinPath: (...parts: string[]) => parts.join('/'),
  getAssetUrlFromPath: vi.fn(async (path: string) => `asset://${path}`), notifyProjectDiskChanged: fs.notify,
}));
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function context(): MediaUploadContext {
  return { projectId: 'p1', conversationId: 'mcp-control-test',
    baseRevision: useAppStore.getState().getCurrentRevision(), signal: new AbortController().signal };
}
const run = (input: MediaUploadInput, ctx = context()) => executeMediaUpload(ctx, input);
// Real 1x1 PNG; trailing bytes exercise bounded streaming, not decoder acceptance.
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jlpEAAAAASUVORK5CYII=', 'base64'));
async function begin(totalBytes = png.length) {
  const result = await run({ action: 'begin', fileName: '生成图片.png', mimeType: 'image/png', totalBytes });
  if (!('digest' in result)) throw new Error('Expected upload snapshot');
  return result;
}
async function append(uploadId: string, bytes: Uint8Array, offset: number) {
  return run({ action: 'append', uploadId, offset, data: Buffer.from(bytes).toString('base64'), checksum: hash(bytes) });
}
async function ready(bytes = png) {
  const started = await begin(bytes.length);
  let digest = hash(`AI-Canvas-upload-v1:image/png:${bytes.length}`);
  expect(started.digest).toBe(digest);
  for (let offset = 0; offset < bytes.length; offset += MEDIA_UPLOAD_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + MEDIA_UPLOAD_CHUNK_BYTES);
    digest = hash(`${digest}:${offset}:${hash(chunk)}`);
    await append(started.uploadId, chunk, offset);
  }
  const finished = await run({ action: 'finish', uploadId: started.uploadId, checksum: digest });
  expect(finished).toMatchObject({ state: 'ready', digest });
  return started.uploadId;
}

beforeEach(() => {
  vi.clearAllMocks(); fs.files.clear();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'p1' });
  fs.write.mockImplementation(async (path: string, bytes: Uint8Array, options: { append?: boolean; createNew?: boolean }) => {
    if (options.createNew && fs.files.has(path)) throw new Error('exists');
    const previous = options.append ? fs.files.get(path)! : new Uint8Array();
    const next = new Uint8Array(previous.length + bytes.length);
    next.set(previous); next.set(bytes, previous.length); fs.files.set(path, next);
  });
  fs.stat.mockImplementation(async (path: string) => ({ size: fs.files.get(path)!.length }));
  fs.remove.mockImplementation(async (path: string) => { fs.files.delete(path); });
  fs.rename.mockImplementation(async (from: string, to: string) => { fs.files.set(to, fs.files.get(from)!); fs.files.delete(from); });
  fs.open.mockImplementation(async (path: string) => {
    let offset = 0;
    return { close: fs.close, read: async (target: Uint8Array) => {
      const bytes = fs.files.get(path)!;
      const count = Math.min(target.length, bytes.length - offset, 12345);
      target.set(bytes.subarray(offset, offset + count)); offset += count; return count || null;
    } };
  });
});
afterEach(async () => { await clearMediaUploads(); vi.useRealTimers(); });

describe('MCP streamed media upload', () => {
  it('accepts a declared multi-gigabyte file without allocating it or adding a total size cap', async () => {
    expect(await begin(10 * 1024 ** 3)).toMatchObject({ totalBytes: 10 * 1024 ** 3, receivedBytes: 0 });
    expect([...fs.files.values()][0]).toHaveLength(0);
    expect(fs.write.mock.calls[0][1]).toHaveLength(0);
  });

  it('streams full chunks and a tail, independently verifies the disk digest with partial reads, and consumes once', async () => {
    const bytes = new Uint8Array(MEDIA_UPLOAD_CHUNK_BYTES * 2 + 71); bytes.set(png);
    const id = await ready(bytes);
    expect(fs.write.mock.calls.map((call) => call[1].length)).toEqual([0, MEDIA_UPLOAD_CHUNK_BYTES, MEDIA_UPLOAD_CHUNK_BYTES, 71]);
    expect(fs.close).toHaveBeenCalledOnce();
    const [saved] = await reserveUploadedMedia(context(), [id]);
    expect(fs.files.get(saved.filePath)).toEqual(bytes);
    settleUploadedMedia([id], true);
    await expect(reserveUploadedMedia(context(), [id])).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
    await clearMediaUploads();
    expect(fs.files.has(saved.filePath)).toBe(true);
    expect(fs.notify).toHaveBeenCalledOnce();
  });

  it('makes only an identical last-block resend idempotent', async () => {
    const { uploadId } = await begin();
    const first = await append(uploadId, png, 0);
    const second = await append(uploadId, png, 0);
    // 每次写入都会续期，expiresAt 本就会前进；幂等比较只针对真正的上传状态。
    const { expiresAt: _firstExpiry, ...firstState } = first;
    expect(second).toMatchObject(firstState);
    expect(second.expiresAt).toBeGreaterThanOrEqual(first.expiresAt);
    expect(fs.write).toHaveBeenCalledTimes(2);
    const altered = png.slice(); altered[40] ^= 1;
    await expect(append(uploadId, altered, 0)).rejects.toMatchObject({ code: 'UPLOAD_OFFSET_INVALID' });
  });

  it('rejects invalid encoding, checksum, short blocks and out-of-order offsets before writing', async () => {
    const { uploadId } = await begin(MEDIA_UPLOAD_CHUNK_BYTES + png.length);
    await expect(run({ action: 'append', uploadId, data: '!!!!', offset: 0, checksum: hash(png) })).rejects.toMatchObject({ code: 'UPLOAD_CHUNK_INVALID' });
    await expect(run({ action: 'append', uploadId, data: Buffer.from(png).toString('base64'), offset: 0, checksum: '0'.repeat(64) })).rejects.toMatchObject({ code: 'UPLOAD_CHECKSUM_MISMATCH' });
    await expect(append(uploadId, png, 0)).rejects.toMatchObject({ code: 'UPLOAD_OFFSET_INVALID' });
    await expect(append(uploadId, png, MEDIA_UPLOAD_CHUNK_BYTES)).rejects.toMatchObject({ code: 'UPLOAD_OFFSET_INVALID' });
    expect(fs.write).toHaveBeenCalledOnce();
  });

  it('rejects incomplete data, wrong final digest and mismatched image MIME', async () => {
    const started = await begin();
    await expect(run({ action: 'finish', uploadId: started.uploadId, checksum: started.digest })).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' });
    await append(started.uploadId, png, 0);
    await expect(run({ action: 'finish', uploadId: started.uploadId, checksum: '0'.repeat(64) })).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' });
    const other = await run({ action: 'begin', fileName: 'wrong.jpg', mimeType: 'image/jpeg', totalBytes: png.length });
    const result = await append(other.uploadId, png, 0);
    if (!('digest' in result)) throw new Error('Expected digest');
    await expect(run({ action: 'finish', uploadId: other.uploadId, checksum: result.digest })).rejects.toMatchObject({ code: 'UPLOAD_IMAGE_INVALID' });
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it('detects same-size on-disk corruption instead of trusting the received digest', async () => {
    const started = await begin();
    const result = await append(started.uploadId, png, 0);
    if (!('digest' in result)) throw new Error('Expected digest');
    [...fs.files.values()][0][40] ^= 1;
    await expect(run({ action: 'finish', uploadId: started.uploadId, checksum: result.digest })).rejects.toMatchObject({ code: 'UPLOAD_CHECKSUM_MISMATCH' });
    expect(fs.close).toHaveBeenCalledOnce();
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it('binds uploads to the project and conversation, and permits status/cancel after a revision change', async () => {
    const { uploadId } = await begin();
    await expect(run({ action: 'status', uploadId }, { ...context(), conversationId: 'other' })).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
    useAppStore.setState({ currentProjectId: 'p2' });
    await expect(run({ action: 'status', uploadId })).rejects.toMatchObject({ code: 'UPLOAD_CONTEXT_CHANGED' });
    useAppStore.setState({ currentProjectId: 'p1' });
    useAppStore.getState().incrementRevision();
    await expect(append(uploadId, png, 0)).rejects.toMatchObject({ code: 'UPLOAD_CONTEXT_CHANGED' });
    expect(await run({ action: 'status', uploadId })).toMatchObject({ stale: true });
    expect(await run({ action: 'cancel', uploadId })).toMatchObject({ state: 'cancelled' });
    expect(fs.files.size).toBe(0);
  });

  it('rejects changes to project storage and supports explicit cleanup', async () => {
    const { uploadId } = await begin();
    useAppStore.setState({ config: { ...useAppStore.getState().config, baseDataDir: '/different' } });
    await expect(append(uploadId, png, 0)).rejects.toMatchObject({ code: 'UPLOAD_STORAGE_CHANGED' });
    await run({ action: 'cancel', uploadId });
    expect(fs.files.size).toBe(0);
  });

  it('cleans idle transfers while leaving a committed image intact', async () => {
    vi.useFakeTimers();
    const id = await ready();
    const [saved] = await reserveUploadedMedia(context(), [id]); settleUploadedMedia([id], true);
    const pending = await begin();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    expect(fs.files.size).toBe(1);
    expect(fs.files.has(saved.filePath)).toBe(true);
    await expect(run({ action: 'status', uploadId: pending.uploadId })).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
  });

  it('reserves batches atomically and releases failed imports for another explicit attempt', async () => {
    const id = await ready(); const pending = await begin();
    await expect(reserveUploadedMedia(context(), [id, id])).rejects.toMatchObject({ code: 'UPLOAD_DUPLICATE' });
    await expect(reserveUploadedMedia(context(), [id, pending.uploadId])).rejects.toMatchObject({ code: 'UPLOAD_NOT_READY' });
    expect(await run({ action: 'status', uploadId: id })).toMatchObject({ state: 'ready' });
    await reserveUploadedMedia(context(), [id]);
    await expect(run({ action: 'cancel', uploadId: id })).rejects.toMatchObject({ code: 'UPLOAD_BUSY' });
    settleUploadedMedia([id], false);
    await expect(reserveUploadedMedia(context(), [id])).resolves.toHaveLength(1);
    settleUploadedMedia([id], false);
  });

  it('does not retry failed writes or reveal filesystem diagnostics', async () => {
    const { uploadId } = await begin();
    fs.write.mockRejectedValueOnce(new Error('sensitive /private/path.png'));
    await expect(append(uploadId, png, 0)).rejects.toMatchObject({ code: 'UPLOAD_STORAGE_FAILED', message: expect.not.stringContaining('/private') });
    expect(fs.write).toHaveBeenCalledTimes(2);
    const result = await run({ action: 'status', uploadId });
    expect(result).toMatchObject({ receivedBytes: 0 });
    expect(JSON.stringify(result)).not.toContain('/project');
  });

  it('waits for an in-flight write before cancellation deletes its exact temporary file', async () => {
    const { uploadId } = await begin();
    let release!: () => void;
    const nativeWrite = fs.write.getMockImplementation()!;
    fs.write.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { release = resolve; });
      await nativeWrite(...args);
    });
    const pending = append(uploadId, png, 0);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'UPLOAD_CANCELLED' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const cancellation = run({ action: 'cancel', uploadId });
    expect(fs.remove).not.toHaveBeenCalled();
    release();
    await rejected;
    await expect(cancellation).resolves.toMatchObject({ state: 'cancelled' });
    expect(fs.files.size).toBe(0);
    expect(fs.remove).toHaveBeenCalledOnce();
  });
});

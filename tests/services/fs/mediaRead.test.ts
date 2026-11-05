/**
 * mediaRead — 回归测试：bounded original media file reader。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SeekMode } from '@tauri-apps/plugin-fs';

const driver = vi.hoisted(() => ({
  bytes: new Uint8Array(1), position: 0, shortRead: Infinity,
  isFile: true, isSymlink: false, mtime: 1, desktop: true,
  open: vi.fn(), lstat: vi.fn(), handleStat: vi.fn(), close: vi.fn(), seek: vi.fn(), read: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/plugin-fs')>(),
  open: driver.open, lstat: driver.lstat,
}));
vi.mock('../../../src/services/fs/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/fs/core')>(),
  isTauriEnv: () => driver.desktop,
}));

import { MEDIA_READ_CHUNK_BYTES, MediaFileReadError, openMediaFileReader } from '../../../src/services/fs/mediaRead';

const path = '/managed/原视频.mp4';
function info() {
  return { isFile: driver.isFile, isSymlink: driver.isSymlink, size: driver.bytes.length, mtime: new Date(driver.mtime) };
}
beforeEach(() => {
  driver.bytes = Uint8Array.from({ length: MEDIA_READ_CHUNK_BYTES + 17 }, (_, index) => index % 251);
  driver.position = 0; driver.shortRead = Infinity;
  driver.isFile = true; driver.isSymlink = false; driver.mtime = 1; driver.desktop = true;
  driver.lstat.mockReset().mockImplementation(async () => info());
  driver.handleStat.mockReset().mockImplementation(async () => info());
  driver.close.mockReset().mockResolvedValue(undefined);
  driver.seek.mockReset().mockImplementation(async (offset: number) => { driver.position = offset; return offset; });
  driver.read.mockReset().mockImplementation(async (buffer: Uint8Array) => {
    const count = Math.min(buffer.length, driver.bytes.length - driver.position, driver.shortRead);
    buffer.set(driver.bytes.subarray(driver.position, driver.position + count));
    driver.position += count;
    return count || null;
  });
  driver.open.mockReset().mockResolvedValue({
    read: driver.read, seek: driver.seek, stat: driver.handleStat, close: driver.close,
  });
});

describe('bounded original media file reader', () => {
  it('reads contiguous chunks and EOF without seeking, while retaining file checks', async () => {
    const reader = await openMediaFileReader(path);
    const initialChecks = driver.handleStat.mock.calls.length;
    expect(await reader.read(0)).toEqual(driver.bytes.slice(0, MEDIA_READ_CHUNK_BYTES));
    expect(await reader.read(MEDIA_READ_CHUNK_BYTES)).toEqual(driver.bytes.slice(MEDIA_READ_CHUNK_BYTES));
    expect(await reader.read(driver.bytes.length)).toHaveLength(0);
    expect(driver.seek).not.toHaveBeenCalled();
    expect(driver.handleStat.mock.calls.length - initialChecks).toBe(6);
    await reader.close();
  });

  it('seeks only for random or repeated offsets and tracks positions across short reads', async () => {
    driver.shortRead = 4093;
    const reader = await openMediaFileReader(path);
    expect(await reader.read(5)).toEqual(driver.bytes.slice(5, 5 + MEDIA_READ_CHUNK_BYTES));
    expect(await reader.read(5 + MEDIA_READ_CHUNK_BYTES)).toEqual(driver.bytes.slice(5 + MEDIA_READ_CHUNK_BYTES));
    expect(await reader.read(5)).toEqual(driver.bytes.slice(5, 5 + MEDIA_READ_CHUNK_BYTES));
    expect(driver.seek.mock.calls).toEqual([[5, SeekMode.Start], [5, SeekMode.Start]]);
    await reader.close();
  });

  it('closes the file when a required random seek returns the wrong position', async () => {
    const reader = await openMediaFileReader(path);
    driver.seek.mockResolvedValueOnce(4);
    await expect(reader.read(5)).rejects.toMatchObject({ code: 'MEDIA_READ_FAILED' });
    expect(driver.read).not.toHaveBeenCalled();
    expect(driver.close).toHaveBeenCalledOnce();
  });

  it('preserves every byte across short reads, repeated offsets, tail chunks and an empty EOF chunk', async () => {
    driver.shortRead = 4093;
    const reader = await openMediaFileReader(path);
    expect(reader.metadata).toEqual({ fileName: '原视频.mp4', mimeType: 'video/mp4', totalBytes: driver.bytes.length, modifiedAt: 1 });
    const first = await reader.read(0);
    const tail = await reader.read(first.length);
    expect(first).toEqual(driver.bytes.slice(0, MEDIA_READ_CHUNK_BYTES));
    expect(tail).toEqual(driver.bytes.slice(MEDIA_READ_CHUNK_BYTES));
    expect(await reader.read(0)).toEqual(first);
    expect(await reader.read(driver.bytes.length)).toHaveLength(0);
    expect(driver.seek).toHaveBeenCalledWith(0, SeekMode.Start);
    expect(driver.read.mock.calls.every(([buffer]) => (buffer as Uint8Array).byteLength <= MEDIA_READ_CHUNK_BYTES)).toBe(true);
    await reader.close(); await reader.close();
    expect(driver.close).toHaveBeenCalledOnce();
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, MEDIA_READ_CHUNK_BYTES + 18])(
    'rejects invalid offset %s and closes the handle', async (offset) => {
      const reader = await openMediaFileReader(path);
      await expect(reader.read(offset)).rejects.toMatchObject({ code: 'MEDIA_READ_OFFSET_INVALID' });
      expect(driver.read).not.toHaveBeenCalled();
      expect(driver.close).toHaveBeenCalledOnce();
      await expect(reader.read(0)).rejects.toMatchObject({ code: 'MEDIA_READ_CLOSED' });
      expect(driver.close).toHaveBeenCalledOnce();
    },
  );

  it.each(['/managed/../private.png', '/managed/./image.png', '/managed/.. ./image.png', 'relative/image.png', '/managed/image.png:stream', '/managed/', 'file:///managed/image.png'])(
    'rejects traversal or non-file path %s before filesystem access', async (invalid) => {
      await expect(openMediaFileReader(invalid)).rejects.toMatchObject({ code: 'MEDIA_READ_PATH_INVALID' });
      expect(driver.lstat).not.toHaveBeenCalled();
      expect(driver.open).not.toHaveBeenCalled();
    },
  );

  it('rejects empty files, directories and symbolic links before opening a handle', async () => {
    driver.bytes = new Uint8Array();
    await expect(openMediaFileReader(path)).rejects.toMatchObject({ code: 'MEDIA_READ_EMPTY' });
    driver.bytes = new Uint8Array([1]); driver.isFile = false;
    await expect(openMediaFileReader(path)).rejects.toMatchObject({ code: 'MEDIA_READ_NOT_FILE' });
    driver.isFile = true; driver.isSymlink = true;
    await expect(openMediaFileReader(path)).rejects.toMatchObject({ code: 'MEDIA_READ_NOT_FILE' });
    expect(driver.open).not.toHaveBeenCalled();
  });

  it.each(['/managed/file.json', '/managed/file.bin', '/managed/file.tiff'])('rejects unsupported media %s', async (invalid) => {
    await expect(openMediaFileReader(invalid)).rejects.toMatchObject({ code: 'MEDIA_READ_TYPE_UNSUPPORTED' });
    expect(driver.open).not.toHaveBeenCalled();
  });

  it('returns only a safe basename and preserves image/audio MIME without converting bytes', async () => {
    const image = await openMediaFileReader('/managed/原图\n?.png');
    expect(image.metadata).toMatchObject({ fileName: '原图__.png', mimeType: 'image/png' });
    await image.close();
    const audio = await openMediaFileReader('C:\\managed\\CON.MP3');
    expect(audio.metadata).toMatchObject({ fileName: '_CON.MP3', mimeType: 'audio/mpeg' });
    await audio.close();
  });

  it('rejects metadata changes before opening completes and before or after a block read', async () => {
    driver.handleStat.mockResolvedValueOnce({ ...info(), mtime: new Date(2) });
    await expect(openMediaFileReader(path)).rejects.toMatchObject({ code: 'MEDIA_READ_CHANGED' });
    expect(driver.close).toHaveBeenCalledOnce();
    const reader = await openMediaFileReader(path);
    driver.mtime = 3;
    await expect(reader.read(0)).rejects.toMatchObject({ code: 'MEDIA_READ_CHANGED' });
    const next = await openMediaFileReader(path);
    driver.read.mockImplementationOnce(async () => { driver.isSymlink = true; return 1; });
    await expect(next.read(driver.bytes.length - 1)).rejects.toMatchObject({ code: 'MEDIA_READ_CHANGED' });
    expect(driver.close).toHaveBeenCalledTimes(3);
  });

  it('rejects cancellation before open and during a block, closing an acquired handle', async () => {
    const cancelled = new AbortController(); cancelled.abort();
    await expect(openMediaFileReader(path, cancelled.signal)).rejects.toMatchObject({ code: 'MEDIA_READ_CANCELLED' });
    expect(driver.open).not.toHaveBeenCalled();
    const controller = new AbortController();
    const reader = await openMediaFileReader(path);
    driver.read.mockImplementationOnce(async () => { controller.abort(); return 1; });
    await expect(reader.read(0, controller.signal)).rejects.toMatchObject({ code: 'MEDIA_READ_CANCELLED' });
    expect(driver.close).toHaveBeenCalledOnce();
  });

  it('closes a handle acquired after its opening request was cancelled', async () => {
    const controller = new AbortController();
    driver.open.mockImplementationOnce(async () => {
      controller.abort();
      return { read: driver.read, seek: driver.seek, stat: driver.handleStat, close: driver.close };
    });
    await expect(openMediaFileReader(path, controller.signal)).rejects.toMatchObject({ code: 'MEDIA_READ_CANCELLED' });
    expect(driver.read).not.toHaveBeenCalled();
    expect(driver.close).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight read on close, refuses another read as busy and discards the late block', async () => {
    const reader = await openMediaFileReader(path);
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    driver.read.mockImplementationOnce(() => new Promise<number>((resolve) => {
      finish = () => resolve(1); entered();
    }));
    const reading = reader.read(0);
    await started;
    await expect(reader.read(0)).rejects.toMatchObject({ code: 'MEDIA_READ_BUSY' });
    expect(driver.close).not.toHaveBeenCalled();
    const closed = reader.close();
    const rejected = expect(reading).rejects.toMatchObject({ code: 'MEDIA_READ_CLOSED' });
    expect(driver.close).not.toHaveBeenCalled();
    finish();
    await rejected; await closed;
    expect(driver.close).toHaveBeenCalledOnce();
  });

  it('converts native failures and short EOF into fixed errors without revealing paths', async () => {
    driver.open.mockRejectedValueOnce(new Error(`denied: ${path}`));
    await expect(openMediaFileReader(path)).rejects.toMatchObject({ code: 'MEDIA_READ_FAILED' });
    const reader = await openMediaFileReader(path);
    driver.read.mockRejectedValueOnce(new Error(`native read failed: ${path}`));
    const error = await reader.read(0).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MediaFileReadError);
    expect((error as Error).message).not.toContain(path);
    expect(driver.close).toHaveBeenCalledOnce();
    const next = await openMediaFileReader(path);
    driver.read.mockResolvedValueOnce(null);
    await expect(next.read(0)).rejects.toMatchObject({ code: 'MEDIA_READ_CHANGED' });
    expect(driver.close).toHaveBeenCalledTimes(2);
  });

  it('rejects desktop-unavailable access and reports close failure without exposing native messages', async () => {
    driver.desktop = false;
    await expect(openMediaFileReader(path)).rejects.toMatchObject({ code: 'MEDIA_READ_UNAVAILABLE' });
    driver.desktop = true;
    const reader = await openMediaFileReader(path);
    driver.close.mockRejectedValue(new Error(`close failed: ${path}`));
    await expect(reader.close()).rejects.toMatchObject({ code: 'MEDIA_READ_CLOSE_FAILED', message: '无法确认原文件读取已关闭' });
    await expect(reader.close()).rejects.toMatchObject({ code: 'MEDIA_READ_CLOSE_FAILED' });
    expect(driver.close).toHaveBeenCalledOnce();
  });
});

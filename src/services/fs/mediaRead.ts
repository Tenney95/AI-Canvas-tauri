/** 原媒体的有界字节读取；路径授权仍由原生文件插件 scope 决定。 */
import { lstat, open, SeekMode, type FileHandle, type FileInfo } from '@tauri-apps/plugin-fs';
import { getFileCategory, getMimeType, isTauriEnv, stripVerbatimPrefix } from './core';

export const MEDIA_READ_CHUNK_BYTES = 256 * 1024;

export class MediaFileReadError extends Error {
  readonly name = 'MediaFileReadError';
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export interface MediaFileReadMetadata {
  fileName: string;
  mimeType: string;
  totalBytes: number;
  modifiedAt: number | null;
}

export interface MediaFileReader {
  readonly metadata: MediaFileReadMetadata;
  read(offset: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
  close(): Promise<void>;
}

function fail(code: string, message: string): never { throw new MediaFileReadError(code, message); }
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) fail('MEDIA_READ_CANCELLED', '原文件读取已取消');
}
function modifiedAt(info: FileInfo): number | null {
  const value = info.mtime?.getTime();
  return value !== undefined && Number.isFinite(value) ? value : null;
}
function safeError(error: unknown, signal?: AbortSignal): MediaFileReadError {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new MediaFileReadError('MEDIA_READ_CANCELLED', '原文件读取已取消');
  }
  return error instanceof MediaFileReadError ? error
    : new MediaFileReadError('MEDIA_READ_FAILED', '无法读取原文件，请检查文件状态与读取授权');
}

function checkedPath(path: string): { path: string; fileName: string; mimeType: string } {
  if (typeof path !== 'string' || path.includes('\0')) fail('MEDIA_READ_PATH_INVALID', '原文件位置无效');
  const normalized = stripVerbatimPrefix(path).replace(/\\/g, '/');
  const absolute = /^(?:[a-z]:\/|\/)/i.test(normalized);
  const segments = normalized.split('/');
  const name = segments.at(-1) ?? '';
  if (!absolute || !name || /^\/\/[.?]\//.test(normalized)
    || segments.some((part) => part.trim() === '.' || part.trim() === '..' || (part !== '' && /^[. ]+$/.test(part)))
    || normalized.replace(/^[a-z]:/i, '').includes(':')) {
    fail('MEDIA_READ_PATH_INVALID', '原文件位置无效');
  }
  const category = getFileCategory(name);
  const mimeType = getMimeType(name.split('.').at(-1)?.toLowerCase() ?? '');
  if (!['image', 'video', 'audio'].includes(category) || !/^(?:image|video|audio)\//.test(mimeType)) {
    fail('MEDIA_READ_TYPE_UNSUPPORTED', '仅支持已落盘的图片、视频或音频原文件');
  }
  let fileName = Array.from(name, (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ? '_' : character).join('').replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fileName)) fileName = `_${fileName}`;
  if (!fileName) fail('MEDIA_READ_PATH_INVALID', '原文件名称无效');
  return { path: normalized, fileName, mimeType };
}

/** 不做整文件加载或转码；元数据比较不等于不可变内容快照。 */
export async function openMediaFileReader(path: string, signal?: AbortSignal): Promise<MediaFileReader> {
  let file: FileHandle | undefined;
  try {
    checkAbort(signal);
    if (!isTauriEnv()) fail('MEDIA_READ_UNAVAILABLE', '原文件读取仅支持桌面应用');
    const source = checkedPath(path);
    const initial = await lstat(source.path);
    checkAbort(signal);
    if (!initial.isFile || initial.isSymlink || !Number.isSafeInteger(initial.size) || initial.size < 0) {
      fail('MEDIA_READ_NOT_FILE', '原文件必须是已授权的普通媒体文件');
    }
    if (initial.size === 0) fail('MEDIA_READ_EMPTY', '原文件为空，无法下载');
    file = await open(source.path, { read: true });
    const handle = file;
    const metadata: MediaFileReadMetadata = Object.freeze({
      fileName: source.fileName, mimeType: source.mimeType,
      totalBytes: initial.size, modifiedAt: modifiedAt(initial),
    });
    let closed = false;
    let busy = false;
    let position = 0;
    let readComplete: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    function checkReadable(readSignal?: AbortSignal): void {
      checkAbort(readSignal);
      if (closed) fail('MEDIA_READ_CLOSED', '原文件读取已关闭，请重新开始下载');
    }
    function checkInfo(info: FileInfo): void {
      if (!info.isFile || info.isSymlink || info.size !== metadata.totalBytes || modifiedAt(info) !== metadata.modifiedAt) {
        fail('MEDIA_READ_CHANGED', '原文件在读取期间发生变化，请重新开始下载');
      }
    }
    async function checkFile(readSignal?: AbortSignal): Promise<void> {
      checkReadable(readSignal);
      checkInfo(await lstat(source.path));
      checkReadable(readSignal);
      checkInfo(await handle.stat());
      checkReadable(readSignal);
    }
    function close(): Promise<void> {
      closed = true;
      if (!closing) {
        const pendingRead = readComplete;
        closing = (async () => {
          await pendingRead;
          try { await handle.close(); }
          catch { fail('MEDIA_READ_CLOSE_FAILED', '无法确认原文件读取已关闭'); }
        })();
      }
      return closing;
    }
    await checkFile(signal);
    return {
      metadata,
      close,
      async read(offset, readSignal) {
        // 忙碌拒绝不能中止或关闭正在进行的另一次读取。
        if (busy) fail('MEDIA_READ_BUSY', '原文件正在读取，请等待当前分块完成');
        busy = true;
        let finish!: () => void;
        readComplete = new Promise<void>((resolve) => { finish = resolve; });
        try {
          checkReadable(readSignal);
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > metadata.totalBytes) {
            fail('MEDIA_READ_OFFSET_INVALID', '原文件读取偏移无效');
          }
          await checkFile(readSignal);
          if (position !== offset) {
            if (await handle.seek(offset, SeekMode.Start) !== offset) fail('MEDIA_READ_FAILED', '原文件定位失败');
            position = offset;
          }
          checkReadable(readSignal);
          const bytes = new Uint8Array(Math.min(MEDIA_READ_CHUNK_BYTES, metadata.totalBytes - offset));
          let filled = 0;
          while (filled < bytes.length) {
            checkReadable(readSignal);
            const count = await handle.read(bytes.subarray(filled));
            checkReadable(readSignal);
            if (count === null || count === 0) fail('MEDIA_READ_CHANGED', '原文件内容不完整，请重新开始下载');
            if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - filled) {
              fail('MEDIA_READ_FAILED', '原文件返回的分块无效');
            }
            filled += count;
            position += count;
          }
          await checkFile(readSignal);
          return bytes;
        } catch (error) {
          closed = true;
          throw safeError(error, readSignal);
        } finally {
          busy = false;
          // 先释放活动读取屏障，close 才能回收句柄；不能在屏障释放前自等待。
          readComplete = undefined;
          finish();
          if (closed) await close().catch(() => undefined);
        }
      },
    };
  } catch (error) {
    if (file) await file.close().catch(() => undefined);
    throw safeError(error, signal);
  }
}

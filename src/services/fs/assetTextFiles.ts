import { lstat, open, writeFile } from '@tauri-apps/plugin-fs';
import { getFileCategory, invalidateTextPreview, isTauriEnv, notifyProjectDiskChanged, stripVerbatimPrefix } from './core';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export interface AssetTextSnapshot {
  content: string;
  digest: string;
  size: number;
  modified: number | null;
  bom: boolean;
  newline: 'LF' | 'CRLF';
}

function checkAbort(signal?: AbortSignal) { signal?.throwIfAborted(); }

/** 只接受已授权的普通文本文件；不把完整正文写入数据库、日志或元数据。 */
export async function readAssetTextFile(path: string, signal?: AbortSignal): Promise<AssetTextSnapshot> {
  if (!isTauriEnv()) throw new Error('请在桌面应用中打开本地文本文件');
  if (getFileCategory(path.split(/[\\/]/).pop() ?? '') !== 'text') throw new Error('此文件不是受支持的文本文件');
  checkAbort(signal);
  const info = await lstat(path);
  if (!info.isFile || info.isSymlink) throw new Error('仅支持普通文本文件');
  if (info.size > MAX_TEXT_BYTES) throw new Error('文件超过 2 MB，请使用外部编辑器');
  const file = await open(path, { read: true });
  const buffer = new Uint8Array(MAX_TEXT_BYTES + 1);
  let length = 0;
  try {
    while (length < buffer.length) {
      checkAbort(signal);
      const count = await file.read(buffer.subarray(length));
      if (!count) break;
      length += count;
    }
  } finally { await file.close(); }
  checkAbort(signal);
  if (length > MAX_TEXT_BYTES) throw new Error('文件超过 2 MB，请使用外部编辑器');
  const bytes = buffer.slice(0, length);
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('文件不是有效 UTF-8，已停止编辑以避免乱码'); }
  if (content.includes('\0')) throw new Error('文件包含二进制数据，无法作为文本编辑');
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  checkAbort(signal);
  return { content: content.replace(/\r\n/g, '\n'), digest: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    size: length, modified: info.mtime?.getTime() ?? null, bom: bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191,
    newline: content.includes('\r\n') ? 'CRLF' : 'LF' };
}

const pendingSaves = new Map<string, Promise<unknown>>();

/** 同窗口串行写入；保存前比较正文摘要，外部改动拒绝覆盖。 */
export async function saveAssetTextFile(path: string, baseline: AssetTextSnapshot, content: string, signal?: AbortSignal): Promise<AssetTextSnapshot> {
  const normalizedPath = stripVerbatimPrefix(path).replace(/\\/g, '/');
  const key = /^[a-z]:\//i.test(normalizedPath) || normalizedPath.startsWith('//') ? normalizedPath.toLowerCase() : normalizedPath;
  const save = async () => {
    checkAbort(signal);
    const current = await readAssetTextFile(path, signal);
    if (current.digest !== baseline.digest) throw new Error('磁盘文件已被修改，请保留草稿并重新载入后再保存');
    const normalized = content.replace(/\r\n/g, '\n');
    const encoded = new TextEncoder().encode((baseline.bom ? '\uFEFF' : '') + (baseline.newline === 'CRLF' ? normalized.replace(/\n/g, '\r\n') : normalized));
    if (encoded.length > MAX_TEXT_BYTES) throw new Error('内容超过 2 MB，无法保存');
    if (normalized.includes('\0')) throw new Error('文本不能包含二进制空字符');
    checkAbort(signal);
    // 写入开始后不提前报告取消；等待真实结果，避免误认为磁盘未修改。
    try { await writeFile(path, encoded); }
    catch (reason) {
      const detail = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason.trim() : '';
      throw new Error(`保存失败，草稿已保留；请检查权限或磁盘空间，并重新读取磁盘确认内容${detail ? `：${detail}` : ''}`, { cause: reason });
    }
    invalidateTextPreview(path);
    notifyProjectDiskChanged();
    try {
      const saved = await readAssetTextFile(path);
      if (saved.content !== normalized || saved.bom !== baseline.bom) throw new Error('verify');
      return saved;
    }
    catch { throw new Error('已写入磁盘，但无法重新读取确认；草稿已保留，请重新载入检查'); }
  };
  const task = (pendingSaves.get(key) ?? Promise.resolve()).catch(() => {}).then(save);
  pendingSaves.set(key, task);
  try { return await task; }
  finally { if (pendingSaves.get(key) === task) pendingSaves.delete(key); }
}

/**
 * assetTextFiles — 读取资产文本快照并保存文本修改。
 */
import { exists, lstat, mkdir, open, writeFile } from '@tauri-apps/plugin-fs';
import { ensureProjectDataDir, getFileCategory, invalidateTextPreview, isTauriEnv, joinPath, notifyProjectDiskChanged, resolveUniqueDestPath, sanitizeFileName, stripVerbatimPrefix } from './core';

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

/** 首次保存时在目标项目内创建唯一 UTF-8 文本文件，不覆盖同名文件。 */
export async function createAssetTextFile(projectId: string, content: string, suggestedName: string, options: {
  signal?: AbortSignal; assertCurrent?: () => void; projectSubdirectory?: 'manuscripts';
} = {}): Promise<{ filePath: string; relativePath: string; fileName: string; snapshot: AssetTextSnapshot }> {
  if (!isTauriEnv()) throw new Error('请在桌面应用中保存原文');
  const check = () => { checkAbort(options.signal); options.assertCurrent?.(); };
  if (options.projectSubdirectory !== undefined && options.projectSubdirectory !== 'manuscripts') throw new Error('稿件目录无效');
  const fileName = sanitizeFileName(suggestedName) || '原文.txt';
  if (/[\\/]/.test(fileName)) throw new Error('文本文件名不能包含目录');
  if (getFileCategory(fileName) !== 'text') throw new Error('此文件不是受支持的文本文件');
  const normalized = content.replace(/\r\n/g, '\n');
  if (normalized.includes('\0')) throw new Error('文本不能包含二进制空字符');
  const bytes = new TextEncoder().encode(normalized);
  if (bytes.byteLength > MAX_TEXT_BYTES) throw new Error('内容超过 2 MB，无法保存');
  check();
  let directory = await ensureProjectDataDir(projectId, { throwOnError: true });
  check();
  if (!directory) throw new Error('剧集素材目录不可用，请重新打开剧集');
  if (options.projectSubdirectory !== undefined) {
    directory = joinPath(directory, 'manuscripts');
    const present = await exists(directory);
    check();
    if (!present) {
      try { await mkdir(directory); }
      catch (reason) { if (!await exists(directory)) throw new Error('无法创建稿件目录，草稿已保留', { cause: reason }); }
    }
    check();
    const info = await lstat(directory);
    check();
    if (!info.isDirectory || info.isSymlink) throw new Error('稿件目录必须是普通文件夹');
  }
  const filePath = await resolveUniqueDestPath(directory, fileName, true);
  check();
  try { await writeFile(filePath, bytes, { createNew: true }); }
  catch (reason) { throw new Error('新建原文失败，草稿已保留，请检查文件权限和磁盘空间', { cause: reason }); }
  notifyProjectDiskChanged();
  // 写入开始后等待真实读回；调用方在绑定原著前继续复核项目，取消不会误报尚未写入。
  let snapshot: AssetTextSnapshot;
  try { snapshot = await readAssetTextFile(filePath); }
  catch (reason) { throw new Error('原文文件已创建，但无法读回确认；草稿已保留，请检查项目文件', { cause: reason }); }
  if (snapshot.content !== normalized || snapshot.bom) throw new Error('新建原文读回复核失败，草稿已保留，请检查项目文件');
  const actualName = filePath.split(/[\\/]/).pop()!;
  const relativePath = options.projectSubdirectory ? `manuscripts/${actualName}` : actualName;
  return { filePath, relativePath, fileName: actualName, snapshot };
}

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

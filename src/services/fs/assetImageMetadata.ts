/**
 * assetImageMetadata — 计算图片身份并管理图片提示词与参考图元数据。
 */
import { exists, lstat, open as openFile, stat } from '@tauri-apps/plugin-fs';
import { open } from '@tauri-apps/plugin-dialog';
import { copyAssetImageReference, type AssetFileEntry, type FileTransferOptions } from '../fileService';
import { getAssetImageRecords, getAssetIndexById, putAssetImageRecord } from '../indexedDbService';
import { sha256BytesHex } from '../mediaDataUrl';
import { CATEGORY_EXTENSIONS, getAssetUrlFromPath, getBaseDir, isTauriEnv, joinPath, stripVerbatimPrefix } from './core';
import { identifyAsset } from './assetIndex';
import type { AssetImageIdentity, AssetImageRecord, AssetImageReference, AssetImageReferenceView, AssetImageSaveInput } from '../../types/assetImage';

const CHUNK_SIZE = 256 * 1024;
export const MAX_ASSET_IMAGE_REFERENCES = 16;
export const MAX_ASSET_IMAGE_PROMPT = 30_000;
const REFERENCE_PATH = /^asset-image-references\/[a-f0-9-]{36}\.[a-z0-9]{1,8}$/;
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };

/** 固定块 SHA-256 链校验全部内容；不是 size/mtime 指纹，内存占用不随文件大小增长。 */
export async function fingerprintAssetImage(path: string, signal?: AbortSignal): Promise<{ digest: string; bytes: number }> {
  if (!isTauriEnv()) throw new Error('图片信息编辑仅支持桌面应用');
  checkAbort(signal);
  const info = await lstat(path);
  if (!info.isFile || info.isSymlink) throw new Error('请选择普通图片文件');
  const file = await openFile(path, { read: true });
  try {
    const before = await file.stat();
    let previous = await sha256BytesHex(new TextEncoder().encode('asset-image-sha256-chain-v1'));
    const input = new Uint8Array(32 + CHUNK_SIZE);
    const block = input.subarray(32);
    let bytes = 0;
    let ended = false;
    while (!ended) {
      let filled = 0;
      while (filled < block.length) {
        checkAbort(signal);
        const count = await file.read(block.subarray(filled));
        if (count === null || count === 0) { ended = true; break; }
        if (count < 0 || count > block.length - filled) throw new Error('图片读取异常');
        filled += count;
      }
      if (!filled) break;
      input.set(Uint8Array.from(previous.match(/../g)!, (hex) => parseInt(hex, 16)));
      // 直接读取到摘要输入的内容区；等待当前摘要完成后再复用缓冲，尾块不包含旧字节。
      previous = await sha256BytesHex(input.subarray(0, 32 + filled));
      bytes += filled;
    }
    checkAbort(signal);
    const after = await stat(path);
    if (!bytes || bytes !== before.size || bytes !== after.size || before.mtime?.getTime() !== after.mtime?.getTime()) {
      throw new Error('图片在读取期间发生变化，请重试');
    }
    const digest = await sha256BytesHex(new TextEncoder().encode(`${previous}:${bytes}`));
    checkAbort(signal);
    return { digest, bytes };
  } finally { await file.close(); }
}

export async function identifyAssetImage(file: AssetFileEntry, projectId?: string, signal?: AbortSignal): Promise<AssetImageIdentity> {
  const content = await fingerprintAssetImage(file.path, signal);
  const indexed = await identifyAsset(file.path, { assetId: file.assetId, source: file.source ?? 'project', projectId, rootPath: file.folderRoot });
  checkAbort(signal);
  return { assetId: indexed.assetId, ...content };
}

function validRecord(record: AssetImageRecord): boolean {
  return !!record && typeof record.id === 'string' && record.id.startsWith('asset-image:')
    && typeof record.assetId === 'string' && /^[a-f0-9]{64}$/.test(record.contentDigest)
    && typeof record.prompt === 'string' && record.prompt.length <= MAX_ASSET_IMAGE_PROMPT
    && Number.isSafeInteger(record.revision) && record.revision > 0
    && Array.isArray(record.references) && record.references.length <= MAX_ASSET_IMAGE_REFERENCES
    && record.references.every(validReference);
}
function validReference(reference: AssetImageReference): boolean {
  return !!reference && REFERENCE_PATH.test(reference.relativePath) && typeof reference.id === 'string'
    && typeof reference.name === 'string' && /^[a-f0-9]{64}$/.test(reference.digest)
    && Number.isSafeInteger(reference.bytes) && reference.bytes > 0;
}

/** 同路径替换拒绝旧内容；找回只接受唯一、内容一致且旧位置明确缺失的记录。 */
export async function findSavedAssetImage(identity: AssetImageIdentity, signal?: AbortSignal): Promise<{ record: AssetImageRecord | null; ambiguous: boolean; contentChanged: boolean }> {
  const records = await getAssetImageRecords(signal);
  if (!records.every(validRecord)) throw new Error('图片信息记录损坏，请检查存储');
  const direct = records.filter((record) => record.assetId === identity.assetId && record.contentDigest === identity.digest);
  if (direct.length) return { record: direct.length === 1 ? direct[0] : null, ambiguous: direct.length > 1, contentChanged: false };
  const detached: AssetImageRecord[] = [];
  for (const record of records.filter((item) => item.contentDigest === identity.digest)) {
    checkAbort(signal);
    const index = await getAssetIndexById(record.assetId);
    // 无索引、权限不足或不可访问不等于删除，不静默猜测归属。
    if (index && !(await exists(index.path))) detached.push(record);
  }
  checkAbort(signal);
  return { record: detached.length === 1 ? detached[0] : null, ambiguous: detached.length > 1,
    contentChanged: records.some((record) => record.assetId === identity.assetId && record.contentDigest !== identity.digest) };
}

export async function resolveAssetImageReferences(references: AssetImageReference[], signal?: AbortSignal): Promise<AssetImageReferenceView[]> {
  const root = await getBaseDir();
  if (!root) throw new Error('参考图目录不可用');
  const resolved: AssetImageReferenceView[] = [];
  for (const reference of references) {
    checkAbort(signal);
    if (!validReference(reference)) throw new Error('参考图记录无效');
    let url: string | null = null;
    try {
      const path = joinPath(root, reference.relativePath);
      const actual = await fingerprintAssetImage(path, signal);
      if (actual.digest === reference.digest && actual.bytes === reference.bytes) url = await getAssetUrlFromPath(path);
    } catch { checkAbort(signal); /* 缺失、替换或权限失败均明确展示不可用，不回退到别的图片。 */ }
    resolved.push({ ...reference, url });
  }
  return resolved;
}

export async function pickAssetImageReferences(): Promise<string[]> {
  if (!isTauriEnv()) throw new Error('添加参考图仅支持桌面应用');
  const paths = await open({ multiple: true, title: '添加本地参考图', filters: [{ name: '图片', extensions: CATEGORY_EXTENSIONS.image.map((extension) => extension.slice(1)) }] });
  return paths ? Array.isArray(paths) ? paths : [paths] : [];
}

export async function previewPendingAssetImageReferences(paths: string[]): Promise<Array<{ path: string; name: string; url: string }>> {
  const result: Array<{ path: string; name: string; url: string }> = [];
  for (const path of paths) {
    const url = await getAssetUrlFromPath(path);
    if (!url) throw new Error('无法预览参考图');
    result.push({ path, name: path.split(/[\\/]/).pop() || '参考图', url });
  }
  return result;
}

/** 先复制及验证副本，最后事务提交。失败保留旧记录和已复制的副本，不自动删文件。 */
export async function saveAssetImageMetadata(file: AssetFileEntry, input: AssetImageSaveInput, options?: FileTransferOptions): Promise<AssetImageRecord> {
  const signal = options?.signal;
  checkAbort(signal);
  if (input.prompt.length > MAX_ASSET_IMAGE_PROMPT) throw new Error('提示词最多 30000 字符');
  if (input.references.length + input.newReferencePaths.length > MAX_ASSET_IMAGE_REFERENCES) throw new Error('最多添加 16 张参考图');
  if (!input.references.every(validReference) || input.record && !validRecord(input.record)) throw new Error('图片信息无效');
  const before = await fingerprintAssetImage(file.path, signal);
  if (before.digest !== input.identity.digest || input.record && input.record.contentDigest !== before.digest) throw new Error('原图内容已变化，请重新打开；旧信息仍保留');
  // 用户只能保留已保存的引用；不能注入或接管其他图片的相对文件。
  if (input.references.some((reference) => !input.record?.references.some((saved) => saved.id === reference.id
    && saved.relativePath === reference.relativePath && saved.digest === reference.digest
    && saved.bytes === reference.bytes && saved.name === reference.name))) throw new Error('参考图关联已变化，请重新读取');
  const root = await getBaseDir();
  if (!root) throw new Error('保存目录不可用');
  const references = [...input.references];
  for (const source of input.newReferencePaths) {
    checkAbort(signal);
    const name = source.split(/[\\/]/).pop() || '参考图';
    const extension = `.${name.split('.').pop()?.toLowerCase()}`;
    if (!CATEGORY_EXTENSIONS.image.includes(extension)) throw new Error('请选择图片文件');
    const content = await fingerprintAssetImage(source, signal);
    const id = crypto.randomUUID();
    const relativePath = `asset-image-references/${id}${extension}`;
    await copyAssetImageReference(source, relativePath, root, options);
    const copied = await fingerprintAssetImage(joinPath(root, relativePath), signal);
    if (copied.digest !== content.digest) throw new Error('参考图复制校验失败，请重试');
    references.push({ id, name, relativePath, ...content });
  }
  const after = await fingerprintAssetImage(file.path, signal);
  if (after.digest !== before.digest || root !== await getBaseDir()) throw new Error('原图或保存目录已变化，请重试');
  const record: AssetImageRecord = {
    id: input.record?.id ?? `asset-image:${encodeURIComponent(input.identity.assetId)}:${after.digest}`,
    assetId: input.identity.assetId, contentDigest: after.digest, fileName: file.name,
    prompt: input.prompt, references, revision: (input.record?.revision ?? 0) + 1, updatedAt: Date.now(),
  };
  checkAbort(signal);
  await putAssetImageRecord(record, input.record?.revision ?? 0, { tagReplacement: input.tagReplacement, signal });
  return record;
}

export interface SharedAssetImageMetadataSource {
  record: AssetImageRecord;
  /** 仅本轮传输可用；不得持久化或发送到云端快照。 */
  references: Array<{ id: string; name: string; filePath: string; bytes: number }>;
}

/** 共享仅读取此项目文件明确保存的信息，禁止按同图内容找回别的文件、历史或画布信息。 */
export async function readSharedAssetImageMetadata(
  file: AssetFileEntry, projectId: string, signal?: AbortSignal, records?: readonly AssetImageRecord[],
): Promise<SharedAssetImageMetadataSource | null> {
  checkAbort(signal);
  if (!file.assetId || file.source !== 'project' || file.category !== 'image') return null;
  const indexed = await getAssetIndexById(file.assetId);
  checkAbort(signal);
  const key = (path: string) => {
    const value = stripVerbatimPrefix(path).replace(/\\/g, '/');
    return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
  };
  if (!indexed || indexed.source !== 'project' || indexed.projectId !== projectId || indexed.status !== 'online'
    || key(indexed.path) !== key(file.path)) throw new Error('项目图片身份已变化，请重新同步');
  const saved = (records ?? await getAssetImageRecords(signal)).filter((record) => record.assetId === file.assetId);
  if (!saved.length) return null;
  if (!saved.every(validRecord)) throw new Error('图片专属信息损坏，请先修复');
  const content = await fingerprintAssetImage(file.path, signal);
  const matches = saved.filter((record) => record.contentDigest === content.digest);
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error('项目图片专属信息不唯一，请先修复');
  const root = await getBaseDir();
  checkAbort(signal);
  if (!root) throw new Error('参考图目录不可用');
  const record = matches[0];
  const references: SharedAssetImageMetadataSource['references'] = [];
  for (const reference of record.references) {
    const filePath = joinPath(root, reference.relativePath);
    const actual = await fingerprintAssetImage(filePath, signal);
    if (actual.digest !== reference.digest || actual.bytes !== reference.bytes) throw new Error('图片专属参考图缺失或已变化');
    references.push({ id: reference.id, name: reference.name, filePath, bytes: reference.bytes });
  }
  if (root !== await getBaseDir()) throw new Error('参考图目录已变化，请重新同步');
  checkAbort(signal);
  return { record, references };
}

/** 只准备文件与新本机记录；协调器将它与文件索引、共享映射在同一事务提交。 */
export async function prepareSharedAssetImageMetadata(
  file: AssetFileEntry,
  input: { prompt: string; references: readonly { id: string; name: string; filePath: string }[] },
  options?: FileTransferOptions,
): Promise<AssetImageRecord> {
  const signal = options?.signal;
  checkAbort(signal);
  if (!file.assetId || file.source !== 'project' || file.category !== 'image'
    || typeof input.prompt !== 'string' || input.prompt.length > MAX_ASSET_IMAGE_PROMPT
    || input.references.length > MAX_ASSET_IMAGE_REFERENCES) throw new Error('共享图片专属信息无效');
  const root = await getBaseDir();
  if (!root) throw new Error('参考图目录不可用');
  const before = await fingerprintAssetImage(file.path, signal);
  const ids = new Set<string>();
  const references: AssetImageReference[] = [];
  for (const reference of input.references) {
    if (!reference.id || reference.id.length > 256 || ids.has(reference.id)
      || typeof reference.name !== 'string' || reference.name.length > 1024
      || Array.from(reference.name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new Error('共享图片参考图身份无效');
    }
    ids.add(reference.id);
    const extension = `.${reference.filePath.split('.').pop()?.toLowerCase()}`;
    if (!CATEGORY_EXTENSIONS.image.includes(extension)) throw new Error('共享参考图类型无效');
    const original = await fingerprintAssetImage(reference.filePath, signal);
    const relativePath = `asset-image-references/${crypto.randomUUID()}${extension}`;
    await copyAssetImageReference(reference.filePath, relativePath, root, options);
    const copied = await fingerprintAssetImage(joinPath(root, relativePath), signal);
    if (copied.digest !== original.digest || copied.bytes !== original.bytes) throw new Error('共享参考图复制校验失败');
    references.push({ id: reference.id, name: reference.name, relativePath, ...copied });
  }
  const after = await fingerprintAssetImage(file.path, signal);
  if (before.digest !== after.digest || root !== await getBaseDir()) throw new Error('项目图片或参考图目录已变化');
  checkAbort(signal);
  return { id: `asset-image:${encodeURIComponent(file.assetId)}:${after.digest}`, assetId: file.assetId,
    contentDigest: after.digest, fileName: file.name, prompt: input.prompt, references, revision: 1, updatedAt: Date.now() };
}

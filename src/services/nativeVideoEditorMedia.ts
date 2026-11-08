/** 新剪辑工程只持久化作品内相对路径；运行时重新解析素材。 */
import { exists, stat } from '@tauri-apps/plugin-fs';
import { copyFileToProjectData, getAssetUrlFromPath, getProjectDataDir, joinPath, saveBinaryToProjectData } from './fileService';
import { getRelativeAssetPath, resolveIndexedAssetPath } from './fs/assetIndex';
import { localMediaUrlToPath, isTauriAssetUrl } from '../utils/mediaUrl';
import { safeExchangePath } from './projectExchangeDomain';
import type { VideoEditorClip, VideoEditorProjectRecord } from '../types/videoEditor';

const copyCache = new Map<string, { size: number; modified: number; destination: string }>();

async function prepareClip(clip: VideoEditorClip, projectId: string, root: string, assertCurrent: () => Promise<void>): Promise<VideoEditorClip> {
  const next = { ...clip };
  let path = next.filePath ?? (next.sourceUrl && isTauriAssetUrl(next.sourceUrl) ? localMediaUrlToPath(next.sourceUrl) ?? undefined : undefined);
  if (!path && next.assetId) path = await resolveIndexedAssetPath(next.assetId) ?? undefined;
  await assertCurrent();
  if (path) {
    let relative = getRelativeAssetPath(path, root);
    // 其他素材根嵌在作品根的 roots/ 下；它们不是主根素材，需复制到主根才可归档和迁移。
    if (!relative || /^roots\//i.test(relative)) {
      const source = await stat(path);
      const modified = source.mtime?.getTime() ?? 0;
      const key = `${projectId}\0${path}`, cached = copyCache.get(key);
      if (cached && cached.size === source.size && cached.modified === modified && await exists(cached.destination)) {
        path = cached.destination;
      } else {
        const copied = await copyFileToProjectData(path, projectId, { assertCurrent });
        if (!copied) throw new Error('剪辑素材无法复制到项目目录');
        copyCache.set(key, { size: source.size, modified, destination: copied.filePath });
        path = copied.filePath;
      }
      relative = getRelativeAssetPath(path, root);
      delete next.assetId;
    }
    if (!relative || safeExchangePath(relative) !== relative) throw new Error('剪辑素材不属于当前作品');
    next.relativePath = relative;
    delete next.filePath;
    if (next.sourceUrl && (isTauriAssetUrl(next.sourceUrl) || /^(?:data:|blob:)/i.test(next.sourceUrl))) delete next.sourceUrl;
    return next;
  }
  if (next.relativePath) {
    if (safeExchangePath(next.relativePath) !== next.relativePath) throw new Error('剪辑素材路径无效');
    return next;
  }
  if (next.sourceUrl && /^(?:data:|blob:)/i.test(next.sourceUrl)) {
    const response = await fetch(next.sourceUrl);
    if (!response.ok) throw new Error('剪辑素材读取失败');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('剪辑素材超过允许的内存上限');
    await assertCurrent();
    const saved = await saveBinaryToProjectData(bytes, projectId, next.fileName || 'video-editor-media', { assertCurrent, throwOnError: true });
    await assertCurrent();
    const relative = saved && getRelativeAssetPath(saved.filePath, root);
    if (!relative || safeExchangePath(relative) !== relative) throw new Error('剪辑素材保存失败');
    next.relativePath = relative;
    delete next.sourceUrl;
  }
  return next;
}

export async function prepareNativeVideoEditorRecord(record: VideoEditorProjectRecord,
  assertCurrent: () => Promise<void>): Promise<VideoEditorProjectRecord> {
  const root = await getProjectDataDir(record.projectId);
  if (!root) throw new Error('项目素材目录不可用');
  await assertCurrent();
  const tracks = await Promise.all(record.tracks.map(async (track) => ({ ...track,
    clips: await Promise.all(track.clips.map((clip) => prepareClip(clip, record.projectId, root, assertCurrent))) })));
  await assertCurrent();
  return { ...record, tracks };
}

export async function restoreNativeVideoEditorRecord(record: VideoEditorProjectRecord,
  assertCurrent: () => Promise<void>): Promise<VideoEditorProjectRecord> {
  const root = await getProjectDataDir(record.projectId);
  if (!root) throw new Error('项目素材目录不可用');
  await assertCurrent();
  const tracks = await Promise.all(record.tracks.map(async (track) => ({ ...track,
    clips: await Promise.all(track.clips.map(async (clip) => {
      if (!clip.relativePath) return clip;
      if (safeExchangePath(clip.relativePath) !== clip.relativePath) throw new Error('剪辑素材路径无效');
      const path = joinPath(root, clip.relativePath);
      if (!await exists(path)) return clip;
      return { ...clip, filePath: path, sourceUrl: await getAssetUrlFromPath(path) };
    })) })));
  await assertCurrent();
  return { ...record, tracks };
}

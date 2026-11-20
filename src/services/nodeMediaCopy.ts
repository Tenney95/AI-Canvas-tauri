/**
 * nodeMediaCopy — 复制节点媒体并管理复制产物的清理。
 */
import type { BaseNodeData, ShotFrameBinding } from '../types';
import * as files from './fileService';
import { isTauriEnv } from './fs/core';
import { isRemoteMediaUrl, localMediaUrlToPath } from '../utils/mediaUrl';
import { trashPathKey, usesTrashPath } from './fs/undoTrashJournal';

// Serialize allocation + native copy: concurrent pastes must not select the same destination.
let copyQueue: Promise<unknown> = Promise.resolve();
const pinnedPaths = new Map<string, number>();
const stagedPaths = new WeakMap<BaseNodeData, string[]>();
export const isNodeMediaCopySource = (path: string) => pinnedPaths.has(trashPathKey(path));
export const isNodeMediaCopySourceTree = (directory: string) => usesTrashPath(directory, new Set(pinnedPaths.keys()));

async function discardFiles(paths: string[]): Promise<void> {
  for (const path of paths) {
    try { await files.moveToUndoTrash(path); } catch { /* Recycling unavailable: keep the staged file. */ }
  }
}

export async function discardCopiedNodeMedia(data: BaseNodeData, source: BaseNodeData): Promise<void> {
  const staged = stagedPaths.get(data);
  if (!staged || data === source) return;
  stagedPaths.delete(data);
  await discardFiles(staged);
}

interface ShotlistPaste {
  copiedSources: ReadonlyMap<string, BaseNodeData>;
  targetId: (sourceId: string) => string;
}
type ShotBinding<K extends ShotFrameBinding['kind']> = ShotFrameBinding & { kind: K };

/** 画面/成片渲染优先使用仍在画布上的来源；剪贴板也在复制时捕获这一版内容。 */
export function snapshotShotlistBinding<K extends ShotFrameBinding['kind']>(binding: ShotBinding<K>, source: BaseNodeData): ShotBinding<K> {
  const url = binding.kind === 'video' ? source.videoUrl : source.imageUrl || source.thumbnailUrl;
  return { nodeId: binding.nodeId, kind: binding.kind, url, filePath: source.filePath,
    assetId: source.assetId, relativePath: source.relativePath,
    sourceDuration: source.videoDuration ?? binding.sourceDuration };
}

export function needsNodeMediaCopy(data: BaseNodeData, crossProject = false): boolean {
  if (data.type === 'ai-director') return false; // Director snapshots have their own insertion lifecycle.
  return !!(data.filePath || crossProject && data.shotlistRows?.some((row) => row.frame || row.video)
    || data.storyboardOverrides?.some((cell) => cell?.filePath)
    || (isTauriEnv() && (data.imageUrl || data.videoUrl || data.audioUrl || data.thumbnailUrl
      || data.outpaintInput
      || data.storyboardOverrides?.some((cell) => cell?.url))));
}

/** Stage independent files before publishing any copied node. Failure never falls back to sharing. */
export async function copyNodeMedia(data: BaseNodeData, projectId: string, shotlist?: ShotlistPaste): Promise<BaseNodeData> {
  const paths = [data.filePath, ...[data.imageUrl, data.videoUrl, data.audioUrl, data.thumbnailUrl, data.outpaintInput?.url].map(localMediaUrlToPath),
    ...(data.storyboardOverrides ?? []).flatMap((cell) => [cell?.filePath, localMediaUrlToPath(cell?.url)]),
    ...(shotlist ? (data.shotlistRows ?? []).flatMap((row) => [row.frame, row.video])
      .flatMap((binding) => [binding?.filePath, localMediaUrlToPath(binding?.url)]) : [])]
    .filter((path): path is string => !!path);
  for (const path of paths) {
    const key = trashPathKey(path);
    pinnedPaths.set(key, (pinnedPaths.get(key) ?? 0) + 1);
  }
  const task = copyQueue.then(async () => {
    const next = structuredClone(data);
    const created: string[] = [];
    try {
      const copy = async (path: string | undefined, url: string | undefined) => {
        if (path) {
          const saved = await files.copyFileToProjectData(path, projectId, { redactErrors: true });
          if (!saved?.filePath || trashPathKey(saved.filePath) === trashPathKey(path)) {
            throw new Error('素材复制失败，请重试');
          }
          created.push(saved.filePath);
          if (!saved.assetUrl) throw new Error('素材复制失败，请重试');
          return { filePath: saved.filePath, url: saved.assetUrl };
        }
        if (!url) return null;
        const saved = await files.persistMediaUrlToProjectData(url, projectId, 'copy', undefined, { deduplicateByContent: false, redactErrors: true });
        if (!saved.filePath) throw new Error('素材复制失败，请重试');
        created.push(saved.filePath);
        return { filePath: saved.filePath, url: saved.mediaUrl };
      };
      const primaryUrl = data.videoUrl || data.audioUrl || data.imageUrl || data.thumbnailUrl;
      const saved = await copy(data.filePath, primaryUrl);
      if (saved) {
        next.filePath = saved.filePath;
        next.fileName = saved.filePath.replace(/\\/g, '/').split('/').pop();
        next.assetId = undefined;
        next.relativePath = undefined;
        delete next.storageRootRef;
        delete next.artifactId;
        delete next.outputHistory;
        for (const field of ['imageUrl', 'videoUrl', 'audioUrl', 'thumbnailUrl'] as const) {
          if (primaryUrl && data[field] === primaryUrl) next[field] = saved.url;
        }
        if (primaryUrl && data.output === primaryUrl) next.output = saved.url;
        if (primaryUrl && data.sourceUrl === primaryUrl) next.sourceUrl = saved.url;
      }
      // A video poster or secondary media URL may be a separate local file.
      const auxiliary = new Map<string, string>();
      if (isTauriEnv()) for (const field of ['imageUrl', 'videoUrl', 'audioUrl', 'thumbnailUrl'] as const) {
        const url = data[field];
        if (!url || url === primaryUrl) continue;
        let copiedUrl = auxiliary.get(url);
        if (!copiedUrl) {
          copiedUrl = (await copy(undefined, url))?.url;
          if (copiedUrl) auxiliary.set(url, copiedUrl);
        }
        if (copiedUrl) next[field] = copiedUrl;
      }
      if (next.storyboardOverrides) {
        for (const cell of next.storyboardOverrides) {
          if (!cell) continue;
          const result = await copy(cell.filePath, cell.url);
          if (result) Object.assign(cell, { filePath: result.filePath, relativePath: undefined, url: result.url });
        }
      }
      if (shotlist && next.shotlistRows) {
        const snapshots = new Map<string, { filePath: string; url: string }>();
        const copyBinding = async <K extends ShotFrameBinding['kind']>(binding: ShotBinding<K>): Promise<ShotBinding<K>> => {
          const nodeId = shotlist.targetId(binding.nodeId);
          const source = shotlist.copiedSources.get(binding.nodeId);
          if (source) {
            if (!source.filePath && (source.assetId || source.relativePath)) throw new Error('分镜来源文件不可用');
            return { ...snapshotShotlistBinding(binding, source), nodeId };
          }
          const path = binding.filePath || localMediaUrlToPath(binding.url);
          const snapshot = { nodeId, kind: binding.kind, sourceDuration: binding.sourceDuration };
          if (!path && isRemoteMediaUrl(binding.url)) return { ...snapshot, url: binding.url };
          if (!path && !binding.url && !binding.assetId && !binding.relativePath) return snapshot;
          if (!path && !/^(?:data|blob):/i.test(binding.url ?? '')) throw new Error('分镜素材不可用，请重新绑定后复制');
          if (!path && !isTauriEnv()) return { ...snapshot, url: binding.url };
          const key = path ? trashPathKey(path) : binding.url!;
          let result = snapshots.get(key);
          if (!result) {
            const saved = await copy(path, binding.url);
            if (!saved) throw new Error('分镜素材复制失败，请重试');
            result = saved;
            snapshots.set(key, result);
          }
          return { ...snapshot, ...result };
        };
        for (const row of next.shotlistRows) {
          if (row.frame) row.frame = await copyBinding(row.frame);
          if (row.video) row.video = await copyBinding(row.video);
        }
      }
      if (next.outpaintInput) {
        const result = await copy(localMediaUrlToPath(next.outpaintInput.url), next.outpaintInput.url);
        if (!result) throw new Error('素材复制失败，请重试');
        next.outpaintInput = { url: result.url, width: next.outpaintInput.width, height: next.outpaintInput.height };
      }
      if (next.status === 'loading') next.status = saved ? 'success' : 'idle';
      stagedPaths.set(next, created);
      return next;
    } catch (error) {
      await discardFiles(created);
      throw error;
    }
  });
  copyQueue = task.catch(() => undefined);
  try { return await task; }
  finally {
    for (const path of paths) {
      const key = trashPathKey(path);
      const count = (pinnedPaths.get(key) ?? 1) - 1;
      if (count) pinnedPaths.set(key, count); else pinnedPaths.delete(key);
    }
  }
}

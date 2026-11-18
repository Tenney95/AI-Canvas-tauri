/**
 * nodeMediaCopy — 复制节点媒体并管理复制产物的清理。
 */
import type { BaseNodeData } from '../types';
import * as files from './fileService';
import { isTauriEnv } from './fs/core';
import { localMediaUrlToPath } from '../utils/mediaUrl';
import { usesTrashPath } from './fs/undoTrashJournal';

// Serialize allocation + native copy: concurrent pastes must not select the same destination.
let copyQueue: Promise<unknown> = Promise.resolve();
const pinnedPaths = new Map<string, number>();
const stagedPaths = new WeakMap<BaseNodeData, string[]>();
const keyOf = (path: string) => path.replace(/\\/g, '/');
export const isNodeMediaCopySource = (path: string) => pinnedPaths.has(keyOf(path));
export const isNodeMediaCopySourceTree = (directory: string) => usesTrashPath(directory, new Set(pinnedPaths.keys()));

async function discardFiles(paths: string[]): Promise<void> {
  for (const path of paths) {
    try { await files.moveToUndoTrash(path); } catch { /* Recycling unavailable: keep the staged file. */ }
  }
}

export async function discardCopiedNodeMedia(data: BaseNodeData, source: BaseNodeData): Promise<void> {
  const staged = stagedPaths.get(data);
  if (staged) { stagedPaths.delete(data); await discardFiles(staged); return; }
  const original = new Set([source.filePath, localMediaUrlToPath(source.outpaintInput?.url), ...(source.storyboardOverrides ?? []).map((cell) => cell?.filePath)]);
  await discardFiles([data.filePath, localMediaUrlToPath(data.outpaintInput?.url), ...(data.storyboardOverrides ?? []).map((cell) => cell?.filePath)]
    .filter((path): path is string => !!path && !original.has(path)));
}

export function needsNodeMediaCopy(data: BaseNodeData): boolean {
  if (data.type === 'ai-director') return false; // Director snapshots have their own insertion lifecycle.
  return !!(data.filePath || data.storyboardOverrides?.some((cell) => cell?.filePath)
    || (isTauriEnv() && (data.imageUrl || data.videoUrl || data.audioUrl || data.thumbnailUrl
      || data.outpaintInput
      || data.storyboardOverrides?.some((cell) => cell?.url))));
}

/** Stage independent files before publishing any copied node. Failure never falls back to sharing. */
export async function copyNodeMedia(data: BaseNodeData, projectId: string): Promise<BaseNodeData> {
  const paths = [data.filePath, ...[data.imageUrl, data.videoUrl, data.audioUrl, data.thumbnailUrl, data.outpaintInput?.url].map(localMediaUrlToPath),
    ...(data.storyboardOverrides ?? []).flatMap((cell) => [cell?.filePath, localMediaUrlToPath(cell?.url)])]
    .filter((path): path is string => !!path);
  for (const path of paths) pinnedPaths.set(keyOf(path), (pinnedPaths.get(keyOf(path)) ?? 0) + 1);
  const task = copyQueue.then(async () => {
    const next = structuredClone(data);
    const created: string[] = [];
    try {
      const copy = async (path: string | undefined, url: string | undefined) => {
        if (path) {
          const saved = await files.copyFileToProjectData(path, projectId, { redactErrors: true });
          if (!saved?.filePath || !saved.assetUrl || keyOf(saved.filePath) === keyOf(path)) {
            throw new Error('素材复制失败，请重试');
          }
          created.push(saved.filePath);
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
      const key = keyOf(path);
      const count = (pinnedPaths.get(key) ?? 1) - 1;
      if (count) pinnedPaths.set(key, count); else pinnedPaths.delete(key);
    }
  }
}

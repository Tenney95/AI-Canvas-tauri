/**
 * 监听画布节点引用的本地图像文件。
 * 监听父目录而不是单个文件，以兼容 Photoshop 等工具通过临时文件替换原文件的保存方式。
 */
import { useCallback, useEffect, useState } from 'react';
import type { WatchEvent } from '@tauri-apps/plugin-fs';
import type { Node } from '@xyflow/react';
import { useAppStore } from '../store/useAppStore';
import type { BaseNodeData, StoryboardCellOverride } from '../types';

export const REFERENCED_IMAGE_CHANGED_EVENT = 'referenced-image-changed';

export interface ReferencedImageChangedDetail {
  paths: string[];
  revision: number;
}

const IS_WINDOWS = typeof navigator !== 'undefined' && /win/i.test(navigator.platform || '');

export function normalizeWatchedPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return IS_WINDOWS ? normalized.toLocaleLowerCase() : normalized;
}

/** 为本地资源 URL 添加仅用于预览刷新的版本参数，绕过 WebView 图片缓存。 */
export function withPreviewRevision(src: string | undefined, revision: number): string | undefined {
  if (!src || revision === 0) return src;
  try {
    const url = new URL(src);
    url.searchParams.set('_refresh', String(revision));
    return url.toString();
  } catch {
    const separator = src.includes('?') ? '&' : '?';
    return `${src}${separator}_refresh=${revision}`;
  }
}

/**
 * 消费全局文件变更事件，不创建额外系统 watcher。
 * 返回按 filePath 查询当前预览版本的方法，供一个节点同时管理多张引用图。
 */
export function useReferencedImageRevisions(
  filePaths: readonly (string | undefined)[],
): (filePath: string | undefined) => number {
  const signature = [...new Set(
    filePaths.filter((path): path is string => !!path).map(normalizeWatchedPath),
  )].sort().join('\n');
  const [revisionByPath, setRevisionByPath] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!signature) return;
    const watchedPaths = new Set(signature.split('\n'));
    const onReferencedImageChanged = (event: Event) => {
      const detail = (event as CustomEvent<ReferencedImageChangedDetail>).detail;
      const affectedPaths = detail.paths
        .map(normalizeWatchedPath)
        .filter((path) => watchedPaths.has(path));
      if (affectedPaths.length === 0) return;

      setRevisionByPath((previous) => {
        const next = { ...previous };
        for (const path of affectedPaths) next[path] = detail.revision;
        return next;
      });
    };

    window.addEventListener(REFERENCED_IMAGE_CHANGED_EVENT, onReferencedImageChanged);
    return () => window.removeEventListener(REFERENCED_IMAGE_CHANGED_EVENT, onReferencedImageChanged);
  }, [signature]);

  return useCallback(
    (filePath: string | undefined) => filePath ? revisionByPath[normalizeWatchedPath(filePath)] ?? 0 : 0,
    [revisionByPath],
  );
}

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return '';
  if (slash === 2 && /^[A-Za-z]:/.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, slash) || '/';
}

export function collectReferencedImagePaths(nodes: readonly Node<BaseNodeData>[]): string[] {
  const paths = nodes.flatMap((node) => {
    const data = node.data;
    const nodePaths: string[] = [];
    if (data.filePath && (data.imageUrl || data.thumbnailUrl)) nodePaths.push(data.filePath);
    for (const override of data.storyboardOverrides ?? []) {
      if (override?.filePath && override.url) nodePaths.push(override.filePath);
    }
    return nodePaths;
  });
  return [...new Set(paths)].sort();
}

function effectiveMainImagePath(data: BaseNodeData): string | undefined {
  return data.imageUrl || data.thumbnailUrl ? data.filePath : undefined;
}

function effectiveOverridePath(override: StoryboardCellOverride | null | undefined): string | undefined {
  return override?.url ? override.filePath : undefined;
}

function referencedImageFieldsEqual(current: BaseNodeData, previous: BaseNodeData): boolean {
  if (current === previous) return true;
  if (effectiveMainImagePath(current) !== effectiveMainImagePath(previous)) return false;

  const currentOverrides = current.storyboardOverrides;
  const previousOverrides = previous.storyboardOverrides;
  if (currentOverrides === previousOverrides) return true;
  if (!currentOverrides?.length && !previousOverrides?.length) return true;
  if (!currentOverrides || !previousOverrides) return false;
  if (currentOverrides.length !== previousOverrides.length) return false;
  return currentOverrides.every(
    (override, index) => effectiveOverridePath(override) === effectiveOverridePath(previousOverrides[index]),
  );
}

function hasReferencedImage(data: BaseNodeData): boolean {
  if (effectiveMainImagePath(data)) return true;
  return data.storyboardOverrides?.some((override) => !!effectiveOverridePath(override)) ?? false;
}

/**
 * 利用 React Flow 更新时保留 data 引用的特性，让位置和选中变化走零分配快速路径。
 * 节点增删或重排较少发生，只有这些场景才建立 id 索引继续比较有效图片引用。
 */
export function haveReferencedImageFieldsChanged(
  current: readonly Node<BaseNodeData>[],
  previous: readonly Node<BaseNodeData>[],
): boolean {
  if (current === previous) return false;

  if (current.length === previous.length) {
    let sameOrder = true;
    for (let index = 0; index < current.length; index++) {
      const currentNode = current[index];
      const previousNode = previous[index];
      if (currentNode === previousNode) continue;
      if (currentNode.id !== previousNode.id) {
        sameOrder = false;
        break;
      }
      if (!referencedImageFieldsEqual(currentNode.data, previousNode.data)) return true;
    }
    if (sameOrder) return false;
  }

  const previousById = new Map(previous.map((node) => [node.id, node]));
  for (const node of current) {
    const previousNode = previousById.get(node.id);
    if (!previousNode) {
      if (hasReferencedImage(node.data)) return true;
      continue;
    }
    previousById.delete(node.id);
    if (!referencedImageFieldsEqual(node.data, previousNode.data)) return true;
  }
  for (const node of previousById.values()) {
    if (hasReferencedImage(node.data)) return true;
  }
  return false;
}

function isAccessEvent(event: WatchEvent): boolean {
  return typeof event.type === 'object' && event.type !== null && 'access' in event.type;
}

export function useReferencedImageWatcher(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;

    let disposed = false;
    let generation = 0;
    let unwatch: (() => void) | undefined;
    let signature = '';
    let syncFrame: number | undefined;

    const rebuildWatcher = async (paths: string[]) => {
      const currentGeneration = ++generation;
      unwatch?.();
      unwatch = undefined;
      if (paths.length === 0) return;

      const directories = [...new Set(paths.map(parentDirectory).filter(Boolean))];
      if (directories.length === 0) return;

      try {
        const { watch } = await import('@tauri-apps/plugin-fs');
        const stop = await watch(
          directories,
          (event) => {
            if (disposed || currentGeneration !== generation || isAccessEvent(event)) return;

            const changedPaths = new Set(
              event.paths.flatMap((eventPath) => [
                normalizeWatchedPath(eventPath),
                normalizeWatchedPath(parentDirectory(eventPath)),
              ]),
            );
            const affected = paths.filter((path) => {
              const normalized = normalizeWatchedPath(path);
              const directory = normalizeWatchedPath(parentDirectory(path));
              return changedPaths.has(normalized) || changedPaths.has(directory);
            });
            if (affected.length === 0) return;

            window.dispatchEvent(new CustomEvent<ReferencedImageChangedDetail>(
              REFERENCED_IMAGE_CHANGED_EVENT,
              { detail: { paths: affected.map(normalizeWatchedPath), revision: Date.now() } },
            ));
          },
          { recursive: false, delayMs: 350 },
        );

        if (disposed || currentGeneration !== generation) stop();
        else unwatch = stop;
      } catch (error) {
        console.warn('[imageWatcher] 无法监听节点引用的图像文件:', error);
      }
    };

    const syncWatcher = () => {
      const paths = collectReferencedImagePaths(useAppStore.getState().nodes);
      const nextSignature = paths.map(normalizeWatchedPath).join('\n');
      if (nextSignature === signature) return;
      signature = nextSignature;
      void rebuildWatcher(paths);
    };

    const scheduleSync = () => {
      if (syncFrame !== undefined) return;
      syncFrame = window.requestAnimationFrame(() => {
        syncFrame = undefined;
        if (!disposed) syncWatcher();
      });
    };

    syncWatcher();
    const unsubscribe = useAppStore.subscribe((state, previousState) => {
      if (haveReferencedImageFieldsChanged(state.nodes, previousState.nodes)) scheduleSync();
    });
    return () => {
      disposed = true;
      generation++;
      unsubscribe();
      if (syncFrame !== undefined) window.cancelAnimationFrame(syncFrame);
      unwatch?.();
    };
  }, []);
}

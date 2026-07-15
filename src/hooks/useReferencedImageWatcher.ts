/**
 * 监听画布节点引用的本地图像文件。
 * 监听父目录而不是单个文件，以兼容 Photoshop 等工具通过临时文件替换原文件的保存方式。
 */
import { useCallback, useEffect, useState } from 'react';
import type { WatchEvent } from '@tauri-apps/plugin-fs';
import { useAppStore } from '../store/useAppStore';

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

function referencedImagePaths(): string[] {
  const paths = useAppStore.getState().nodes.flatMap((node) => {
    const data = node.data as {
      filePath?: string;
      imageUrl?: string;
      thumbnailUrl?: string;
      storyboardOverrides?: ({ url?: string; filePath?: string } | null)[];
    };
    const nodePaths: string[] = [];
    if (data.filePath && (data.imageUrl || data.thumbnailUrl)) nodePaths.push(data.filePath);
    for (const override of data.storyboardOverrides ?? []) {
      if (override?.filePath && override.url) nodePaths.push(override.filePath);
    }
    return nodePaths;
  });
  return [...new Set(paths)].sort();
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
      const paths = referencedImagePaths();
      const nextSignature = paths.map(normalizeWatchedPath).join('\n');
      if (nextSignature === signature) return;
      signature = nextSignature;
      void rebuildWatcher(paths);
    };

    syncWatcher();
    const unsubscribe = useAppStore.subscribe((state, previousState) => {
      if (state.nodes !== previousState.nodes) syncWatcher();
    });
    return () => {
      disposed = true;
      generation++;
      unsubscribe();
      unwatch?.();
    };
  }, []);
}

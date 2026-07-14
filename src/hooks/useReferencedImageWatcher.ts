/**
 * 监听画布节点引用的本地图像文件。
 * 监听父目录而不是单个文件，以兼容 Photoshop 等工具通过临时文件替换原文件的保存方式。
 */
import { useEffect } from 'react';
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

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return '';
  if (slash === 2 && /^[A-Za-z]:/.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, slash) || '/';
}

function referencedImagePaths(): string[] {
  const paths = useAppStore.getState().nodes.flatMap((node) => {
    const data = node.data as { filePath?: string; imageUrl?: string; thumbnailUrl?: string };
    return data.filePath && (data.imageUrl || data.thumbnailUrl) ? [data.filePath] : [];
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
    const unsubscribe = useAppStore.subscribe(syncWatcher);
    return () => {
      disposed = true;
      generation++;
      unsubscribe();
      unwatch?.();
    };
  }, []);
}

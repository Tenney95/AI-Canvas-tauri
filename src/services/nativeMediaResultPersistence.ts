import type { MediaKind, NativeMediaLocalOutput } from '../types/media';
import { persistMediaUrlToProjectData, type FileTransferOptions } from './fileService';
import { captureNativeMediaLocalResult } from './nativeMediaLocalResult';

type NativeMediaResultOptions = Pick<FileTransferOptions, 'signal' | 'assertCurrent' | 'mediaDownloadAccess'> & {
  category: MediaKind;
  label: string;
  missingFileMessage: string;
};

/** 把单个产物保存到原画布目录并冻结内容身份，回执和交付由调用方结算。 */
export async function persistNativeMediaResult(
  url: string,
  canvasId: string,
  { category, label, missingFileMessage, ...options }: NativeMediaResultOptions,
): Promise<NativeMediaLocalOutput> {
  options.signal?.throwIfAborted();
  const saved = await persistMediaUrlToProjectData(url, canvasId, `ai-${category}`, label, options);
  if (!saved.filePath) throw new Error(missingFileMessage);
  options.signal?.throwIfAborted();
  const file = await captureNativeMediaLocalResult(canvasId, saved.filePath);
  options.signal?.throwIfAborted();
  return { ...file, category };
}

import type { MediaKind, NativeMediaLocalOutput } from '../types/media';
import { persistMediaUrlToProjectData, type FileTransferOptions } from './fileService';
import { captureNativeMediaLocalResult } from './nativeMediaLocalResult';

type NativeMediaResultOptions = Pick<FileTransferOptions, 'signal' | 'assertCurrent' | 'mediaDownloadAccess'> & {
  category: MediaKind;
  label: string;
  missingFileMessage: string;
};

/**
 * 将单个产物保存到原画布并核验本地文件摘要。
 * 调用方按执行阶段提供适用的鉴权、取消信号及上下文校验，并负责候选顺序和回执结算。
 */
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

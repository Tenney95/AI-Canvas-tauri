/**
 * assetFormat — 资产文件展示相关的公共工具（AssetsPanel / AssetSearchWindow 共用）
 */
import type { FileCategory } from '../services/fileService';

/** 全部文件分类（固定顺序，用于分类筛选行）*/
export const ALL_CATEGORIES: FileCategory[] = ['image', 'video', 'audio', 'text', 'other'];

/** 各分类的图标 emoji */
export const CATEGORY_ICONS: Record<FileCategory, string> = {
  image: '🖼', video: '🎬', audio: '🎵', text: '📄', other: '📁',
};

/** 字节数格式化为可读大小 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 取路径最后一段作为短文件夹名 */
export function shortFolderName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

/**
 * assetSort — 按名称、类型或时间对资产文件生成排序副本。
 */
import type { AssetFileEntry } from '../services/fileService';
import type { AssetSortBy, AssetSortOrder } from '../types';

const naturalOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function compareIdentity(a: AssetFileEntry, b: AssetFileEntry): number {
  return naturalOrder.compare(a.name, b.name) || naturalOrder.compare(a.path, b.path)
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function knownTime(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 返回排序副本；可将文本固定置后，组内同值按名称、路径升序，未知时间排最后。 */
export function sortAssetFiles<T extends AssetFileEntry>(
  files: readonly T[], sortBy: AssetSortBy = 'name', order: AssetSortOrder = 'asc',
  usage?: ReadonlyMap<string, number>, textLast = false,
): T[] {
  const direction = order === 'desc' ? -1 : 1;
  return [...files].sort((a, b) => {
    if (textLast) {
      const categoryOrder = Number(a.category === 'text') - Number(b.category === 'text');
      if (categoryOrder) return categoryOrder;
    }
    let comparison = 0;
    if (sortBy === 'name') comparison = naturalOrder.compare(a.name, b.name);
    else if (sortBy === 'size') comparison = a.size - b.size;
    else {
      const first = knownTime(sortBy === 'usedAt' ? (a.assetId ? usage?.get(a.assetId) : undefined) : a[sortBy]);
      const second = knownTime(sortBy === 'usedAt' ? (b.assetId ? usage?.get(b.assetId) : undefined) : b[sortBy]);
      if (first === undefined || second === undefined) {
        if (first !== second) return first === undefined ? 1 : -1;
      } else comparison = first - second;
    }
    return comparison * direction || compareIdentity(a, b);
  });
}

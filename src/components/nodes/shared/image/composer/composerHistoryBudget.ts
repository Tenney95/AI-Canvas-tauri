import type { Layer } from '../../../../../types/composerTypes';
import {
  MAX_COMPOSER_SOURCE_RGBA_BYTES,
  estimateRgbaBytes,
} from '../imageResourceBudget';

export interface ComposerLayerSnapshot {
  layers: Layer[];
}

export interface TrimmedComposerHistory<TSnapshot extends ComposerLayerSnapshot> {
  past: TSnapshot[];
  future: TSnapshot[];
  totalBytes: number;
}

/**
 * 只回收已经不被当前图层、撤销/重做快照或排队中导入任务引用的 object URL。
 * `owned` 只包含合成器自己通过 URL.createObjectURL() 创建的地址，外部 URL 不在此处处理。
 */
export function releaseUnreachableComposerObjectUrls(
  owned: Set<string>,
  pending: Set<string>,
  layerGroups: Iterable<Layer[]>,
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
): void {
  const reachable = new Set<string>();
  for (const layers of layerGroups) {
    for (const layer of layers) {
      if (layer.type === 'image' && owned.has(layer.src)) reachable.add(layer.src);
    }
  }

  for (const url of Array.from(owned)) {
    if (pending.has(url) || reachable.has(url)) continue;
    owned.delete(url);
    revoke(url);
  }
}

function estimateUniqueImageBytes(layerGroups: Iterable<Layer[]>): number {
  const seenImages = new Set<object>();
  let totalBytes = 0;

  for (const layers of layerGroups) {
    for (const layer of layers) {
      if (layer.type !== 'image' || !layer.image || seenImages.has(layer.image)) continue;
      seenImages.add(layer.image);
      totalBytes += estimateRgbaBytes(layer.width, layer.height)?.bytes ?? 0;
    }
  }

  return totalBytes;
}

/**
 * 让当前图层始终优先保留，并从最远的撤销/重做快照开始淘汰。
 * 快照是浅拷贝，必须按 HTMLImageElement 对象去重，否则会高估共享位图。
 */
export function trimComposerHistoryToImageBudget<TSnapshot extends ComposerLayerSnapshot>(
  currentLayers: Layer[],
  past: TSnapshot[],
  future: TSnapshot[],
  maxBytes = MAX_COMPOSER_SOURCE_RGBA_BYTES,
  additionalBytes = 0,
): TrimmedComposerHistory<TSnapshot> {
  let retainedPast = past;
  let retainedFuture = future;

  const safeAdditionalBytes = Number.isFinite(additionalBytes) ? Math.max(0, additionalBytes) : 0;
  const estimate = (nextPast: TSnapshot[], nextFuture: TSnapshot[]) => (
    estimateUniqueImageBytes([
      currentLayers,
      ...nextPast.map((snapshot) => snapshot.layers),
      ...nextFuture.map((snapshot) => snapshot.layers),
    ]) + safeAdditionalBytes
  );

  let totalBytes = estimate(retainedPast, retainedFuture);
  while (totalBytes > maxBytes && (retainedPast.length > 0 || retainedFuture.length > 0)) {
    const pastCandidate = retainedPast.length > 0 ? retainedPast.slice(1) : retainedPast;
    const futureCandidate = retainedFuture.length > 0 ? retainedFuture.slice(1) : retainedFuture;
    const totalWithoutOldestPast = retainedPast.length > 0
      ? estimate(pastCandidate, retainedFuture)
      : Number.POSITIVE_INFINITY;
    const totalWithoutFarthestFuture = retainedFuture.length > 0
      ? estimate(retainedPast, futureCandidate)
      : Number.POSITIVE_INFINITY;

    if (totalWithoutOldestPast <= totalWithoutFarthestFuture) {
      retainedPast = pastCandidate;
      totalBytes = totalWithoutOldestPast;
    } else {
      retainedFuture = futureCandidate;
      totalBytes = totalWithoutFarthestFuture;
    }
  }

  return { past: retainedPast, future: retainedFuture, totalBytes };
}

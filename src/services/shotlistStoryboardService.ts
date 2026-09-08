/** 宫格真实裁片 → 图片节点 → 指定镜头；保留原宫格。 */
import type { BaseNodeData } from '../types';
import { getShotlist, type ShotlistScope } from './shotlistService';
import { useAppStore } from '../store/useAppStore';
import { generateId } from '../store/store.utils';
import { cropImageByRanges } from '../components/nodes/shared/image/imageUtils';
import { gridBoundaries } from '../utils/storyboardGrid';
import { buildNodeFileName, isTauriEnv, saveDataUrlToProjectData } from './fileService';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from './canvasDerivationGuard';
import { normalizeWatchedPath, REFERENCED_IMAGE_CHANGED_EVENT, type ReferencedImageChangedDetail } from '../hooks/useReferencedImageWatcher';

export function describeStoryboardGrid(data: BaseNodeData) {
  const rows = data.storyboardRows ?? 3;
  const cols = data.storyboardCols ?? 3;
  if (![rows, cols].every((count) => Number.isInteger(count) && count > 0 && count <= 20)) throw new Error('宫格尺寸无效');
  const hRanges = gridBoundaries(rows, data.storyboardRowPositions);
  const vRanges = gridBoundaries(cols, data.storyboardColPositions);
  for (const [ranges, count] of [[hRanges, rows], [vRanges, cols]] as const) {
    if (ranges.length !== count + 1 || ranges.some((value, index) => !Number.isFinite(value)
      || value < 0 || value > 100 || (index > 0 && value <= ranges[index - 1]))) throw new Error('宫格分割线无效');
  }
  return { rows, cols, hRanges, vRanges };
}

function sourceFingerprint(data: BaseNodeData) {
  return JSON.stringify([data.imageUrl, data.thumbnailUrl, data.filePath, data.storyboardRows, data.storyboardCols,
    data.storyboardRowPositions, data.storyboardColPositions, data.storyboardOverrides, data.storyboardExtracted]);
}

function waitForCrop<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error('取画面已取消'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

export async function bindStoryboardCellToShot(input: ShotlistScope & {
  nodeId: string; rowId: string; storyboardId: string; cellIndex: number; replaceExisting?: boolean; signal?: AbortSignal;
}) {
  const { state, node: sheet, rows } = getShotlist(input, input.nodeId);
  const row = rows.find((item) => item.id === input.rowId);
  const storyboard = state.nodes.find((item) => item.id === input.storyboardId && item.type === 'ai-storyboard');
  if (!row || !storyboard) throw new Error('镜头或宫格已不存在');
  if (row.frame && !input.replaceExisting) throw new Error('镜头已有画面，请明确选择替换');
  const grid = describeStoryboardGrid(storyboard.data);
  if (!Number.isInteger(input.cellIndex) || input.cellIndex < 0 || input.cellIndex >= grid.rows * grid.cols) throw new Error('宫格位置无效');
  const override = storyboard.data.storyboardOverrides?.[input.cellIndex];
  if (!override && storyboard.data.storyboardExtracted?.[input.cellIndex]) throw new Error('此宫格位置已为空，请选择其他格');
  const url = override?.url || storyboard.data.imageUrl || storyboard.data.thumbnailUrl;
  if (!url) throw new Error('宫格没有可读取的图片');
  const guard = registerCanvasDerivation(state, storyboard.id);
  if (!guard) throw new Error('宫格来源已失效');
  const fingerprint = sourceFingerprint(storyboard.data);
  const rowSnapshot = JSON.stringify(row);
  const watchedPaths = new Set([storyboard.data.filePath, override?.filePath].filter((path): path is string => !!path).map(normalizeWatchedPath));
  let sourceChanged = false;
  const onSourceChanged = (event: Event) => {
    const detail = (event as CustomEvent<ReferencedImageChangedDetail>).detail;
    if (Array.isArray(detail?.paths) && detail.paths.some((path) => watchedPaths.has(normalizeWatchedPath(path)))) sourceChanged = true;
  };
  const assertFresh = () => {
    const current = useAppStore.getState();
    const currentSource = current.nodes.find((item) => item.id === storyboard.id);
    const currentRow = current.nodes.find((item) => item.id === sheet.id)?.data.shotlistRows?.find((item) => item.id === row.id);
    if (input.signal?.aborted) throw new Error('取画面已取消');
    if (sourceChanged || current.projectLoadStatus !== 'ready' || !isCanvasDerivationFresh(guard, current)
      || !currentSource || sourceFingerprint(currentSource.data) !== fingerprint || JSON.stringify(currentRow) !== rowSnapshot) {
      throw new Error('宫格或镜头已变化，请重新选择');
    }
  };
  if (typeof window !== 'undefined') window.addEventListener(REFERENCED_IMAGE_CHANGED_EVENT, onSourceChanged);
  try {
    assertFresh();
    const cell = await waitForCrop(cropImageByRanges(url, override ? [0, 100] : grid.hRanges, override ? [0, 100] : grid.vRanges,
      override ? 0 : Math.floor(input.cellIndex / grid.cols), override ? 0 : input.cellIndex % grid.cols), input.signal)
      .catch(() => { throw new Error(input.signal?.aborted ? '取画面已取消' : '宫格裁切失败，未修改镜头画面'); });
    assertFresh();
    const label = `镜${row.shotNo.slice(0, 48)} 宫格画面`;
    const saved = isTauriEnv() ? await saveDataUrlToProjectData(cell.dataUrl, input.projectId,
      buildNodeFileName(label, 'png', 'grid'), { deduplicateByContent: true }) : null;
    assertFresh();
    if (isTauriEnv() && (!saved?.filePath || !saved.assetUrl)) throw new Error('裁片保存失败，未修改镜头画面');
    const imageId = `node-${generateId()}`;
    const imageUrl = saved?.assetUrl || cell.dataUrl;
    const current = useAppStore.getState();
    current.addNodesWithEdges([{ id: imageId, type: 'source-image', parentId: sheet.parentId,
      position: { x: sheet.position.x - 360, y: sheet.position.y + rows.indexOf(row) * 210 }, data: {
        type: 'source-image', label, role: 'source', status: 'success', imageUrl, filePath: saved?.filePath,
        imageWidth: cell.width, imageHeight: cell.height, nodeWidth: 280, nodeHeight: Math.max(100, Math.min(400, 280 * cell.height / cell.width)),
      } }], [{ id: generateId(), source: imageId, target: sheet.id, sourceHandle: 'right', targetHandle: 'left' }]);
    const currentRows = current.nodes.find((item) => item.id === sheet.id)!.data.shotlistRows!;
    current.updateNodeDataTransient(sheet.id, { shotlistRows: currentRows.map((item) => item.id === row.id
      ? { ...item, frame: { nodeId: imageId, kind: 'image', url: imageUrl, filePath: saved?.filePath } } : item) });
    current.incrementRevision();
    return { nodeId: imageId, rowId: row.id, storyboardId: storyboard.id, cellIndex: input.cellIndex };
  } finally {
    completeCanvasDerivation(guard);
    if (typeof window !== 'undefined') window.removeEventListener(REFERENCED_IMAGE_CHANGED_EVENT, onSourceChanged);
  }
}

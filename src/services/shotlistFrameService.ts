/** 有界、可取消的补空镜操作；完成图片留在画布上，旧镜头不会被异步覆盖。 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import type { ShotRow } from '../types/shotlist';
import { buildShotFramePrompt } from '../types/shotlist';
import { useAppStore } from '../store/useAppStore';
import { generateId } from '../store/store.utils';
import { findMediaModelOption } from '../components/nodes/shared/defaultModels';
import { generateImage } from './ai/generateImage';
import { persistMediaUrlToProjectData } from './fileService';
import { resolveProjectGenerationPrompt } from './projectSettingsService';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from './canvasDerivationGuard';
import { getShotlist, type ShotlistScope } from './shotlistService';

export const MAX_SHOTLIST_FRAME_BATCH = 12;
const activeBatches = new Set<string>();

function frameRequestFingerprint(data?: BaseNodeData): string {
  return JSON.stringify([data?.prompt, data?.model, data?.provider, data?.workflowId,
    data?.workflowInputs, data?.imageSize, data?.aspectRatio]);
}

/** 下游可能不能及时中止；停止本地等待后不再消费其迟到结果。 */
function waitForFrameOperation<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('补图已取消', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(new DOMException('补图已取消', 'AbortError')); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      operation().then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    } catch (error) { cleanup(); reject(error); }
  });
}

export interface ShotFrameResult {
  rowId: string;
  nodeId?: string;
  status: 'success' | 'skipped' | 'error' | 'cancelled' | 'stale';
}

export interface ShotFrameBatchInput extends ShotlistScope {
  nodeId: string;
  rowIds: string[];
  modelRef: string;
  /** 仅 UI 单镜编辑器提供的提示词覆盖。 */
  prompts?: Record<string, string>;
  /** 保留单镜「换画面」入口；批量与 Agent 补空镜不启用。 */
  replaceExisting?: boolean;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number, rowId?: string) => void;
}

export async function generateShotlistFrames(input: ShotFrameBatchInput): Promise<ShotFrameResult[]> {
  const { state, node: sheet, rows } = getShotlist(input, input.nodeId);
  if (!input.rowIds.length || input.rowIds.length > MAX_SHOTLIST_FRAME_BATCH
    || new Set(input.rowIds).size !== input.rowIds.length) throw new Error(`每次请选择 1 到 ${MAX_SHOTLIST_FRAME_BATCH} 个不同镜头`);
  const key = `${input.projectId}/${input.nodeId}`;
  if (activeBatches.has(key)) throw new Error('这张分镜表正在补图，请等待完成或取消');
  if (input.signal?.aborted) return input.rowIds.map((rowId) => ({ rowId, status: 'cancelled' }));
  const model = findMediaModelOption(input.modelRef, state.config.generalModels ?? [], state.config, state.workflows);
  if (!model || model.mediaKind !== 'image') throw new Error('请选择已配置的图片模型');
  const selected = input.rowIds.map((rowId) => {
    const row = rows.find((item) => item.id === rowId);
    if (!row) throw new Error('镜头已删除，请重新选择');
    return row;
  });
  const results: ShotFrameResult[] = [];
  const settings = state.projects.find((project) => project.id === input.projectId)?.settings;
  const targets = selected.flatMap((row) => {
    const prompt = (input.prompts?.[row.id] ?? buildShotFramePrompt(row)).trim();
    if ((row.frame && !input.replaceExisting) || !prompt) {
      results.push({ rowId: row.id, status: 'skipped' });
      return [];
    }
    const rowIndex = rows.findIndex((item) => item.id === row.id);
    const image: Node<BaseNodeData> = {
      id: `node-${generateId()}`, type: 'ai-image', parentId: sheet.parentId,
      position: { x: sheet.position.x - 360, y: sheet.position.y + rowIndex * 210 },
      data: {
        type: 'ai-image', label: `${sheet.data.label || '分镜表'} 镜${row.shotNo}`, role: 'generator',
        status: 'idle', prompt, model: model.value, provider: model.provider,
        ...(model.workflowId ? { workflowId: model.workflowId } : {}),
        nodeWidth: 280, nodeHeight: 180,
      },
    };
    return [{ row, image, fingerprint: JSON.stringify(row) }];
  });
  if (!targets.length) return results;

  activeBatches.add(key);
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
    // 项目离开前同步结束本批占位状态，避免保存下一次打开仍显示生成中。
    const current = useAppStore.getState();
    if (current.currentProjectId !== input.projectId) return;
    for (const { image } of targets) {
      const node = current.nodes.find((item) => item.id === image.id);
      if (node?.data.status === 'loading') current.updateNodeDataTransient(image.id, { status: 'idle' });
    }
  };
  input.signal?.addEventListener('abort', cancel, { once: true });
  let guard: ReturnType<typeof registerCanvasDerivation> = null;
  try {
    state.addNodesWithEdges(targets.map((target) => target.image), targets.map(({ image }) => ({
      id: generateId(), source: image.id, target: sheet.id, sourceHandle: 'right', targetHandle: 'left',
    })));
    state.incrementRevision();
    const requestSnapshots = new Map(targets.map(({ image }) => [image.id,
      frameRequestFingerprint(useAppStore.getState().nodes.find((node) => node.id === image.id)?.data)]));
    guard = registerCanvasDerivation(useAppStore.getState(), sheet.id, { onCancel: cancel });
    if (!guard) throw new Error('分镜上下文已失效');
    const fresh = () => !!guard && isCanvasDerivationFresh(guard, useAppStore.getState());
    for (const target of targets) {
      const { row, image, fingerprint } = target;
      if (controller.signal.aborted || !fresh()) {
        results.push({ rowId: row.id, nodeId: image.id, status: controller.signal.aborted ? 'cancelled' : 'stale' });
        continue;
      }
      const current = useAppStore.getState();
      const latestRow = current.nodes.find((item) => item.id === sheet.id)?.data.shotlistRows?.find((item) => item.id === row.id);
      const imageData = current.nodes.find((item) => item.id === image.id)?.data;
      const requestFingerprint = requestSnapshots.get(image.id);
      if (!imageData || frameRequestFingerprint(imageData) !== requestFingerprint || JSON.stringify(latestRow) !== fingerprint) {
        results.push({ rowId: row.id, nodeId: image.id, status: 'stale' });
        continue;
      }
      const prompt = resolveProjectGenerationPrompt({ prompt: imageData.prompt || '', data: imageData, settings, customStyles: state.customStyles });
      const imageUnchanged = () => {
        const data = useAppStore.getState().nodes.find((item) => item.id === image.id)?.data;
        return !!data && frameRequestFingerprint(data) === requestFingerprint;
      };
      input.onProgress?.(results.length, selected.length, row.id);
      current.updateNodeDataTransient(image.id, { status: 'loading', error: undefined });
      try {
        if (!fresh() || !imageUnchanged()) {
          results.push({ rowId: row.id, nodeId: image.id, status: 'stale' });
          continue;
        }
        const generated = await waitForFrameOperation(() => generateImage({
          prompt, model: model.value, provider: model.provider, nodeId: image.id,
          imageSize: imageData.imageSize || '2K', aspectRatio: imageData.aspectRatio || '16:9',
          workflowId: model.workflowId, workflowInputs: imageData.workflowInputs,
        }, controller.signal), controller.signal);
        if (controller.signal.aborted || !fresh() || !imageUnchanged()) {
          results.push({ rowId: row.id, nodeId: image.id, status: controller.signal.aborted ? 'cancelled' : 'stale' });
          continue;
        }
        const persisted = await waitForFrameOperation(() => persistMediaUrlToProjectData(
          generated.url, input.projectId, 'ai-image', imageData.label,
        ), controller.signal);
        if (controller.signal.aborted || !fresh() || !imageUnchanged()) {
          results.push({ rowId: row.id, nodeId: image.id, status: controller.signal.aborted ? 'cancelled' : 'stale' });
          continue;
        }
        const latest = useAppStore.getState();
        latest.updateNodeDataTransient(image.id, {
          imageUrl: persisted.mediaUrl, thumbnailUrl: persisted.mediaUrl, sourceUrl: persisted.sourceUrl,
          filePath: persisted.filePath, output: persisted.sourceUrl, imageWidth: generated.width, imageHeight: generated.height,
          status: 'success', error: undefined,
        });
        const latestRows = latest.nodes.find((item) => item.id === sheet.id)?.data.shotlistRows ?? [];
        const canBind = JSON.stringify(latestRows.find((item) => item.id === row.id)) === fingerprint;
        if (canBind) {
          const frame: NonNullable<ShotRow['frame']> = {
            nodeId: image.id, kind: 'image', url: persisted.mediaUrl, filePath: persisted.filePath,
          };
          latest.updateNodeDataTransient(sheet.id, {
            shotlistRows: latestRows.map((item) => item.id === row.id ? { ...item, frame } : item),
          });
        }
        latest.recordOutputHistory(image.id, {
          nodeId: image.id, nodeLabel: imageData.label, timestamp: Date.now(), prompt, output: persisted.sourceUrl,
          nodeType: 'ai-image', model: model.value, provider: model.provider, status: 'success',
          mediaUrl: persisted.mediaUrl, filePath: persisted.filePath,
        });
        results.push({ rowId: row.id, nodeId: image.id, status: canBind ? 'success' : 'stale' });
      } catch {
        const cancelled = controller.signal.aborted;
        if (fresh() && imageUnchanged()) {
          useAppStore.getState().updateNodeDataTransient(image.id, {
            status: cancelled ? 'idle' : 'error', error: cancelled ? undefined : '补图失败，可在图片节点查看配置后重试',
          });
        }
        results.push({ rowId: row.id, nodeId: image.id, status: cancelled ? 'cancelled' : 'error' });
      } finally {
        // 参数编辑不启动新生成（各入口拒绝 loading 节点）；本批占位节点仍需结束旧请求状态。
        if (useAppStore.getState().currentProjectId === input.projectId
          && useAppStore.getState().nodes.find((item) => item.id === image.id)?.data.status === 'loading') {
          useAppStore.getState().updateNodeDataTransient(image.id, { status: 'idle' });
        }
        input.onProgress?.(results.length, selected.length);
      }
    }
    if (fresh()) useAppStore.getState().incrementRevision();
    return results;
  } finally {
    if (guard) completeCanvasDerivation(guard);
    input.signal?.removeEventListener('abort', cancel);
    activeBatches.delete(key);
  }
}

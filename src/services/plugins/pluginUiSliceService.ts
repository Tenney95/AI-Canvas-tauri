import { invoke, isTauri } from '@tauri-apps/api/core';
import type { PluginInvocationResources } from '../../types/plugin';
import { resolvePluginUiSliceSource, type PluginResourceReadContext } from './pluginResourceService';

export const UI_SLICE_PLUGIN_ID = 'ai-canvas.ui-slice';
export const UI_SLICE_TOOL_ID = 'slice-image';

type UiSliceEffect = 'image.uiSlice.inspect' | 'image.uiSlice.publish' | 'image.uiSlice.openDraft';

export function isUiSliceEffect(type: unknown): type is UiSliceEffect {
  return type === 'image.uiSlice.inspect' || type === 'image.uiSlice.publish' || type === 'image.uiSlice.openDraft';
}

interface ImageSnapshot {
  sourceSha256: string;
  width: number;
  height: number;
}

interface DraftFile {
  path: string;
  version: string;
}

export interface UiSliceSessionState {
  snapshot?: ImageSnapshot & { verifiedColorInterpretations: Set<boolean> };
  drafts?: Map<string, DraftFile>;
}

function rememberSnapshot(state: UiSliceSessionState, snapshot: ImageSnapshot, assumeSrgb: boolean) {
  if (state.snapshot?.sourceSha256 === snapshot.sourceSha256) state.snapshot.verifiedColorInterpretations.add(assumeSrgb);
  else state.snapshot = { ...snapshot, verifiedColorInterpretations: new Set([assumeSrgb]) };
}

interface Options {
  type: UiSliceEffect;
  nativeWindow: boolean;
  payload: unknown;
  context: PluginResourceReadContext;
  resources: PluginInvocationResources;
  state: UiSliceSessionState;
  signal: AbortSignal;
  assertFresh: () => void;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('切图参数格式无效');
  return value as Record<string, unknown>;
}

function readItems(value: unknown, snapshot: ImageSnapshot) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) throw new Error('请选择 1–128 个素材');
  let totalPixels = 0;
  return value.map((input: unknown) => {
    const { label, rect, rings } = object(input);
    if (typeof label !== 'string' || !label.trim() || [...label].length > 80 || /\p{Cc}/u.test(label)) {
      throw new Error('素材名称无效');
    }
    const coordinates = object(rect);
    const { x0, y0, x1, y1 } = coordinates;
    if (typeof x0 !== 'number' || typeof y0 !== 'number' || typeof x1 !== 'number' || typeof y1 !== 'number'
      || ![x0, y0, x1, y1].every(Number.isSafeInteger) || x0 < 0 || y0 < 0 || x0 >= x1 || y0 >= y1
      || x1 > snapshot.width || y1 > snapshot.height) throw new Error('素材坐标超出原图范围');
    const pixels = (x1 - x0) * (y1 - y0);
    totalPixels += pixels;
    if (pixels > 8_000_000 || totalPixels > 64_000_000) throw new Error('单片或整批输出像素超限');
    let vertices = 0;
    if (!Array.isArray(rings) || rings.length > 16) throw new Error('套索环数超限');
    const polygon = rings.map((ring: unknown) => {
      if (!Array.isArray(ring) || ring.length < 3 || (vertices += ring.length) > 128) {
        throw new Error('套索顶点数量无效');
      }
      return ring.map((point: unknown) => {
        if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isSafeInteger)
          || point[0] < x0 || point[0] > x1 || point[1] < y0 || point[1] > y1) {
          throw new Error('套索顶点超出素材框');
        }
        return [point[0], point[1]];
      });
    });
    return { label, rect: { x0, y0, x1, y1 }, rings: polygon };
  });
}

function readMissing(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) throw new Error('待补项超过 256 项');
  return value.map((entry: unknown) => {
    const { name, reason, box } = object(entry);
    if (typeof name !== 'string' || !name.trim() || [...name].length > 64 || /\p{Cc}/u.test(name)
      || typeof reason !== 'string' || !reason.trim() || [...reason].length > 120 || /\p{Cc}/u.test(reason)) {
      throw new Error('待补项名称或原因无效');
    }
    if (box !== undefined && (!Array.isArray(box) || box.length !== 4
      || !box.every((coordinate) => Number.isInteger(coordinate) && coordinate >= 0 && coordinate <= 1000)
      || box[0] >= box[2] || box[1] >= box[3])) throw new Error('待补项位置无效');
    return box === undefined ? { name, reason } : { name, reason, box };
  });
}

export async function executePluginUiSlice(options: Options) {
  const { type, context, resources, signal, assertFresh, state } = options;
  if (!isTauri()) throw new Error('切图需要 AI Canvas 桌面端');
  const input = object(options.payload);
  const sourcePath = await resolvePluginUiSliceSource(context, resources);
  const requestId = crypto.randomUUID();
  const identity = {
    pluginId: context.pluginId, toolId: UI_SLICE_TOOL_ID, sourceDigest: context.sourceDigest,
    revisionDigest: context.revisionDigest, invocationId: context.invocationId,
  };
  const assertActive = () => {
    if (signal.aborted) throw new Error('切图操作已取消');
    assertFresh();
  };
  const execute = async <T,>(effect: Record<string, unknown>): Promise<T> => {
    assertActive();
    const cancel = () => {
      void invoke('cancel_plugin_host_effect', { pluginId: context.pluginId, requestId }).catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      return await invoke<T>('execute_plugin_host_effect', { identity, requestId, effect });
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  };
  if (type === 'image.uiSlice.inspect') {
    if (typeof input.assumeSrgb !== 'boolean') throw new Error('色彩确认参数无效');
    const info = await execute<ImageSnapshot & { previewPngBase64: string }>(
      { type, sourcePath, assumeSrgb: input.assumeSrgb },
    );
    assertActive();
    rememberSnapshot(state, { sourceSha256: info.sourceSha256, width: info.width, height: info.height }, input.assumeSrgb);
    return { ...info, supportsDraftSaveAs: true };
  }
  if (type === 'image.uiSlice.openDraft') {
    if (typeof input.assumeSrgb !== 'boolean') throw new Error('色彩确认参数无效');
    const archivePath = await execute<string | null>({ type: 'image.uiSlice.pick', purpose: 'openDraft', nativeWindow: options.nativeWindow });
    if (typeof archivePath !== 'string') return { cancelled: true };
    const { draft, ...info } = await execute<ImageSnapshot & {
      previewPngBase64: string; items: unknown; missing: unknown; draft: DraftFile;
    }>(
      { type, sourcePath, archivePath, assumeSrgb: input.assumeSrgb },
    );
    assertActive();
    const currentPath = await resolvePluginUiSliceSource(context, resources);
    assertActive();
    if (currentPath !== sourcePath) throw new Error('源图已改变，请重新打开切图界面');
    const snapshot = { sourceSha256: info.sourceSha256, width: info.width, height: info.height };
    if (!Array.isArray(info.items)) throw new Error('工作稿选区无效');
    const items = readItems(info.items.map((item: unknown) => {
      const entry = object(item);
      return { ...entry, rings: entry.rings ?? [] };
    }), snapshot);
    const missing = readMissing(info.missing);
    rememberSnapshot(state, snapshot, input.assumeSrgb);
    (state.drafts ??= new Map()).set(requestId, draft);
    return { ...info, items, missing, draftRef: requestId, supportsDraftSaveAs: true };
  }
  const snapshot = state.snapshot;
  const { assumeSrgb } = input;
  if (!snapshot || snapshot.sourceSha256 !== input.sourceSha256 || typeof assumeSrgb !== 'boolean'
    || !snapshot.verifiedColorInterpretations.has(assumeSrgb)) {
    throw new Error('图片或色彩解释已变化，请重新分析并审核选区');
  }
  const items = readItems(input.items, snapshot);
  const missing = readMissing(input.missing);
  const includeSource = input.includeSource === true;
  const newDraft = includeSource && input.newDraft === true;
  let overwriteDraft: DraftFile | undefined;
  let directory: string | undefined;
  if (includeSource && input.draftRef !== undefined) {
    overwriteDraft = typeof input.draftRef === 'string' ? state.drafts?.get(input.draftRef) : undefined;
    if (!overwriteDraft || newDraft) throw new Error('当前草稿关联已失效，请重新打开草稿或另存为');
  } else {
    const selected = await execute<string | null>({
      type: 'image.uiSlice.pick', purpose: includeSource ? 'saveDraft' : 'export', nativeWindow: options.nativeWindow,
    });
    if (typeof selected !== 'string') return { cancelled: true };
    directory = selected;
  }
  await resolvePluginUiSliceSource(context, resources).then((currentPath) => {
    if (currentPath !== sourcePath) throw new Error('源图已改变，请重新打开切图界面');
  });
  const { draft, ...receipt } = await execute<{ draft?: DraftFile; fileName: string; assetCount: number }>(
    { type, sourcePath, directory, items, missing, includeSource, newDraft, overwriteDraft,
      sourceSha256: snapshot.sourceSha256, assumeSrgb },
  );
  assertActive();
  if (!draft) return receipt;
  const draftRef = overwriteDraft && typeof input.draftRef === 'string' ? input.draftRef : requestId;
  (state.drafts ??= new Map()).set(draftRef, draft);
  return { ...receipt, draftRef };
}

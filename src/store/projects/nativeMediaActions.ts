import type { StoreApi } from 'zustand';
import type { Node } from '@xyflow/react';
import type { AppState } from '../useAppStore';
import type { BaseNodeData } from '../../types';
import { normalizeProjectMediaNodes } from '../../services/storageService';
import { isProjectExpectedContextCurrent } from '../../services/projectExecutionContext';
import { matchesNativeCanvasMediaInputFingerprint, nativeCanvasMediaInputMaterial } from '../../services/nativeMediaInput';
import {
  readNativeProjectContent, readNativeProjectSelection,
} from '../../services/indexedDb/nativeProjectRepository';
import { restoreProjectRecord } from '../../services/storageService';
import { configValuesEqual } from '../../services/configPatch';
import type { ProjectSlice, ProjectSliceGet, ProjectSliceSet, NativeMediaContext } from '../store.projects';

/** complete事件前已经发生的编辑按字段保留；媒体只补原节点的未被改写结果及稳定候选。 */
function rebaseCommittedMediaNodes(before: Node<BaseNodeData>[], current: Node<BaseNodeData>[], delivered: Node<BaseNodeData>[], nodeId: string): Node<BaseNodeData>[] {
  const previous = before.find((node) => node.id === nodeId), next = delivered.find((node) => node.id === nodeId), target = current.find((node) => node.id === nodeId);
  if (!previous || !next || !target || target.data.type !== previous.data.type) return current;
  const original = previous.data as unknown as Record<string, unknown>, result = next.data as unknown as Record<string, unknown>, live = target.data as unknown as Record<string, unknown>;
  if (['imageUrl', 'audioUrl', 'videoUrl', 'relativePath', 'filePath', 'assetId', 'sourceUrl', 'output', 'storageRootRef', 'artifactId', 'animationSheet', 'animationEdits', 'outpaintInput']
    .some((field) => !configValuesEqual(live[field], original[field]))) return current;
  const data = { ...live };
  for (const field of new Set([...Object.keys(original), ...Object.keys(result)])) {
    if (configValuesEqual(original[field], result[field]) || !configValuesEqual(live[field], original[field])) continue;
    if (Object.hasOwn(result, field)) data[field] = result[field]; else delete data[field];
  }
  const changed = current.map((node) => node.id === nodeId ? { ...node, data: data as unknown as BaseNodeData } : node);
  const existingIds = new Set([...before, ...current].map((node) => node.id));
  return [...changed, ...delivered.filter((node) => !existingIds.has(node.id))];
}

const NORMALIZED_MEDIA_FIELDS = [
  'assetId', 'relativePath', 'filePath', 'storageRootRef',
  'imageUrl', 'videoUrl', 'audioUrl', 'thumbnailUrl', 'sourceUrl', 'output', 'mattingMask', 'annotation', 'outpaintInput',
  'storyboardOverrides', 'shotlistRows', 'videoReferences', 'runninghubOutputs', 'workflowApiOutputs',
  'directorCaptureUrls', 'directorCaptureFilePaths', 'directorCaptureRelativePaths', '__nativeUnavailableMediaFields',
] as const satisfies readonly (keyof BaseNodeData)[];

export function createNativeMediaActions(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
  api: StoreApi<AppState>,
  context: NativeMediaContext,
): Pick<ProjectSlice,
  | 'normalizeNativeMediaGenerationInputs'
  | 'beginNativeMediaSubmissionPreparation'
  | 'commitNativeMediaResult'
> {
  const {
    nativeRuntime, saveNativeCurrentProject, projectAssetSyncBarriers, projectImportsApplying,
    createCurrentProjectSaveRecord,
  } = context;
  return {
    normalizeNativeMediaGenerationInputs: async (nodeId, input) => {
      const before = get(), context = before.projectExecutionContext;
      if (context?.modelGeneration !== 1) return { targetPatch: {}, nodePatches: new Map() };
      const runtime = nativeRuntime.get(get), target = before.nodes.find((node) => node.id === nodeId);
      if (context.kind !== 'canvas' || !runtime || runtime.activeId !== context.canvasId || !target) {
        throw new Error('原画布或生成节点已变化，未准备参考素材');
      }
      const revision = before.getCurrentRevision();
      const material = nativeCanvasMediaInputMaterial(target, before, 'media-input-v3');
      const references = new Set([nodeId, ...before.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source)]);
      const parameters = input ?? target.data;
      const mentionText = JSON.stringify([parameters.prompt, parameters.workflowInputs, parameters.videoReferences,
        parameters.comfyRefmods, parameters.cameraSettings]);
      const byId = new Map(before.nodes.map((node) => [node.id, node]));
      for (const match of mentionText.matchAll(/@\{([^}:]+)(?::[^}]*)?\}/g)) {
        references.add(byId.has(match[1]) ? match[1] : match[1].split(/\/(?:cell|shot)\//)[0]);
      }
      const originals = before.nodes.filter((node) => references.has(node.id));
      const assertCurrent = () => {
        const current = get(), live = current.nodes.find((node) => node.id === nodeId);
        if (nativeRuntime.get(get) !== runtime || projectImportsApplying.has(context.projectId)
          || projectAssetSyncBarriers.has(context.projectId) || current.getCurrentRevision() !== revision
          || !isProjectExpectedContextCurrent(context, current, { checkCanvasRevision: false }) || !live
          || nativeCanvasMediaInputMaterial(live, current, 'media-input-v3') !== material) {
          throw new Error('生成输入或参考素材已变化，未提交请求');
        }
        const liveById = new Map(current.nodes.map((node) => [node.id, node]));
        for (const original of originals) {
          const node = liveById.get(original.id);
          if (!node || node.type !== original.type || NORMALIZED_MEDIA_FIELDS.some((field) => (
            !configValuesEqual(node.data[field], original.data[field])
          ))) throw new Error('节点媒体已变化，未覆盖新内容');
        }
      };
      assertCurrent();
      let normalized: Node<BaseNodeData>[];
      try { normalized = await normalizeProjectMediaNodes(context.canvasId, originals); }
      catch {
        assertCurrent();
        throw new Error('参考素材身份准备失败，请检查文件后重试');
      }
      assertCurrent();
      const normalizedById = new Map(normalized.map((node) => [node.id, node]));
      const originalById = new Map(originals.map((node) => [node.id, node]));
      const targetPatch: Partial<BaseNodeData> = {};
      const nodePatches = new Map<string, Partial<BaseNodeData>>();
      set((state) => {
        let changed = false;
        const nodes = state.nodes.map((node) => {
          const original = originalById.get(node.id), resolved = normalizedById.get(node.id);
          if (!original || !resolved) return node;
          let data: BaseNodeData | undefined;
          const patch: Partial<BaseNodeData> = {};
          for (const field of NORMALIZED_MEDIA_FIELDS) {
            if (configValuesEqual(original.data[field], resolved.data[field])) continue;
            data ??= { ...node.data };
            if (Object.hasOwn(resolved.data, field)) data[field] = resolved.data[field] as never;
            else delete data[field];
            patch[field] = resolved.data[field] as never;
            if (node.id === nodeId) targetPatch[field] = resolved.data[field] as never;
          }
          if (!data) return node;
          nodePatches.set(node.id, patch);
          changed = true;
          return { ...node, data };
        });
        return changed ? { nodes } : state;
      });
      return { targetPatch, nodePatches };
    },

    beginNativeMediaSubmissionPreparation: async (expected) => {
      const context = structuredClone(expected), runtime = nativeRuntime.get(get);
      const assertContext = () => {
        const state = get();
        if (context.modelGeneration !== 1 || !context.runtimeEpoch || !runtime || nativeRuntime.get(get) !== runtime
          || runtime.activeId !== context.canvasId || projectImportsApplying.has(context.projectId)
          || projectAssetSyncBarriers.has(context.projectId)
          || !isProjectExpectedContextCurrent(context, state, { checkCanvasRevision: false })) throw new Error('原画布准备上下文已变化，未提交生成');
      };
      assertContext();
      if (!runtime) throw new Error('原画布保存基线不可用');
      const prior = runtime.tail;
      let unlock!: () => void, released = false, ready = false;
      runtime.tail = new Promise<void>((resolve) => { unlock = resolve; });
      const release = () => { if (!released) { released = true; unlock(); } };
      try {
        // 先占原队列位置，再读取fresh状态强制保存；不能在自己的slot内重排saveSilent。
        await prior; assertContext();
        const state = get(), record = createCurrentProjectSaveRecord(state);
        if (!record || record.id !== context.canvasId) throw new Error('原画布准备保存上下文不可用');
        await saveNativeCurrentProject(get, state, record, assertContext, runtime);
        assertContext();
        const canvas = runtime.loaded.selection.canvas;
        if (!canvas || canvas.id !== context.canvasId) throw new Error('原画布准备基线不可用');
        ready = true;
        return Object.freeze({ context: Object.freeze(context), canvasRevision: canvas.revision,
          assertCurrent: () => { if (released || !ready) throw new Error('媒体提交准备租约已释放'); assertContext(); }, release });
      } catch (error) { release(); throw error; }
    },

    commitNativeMediaResult: async (record, relativePath, expected, signal) => {
      signal?.throwIfAborted();
      const { safeExchangePath } = await import('../../services/projectExchangeDomain');
      const scheme = record.fingerprintScheme;
      if (record.category !== 'video' && scheme !== 'media-input-v2' && scheme !== 'media-input-v3' || safeExchangePath(relativePath) !== relativePath
        || expected.kind !== 'canvas' || expected.canvasId !== record.canvasId || expected.projectId !== record.ownerProjectId
        || !isProjectExpectedContextCurrent(expected, get(), { checkCanvasRevision: false })) throw new Error('原画布已切换，媒体结果已保留');
      const assertSource = async () => {
        signal?.throwIfAborted();
        const state = get(), node = state.nodes.find((item) => item.id === record.nodeId);
        if (!node) throw new Error('原媒体节点或参考素材已变化，结果已保留');
        const material = nativeCanvasMediaInputMaterial(node, state, scheme);
        if (material.includes('@drama{') && !record.recovery) throw new Error('原视频引用了尚不可安全验证的全局素材，结果已保留');
        const matches = await matchesNativeCanvasMediaInputFingerprint(node, state, scheme, material, record.inputFingerprint);
        const latest = get(), latestNode = latest.nodes.find((item) => item.id === record.nodeId);
        if (!latestNode || !isProjectExpectedContextCurrent(expected, latest, { checkCanvasRevision: false })) throw new Error('原画布或媒体节点已变化，结果已保留');
        if (!matches || material !== nativeCanvasMediaInputMaterial(latestNode, latest, scheme)) {
          const error = new Error('原媒体节点或参考素材已变化，结果已保留');
          error.name = 'NativeMediaInputChanged';
          throw error;
        }
        return material;
      };
      await assertSource();
      if (await get().saveCurrentProjectSilent() !== record.canvasId
        || !isProjectExpectedContextCurrent(expected, get(), { checkCanvasRevision: false })) throw new Error('原画布保存失败或已切换，媒体结果已保留');
      const runtime = nativeRuntime.get(get);
      if (!runtime || runtime.activeId !== record.canvasId || (runtime.mediaGeneration ?? 0) >= Number.MAX_SAFE_INTEGER) throw new Error('原画布保存基线不可用，媒体结果已保留');
      const prior = runtime.tail;
      let release!: () => void;
      runtime.tail = new Promise<void>((resolve) => { release = resolve; });
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) controller.abort();
      let unsubscribe = () => {};
      try {
        await prior;
        const material = await assertSource();
        if (nativeRuntime.get(get) !== runtime) throw new Error('原画布已重新加载，媒体结果保留');
        const expectedCanvasRevision = runtime.loaded.selection.canvas?.revision;
        const expectedAssetsRevision = runtime.loaded.content.revisions.assets;
        const before = get();
        const assertCurrent = () => {
          controller.signal.throwIfAborted();
          const current = get(), node = current.nodes.find((item) => item.id === record.nodeId);
          if (nativeRuntime.get(get) !== runtime || !node || current.nodes !== before.nodes || current.edges !== before.edges
            || current.groups !== before.groups || (scheme !== 'media-input-v3' && current.dramaAssets !== before.dramaAssets)
            || nativeCanvasMediaInputMaterial(node, current, scheme) !== material
            || !isProjectExpectedContextCurrent(expected, current, { checkCanvasRevision: false })) throw new Error('原画布在媒体交付期间变化，产物已保留');
        };
        unsubscribe = api.subscribe(() => { try { assertCurrent(); } catch { controller.abort(); } });
        assertCurrent();
        if (record.imageReference) {
          const { readNativeVideoImageReference } = await import('../../services/nativeVideoImageReference');
          await readNativeVideoImageReference(record.ownerProjectId, record.imageReference);
          assertCurrent();
        }
        const readOptions = { signal: controller.signal };
        const [selection, shared] = await Promise.all([
          readNativeProjectSelection(record.ownerProjectId, record.canvasId, readOptions),
          readNativeProjectContent(record.ownerProjectId, readOptions),
        ]);
        const canvas = selection?.canvas;
        if (!selection || !canvas || !shared || selection.changeRevision !== shared.changeRevision
          || !configValuesEqual(selection.project, shared.project) || selection.project.epoch !== record.projectEpoch
          || canvas.epoch !== record.canvasEpoch || canvas.episodeId !== record.episodeId
          || canvas.revision !== expectedCanvasRevision || shared.content.revisions.assets !== expectedAssetsRevision
          || nativeRuntime.get(get) !== runtime) throw new Error('原画布或共享素材已变化，媒体结果已保留');
        const resultRootRef = selection.project.storageRootRef;
        let nodes = canvas.nodes.map((value) => {
          if (!value || typeof value !== 'object' || (value as { id?: unknown }).id !== record.nodeId) return value;
          const node = structuredClone(value) as { data?: Record<string, unknown> };
          if (!node.data || node.data.type !== (record.targetNodeType ?? `ai-${record.category}`)) throw new Error('原媒体节点已变化，媒体结果已保留');
          const mediaKey = record.category === 'video' ? 'videoUrl' : record.category === 'image' ? 'imageUrl' : 'audioUrl';
          const data: Record<string, unknown> = { ...node.data, [mediaKey]: relativePath, output: relativePath, sourceUrl: relativePath,
            ...(record.category !== 'audio' ? { thumbnailUrl: relativePath } : {}), relativePath, storageRootRef: resultRootRef, status: 'success', error: undefined,
            artifactId: `native-media-${record.operationId}`, videoTaskState: undefined, mediaTaskState: undefined, mediaTaskStage: undefined };
          delete data.filePath; delete data.assetId;
          return { ...node, data };
        });
        if ('apimartImageBatch' in record && record.apimartImageBatch) {
          const { buildNativeImageBatchCanvas } = await import('../../services/nativeImageBatchCanvas');
          nodes = buildNativeImageBatchCanvas(canvas, record, resultRootRef).nodes;
        } else if (record.localResults) {
          const { buildNativeMediaCollectionCanvas } = await import('../../services/nativeMediaCollectionCanvas');
          const { readMusicTrackMetadata } = await import('../../services/nativeAudioContent');
          const tracks = await readMusicTrackMetadata(record.ownerProjectId, record.localResults);
          nodes = buildNativeMediaCollectionCanvas(canvas, record, resultRootRef, tracks).nodes;
        }
        const selected = before.projects.find((item) => item.id === record.canvasId);
        if (!selected) throw new Error('原画布目录不可用，产物已保留');
        const { createNativeMediaDisplayResolver, nativeMediaContentDigest } = await import('../../services/nativeMediaDisplay');
        const { nativeMediaLocalOutputs } = await import('../../services/nativeMediaCollection');
        const { nativeMediaOutputNodeId } = await import('../../services/nativeMediaCollectionCanvas');
        const files = nativeMediaLocalOutputs(record);
        // 老异步回执没有集合字段时也只接受明确摘要路径，不按普通文件名猜配已付费结果。
        const digest = nativeMediaContentDigest(relativePath);
        const displayFiles = files.length ? files : digest ? [{ relativePath, sha256: digest, category: record.category }] : [];
        const deliveryIds = new Set([record.nodeId, ...files.slice(1).map((_, index) => nativeMediaOutputNodeId(record, index + 1))]);
        // 事务仍校验完整画布。展示只恢复本轮目标与候选，避免重新读取其他节点的媒体文件。
        const restored = await restoreProjectRecord({ ...selected,
          nodes: (nodes as Node<BaseNodeData>[]).filter((node) => deliveryIds.has(node.id)), edges: [], groups: [],
          dramaAssets: runtime.loaded.content.dramaAssets });
        assertCurrent();
        const displays = createNativeMediaDisplayResolver(selection.project);
        const displayPatches = new Map<string, Record<string, unknown>>();
        for (const [ordinal, file] of displayFiles.entries()) {
          assertCurrent();
          const id = ordinal ? nativeMediaOutputNodeId(record, ordinal) : record.nodeId;
          const projected = (restored.nodes as Node<BaseNodeData>[]).find((node) => node.id === id);
          if (!projected || projected.data.relativePath !== file.relativePath || projected.data.storageRootRef !== resultRootRef) throw new Error('原媒体候选展示身份已变化，产物已保留');
          const display = await displays(resultRootRef, file);
          assertCurrent();
          const mediaKey = file.category === 'image' ? 'imageUrl' : file.category === 'video' ? 'videoUrl' : 'audioUrl';
          displayPatches.set(id, { [mediaKey]: display.url, output: display.url, sourceUrl: display.url,
            ...(file.category !== 'audio' ? { thumbnailUrl: display.url } : {}), filePath: display.filePath });
        }
        const projectedNodes = (restored.nodes as Node<BaseNodeData>[]).map((node) => {
          const patch = displayPatches.get(node.id);
          if (!patch) return node;
          const data = { ...node.data, ...patch } as BaseNodeData;
          delete data.__nativeUnavailableMediaFields;
          return { ...node, data };
        });
        const primary = projectedNodes.find((node) => node.id === record.nodeId);
        const primaryMedia = primary?.data[record.category === 'image' ? 'imageUrl' : record.category === 'video' ? 'videoUrl' : 'audioUrl'];
        if (typeof primaryMedia !== 'string' || !primaryMedia || primaryMedia === relativePath) throw new Error('原媒体展示地址尚不可用，产物已保留');
        assertCurrent();
        const { commitNativeMediaDelivery } = await import('../../services/nativeMediaDelivery');
        assertCurrent();
        await commitNativeMediaDelivery({ record, expectedCanvasRevision: canvas.revision, expectedAssetsRevision,
          document: { nodes, edges: canvas.edges, groups: canvas.groups } }, { signal: controller.signal, onCommitted: (committed) => {
            unsubscribe(); unsubscribe = () => {};
            // 幂等回执不能把前置保存已推进的版本倒退，也不重复投影或记历史。
            if (committed.alreadyCommitted) return;
            // 在complete事件中先推进保存基线；Promise后续continuation不得再写Store。
            runtime.loaded = { ...runtime.loaded, selection: { ...runtime.loaded.selection,
              canvas: { ...canvas, nodes, revision: committed.canvasRevision }, changeRevision: committed.changeRevision,
              context: { ...runtime.loaded.selection.context, canvasRevision: committed.canvasRevision } } };
            runtime.mediaGeneration = (runtime.mediaGeneration ?? 0) + 1;
            const current = get();
            if (nativeRuntime.get(get) !== runtime || current.currentProjectId !== record.canvasId) return;
            const rebased = rebaseCommittedMediaNodes(before.nodes, current.nodes, projectedNodes, record.nodeId);
            if (rebased === current.nodes) return;
            let historyFailure: unknown;
            try { get().commitToHistory(); } catch (error) { historyFailure = error; }
            try { set({ nodes: rebased }); } finally { get().incrementRevision(); }
            if (get().historyPanelOpen) void get().loadHistoryFromDb();
            if (historyFailure) throw historyFailure;
          } });
      } finally { unsubscribe(); signal?.removeEventListener('abort', cancel); release(); }
    },
  };
}

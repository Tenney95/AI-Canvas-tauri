import type { StoreApi } from 'zustand';
import { t } from '../../i18n';
import type { AppState } from '../useAppStore';
import type { ProjectSaveData } from '../../services/fileService';
import { projectMemoryOwnerId, seriesOwnerId } from '../store.utils';
import { getPendingTasksForProject } from '../../services/pollManager';
import {
  completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasImport,
} from '../../services/canvasDerivationGuard';
import { getProjectById } from '../../services/indexedDbService';
import { serializeProjectRecord } from '../../services/storageService';
import { applySharedAssetSyncCommit } from '../../services/indexedDb/sharedAssetSyncRepository';
import type { DramaAssetLibrary } from '../../types/dramaAssets';
import { sha256BytesHex } from '../../services/mediaDataUrl';
import { projectModelSourceToken } from '../../services/projectModelComparisonMaterial';
import {
  finalizeNativeSharedAssetSync, prepareNativeSharedAssetSync,
} from '../../services/indexedDb/nativeSharedAssetSyncRepository';
import { isProjectExpectedContextCurrent } from '../../services/projectExecutionContext';
import { readNativeProjectContent } from '../../services/indexedDb/nativeProjectRepository';
import { configValuesEqual } from '../../services/configPatch';
import type {
  ProjectSlice, ProjectSliceGet, ProjectSliceSet, ProjectSaveQueue, ProjectAssetSyncBarrier,
  SharedProjectAssetContext,
} from '../store.projects';

export function createSharedProjectAssetActions(
  set: ProjectSliceSet,
  get: ProjectSliceGet,
  api: StoreApi<AppState>,
  context: SharedProjectAssetContext,
): Pick<ProjectSlice,
  | 'applyCharacterVisualReferencePlan'
  | 'commitSharedAssetSyncDownload'
> {
  const {
    readNativeProjectWriteBlock, nativeKnownIds, nativeRuntime, nativeBinding, saveNativeCurrentProject,
    pendingProjectSaves, trackProjectSave, projectAssetSyncBarriers, projectImportsApplying,
    invalidateSeriesLibrarySave, waitForProjectSaveQueue, enqueueProjectSave,
    createCurrentProjectSaveRecord, createSeriesLibraryRecord,
  } = context;
  return {
    applyCharacterVisualReferencePlan: async (plan, nodeIds, assertEditorCurrent) => {
      const before = get();
      const { context, characterId, referenceId } = plan;
      const stale = () => new Error(t('角色引用或画布已变化，请重新预览'));
      assertEditorCurrent?.();
      if (!isProjectExpectedContextCurrent(context, before)) throw stale();
      const { planCharacterVisualReferences } = await import('../../services/characterVisualReferencePlan');
      const current = get();
      const character = current.dramaAssets.characters.find((item) => item.id === characterId);
      if (!character || !isProjectExpectedContextCurrent(context, current)) throw stale();
      const fresh = planCharacterVisualReferences(context, current.nodes, character, referenceId,
        new Set(getPendingTasksForProject(context.canvasId).map((task) => task.nodeId)));
      const selected = new Set(nodeIds);
      const requested = plan.changes.filter((entry) => selected.has(entry.nodeId));
      const changes = new Map(fresh.changes.filter((entry) => selected.has(entry.nodeId)).map((entry) => [entry.nodeId, entry]));
      if (!selected.size || requested.length !== selected.size || changes.size !== selected.size
        || plan.referenceUrl !== fresh.referenceUrl
        || requested.some((entry) => !configValuesEqual(entry, changes.get(entry.nodeId)))) throw stale();

      const patchNodes = (nodes: AppState['nodes']) => nodes.map((node) => {
        const change = changes.get(node.id);
        if (!change) return node;
        const promptChanged = !!change.promptMatches && node.data.prompt === change.originalPrompt;
        const videoChanged = !!change.videoMatches && configValuesEqual(node.data.videoReferences, change.originalVideoReferences);
        if (!promptChanged && !videoChanged) return node;
        return { ...node, data: { ...node.data, ...(promptChanged ? { prompt: change.nextPrompt } : {}),
          ...(videoChanged ? { videoReferences: change.nextVideoReferences } : {}) } };
      });
      const nodes = patchNodes(current.nodes);
      const record = createCurrentProjectSaveRecord({ ...current, nodes });
      const runtime = nativeRuntime.get(get);
      const mediaGeneration = runtime?.mediaGeneration;
      if (!record) throw stale();
      const controller = new AbortController();
      const guard = registerCanvasImport(current, () => controller.abort(stale()));
      if (!guard) throw stale();
      const assertSaveCurrent = () => {
        controller.signal.throwIfAborted();
        assertEditorCurrent?.();
        const live = get();
        if (!isCanvasDerivationFresh(guard, live) || !isProjectExpectedContextCurrent(context, live)
          || live.nodes !== current.nodes || live.edges !== current.edges || live.groups !== current.groups
          || live.dramaAssets !== current.dramaAssets || projectAssetSyncBarriers.has(context.projectId)
          || getPendingTasksForProject(context.canvasId).some((task) => selected.has(task.nodeId))
          || projectImportsApplying.has(context.projectId) || (context.modelGeneration === 1
            && (nativeRuntime.get(get) !== runtime || runtime?.mediaGeneration !== mediaGeneration))) throw stale();
      };

      const unsubscribe = api.subscribe(() => { try { assertSaveCurrent(); } catch { controller.abort(stale()); } });
      const projectCommitted = (queue?: ProjectSaveQueue) => {
        unsubscribe();
        const live = get();
        if (!isProjectExpectedContextCurrent(context, live, { checkCanvasRevision: false })) return;
        if (queue) {
          const queued = [queue.pending, ...(queue.pendingBatches ?? [])];
          for (const item of queued) {
            if (item && !item.guard && Array.isArray(item.record.nodes)) {
              item.record = { ...item.record, nodes: patchNodes(item.record.nodes as AppState['nodes']) };
            }
          }
        }
        const projected = patchNodes(live.nodes);
        if (projected.some((node, index) => node !== live.nodes[index])) {
          live.commitCharacterVisualHistory([...changes.values()]);
          set({ nodes: projected });
          get().incrementRevision();
        }
      };

      try {
        const saved = await trackProjectSave(context.canvasId, async () => {
          assertSaveCurrent();
          const projection = { signal: controller.signal, commit: projectCommitted };
          return context.modelGeneration === 1 ? saveNativeCurrentProject(get, current, record, assertSaveCurrent, undefined, projection)
            : enqueueProjectSave(record, assertSaveCurrent, projection);
        });
        if (saved !== context.canvasId) throw new Error(t('角色引用保存失败，请重新预览'));
        return selected.size;
      } finally {
        unsubscribe();
        completeCanvasDerivation(guard);
      }
    },

    commitSharedAssetSyncDownload: async (input) => {
      const originProject = get().projects.find((project) => project.id === input.originProjectId);
      const native = nativeBinding(originProject);
      if ((nativeKnownIds.has(input.ownerId) || nativeKnownIds.has(input.originProjectId)) && !native) {
        throw new Error('新项目身份不可用，请重新打开');
      }
      if (input.commit.ownerId !== input.ownerId || projectAssetSyncBarriers.has(input.ownerId) || projectImportsApplying.has(input.ownerId)) {
        throw new Error('该项目正在应用共享资产，请稍后重试');
      }
      const controller = new AbortController();
      const abort = () => controller.abort(input.signal?.reason ?? input.commit.signal?.reason);
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        input.signal?.throwIfAborted();
        input.commit.signal?.throwIfAborted();
        input.assertCurrent?.();
        input.commit.assertCurrent?.();
        const current = get();
        if (current.projectLoadStatus !== 'ready' || current.currentProjectId !== input.originProjectId
          || (native ? nativeBinding(current.projects.find((project) => project.id === input.originProjectId))?.projectId !== input.ownerId
            : !current.projects.some((project) => project.id === input.ownerId)
              || seriesOwnerId(current.projects, input.originProjectId) !== input.ownerId)
          || current.dramaAssets !== input.expectedLibrary) {
          throw new Error('项目或资产内容已变化，请重新预览');
        }
      };
      assertCurrent();
      input.signal?.addEventListener('abort', abort, { once: true });
      input.commit.signal?.addEventListener('abort', abort, { once: true });
      let release!: () => void;
      const barrier: ProjectAssetSyncBarrier = {
        done: new Promise<void>((resolve) => { release = resolve; }), library: input.expectedLibrary,
      };
      invalidateSeriesLibrarySave();
      const precedingNativeSaves = native ? [...(pendingProjectSaves.get(input.originProjectId) ?? [])] : [];
      projectAssetSyncBarriers.set(input.ownerId, barrier);
      let unsubscribe = api.subscribe(() => { try { assertCurrent(); } catch { controller.abort(); } });
      try {
        // 屏障先登记，再等旧 active/pending 写完；后来的自动保存不能挤到下载提交后面写旧库。
        if (native) {
          const results = await Promise.allSettled(precedingNativeSaves);
          if (results.some((result) => result.status === 'rejected' || result.value !== input.originProjectId)) throw new Error('当前画布保存失败');
        } else await waitForProjectSaveQueue(input.ownerId);
        assertCurrent();
        if (native) {
          const runtime = nativeRuntime.get(get);
          if (!runtime || runtime.activeId !== input.originProjectId || native.projectId !== input.ownerId) throw new Error('新项目上下文不可用');
          const source = await readNativeProjectContent(native.projectId);
          assertCurrent();
          if (!source || source.project.epoch !== runtime.loaded.selection.project.epoch
            || !configValuesEqual(source.content, runtime.loaded.content)) throw new Error('共享资料已变化，请重新预览');
          let nextLibrary: DramaAssetLibrary | undefined;
          if (input.nextLibrary) {
            const record = createCurrentProjectSaveRecord({ ...get(), dramaAssets: input.nextLibrary });
            if (!record) throw new Error('所属项目已变化，请重新预览');
            nextLibrary = (await serializeProjectRecord({ ...record, dramaAssets: input.nextLibrary })).dramaAssets;
            if (!nextLibrary) throw new Error('共享资料无法序列化');
            assertCurrent();
          }
          const { signal: _signal, assertCurrent: _assertCurrent, nativeAuthority: _authority,
            ...commitRecords } = input.commit;
          const receiptDigest = await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken({
            projectId: native.projectId, projectEpoch: source.project.epoch, expectedContent: source.content,
            nextLibrary, commit: commitRecords,
          })));
          assertCurrent();
          const { captureNativeSharedAssetSources } = await import('../../services/indexedDb/nativeSharedAssetSources');
          const nativeAssets = await captureNativeSharedAssetSources(input.commit);
          let journalPrepared = false;
          try {
            const journal = await prepareNativeSharedAssetSync({ projectId: native.projectId, operationId: input.commit.operationId,
              expectedProjectEpoch: source.project.epoch, expectedAssetsRevision: source.content.revisions.assets,
              expectedLibrary: source.content.dramaAssets, ...(nextLibrary ? { nextLibrary } : {}), receiptDigest, ...(nativeAssets.length ? { nativeAssets } : {}) },
            { signal: controller.signal });
            journalPrepared = true;
            assertCurrent();
            const result = await applySharedAssetSyncCommit({ ...input.commit, signal: controller.signal, assertCurrent, onCommitted: undefined,
              nativeAuthority: { projectId: native.projectId, memberIds: journal.memberIds, receiptDigest } });
            // 旧库事务已提交后即使取消也必须完成原 journal，不能把已应用的索引当作失败撤销。
            await finalizeNativeSharedAssetSync(journal);
            const latest = await readNativeProjectContent(native.projectId);
            if (!latest) throw new Error('共享资料已提交，但项目读取失败');
            runtime.loaded = { ...runtime.loaded, selection: { ...runtime.loaded.selection, project: latest.project,
              changeRevision: latest.changeRevision, context: { ...runtime.loaded.selection.context, projectEpoch: latest.project.epoch } },
              content: latest.content };
            if (input.nextLibrary) { runtime.library = input.nextLibrary; barrier.library = input.nextLibrary; }
            const current = get();
            if (current.currentProjectId === input.originProjectId && current.projectLoadStatus === 'ready'
              && current.dramaAssets === input.expectedLibrary && projectMemoryOwnerId(current.projects, input.originProjectId) === input.ownerId) {
              unsubscribe(); unsubscribe = () => undefined;
              if (input.nextLibrary) set({ dramaAssets: input.nextLibrary });
            }
            return result;
          } catch (error) {
            if (journalPrepared) {
              const block = await readNativeProjectWriteBlock(native.projectId).catch(() => null);
              if (get().currentProjectId === input.originProjectId && nativeRuntime.get(get) === runtime) {
                set({ projectLoadStatus: block ? 'readonly' : 'error', projectExecutionContext: null, nativeProjectWriteBlock: block });
              }
              get().showToast(block
                ? t('共享素材同步尚未完成，请通过「处理原操作」恢复')
                : t('共享素材同步状态需要核对，请从项目库重新打开项目'), 'error');
            }
            throw error;
          }
        }
        let project: ProjectSaveData | undefined;
        let expectedProjectLibrary: unknown;
        if (input.nextLibrary) {
          const previous = await getProjectById(input.ownerId);
          assertCurrent();
          if (!previous) throw new Error('所属项目已不存在，已停止共享资产应用');
          expectedProjectLibrary = previous.dramaAssets;
          const state = { ...get(), dramaAssets: input.nextLibrary };
          const captured = input.ownerId === input.originProjectId
            ? createCurrentProjectSaveRecord(state) : createSeriesLibraryRecord(state);
          if (!captured) throw new Error('所属项目已变化，请重新预览');
          project = await serializeProjectRecord(captured);
          assertCurrent();
        }
        return await applySharedAssetSyncCommit({
          ...input.commit, project, expectedProjectLibrary, signal: controller.signal, assertCurrent,
          onCommitted: (result) => {
            if (result.alreadyApplied) return;
            if (input.nextLibrary) barrier.library = input.nextLibrary;
            const current = get();
            // 提交后的取消不能撤回已持久化数据；只给仍持有原库的原项目投影，不覆盖新编辑。
            if (current.currentProjectId !== input.originProjectId || current.projectLoadStatus !== 'ready'
              || current.dramaAssets !== input.expectedLibrary
              || seriesOwnerId(current.projects, input.originProjectId) !== input.ownerId) return;
            unsubscribe(); unsubscribe = () => undefined;
            // IDB 已提交；同一回调里同步投影，校验与 set 之间没有 await。
            set((state) => ({
              ...(input.nextLibrary ? { dramaAssets: input.nextLibrary } : {}),
              projects: project ? state.projects.map((item) => item.id === input.ownerId
                ? { ...item, updatedAt: project!.updatedAt } : item) : state.projects,
            }));
          },
        });
      } finally {
        unsubscribe();
        input.signal?.removeEventListener('abort', abort);
        input.commit.signal?.removeEventListener('abort', abort);
        const current = get();
        if (current.currentProjectId && projectMemoryOwnerId(current.projects, current.currentProjectId) === input.ownerId) {
          if (current.dramaAssets !== input.expectedLibrary) barrier.library = current.dramaAssets;
        }
        invalidateSeriesLibrarySave();
        projectAssetSyncBarriers.delete(input.ownerId);
        release();
      }
    },
  };
}

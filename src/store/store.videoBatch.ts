/**
 * store.videoBatch — 管理视频批次预检、提交、取消与恢复状态。
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { VideoBatch, VideoBatchItem, VideoPreflightItem } from '../types/videoBatch';
import { readVideoBatches, writeVideoBatches } from '../services/videoBatchRepository';
import { isUnresolvedVideoBatchStatus, latestVideoBatchItems, recoverVideoBatches, retainVideoBatches, runVideoBatch } from '../services/videoBatchRunner';
import { checkVideoServices, inspectVideoNode, isComfyH3VideoNode } from '../services/videoBatchPlanning';
import { generateId } from './store.utils';
import type { GenerationLease } from '../services/generationService';

export interface VideoBatchSlice {
  videoBatches: Record<string, VideoBatch[]>;
  videoBatchBusy: boolean;
  loadVideoBatches: (projectId: string) => Promise<void>;
  startVideoBatch: (projectId: string, items: VideoPreflightItem[], lease?: GenerationLease,
    acknowledged?: ReadonlyMap<string, VideoBatchItem>) => Promise<VideoBatch>;
  cancelWaitingVideos: (projectId: string, batchId: string) => Promise<void>;
  recoverVideoBatchItem: (projectId: string, batchId: string, nodeId: string) => Promise<void>;
}

export const createVideoBatchSlice: StateCreator<AppState, [], [], VideoBatchSlice> = (set, get, api) => {
  let persistence: Promise<void> = Promise.resolve();
  const persist = (projectId: string) => {
    const snapshot = get().videoBatches[projectId] || [];
    const next = persistence.catch(() => undefined).then(() => writeVideoBatches(projectId, snapshot));
    persistence = next;
    return next;
  };
  const patch = async (projectId: string, batchId: string, nodeId: string, value: Partial<VideoBatchItem>) => {
    set((s) => ({ videoBatches: { ...s.videoBatches, [projectId]: (s.videoBatches[projectId] || []).map((b) => b.id !== batchId ? b
      : { ...b, items: b.items.map((i) => i.nodeId === nodeId ? { ...i, ...value } : i) }) } }));
    await persist(projectId);
  };
  return {
    videoBatches: {}, videoBatchBusy: false,
    loadVideoBatches: async (projectId) => {
      if (get().videoBatches[projectId]) return;
      const batches = recoverVideoBatches(await readVideoBatches(projectId));
      if (get().videoBatches[projectId]) return;
      set((s) => ({ videoBatches: { ...s.videoBatches, [projectId]: batches } }));
    },
    cancelWaitingVideos: async (projectId, batchId) => {
      set((s) => ({ videoBatches: { ...s.videoBatches, [projectId]: (s.videoBatches[projectId] || []).map((b) => b.id !== batchId ? b
        : { ...b, items: b.items.map((i) => i.status === 'waiting' ? { ...i, status: 'cancelled' as const, message: '已取消，未提交' } : i) }) } }));
      await persist(projectId);
    },
    recoverVideoBatchItem: async (projectId, batchId, nodeId) => {
      if (get().videoBatchBusy || get().currentProjectId !== projectId
        || !get().nodes.some((node) => node.id === nodeId && node.data.type === 'ai-video' && node.data.status !== 'loading')) {
        throw new Error('原视频节点或画布已变化');
      }
      const batches = get().videoBatches[projectId] ?? [];
      const item = batches.find((batch) => batch.id === batchId)?.items.find((row) => row.nodeId === nodeId);
      const recovery = item?.recovery;
      if (!recovery || latestVideoBatchItems(batches).get(nodeId) !== item) throw new Error('原视频任务已变化');
      set({ videoBatchBusy: true });
      const controller = new AbortController();
      const unsubscribe = api.subscribe((state) => {
        if (state.currentProjectId !== projectId) controller.abort();
      });
      try {
        const { signal } = controller;
        if (recovery.nativeOperationId) {
          const { inspectNativeVolcengineTask, resumeNativeVolcengineTask } = await import('../services/nativeVolcengineRecovery');
          const { readNativeMediaRecoverySummary } = await import('../services/nativeMediaRecoverySummary');
          const record = await inspectNativeVolcengineTask(recovery.nativeOperationId);
          signal.throwIfAborted();
          if (record.canvasId !== projectId || record.nodeId !== nodeId || record.category !== 'video'
            || record.origin?.deliveryMode === 'chat') throw new Error('原视频任务已变化');
          if (record.status !== 'delivered') {
            if (!(await readNativeMediaRecoverySummary(record)).canResume) throw new Error('原任务尚不能续查，请先在服务商核对');
            signal.throwIfAborted();
            await resumeNativeVolcengineTask(record.operationId, signal);
            if ((await inspectNativeVolcengineTask(record.operationId)).status !== 'delivered') {
              throw new Error('原任务尚未交付，原回执已保留');
            }
          }
        } else {
          const receipt = recovery.receipt;
          if (!receipt || receipt.projectId !== projectId || receipt.nodeId !== nodeId || !receipt.taskId) {
            throw new Error('原任务尚不能续查，请先在服务商核对');
          }
          const { resumeMediaNodeTask, retryHistoryMediaDownload } = await import('../services/pollManager');
          signal.throwIfAborted();
          if (recovery.state === 'delivery_pending') await retryHistoryMediaDownload(receipt, signal);
          else await resumeMediaNodeTask(nodeId, signal, receipt);
        }
        await patch(projectId, batchId, nodeId, { status: 'success', recovery: undefined, message: undefined });
      } finally {
        unsubscribe();
        set({ videoBatchBusy: false });
      }
    },
    startVideoBatch: async (projectId, items, lease, acknowledged) => {
      if (lease?.signal?.aborted) throw new Error('视频批次已取消，未提交');
      if (get().videoBatchBusy) throw new Error('已有视频批次正在执行');
      if (get().currentProjectId !== projectId || !items.length) throw new Error('项目或提交范围已变化');
      if (new Set(items.map((i) => i.nodeId)).size !== items.length) throw new Error('提交范围包含重复节点');
      set({ videoBatchBusy: true });
      let projectChanged = false;
      const unsubscribe = api.subscribe((state) => {
        if (state.currentProjectId !== projectId) projectChanged = true;
      });
      try {
        const hasGlobalAssetReferences = items.some((item) => {
          const data = get().nodes.find((node) => node.id === item.nodeId)?.data;
          return data && /@drama\{global\//.test(`${data.prompt || ''}\n${JSON.stringify(data.workflowInputs || {})}`);
        });
        if (hasGlobalAssetReferences) {
          await get().loadGlobalDramaAssets();
          if (lease?.signal?.aborted) throw new Error('视频批次已取消，未提交');
          if (projectChanged || get().currentProjectId !== projectId) throw new Error('项目已切换');
        }
        await get().loadVideoBatches(projectId);
        if (lease?.signal?.aborted) throw new Error('视频批次已取消，未提交');
        if (projectChanged || get().currentProjectId !== projectId) throw new Error('项目已切换');
        const previous = latestVideoBatchItems(get().videoBatches[projectId] ?? []);
        if (items.some(({ nodeId }) => {
          const item = previous.get(nodeId);
          return item && isUnresolvedVideoBatchStatus(item.status) && acknowledged?.get(nodeId) !== item;
        })) throw new Error('请先核对所选镜头的原任务与输出，再确认重新提交');
        const h3Items = items.filter((item) => {
          const node = get().nodes.find((entry) => entry.id === item.nodeId);
          return node && isComfyH3VideoNode(node, get());
        });
        if (h3Items.some((item) => !item.comfyH3SettingsFingerprint)) throw new Error('H3 显存设置尚未检查，请重新检查视频批次');
        const h3Checked = h3Items.length ? await checkVideoServices(h3Items, get()) : [];
        if (lease?.signal?.aborted) throw new Error('视频批次已取消，未提交');
        if (projectChanged || get().currentProjectId !== projectId) throw new Error('项目已切换');
        if (h3Checked.some((fresh, index) => fresh.issues.length || !fresh.comfyH3SettingsFingerprint
          || fresh.comfyH3SettingsFingerprint !== h3Items[index].comfyH3SettingsFingerprint)) {
          throw new Error('H3 显存设置或服务已变化，请重新检查视频批次');
        }
        const h3Fingerprints = new Map(h3Checked.map((item) => [item.nodeId, item.comfyH3SettingsFingerprint]));
        for (const item of items) {
          const node = get().nodes.find((n) => n.id === item.nodeId);
          const fresh = node && inspectVideoNode(node, get());
          if (item.issues.length || !node || !fresh || fresh.issues.length || fresh.fingerprint !== item.fingerprint) throw new Error('物料或参数已变化，请重新检查');
          if (isComfyH3VideoNode(node, get()) !== h3Fingerprints.has(item.nodeId)) throw new Error('H3 工作流已变化，请重新检查视频批次');
        }
        const batch: VideoBatch = { id: generateId(), projectId, createdAt: Date.now(), items: items.map((i) => ({
          nodeId: i.nodeId, label: i.label, fingerprint: i.fingerprint, duration: i.duration, status: 'waiting',
          ...(h3Fingerprints.has(i.nodeId) ? { comfyH3SettingsFingerprint: h3Fingerprints.get(i.nodeId) } : {}),
        })) };
        set((s) => ({ videoBatches: { ...s.videoBatches, [projectId]: retainVideoBatches([...(s.videoBatches[projectId] || []), batch]) } }));
        await persist(projectId);
        await runVideoBatch({
          projectId: () => projectChanged || lease?.signal?.aborted ? null : get().currentProjectId,
          read: () => get().videoBatches[projectId].find((b) => b.id === batch.id)!,
          update: (nodeId, value) => patch(projectId, batch.id, nodeId, value),
          inspect: (nodeId) => {
            const node = get().nodes.find((n) => n.id === nodeId);
            return node ? inspectVideoNode(node, get()) : null;
          },
          execute: async (nodeId) => {
            const { executeGeneration } = await import('../services/generationService');
            if (projectChanged || get().currentProjectId !== projectId) return { success: false, message: '项目已切换' };
            const expected = batch.items.find((item) => item.nodeId === nodeId)?.comfyH3SettingsFingerprint;
            if (expected !== undefined) return executeGeneration(nodeId, undefined, undefined, undefined, lease, { comfyH3ExpectedSettings: expected });
            return lease ? executeGeneration(nodeId, undefined, undefined, undefined, lease) : executeGeneration(nodeId);
          },
        });
        const completed = get().videoBatches[projectId]?.find((item) => item.id === batch.id);
        if (!completed) throw new Error('视频批次结果已不可用');
        return completed;
      } catch (error) {
        set((s) => ({ videoBatches: { ...s.videoBatches, [projectId]: recoverVideoBatches(s.videoBatches[projectId] || []) } }));
        await persist(projectId).catch(() => undefined);
        throw error;
      } finally { unsubscribe(); set({ videoBatchBusy: false }); }
    },
  };
};

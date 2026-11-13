/**
 * videoBatchRunner — 执行视频批次并恢复中断后的任务状态。
 */
import type { VideoBatch, VideoBatchItem, VideoPreflightItem } from '../types/videoBatch';
import type { GenerationResult } from './generationService';

export interface VideoBatchRunnerPorts {
  projectId: () => string | null;
  read: () => VideoBatch;
  update: (nodeId: string, patch: Partial<VideoBatchItem>) => Promise<void>;
  inspect: (nodeId: string) => VideoPreflightItem | null;
  execute: (nodeId: string) => Promise<GenerationResult>;
}

const recoveryMessages = {
  unknown: '生成状态未确认，请核对原任务后再决定是否重新提交',
  paused: '原任务已保留，可继续查询',
  delivery_pending: '生成已完成，可继续保存原结果',
};

export function isUnresolvedVideoBatchStatus(status: VideoBatchItem['status']): boolean {
  return status === 'unknown' || status === 'paused' || status === 'delivery_pending';
}

/** 旧批次保留为历史，当前提交只根据每个节点最近一次有执行结果的记录判断。 */
export function latestVideoBatchItems(batches: readonly VideoBatch[]): Map<string, VideoBatchItem> {
  const latest = new Map<string, VideoBatchItem>();
  for (const batch of batches) for (const item of batch.items) {
    if (item.status !== 'cancelled' && item.status !== 'waiting') latest.set(item.nodeId, item);
  }
  return latest;
}

export function retainVideoBatches(batches: VideoBatch[]): VideoBatch[] {
  const latest = latestVideoBatchItems(batches);
  return batches.filter((batch, index) => index >= batches.length - 30 || batch.items.some((item) =>
    latest.get(item.nodeId) === item && isUnresolvedVideoBatchStatus(item.status)));
}

/** One-at-a-time execution; durable running state precedes submission. No implicit retry. */
export async function runVideoBatch(ports: VideoBatchRunnerPorts): Promise<void> {
  const batch = ports.read();
  for (const original of batch.items) {
    const item = ports.read().items.find((i) => i.nodeId === original.nodeId);
    if (!item || item.status !== 'waiting') continue;
    if (ports.projectId() !== batch.projectId) {
      await ports.update(item.nodeId, { status: 'cancelled', message: '项目已切换，未提交' });
      continue;
    }
    const current = ports.inspect(item.nodeId);
    if (!current || current.issues.length || current.fingerprint !== item.fingerprint) {
      await ports.update(item.nodeId, { status: 'error', message: !current ? '节点已删除'
        : current.issues.length ? current.issues.join('；') : '输入已变化，请重新检查后提交' });
      continue;
    }
    await ports.update(item.nodeId, { status: 'running', message: undefined });
    if (ports.projectId() !== batch.projectId) {
      await ports.update(item.nodeId, { status: 'cancelled', message: '项目已切换，未提交' });
      continue;
    }
    let result: GenerationResult;
    try { result = await ports.execute(item.nodeId); }
    catch {
      await ports.update(item.nodeId, { status: 'unknown', message: '执行状态未确认，请核对输出后再决定是否重生成' });
      continue;
    }
    if (result.recovery) {
      const { state, receipt, nativeOperationId } = result.recovery;
      const sameReceipt = receipt?.projectId === batch.projectId && receipt.nodeId === item.nodeId;
      await ports.update(item.nodeId, { status: state, message: recoveryMessages[state],
        recovery: { state, ...(sameReceipt ? { receipt } : {}), ...(nativeOperationId ? { nativeOperationId } : {}) } });
    } else if (ports.projectId() !== batch.projectId) {
      await ports.update(item.nodeId, { status: 'unknown', message: '项目已切换，请核对原任务和输出，勿直接重投' });
    } else {
      await ports.update(item.nodeId, { status: result.success ? 'success' : 'error',
        message: result.success ? undefined : '生成失败，请定位视频节点查看原因' });
    }
  }
}

export function recoverVideoBatches(batches: VideoBatch[]): VideoBatch[] {
  return batches.map((b) => ({ ...b, items: b.items.map((i) => i.status === 'running'
    ? { ...i, status: 'unknown', message: '上次执行被中断，请先核对服务与结果' }
    : i.status === 'waiting' ? { ...i, status: 'cancelled', message: '重开后未自动提交，可重新检查' } : i) }));
}

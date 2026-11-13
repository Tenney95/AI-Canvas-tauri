/**
 * videoBatchRunner — 回归测试：waits for each execution and its durable status update, continuing after failure。
 */
import { it, expect, vi } from 'vitest';
import { latestVideoBatchItems, retainVideoBatches, runVideoBatch, recoverVideoBatches, type VideoBatchRunnerPorts } from '../../src/services/videoBatchRunner';
import type { GenerationResult } from '../../src/services/generationService';
import type { VideoBatch } from '../../src/types/videoBatch';

function setup() {
  const batch: VideoBatch = { id: 'b', projectId: 'p', createdAt: 1, items: ['a', 'b', 'c'].map((nodeId) => ({ nodeId, label: nodeId, status: 'waiting', fingerprint: 'f' })) };
  const ports: VideoBatchRunnerPorts = {
    projectId: () => 'p', read: () => batch,
    update: async (id, patch) => { Object.assign(batch.items.find((i) => i.nodeId === id)!, patch); },
    inspect: (nodeId) => ({ nodeId, label: nodeId, fingerprint: 'f', issues: [], existing: false, stale: false }),
    execute: vi.fn(async () => ({ success: true })),
  };
  return { batch, ports };
}
it('waits for each execution and its durable status update, continuing after failure', async () => {
  const { batch, ports } = setup();
  const order: string[] = [];
  ports.execute = vi.fn(async (id) => {
    expect(batch.items.filter((i) => i.status === 'running')).toHaveLength(1);
    order.push(id); await new Promise((resolve) => setTimeout(resolve, 2));
    return { success: id !== 'b', message: id === 'b' ? '失败' : undefined };
  });
  await runVideoBatch(ports);
  expect(order).toEqual(['a', 'b', 'c']);
  expect(batch.items.map((i) => i.status)).toEqual(['success', 'error', 'success']);
});
it('does not submit cancelled items and stops scheduling when the project changes', async () => {
  const { batch, ports } = setup();
  batch.items[1].status = 'cancelled';
  ports.execute = vi.fn(async () => { ports.projectId = () => 'other'; return { success: true }; });
  await runVideoBatch(ports);
  expect(ports.execute).toHaveBeenCalledTimes(1);
  expect(batch.items.map((i) => i.status)).toEqual(['unknown', 'cancelled', 'cancelled']);
});
it('refuses changed inputs and missing nodes before submitting', async () => {
  const { batch, ports } = setup();
  ports.inspect = (id) => id === 'b' ? null : { nodeId: id, label: id, fingerprint: 'changed', issues: [], existing: false, stale: false };
  await runVideoBatch(ports);
  expect(ports.execute).not.toHaveBeenCalled();
  expect(batch.items.every((i) => i.status === 'error')).toBe(true);
});
it('fails closed when running state cannot persist and does not auto retry uncertain work', async () => {
  const { batch, ports } = setup();
  ports.update = vi.fn(async () => { throw new Error('storage full'); });
  await expect(runVideoBatch(ports)).rejects.toThrow('storage full');
  expect(ports.execute).not.toHaveBeenCalled();
  batch.items[0].status = 'running';
  const recovered = recoverVideoBatches([batch])[0];
  expect(recovered.items.map((i) => i.status)).toEqual(['unknown', 'cancelled', 'cancelled']);
  expect(batch.items[0].status).toBe('running');
});
it('classifies uncertain exceptions as needing review instead of retryable failure', async () => {
  const { batch, ports } = setup();
  ports.execute = vi.fn(async () => { throw new Error('unknown submit response'); });
  await runVideoBatch(ports);
  expect(batch.items.every((i) => i.status === 'unknown')).toBe(true);
});

it('preserves explicit recovery states and the original receipt across restart', async () => {
  const { batch, ports } = setup();
  ports.execute = vi.fn(async (nodeId): Promise<GenerationResult> => ({
    success: false, message: 'same localized error',
    recovery: { state: nodeId === 'a' ? 'paused' : nodeId === 'b' ? 'delivery_pending' : 'unknown',
      receipt: { projectId: 'p', nodeId, taskId: 'original', attemptId: 'attempt-1' } },
  }));
  await runVideoBatch(ports);
  const [recovered] = recoverVideoBatches([batch]);
  expect(recovered.items.map((item) => item.status)).toEqual(['paused', 'delivery_pending', 'unknown']);
  expect(recovered.items[1].recovery?.receipt).toEqual({ projectId: 'p', nodeId: 'b', taskId: 'original', attemptId: 'attempt-1' });
});

it('uses the newest attempted record without treating an unsubmitted cancellation as a replacement', () => {
  const { batch } = setup();
  const original = { ...batch.items[0], status: 'unknown' as const };
  const finished = { ...original, status: 'success' as const };
  expect(latestVideoBatchItems([{ ...batch, items: [original] }, { ...batch, items: [finished] },
    { ...batch, items: [{ ...finished, status: 'cancelled' }] }]).get(original.nodeId)).toBe(finished);
});

it('retains an unresolved original after thirty newer unrelated batches', () => {
  const { batch } = setup();
  const original: VideoBatch = { ...batch, items: [{ ...batch.items[0], status: 'delivery_pending' }] };
  const later: VideoBatch[] = Array.from({ length: 30 }, (_, index) => ({
    ...batch, id: `later-${index}`, items: [{ ...batch.items[1], status: 'success' }],
  }));
  expect(retainVideoBatches([original, ...later])).toContain(original);
  expect(retainVideoBatches([original, ...later, { ...batch, items: [{ ...original.items[0], status: 'success' }] }])).not.toContain(original);
});

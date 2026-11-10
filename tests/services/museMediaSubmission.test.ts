import { beforeEach, expect, it, vi } from 'vitest';
import type { VideoProviderRequest } from '../../src/services/ai/mediaProviderRegistry';
import type { submitNativeWorkflowTask } from '../../src/services/nativeWorkflowTasks';

type Submission = Parameters<typeof submitNativeWorkflowTask>[0];
const bridge = vi.hoisted(() => ({
  invoke: vi.fn(), received: vi.fn(), workflow: vi.fn(), classification: vi.fn(), events: [] as string[],
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: {
  getState: () => ({ currentProjectId: 'canvas' }), subscribe: () => () => {},
} }));
vi.mock('../../src/services/museService', () => ({
  museInvoke: bridge.invoke, assertMuseTaskId: () => {}, queryMuseTask: vi.fn(),
}));
vi.mock('../../src/services/ai/imageUtils', () => ({
  resolveImageDataUrlArray: async (urls: string[]) => urls, loadImage: vi.fn(),
}));
vi.mock('../../src/services/nativeWorkflowExecution', () => ({
  isNativeWorkflowExecution: () => true, nativeWorkflowDigest: async () => 'fixture-digest',
}));
vi.mock('../../src/services/nativeWorkflowTasks', () => ({ submitNativeWorkflowTask: bridge.workflow }));
vi.mock('../../src/services/canvasDerivationGuard', () => ({
  registerCanvasDerivation: vi.fn(), isCanvasDerivationFresh: () => true, completeCanvasDerivation: vi.fn(),
}));
vi.mock('../../src/services/pollManager', () => ({
  savePendingTask: vi.fn(), updatePendingTask: vi.fn(), getPendingTasksForProject: () => [],
  pauseMediaTask: vi.fn(), removeFailedMediaTask: vi.fn(), registerNodePolling: vi.fn(), cleanupNodePolling: vi.fn(),
}));

import { museMediaProviderAdapter } from '../../src/services/ai/providers/museMedia';

const taskId = 'ac655c56-b537-4c04-8913-fd150fc0e92a';
const input = (): VideoProviderRequest => ({
  params: { model: 'muse/muse-video', provider: 'muse', prompt: '海浪', nodeId: 'video' },
  prompt: '海浪', beforeSubmit: vi.fn(),
  resolveReferenceInput: async () => ({ prompt: '海浪', imageUrls: [], videoUrls: [], audioUrls: [], operation: 'text-to-video' }),
});

beforeEach(() => {
  bridge.events.length = 0;
  bridge.invoke.mockReset().mockImplementation(async (command: string) => {
    bridge.events.push(command);
    return { taskId };
  });
  bridge.received.mockReset().mockImplementation(async () => { bridge.events.push('received'); });
  bridge.classification.mockReset();
  bridge.workflow.mockReset().mockImplementation(async (submission: Submission) => {
    try { await submission.submit(0, submission.signal, bridge.received); }
    catch (error) { bridge.classification(submission.isDefinitiveFailure?.(error)); throw error; }
    throw new Error('fixture-workflow-pending');
  });
});

it('网页完成准备后才登记身份，发送前已有原任务回执且只点击一次', async () => {
  await expect(museMediaProviderAdapter.generateVideo!(input())).rejects.toThrow('fixture-workflow-pending');
  expect(bridge.events).toEqual(['muse_prepare', 'muse_submit', 'received', 'muse_send', 'muse_cancel_prepared']);
  expect(bridge.received).toHaveBeenCalledExactlyOnceWith(taskId);
});

it('准备失败保留首次具体原因，不登记为已提交或继续查询未发送的任务', async () => {
  const original = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'muse_submit') throw new Error('Muse 网页发送按钮尚未就绪，尚未发送生成请求');
    return original(command, args);
  });
  await expect(museMediaProviderAdapter.generateVideo!(input())).rejects.toThrow('发送按钮尚未就绪');
  expect(bridge.classification).toHaveBeenCalledWith(true);
  expect(bridge.received).not.toHaveBeenCalled();
  expect(bridge.invoke.mock.calls.some(([command]) => command === 'muse_send' || command === 'muse_query')).toBe(false);
});

it('登记身份期间输入变化仍阻止发送，并保守保留已登记的原任务', async () => {
  let changed = false;
  bridge.received.mockImplementation(async () => { changed = true; });
  const request = input();
  request.beforeSubmit = () => { if (changed) throw new Error('原输入已变化'); };
  await expect(museMediaProviderAdapter.generateVideo!(request)).rejects.toThrow('原输入已变化');
  expect(bridge.classification).toHaveBeenCalledWith(false);
  expect(bridge.received).toHaveBeenCalledExactlyOnceWith(taskId);
  expect(bridge.invoke.mock.calls.some(([command]) => command === 'muse_send')).toBe(false);
});

it('发送后未确认送达保留原身份，不当作明确未发送，也不再点击', async () => {
  const original = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'muse_send') throw new Error('Muse 尚未确认新对话已送达，原任务已保留；不会自动重发');
    return original(command, args);
  });
  await expect(museMediaProviderAdapter.generateVideo!(input())).rejects.toThrow('尚未确认新对话已送达');
  expect(bridge.classification).toHaveBeenCalledWith(false);
  expect(bridge.received).toHaveBeenCalledExactlyOnceWith(taskId);
  expect(bridge.invoke.mock.calls.filter(([command]) => command === 'muse_send')).toHaveLength(1);
});

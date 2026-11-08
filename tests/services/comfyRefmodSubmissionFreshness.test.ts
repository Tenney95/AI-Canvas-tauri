/**
 * comfyRefmodSubmissionFreshness — 回归测试：RefMod 最后同步提交检查点。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from '../../src/types';
import type { ComfyRefmodCatalog, ComfyRefmodSelection } from '../../src/types/comfyRefmod';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), identity: vi.fn(), catalog: vi.fn(), poll: vi.fn(), beforeSubmit: vi.fn(),
  state: {
    currentProjectId: 'p', revision: 1, getCurrentRevision: (): number => 1,
    config: { comfyUIUrl: 'http://comfy.test:8188' },
    projects: [],
    workflows: [] as WorkflowDefinition[],
    nodes: [] as Array<{ id: string; type: string; data: { prompt: string; role?: string } }>,
  },
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.state } }));
vi.mock('../../src/services/comfyRefmodService', () => ({ loadComfyRefmodCatalog: mocks.catalog, resolveComfyRefmodServerIdentity: mocks.identity }));
vi.mock('../../src/services/videoBatchPlanning', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/videoBatchPlanning')>(),
  videoInputFingerprint: (node: { data: unknown }) => JSON.stringify(node.data),
}));
vi.mock('../../src/services/comfyPolling', () => ({
  comfyFetch: mocks.fetch, pollComfyHistory: mocks.poll, ComfyPendingError: class extends Error {},
}));
vi.mock('../../src/services/nodeReferenceService', () => ({ resolveNodeReferences: (value: string) => value, resolveNodeReferencesAsync: async (value: string) => value }));
vi.mock('../../src/services/pollManager', () => ({
  savePendingTask: vi.fn(), updatePendingTask: vi.fn(), removePendingTask: vi.fn(),
  registerNodePolling: vi.fn(() => undefined), cleanupNodePolling: vi.fn(),
  getPendingTasksForProject: vi.fn(() => []), pauseVideoNodeTask: vi.fn(), cancelNodePolling: vi.fn(),
}));
vi.mock('../../src/services/comfyProgress', () => ({ createComfyProgressSession: () => ({
  clientId: 'client', requestId: 'request', waitUntilReady: vi.fn().mockResolvedValue(undefined), bindPrompt: vi.fn(), close: vi.fn(),
}) }));

import { executeComfyUIVideoGenerate } from '../../src/services/comfyWorkflowService';

const fingerprint = 'a'.repeat(64);
const ref: ComfyRefmodSelection = { endpointFingerprint: fingerprint, loaderType: 'minimax-h3', fileName: 'alice', strength: 0.8,
  workflowId: 'wf', loaderNodeId: '12', slot: 1, originalFileName: '(none)' };
const catalog: ComfyRefmodCatalog = { serverName: '默认服务器', endpointFingerprint: fingerprint, entries: [], warnings: [], fetchedAt: 1,
  loaders: [{ classType: 'MiniMaxH3RefModsLoader', loaderType: 'minimax-h3', label: 'RefMods', slots: [{
    slot: 1, fileField: 'mod_1', allowedNames: ['alice'], emptyNames: ['(none)'], strengthField: 'strength_1', strengthMin: 0, strengthMax: 1,
  }] }] };
const params = { prompt: '向前走', model: 'comfyui/workflow', provider: 'comfyui', workflowId: 'wf', nodeId: 'v', comfyRefmods: [ref] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.currentProjectId = 'p';
  mocks.state.revision = 1;
  mocks.state.getCurrentRevision = () => mocks.state.revision;
  mocks.state.nodes = [{ id: 'v', type: 'ai-video', data: { prompt: '仍有角色 token' } }];
  mocks.state.workflows = [{ id: 'wf', name: 'H3', category: 'ai-video', fileName: 'h3.json', createdAt: 1,
    fileContent: JSON.stringify({ '12': { class_type: 'MiniMaxH3RefModsLoader', inputs: { mod_1: '(none)', strength_1: 1 } } }) }];
  mocks.catalog.mockResolvedValue(catalog);
  mocks.identity.mockResolvedValue({ serverName: '默认服务器', endpointFingerprint: fingerprint });
  mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ prompt_id: 'job' }), text: async () => '' });
  mocks.poll.mockResolvedValue({ url: 'http://comfy.test:8188/view?filename=video.mp4' });
});

describe('RefMod 最后同步提交检查点', () => {
  it.each(['token', 'project', 'revision'] as const)('最后一次 SHA 等待期间改变 %s 时不发送 POST', async (change) => {
    let releaseHash!: () => void;
    let enteredHash!: () => void;
    const hashGate = new Promise<void>((resolve) => { releaseHash = resolve; });
    const entered = new Promise<void>((resolve) => { enteredHash = resolve; });
    let count = 0;
    mocks.identity.mockImplementation(async () => {
      count += 1;
      // 目录复核、上传前身份复核后，第三次是 caller guard 之后的最终 SHA。
      if (count === 3) { enteredHash(); await hashGate; }
      return { serverName: '默认服务器', endpointFingerprint: fingerprint };
    });
    const generation = executeComfyUIVideoGenerate(params, undefined, [], {}, mocks.beforeSubmit);
    await entered;
    expect(mocks.beforeSubmit).toHaveBeenCalledTimes(1);
    if (change === 'token') mocks.state.nodes = [{ id: 'v', type: 'ai-video', data: { prompt: '角色 token 已删除' } }];
    if (change === 'project') mocks.state.currentProjectId = 'other';
    if (change === 'revision') mocks.state.revision += 1;
    releaseHash();
    await expect(generation).rejects.toThrow('已变化');
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith('/prompt'))).toBe(false);
    expect(mocks.beforeSubmit).toHaveBeenCalledTimes(2);
  });

  it('最终SHA前后复核caller guard，输入未变化时只提交一次', async () => {
    await expect(executeComfyUIVideoGenerate(params, undefined, [], {}, mocks.beforeSubmit)).resolves.toHaveProperty('url');
    expect(mocks.beforeSubmit).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith('/prompt'))).toHaveLength(1);
  });
});

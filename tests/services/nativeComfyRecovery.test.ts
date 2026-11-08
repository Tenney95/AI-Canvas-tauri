import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeMediaTaskRecord } from '../../src/services/indexedDb/nativeMediaTaskRepository';

const probes = vi.hoisted(() => ({ base: 'http://127.0.0.1:8188', active: true, rows: [] as NativeMediaTaskRecord[],
  claim: vi.fn(), poll: vi.fn(), persist: vi.fn(), commit: vi.fn(), lease: vi.fn(), failed: vi.fn() }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({ nodes: [{ id: 'node' }], workflows: [{ id: 'workflow', fileContent: '{}' }], config: {},
  commitNativeMediaResult: probes.commit }), subscribe: () => () => {} } }));
vi.mock('../../src/services/projectExecutionContext', () => ({ captureLegacyCanvasContext: () => ({ kind: 'canvas', modelGeneration: 1,
  projectId: 'p2-project', canvasId: 'c2-canvas', projectEpoch: 1, canvasEpoch: 1, episodeId: 'episode', runtimeEpoch: 'restarted' }),
isProjectExpectedContextCurrent: () => probes.active }));
vi.mock('../../src/services/indexedDb/nativeMediaTaskRepository', () => ({ listNativeMediaTasks: async () => probes.rows,
  claimNativeMediaRecovery: probes.claim, failNativeMediaTask: probes.failed, isNativeMediaLeaseCurrent: probes.lease,
  normalizeNativeMediaProviderBase: (value: string) => value.replace(/\/+$/, '') }));
vi.mock('../../src/services/comfyServers', () => ({ comfyBaseUrlFor: () => probes.base, listConfiguredComfyServers: () => [], resolveComfyServerSelection: vi.fn() }));
vi.mock('../../src/services/comfyPolling', () => ({ pollComfyHistory: probes.poll }));
vi.mock('../../src/services/videoBatchPlanning', () => ({ videoInputData: () => ({ workflowId: 'workflow' }) }));
vi.mock('../../src/services/fileService', () => ({ getProjectDataDir: async () => '/fixture', getRelativeAssetPath: () => 'media/video.mp4',
  persistMediaUrlToProjectData: probes.persist }));
vi.mock('../../src/services/nativeMediaMessages', () => ({ projectNativeMediaMessages: async () => {} }));
import { NATIVE_COMFY_VIDEO_PROTOCOL_DIGEST, resumeNativeComfyTask } from '../../src/services/nativeComfyRecovery';

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); probes.base = 'http://127.0.0.1:8188'; probes.active = true;
  const row = { operationId: 'operation', ownerProjectId: 'p2-project', canvasId: 'c2-canvas', nodeId: 'node',
    providerConfigId: 'comfyui', providerBase: probes.base, category: 'video', status: 'submitted', remoteTaskId: 'original-prompt-id',
    protocolDigest: await NATIVE_COMFY_VIDEO_PROTOCOL_DIGEST('workflow'), lease: 'lease' } as NativeMediaTaskRecord;
  probes.rows = [row]; probes.claim.mockReset().mockResolvedValue(row); probes.lease.mockReset().mockResolvedValue(true);
  probes.poll.mockReset().mockResolvedValue({ url: `${probes.base}/view?filename=video.mp4`, file: { filename: 'video.mp4' } });
  probes.persist.mockReset().mockResolvedValue({ filePath: '/fixture/media/video.mp4' }); probes.commit.mockReset().mockResolvedValue(undefined); probes.failed.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

it('重启后只按原站点和原 prompt_id 查询并交付，未再次提交工作流', async () => {
  await resumeNativeComfyTask('operation');
  expect(probes.poll).toHaveBeenCalledWith('http://127.0.0.1:8188', 'original-prompt-id', expect.any(String), expect.any(Function), expect.any(AbortSignal));
  expect(probes.persist).toHaveBeenCalledOnce();
  expect(probes.commit).toHaveBeenCalledWith(probes.rows[0], 'media/video.mp4', expect.objectContaining({ canvasId: 'c2-canvas', runtimeEpoch: 'restarted' }));
});

it('服务器或查询合同变化时不向替代服务发送原任务 ID', async () => {
  probes.base = 'http://127.0.0.1:8189';
  await expect(resumeNativeComfyTask('operation')).rejects.toThrow('服务配置已变化');
  expect(probes.poll).not.toHaveBeenCalled();
  probes.base = 'http://127.0.0.1:8188'; probes.rows[0].protocolDigest = 'a'.repeat(64);
  await expect(resumeNativeComfyTask('operation')).rejects.toThrow('查询协议或工作流已变化');
  expect(probes.poll).not.toHaveBeenCalled();
});

it('任务查询被取消或投递租约变化时保留回执，不提交画布', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(resumeNativeComfyTask('operation', controller.signal)).rejects.toThrow();
  expect(probes.poll).not.toHaveBeenCalled(); expect(probes.commit).not.toHaveBeenCalled();
  probes.lease.mockResolvedValueOnce(false);
  await expect(resumeNativeComfyTask('operation')).rejects.toThrow('租约');
  expect(probes.persist).not.toHaveBeenCalled(); expect(probes.commit).not.toHaveBeenCalled();
});

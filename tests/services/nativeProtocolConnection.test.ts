/** 通用模型配置身份不能因删除／换连接回退成同裸ID的直连模型。 */
import { webcrypto } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import type { GeneralModelConfig } from '../../src/types';
import type { NativeMediaTaskRecord } from '../../src/services/indexedDb/nativeMediaTaskRepository';

const driver = vi.hoisted(() => ({ models: [] as GeneralModelConfig[], providers: {} as Record<string, unknown> }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({ config: { generalModels: driver.models, providers: driver.providers } }) } }));
vi.mock('../../src/services/ai/providerCatalogService', () => ({
  getProviderDefinition: (_id: string, provider?: { catalogId?: string }) => provider?.catalogId === 'sora2u'
    ? { id: 'sora2u', retired: true, defaultBaseUrl: 'https://sora2u.com' }
    : { id: 'custom-openai', models: [{ id: 'same-bare-id', name: '目录图片', category: 'image', executionProfile: { preset: 'openai-image' } }] },
  isRetiredProviderConnection: (_id: string, provider?: { catalogId?: string }) => provider?.catalogId === 'sora2u',
  resolveCccGeminiImageExecutionProfile: (_modelId: string, profile: unknown) => profile,
}));
import { resolveNativeProtocolConnection } from '../../src/services/nativeProtocolConnection';
import { resolveGeneralModelConnection } from '../../src/services/ai/helpers';
import { resolveModelExecutionProfile } from '../../src/services/ai/modelProtocol';
import { resolveMinimaxExecutionProfile, MINIMAX_BASE_URL } from '../../src/services/ai/providers/minimaxModelManifest';
import { nativeProtocolQueryDigest, nativeProtocolTaskDigest } from '../../src/services/nativeModelProtocolTask';
import { resolveNativeRecoveryProtocol } from '../../src/services/nativeProtocolRecovery';

function record(): NativeMediaTaskRecord {
  return { projectId: 'media-task:10000000-0000-4000-8000-000000000001', kind: 'native-media-task-v1',
    operationId: '10000000-0000-4000-8000-000000000001', ownerProjectId: 'p2-20000000-0000-4000-8000-000000000002',
    canvasId: 'c2-30000000-0000-4000-8000-000000000003', episodeId: null, projectEpoch: 0, canvasEpoch: 0, sourceCanvasRevision: 0,
    nodeId: 'image', inputFingerprint: 'a'.repeat(64), providerConfigId: 'original', providerBase: 'https://original.example/v1',
    modelRef: 'general/user-config', category: 'image', protocolDigest: 'b'.repeat(64), status: 'submitted', remoteTaskId: 'original-task',
    lease: '40000000-0000-4000-8000-000000000004', revision: 1, createdAt: 1, updatedAt: 1,
    recovery: { kind: 'general-protocol', modelId: 'same-bare-id', digest: 'b'.repeat(64) } };
}
beforeEach(() => {
  driver.models = [];
  driver.providers = { original: { apiKey: 'synthetic-original', baseUrl: 'https://original.example/v1',
    selectedModels: [{ id: 'same-bare-id', category: 'image', executionProfile: { preset: 'openai-image' } }] },
  other: { apiKey: 'synthetic-other', baseUrl: 'https://other.example/v1' } };
});
it('原general配置已删除时即使原目录有同裸ID也拒绝恢复', () => {
  expect(resolveNativeProtocolConnection(record())).toBeUndefined();
});
it('原general ID被改为另一连接时不能回退到原provider目录', () => {
  driver.models = [{ id: 'user-config', name: '已改连接', modelId: 'same-bare-id', category: 'image', providerConfigId: 'other', executionProfile: { preset: 'openai-image' } }];
  expect(resolveNativeProtocolConnection(record())).toBeUndefined();
});
it('同general ID、原provider完整配置保留其确切模型对象', () => {
  driver.models = [{ id: 'user-config', name: '原模型', modelId: 'same-bare-id', category: 'image', providerConfigId: 'original', executionProfile: { preset: 'openai-image' } }];
  const selected = resolveNativeProtocolConnection(record());
  expect(selected?.model).toBe(driver.models[0]); expect(selected?.providerConfigId).toBe('original');
});
it('明确直连descriptor按原连接与原裸ID读取实际profile', () => {
  const selected = resolveNativeProtocolConnection({ ...record(), modelRef: 'original/same-bare-id' });
  expect(selected).toMatchObject({ providerConfigId: 'original', baseUrl: 'https://original.example/v1', model: { modelId: 'same-bare-id', executionProfile: { preset: 'openai-image' } } });
});
it('下架的内置连接只允许原生回执解析原模型、凭据和默认地址', () => {
  const model: GeneralModelConfig = { id: 'user-config', name: '旧图片模型', modelId: 'same-bare-id', category: 'image',
    providerConfigId: 'original', executionProfile: { preset: 'openai-image' } };
  driver.models = [model];
  driver.providers.original = { catalogId: 'sora2u', apiKey: 'synthetic-original' };
  const receipt = { ...record(), providerBase: 'https://sora2u.com' };

  expect(resolveGeneralModelConnection(receipt.modelRef!)).toBeUndefined();
  expect(resolveNativeProtocolConnection(receipt)).toMatchObject({
    model, providerConfigId: 'original', apiKey: 'synthetic-original', baseUrl: receipt.providerBase,
  });
});

it('原 MiniMax 视频配置缺少显式协议时，只有原厂连接和原回执摘要共同匹配才可续查', async () => {
  vi.stubGlobal('crypto', webcrypto);
  try {
    const modelId = 'MiniMax-H3-Max';
    const protocol = resolveModelExecutionProfile(resolveMinimaxExecutionProfile(modelId))!;
    const receipt = { ...record(), category: 'video' as const, providerBase: MINIMAX_BASE_URL,
      protocolDigest: await nativeProtocolTaskDigest(modelId, protocol),
      recovery: { kind: 'general-protocol' as const, modelId, digest: await nativeProtocolQueryDigest(modelId, protocol) } };
    driver.models = [{ id: 'user-config', modelId, name: modelId, category: 'video', providerConfigId: 'original' }];
    driver.providers.original = { catalogId: 'minimax', baseUrl: MINIMAX_BASE_URL, apiKey: 'synthetic-original' };

    const original = resolveNativeProtocolConnection(receipt);
    expect(driver.models[0].executionProfile).toBeUndefined();
    const recovery = { modelId, profile: original?.model.executionProfile, catalogId: 'minimax',
      protocolDigest: receipt.protocolDigest, queryDigest: receipt.recovery.digest };
    expect(await resolveNativeRecoveryProtocol(recovery)).toEqual(protocol);
    expect(await resolveNativeRecoveryProtocol({ ...recovery, protocolDigest: 'f'.repeat(64), queryDigest: 'f'.repeat(64) })).toBeUndefined();

    driver.providers.original = { catalogId: 'custom-openai', baseUrl: MINIMAX_BASE_URL, apiKey: 'synthetic-original' };
    expect(resolveNativeProtocolConnection(receipt)?.model.executionProfile).toBeUndefined();
  } finally { vi.unstubAllGlobals(); }
});

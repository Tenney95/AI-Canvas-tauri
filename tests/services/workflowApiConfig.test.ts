import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConnectionShare, serializeConnection } from '../../src/services/ai/providerConnectionTransfer';
import { getProviderDefinition, fetchProviderModelCatalog } from '../../src/services/ai/providerCatalogService';
import { testProviderConnection } from '../../src/services/testConnection';
import { saveAutodlWorkflowTemplate, parseWorkflowApiFields } from '../../src/services/workflowApi/workflowApiConfig';
import { useAppStore } from '../../src/store/useAppStore';
import { findMediaModelOption } from '../../src/components/nodes/shared/defaultModels';
import { workflowExecution } from '../../src/services/workflowExecutionService';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn() }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.fetch }));
vi.mock('../../src/services/fileService', async (original) => ({ ...await original<typeof import('../../src/services/fileService')>(), saveWorkflow: mocks.save }));
const connection = { name: 'AutoDL', catalogId: 'autodl-workflow', apiKey: 'private-token', baseUrl: 'https://autodl.art' };

beforeEach(() => { useAppStore.setState(useAppStore.getInitialState(), true); vi.clearAllMocks(); mocks.save.mockResolvedValue(undefined); });

describe('工作流 API 配置与目录', () => {
  it('独立类别不请求模型目录，配置检查不声称验证 Token 或提交任务', async () => {
    expect(getProviderDefinition('autodl-workflow')).toMatchObject({ kind: 'workflow-api', catalogAdapter: 'local-manifest' });
    expect((await fetchProviderModelCatalog({ providerId: 'autodl-workflow', config: connection })).models).toEqual([]);
    expect(await testProviderConnection('autodl-workflow', connection.apiKey, connection.baseUrl)).toMatchObject({ success: false, unsupported: true });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('模板保存复用工作流 Store，编辑保持同一 ID，视频菜单使用正确执行类型', async () => {
    await saveAutodlWorkflowTemplate('autodl-workflow', { seed: 0, duration: 12, resolution: '480p', ratio: '1:1' });
    const first = useAppStore.getState().workflows[0];
    await saveAutodlWorkflowTemplate('autodl-workflow', { seed: 0, duration: 7 });
    const workflows = useAppStore.getState().workflows;
    expect(workflows).toHaveLength(1); expect(workflows[0].id).toBe(first.id);
    expect(workflowExecution(workflows[0])).toMatchObject({ provider: 'workflow-api', workflowId: first.id, seedanceDuration: 7 });
    expect(findMediaModelOption(`workflow-api/${first.id}`, [], undefined, workflows)).toMatchObject({ provider: 'workflow-api', groupName: '工作流 API', providerConfigId: 'autodl-workflow', mediaKind: 'video' });
  });
  it('分享往返保留默认参数、绑定新连接并排除 Token', async () => {
    await saveAutodlWorkflowTemplate('autodl-workflow', { seed: 0, duration: 15, resolution: '480p', ratio: '1:1' });
    const share = serializeConnection(connection, useAppStore.getState().workflows);
    expect(share).not.toContain(connection.apiKey);
    const parsed = parseConnectionShare(share)!;
    expect(parsed.config.apiKey).toBe(''); expect(parsed.config.selectedModels).toEqual([]);
    expect(parsed.workflowApi?.defaults).toEqual({ seed: 0, duration: 15, resolution: '480p', ratio: '1:1' });
    await saveAutodlWorkflowTemplate('new-connection', parsed.workflowApi?.defaults);
    expect(useAppStore.getState().workflows[1].workflowApi?.connectionId).toBe('new-connection');
  });
  it.each(['unknown-workflow', '../../other'])('导入拒绝未知工作流 %s，不回退到普通模型', (workflowId) => {
    const share = JSON.parse(serializeConnection(connection)); share.workflowApi.workflowId = workflowId;
    expect(parseConnectionShare(JSON.stringify(share))).toBeNull();
  });
  it('损坏的地址、manifest、默认值和重复参数在保存前拒绝', async () => {
    for (const patch of [{ token: 'secret' }, { defaults: { duration: null } }, { adapter: 'other' }]) {
      const share = JSON.parse(serializeConnection(connection)); Object.assign(share.workflowApi, patch);
      expect(parseConnectionShare(JSON.stringify(share))).toBeNull();
    }
    const share = JSON.parse(serializeConnection(connection)); share.connection.baseUrl = 'https://autodl.art/v1';
    expect(parseConnectionShare(JSON.stringify(share))).toBeNull();
    await expect(saveAutodlWorkflowTemplate('autodl-workflow', { duration: 16 })).rejects.toThrow();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(parseWorkflowApiFields({ 'workflow::seed': '0' })).toEqual({ seed: 0 });
    expect(() => parseWorkflowApiFields({ seed: '1', 'workflow::seed': '2' })).toThrow('重复');
  });
});

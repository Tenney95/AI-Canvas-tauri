import { describe, expect, it } from 'vitest';
import { buildRunningHubSiteProviders, hydrateRunningHubAliases, runningHubCredentialId, runningHubSiteDrafts } from '../../src/services/runninghubSiteCredentials';
import { runningHubConnection } from '../../src/services/workflowExecutionService';
import type { ApiProviderConfig } from '../../src/types';
import type { RunningHubSiteKeyDrafts } from '../../src/types/runninghub';

const keys: RunningHubSiteKeyDrafts = {
  cn: { modelKey: 'cn-model-fixture', workflowKey: 'cn-workflow-fixture' },
  ai: { modelKey: 'ai-model-fixture', workflowKey: 'ai-workflow-fixture' },
};
const model: ApiProviderConfig = { name: 'RunningHub', apiKey: '', catalogId: 'runninghub-model', baseUrl: 'https://www.runninghub.ai/openapi/v2' };

describe('RunningHub 国内与国际凭据隔离', () => {
  it('旧单组密钥只归入原地址对应站点，不复制到另一站', () => {
    const drafts = runningHubSiteDrafts({
      'runninghub-model': { ...model, apiKey: 'old-model-fixture' },
      runninghub: { name: '工作流', apiKey: 'old-workflow-fixture', baseUrl: 'https://www.runninghub.cn' },
    });
    expect(drafts).toEqual({ cn: { modelKey: '', workflowKey: 'old-workflow-fixture' }, ai: { modelKey: 'old-model-fixture', workflowKey: '' } });
  });
  it('切换站点只切换当前凭据投影，另一套密钥保持原值', () => {
    const providers = buildRunningHubSiteProviders({}, model, keys);
    expect(runningHubConnection(providers, 'runninghub-model')).toEqual({ apiKey: keys.ai.modelKey, baseUrl: 'https://www.runninghub.ai' });
    expect(runningHubConnection(providers, 'runninghub').apiKey).toBe(keys.ai.workflowKey);
    const switched = hydrateRunningHubAliases({ ...providers,
      'runninghub-model': { ...providers['runninghub-model'], baseUrl: 'https://www.runninghub.cn/openapi/v2' },
      runninghub: { ...providers.runninghub, baseUrl: 'https://www.runninghub.cn/openapi/v2' },
    });
    expect(switched['runninghub-model'].apiKey).toBe(keys.cn.modelKey);
    expect(runningHubConnection(switched, 'runninghub').apiKey).toBe(keys.cn.workflowKey);
    expect(runningHubSiteDrafts(switched)).toEqual(keys);
  });
  it('当前站点空密钥不借用另一站或旧入口残留；清空只移除所选记录', () => {
    const providers = buildRunningHubSiteProviders({}, model, keys);
    const cleared = buildRunningHubSiteProviders(providers, model, { ...keys, ai: { modelKey: '', workflowKey: keys.ai.workflowKey } });
    expect(cleared).not.toHaveProperty(runningHubCredentialId('ai', 'runninghub-model'));
    expect(cleared['runninghub-model'].apiKey).toBe('');
    const withStaleAlias = { ...cleared, 'runninghub-model': { ...cleared['runninghub-model'], apiKey: 'stale-alias-fixture' } };
    expect(() => runningHubConnection(withStaleAlias, 'runninghub-model')).toThrow('模型');
    expect(cleared[runningHubCredentialId('cn', 'runninghub-model')].apiKey).toBe(keys.cn.modelKey);
  });
  it('未读出的原生凭据引用保持原记录，不因空草稿而删除', () => {
    const id = runningHubCredentialId('cn', 'runninghub-model');
    const providers: Record<string, ApiProviderConfig> = {
      [id]: { name: '未读出', apiKey: '', apiKeyRef: `secret:provider/${id}`, baseUrl: 'https://www.runninghub.cn/openapi/v2' },
    };
    const next = buildRunningHubSiteProviders(providers, model, { cn: { modelKey: '', workflowKey: '' }, ai: keys.ai });
    expect(next[id]).toEqual(providers[id]);
  });
  it('旧任务按原站点续查，缺少原站凭据时不借用当前站点', () => {
    const providers = buildRunningHubSiteProviders({}, model, keys);
    expect(runningHubConnection(providers, 'runninghub', 'cn')).toEqual({ apiKey: keys.cn.workflowKey, baseUrl: 'https://www.runninghub.cn' });
    expect(runningHubConnection(providers, 'runninghub').apiKey).toBe(keys.ai.workflowKey);
    delete providers[runningHubCredentialId('cn', 'runninghub')];
    expect(() => runningHubConnection(providers, 'runninghub', 'cn')).toThrow('工作流');
  });
  it('旧单组凭据读取失败时阻止迁移，不能丢弃其原生引用', () => {
    const providers: Record<string, ApiProviderConfig> = {
      runninghub: { name: '旧工作流', apiKey: '', apiKeyRef: 'secret:provider/runninghub', baseUrl: 'https://www.runninghub.cn' },
    };
    expect(() => buildRunningHubSiteProviders(providers, model, { cn: { modelKey: '', workflowKey: '' }, ai: keys.ai })).toThrow('尚未读取');
    expect(providers.runninghub.apiKeyRef).toBe('secret:provider/runninghub');
  });
});

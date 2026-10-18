import { describe, expect, it } from 'vitest';
import { shouldListProviderConnection } from '../../src/components/settings/apiKeySettingsUtils';

describe('API Key 设置连接列表', () => {
  it('显示 Agent 保存但尚未填写密钥的自定义连接', () => {
    expect(shouldListProviderConnection({
      apiKey: '',
      catalogId: 'custom-openai',
    }, 'api-key')).toBe(true);
  });

  it('继续隐藏没有密钥的内置连接', () => {
    expect(shouldListProviderConnection({
      apiKey: '',
      catalogId: 'apimart',
    }, 'api-key')).toBe(false);
  });

  it('只配置工作流 Key 时显示 RunningHub 连接，不显示无关厂商', () => {
    expect(shouldListProviderConnection({
      apiKey: '',
      catalogId: 'runninghub-model',
    }, 'api-key', 'workflow-key')).toBe(true);
    expect(shouldListProviderConnection({
      apiKey: '',
      catalogId: 'runninghub-model',
    }, 'api-key')).toBe(false);
    expect(shouldListProviderConnection({
      apiKey: '',
      catalogId: 'apimart',
    }, 'api-key', 'workflow-key')).toBe(false);
  });

  it('显示已有密钥或使用 OAuth 的连接', () => {
    expect(shouldListProviderConnection({
      apiKey: 'configured',
      catalogId: 'custom-openai',
    }, 'api-key')).toBe(true);
    expect(shouldListProviderConnection({
      apiKey: '',
      catalogId: 'dreamina',
    }, 'oauth')).toBe(true);
  });
  it('当前站点为空时仍保留 RunningHub 入口，允许切回另一套已保存密钥', () => {
    expect(shouldListProviderConnection({ apiKey: '', catalogId: 'runninghub-model', runninghubSiteCredentials: true }, 'api-key')).toBe(true);
  });
});

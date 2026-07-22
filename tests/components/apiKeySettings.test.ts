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
});

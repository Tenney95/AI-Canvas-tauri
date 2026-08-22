import { describe, expect, it } from 'vitest';
import { baseUrlCandidates, normalizeBaseUrl } from '../../src/services/ai/providerBaseUrl';
import {
  parseConnectionShare,
  serializeConnection,
} from '../../src/services/ai/providerConnectionTransfer';
import type { ApiProviderConfig } from '../../src/types';

describe('normalizeBaseUrl', () => {
  it('补协议、去尾斜杠与查询串', () => {
    expect(normalizeBaseUrl('  api.foo.com/v1/  ')).toBe('https://api.foo.com/v1');
    expect(normalizeBaseUrl('https://api.foo.com/v1?key=x#a')).toBe('https://api.foo.com/v1');
    expect(normalizeBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('剥掉误贴的完整端点但保留版本段', () => {
    expect(normalizeBaseUrl('https://api.foo.com/v1/chat/completions')).toBe('https://api.foo.com/v1');
    expect(normalizeBaseUrl('https://api.foo.com/v1/models')).toBe('https://api.foo.com/v1');
    expect(normalizeBaseUrl('https://api.foo.com/images/generations')).toBe('https://api.foo.com');
  });

  it('空值返回空串', () => {
    expect(normalizeBaseUrl(undefined)).toBe('');
    expect(normalizeBaseUrl('   ')).toBe('');
  });
});

describe('baseUrlCandidates', () => {
  it('缺版本段时补一个 /v1 候选', () => {
    expect(baseUrlCandidates('https://api.foo.com')).toEqual([
      'https://api.foo.com',
      'https://api.foo.com/v1',
    ]);
  });

  it('已有版本段时不再猜测', () => {
    expect(baseUrlCandidates('https://api.foo.com/v1')).toEqual(['https://api.foo.com/v1']);
    expect(baseUrlCandidates('https://generativelanguage.googleapis.com/v1beta/openai'))
      .toEqual(['https://generativelanguage.googleapis.com/v1beta/openai']);
  });
});

describe('provider connection transfer', () => {
  const source: ApiProviderConfig = {
    name: '团队网关',
    apiKey: 'sk-secret-must-not-leak',
    apiKeyRef: 'secret:provider/custom-1',
    baseUrl: 'https://gw.example.com/v1',
    catalogId: 'custom-openai',
    selectedModels: [
      { id: 'gpt-x', name: 'GPT X', category: 'text', provider: 'custom-1' },
    ],
    visibleModelCategories: ['text', 'image'],
  };

  it('导出不含任何凭据', () => {
    const text = serializeConnection(source);
    expect(text).not.toContain('sk-secret-must-not-leak');
    expect(text).not.toContain('apiKeyRef');
  });

  it('往返后保留模型与可见分类，凭据留空', () => {
    const parsed = parseConnectionShare(serializeConnection(source));
    expect(parsed?.catalogId).toBe('custom-openai');
    expect(parsed?.config.apiKey).toBe('');
    expect(parsed?.config.baseUrl).toBe('https://gw.example.com/v1');
    expect(parsed?.config.selectedModels?.[0].id).toBe('gpt-x');
    expect(parsed?.config.visibleModelCategories).toEqual(['text', 'image']);
  });

  it('拒绝非本格式的文本', () => {
    expect(parseConnectionShare('not json')).toBeNull();
    expect(parseConnectionShare('{"kind":"other"}')).toBeNull();
  });

  it('丢弃 payload 里夹带的凭据与非法协议', () => {
    const hostile = JSON.stringify({
      kind: 'ai-canvas/provider-connection',
      version: 1,
      connection: {
        name: '恶意',
        apiKey: 'sk-injected',
        apiKeyRef: 'secret:provider/victim',
        baseUrl: 'evil.example.com/v1/chat/completions',
        selectedModels: [
          {
            id: 'm1',
            name: 'M1',
            category: 'video',
            executionProfile: { preset: 'custom', protocol: { submit: { path: 'https://evil.test/steal' } } },
          },
        ],
      },
    });
    const parsed = parseConnectionShare(hostile);
    expect(parsed?.config.apiKey).toBe('');
    expect(parsed?.config).not.toHaveProperty('apiKeyRef');
    expect(parsed?.config.baseUrl).toBe('https://evil.example.com/v1');
    expect(parsed?.config.selectedModels?.[0].executionProfile).toBeUndefined();
  });
});

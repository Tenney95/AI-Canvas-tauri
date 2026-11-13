/**
 * providerPolicies — 回归测试：厂商接线策略。
 */
import { describe, expect, it } from 'vitest';
import { getProviderPolicy, resolveProviderCatalogId } from '../../src/services/ai/providerPolicies';

it('方舟官方使用独立 TOS，同名自定义连接不借用该上传方式', () => {
  expect(getProviderPolicy(resolveProviderCatalogId('volcengine')).upload).toBe('volcengine-tos');
  expect(getProviderPolicy(resolveProviderCatalogId('方舟连接', { catalogId: 'volcengine' })).upload).toBe('volcengine-tos');
  expect(getProviderPolicy(resolveProviderCatalogId('volcengine', { catalogId: 'custom-openai' })).upload).toBeUndefined();
});

describe('厂商接线策略', () => {
  it.each(['custom-openai', 'cccapi', 'xai', 'google', 'sora2u', 'toapis', 'libapi', 'relayonapi', 'aigc-si', 'minimax'])('%s 沿用通用模型同步', (id) => {
    expect(getProviderPolicy(id).syncGeneralModels).toBe(true);
  });

  it.each(['apimart', 'runninghub-model', 'grsai', 'dreamina', 'workflow-api', 'unknown', undefined])('%s 不隐式改用通用模型或独立上传', (id) => {
    const policy = getProviderPolicy(id);
    expect(policy.syncGeneralModels).toBe(false);
    expect(policy.upload).toBeUndefined();
    expect(policy.catalog).toMatchObject({ refresh: 'merge', fallback: 'allow', connectionTest: 'default' });
  });

  it('CCC 与万象合并连接分组，其他既有专属菜单按连接区分', () => {
    expect(getProviderPolicy('cccapi').modelMenuGroup?.scope).toBe('catalog');
    expect(getProviderPolicy('relayonapi').modelMenuGroup?.scope).toBe('catalog');
    for (const id of ['sora2u', 'toapis', 'libapi']) {
      expect(getProviderPolicy(id).modelMenuGroup?.scope).toBe('connection');
    }
    expect(getProviderPolicy('custom-openai').modelMenuGroup).toBeUndefined();
  });

  it.each([
    ['cccapi', 'empty', 'fallback', 'ungrouped-only', false],
    ['toapis', 'fallback', 'fallback', 'deny', true],
    ['libapi', 'fallback', 'fallback', 'deny', true],
    ['relayonapi', 'fallback', 'fallback', 'deny', true],
    ['aigc-si', 'fallback', 'fallback', 'deny', true],
  ] as const)('%s 分别声明初始目录、刷新和失败规则', (id, create, edit, fallback, keyChange) => {
    expect(getProviderPolicy(id).catalog).toEqual({ initialModelsOnCreate: create,
      initialModelsOnEdit: edit, refresh: 'replace', fallback,
      invalidateOnKeyChange: keyChange, connectionTest: 'catalog' });
  });

  it('显式 catalogId 优先于同名连接，仅真实厂商选用已登记上传', () => {
    expect(resolveProviderCatalogId('libapi', { catalogId: 'custom-openai' })).toBe('custom-openai');
    expect(getProviderPolicy(resolveProviderCatalogId('libapi', { catalogId: 'custom-openai' })).upload).toBeUndefined();
    expect(resolveProviderCatalogId('toapis', { catalogId: 'unknown' })).toBe('unknown');
    expect(getProviderPolicy(resolveProviderCatalogId('自己的连接', { catalogId: 'libapi' })).upload).toBe('libapi');
    expect(getProviderPolicy(resolveProviderCatalogId('自己的连接', { catalogId: 'toapis' })).upload).toBe('toapis');
    expect(resolveProviderCatalogId('libapi')).toBe('libapi');
    expect(resolveProviderCatalogId('autodl-workflow')).toBe('workflow-api');
    expect(resolveProviderCatalogId('autodl-workflow', { catalogId: 'custom-openai' })).toBe('custom-openai');
  });

  it('RelayOnAPI 使用公开素材策略及提交幂等键，不借用专有上传或同名连接身份', () => {
    const policy = getProviderPolicy(resolveProviderCatalogId('自己的万象连接', { catalogId: 'relayonapi' }));
    expect(policy.modelMenuGroup).toMatchObject({ scope: 'catalog' });
    expect(policy.submitIdempotency).toBe(true);
    expect(policy.referenceTransport).toBe('public-url');
    expect(policy.upload).toBeUndefined();
    const custom = getProviderPolicy(resolveProviderCatalogId('relayonapi', { catalogId: 'custom-openai' }));
    expect(custom.modelMenuGroup).toBeUndefined();
    expect(custom.catalog.connectionTest).toBe('default');
    expect(custom.submitIdempotency).toBeUndefined();
    expect(custom.referenceTransport).toBeUndefined();
    expect(custom.upload).toBeUndefined();
  });

  it('查询返回稳定只读策略，不共享可变目录规则', () => {
    const defaultPolicy = getProviderPolicy(undefined);
    const libapiPolicy = getProviderPolicy('libapi');
    expect(getProviderPolicy('libapi')).toBe(libapiPolicy);
    expect(Object.isFrozen(libapiPolicy)).toBe(true);
    expect(Object.isFrozen(libapiPolicy.catalog)).toBe(true);
    expect(defaultPolicy.catalog.initialModelsOnCreate).toBe('fallback');
    expect(libapiPolicy.catalog.initialModelsOnCreate).toBe('fallback');
    expect(libapiPolicy.catalog.fallback).toBe('deny');
    expect(defaultPolicy.catalog.fallback).toBe('allow');
  });

  it('Amam 按连接分组，只启用提交幂等，不借用其他厂商上传或同名自定义身份', () => {
    const policy = getProviderPolicy('aigc-si');
    expect(policy.modelMenuGroup?.scope).toBe('connection');
    expect(policy.submitIdempotency).toBe(true);
    expect(policy.upload).toBeUndefined();
    expect(policy.referenceTransport).toBeUndefined();
    expect(getProviderPolicy(resolveProviderCatalogId('aigc-si', { catalogId: 'custom-openai' })).submitIdempotency).toBeUndefined();
  });

  it('MiniMax 按连接分组，专属上传不应用到碰巧同名的自定义连接', () => {
    const policy = getProviderPolicy(resolveProviderCatalogId('my-minimax', { catalogId: 'minimax' }));
    expect(policy).toMatchObject({ upload: 'minimax', syncGeneralModels: true, modelMenuGroup: { scope: 'connection' },
      catalog: { initialModelsOnCreate: 'fallback', initialModelsOnEdit: 'fallback', connectionTest: 'default' } });
    expect(getProviderPolicy(resolveProviderCatalogId('minimax', { catalogId: 'custom-openai' })).upload).toBeUndefined();
    expect(policy.submitIdempotency).toBeUndefined();
  });
});

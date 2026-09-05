import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderModelChoice } from '../../../src/types/agent';
import { clearProviderModelCatalogsForTask, clearProviderModelCatalogsForTests, createProviderModelCatalog,
  getPreparedProviderCatalogApproval, getProviderModelCatalog, MAX_PROVIDER_CATALOG_MODELS,
  prepareProviderCatalogSelection, PROVIDER_CATALOG_TTL_MS, queryProviderModels,
  toggleProviderModelSelection, validateProviderModelSelection } from '../../../src/services/chat/providerModelCatalogService';

const scope = { projectId: 'p1', conversationId: 'c1', taskId: 't1' };
const models: ProviderModelChoice[] = Array.from({ length: 1000 }, (_, index) => ({ id: `model-${index}`,
  name: `模型 ${index}`, category: index % 2 ? 'video' : 'text' }));
afterEach(() => { clearProviderModelCatalogsForTests(); vi.useRealTimers(); });

describe('provider model catalog', () => {
  it('supports more than 200 choices and deduplicates IDs without retaining extra fields', () => {
    const candidates = [...models.slice(0, 201), { ...models[0], description: 'RAW_DOCUMENT_TEXT' }];
    const summary = createProviderModelCatalog(scope, candidates);
    expect(summary.total).toBe(201);
    expect(JSON.stringify(getProviderModelCatalog(scope, summary.catalogId))).not.toContain('RAW_DOCUMENT_TEXT');
  });
  it('passes only an opaque ID through the tool while supplying bounded approval metadata', () => {
    const summary = createProviderModelCatalog(scope, models);
    expect(summary).toMatchObject({ total: 1000, categoryCounts: { text: 500, video: 500 }, maxSelection: 16 });
    const input = prepareProviderCatalogSelection({ catalogId: summary.catalogId }, scope);
    expect(input).toEqual({ catalogId: summary.catalogId });
    expect(getPreparedProviderCatalogApproval(input)).toMatchObject({ kind: 'provider_models', options: models });
    expect(JSON.stringify(input).length).toBeLessThan(100);
    const copy = getProviderModelCatalog(scope, summary.catalogId);
    copy.options[0].name = 'MUTATED';
    expect(getProviderModelCatalog(scope, summary.catalogId).options[0].name).toBe('模型 0');
  });
  it('searches and filters 1000 candidates, paging without losing selections', () => {
    const first = queryProviderModels(models);
    expect(first).toMatchObject({ total: 1000, page: 1, pageCount: 50 });
    expect(first.options).toHaveLength(20);
    const last = queryProviderModels(models, '', '', 50);
    let selected = toggleProviderModelSelection([], [first.options[0].id]);
    selected = toggleProviderModelSelection(selected, [last.options.at(-1)!.id]);
    expect(selected).toEqual(['model-0', 'model-999']);
    expect(queryProviderModels(models, 'MODEL-999', 'video', 50).options).toEqual([models[999]]);
    expect(queryProviderModels(models, '不存在').total).toBe(0);
    expect(validateProviderModelSelection(models, selected)).toEqual([models[0], models[999]]);
  });
  it('bounds selections and rejects forged or duplicate choices', () => {
    expect(toggleProviderModelSelection([], models.map((model) => model.id))).toHaveLength(16);
    for (const ids of [['fake'], ['model-0', 'model-0'], models.slice(0, 17).map((model) => model.id)]) {
      expect(() => validateProviderModelSelection(models, ids)).toThrow();
    }
    expect(() => prepareProviderCatalogSelection({}, scope)).toThrow('其中一项');
    expect(() => prepareProviderCatalogSelection({ catalogId: 'fake', models }, scope)).toThrow('其中一项');
  });
  it('rejects expiry and every mismatched scope, with only same-project MCP reuse', async () => {
    vi.useFakeTimers();
    const summary = createProviderModelCatalog(scope, models);
    for (const change of [{ projectId: 'p2' }, { conversationId: 'c2' }, { taskId: 't2' }]) {
      expect(() => getProviderModelCatalog({ ...scope, ...change }, summary.catalogId)).toThrow('作用域');
    }
    const mcp = { ...scope, conversationId: 'mcp-control-p1' };
    const shared = createProviderModelCatalog(mcp, models);
    expect(getProviderModelCatalog({ ...mcp, taskId: 'next' }, shared.catalogId).options).toHaveLength(1000);
    await vi.advanceTimersByTimeAsync(PROVIDER_CATALOG_TTL_MS + 1);
    expect(() => getProviderModelCatalog(scope, summary.catalogId)).toThrow('失效');
    expect(() => prepareProviderCatalogSelection({ catalogId: summary.catalogId }, scope)).toThrow('失效');
  });
  it('clears on task end and bounds catalog count, metadata, and candidate count', () => {
    expect(() => createProviderModelCatalog(scope, Array(MAX_PROVIDER_CATALOG_MODELS + 1).fill(models[0]))).toThrow('上限');
    expect(() => createProviderModelCatalog(scope, [{ ...models[0], id: 'x'.repeat(161) }])).toThrow('无效');
    expect(() => createProviderModelCatalog(scope, [models[0], { ...models[0], category: 'audio' }])).toThrow('冲突');
    const first = createProviderModelCatalog(scope, models);
    for (let index = 0; index < 16; index++) createProviderModelCatalog(scope, [models[0]]);
    expect(() => getProviderModelCatalog(scope, first.catalogId)).toThrow('失效');
    const recent = createProviderModelCatalog(scope, models);
    clearProviderModelCatalogsForTask(scope.taskId);
    expect(() => getProviderModelCatalog(scope, recent.catalogId)).toThrow('失效');
  });
});

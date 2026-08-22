import { describe, expect, it } from 'vitest';
import {
  MAX_CACHED_CATALOG_MODELS,
  capCatalogModels,
} from '../../src/services/ai/providerCatalogService';
import type { ProviderModelSelection } from '../../src/types';

function makeModels(count: number, prefix = 'm'): ProviderModelSelection[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    name: `${prefix}-${index}`,
    category: 'text' as const,
    provider: 'custom-1',
  }));
}

describe('目录缓存截断', () => {
  it('不超过上限时原样保留', () => {
    const models = makeModels(10);
    expect(capCatalogModels(models, new Set())).toEqual(models);
  });

  it('截断到上限，且已勾选的模型一个都不丢', () => {
    const models = makeModels(1_000);
    const selectedIds = new Set(['m-990', 'm-999']);
    const capped = capCatalogModels(models, selectedIds);

    expect(capped).toHaveLength(MAX_CACHED_CATALOG_MODELS);
    expect(capped.map((model) => model.id)).toEqual(
      expect.arrayContaining([...selectedIds]),
    );
  });

  it('已勾选数量本身超过上限时全部保留，不丢配置', () => {
    const models = makeModels(1_000);
    const selectedIds = new Set(models.slice(0, 400).map((model) => model.id));
    const capped = capCatalogModels(models, selectedIds);

    expect(capped).toHaveLength(400);
    expect(capped.every((model) => selectedIds.has(model.id))).toBe(true);
  });
});

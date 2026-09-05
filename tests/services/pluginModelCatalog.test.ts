import { describe, expect, it } from 'vitest';
import { resolvePluginModelInputModalities } from '../../src/services/plugins/pluginModelCatalog';

describe('pluginModelCatalog input modalities', () => {
  it('preserves explicit declarations', () => {
    expect(resolvePluginModelInputModalities('text', 'gpt-4o', ['text'])).toEqual(['text']);
  });

  it('infers legacy vision text models with the host capability rule', () => {
    expect(resolvePluginModelInputModalities('text', 'apimart/gpt-4o', undefined)).toEqual(['text', 'image']);
    expect(resolvePluginModelInputModalities('text', 'deepseek/deepseek-r1', undefined)).toEqual(['text']);
  });

  it('does not invent modalities for media categories', () => {
    expect(resolvePluginModelInputModalities('image', 'provider/image-model', undefined)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { buildPluginModelCatalog, resolvePluginModelInputModalities } from '../../src/services/plugins/pluginModelCatalog';
import { useAppStore } from '../../src/store/useAppStore';
import type { WorkflowDefinition } from '../../src/types';

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

describe('pluginModelCatalog video workflows', () => {
  const workflow = (id: string, overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
    id, name: `工作流 ${id}`, category: 'ai-video', fileName: 'video.json', fileContent: '{"1":{"class_type":"VideoOutput"}}', createdAt: 1, ...overrides,
  });
  it('uses host workflow model identities without exposing service URLs, paths or source JSON', () => {
    const config = { ...useAppStore.getState().config, comfyUIUrl: 'http://127.0.0.1:8188', comfyUIPath: 'D:\\private\\ComfyUI' };
    const models = buildPluginModelCatalog(config, ['video'], [workflow('local')]);
    expect(models).toContainEqual({ id: 'comfyui/local', name: '工作流 local', provider: 'comfyui', category: 'video', description: 'ComfyUI 工作流' });
    const entry = models.find((model) => model.id === 'comfyui/local');
    expect(JSON.stringify(entry)).not.toContain('127.0.0.1');
    expect(JSON.stringify(entry)).not.toContain('private');
    expect(JSON.stringify(entry)).not.toContain('VideoOutput');
  });
  it('requires video category, registered workflow content and a configured server', () => {
    const config = { ...useAppStore.getState().config, comfyUIUrl: '', comfyServers: [{ id: 'bound', name: '局域网', url: 'http://192.168.1.2:8188' }] };
    const workflows = [workflow('available', { serverId: 'bound' }), workflow('missing-server'),
      workflow('empty', { serverId: 'bound', fileContent: '' }), workflow('image', { serverId: 'bound', category: 'ai-image' }),
      workflow('cloud', { serverId: 'bound', adapterType: 'runninghub' })];
    expect(buildPluginModelCatalog(config, ['video'], workflows).filter((model) => model.provider === 'comfyui').map((model) => model.id)).toEqual(['comfyui/available']);
    expect(buildPluginModelCatalog(config, ['text'], workflows).some((model) => model.provider === 'comfyui')).toBe(false);
  });
});

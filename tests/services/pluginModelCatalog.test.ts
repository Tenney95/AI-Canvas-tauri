import { describe, expect, it } from 'vitest';
import { buildPluginModelCatalog, resolvePluginModelInputModalities } from '../../src/services/plugins/pluginModelCatalog';
import { useAppStore } from '../../src/store/useAppStore';
import type { AppConfig, WorkflowDefinition } from '../../src/types';

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

describe('pluginModelCatalog video capabilities', () => {
  it('includes configured model capability without exposing credentials or protocol content', () => {
    const config: AppConfig = { ...useAppStore.getState().config,
      providers: { relay: { name: '中转站', apiKey: 'private-key', baseUrl: 'https://private.example/v1' } },
      generalModels: [{ id: 'replica', name: '复刻模型', modelId: 'relay-video', category: 'video', providerConfigId: 'relay',
        videoCapability: { maxDuration: 30, maxVideoReferences: 10, maxAudioReferences: 10 },
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync', submit: { method: 'POST', path: '/private', body: {} }, response: { type: 'json', result: { urlPath: 'url' } } } } }],
    };
    const model = buildPluginModelCatalog(config, ['video']).find((entry) => entry.id === 'general/replica');
    expect(model).toMatchObject({ videoCapability: { maxDuration: 30, maxVideoReferences: 10, maxAudioReferences: 10 } });
    expect(JSON.stringify(model)).not.toContain('private');
    expect(JSON.stringify(model)).not.toContain('executionProfile');
  });

  it('keeps unknown ComfyUI capability unspecified', () => {
    const config = { ...useAppStore.getState().config, comfyUIUrl: 'http://127.0.0.1:8188' };
    const model = buildPluginModelCatalog(config, ['video'], [{ id: 'local', name: 'local', category: 'ai-video', fileName: 'video.json', fileContent: '{}', createdAt: 1 }])
      .find((entry) => entry.id === 'comfyui/local');
    expect(model).toBeDefined();
    expect(model).not.toHaveProperty('videoCapability');
  });
});

describe('pluginModelCatalog menu presentation', () => {
  it('exposes built-in group display fields without changing execution identity', () => {
    const config: AppConfig = {
      ...useAppStore.getState().config,
      providers: {
        apimart: { name: 'APIMart 连接', apiKey: 'never-export-this-key', baseUrl: 'https://never-export.example/v1' },
      },
      generalModels: [],
    };
    const entry = buildPluginModelCatalog(config, ['text'], []).find((model) => model.id === 'apimart/gpt-4o');
    expect(entry).toMatchObject({ id: 'apimart/gpt-4o', provider: 'apimart', category: 'text' });
    expect(entry?.group).toEqual({
      id: 'apimart', name: 'APIMart', description: '一个 API 搞定一切——节省 30-70%', badgeText: 'AM', tone: 'success',
    });
    expect(JSON.stringify(entry)).not.toContain('never-export');
    expect(entry?.group).not.toHaveProperty('models');
    expect(entry?.group).not.toHaveProperty('apiKey');
  });

  it('uses host CCC and Sora2U groups while preserving general model IDs and routing', () => {
    const config: AppConfig = {
      ...useAppStore.getState().config,
      providers: {
        'ccc-first': { name: 'CCC GPT', catalogId: 'cccapi', cccGroup: 'GPT', apiKey: 'never-export-ccc-key', baseUrl: 'https://never-export-ccc.example/v1' },
        'ccc-second': { name: 'CCC 视频', catalogId: 'cccapi', cccGroup: '视频', apiKey: 'never-export-second-key' },
        sora: { name: 'Sora2U', catalogId: 'sora2u', apiKey: 'never-export-sora-key', baseUrl: 'https://never-export-sora.example' },
        relay: { name: '测试中转站', apiKey: 'never-export-relay-key' },
      },
      generalModels: [
        { id: 'ccc-a', name: 'H3', modelId: 'minimax-h3', category: 'video', providerConfigId: 'ccc-first' },
        { id: 'ccc-b', name: 'H3', modelId: 'minimax-h3', category: 'video', providerConfigId: 'ccc-second' },
        { id: 'sora-a', name: 'Seedance', modelId: 'seedance', category: 'video', providerConfigId: 'sora' },
        { id: 'relay-a', name: '自定义视频', modelId: 'relay-video', category: 'video', providerConfigId: 'relay' },
      ],
    };
    const entries = buildPluginModelCatalog(config, ['video'], []);
    const cccFirst = entries.find((model) => model.id === 'general/ccc-a');
    const cccSecond = entries.find((model) => model.id === 'general/ccc-b');
    expect(cccFirst).toMatchObject({ id: 'general/ccc-a', provider: 'general', category: 'video', name: 'H3 · GPT' });
    expect(cccSecond).toMatchObject({ id: 'general/ccc-b', provider: 'general', category: 'video', name: 'H3 · 视频' });
    expect(cccFirst?.group).toEqual({
      id: 'general-provider-cccapi', name: 'CCC API', description: '按模型所属分组自动使用对应的 API Key', badgeText: 'CCC', tone: 'brand',
    });
    expect(cccSecond?.group).toEqual(cccFirst?.group);
    expect(entries.find((model) => model.id === 'general/sora-a')).toMatchObject({
      provider: 'general', group: { id: 'general-provider-sora', name: 'Sora2U', badgeText: 'S2U' },
    });
    expect(entries.find((model) => model.id === 'general/relay-a')).toMatchObject({
      provider: 'general', group: { id: 'general-models', name: '通用模型', badgeText: 'GM' }, description: '测试中转站 · ID: relay-video',
    });
    expect(JSON.stringify(entries)).not.toContain('never-export');
    expect(JSON.stringify(entries)).not.toContain('providerConfigId');
    expect(JSON.stringify(entries)).not.toContain('cccGroup');
  });

  it('keeps unconfigured and hidden connections out of display groups', () => {
    const config: AppConfig = {
      ...useAppStore.getState().config,
      providers: {
        absent: { name: '未配置', catalogId: 'cccapi', apiKey: '' },
        hidden: { name: '已隐藏', catalogId: 'sora2u', apiKey: 'private-hidden-key', visibleModelCategories: [] },
      },
      generalModels: [
        { id: 'absent', name: '未配置视频', modelId: 'video', category: 'video', providerConfigId: 'absent' },
        { id: 'hidden', name: '已隐藏视频', modelId: 'video', category: 'video', providerConfigId: 'hidden' },
      ],
    };
    expect(buildPluginModelCatalog(config, ['video'], []).filter((model) => model.provider === 'general')).toEqual([]);
  });
});

describe('pluginModelCatalog video workflows', () => {
  const workflow = (id: string, overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
    id, name: `工作流 ${id}`, category: 'ai-video', fileName: 'video.json', fileContent: '{"1":{"class_type":"VideoOutput"}}', createdAt: 1, ...overrides,
  });
  it('uses host workflow model identities without exposing service URLs, paths or source JSON', () => {
    const config = { ...useAppStore.getState().config, comfyUIUrl: 'http://127.0.0.1:8188', comfyUIPath: 'D:\\private\\ComfyUI' };
    const models = buildPluginModelCatalog(config, ['video'], [workflow('local')]);
    expect(models).toContainEqual({ id: 'comfyui/local', name: '工作流 local', provider: 'comfyui', category: 'video', description: 'ComfyUI 工作流',
      group: { id: 'comfyui', name: 'ComfyUI', description: 'ComfyUI 视频工作流', badgeText: 'CF', tone: 'brand' },
    });
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

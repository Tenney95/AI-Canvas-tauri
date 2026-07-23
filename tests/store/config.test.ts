import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/types';

const fileMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  loadProjectsList: vi.fn(async () => [] as Array<Record<string, unknown>>),
  saveProject: vi.fn(async (record: { id: string }) => record.id),
  saveConfig: vi.fn<(config: unknown) => Promise<void>>(async () => undefined),
  setBaseDataDir: vi.fn(),
  syncAuthorizedDirectories: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/fileService', () => fileMocks);

import { useAppStore } from '../../src/store/useAppStore';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  fileMocks.loadConfig.mockReset();
  fileMocks.loadProjectsList.mockReset();
  fileMocks.loadProjectsList.mockResolvedValue([]);
  fileMocks.saveProject.mockClear();
  fileMocks.saveConfig.mockClear();
  fileMocks.setBaseDataDir.mockClear();
  fileMocks.syncAuthorizedDirectories.mockReset();
  fileMocks.syncAuthorizedDirectories.mockResolvedValue(undefined);
});

describe('config hydration guard', () => {
  it('blocks persistence until the saved config has been loaded', async () => {
    useAppStore.getState().updateConfig({ baseDataDir: 'new-default-path' });

    await useAppStore.getState().saveConfig();

    expect(useAppStore.getState().configHydrated).toBe(false);
    expect(fileMocks.saveConfig).not.toHaveBeenCalled();
  });

  it('allows persistence after loading and preserves saved paths', async () => {
    fileMocks.loadConfig.mockResolvedValue({
      providers: {},
      theme: 'dark',
      comfyUIUrl: 'http://127.0.0.1:8188',
      comfyUIPath: '',
      generalModels: [],
      baseDataDir: 'existing-root',
      assetFolders: ['existing-assets'],
    });

    await useAppStore.getState().loadConfig();
    await useAppStore.getState().saveConfig();

    expect(useAppStore.getState().configHydrated).toBe(true);
    expect(fileMocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      baseDataDir: 'existing-root',
      assetFolders: ['existing-assets'],
    }));
  });

  it('silently persists the selected assistant model without a success toast', async () => {
    fileMocks.loadConfig.mockResolvedValue({ providers: {}, theme: 'dark' });
    await useAppStore.getState().loadConfig();
    useAppStore.getState().updateConfig({ assistantModelId: 'volcengine/doubao-seed' });

    await useAppStore.getState().saveConfig({ silent: true });

    expect(fileMocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      assistantModelId: 'volcengine/doubao-seed',
    }));
    expect(useAppStore.getState().toast.visible).toBe(false);
  });

  it('keeps persistence blocked when loading the saved config fails', async () => {
    fileMocks.loadConfig.mockRejectedValue(new Error('read failed'));

    await useAppStore.getState().loadConfig();
    await useAppStore.getState().saveConfig();

    expect(useAppStore.getState().configHydrated).toBe(false);
    expect(fileMocks.saveConfig).not.toHaveBeenCalled();
  });

  it('keeps persistence enabled when only directory authorization sync fails', async () => {
    fileMocks.loadConfig.mockResolvedValue({ providers: {}, theme: 'dark' });
    fileMocks.syncAuthorizedDirectories.mockRejectedValue(new Error('sync failed'));

    await useAppStore.getState().loadConfig();
    await useAppStore.getState().saveConfig();

    expect(useAppStore.getState().configHydrated).toBe(true);
    expect(fileMocks.saveConfig).toHaveBeenCalledTimes(1);
  });

  it('migrates legacy model connection fields and persists only provider references', async () => {
    fileMocks.loadConfig.mockResolvedValue({
      providers: {},
      theme: 'dark',
      generalModels: [{
        id: 'legacy-model',
        name: '旧模型',
        openaiUrl: 'https://legacy.example/v1',
        anthropicUrl: '',
        modelId: 'legacy-chat',
        apiKey: 'legacy-secret',
        category: 'text',
      }],
    });

    await useAppStore.getState().loadConfig();
    const migrated = useAppStore.getState().config;
    const model = migrated.generalModels?.[0];
    expect(model?.providerConfigId).toMatch(/^custom-/);
    expect(model).not.toHaveProperty('apiKey');
    expect(model).not.toHaveProperty('openaiUrl');
    expect(model).not.toHaveProperty('anthropicUrl');
    expect(migrated.providers[model!.providerConfigId]).toMatchObject({
      apiKey: 'legacy-secret',
      baseUrl: 'https://legacy.example/v1',
    });

    await useAppStore.getState().saveConfig();
    const saved = fileMocks.saveConfig.mock.calls[0]?.[0] as AppConfig | undefined;
    expect(JSON.stringify(saved?.generalModels)).not.toContain('legacy-secret');
    expect(saved?.generalModels?.[0]).toEqual(model);
  });

  it('syncs custom provider models without copying credentials or addresses', () => {
    useAppStore.getState().saveProviderConfig('custom-current', {
      name: '当前连接',
      apiKey: 'provider-only-secret',
      baseUrl: 'https://current.example/v1',
      anthropicUrl: 'https://current.example/anthropic',
      catalogId: 'custom-openai',
      selectedModels: [{
        id: 'current-image',
        name: '当前图片模型',
        category: 'image',
        provider: 'custom-current',
        imageReferenceRequestMode: 'edits-multipart',
      }],
    });

    const model = useAppStore.getState().config.generalModels?.[0];
    expect(model).toMatchObject({
      modelId: 'current-image',
      providerConfigId: 'custom-current',
      imageReferenceRequestMode: 'edits-multipart',
    });
    expect(model).not.toHaveProperty('apiKey');
    expect(model).not.toHaveProperty('openaiUrl');
    expect(model).not.toHaveProperty('anthropicUrl');
  });

  it('clears every model reference owned by a removed provider', async () => {
    localStorage.setItem('canvas-model-prefs', JSON.stringify({
      'ai-text': 'general/provider-text',
      'ai-image': 'apimart/image-model',
      'ai-video': 'other/video-model',
    }));
    fileMocks.loadProjectsList.mockResolvedValue([{
      id: 'other-project',
      name: '其他项目',
      createdAt: 2,
      updatedAt: 2,
      settings: {
        defaultModels: {
          video: 'apimart/video-model',
          audio: 'other/audio-model',
        },
      },
      nodes: [
        {
          id: 'other-provider-node',
          data: { label: '待清理', type: 'ai-video', model: 'apimart/video-model', provider: 'apimart' },
        },
        {
          id: 'other-kept-node',
          data: { label: '保留', type: 'ai-audio', model: 'other/audio-model', provider: 'other' },
        },
      ],
      edges: [],
    }]);
    useAppStore.setState({
      config: {
        providers: {
          apimart: {
            name: 'APIMart',
            apiKey: 'secret',
            catalogId: 'apimart',
            selectedModels: [{
              id: 'image-model',
              name: '图片模型',
              category: 'image',
              provider: 'apimart',
            }],
          },
          other: { name: '其他厂商', apiKey: 'kept' },
        },
        theme: 'dark',
        generalModels: [
          {
            id: 'provider-text',
            name: '厂商文本模型',
            modelId: 'text-model',
            category: 'text',
            providerConfigId: 'apimart',
          },
          {
            id: 'other-text',
            name: '其他文本模型',
            modelId: 'other-text-model',
            category: 'text',
            providerConfigId: 'other',
          },
        ],
        assistantModelId: 'provider-text',
        assistantImageModelId: 'apimart/image-model',
        assistantVideoModelId: 'other/video-model',
      },
      projects: [
        {
          id: 'current-project',
          name: '当前项目',
          createdAt: 1,
          updatedAt: 1,
          settings: {
            defaultModels: {
              text: 'general/provider-text',
              image: 'other/image-model',
            },
          },
        },
        {
          id: 'other-project',
          name: '其他项目',
          createdAt: 2,
          updatedAt: 2,
          settings: {
            defaultModels: {
              video: 'apimart/video-model',
              audio: 'other/audio-model',
            },
          },
        },
      ],
      currentProjectId: 'current-project',
      projectName: '当前项目',
      nodes: [
        {
          id: 'general-node',
          type: 'ai-text',
          position: { x: 0, y: 0 },
          data: { label: '通用模型', type: 'ai-text', model: 'general/provider-text', provider: 'general' },
        },
        {
          id: 'provider-node',
          type: 'ai-image',
          position: { x: 10, y: 10 },
          data: { label: '厂商模型', type: 'ai-image', model: 'apimart/image-model', provider: 'apimart' },
        },
        {
          id: 'kept-node',
          type: 'ai-video',
          position: { x: 20, y: 20 },
          data: { label: '保留模型', type: 'ai-video', model: 'other/video-model', provider: 'other' },
        },
      ],
      edges: [],
      groups: [],
      history: [],
      historyIndex: -1,
    });

    await useAppStore.getState().removeProviderConfig('apimart');

    const state = useAppStore.getState();
    expect(state.config.providers).not.toHaveProperty('apimart');
    expect(state.config.generalModels?.map((model) => model.id)).toEqual(['other-text']);
    expect(state.config.assistantModelId).toBeUndefined();
    expect(state.config.assistantImageModelId).toBeUndefined();
    expect(state.config.assistantVideoModelId).toBe('other/video-model');
    expect(state.projects[0].settings?.defaultModels).toEqual({ image: 'other/image-model' });
    expect(state.projects[1].settings?.defaultModels).toEqual({ audio: 'other/audio-model' });
    expect(state.nodes.map((node) => ({ model: node.data.model, provider: node.data.provider }))).toEqual([
      { model: undefined, provider: undefined },
      { model: undefined, provider: undefined },
      { model: 'other/video-model', provider: 'other' },
    ]);
    expect(state.history).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('canvas-model-prefs') || '{}')).toEqual({
      'ai-video': 'other/video-model',
    });
    expect(fileMocks.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      id: 'current-project',
      nodes: expect.arrayContaining([
        expect.objectContaining({
          id: 'general-node',
          data: expect.objectContaining({ model: undefined, provider: undefined }),
        }),
      ]),
    }));
    expect(fileMocks.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      id: 'other-project',
      settings: { defaultModels: { audio: 'other/audio-model' } },
      nodes: expect.arrayContaining([
        expect.objectContaining({
          id: 'other-provider-node',
          data: expect.objectContaining({ model: undefined, provider: undefined }),
        }),
      ]),
    }));
  });

  it('keeps RunningHub standard model references when only workflow credentials are removed', async () => {
    useAppStore.setState({
      config: {
        providers: {
          'runninghub-model': { name: 'RunningHub 模型', apiKey: 'model-key' },
          runninghub: { name: 'RunningHub 工作流', apiKey: 'workflow-key' },
        },
        theme: 'dark',
        assistantImageModelId: 'runninghub/nanobanana',
      },
      nodes: [{
        id: 'runninghub-node',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: {
          label: 'RunningHub 模型',
          type: 'ai-image',
          model: 'runninghub/nanobanana',
          provider: 'runninghub',
        },
      }],
      history: [],
      historyIndex: -1,
    });

    await useAppStore.getState().removeProviderConfig('runninghub');

    const state = useAppStore.getState();
    expect(state.config.providers).toHaveProperty('runninghub-model');
    expect(state.config.providers).not.toHaveProperty('runninghub');
    expect(state.config.assistantImageModelId).toBe('runninghub/nanobanana');
    expect(state.nodes[0].data).toMatchObject({
      model: 'runninghub/nanobanana',
      provider: 'runninghub',
    });
    expect(state.history).toHaveLength(0);
  });
});

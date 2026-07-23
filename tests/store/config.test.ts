import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/types';

const fileMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn<(config: unknown) => Promise<void>>(async () => undefined),
  setBaseDataDir: vi.fn(),
  syncAuthorizedDirectories: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/fileService', () => fileMocks);

import { useAppStore } from '../../src/store/useAppStore';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  fileMocks.loadConfig.mockReset();
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
        id: 'current-chat',
        name: '当前模型',
        category: 'text',
        provider: 'custom-current',
      }],
    });

    const model = useAppStore.getState().config.generalModels?.[0];
    expect(model).toMatchObject({
      modelId: 'current-chat',
      providerConfigId: 'custom-current',
    });
    expect(model).not.toHaveProperty('apiKey');
    expect(model).not.toHaveProperty('openaiUrl');
    expect(model).not.toHaveProperty('anthropicUrl');
  });
});

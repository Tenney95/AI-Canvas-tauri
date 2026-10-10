import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/types';
import type { ConfigSaveOptions, LoadedConfig } from '../../src/services/storageService';
import { ConfigConflictError, configWithoutSecrets } from '../../src/services/configPatch';
import { cloneAppearanceTheme, getBuiltinAppearanceTheme } from '../../src/services/appearance/appearanceDefaults';

const fileMocks = vi.hoisted(() => {
  const loadConfig = vi.fn();
  return {
    loadConfig,
    // 凭据改由凭据存储托管后，store 走 loadConfigWithSecrets；沿用 loadConfig 的桩数据
    loadConfigWithSecrets: vi.fn<(_options?: { allowSecretReadFailure?: boolean }) => Promise<LoadedConfig>>(async () => ({
      config: await loadConfig(),
      missingSecrets: [] as string[],
    })),
    loadProjectsList: vi.fn(async () => [] as Array<Record<string, unknown>>),
    loadProjectData: vi.fn(async () => null as Record<string, unknown> | null),
    saveProject: vi.fn(async (record: { id: string }) => record.id),
    saveConfig: vi.fn<(config: unknown, options?: ConfigSaveOptions) => Promise<string[]>>(async () => []),
    setBaseDataDir: vi.fn(),
    syncAuthorizedDirectories: vi.fn(async () => undefined),
  };
});

vi.mock('../../src/services/fileService', () => fileMocks);

import { useAppStore } from '../../src/store/useAppStore';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  fileMocks.loadConfig.mockReset();
  fileMocks.loadConfigWithSecrets.mockReset();
  fileMocks.loadConfigWithSecrets.mockImplementation(async () => ({
    config: await fileMocks.loadConfig(),
    missingSecrets: [],
  }));
  fileMocks.saveConfig.mockReset();
  fileMocks.saveConfig.mockResolvedValue([]);
  fileMocks.loadProjectsList.mockReset();
  fileMocks.loadProjectsList.mockResolvedValue([]);
  fileMocks.loadProjectData.mockReset();
  fileMocks.loadProjectData.mockResolvedValue(null);
  fileMocks.saveProject.mockClear();
  fileMocks.setBaseDataDir.mockClear();
  fileMocks.syncAuthorizedDirectories.mockReset();
  fileMocks.syncAuthorizedDirectories.mockResolvedValue(undefined);
});

describe('config hydration guard', () => {
  it.each(['enter', 'shift-enter', 'ctrl-enter', 'alt-enter'] as const)('发送快捷键 %s 通过现有配置保存并在重新加载后恢复', async (shortcut) => {
    fileMocks.loadConfig.mockResolvedValue({ providers: {}, theme: 'dark' });
    await useAppStore.getState().loadConfig();
    expect(useAppStore.getState().config.promptSubmitShortcut).toBeUndefined();
    useAppStore.getState().updateConfig({ promptSubmitShortcut: shortcut });
    expect(useAppStore.getState().configDirty).toBe(true);
    await useAppStore.getState().saveConfig({ silent: true });
    const saved = fileMocks.saveConfig.mock.calls.at(-1)?.[0] as AppConfig;
    expect(saved.promptSubmitShortcut).toBe(shortcut);
    fileMocks.loadConfig.mockResolvedValue(saved);
    useAppStore.setState(useAppStore.getInitialState(), true);
    await useAppStore.getState().loadConfig();
    expect(useAppStore.getState().config.promptSubmitShortcut).toBe(shortcut);
  });

  it('repairs missing CCC addresses on load while retaining custom addresses, group Keys and model identities', async () => {
    fileMocks.loadConfig.mockResolvedValue({ providers: {
      cccapi: { name: 'CCC', apiKey: 'legacy-fixture' },
      'cccapi-pro': { name: 'CCC Pro', catalogId: 'cccapi', cccGroup: 'GPT-特价Pro', apiKey: 'pro-fixture', baseUrl: '   ' },
      'cccapi-custom': { name: 'CCC Custom', catalogId: 'cccapi', cccGroup: 'GPT-Pro分组', apiKey: 'custom-fixture', baseUrl: 'https://custom.example/v1' },
      'cccapi-lookalike': { name: '自定义', catalogId: 'custom-openai', apiKey: '', baseUrl: '' },
    }, generalModels: [{ id: 'ccc-pro-text', name: 'GPT-5.6 Sol', modelId: 'gpt-5.6-sol', category: 'text', providerConfigId: 'cccapi-pro' }] });
    await useAppStore.getState().loadConfig();
    const { providers, generalModels } = useAppStore.getState().config;
    expect(providers.cccapi).toMatchObject({ apiKey: 'legacy-fixture', baseUrl: 'https://cccapi.cn/v1' });
    expect(providers['cccapi-pro']).toMatchObject({ apiKey: 'pro-fixture', cccGroup: 'GPT-特价Pro', baseUrl: 'https://cccapi.cn/v1' });
    expect(providers['cccapi-custom']).toMatchObject({ apiKey: 'custom-fixture', baseUrl: 'https://custom.example/v1' });
    expect(providers['cccapi-lookalike'].baseUrl).toBe('');
    expect(generalModels).toEqual([expect.objectContaining({ id: 'ccc-pro-text', modelId: 'gpt-5.6-sol', providerConfigId: 'cccapi-pro' })]);
  });

  it('saves multiple CCC group credentials and model bindings in one configuration snapshot', async () => {
    fileMocks.loadConfig.mockResolvedValue({ providers: {} });
    await useAppStore.getState().loadConfig();
    for (const [id, group, modelId] of [
      ['cccapi-banana', '🍌香蕉（官k）', 'nano-banana-pro'],
      ['cccapi-stable', 'CCC生图稳定', 'gpt-image-2'],
    ]) useAppStore.getState().saveProviderConfig(id, {
      name: 'CCC', catalogId: 'cccapi', cccGroup: group, apiKey: `${id}-fixture`,
      selectedModels: [{ id: modelId, name: modelId, category: 'image', provider: id }],
    });
    await useAppStore.getState().saveConfig({ throwOnError: true });
    expect(fileMocks.saveConfig).toHaveBeenCalledTimes(1);
    const saved = fileMocks.saveConfig.mock.calls[0][0] as AppConfig;
    expect(saved.providers['cccapi-banana'].apiKey).toBe('cccapi-banana-fixture');
    expect(saved.providers['cccapi-stable'].apiKey).toBe('cccapi-stable-fixture');
    expect(saved.providers['cccapi-banana'].baseUrl).toBe('https://cccapi.cn/v1');
    expect(saved.providers['cccapi-stable'].baseUrl).toBe('https://cccapi.cn/v1');
    expect(saved.generalModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'nano-banana-pro', providerConfigId: 'cccapi-banana' }),
      expect.objectContaining({ modelId: 'gpt-image-2', providerConfigId: 'cccapi-stable' }),
    ]));
    const identities = saved.generalModels!.map((model) => model.id);
    fileMocks.loadConfig.mockResolvedValue(saved);
    await useAppStore.getState().loadConfig();
    expect(useAppStore.getState().config.generalModels!.map((model) => model.id)).toEqual(identities);
    expect(useAppStore.getState().config.providers['cccapi-banana'].apiKey).toBe('cccapi-banana-fixture');
    expect(useAppStore.getState().config.providers['cccapi-stable'].apiKey).toBe('cccapi-stable-fixture');
  });
  it('keeps CCC group model identities stable and removes only the selected connection references', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {} } }));
    for (const id of ['cccapi', 'cccapi-free', 'cccapi-stable']) {
      useAppStore.getState().saveProviderConfig(id, { name: 'CCC', catalogId: 'cccapi', apiKey: `${id}-fixture`,
        ...(id !== 'cccapi' ? { cccGroup: id } : {}),
        // 模拟旧目录中仍使用根 provider 的缓存，删除分组不能伤及根连接。
        selectedModels: [{ id: 'gpt-image-2', name: 'Image', category: 'image', provider: 'cccapi' }],
      });
    }
    const before = useAppStore.getState().config.generalModels!;
    expect(new Set(before.map((model) => model.id)).size).toBe(3);
    const stable = before.find((model) => model.providerConfigId === 'cccapi-stable')!;
    const free = before.find((model) => model.providerConfigId === 'cccapi-free')!;
    useAppStore.getState().saveProviderConfig('cccapi-stable', useAppStore.getState().config.providers['cccapi-stable']);
    expect(useAppStore.getState().config.generalModels!.find((model) => model.providerConfigId === 'cccapi-stable')!.id).toBe(stable.id);
    useAppStore.getState().updateConfig({ assistantImageModelId: `general/${stable.id}` });
    useAppStore.setState({ nodes: [
      { id: 'legacy', type: 'ai-image', position: { x: 0, y: 0 }, data: { label: 'Image', type: 'ai-image', provider: 'cccapi', model: 'cccapi/gpt-image-2' } },
      { id: 'stable', type: 'ai-image', position: { x: 0, y: 0 }, data: { label: 'Image', type: 'ai-image', provider: 'general', model: `general/${stable.id}` } },
      { id: 'free', type: 'ai-image', position: { x: 0, y: 0 }, data: { label: 'Image', type: 'ai-image', provider: 'general', model: `general/${free.id}` } },
    ] });
    await useAppStore.getState().removeProviderConfig('cccapi-free');
    const state = useAppStore.getState();
    expect(state.config.generalModels!.map((model) => model.providerConfigId)).toEqual(['cccapi', 'cccapi-stable']);
    expect(state.config.providers['cccapi-stable'].apiKey).toBe('cccapi-stable-fixture');
    expect(state.config.assistantImageModelId).toBe(`general/${stable.id}`);
    expect(state.nodes.map((node) => node.data.model)).toEqual(['cccapi/gpt-image-2', `general/${stable.id}`, undefined]);
  });
  it('persists an activated appearance before reporting the save as complete', async () => {
    fileMocks.loadConfig.mockResolvedValue({ providers: {} });
    await useAppStore.getState().loadConfig();
    const theme = getBuiltinAppearanceTheme('standard-light');
    await useAppStore.getState().activateAppearanceTheme(theme);
    expect(fileMocks.saveConfig).toHaveBeenCalledOnce();
    expect(fileMocks.saveConfig.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ appearance: theme }));
    expect(useAppStore.getState()).toMatchObject({ configDirty: false, configSaveStatus: 'saved' });
  });

  it('does not mutate a saved custom preset during ordinary appearance edits', async () => {
    fileMocks.loadConfig.mockResolvedValue({ providers: {} });
    await useAppStore.getState().loadConfig();
    const preset = cloneAppearanceTheme(getBuiltinAppearanceTheme('standard-dark'), 'theme-fixture', '自定义预设');
    useAppStore.setState({ appearanceThemes: [preset] });
    await useAppStore.getState().activateAppearanceTheme({ ...preset, ui: { ...preset.ui, accent: '#be4b78' } });
    expect(useAppStore.getState().appearanceThemes[0]).toEqual(preset);
    expect(useAppStore.getState().config.appearance?.ui.accent).toBe('#be4b78');
  });

  it('keeps appearance changes dirty when persistence fails', async () => {
    fileMocks.loadConfig.mockResolvedValue({ providers: {} });
    await useAppStore.getState().loadConfig();
    fileMocks.saveConfig.mockRejectedValueOnce(new Error('fixture-private'));
    await expect(useAppStore.getState().activateAppearanceTheme(getBuiltinAppearanceTheme('standard-light')))
      .rejects.toThrow('设置保存失败');
    expect(useAppStore.getState()).toMatchObject({ configDirty: true, configSaveStatus: 'error' });
  });

  it('keeps failed edits dirty and clears the error only after a successful retry', async () => {
    fileMocks.loadConfig.mockResolvedValue({ theme: 'dark', providers: {} });
    await useAppStore.getState().loadConfig();
    useAppStore.getState().updateConfig({ theme: 'light' });
    fileMocks.saveConfig.mockRejectedValueOnce(new Error('fixture-private'));
    await expect(useAppStore.getState().saveConfig()).rejects.toThrow('设置保存失败');
    expect(useAppStore.getState()).toMatchObject({ configDirty: true, configSaveStatus: 'error', config: { theme: 'light' } });
    await useAppStore.getState().saveConfig();
    expect(useAppStore.getState()).toMatchObject({ configDirty: false, configSaveStatus: 'saved', configSaveError: null });
  });

  it('saves a later reversal after the first pending operation', async () => {
    fileMocks.loadConfig.mockResolvedValue({ theme: 'dark', providers: {} });
    await useAppStore.getState().loadConfig();
    let finish!: () => void;
    fileMocks.saveConfig.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve([]); }));
    useAppStore.getState().updateConfig({ theme: 'light' });
    const first = useAppStore.getState().saveConfig();
    await Promise.resolve();
    useAppStore.getState().updateConfig({ theme: 'dark' });
    const second = useAppStore.getState().saveConfig();
    finish(); await first; await second;
    expect(fileMocks.saveConfig.mock.calls[1][1]?.changes).toContainEqual({ path: ['theme'], before: 'light', after: 'dark' });
    expect(useAppStore.getState()).toMatchObject({ configDirty: false, config: { theme: 'dark' } });
  });

  it('reports conflicts without replacing local edits and resets the baseline on reload', async () => {
    fileMocks.loadConfig.mockResolvedValue({ language: 'zh-CN', providers: {} });
    await useAppStore.getState().loadConfig();
    useAppStore.getState().updateConfig({ language: 'en-US' });
    fileMocks.saveConfig.mockRejectedValueOnce(new ConfigConflictError());
    await expect(useAppStore.getState().saveConfig()).rejects.toBeInstanceOf(ConfigConflictError);
    expect(useAppStore.getState()).toMatchObject({ configSaveStatus: 'conflict', configDirty: true, config: { language: 'en-US' } });
    fileMocks.loadConfig.mockResolvedValue({ language: 'ja-JP', providers: {} });
    await useAppStore.getState().loadConfig();
    expect(useAppStore.getState()).toMatchObject({ configSaveStatus: 'idle', configDirty: false, config: { language: 'ja-JP' } });
  });

  it('preserves edits made during loading while adopting the new disk baseline', async () => {
    let finish!: (config: unknown) => void;
    fileMocks.loadConfig.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const loading = useAppStore.getState().loadConfig();
    await Promise.resolve();
    useAppStore.getState().updateConfig({ language: 'en-US' });
    finish({ theme: 'light', language: 'ja-JP', providers: {} }); await loading;
    expect(useAppStore.getState()).toMatchObject({ configDirty: true, config: { theme: 'light', language: 'en-US' }, configEditBaseline: { language: 'ja-JP' } });
  });

  it('marks only explicit credential changes and keeps plaintext out of baselines', async () => {
    fileMocks.loadConfig.mockResolvedValue({ providers: { a: { name: 'A', apiKey: 'fixture-key', apiKeyRef: 'secret:provider/a' } } });
    await useAppStore.getState().loadConfig();
    useAppStore.getState().updateConfig({ theme: 'light' });
    await useAppStore.getState().saveConfig();
    expect(fileMocks.saveConfig.mock.calls[0][1]?.secretChanges).toEqual({});
    useAppStore.getState().setProviderKey('a', 'replacement-key');
    await useAppStore.getState().saveConfig();
    expect(Object.keys(fileMocks.saveConfig.mock.calls[1][1]?.secretChanges ?? {})).toEqual(['a']);
    expect(JSON.stringify(useAppStore.getState().configEditBaseline)).not.toContain('replacement-key');
    expect(configWithoutSecrets(useAppStore.getState().config)).toEqual(useAppStore.getState().configEditBaseline);
  });

  it('allows ordinary saves after credential-only errors and retains references in editor drafts', async () => {
    const config = { providers: { a: { name: 'A', apiKeyRef: 'secret:provider/a' } } };
    fileMocks.loadConfigWithSecrets.mockResolvedValueOnce({ config, persistedConfig: config, unreadSecrets: ['a'], missingSecrets: [] });
    await useAppStore.getState().loadConfig();
    expect(useAppStore.getState().configHydrated).toBe(true);
    useAppStore.getState().saveProviderConfig('a', { name: '改名', apiKey: '' });
    await useAppStore.getState().saveConfig();
    expect(useAppStore.getState().config.providers.a.apiKeyRef).toBe('secret:provider/a');
    expect(fileMocks.saveConfig.mock.calls[0][1]?.secretChanges).toEqual({});
    expect(useAppStore.getState().configSecretReadErrors).toEqual(['a']);
  });

  it('rejects every failed save with a sanitized error', async () => {
    useAppStore.setState({ configHydrated: true });
    fileMocks.saveConfig.mockRejectedValue(new Error('private-path-and-secret'));
    await expect(useAppStore.getState().saveConfig({ throwOnError: true }))
      .rejects.toThrow('设置保存失败');
    await expect(useAppStore.getState().saveConfig()).rejects.toThrow();
  });

  it('rejects strict saves before hydration without writing defaults', async () => {
    await expect(useAppStore.getState().saveConfig({ throwOnError: true }))
      .rejects.toThrow('配置尚未完成加载');
    expect(fileMocks.saveConfig).not.toHaveBeenCalled();
  });

  it('distinguishes persisted config from credentials that remain session-only', async () => {
    useAppStore.setState({ configHydrated: true });
    fileMocks.saveConfig.mockResolvedValue(['private-provider-id']);
    await expect(useAppStore.getState().saveConfig({ throwOnError: true }))
      .rejects.toThrow('配置已保存，但凭据存储不可用');
    await expect(useAppStore.getState().saveConfig()).rejects.toThrow();
  });

  it('reports a directory synchronization failure after persistence separately', async () => {
    useAppStore.setState({ configHydrated: true });
    fileMocks.syncAuthorizedDirectories.mockRejectedValue(new Error('private-directory'));
    await expect(useAppStore.getState().saveConfig({ throwOnError: true }))
      .rejects.toThrow('配置已保存，但目录授权同步失败');
    expect(fileMocks.saveConfig).toHaveBeenCalledOnce();
  });

  it('does not hide a session-only credential warning when directory synchronization also fails', async () => {
    useAppStore.setState({ configHydrated: true });
    fileMocks.saveConfig.mockResolvedValue(['private-ref']);
    fileMocks.syncAuthorizedDirectories.mockRejectedValue(new Error('private-directory'));
    await expect(useAppStore.getState().saveConfig({ throwOnError: true }))
      .rejects.toThrow(/目录授权同步失败.*API Key 仅本次会话有效/);
  });

  it('does not overwrite edits made while config persistence is pending', async () => {
    useAppStore.setState({ configHydrated: true });
    fileMocks.saveConfig.mockImplementationOnce(async () => {
      useAppStore.getState().updateConfig({ theme: 'light' });
      return [];
    });
    await useAppStore.getState().saveConfig({ throwOnError: true });
    expect(useAppStore.getState().config.theme).toBe('light');
  });

  it('blocks persistence until the saved config has been loaded', async () => {
    useAppStore.getState().updateConfig({ baseDataDir: 'new-default-path' });

    await expect(useAppStore.getState().saveConfig()).rejects.toThrow();

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
    expect(fileMocks.saveConfig.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      baseDataDir: 'existing-root',
      assetFolders: ['existing-assets'],
    }));
  });

  it('defaults to the project library and preserves the last-project startup preference', async () => {
    expect(useAppStore.getState().config.startupView).toBe('project-library');
    fileMocks.loadConfig.mockResolvedValue({
      providers: {},
      theme: 'dark',
      startupView: 'last-project',
    });

    await useAppStore.getState().loadConfig();
    await useAppStore.getState().saveConfig({ silent: true });

    expect(useAppStore.getState().config.startupView).toBe('last-project');
    expect(fileMocks.saveConfig.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      startupView: 'last-project',
    }));
  });

  it('shares project library visibility through the UI store', () => {
    expect(useAppStore.getState().projectLibraryOpen).toBe(false);

    useAppStore.getState().setProjectLibraryOpen(true);

    expect(useAppStore.getState().projectLibraryOpen).toBe(true);
  });

  it('silently persists the selected assistant model without a success toast', async () => {
    fileMocks.loadConfig.mockResolvedValue({ providers: {}, theme: 'dark' });
    await useAppStore.getState().loadConfig();
    useAppStore.getState().updateConfig({ assistantModelId: 'volcengine/doubao-seed' });

    await useAppStore.getState().saveConfig({ silent: true });

    expect(fileMocks.saveConfig.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      assistantModelId: 'volcengine/doubao-seed',
    }));
    expect(useAppStore.getState().toast.visible).toBe(false);
  });

  it('keeps persistence blocked when loading the saved config fails', async () => {
    fileMocks.loadConfig.mockRejectedValue(new Error('private-path-and-secret'));

    await expect(useAppStore.getState().loadConfig()).rejects.toThrow('已阻止覆盖原配置');
    await expect(useAppStore.getState().saveConfig()).rejects.toThrow();

    expect(useAppStore.getState().configHydrated).toBe(false);
    expect(fileMocks.saveConfig).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast).toMatchObject({
      visible: true,
      type: 'error',
      message: expect.stringContaining('已阻止覆盖原配置'),
    });
    expect(useAppStore.getState().toast.message).not.toContain('private-path-and-secret');
  });

  it('explains that a newer database requires a newer application without enabling writes', async () => {
    fileMocks.loadConfig.mockRejectedValue(new DOMException('private-database-path', 'VersionError'));

    await expect(useAppStore.getState().loadConfig()).rejects.toThrow('较新版本');
    await expect(useAppStore.getState().saveConfig()).rejects.toThrow();

    expect(useAppStore.getState().configHydrated).toBe(false);
    expect(fileMocks.saveConfig).not.toHaveBeenCalled();
    expect(useAppStore.getState().toast.message).toContain('较新版本');
    expect(useAppStore.getState().toast.message).not.toContain('private-database-path');
  });

  it('blocks saves while reloading and restores the saved providers after a failed read', async () => {
    const savedConfig = {
      providers: { retained: { name: '已有连接', apiKey: 'test-only-key' } },
      theme: 'light',
    };
    fileMocks.loadConfig.mockResolvedValue(savedConfig);
    await useAppStore.getState().loadConfig();
    const previousConfig = useAppStore.getState().config;
    let rejectReload!: (error: Error) => void;
    fileMocks.loadConfig.mockReturnValueOnce(new Promise((_resolve, reject) => {
      rejectReload = reject;
    }));

    const reloading = useAppStore.getState().loadConfig();
    await expect(useAppStore.getState().saveConfig()).rejects.toThrow();
    expect(fileMocks.saveConfig).not.toHaveBeenCalled();
    rejectReload(new Error('read interrupted'));
    await expect(reloading).rejects.toThrow('已阻止覆盖原配置');

    expect(useAppStore.getState().config).toBe(previousConfig);
    expect(useAppStore.getState().configHydrated).toBe(false);

    await useAppStore.getState().loadConfig();
    await useAppStore.getState().saveConfig();
    expect(fileMocks.saveConfig).toHaveBeenCalledOnce();
    expect(fileMocks.saveConfig.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining(savedConfig));
  });

  it('allows first-run settings to be saved when the configuration is genuinely absent', async () => {
    fileMocks.loadConfig.mockResolvedValue(null);

    await useAppStore.getState().loadConfig();
    await useAppStore.getState().saveConfig();

    expect(useAppStore.getState().configHydrated).toBe(true);
    expect(fileMocks.saveConfig).toHaveBeenCalledOnce();
  });

  it('blocks default writes when the real persistence service cannot read an existing config', async () => {
    const persistence = await import('../../src/services/storageService');
    const repository = await import('../../src/services/indexedDbService');
    const saved = { theme: 'light', providers: { retained: { name: '已有连接', apiKey: '' } } };
    await repository.saveConfigToDb(saved);
    fileMocks.loadConfigWithSecrets.mockImplementation(persistence.loadConfigWithSecrets);
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementationOnce(() => {
      throw new DOMException('read interrupted', 'UnknownError');
    });

    await expect(useAppStore.getState().loadConfig()).rejects.toThrow('已阻止覆盖原配置');
    await expect(useAppStore.getState().saveConfig()).rejects.toThrow();

    expect(useAppStore.getState().configHydrated).toBe(false);
    expect(fileMocks.saveConfig).not.toHaveBeenCalled();
    await expect(repository.loadConfigFromDb()).resolves.toEqual(saved);

    await useAppStore.getState().loadConfig();
    expect(useAppStore.getState().configHydrated).toBe(true);
    expect(useAppStore.getState().config.providers).toEqual(saved.providers);
  });

  it('stops project initialization when its data-directory configuration cannot be loaded', async () => {
    for (const action of [
      'loadWorkflows', 'loadPresets', 'loadSkills', 'loadSubAgentProfiles',
      'loadCustomStyles', 'loadToolbarLayouts', 'loadPlugins',
    ] as const) {
      vi.spyOn(useAppStore.getState(), action).mockResolvedValue(undefined);
    }
    fileMocks.loadConfig.mockRejectedValue(new Error('configuration read failed'));

    await useAppStore.getState().initFromDb();

    expect(useAppStore.getState().configHydrated).toBe(false);
    expect(useAppStore.getState().projectLoadStatus).toBe('error');
    expect(fileMocks.loadProjectsList).not.toHaveBeenCalled();
    expect(fileMocks.loadProjectData).not.toHaveBeenCalled();
    expect(fileMocks.saveProject).not.toHaveBeenCalled();
    expect(fileMocks.saveConfig).not.toHaveBeenCalled();
  });

  it('keeps persistence enabled when only directory authorization sync fails', async () => {
    fileMocks.loadConfig.mockResolvedValue({ providers: {}, theme: 'dark' });
    fileMocks.syncAuthorizedDirectories.mockRejectedValue(new Error('sync failed'));

    await useAppStore.getState().loadConfig();
    await expect(useAppStore.getState().saveConfig()).rejects.toThrow();

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
      }, {
        id: 'legacy-model-2',
        name: '旧模型二',
        openaiUrl: 'https://legacy.example/v1',
        anthropicUrl: 'https://legacy.example/anthropic',
        modelId: 'legacy-chat-2',
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
    // anthropicUrl 从未参与请求，只有它不同的旧模型应并进同一条连接而不是各建一条
    expect(Object.keys(migrated.providers).filter((id) => id.startsWith('custom-'))).toHaveLength(1);

    await useAppStore.getState().saveConfig();
    const saved = fileMocks.saveConfig.mock.calls[0]?.[0] as AppConfig | undefined;
    expect(JSON.stringify(saved?.generalModels)).not.toContain('legacy-secret');
    expect(saved?.generalModels?.[0]).toEqual(model);
  });

  it('migrates the legacy GRSAI default URL without changing custom endpoints', async () => {
    fileMocks.loadConfig.mockResolvedValue({
      providers: {
        grsai: {
          name: 'GRSAI',
          apiKey: 'grsai-secret',
          baseUrl: 'https://api.grsai.com/',
          catalogId: 'grsai',
        },
        'grsai-v1': {
          name: 'GRSAI V1',
          apiKey: 'grsai-v1-secret',
          baseUrl: 'https://api.grsai.com/v1/',
          catalogId: 'grsai',
        },
        'grsai-global': {
          name: 'GRSAI Global',
          apiKey: 'grsai-global-secret',
          baseUrl: 'https://grsaiapi.com/v1/',
          catalogId: 'grsai',
        },
        'grsai-custom': {
          name: 'GRSAI Custom',
          apiKey: 'custom-secret',
          baseUrl: 'https://gateway.example/grsai',
          catalogId: 'grsai',
        },
      },
      theme: 'dark',
      generalModels: [],
    });

    await useAppStore.getState().loadConfig();

    expect(useAppStore.getState().config.providers.grsai.baseUrl).toBe(
      'https://grsai.dakka.com.cn/v1',
    );
    expect(useAppStore.getState().config.providers['grsai-v1'].baseUrl).toBe(
      'https://grsai.dakka.com.cn/v1',
    );
    expect(useAppStore.getState().config.providers['grsai-global'].baseUrl).toBe(
      'https://grsai.dakka.com.cn/v1',
    );
    expect(useAppStore.getState().config.providers['grsai-custom'].baseUrl).toBe(
      'https://gateway.example/grsai',
    );
  });

  it('syncs custom provider models without copying credentials or addresses', () => {
    useAppStore.getState().saveProviderConfig('custom-current', {
      name: '当前连接',
      apiKey: 'provider-only-secret',
      baseUrl: 'https://current.example/v1',
      catalogId: 'custom-openai',
      selectedModels: [{
        id: 'current-image',
        name: '当前图片模型',
        category: 'image',
        provider: 'custom-current',
        imageReferenceRequestMode: 'edits-multipart',
      }, {
        id: 'current-chat',
        name: '当前文本模型',
        category: 'text',
        provider: 'custom-current',
        contextWindow: 262_144,
      }],
    });

    const model = useAppStore.getState().config.generalModels?.[0];
    expect(model).toMatchObject({
      modelId: 'current-image',
      providerConfigId: 'custom-current',
      imageReferenceRequestMode: 'edits-multipart',
    });
    expect(useAppStore.getState().config.generalModels?.[1]).toMatchObject({
      modelId: 'current-chat',
      contextWindow: 262_144,
    });
    expect(model).not.toHaveProperty('apiKey');
    expect(model).not.toHaveProperty('openaiUrl');
    expect(model).not.toHaveProperty('anthropicUrl');
  });

  it('keeps each image model protocol independent in a custom connection', () => {
    useAppStore.getState().saveProviderConfig('image-gateway', {
      name: '图片网关', apiKey: 'fixture-key', baseUrl: 'https://gateway.example/v1',
      catalogId: 'custom-openai',
      selectedModels: [
        { id: 'image-a', name: '图片 A', category: 'image', provider: 'image-gateway',
          executionProfile: { preset: 'gpt-image-gateway-json' } },
        { id: 'image-b', name: '图片 B', category: 'image', provider: 'image-gateway',
          executionProfile: { preset: 'openai-gpt-image' } },
        { id: 'text-a', name: '文本 A', category: 'text', provider: 'image-gateway' },
      ],
    });
    const models = useAppStore.getState().config.generalModels ?? [];
    expect(models.find((model) => model.modelId === 'image-a')?.executionProfile?.preset)
      .toBe('gpt-image-gateway-json');
    expect(models.find((model) => model.modelId === 'image-b')?.executionProfile?.preset)
      .toBe('openai-gpt-image');
    expect(models.find((model) => model.modelId === 'text-a')?.executionProfile).toBeUndefined();
    expect(useAppStore.getState().config.providers['image-gateway'].selectedModels?.[0]?.executionProfile?.preset)
      .toBe('gpt-image-gateway-json');

    useAppStore.getState().saveProviderConfig('image-gateway', {
      ...useAppStore.getState().config.providers['image-gateway'],
      selectedModels: useAppStore.getState().config.providers['image-gateway'].selectedModels?.map(
        (model) => model.id === 'image-a' ? { ...model, executionProfile: undefined } : model,
      ),
    });
    const resetModels = useAppStore.getState().config.generalModels ?? [];
    expect(resetModels.find((model) => model.modelId === 'image-a')?.executionProfile).toBeUndefined();
    expect(resetModels.find((model) => model.modelId === 'image-b')?.executionProfile?.preset)
      .toBe('openai-gpt-image');
  });

  it('syncs editable video capabilities into the unified model runtime', async () => {
    useAppStore.getState().saveProviderConfig('custom-video', {
      name: '视频连接',
      apiKey: 'provider-only-secret',
      baseUrl: 'https://video.example/v1',
      catalogId: 'custom-openai',
      selectedModels: [{
        id: 'custom-video-model',
        name: '自定义视频模型',
        category: 'video',
        provider: 'custom-video',
        videoCapability: {
          ratios: ['16:9', '9:16'],
          defaultRatio: '16:9',
          resolutions: ['720p', '1080p'],
          defaultResolution: '1080p',
          frameRates: [24, 30],
          defaultFrameRate: 24,
          minDuration: 4,
          maxDuration: 12,
          defaultDuration: 6,
        },
      }],
    });

    expect(useAppStore.getState().config.generalModels?.[0]?.videoCapability).toEqual({
      ratios: ['16:9', '9:16'],
      defaultRatio: '16:9',
      resolutions: ['720p', '1080p'],
      defaultResolution: '1080p',
      frameRates: [24, 30],
      defaultFrameRate: 24,
      minDuration: 4,
      maxDuration: 12,
      defaultDuration: 6,
    });

    // 保存/加载都会过 sanitizeGeneralModel，能力声明必须原样留在通用模型上
    fileMocks.loadConfig.mockResolvedValue(useAppStore.getState().config);
    await useAppStore.getState().loadConfig();
    expect(useAppStore.getState().config.generalModels?.[0]?.videoCapability?.frameRates)
      .toEqual([24, 30]);

    useAppStore.getState().saveProviderConfig('custom-video', {
      ...useAppStore.getState().config.providers['custom-video'],
      selectedModels: [{
        id: 'custom-video-model',
        name: '自定义视频模型',
        category: 'video',
        provider: 'custom-video',
      }],
    });

    expect(useAppStore.getState().config.generalModels?.[0]?.videoCapability).toBeUndefined();
  });

  it('defaults performance mode off, migrates the legacy compatibility flag, and applies changes immediately', async () => {
    const rootAttributes = new Set<string>();
    vi.stubGlobal('document', {
      documentElement: {
        dataset: {},
        toggleAttribute: (name: string, enabled: boolean) => {
          if (enabled) rootAttributes.add(name);
          else rootAttributes.delete(name);
        },
      },
    });

    expect(useAppStore.getState().config.performanceMode).toBe(false);
    expect(rootAttributes.has('data-performance-mode')).toBe(false);

    fileMocks.loadConfig.mockResolvedValue({
      providers: {},
      theme: 'dark',
      graphicsCompatibilityMode: true,
    });

    await useAppStore.getState().loadConfig();

    expect(useAppStore.getState().config.performanceMode).toBe(true);
    expect(useAppStore.getState().config).not.toHaveProperty('graphicsCompatibilityMode');
    expect(rootAttributes.has('data-performance-mode')).toBe(true);

    await useAppStore.getState().saveConfig({ silent: true });
    expect(fileMocks.saveConfig.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      performanceMode: true,
    }));
    expect(fileMocks.saveConfig.mock.calls[0]?.[0]).not.toHaveProperty('graphicsCompatibilityMode');

    useAppStore.getState().updateConfig({ performanceMode: false });

    expect(rootAttributes.has('data-performance-mode')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('syncs and clears xAI manifest models through the unified model runtime', () => {
    useAppStore.getState().saveProviderConfig('xai', {
      name: 'xAI / Grok 官方',
      apiKey: 'xai-secret',
      baseUrl: 'https://api.x.ai/v1',
      catalogId: 'xai',
      selectedModels: [{
        id: 'grok-imagine-video',
        name: 'Grok Imagine Video（文生视频）',
        category: 'video',
        provider: 'xai',
        executionProfile: {
          preset: 'custom',
          protocol: {
            version: 2,
            mode: 'async',
            submit: { method: 'POST', path: '/videos/generations' },
            response: { type: 'json', taskIdPath: 'request_id' },
            poll: {
              method: 'GET',
              path: '/videos/{{submit.request_id}}',
              response: {
                statusPath: 'status',
                successValues: ['done'],
                failureValues: ['failed', 'expired'],
                result: { urlPath: 'video.url' },
              },
            },
          },
        },
      }],
    });

    expect(useAppStore.getState().config.generalModels).toEqual([
      expect.objectContaining({
        modelId: 'grok-imagine-video',
        category: 'video',
        providerConfigId: 'xai',
        executionProfile: expect.objectContaining({ preset: 'custom' }),
      }),
    ]);
    expect(useAppStore.getState().config.generalModels?.[0]).not.toHaveProperty('apiKey');

    useAppStore.getState().saveProviderConfig('xai', {
      name: 'xAI / Grok 官方',
      apiKey: 'xai-secret',
      baseUrl: 'https://api.x.ai/v1',
      catalogId: 'xai',
      selectedModels: [],
    });

    expect(useAppStore.getState().config.generalModels).toEqual([]);
  });

  it('syncs Google media manifests without copying its API key', () => {
    useAppStore.getState().saveProviderConfig('google', {
      name: 'Google Gemini 官方',
      apiKey: 'google-secret',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      catalogId: 'google',
      selectedModels: [{
        id: 'gemini-3.1-flash-tts-preview',
        name: 'Gemini 3.1 Flash TTS（Kore / WAV）',
        category: 'audio',
        provider: 'google',
        executionProfile: {
          preset: 'custom',
          protocol: {
            version: 2,
            mode: 'sync',
            submit: { method: 'POST', path: '/v1beta/interactions', pathMode: 'origin' },
            response: {
              type: 'json',
              result: {
                base64Path: 'steps.*.content.*.data',
                mimeType: 'audio/wav',
                base64Transform: {
                  type: 'pcm-s16le-to-wav',
                  sampleRate: 24000,
                  channels: 1,
                },
              },
            },
          },
        },
      }],
    });

    expect(useAppStore.getState().config.generalModels).toEqual([
      expect.objectContaining({
        modelId: 'gemini-3.1-flash-tts-preview',
        category: 'audio',
        providerConfigId: 'google',
        executionProfile: expect.objectContaining({ preset: 'custom' }),
      }),
    ]);
    expect(useAppStore.getState().config.generalModels?.[0]).not.toHaveProperty('apiKey');
  });

  it('syncs Sora2U media models into the unified model runtime', () => {
    useAppStore.getState().saveProviderConfig('sora2u', {
      name: 'Sora2U',
      apiKey: 'sk_sora_secret',
      baseUrl: 'https://sora2u.com',
      catalogId: 'sora2u',
      selectedModels: [{
        id: 'seedance-2.5',
        name: 'Seedance 2.5',
        category: 'video',
        provider: 'sora2u',
        videoCapability: {
          minDuration: 5,
          maxDuration: 30,
          maxImageReferences: 30,
          maxVideoReferences: 10,
          maxAudioReferences: 10,
        },
        executionProfile: {
          preset: 'custom',
          protocol: {
            version: 2,
            mode: 'async',
            submit: { method: 'POST', path: '/api/v1/videos' },
            response: { type: 'json', taskIdPath: 'task.id' },
            poll: {
              method: 'GET',
              path: '/api/v1/videos/{{submit.task.id}}',
              response: {
                statusPath: 'task.status',
                successValues: ['completed'],
                failureValues: ['failed', 'canceled'],
                result: { urlPath: 'task.video_url' },
              },
            },
          },
        },
      }],
    });

    expect(useAppStore.getState().config.generalModels).toEqual([
      expect.objectContaining({
        modelId: 'seedance-2.5',
        category: 'video',
        providerConfigId: 'sora2u',
        videoCapability: expect.objectContaining({ maxDuration: 30 }),
        executionProfile: expect.objectContaining({ preset: 'custom' }),
      }),
    ]);
    expect(useAppStore.getState().config.generalModels?.[0]).not.toHaveProperty('apiKey');
  });

  it('clears every model reference owned by a removed provider', async () => {
    localStorage.setItem('canvas-model-prefs', JSON.stringify({
      'ai-text': 'general/provider-text',
      'ai-image': 'apimart/image-model',
      'ai-video': 'other/video-model',
    }));
    const otherProjectRecord = {
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
    };
    fileMocks.loadProjectsList.mockResolvedValue([{
      id: otherProjectRecord.id,
      name: otherProjectRecord.name,
      createdAt: otherProjectRecord.createdAt,
      updatedAt: otherProjectRecord.updatedAt,
      settings: otherProjectRecord.settings,
    }]);
    fileMocks.loadProjectData.mockResolvedValue(otherProjectRecord);
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
      projectLoadStatus: 'ready',
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
    expect(fileMocks.loadProjectData).toHaveBeenCalledWith('other-project');
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

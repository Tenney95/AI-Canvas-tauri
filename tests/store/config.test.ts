import { beforeEach, describe, expect, it, vi } from 'vitest';

const fileMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(async () => undefined),
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
});

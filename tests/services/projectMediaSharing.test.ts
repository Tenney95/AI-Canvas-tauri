import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProjectDataDir, isSharedProjectDataDir, registerProjectFolders } from '../../src/services/fs/core';

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/app', executableDir: async () => '/app',
}));

afterEach(() => vi.unstubAllGlobals());

describe('project shared media directories', () => {
  it('restores one shared directory for the series and all episode canvases', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    registerProjectFolders([
      { id: 'shared-series', dataFolder: '全剧素材' },
      { id: 'shared-episode-1', dataFolder: '全剧素材' },
      { id: 'shared-episode-2', dataFolder: '全剧素材' },
      { id: 'other-project', dataFolder: '其他项目' },
    ]);
    expect(await getProjectDataDir('shared-episode-1')).toBe(await getProjectDataDir('shared-episode-2'));
    expect(await getProjectDataDir('shared-episode-1')).toBe(await getProjectDataDir('shared-series'));
    for (const id of ['shared-series', 'shared-episode-1', 'shared-episode-2']) {
      expect(isSharedProjectDataDir(id)).toBe(true);
    }
    expect(isSharedProjectDataDir('other-project')).toBe(false);
  });

  it('keeps standalone project deletion independent of similarly named directories', () => {
    registerProjectFolders([
      { id: 'single-series', dataFolder: '单独项目' },
      { id: 'single-other', dataFolder: '单独项目-other' },
    ]);
    expect(isSharedProjectDataDir('single-series')).toBe(false);
    expect(isSharedProjectDataDir('unregistered-project')).toBe(false);
  });
});

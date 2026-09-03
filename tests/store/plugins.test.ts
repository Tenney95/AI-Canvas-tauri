import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { InstalledPlugin } from '../../src/types/plugin';

const nativeMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
  deletePluginFromDb: vi.fn(),
  getAllPlugins: vi.fn(),
  savePluginToDb: vi.fn(),
}));
const resourceMocks = vi.hoisted(() => ({
  clearPluginResources: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => nativeMocks);
vi.mock('../../src/services/indexedDbService', () => dbMocks);
vi.mock('../../src/services/plugins/pluginResourceService', () => resourceMocks);

import { createPluginSlice } from '../../src/store/store.plugins';

const pythonManifestText = JSON.stringify({
  apiVersion: 1,
  runtime: 'python',
  id: 'com.example.python-tool',
  name: 'Python 工具',
  version: '1.0.0',
  category: 'content',
  entry: 'main.py',
  permissions: ['node.read', 'node.write'],
  contributes: {
    nodeTools: [{
      id: 'uppercase',
      title: '转大写',
      placements: ['node-context-menu'],
      nodeTypes: ['ai-text'],
      inputFields: ['output'],
      output: { mode: 'update-current', fields: ['output'] },
    }],
  },
});

const pythonSource = 'define_plugin({"tools": {"uppercase": lambda input_value: {"data": {"output": "ok"}}}})';
const SOURCE_DIGEST_A = 'a'.repeat(64);
const SOURCE_DIGEST_B = 'b'.repeat(64);
const REVISION_DIGEST_A = 'c'.repeat(64);
const REVISION_DIGEST_B = 'd'.repeat(64);

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createInstalledPluginFixture(id: string): InstalledPlugin {
  return {
    id,
    sourceDigest: SOURCE_DIGEST_A,
    revisionDigest: REVISION_DIGEST_A,
    source: 'definePlugin({ tools: {} });',
    enabled: true,
    installedAt: 1,
    updatedAt: 1,
    manifest: {
      apiVersion: 1,
      runtime: 'javascript',
      id,
      name: id,
      version: '1.0.0',
      category: 'utility',
      entry: 'main.js',
      permissions: [],
      contributes: { nodeTools: [] },
    },
  };
}

function mockNativeSuccess(sourceDigest = SOURCE_DIGEST_A, revisionDigest = REVISION_DIGEST_A): void {
  nativeMocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'stage_plugin_revision') {
      const manifest = args.manifest as { id: string };
      return { pluginId: manifest.id, sourceDigest, revisionDigest };
    }
    return null;
  });
}

function createSlice(initialPlugins: InstalledPlugin[] = []) {
  let state = {
    installedPlugins: initialPlugins,
    showToast: vi.fn(),
  } as unknown as AppState;
  const set = (next: Partial<AppState> | ((current: AppState) => Partial<AppState>)) => {
    const patch = typeof next === 'function' ? next(state) : next;
    state = { ...state, ...patch };
  };
  const slice = createPluginSlice(set as never, () => state, {} as never);
  state = { ...state, ...slice, installedPlugins: initialPlugins };
  return { slice, getState: () => state };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNativeSuccess();
  dbMocks.savePluginToDb.mockResolvedValue(undefined);
  dbMocks.getAllPlugins.mockResolvedValue([]);
  dbMocks.deletePluginFromDb.mockResolvedValue(undefined);
});

describe('可信 Python 插件状态边界', () => {
  it('requires explicit confirmation before installing Python code', async () => {
    const { slice, getState } = createSlice();

    await expect(slice.installPluginBundle(pythonManifestText, pythonSource))
      .rejects.toThrow('必须确认');
    expect(dbMocks.savePluginToDb).not.toHaveBeenCalled();
    expect(nativeMocks.invoke).not.toHaveBeenCalled();

    await slice.installPluginBundle(pythonManifestText, pythonSource, {
      trustedPythonConfirmed: true,
      expectedSourceDigest: SOURCE_DIGEST_A,
    });
    expect(getState().installedPlugins[0].manifest.runtime).toBe('python');
    expect(getState().installedPlugins[0].sourceDigest).toBe(SOURCE_DIGEST_A);
    expect(dbMocks.savePluginToDb).toHaveBeenCalledTimes(1);
    expect(nativeMocks.invoke).toHaveBeenNthCalledWith(1, 'stage_plugin_revision', {
      manifest: expect.objectContaining({ id: 'com.example.python-tool' }),
      source: pythonSource,
      uiSource: undefined,
      resourcePayloads: [],
    });
    expect(nativeMocks.invoke).toHaveBeenNthCalledWith(2, 'activate_plugin_revision', {
      pluginId: 'com.example.python-tool',
      sourceDigest: SOURCE_DIGEST_A,
      revisionDigest: REVISION_DIGEST_A,
      enabled: true,
    });
  });

  it('rejects a staged revision whose digest differs from the user-confirmed source', async () => {
    mockNativeSuccess(SOURCE_DIGEST_B);
    const { slice, getState } = createSlice();

    await expect(slice.installPluginBundle(pythonManifestText, pythonSource, {
      trustedPythonConfirmed: true,
      expectedSourceDigest: SOURCE_DIGEST_A,
    })).rejects.toThrow('摘要与用户确认的版本不一致');

    expect(getState().installedPlugins).toHaveLength(0);
    expect(dbMocks.savePluginToDb).not.toHaveBeenCalled();
    expect(nativeMocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      'stage_plugin_revision',
      'remove_plugin_registration',
    ]);
    expect(dbMocks.deletePluginFromDb).toHaveBeenCalledWith('com.example.python-tool');
  });

  it('cleans a possibly staged first install when the stage IPC rejects', async () => {
    nativeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'stage_plugin_revision') throw new Error('暂存响应丢失');
      return null;
    });
    const { slice, getState } = createSlice();

    await expect(slice.installPluginBundle(
      pythonManifestText,
      pythonSource,
      { trustedPythonConfirmed: true },
    )).rejects.toThrow('暂存响应丢失');

    expect(nativeMocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      'stage_plugin_revision',
      'remove_plugin_registration',
    ]);
    expect(dbMocks.deletePluginFromDb).toHaveBeenCalledWith('com.example.python-tool');
    expect(getState().installedPlugins).toHaveLength(0);
  });

  it('cleans staged native state and restores the previous DB record when saving the update fails', async () => {
    const previous = {
      ...createInstalledPluginFixture('com.example.python-tool'),
      source: pythonSource,
      manifest: JSON.parse(pythonManifestText),
    } as InstalledPlugin;
    nativeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'stage_plugin_revision') {
        return { pluginId: previous.id, sourceDigest: SOURCE_DIGEST_B, revisionDigest: REVISION_DIGEST_B };
      }
      return null;
    });
    dbMocks.savePluginToDb.mockImplementation(async (plugin: InstalledPlugin) => {
      if (plugin.sourceDigest === SOURCE_DIGEST_B) throw new Error('IndexedDB save failed');
    });
    const { slice, getState } = createSlice([previous]);

    await expect(slice.installPluginBundle(
      pythonManifestText,
      `${pythonSource}\n# updated`,
      { trustedPythonConfirmed: true },
    )).rejects.toThrow('IndexedDB save failed');

    expect(nativeMocks.invoke.mock.calls).toEqual([
      ['stage_plugin_revision', expect.objectContaining({ source: `${pythonSource}\n# updated` })],
      ['activate_plugin_revision', {
        pluginId: previous.id,
        sourceDigest: SOURCE_DIGEST_A,
        revisionDigest: REVISION_DIGEST_A,
        enabled: true,
      }],
    ]);
    expect(dbMocks.savePluginToDb).toHaveBeenLastCalledWith(previous);
    expect(getState().installedPlugins).toEqual([previous]);
  });

  it('serializes concurrent installs of the same plugin through activation and Store commit', async () => {
    const firstStage = createDeferred<void>();
    const updatedSource = `${pythonSource}\n# updated`;
    const events: string[] = [];
    let activeStages = 0;
    let maxActiveStages = 0;
    nativeMocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'stage_plugin_revision') {
        const isFirst = args.source === pythonSource;
        activeStages += 1;
        maxActiveStages = Math.max(maxActiveStages, activeStages);
        events.push(`native.stage:${isFirst ? 'a' : 'b'}`);
        if (isFirst) await firstStage.promise;
        activeStages -= 1;
        const manifest = args.manifest as { id: string };
        return {
          pluginId: manifest.id,
          sourceDigest: isFirst ? SOURCE_DIGEST_A : SOURCE_DIGEST_B,
          revisionDigest: isFirst ? REVISION_DIGEST_A : REVISION_DIGEST_B,
        };
      }
      if (command === 'activate_plugin_revision') {
        events.push(`native.activate:${String(args.sourceDigest).slice(0, 1)}`);
      }
      return null;
    });
    dbMocks.savePluginToDb.mockImplementation(async (plugin: InstalledPlugin) => {
      events.push(`db.save:${plugin.sourceDigest?.slice(0, 1)}`);
    });
    const { slice, getState } = createSlice();

    const firstInstall = slice.installPluginBundle(pythonManifestText, pythonSource, {
      trustedPythonConfirmed: true,
      expectedSourceDigest: SOURCE_DIGEST_A,
    });
    const secondInstall = slice.installPluginBundle(pythonManifestText, updatedSource, {
      trustedPythonConfirmed: true,
      expectedSourceDigest: SOURCE_DIGEST_B,
    });

    await vi.waitFor(() => expect(events).toEqual(['native.stage:a']));
    expect(nativeMocks.invoke).toHaveBeenCalledTimes(1);
    firstStage.resolve(undefined);
    const [firstPlugin, secondPlugin] = await Promise.all([firstInstall, secondInstall]);

    expect(maxActiveStages).toBe(1);
    expect(events).toEqual([
      'native.stage:a',
      'db.save:a',
      'native.activate:a',
      'native.stage:b',
      'db.save:b',
      'native.activate:b',
    ]);
    expect(firstPlugin.sourceDigest).toBe(SOURCE_DIGEST_A);
    expect(secondPlugin).toMatchObject({ source: updatedSource, sourceDigest: SOURCE_DIGEST_B });
    expect(dbMocks.savePluginToDb).toHaveBeenLastCalledWith(secondPlugin);
    expect(nativeMocks.invoke).toHaveBeenLastCalledWith('activate_plugin_revision', {
      pluginId: secondPlugin.id,
      sourceDigest: SOURCE_DIGEST_B,
      revisionDigest: REVISION_DIGEST_B,
      enabled: true,
    });
    expect(getState().installedPlugins).toEqual([secondPlugin]);
  });

  it('does not block mutations for a different plugin id', async () => {
    const firstNativeCall = createDeferred<void>();
    const first = createInstalledPluginFixture('com.example.first');
    const second = createInstalledPluginFixture('com.example.second');
    nativeMocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'set_plugin_registration_enabled' && args.pluginId === first.id) {
        await firstNativeCall.promise;
      }
      return null;
    });
    const { slice, getState } = createSlice([first, second]);

    const firstToggle = slice.setPluginEnabled(first.id, false);
    await vi.waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledWith(
      'set_plugin_registration_enabled',
      { pluginId: first.id, enabled: false },
    ));
    try {
      await slice.setPluginEnabled(second.id, false);
      expect(getState().installedPlugins.find((plugin) => plugin.id === first.id)?.enabled).toBe(false);
      expect(getState().installedPlugins.find((plugin) => plugin.id === second.id)?.enabled).toBe(false);
    } finally {
      firstNativeCall.resolve(undefined);
    }
    await firstToggle;
  });

  it('revokes the previous Store lease and grants while update activation is pending', async () => {
    const { slice: installer } = createSlice();
    const previous = await installer.installPluginBundle(
      pythonManifestText,
      pythonSource,
      { trustedPythonConfirmed: true },
    );
    const activation = createDeferred<void>();
    const grantedPluginIds = new Set([previous.id]);
    vi.clearAllMocks();
    nativeMocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'stage_plugin_revision') {
        return { pluginId: previous.id, sourceDigest: SOURCE_DIGEST_B, revisionDigest: REVISION_DIGEST_B };
      }
      if (command === 'activate_plugin_revision' && args.sourceDigest === SOURCE_DIGEST_B) {
        return activation.promise;
      }
      return null;
    });
    dbMocks.savePluginToDb.mockResolvedValue(undefined);
    resourceMocks.clearPluginResources.mockImplementation((pluginId: string) => {
      grantedPluginIds.delete(pluginId);
    });
    const { slice, getState } = createSlice([previous]);

    const update = slice.installPluginBundle(
      pythonManifestText,
      `${pythonSource}\n# updated`,
      { trustedPythonConfirmed: true },
    );
    await vi.waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledWith(
      'activate_plugin_revision',
      {
        pluginId: previous.id,
        sourceDigest: SOURCE_DIGEST_B,
        revisionDigest: REVISION_DIGEST_B,
        enabled: true,
      },
    ));

    expect(getState().installedPlugins[0]).toMatchObject({
      id: previous.id,
      sourceDigest: SOURCE_DIGEST_A,
      enabled: false,
    });
    expect(grantedPluginIds.has(previous.id)).toBe(false);

    activation.resolve(undefined);
    const installed = await update;
    expect(getState().installedPlugins).toEqual([installed]);
  });

  it('rolls native activation and IndexedDB back to the previous plugin when activation fails', async () => {
    const { slice: installer } = createSlice();
    const previous = await installer.installPluginBundle(
      pythonManifestText,
      pythonSource,
      { trustedPythonConfirmed: true },
    );
    const events: string[] = [];
    vi.clearAllMocks();
    dbMocks.savePluginToDb.mockImplementation(async () => { events.push('db.save'); });
    nativeMocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      events.push(command);
      if (command === 'stage_plugin_revision') {
        const manifest = args.manifest as { id: string };
        return { pluginId: manifest.id, sourceDigest: SOURCE_DIGEST_B, revisionDigest: REVISION_DIGEST_B };
      }
      if (command === 'activate_plugin_revision' && args.sourceDigest === SOURCE_DIGEST_B) {
        throw new Error('原生激活失败');
      }
      return null;
    });
    const { slice, getState } = createSlice([previous]);

    await expect(slice.installPluginBundle(
      pythonManifestText,
      `${pythonSource}\n# updated`,
      { trustedPythonConfirmed: true },
    )).rejects.toThrow('原生激活失败');

    expect(events).toEqual([
      'stage_plugin_revision',
      'db.save',
      'activate_plugin_revision',
      'activate_plugin_revision',
      'db.save',
    ]);
    expect(nativeMocks.invoke).toHaveBeenNthCalledWith(3, 'activate_plugin_revision', {
      pluginId: previous.id,
      sourceDigest: previous.sourceDigest,
      revisionDigest: previous.revisionDigest,
      enabled: previous.enabled,
    });
    expect(dbMocks.savePluginToDb).toHaveBeenLastCalledWith(previous);
    expect(getState().installedPlugins).toEqual([previous]);
  });

  it('removes a first-time native registration when activation fails', async () => {
    const events: string[] = [];
    nativeMocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      events.push(command);
      if (command === 'stage_plugin_revision') {
        const manifest = args.manifest as { id: string };
        return { pluginId: manifest.id, sourceDigest: SOURCE_DIGEST_A, revisionDigest: REVISION_DIGEST_A };
      }
      if (command === 'activate_plugin_revision') throw new Error('原生激活失败');
      return null;
    });
    dbMocks.savePluginToDb.mockImplementation(async () => { events.push('db.save'); });
    dbMocks.deletePluginFromDb.mockImplementation(async () => { events.push('db.delete'); });
    const { slice, getState } = createSlice();

    await expect(slice.installPluginBundle(
      pythonManifestText,
      pythonSource,
      { trustedPythonConfirmed: true },
    )).rejects.toThrow('原生激活失败');

    expect(events).toEqual([
      'stage_plugin_revision',
      'db.save',
      'activate_plugin_revision',
      'remove_plugin_registration',
      'db.delete',
    ]);
    expect(getState().installedPlugins).toHaveLength(0);
  });

  it('reports both activation and native rollback failures without committing the new plugin', async () => {
    const { slice: installer } = createSlice();
    const previous = await installer.installPluginBundle(
      pythonManifestText,
      pythonSource,
      { trustedPythonConfirmed: true },
    );
    vi.clearAllMocks();
    nativeMocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'stage_plugin_revision') {
        const manifest = args.manifest as { id: string };
        return { pluginId: manifest.id, sourceDigest: SOURCE_DIGEST_B, revisionDigest: REVISION_DIGEST_B };
      }
      if (command === 'activate_plugin_revision' && args.sourceDigest === SOURCE_DIGEST_B) {
        throw new Error('原生激活失败');
      }
      if (command === 'activate_plugin_revision' && args.sourceDigest === SOURCE_DIGEST_A) {
        throw new Error('原生回滚失败');
      }
      return null;
    });
    dbMocks.savePluginToDb.mockResolvedValue(undefined);
    const { slice, getState } = createSlice([previous]);

    await expect(slice.installPluginBundle(
      pythonManifestText,
      `${pythonSource}\n# updated`,
      { trustedPythonConfirmed: true },
    )).rejects.toThrow('原生激活失败；恢复原生插件注册失败：原生回滚失败');

    expect(dbMocks.savePluginToDb).toHaveBeenLastCalledWith(previous);
    expect(getState().installedPlugins).toEqual([{ ...previous, enabled: false }]);
  });

  it('requires a fresh confirmation when re-enabling a Python plugin', async () => {
    const installed = createSlice().slice;
    const plugin = await installed.installPluginBundle(
      pythonManifestText,
      pythonSource,
      { trustedPythonConfirmed: true },
    );
    const disabledPlugin = { ...plugin, enabled: false };
    const { slice, getState } = createSlice([disabledPlugin]);
    const events: string[] = [];
    vi.clearAllMocks();
    nativeMocks.invoke.mockImplementation(async (command: string) => { events.push(command); return null; });
    dbMocks.savePluginToDb.mockImplementation(async () => { events.push('db.save'); });

    await expect(slice.setPluginEnabled(plugin.id, true)).rejects.toThrow('必须确认');
    expect(getState().installedPlugins[0].enabled).toBe(false);
    expect(events).toEqual([]);

    await slice.setPluginEnabled(plugin.id, true, { trustedPythonConfirmed: true });
    expect(getState().installedPlugins[0].enabled).toBe(true);
    expect(events).toEqual(['activate_plugin_revision', 'db.save']);
    expect(nativeMocks.invoke).toHaveBeenCalledWith('activate_plugin_revision', {
      pluginId: plugin.id,
      sourceDigest: plugin.sourceDigest,
      revisionDigest: plugin.revisionDigest,
      enabled: true,
    });
  });

  it('keeps a plugin disabled when its persisted source digest is missing', async () => {
    const plugin = {
      ...createInstalledPluginFixture('missing-digest'),
      enabled: false,
      sourceDigest: undefined,
    } as InstalledPlugin;
    const { slice, getState } = createSlice([plugin]);

    await expect(slice.setPluginEnabled(plugin.id, true)).rejects.toThrow('插件源码摘要缺失');

    expect(getState().installedPlugins).toEqual([plugin]);
    expect(nativeMocks.invoke).not.toHaveBeenCalled();
    expect(dbMocks.savePluginToDb).not.toHaveBeenCalled();
  });

  it('disables Store state and clears grants while IndexedDB persistence is still pending', async () => {
    const plugin = createInstalledPluginFixture('deferred-disable');
    const databaseWrite = createDeferred<void>();
    const grantedPluginIds = new Set([plugin.id]);
    nativeMocks.invoke.mockResolvedValue(null);
    dbMocks.savePluginToDb.mockReturnValue(databaseWrite.promise);
    resourceMocks.clearPluginResources.mockImplementation((pluginId: string) => {
      grantedPluginIds.delete(pluginId);
    });
    const { slice, getState } = createSlice([plugin]);

    const disable = slice.setPluginEnabled(plugin.id, false);
    await vi.waitFor(() => expect(dbMocks.savePluginToDb).toHaveBeenCalledWith(
      expect.objectContaining({ id: plugin.id, enabled: false }),
    ));

    expect(getState().installedPlugins[0].enabled).toBe(false);
    expect(resourceMocks.clearPluginResources).toHaveBeenCalledWith(plugin.id);
    expect(grantedPluginIds.has(plugin.id)).toBe(false);

    databaseWrite.resolve(undefined);
    await disable;
  });

  it('disables Store state and clears grants before the native disable responds', async () => {
    const plugin = createInstalledPluginFixture('deferred-native-disable');
    const nativeDisable = createDeferred<void>();
    const grantedPluginIds = new Set([plugin.id]);
    nativeMocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'set_plugin_registration_enabled' && args.enabled === false) {
        return nativeDisable.promise;
      }
      return null;
    });
    resourceMocks.clearPluginResources.mockImplementation((pluginId: string) => {
      grantedPluginIds.delete(pluginId);
    });
    const { slice, getState } = createSlice([plugin]);

    const disable = slice.setPluginEnabled(plugin.id, false);
    await vi.waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledWith(
      'set_plugin_registration_enabled',
      { pluginId: plugin.id, enabled: false },
    ));

    expect(getState().installedPlugins[0].enabled).toBe(false);
    expect(grantedPluginIds.has(plugin.id)).toBe(false);
    expect(dbMocks.savePluginToDb).not.toHaveBeenCalled();

    nativeDisable.resolve(undefined);
    await disable;
  });

  it('keeps Store state disabled when the native disable response is ambiguous', async () => {
    const plugin = createInstalledPluginFixture('failed-native-disable');
    nativeMocks.invoke.mockRejectedValue(new Error('原生停用响应丢失'));
    const { slice, getState } = createSlice([plugin]);

    await expect(slice.setPluginEnabled(plugin.id, false)).rejects.toThrow(
      '插件已在当前会话停用，但原生停用状态未确认',
    );

    expect(getState().installedPlugins[0].enabled).toBe(false);
    expect(resourceMocks.clearPluginResources).toHaveBeenCalledWith(plugin.id);
    expect(dbMocks.savePluginToDb).not.toHaveBeenCalled();
  });

  it('restores Store state after a failed disable persistence and successful native rollback', async () => {
    const plugin = createInstalledPluginFixture('disable-db-failure');
    nativeMocks.invoke.mockResolvedValue(null);
    dbMocks.savePluginToDb.mockRejectedValue(new Error('IndexedDB save failed'));
    const { slice, getState } = createSlice([plugin]);

    await expect(slice.setPluginEnabled(plugin.id, false)).rejects.toThrow('IndexedDB save failed');

    expect(nativeMocks.invoke.mock.calls).toEqual([
      ['set_plugin_registration_enabled', { pluginId: plugin.id, enabled: false }],
      ['set_plugin_registration_enabled', { pluginId: plugin.id, enabled: true }],
    ]);
    expect(getState().installedPlugins).toEqual([plugin]);
    expect(resourceMocks.clearPluginResources).toHaveBeenCalledTimes(1);
  });

  it('keeps Store state disabled when persistence and native rollback both fail', async () => {
    const plugin = createInstalledPluginFixture('disable-rollback-failure');
    nativeMocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'set_plugin_registration_enabled' && args.enabled === true) {
        throw new Error('原生回滚失败');
      }
      return null;
    });
    dbMocks.savePluginToDb.mockRejectedValue(new Error('IndexedDB save failed'));
    const { slice, getState } = createSlice([plugin]);

    await expect(slice.setPluginEnabled(plugin.id, false)).rejects.toThrow(
      'IndexedDB save failed；恢复原生插件启停状态失败：原生回滚失败',
    );

    expect(getState().installedPlugins[0].enabled).toBe(false);
    expect(resourceMocks.clearPluginResources).toHaveBeenCalledTimes(1);
  });

  it('fails closed for persisted plugins without a complete native revision identity', async () => {
    const incomplete = {
      id: 'incomplete',
      enabled: true,
      installedAt: 1,
      updatedAt: 1,
      source: 'definePlugin({ tools: {} });',
      manifest: {
        apiVersion: 1,
        id: 'incomplete',
        name: '不完整插件记录',
        version: '1.0.0',
        category: 'utility',
        entry: 'main.js',
        permissions: ['node.write'],
        contributes: { nodeTools: [] },
      },
    } as unknown as InstalledPlugin;
    dbMocks.getAllPlugins.mockResolvedValue([incomplete]);
    const { slice, getState } = createSlice();

    await slice.loadPlugins();

    expect(getState().installedPlugins[0].enabled).toBe(false);
    expect(nativeMocks.invoke).toHaveBeenCalledWith('set_plugin_registration_enabled', {
      pluginId: 'incomplete',
      enabled: false,
    });
    expect(dbMocks.savePluginToDb).toHaveBeenCalledWith(expect.objectContaining({
      id: 'incomplete',
      enabled: false,
    }));
  });

  it('ensures a digest-bearing registration without resubmitting plugin source', async () => {
    const installed = {
      id: 'registered',
      enabled: true,
      installedAt: 1,
      updatedAt: 1,
      source: 'definePlugin({ tools: {} });',
      sourceDigest: SOURCE_DIGEST_A,
      revisionDigest: REVISION_DIGEST_A,
      manifest: {
        apiVersion: 1,
        runtime: 'javascript',
        id: 'registered',
        name: '已注册',
        version: '1.0.0',
        category: 'utility',
        entry: 'main.js',
        permissions: ['node.write'],
        contributes: { nodeTools: [] },
      },
    } as InstalledPlugin;
    dbMocks.getAllPlugins.mockResolvedValue([installed]);
    const { slice, getState } = createSlice();

    await slice.loadPlugins();

    expect(getState().installedPlugins).toEqual([installed]);
    expect(nativeMocks.invoke).toHaveBeenCalledTimes(1);
    expect(nativeMocks.invoke).toHaveBeenCalledWith('ensure_plugin_registration', {
      pluginId: installed.id,
      sourceDigest: SOURCE_DIGEST_A,
      revisionDigest: REVISION_DIGEST_A,
      enabled: true,
    });
    expect(nativeMocks.invoke.mock.calls[0][1]).not.toHaveProperty('source');
    expect(dbMocks.savePluginToDb).not.toHaveBeenCalled();
  });

  it('fails closed on ensure errors and continues loading the remaining plugins', async () => {
    const first = {
      id: 'broken',
      sourceDigest: SOURCE_DIGEST_A,
      revisionDigest: REVISION_DIGEST_A,
      source: 'first',
      enabled: true,
      installedAt: 1,
      updatedAt: 1,
      manifest: {
        apiVersion: 1,
        runtime: 'javascript',
        id: 'broken',
        name: 'A broken',
        version: '1.0.0',
        category: 'utility',
        entry: 'main.js',
        permissions: [],
        contributes: { nodeTools: [] },
      },
    } as InstalledPlugin;
    const second = {
      ...first,
      id: 'healthy',
      sourceDigest: SOURCE_DIGEST_B,
      revisionDigest: REVISION_DIGEST_B,
      source: 'second',
      manifest: { ...first.manifest, id: 'healthy', name: 'B healthy' },
    } as InstalledPlugin;
    dbMocks.getAllPlugins.mockResolvedValue([first, second]);
    nativeMocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'ensure_plugin_registration' && args.pluginId === first.id) {
        throw new Error('注册丢失');
      }
      return null;
    });
    const { slice, getState } = createSlice();

    await slice.loadPlugins();

    expect(getState().installedPlugins.map(({ id, enabled }) => ({ id, enabled }))).toEqual([
      { id: 'broken', enabled: false },
      { id: 'healthy', enabled: true },
    ]);
    expect(dbMocks.savePluginToDb).toHaveBeenCalledWith(expect.objectContaining({
      id: 'broken',
      enabled: false,
    }));
    expect(nativeMocks.invoke.mock.calls.some(([command]) => command === 'stage_plugin_revision')).toBe(false);
    expect(nativeMocks.invoke).toHaveBeenCalledWith('ensure_plugin_registration', {
      pluginId: second.id,
      sourceDigest: SOURCE_DIGEST_B,
      revisionDigest: REVISION_DIGEST_B,
      enabled: true,
    });
  });

  it('activates the persisted digest when re-enabling after an ensure mismatch', async () => {
    const persisted = {
      ...createInstalledPluginFixture('com.example.python-tool'),
      source: pythonSource,
      sourceDigest: SOURCE_DIGEST_B,
      revisionDigest: REVISION_DIGEST_B,
      manifest: JSON.parse(pythonManifestText),
    } as InstalledPlugin;
    dbMocks.getAllPlugins.mockResolvedValue([persisted]);
    nativeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'ensure_plugin_registration') throw new Error('native active A, staged B');
      return null;
    });
    const { slice, getState } = createSlice();

    await slice.loadPlugins();
    expect(getState().installedPlugins[0]).toMatchObject({
      id: persisted.id,
      sourceDigest: SOURCE_DIGEST_B,
      enabled: false,
    });

    vi.clearAllMocks();
    dbMocks.savePluginToDb.mockResolvedValue(undefined);
    await slice.setPluginEnabled(persisted.id, true, { trustedPythonConfirmed: true });

    expect(nativeMocks.invoke).toHaveBeenCalledWith('activate_plugin_revision', {
      pluginId: persisted.id,
      sourceDigest: SOURCE_DIGEST_B,
      revisionDigest: REVISION_DIGEST_B,
      enabled: true,
    });
    expect(nativeMocks.invoke).not.toHaveBeenCalledWith(
      'set_plugin_registration_enabled',
      expect.objectContaining({ enabled: true }),
    );
    expect(getState().installedPlugins[0]).toMatchObject({
      sourceDigest: SOURCE_DIGEST_B,
      enabled: true,
    });
  });

  it('removes the native registration and clears runtime state before deleting IndexedDB', async () => {
    const events: string[] = [];
    nativeMocks.invoke.mockImplementation(async (command: string) => { events.push(command); return null; });
    dbMocks.deletePluginFromDb.mockImplementation(async () => { events.push('db.delete'); });
    resourceMocks.clearPluginResources.mockImplementation(() => { events.push('grants.clear'); });
    const { slice, getState } = createSlice([{
      id: 'remove-me',
      sourceDigest: SOURCE_DIGEST_A,
      revisionDigest: REVISION_DIGEST_A,
      source: 'source',
      enabled: true,
      installedAt: 1,
      updatedAt: 1,
      manifest: {
        apiVersion: 1,
        runtime: 'javascript',
        id: 'remove-me',
        name: '删除测试',
        version: '1.0.0',
        category: 'utility',
        entry: 'main.js',
        permissions: [],
        contributes: { nodeTools: [] },
      },
    } as InstalledPlugin]);

    await slice.deletePlugin('remove-me');

    expect(events).toEqual(['grants.clear', 'remove_plugin_registration', 'db.delete']);
    expect(getState().installedPlugins).toHaveLength(0);
  });

  it('removes Store state and clears grants before the native remove responds', async () => {
    const plugin = createInstalledPluginFixture('deferred-native-remove');
    const nativeRemoval = createDeferred<void>();
    const grantedPluginIds = new Set([plugin.id]);
    nativeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'remove_plugin_registration') return nativeRemoval.promise;
      return null;
    });
    resourceMocks.clearPluginResources.mockImplementation((pluginId: string) => {
      grantedPluginIds.delete(pluginId);
    });
    const { slice, getState } = createSlice([plugin]);

    const deletion = slice.deletePlugin(plugin.id);
    await vi.waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledWith(
      'remove_plugin_registration',
      { pluginId: plugin.id },
    ));

    expect(getState().installedPlugins).toHaveLength(0);
    expect(grantedPluginIds.has(plugin.id)).toBe(false);
    expect(dbMocks.deletePluginFromDb).not.toHaveBeenCalled();

    nativeRemoval.resolve(undefined);
    await deletion;
  });

  it('keeps the plugin removed from Store when native removal fails ambiguously', async () => {
    const plugin = createInstalledPluginFixture('failed-native-remove');
    nativeMocks.invoke.mockRejectedValue(new Error('原生删除响应丢失'));
    const { slice, getState } = createSlice([plugin]);

    await expect(slice.deletePlugin(plugin.id)).rejects.toThrow(
      '插件已从当前会话移除，但原生注册删除状态未确认',
    );

    expect(getState().installedPlugins).toHaveLength(0);
    expect(resourceMocks.clearPluginResources).toHaveBeenCalledWith(plugin.id);
    expect(dbMocks.deletePluginFromDb).not.toHaveBeenCalled();
  });

  it('clears grants and removes memory state while IndexedDB deletion is still pending', async () => {
    const plugin = createInstalledPluginFixture('remove-with-db-failure');
    const grantedPluginIds = new Set([plugin.id]);
    const databaseDeletion = createDeferred<void>();
    nativeMocks.invoke.mockResolvedValue(null);
    dbMocks.deletePluginFromDb.mockReturnValue(databaseDeletion.promise);
    resourceMocks.clearPluginResources.mockImplementation((pluginId: string) => {
      grantedPluginIds.delete(pluginId);
    });
    const { slice, getState } = createSlice([plugin]);

    const deletion = slice.deletePlugin(plugin.id);
    await vi.waitFor(() => expect(dbMocks.deletePluginFromDb).toHaveBeenCalledWith(plugin.id));
    expect(resourceMocks.clearPluginResources).toHaveBeenCalledWith(plugin.id);
    expect(grantedPluginIds.has(plugin.id)).toBe(false);
    expect(getState().installedPlugins).toHaveLength(0);

    databaseDeletion.reject(new Error('IndexedDB delete failed'));
    await expect(deletion).rejects.toThrow(
      '插件已从原生运行时和当前会话移除，但删除持久化记录失败',
    );
    expect(nativeMocks.invoke).toHaveBeenCalledWith('remove_plugin_registration', { pluginId: plugin.id });
  });

  it('queues toggle and delete mutations for the same plugin id', async () => {
    const plugin = createInstalledPluginFixture('toggle-then-delete');
    const toggleNativeCall = createDeferred<void>();
    const events: string[] = [];
    nativeMocks.invoke.mockImplementation(async (command: string) => {
      events.push(command);
      if (command === 'set_plugin_registration_enabled') await toggleNativeCall.promise;
      return null;
    });
    dbMocks.savePluginToDb.mockImplementation(async () => { events.push('db.save'); });
    dbMocks.deletePluginFromDb.mockImplementation(async () => { events.push('db.delete'); });
    resourceMocks.clearPluginResources.mockImplementation(() => { events.push('grants.clear'); });
    const { slice, getState } = createSlice([plugin]);

    const toggle = slice.setPluginEnabled(plugin.id, false);
    await vi.waitFor(() => expect(events).toEqual([
      'grants.clear',
      'set_plugin_registration_enabled',
    ]));
    const deletion = slice.deletePlugin(plugin.id);
    await Promise.resolve();
    expect(events).toEqual(['grants.clear', 'set_plugin_registration_enabled']);

    toggleNativeCall.resolve(undefined);
    await Promise.all([toggle, deletion]);

    expect(events).toEqual([
      'grants.clear',
      'set_plugin_registration_enabled',
      'db.save',
      'grants.clear',
      'remove_plugin_registration',
      'db.delete',
    ]);
    expect(getState().installedPlugins).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { InstalledPlugin } from '../../src/types/plugin';

const dbMocks = vi.hoisted(() => ({
  deletePluginFromDb: vi.fn(),
  getAllPlugins: vi.fn(),
  savePluginToDb: vi.fn(),
}));

vi.mock('../../src/services/indexedDbService', () => dbMocks);
vi.mock('../../src/services/plugins/pluginFileGrantService', () => ({
  clearPluginFileGrants: vi.fn(),
}));

import { createPluginSlice } from '../../src/store/store.plugins';

const pythonManifestText = JSON.stringify({
  apiVersion: 3,
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
  dbMocks.savePluginToDb.mockResolvedValue(undefined);
  dbMocks.getAllPlugins.mockResolvedValue([]);
});

describe('可信 Python 插件状态边界', () => {
  it('requires explicit confirmation before installing Python code', async () => {
    const { slice, getState } = createSlice();

    await expect(slice.installPluginBundle(pythonManifestText, pythonSource))
      .rejects.toThrow('必须确认');
    expect(dbMocks.savePluginToDb).not.toHaveBeenCalled();

    await slice.installPluginBundle(pythonManifestText, pythonSource, { trustedPythonConfirmed: true });
    expect(getState().installedPlugins[0].manifest.runtime).toBe('python');
    expect(dbMocks.savePluginToDb).toHaveBeenCalledTimes(1);
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

    await expect(slice.setPluginEnabled(plugin.id, true)).rejects.toThrow('必须确认');
    expect(getState().installedPlugins[0].enabled).toBe(false);

    await slice.setPluginEnabled(plugin.id, true, { trustedPythonConfirmed: true });
    expect(getState().installedPlugins[0].enabled).toBe(true);
  });

  it('normalizes persisted pre-v3 JavaScript plugins without changing the database schema', async () => {
    const legacy = {
      id: 'legacy',
      enabled: true,
      installedAt: 1,
      updatedAt: 1,
      source: 'definePlugin({ tools: {} });',
      manifest: {
        apiVersion: 1,
        id: 'legacy',
        name: '旧插件',
        version: '1.0.0',
        category: 'utility',
        entry: 'main.js',
        permissions: ['node.write'],
        contributes: { nodeTools: [] },
      },
    } as unknown as InstalledPlugin;
    dbMocks.getAllPlugins.mockResolvedValue([legacy]);
    const { slice, getState } = createSlice();

    await slice.loadPlugins();

    expect(getState().installedPlugins[0].manifest.runtime).toBe('javascript');
  });
});

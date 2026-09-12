import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createHash } from 'node:crypto';
import type { AppState } from '../../src/store/useAppStore';

/**
 * 端到端钉住报告里的那条路径：配置写进 IndexedDB 时不得含明文 API Key。
 * 这里用 fake-indexeddb 跑真实的 saveConfigToDb / loadConfigFromDb。
 */
const secretStore = vi.hoisted(() => ({
  isTauri: true,
  entries: new Map<string, string>(),
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: secretStore.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: vi.fn(async () => false) }));
vi.mock('../../src/services/fs/core', () => ({
  isTauriEnv: () => secretStore.isTauri,
  getProjectDataDir: vi.fn(async () => null),
  joinPath: (...parts: string[]) => parts.join('/'),
  listDirectoryFiles: vi.fn(async () => []),
  getAssetUrlFromPath: vi.fn(async (path: string) => `asset://${path}`),
}));
vi.mock('../../src/services/fs/assetIndex', () => ({
  identifyAsset: vi.fn(async () => null),
  resolveIndexedAssetPath: vi.fn(async () => null),
}));
vi.mock('../../src/services/fileService', async () => ({
  ...await vi.importActual<typeof import('../../src/services/storageService')>('../../src/services/storageService'),
  setBaseDataDir: vi.fn(), syncAuthorizedDirectories: async () => {},
}));

import {
  loadConfig,
  loadConfigWithSecrets,
  loadConfigWithoutSecrets,
  saveConfig,
} from '../../src/services/storageService';
import { loadConfigFromDb, saveConfigToDb } from '../../src/services/indexedDbService';
import { openDB, STORE_CONFIG } from '../../src/services/indexedDb/schema';
import { enqueueConfigPersistence } from '../../src/services/configPersistenceQueue';
import { deleteProviderSecret } from '../../src/services/providerSecretService';
import { ConfigConflictError, configWithoutSecrets, createConfigPatch } from '../../src/services/configPatch';
import { createConfigSlice } from '../../src/store/store.config';

function configStore() {
  return createStore<AppState>()((set, get, api) => ({
    ...createConfigSlice(set, get, api), showToast: vi.fn(), nodes: [], projects: [], currentProjectId: null,
  } as unknown as AppState));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_CONFIG, 'readwrite');
    transaction.objectStore(STORE_CONFIG).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  secretStore.isTauri = true;
  secretStore.entries.clear();
  secretStore.invoke.mockReset();
  secretStore.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    const key = args?.key as string;
    const current = secretStore.entries.get(key) ?? null;
    const fingerprint = current === null ? null : createHash('sha256').update(current).digest('hex');
    const expected = args.expected as { value?: string | null; fingerprint?: string } | undefined;
    if (command === 'secret_set') {
      if (current !== args.value && expected && expected.value !== current) throw { code: 'conflict' };
      secretStore.entries.set(key, args.value as string); return undefined;
    }
    if (command === 'secret_get') return args.fingerprintOnly ? fingerprint : current;
    if (command === 'secret_delete') {
      if (current !== null && expected?.fingerprint && expected.fingerprint !== fingerprint) throw { code: 'conflict' };
      secretStore.entries.delete(key); return undefined;
    }
    return undefined;
  });
});

describe('config persistence keeps secrets out of IndexedDB', () => {
  it('does not delete a provider key until its config deletion commits, including an aborted config write', async () => {
    await saveConfigToDb({ providers: { a: { name: 'A', apiKeyRef: 'secret:provider/a' } } });
    secretStore.entries.set('provider/a', 'delete-fixture');
    const store = configStore(); await store.getState().loadConfig();
    await store.getState().removeProviderConfig('a');
    expect(secretStore.entries.has('provider/a')).toBe(true);
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort()); return request;
    });
    await expect(store.getState().saveConfig()).rejects.toThrow();
    expect(secretStore.entries.has('provider/a')).toBe(true);
    expect(await loadConfigFromDb()).toHaveProperty('providers.a');
    await store.getState().saveConfig();
    expect(secretStore.entries.has('provider/a')).toBe(false);
    expect(await loadConfigFromDb()).not.toHaveProperty('providers.a');
  });

  it('records only a fingerprint after cleanup failure and finishes cleanup on a fresh load', async () => {
    await saveConfigToDb({ providers: { a: { name: 'A', apiKeyRef: 'secret:provider/a' } } });
    secretStore.entries.set('provider/a', 'delete-fixture');
    const store = configStore(); await store.getState().loadConfig();
    await store.getState().removeProviderConfig('a');
    const invoke = secretStore.invoke.getMockImplementation()!;
    secretStore.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'secret_delete') throw { code: 'permission_denied' };
      return invoke(cmd, args);
    });
    await expect(store.getState().saveConfig()).rejects.toThrow('旧渠道凭据清理失败');
    expect(store.getState().configPersistedBaseline).not.toHaveProperty('providers.a');
    expect(store.getState().configDirty).toBe(false);
    const saved = await loadConfigFromDb();
    expect(saved).not.toHaveProperty('providers.a');
    expect(saved).toHaveProperty('_pendingSecretCleanup.a');
    expect(JSON.stringify(saved)).not.toContain('delete-fixture');
    expect(secretStore.entries.has('provider/a')).toBe(true);
    const duringFailure = configStore(); await duringFailure.getState().loadConfig();
    expect(duringFailure.getState().configHydrated).toBe(true);
    expect(duringFailure.getState().configSaveError).toContain('旧渠道凭据清理失败');
    secretStore.invoke.mockImplementation(invoke);
    const fresh = configStore(); await fresh.getState().loadConfig();
    expect(secretStore.entries.has('provider/a')).toBe(false);
    expect(await loadConfigFromDb()).toHaveProperty('_pendingSecretCleanup', {});
  });

  it('does not delete a changed native key while finishing an older cleanup plan', async () => {
    const hash = createHash('sha256').update('old-fixture').digest('hex');
    await saveConfigToDb({ providers: {}, _pendingSecretCleanup: { a: hash } });
    secretStore.entries.set('provider/a', 'new-fixture');
    await loadConfigWithSecrets({ allowSecretReadFailure: true });
    expect(secretStore.entries.get('provider/a')).toBe('new-fixture');
    expect(await loadConfigFromDb()).toHaveProperty('_pendingSecretCleanup', {});
  });

  it('can recreate a connection after its deletion committed but secret cleanup failed', async () => {
    await saveConfigToDb({ providers: { a: { name: 'A', apiKeyRef: 'secret:provider/a' } } });
    secretStore.entries.set('provider/a', 'old-fixture');
    const store = configStore(); await store.getState().loadConfig();
    await store.getState().removeProviderConfig('a');
    const invoke = secretStore.invoke.getMockImplementation()!;
    secretStore.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'secret_delete') throw { code: 'permission_denied' };
      return invoke(cmd, args);
    });
    await expect(store.getState().saveConfig()).rejects.toThrow('旧渠道凭据清理失败');
    store.getState().saveProviderConfig('a', { name: 'A', apiKey: 'replacement-fixture' });
    secretStore.invoke.mockImplementation(invoke);
    await store.getState().saveConfig();
    expect(await loadConfigFromDb()).toHaveProperty('providers.a.apiKeyRef', 'secret:provider/a');
    expect(secretStore.entries.get('provider/a')).toBe('replacement-fixture');
    expect(store.getState().configDirty).toBe(false);
  });

  it('migrates legacy model credentials through the real Store and persists the ordinary baseline', async () => {
    await saveConfigToDb({ providers: {}, generalModels: [{ id: 'old', name: '旧模型', modelId: 'model', category: 'text', apiKey: 'legacy-fixture-key', openaiUrl: 'https://example.test/v1' }] });
    const store = configStore();
    await store.getState().loadConfig();
    expect(store.getState().config.providers['custom-1'].apiKey).toBe('legacy-fixture-key');
    expect(secretStore.entries.get('provider/custom-1')).toBe('legacy-fixture-key');
    expect(JSON.stringify(await loadConfigFromDb())).not.toContain('legacy-fixture-key');
    expect(JSON.stringify(store.getState().configEditBaseline)).not.toContain('legacy-fixture-key');
    expect(JSON.stringify(store.getState().configPersistedBaseline)).not.toContain('legacy-fixture-key');
    secretStore.invoke.mockClear();
    store.getState().updateConfig({ theme: 'light' });
    await store.getState().saveConfig();
    expect(secretStore.invoke).not.toHaveBeenCalled();
    expect(await loadConfigFromDb()).toMatchObject({ theme: 'light', generalModels: [{ providerConfigId: 'custom-1' }] });
  });

  it('preserves the original legacy record and blocks saves when credential migration fails', async () => {
    const legacy = { providers: {}, generalModels: [{ id: 'old', modelId: 'model', apiKey: 'legacy-fixture-key' }] };
    await saveConfigToDb(legacy);
    secretStore.invoke.mockRejectedValue(new Error('fixture-private'));
    const store = configStore();
    await expect(store.getState().loadConfig()).rejects.toThrow('设置读取失败');
    expect(store.getState().configHydrated).toBe(false);
    await expect(store.getState().saveConfig()).rejects.toThrow('配置尚未完成加载');
    expect(await loadConfigFromDb()).toEqual(legacy);
    expect(JSON.stringify(await loadConfigWithoutSecrets())).not.toContain('legacy-fixture-key');
  });

  it('persists ordinary migrations even if an unrelated credential is unreadable', async () => {
    await saveConfigToDb({ graphicsCompatibilityMode: true, providers: { grsai: { name: 'GRSAI', baseUrl: 'https://api.grsai.com/', apiKeyRef: 'secret:provider/grsai' } } });
    secretStore.invoke.mockRejectedValue(new Error('fixture-private'));
    const store = configStore();
    await store.getState().loadConfig();
    expect(store.getState().configSecretReadErrors).toEqual(['grsai']);
    const saved = await loadConfigFromDb();
    expect(saved).toMatchObject({ performanceMode: true, providers: { grsai: { baseUrl: 'https://grsai.dakka.com.cn/v1', apiKeyRef: 'secret:provider/grsai' } } });
    expect(saved).not.toHaveProperty('graphicsCompatibilityMode');
  });

  it('preserves credential references and revisions when an editor reconstructs the provider object', async () => {
    await saveConfigToDb({ providers: { a: { name: 'A', apiKeyRef: 'secret:provider/a', apiKeyRevision: 'current-version' } } });
    secretStore.entries.set('provider/a', 'fixture-key');
    const store = configStore(); await store.getState().loadConfig();
    secretStore.invoke.mockClear();
    store.getState().saveProviderConfig('a', { name: '改名', apiKey: 'fixture-key' });
    await store.getState().saveConfig();
    expect(secretStore.invoke).not.toHaveBeenCalled();
    expect(await loadConfigFromDb()).toMatchObject({ providers: { a: { name: '改名', apiKeyRef: 'secret:provider/a', apiKeyRevision: 'current-version' } } });
  });

  it('merges independent Store changes and prevents stale cached credentials from returning after reload', async () => {
    const original = { theme: 'dark', providers: { a: { name: 'A', apiKeyRef: 'secret:provider/a', apiKeyRevision: 'old' } } };
    await saveConfigToDb(original); secretStore.entries.set('provider/a', 'original-fixture');
    const first = configStore(); const second = configStore();
    await first.getState().loadConfig(); await second.getState().loadConfig();
    first.getState().setProviderKey('a', 'new-fixture'); await first.getState().saveConfig();
    second.getState().updateConfig({ theme: 'light' }); await second.getState().saveConfig();
    expect(second.getState().config.providers.a.apiKey).toBe('');
    expect(second.getState().configSecretReadErrors).toEqual(['a']);
    expect(await loadConfigFromDb()).toMatchObject({ theme: 'light' });
    // 另一实例持有旧 Key，但同一引用已换版本；失败的重读不能把旧 Key 继续当成当前值。
    const third = configStore(); await third.getState().loadConfig();
    first.getState().setProviderKey('a', 'newer-fixture'); await first.getState().saveConfig();
    secretStore.invoke.mockRejectedValue(new Error('fixture-private'));
    await third.getState().loadConfig();
    expect(third.getState().config.providers.a.apiKey).toBe('');
  });

  it('deletes a provider after only its credential revision changed elsewhere', async () => {
    const original = {
      providers: {
        a: {
          name: 'A',
          baseUrl: 'https://example.test/v1',
          apiKeyRef: 'secret:provider/a',
          apiKeyRevision: 'old-revision',
        },
      },
    };
    await saveConfigToDb(original);
    secretStore.entries.set('provider/a', 'old-fixture');
    const deletingStore = configStore();
    const editingStore = configStore();
    await deletingStore.getState().loadConfig();
    await editingStore.getState().loadConfig();

    editingStore.getState().setProviderKey('a', 'new-fixture');
    await editingStore.getState().saveConfig();
    await deletingStore.getState().removeProviderConfig('a');
    await deletingStore.getState().saveConfig();

    expect(await loadConfigFromDb()).not.toHaveProperty('providers.a');
    expect(secretStore.entries.has('provider/a')).toBe(false);
  });

  it('still rejects provider deletion after its ordinary fields changed elsewhere', async () => {
    const original = {
      providers: {
        a: {
          name: 'A',
          baseUrl: 'https://example.test/v1',
          apiKeyRef: 'secret:provider/a',
          apiKeyRevision: 'old-revision',
        },
      },
    };
    await saveConfigToDb(original);
    secretStore.entries.set('provider/a', 'fixture-key');
    const deletingStore = configStore();
    const editingStore = configStore();
    await deletingStore.getState().loadConfig();
    await editingStore.getState().loadConfig();

    editingStore.getState().saveProviderConfig('a', {
      ...editingStore.getState().config.providers.a,
      name: 'Renamed',
    });
    await editingStore.getState().saveConfig();
    await deletingStore.getState().removeProviderConfig('a');

    await expect(deletingStore.getState().saveConfig()).rejects.toBeInstanceOf(ConfigConflictError);
    expect(await loadConfigFromDb()).toHaveProperty('providers.a.name', 'Renamed');
    expect(secretStore.entries.get('provider/a')).toBe('fixture-key');
  });

  it('saves an unrelated setting with zero credential IPC even when secret reads fail', async () => {
    const baseline = { theme: 'dark', providers: { a: { name: 'A', apiKeyRef: 'secret:provider/a' } } };
    await saveConfigToDb(baseline);
    secretStore.invoke.mockRejectedValue(new Error('unavailable'));
    await saveConfig({ ...baseline, theme: 'light', providers: { a: { ...baseline.providers.a, apiKey: 'runtime-key' } } }, {
      baseline, changes: createConfigPatch(baseline, { ...baseline, theme: 'light' }),
    });
    expect(secretStore.invoke).not.toHaveBeenCalled();
    expect(await loadConfigFromDb()).toEqual({ ...baseline, theme: 'light' });
  });

  it('keeps ordinary settings readable when individual credentials cannot be read', async () => {
    const baseline = { theme: 'light', providers: { a: { name: 'A', apiKeyRef: 'secret:provider/a' } } };
    await saveConfigToDb(baseline);
    secretStore.invoke.mockRejectedValue(new Error('fixture-private'));
    expect(await loadConfigWithSecrets({ allowSecretReadFailure: true })).toMatchObject({ config: baseline, unreadSecrets: ['a'], missingSecrets: [] });
    expect(await loadConfigFromDb()).toEqual(baseline);
  });

  it('merges two stale snapshots for different fields and rejects a same-field conflict', async () => {
    const baseline = { theme: 'dark', language: 'zh-CN', providers: {} };
    await saveConfigToDb(baseline);
    const first = { ...baseline, theme: 'light' };
    const second = { ...baseline, language: 'en-US' };
    await Promise.all([
      saveConfig(first, { baseline, changes: createConfigPatch(baseline, first) }),
      saveConfig(second, { baseline, changes: createConfigPatch(baseline, second) }),
    ]);
    expect(await loadConfigFromDb()).toEqual({ ...baseline, theme: 'light', language: 'en-US' });
    const conflict = { ...baseline, theme: 'system' };
    await expect(saveConfig(conflict, { baseline, changes: createConfigPatch(baseline, conflict) })).rejects.toMatchObject({ name: 'ConfigConflictError' });
  });

  it('writes only explicitly changed credentials and checks their revision before native writes', async () => {
    const baseline = { providers: { a: { name: 'A', apiKeyRef: 'secret:provider/a', apiKeyRevision: 'old' }, b: { name: 'B', apiKeyRef: 'secret:provider/b' } } };
    await saveConfigToDb(baseline);
    const snapshot = { providers: { a: { ...baseline.providers.a, apiKey: 'replacement' }, b: { ...baseline.providers.b, apiKey: 'unchanged' } } };
    const options = { baseline, changes: [], secretChanges: { a: 'revision-one' } };
    await saveConfig(snapshot, options);
    expect(secretStore.invoke.mock.calls.every(([, args]) => (args as { key: string }).key === 'provider/a')).toBe(true);
    const persisted = await loadConfigFromDb();
    expect(JSON.stringify(persisted)).not.toContain('replacement');
    expect(persisted).toMatchObject({ providers: { a: { apiKeyRevision: 'revision-one' } } });
    secretStore.invoke.mockClear();
    await expect(saveConfig(snapshot, { ...options, secretChanges: { a: 'revision-two' } })).rejects.toMatchObject({ name: 'ConfigConflictError' });
    expect(secretStore.invoke).not.toHaveBeenCalled();
  });

  it('recovers a missing reference without writing a runtime plaintext key into ordinary config', async () => {
    await saveConfigToDb({ providers: { a: { name: 'A' } } });
    secretStore.entries.set('provider/a', 'fixture-native-key');
    const loaded = await loadConfigWithSecrets({ allowSecretReadFailure: true });
    expect(loaded.config).toMatchObject({ providers: { a: { apiKey: 'fixture-native-key', apiKeyRef: 'secret:provider/a' } } });
    expect(configWithoutSecrets(loaded.config)).toEqual(await loadConfigFromDb());
    expect(JSON.stringify(loaded.persistedConfig)).not.toContain('fixture-native-key');
  });

  it('returns null only when the config record is absent', async () => {
    await expect(loadConfigWithSecrets()).resolves.toEqual({ config: null, missingSecrets: [] });
    await expect(loadConfig()).resolves.toBeNull();
    await expect(loadConfigWithoutSecrets()).resolves.toBeNull();
    expect(secretStore.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['loadConfigWithSecrets', loadConfigWithSecrets],
    ['loadConfig', loadConfig],
    ['loadConfigWithoutSecrets', loadConfigWithoutSecrets],
  ])('%s rejects read failures without exposing the original error, and can recover', async (_, load) => {
    const saved = { theme: 'light', providers: {} };
    await saveConfigToDb(saved);
    const db = await openDB();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
      throw new DOMException('G:/private-data/credentials.json sk-sensitive-value', 'UnknownError');
    });

    await expect(load()).rejects.toMatchObject({
      name: 'Error',
      message: '读取应用配置失败，请重试或检查存储状态',
    });
    const output = JSON.stringify(errorLog.mock.calls);
    expect(output).not.toContain('private-data');
    expect(output).not.toContain('sk-sensitive-value');
    await expect(loadConfigFromDb()).resolves.toEqual(saved);
    await expect(loadConfigWithSecrets()).resolves.toEqual({ config: saved, missingSecrets: [] });
  });

  it('preserves VersionError classification without exposing database error details', async () => {
    const db = await openDB();
    vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
      throw new DOMException('G:/private-data/ai-canvas-db version details', 'VersionError');
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(loadConfigWithSecrets()).rejects.toMatchObject({
      name: 'VersionError',
      message: '读取应用配置失败，请重试或检查存储状态',
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private-data');
  });

  it('stores only a keychain reference, and rehydrates the key on load', async () => {
    await saveConfig({
      theme: 'dark',
      providers: { apimart: { name: 'Apimart', apiKey: 'sk-should-not-persist' } },
    });

    const stored = await loadConfigFromDb();
    expect(JSON.stringify(stored)).not.toContain('sk-should-not-persist');
    expect(secretStore.entries.get('provider/apimart')).toBe('sk-should-not-persist');

    const { config, missingSecrets } = await loadConfigWithSecrets();
    expect(missingSecrets).toEqual([]);
    const providers = (config as { providers: Record<string, { apiKey: string }> }).providers;
    expect(providers.apimart.apiKey).toBe('sk-should-not-persist');
  });

  it('scrubs a legacy plaintext record from the database on first load', async () => {
    // 模拟本次修复之前落盘的记录
    await saveConfigToDb({
      theme: 'dark',
      providers: { volcengine: { name: '火山', apiKey: 'legacy-plaintext' } },
    });
    expect(JSON.stringify(await loadConfigFromDb())).toContain('legacy-plaintext');

    const { config } = await loadConfigWithSecrets();

    // 明文进凭据存储，数据库记录被立刻覆盖
    expect(secretStore.entries.get('provider/volcengine')).toBe('legacy-plaintext');
    expect(JSON.stringify(await loadConfigFromDb())).not.toContain('legacy-plaintext');
    const providers = (config as { providers: Record<string, { apiKey: string }> }).providers;
    expect(providers.volcengine.apiKey).toBe('legacy-plaintext');
  });

  it.each(['secret_get', 'secret_set'])(
    'rejects a new desktop credential when %s fails instead of saving a keyless connection',
    async (failedCommand) => {
      const original = { theme: 'dark', providers: {} };
      await saveConfigToDb(original);
      const invokeSecret = secretStore.invoke.getMockImplementation()!;
      secretStore.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
        if (command === failedCommand) throw new Error('native credential unavailable');
        return invokeSecret(command, args);
      });

      const next = { theme: 'light', providers: { apimart: { apiKey: 'test-new-desktop-key' } } };
      await expect(saveConfig(next)).rejects.toThrow('保存应用配置失败');
      await expect(loadConfigFromDb()).resolves.toEqual(original);

      secretStore.invoke.mockImplementation(invokeSecret);
      await expect(saveConfig(next)).resolves.toEqual([]);
      await expect(loadConfigWithSecrets()).resolves.toMatchObject({ config: next, missingSecrets: [] });
    },
  );

  it.each(['throws', 'invalid-result'])(
    'rejects an unreadable existing credential (%s) without replacing it with an empty key',
    async (failure) => {
      await saveConfig({ providers: { apimart: { apiKey: 'test-saved-key' } } });
      const original = await loadConfigFromDb();
      const invokeSecret = secretStore.invoke.getMockImplementation()!;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      secretStore.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
        if (command === 'secret_get') {
          if (failure === 'throws') throw new Error('G:/fixture-private-path/test-private-key');
          return undefined;
        }
        return invokeSecret(command, args);
      });

      await expect(loadConfigWithSecrets()).rejects.toThrow('读取应用配置失败');
      await expect(loadConfigFromDb()).resolves.toEqual(original);
      expect(JSON.stringify([...warn.mock.calls, ...errorLog.mock.calls])).not.toMatch(/fixture-private-path|test-private-key/);
      expect(secretStore.entries.get('provider/apimart')).toBe('test-saved-key');

      secretStore.invoke.mockImplementation(invokeSecret);
      await expect(loadConfigWithSecrets()).resolves.toMatchObject({
        config: { providers: { apimart: { apiKey: 'test-saved-key' } } }, missingSecrets: [],
      });
    },
  );

  it('preserves the saved reference when a keyless editor snapshot updates other connection fields', async () => {
    await saveConfig({ providers: { apimart: { name: 'Original', apiKey: 'test-retained-key' } } });
    secretStore.invoke.mockClear();

    await saveConfig({ theme: 'light', providers: { apimart: { name: 'Renamed', apiKey: '', baseUrl: 'https://example.com' } } });

    expect(secretStore.invoke).not.toHaveBeenCalled();
    await expect(loadConfigFromDb()).resolves.toMatchObject({
      providers: { apimart: { apiKey: '', apiKeyRef: 'secret:provider/apimart', name: 'Renamed' } },
    });
    await expect(loadConfigWithSecrets()).resolves.toMatchObject({
      config: { theme: 'light', providers: { apimart: { apiKey: 'test-retained-key', name: 'Renamed' } } },
      missingSecrets: [],
    });
  });

  it('recovers a lost reference from the same connection native entry and persists the repaired reference', async () => {
    await saveConfigToDb({ providers: { apimart: { name: 'Apimart', apiKey: '' } } });
    secretStore.entries.set('provider/apimart', 'test-recoverable-key');
    secretStore.entries.set('provider/unrelated', 'test-unrelated-key');

    await expect(loadConfigWithSecrets()).resolves.toMatchObject({
      config: { providers: { apimart: { name: 'Apimart', apiKey: 'test-recoverable-key', apiKeyRef: 'secret:provider/apimart' } } },
      missingSecrets: [],
    });
    const persisted = await loadConfigFromDb();
    expect(persisted).toMatchObject({ providers: { apimart: { apiKey: '', apiKeyRef: 'secret:provider/apimart' } } });
    expect(JSON.stringify(persisted)).not.toMatch(/test-recoverable-key|test-unrelated-key/);
    expect(secretStore.invoke.mock.calls.every(([command, args]) => command === 'secret_get' && args.key === 'provider/apimart')).toBe(true);
    await expect(loadConfigWithSecrets()).resolves.toMatchObject({
      config: { providers: { apimart: { apiKey: 'test-recoverable-key' } } }, missingSecrets: [],
    });
  });

  it('does not invent a reference for a connection that has never stored credentials', async () => {
    const original = { providers: { custom: { apiKey: '', name: 'No authentication' } } };
    await saveConfigToDb(original);

    await expect(loadConfigWithSecrets()).resolves.toEqual({ config: original, missingSecrets: [] });
    await expect(loadConfigFromDb()).resolves.toEqual(original);
    expect(secretStore.entries.size).toBe(0);
  });

  it('keeps a legacy credential record when a keyless snapshot would remove its only copy', async () => {
    const legacy = { providers: { apimart: { apiKey: 'test-only-legacy-copy' } } };
    await saveConfigToDb(legacy);

    await expect(saveConfig({ providers: { apimart: { apiKey: '' } } })).rejects.toThrow('保存应用配置失败');
    await expect(loadConfigFromDb()).resolves.toEqual(legacy);
    expect(secretStore.invoke).not.toHaveBeenCalled();
  });

  it('does not replace an explicit missing reference with another native entry', async () => {
    const original = { providers: { apimart: { apiKey: '', apiKeyRef: 'secret:provider/explicit-ref' } } };
    await saveConfigToDb(original);
    secretStore.entries.set('provider/apimart', 'test-other-entry');

    await expect(loadConfigWithSecrets()).resolves.toEqual({ config: original, missingSecrets: ['apimart'] });
    expect(secretStore.invoke).toHaveBeenCalledTimes(1);
    expect(secretStore.invoke).toHaveBeenCalledWith('secret_get', { key: 'provider/explicit-ref' });
    await expect(loadConfigFromDb()).resolves.toEqual(original);
  });

  it('reports an actually missing referenced entry without deleting its reference', async () => {
    await saveConfig({ providers: { apimart: { apiKey: 'test-removed-key' } } });
    const original = await loadConfigFromDb();
    secretStore.entries.clear();

    await expect(loadConfigWithSecrets()).resolves.toEqual({ config: original, missingSecrets: ['apimart'] });
    await expect(loadConfigFromDb()).resolves.toEqual(original);
  });

  it('still refuses to persist plaintext when no keychain is available', async () => {
    secretStore.isTauri = false;

    const unstored = await saveConfig({
      theme: 'dark',
      providers: { apimart: { name: 'Apimart', apiKey: 'sk-should-not-persist' } },
    });

    expect(unstored).toEqual(['apimart']);
    expect(JSON.stringify(await loadConfigFromDb())).not.toContain('sk-should-not-persist');
  });

  it('rejects a failed migration write without treating the saved config as absent', async () => {
    const legacy = {
      theme: 'light',
      providers: { apimart: { name: 'Apimart', apiKey: 'legacy-plaintext' } },
    };
    await saveConfigToDb(legacy);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('G:/private-data/database legacy-plaintext', 'QuotaExceededError');
    });

    await expect(loadConfigWithSecrets()).rejects.toThrow('读取应用配置失败，请重试或检查存储状态');
    await expect(loadConfigFromDb()).resolves.toEqual(legacy);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private-data');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('legacy-plaintext');

    await expect(loadConfigWithSecrets()).resolves.toMatchObject({
      config: legacy,
      missingSecrets: [],
    });
    expect(JSON.stringify(await loadConfigFromDb())).not.toContain('legacy-plaintext');
  });

  it('keeps the original record when credential verification fails during migration cleanup', async () => {
    const legacy = {
      theme: 'light',
      providers: { apimart: { name: 'Apimart', apiKey: 'legacy-plaintext' } },
    };
    await saveConfigToDb(legacy);
    const invokeSecret = secretStore.invoke.getMockImplementation()!;
    let reads = 0;
    secretStore.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'secret_get' && ++reads === 2) throw new Error('凭据存储暂时不可用');
      return invokeSecret(command, args);
    });

    await expect(loadConfigWithSecrets()).rejects.toThrow('读取应用配置失败，请重试或检查存储状态');
    await expect(loadConfigFromDb()).resolves.toEqual(legacy);
    expect(secretStore.entries.get('provider/apimart')).toBe('legacy-plaintext');

    await expect(loadConfigWithSecrets()).resolves.toMatchObject({
      config: legacy,
      missingSecrets: [],
    });
    expect(JSON.stringify(await loadConfigFromDb())).not.toContain('legacy-plaintext');
    await expect(loadConfigFromDb()).resolves.toMatchObject({
      providers: { apimart: { apiKey: '', apiKeyRef: 'secret:provider/apimart' } },
    });
  });

  it('does not rewrite an unchanged key when saving window preferences', async () => {
    const config = { theme: 'dark', providers: { apimart: { apiKey: 'test-unchanged-key' } } };
    await saveConfig(config);
    secretStore.invoke.mockClear();

    await saveConfig({ ...config, theme: 'light', mainWindowSize: { width: 1200, height: 800 } });

    expect(secretStore.invoke.mock.calls.filter(([command]) => command === 'secret_set')).toHaveLength(0);
    expect(secretStore.invoke.mock.calls.filter(([command]) => command === 'secret_get')).toHaveLength(1);
    await expect(loadConfigFromDb()).resolves.toMatchObject({ theme: 'light' });
  });

  it('keeps the saved config and existing key reference when updating that key fails', async () => {
    await saveConfig({ theme: 'dark', providers: { apimart: { apiKey: 'test-old-key' } } });
    const original = await loadConfigFromDb();
    const invokeSecret = secretStore.invoke.getMockImplementation()!;
    secretStore.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'secret_set') throw new Error('G:/private-data/secrets test-new-key');
      return invokeSecret(command, args);
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 编辑方没有带回 apiKeyRef 时，也必须识别数据库里已有的凭据。
    await expect(saveConfig({
      theme: 'light', providers: { apimart: { apiKey: 'test-new-key' } },
    })).rejects.toThrow('保存应用配置失败');

    await expect(loadConfigFromDb()).resolves.toEqual(original);
    expect(secretStore.entries.get('provider/apimart')).toBe('test-old-key');
    expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/private-data|test-new-key/);

    secretStore.invoke.mockImplementation(invokeSecret);
    await expect(saveConfig({ theme: 'light', providers: { apimart: { apiKey: 'test-new-key' } } })).resolves.toEqual([]);
    await expect(loadConfigWithSecrets()).resolves.toMatchObject({
      config: { theme: 'light', providers: { apimart: { apiKey: 'test-new-key' } } },
    });
  });

  it('rejects a config read failure before changing any native credential', async () => {
    const original = { theme: 'dark', providers: {} };
    await saveConfigToDb(original);
    const db = await openDB();
    vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
      throw new DOMException('database unavailable', 'UnknownError');
    });

    await expect(saveConfig({ providers: { apimart: { apiKey: 'test-new-key' } } })).rejects.toThrow();
    expect(secretStore.invoke).not.toHaveBeenCalled();
    await expect(loadConfigFromDb()).resolves.toEqual(original);
  });

  it('serializes credential work and database commits for overlapping saves', async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const invokeSecret = secretStore.invoke.getMockImplementation()!;
    secretStore.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'secret_set' && args.value === 'test-older-key') {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return invokeSecret(command, args);
    });
    const older = saveConfig({ theme: 'dark', providers: { apimart: { apiKey: 'test-older-key' } } });
    await firstStarted.promise;
    const newer = saveConfig({ theme: 'light', providers: { apimart: { apiKey: 'test-newer-key' } } });
    try {
      // 让数据库和原生 Promise 有机会推进，第一笔凭据写入仍由门闩阻塞。
      await loadConfigFromDb();
      expect(secretStore.invoke.mock.calls.some(([, args]) => args.value === 'test-newer-key')).toBe(false);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([older, newer]);
    }
    await expect(older).resolves.toEqual([]);
    await expect(newer).resolves.toEqual([]);
    await expect(loadConfigWithSecrets()).resolves.toMatchObject({
      config: { theme: 'light', providers: { apimart: { apiKey: 'test-newer-key' } } },
    });
  });

  it('snapshots caller data before it waits in the shared queue', async () => {
    const release = deferred();
    const blocking = enqueueConfigPersistence(() => release.promise);
    const data = { theme: 'light', providers: { apimart: { apiKey: 'test-snapshot-key' } } };
    const saving = saveConfig(data);
    data.theme = 'dark';
    data.providers.apimart.apiKey = 'test-later-mutation';
    release.resolve();
    await blocking;
    await saving;

    await expect(loadConfigWithSecrets()).resolves.toMatchObject({
      config: { theme: 'light', providers: { apimart: { apiKey: 'test-snapshot-key' } } },
    });
  });

  it('lets the next queued save continue after an earlier credential failure', async () => {
    await saveConfig({ providers: { apimart: { apiKey: 'test-old-key' } } });
    const invokeSecret = secretStore.invoke.getMockImplementation()!;
    secretStore.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'secret_set' && args.value === 'test-failed-key') throw new Error('write failed');
      return invokeSecret(command, args);
    });

    const failed = saveConfig({ theme: 'dark', providers: { apimart: { apiKey: 'test-failed-key' } } });
    const recovered = saveConfig({ theme: 'light', providers: { apimart: { apiKey: 'test-recovered-key' } } });
    const results = await Promise.allSettled([failed, recovered]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    await expect(loadConfigWithSecrets()).resolves.toMatchObject({
      config: { theme: 'light', providers: { apimart: { apiKey: 'test-recovered-key' } } },
    });
  });

  it('does not let an in-flight save recreate a key after deletion', async () => {
    const started = deferred();
    const release = deferred();
    const invokeSecret = secretStore.invoke.getMockImplementation()!;
    secretStore.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'secret_set') { started.resolve(); await release.promise; }
      return invokeSecret(command, args);
    });
    const saving = saveConfig({ providers: { apimart: { apiKey: 'test-deleted-key' } } });
    await started.promise;
    const deleting = deleteProviderSecret('apimart');
    try {
      await Promise.resolve();
      expect(secretStore.invoke.mock.calls.some(([command]) => command === 'secret_delete')).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([saving, deleting]);
    }
    await saving;
    await deleting;
    expect(secretStore.entries.has('provider/apimart')).toBe(false);
  });

  it('waits for a migration to finish before committing a subsequent save', async () => {
    await saveConfigToDb({ theme: 'dark', providers: { apimart: { apiKey: 'test-legacy-key' } } });
    const started = deferred();
    const release = deferred();
    const invokeSecret = secretStore.invoke.getMockImplementation()!;
    secretStore.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'secret_set' && args.value === 'test-legacy-key') {
        started.resolve();
        await release.promise;
      }
      return invokeSecret(command, args);
    });
    const loading = loadConfigWithSecrets();
    await started.promise;
    const saving = saveConfig({ theme: 'light', providers: { apimart: { apiKey: 'test-new-key' } } });
    try {
      await Promise.resolve();
      expect(secretStore.invoke.mock.calls.some(([, args]) => args.value === 'test-new-key')).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([loading, saving]);
    }
    await loading;
    await saving;
    await expect(loadConfigWithSecrets()).resolves.toMatchObject({
      config: { theme: 'light', providers: { apimart: { apiKey: 'test-new-key' } } },
    });
  });

  it('rejects an aborted write and releases the queue for the next save', async () => {
    await saveConfigToDb({ theme: 'dark', providers: {} });
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(saveConfig({ theme: 'light', providers: {} })).rejects.toThrow();
    await expect(loadConfigFromDb()).resolves.toEqual({ theme: 'dark', providers: {} });
    await saveConfig({ theme: 'system', providers: {} });
    await expect(loadConfigFromDb()).resolves.toEqual({ theme: 'system', providers: {} });
  });

  it('retains Store edits when a patch transaction aborts after put, then converges on explicit retry', async () => {
    await saveConfigToDb({ theme: 'dark', providers: {} });
    const store = configStore(); await store.getState().loadConfig();
    store.getState().updateConfig({ theme: 'light' });
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(store.getState().saveConfig()).rejects.toThrow('设置保存失败');
    expect(store.getState()).toMatchObject({ configDirty: true, configSaveStatus: 'error', config: { theme: 'light' } });
    expect(await loadConfigFromDb()).toMatchObject({ theme: 'dark' });
    await store.getState().saveConfig();
    expect(store.getState()).toMatchObject({ configDirty: false, configSaveStatus: 'saved' });
    expect(await loadConfigFromDb()).toMatchObject({ theme: 'light' });
  });

  it('does not bypass a failed cross-window lock and recovers on the next request', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('lock unavailable'))
      .mockImplementation(async (_name: string, _options: unknown, operation: () => Promise<unknown>) => operation());
    vi.stubGlobal('navigator', { locks: { request } });

    await expect(saveConfig({ providers: { apimart: { apiKey: 'test-locked-key' } } })).rejects.toThrow();
    expect(secretStore.invoke).not.toHaveBeenCalled();
    await expect(loadConfigFromDb()).resolves.toBeNull();
    await saveConfig({ theme: 'light', providers: {} });
    expect(request).toHaveBeenCalledWith('ai-canvas:config-persistence', { mode: 'exclusive' }, expect.any(Function));
    await expect(loadConfigFromDb()).resolves.toEqual({ theme: 'light', providers: {} });
  });

  it('rejects when all initial legacy credential writes fail and migrates both after recovery', async () => {
    const legacy = {
      theme: 'light',
      providers: {
        apimart: { name: 'Apimart', apiKey: 'legacy-test-apimart' },
        volcengine: { name: '火山', apiKey: 'legacy-test-volcengine' },
      },
    };
    await saveConfigToDb(legacy);
    const invokeSecret = secretStore.invoke.getMockImplementation()!;
    secretStore.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'secret_set') throw new Error('凭据存储暂时不可用');
      return invokeSecret(command, args);
    });

    await expect(loadConfigWithSecrets()).rejects.toThrow('读取应用配置失败，请重试或检查存储状态');
    await expect(loadConfigFromDb()).resolves.toEqual(legacy);
    expect(secretStore.invoke.mock.calls.filter(([command]) => command === 'secret_set')).toHaveLength(2);
    expect(secretStore.entries.size).toBe(0);

    secretStore.invoke.mockImplementation(invokeSecret);
    await expect(loadConfigWithSecrets()).resolves.toMatchObject({
      config: legacy,
      missingSecrets: [],
    });
    const persisted = await loadConfigFromDb();
    expect(JSON.stringify(persisted)).not.toContain('legacy-test-apimart');
    expect(JSON.stringify(persisted)).not.toContain('legacy-test-volcengine');
    expect(persisted).toMatchObject({
      providers: {
        apimart: { apiKey: '', apiKeyRef: 'secret:provider/apimart' },
        volcengine: { apiKey: '', apiKeyRef: 'secret:provider/volcengine' },
      },
    });
    expect(secretStore.entries.get('provider/apimart')).toBe('legacy-test-apimart');
    expect(secretStore.entries.get('provider/volcengine')).toBe('legacy-test-volcengine');
  });
});

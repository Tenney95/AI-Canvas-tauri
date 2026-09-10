import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    if (command === 'secret_set') { secretStore.entries.set(key, args.value as string); return undefined; }
    if (command === 'secret_get') return secretStore.entries.get(key) ?? null;
    if (command === 'secret_delete') { secretStore.entries.delete(key); return undefined; }
    return undefined;
  });
});

describe('config persistence keeps secrets out of IndexedDB', () => {
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

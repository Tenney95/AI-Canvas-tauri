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

  it('keeps the original record when a second credential write fails during migration', async () => {
    const legacy = {
      theme: 'light',
      providers: { apimart: { name: 'Apimart', apiKey: 'legacy-plaintext' } },
    };
    await saveConfigToDb(legacy);
    const invokeSecret = secretStore.invoke.getMockImplementation()!;
    let writes = 0;
    secretStore.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'secret_set' && ++writes === 2) throw new Error('凭据存储暂时不可用');
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

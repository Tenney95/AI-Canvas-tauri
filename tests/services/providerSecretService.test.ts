import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  isTauri: true,
  keychain: new Map<string, string>(),
  failReads: false,
  failWrites: false,
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
}));

vi.mock('../../src/services/fs/core', () => ({
  isTauriEnv: () => tauriMocks.isTauri,
}));

import {
  deleteProviderSecret,
  hasPlaintextSecret,
  providerSecretRef,
  restoreConfigSecrets,
  stripConfigSecrets,
  readAppSecret,
  writeAppSecret,
} from '../../src/services/providerSecretService';
import { enqueueConfigPersistence } from '../../src/services/configPersistenceQueue';

function config(providers: Record<string, Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { theme: 'dark', providers, ...extra };
}

beforeEach(() => {
  tauriMocks.isTauri = true;
  tauriMocks.keychain.clear();
  tauriMocks.failReads = false;
  tauriMocks.failWrites = false;
  tauriMocks.invoke.mockReset();
  tauriMocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    const key = args?.key as string;
    if (command === 'secret_set') {
      if (tauriMocks.failWrites) throw new Error('凭据存储不可用');
      tauriMocks.keychain.set(key, args.value as string);
      return undefined;
    }
    if (command === 'secret_get') {
      if (tauriMocks.failReads) throw new Error('G:/fixture-private-path/test-secret-read-failed');
      return tauriMocks.keychain.get(key) ?? null;
    }
    if (command === 'secret_delete') {
      tauriMocks.keychain.delete(key);
      return undefined;
    }
    throw new Error(`unexpected command ${command}`);
  });
});

describe('provider secret persistence', () => {
  it('passes the observed native value as a compare condition and does not retry conflicts', async () => {
    tauriMocks.keychain.set('provider/apimart', 'original-fixture');
    await stripConfigSecrets(config({ apimart: { apiKey: 'next-fixture' } }));
    expect(tauriMocks.invoke).toHaveBeenCalledWith('secret_set', {
      key: 'provider/apimart', value: 'next-fixture', expected: { value: 'original-fixture' },
    });
    tauriMocks.invoke.mockClear();
    tauriMocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'secret_get') return 'next-fixture';
      throw { code: 'conflict', message: 'fixture-private' };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(stripConfigSecrets(config({ apimart: { apiKey: 'other-fixture' } }))).rejects.toMatchObject({ code: 'conflict' });
    expect(tauriMocks.invoke.mock.calls.filter(([cmd]) => cmd === 'secret_set')).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture');
  });

  it('distinguishes a missing application secret from a failed read without leaking details', async () => {
    await expect(readAppSecret('mcp/token')).resolves.toBeNull();
    tauriMocks.failReads = true;
    const failure = await readAppSecret('mcp/token').catch((error: unknown) => error);
    expect(failure).toMatchObject({ operation: 'secret-read', code: 'unknown' });
    expect(String(failure)).not.toContain('fixture-private-path');
    expect(failure).not.toHaveProperty('cause');
    expect(tauriMocks.invoke.mock.calls.filter(([command]) => command === 'secret_set')).toHaveLength(0);
  });

  it('rejects malformed IPC results and classifies unavailable runtime', async () => {
    tauriMocks.invoke.mockResolvedValueOnce(undefined);
    await expect(readAppSecret('mcp/token')).rejects.toMatchObject({ code: 'corrupt' });
    tauriMocks.isTauri = false;
    await expect(readAppSecret('mcp/token')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('retries only a transient native read and does not retry failed writes', async () => {
    tauriMocks.invoke.mockRejectedValueOnce({ code: 'busy', message: 'secret-path' }).mockResolvedValueOnce('saved');
    expect(await readAppSecret('mcp/token')).toBe('saved');
    expect(tauriMocks.invoke).toHaveBeenCalledTimes(2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tauriMocks.invoke.mockRejectedValueOnce(new Error('G:/private sk-private'));
    expect(await writeAppSecret('mcp/token', 'replacement')).toBe(false);
    expect(tauriMocks.invoke).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('replacement');
  });

  it('checks the native value and skips unchanged credential writes', async () => {
    tauriMocks.keychain.set('provider/apimart', 'unchanged-test-key');

    const result = await stripConfigSecrets(config({
      apimart: { name: 'Apimart', apiKey: 'unchanged-test-key' },
    }));

    expect(result.unstored).toEqual([]);
    expect(result.failedExistingSecrets).toEqual([]);
    expect(tauriMocks.invoke).toHaveBeenCalledWith('secret_get', { key: 'provider/apimart' });
    expect(tauriMocks.invoke.mock.calls.filter(([command]) => command === 'secret_set')).toHaveLength(0);
    expect(result.config).toMatchObject({
      providers: { apimart: { apiKey: '', apiKeyRef: 'secret:provider/apimart' } },
    });
  });

  it('writes a changed credential once and rechecks native state on every save', async () => {
    tauriMocks.keychain.set('provider/apimart', 'old-test-key');
    const next = config({ apimart: { name: 'Apimart', apiKey: 'new-test-key' } });

    await stripConfigSecrets(next);
    await stripConfigSecrets(next);

    expect(tauriMocks.keychain.get('provider/apimart')).toBe('new-test-key');
    expect(tauriMocks.invoke.mock.calls.filter(([command]) => command === 'secret_get')).toHaveLength(2);
    expect(tauriMocks.invoke.mock.calls.filter(([command]) => command === 'secret_set')).toHaveLength(1);

    tauriMocks.keychain.set('provider/apimart', 'externally-changed-test-key');
    await stripConfigSecrets(next);
    expect(tauriMocks.invoke.mock.calls.filter(([command]) => command === 'secret_set')).toHaveLength(2);
  });

  it('does not overwrite a credential when its native value cannot be read', async () => {
    tauriMocks.keychain.set('provider/apimart', 'existing-test-key');
    tauriMocks.failReads = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await stripConfigSecrets(config({
      apimart: { apiKey: 'new-test-key', apiKeyRef: 'secret:provider/apimart' },
    }));

    expect(result.unstored).toEqual(['apimart']);
    expect(result.failedExistingSecrets).toEqual(['apimart']);
    expect(tauriMocks.keychain.get('provider/apimart')).toBe('existing-test-key');
    expect(tauriMocks.invoke.mock.calls.filter(([command]) => command === 'secret_set')).toHaveLength(0);
    expect(result.config).toMatchObject({
      providers: { apimart: { apiKey: '', apiKeyRef: 'secret:provider/apimart' } },
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-private-path');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('test-secret-read-failed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('new-test-key');
  });

  it('preserves an existing reference when a changed credential cannot be written', async () => {
    tauriMocks.keychain.set('provider/apimart', 'old-test-key');
    tauriMocks.failWrites = true;

    const result = await stripConfigSecrets(config({
      apimart: { apiKey: 'new-test-key', apiKeyRef: 'secret:provider/apimart' },
    }));

    expect(result.unstored).toEqual(['apimart']);
    expect(result.failedExistingSecrets).toEqual(['apimart']);
    expect(result.config).toMatchObject({
      providers: { apimart: { apiKey: '', apiKeyRef: 'secret:provider/apimart' } },
    });
    expect(tauriMocks.keychain.get('provider/apimart')).toBe('old-test-key');
  });

  it.each([undefined, 'secret:provider/other-ref'])(
    'uses the persisted reference when the input reference is %s',
    async (apiKeyRef) => {
      tauriMocks.failWrites = true;
      const previous = config({ apimart: { apiKey: '', apiKeyRef: 'secret:provider/apimart' } });

      const result = await stripConfigSecrets(config({
        apimart: { apiKey: 'new-test-key', ...(apiKeyRef ? { apiKeyRef } : {}) },
      }), previous);

      expect(result.failedExistingSecrets).toEqual(['apimart']);
      expect(result.config).toMatchObject({
        providers: { apimart: { apiKey: '', apiKeyRef: 'secret:provider/apimart' } },
      });
    },
  );

  it('reports failed legacy credentials only when plaintext was already persisted', async () => {
    tauriMocks.failWrites = true;
    const previous = config({ apimart: { apiKey: 'previous-test-key' } });

    const result = await stripConfigSecrets(config({
      apimart: { apiKey: 'replacement-test-key' },
      custom: { apiKey: 'new-connection-test-key' },
    }), previous);

    expect(result.unstored).toEqual(['apimart', 'custom']);
    expect(result.failedExistingSecrets).toEqual(['apimart']);
    expect(hasPlaintextSecret(result.config)).toBe(false);
    expect(JSON.stringify(result.config)).not.toContain('previous-test-key');
  });

  it('marks same-value legacy migration for database cleanup without rewriting the key', async () => {
    tauriMocks.keychain.set('provider/apimart', 'legacy-test-key');

    const result = await restoreConfigSecrets(config({ apimart: { apiKey: 'legacy-test-key' } }));

    expect(result.migrated).toBe(true);
    expect(result.config).toMatchObject({
      providers: { apimart: { apiKey: 'legacy-test-key', apiKeyRef: 'secret:provider/apimart' } },
    });
    expect(tauriMocks.invoke.mock.calls.filter(([command]) => command === 'secret_set')).toHaveLength(0);
  });

  it('moves the api key into the keychain and leaves only a reference', async () => {
    const { config: persisted, unstored } = await stripConfigSecrets(
      config({ apimart: { name: 'Apimart', apiKey: 'sk-live-secret', baseUrl: 'https://api' } }),
    );

    expect(unstored).toEqual([]);
    expect(hasPlaintextSecret(persisted)).toBe(false);
    expect(JSON.stringify(persisted)).not.toContain('sk-live-secret');
    const providers = (persisted as { providers: Record<string, Record<string, unknown>> }).providers;
    expect(providers.apimart).toMatchObject({
      name: 'Apimart',
      apiKey: '',
      apiKeyRef: providerSecretRef('apimart'),
      baseUrl: 'https://api',
    });
    expect(tauriMocks.keychain.get('provider/apimart')).toBe('sk-live-secret');
  });

  it('restores the key from the keychain on load', async () => {
    const { config: persisted } = await stripConfigSecrets(
      config({ apimart: { name: 'Apimart', apiKey: 'sk-live-secret' } }),
    );

    const restored = await restoreConfigSecrets(persisted);

    expect(restored.missing).toEqual([]);
    expect(restored.migrated).toBe(false);
    const providers = (restored.config as { providers: Record<string, Record<string, unknown>> }).providers;
    expect(providers.apimart.apiKey).toBe('sk-live-secret');
  });

  it('migrates a legacy plaintext config into the keychain', async () => {
    const legacy = config({ volcengine: { name: '火山', apiKey: 'legacy-plain-key' } });

    const restored = await restoreConfigSecrets(legacy);

    expect(restored.migrated).toBe(true);
    expect(tauriMocks.keychain.get('provider/volcengine')).toBe('legacy-plain-key');
    // 迁移后内存里仍可用，但再次持久化不会写回明文
    const providers = (restored.config as { providers: Record<string, Record<string, unknown>> }).providers;
    expect(providers.volcengine.apiKey).toBe('legacy-plain-key');
    const { config: rewritten } = await stripConfigSecrets(restored.config);
    expect(hasPlaintextSecret(rewritten)).toBe(false);
    expect(JSON.stringify(rewritten)).not.toContain('legacy-plain-key');
  });

  it('never writes plaintext when the keychain rejects the write', async () => {
    tauriMocks.failWrites = true;

    const { config: persisted, unstored, failedExistingSecrets } = await stripConfigSecrets(
      config({ apimart: { name: 'Apimart', apiKey: 'sk-live-secret' } }),
    );

    expect(unstored).toEqual(['apimart']);
    expect(failedExistingSecrets).toEqual([]);
    expect(hasPlaintextSecret(persisted)).toBe(false);
    expect(JSON.stringify(persisted)).not.toContain('sk-live-secret');
    const providers = (persisted as { providers: Record<string, Record<string, unknown>> }).providers;
    expect(providers.apimart).not.toHaveProperty('apiKeyRef');
  });

  it('never writes plaintext outside Tauri either', async () => {
    tauriMocks.isTauri = false;

    const { config: persisted, unstored } = await stripConfigSecrets(
      config({ apimart: { name: 'Apimart', apiKey: 'sk-live-secret' } }),
    );

    expect(unstored).toEqual(['apimart']);
    expect(JSON.stringify(persisted)).not.toContain('sk-live-secret');
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it('reports connections whose keychain entry disappeared', async () => {
    const { config: persisted } = await stripConfigSecrets(
      config({ apimart: { name: 'Apimart', apiKey: 'sk-live-secret' } }),
    );
    tauriMocks.keychain.clear();

    const restored = await restoreConfigSecrets(persisted);

    expect(restored.missing).toEqual(['apimart']);
    const providers = (restored.config as { providers: Record<string, Record<string, unknown>> }).providers;
    expect(providers.apimart.apiKey).toBe('');
  });

  it('drops the deprecated dreamina cookie instead of persisting it', async () => {
    const { config: persisted } = await stripConfigSecrets(
      config({}, { dreaminaAuth: { loggedIn: true, username: 'u', cookie: 'sessionid=secret' } }),
    );

    expect(JSON.stringify(persisted)).not.toContain('sessionid=secret');
    const auth = (persisted as { dreaminaAuth: Record<string, unknown> }).dreaminaAuth;
    expect(auth).toEqual({ loggedIn: true, username: 'u' });
  });

  it('keeps empty connections and non-provider config untouched', async () => {
    const { config: persisted, unstored } = await stripConfigSecrets(
      config({ custom: { name: '自建', apiKey: '', catalogId: 'custom-openai' } }, { theme: 'light' }),
    );

    expect(unstored).toEqual([]);
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
    expect(persisted).toMatchObject({ theme: 'light' });
    const providers = (persisted as { providers: Record<string, Record<string, unknown>> }).providers;
    expect(providers.custom).toMatchObject({ apiKey: '', catalogId: 'custom-openai' });
  });

  it('deletes the keychain entry when a connection is removed', async () => {
    await stripConfigSecrets(config({ apimart: { name: 'Apimart', apiKey: 'sk-live-secret' } }));
    expect(tauriMocks.keychain.has('provider/apimart')).toBe(true);

    await deleteProviderSecret('apimart');

    expect(tauriMocks.keychain.has('provider/apimart')).toBe(false);
  });

  it('queues credential deletion behind an earlier configuration operation', async () => {
    let release: () => void = () => {};
    const blocked = enqueueConfigPersistence(() => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    tauriMocks.keychain.set('provider/apimart', 'existing-test-key');

    const deletion = deleteProviderSecret('apimart');
    await Promise.resolve();
    try {
      expect(tauriMocks.keychain.has('provider/apimart')).toBe(true);
      expect(tauriMocks.invoke.mock.calls.filter(([command]) => command === 'secret_delete')).toHaveLength(0);
    } finally {
      release();
      await blocked;
      await deletion;
    }
    expect(tauriMocks.keychain.has('provider/apimart')).toBe(false);
  });

  it('sanitizes connection ids used as keychain entry names', () => {
    expect(providerSecretRef('custom openai/../x')).toBe('secret:provider/custom_openai___x');
  });
});

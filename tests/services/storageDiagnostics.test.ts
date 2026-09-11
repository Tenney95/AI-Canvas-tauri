import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyStorageError, readStorageWithRetry, reportStorageError, StorageError } from '../../src/services/storageDiagnostics';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('safe storage diagnostics', () => {
  it('retries an interrupted read and returns the later value', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(new DOMException('private', 'AbortError')).mockResolvedValue('saved');
    const result = readStorageWithRetry('toolbar-read', read);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe('saved');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('limits even explicit transient failures to three attempts', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue({ code: 'busy', message: 'sensitive' });
    const check = expect(readStorageWithRetry('secret-read', read)).rejects.toMatchObject({ code: 'busy', attempt: 3 });
    await vi.runAllTimersAsync();
    await check;
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each(['SecurityError', 'VersionError', 'QuotaExceededError', 'SyntaxError', 'UnknownError'])(
    'does not retry %s or retain its raw message', async (name) => {
      const read = vi.fn().mockRejectedValue(new DOMException('G:/private/key-value', name));
      const result = await readStorageWithRetry('secret-read', read).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(StorageError);
      expect(read).toHaveBeenCalledOnce();
      expect(String(result)).not.toContain('private');
      expect(result).not.toHaveProperty('cause');
    },
  );

  it('logs only whitelisted operation, code and attempt', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportStorageError('secret-write', { code: 'sk-private-key', message: 'G:/private/file', name: 'private-name' });
    expect(warn).toHaveBeenCalledExactlyOnceWith('[storage]', { operation: 'secret-write', code: 'unknown', attempt: 1 });
    expect(classifyStorageError('权限错误 G:/private')).toBe('unknown');
    expect(classifyStorageError({ code: 'permission_denied' })).toBe('permission');
  });
});

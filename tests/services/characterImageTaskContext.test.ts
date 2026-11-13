import { describe, expect, it, vi } from 'vitest';
import type { CharacterImageTaskRecovery } from '../../src/types/media';
import { executeCharacterImageTask, isCharacterImageTaskContext, registerCharacterImageTaskContext,
  validateCharacterImageTaskRecovery } from '../../src/services/characterImageTaskContext';

const receipt = (): CharacterImageTaskRecovery => ({ version: 1, kind: 'builtin', builtinMode: 'ccc',
  connectionId: 'gateway', providerBase: 'https://gateway.example/v1', modelRef: 'general/image',
  configurationDigest: 'a'.repeat(64), expectedCount: 1, tasks: [{ taskId: 'job-1' }] });

describe('character image task destination', () => {
  it('requires a registered destination and allows one execution per operation', async () => {
    const completed = new Error('completed');
    const execute = vi.fn(async (): Promise<never> => { throw completed; });
    const assertCurrent = vi.fn();
    const destination = registerCharacterImageTaskContext({ execute, assertCurrent });
    const plan = { recovery: { kind: 'builtin' as const, builtinMode: 'standard' as const }, execute: vi.fn(async () => []) };
    expect(isCharacterImageTaskContext(vi.fn())).toBe(false);
    await expect(executeCharacterImageTask(vi.fn(), plan)).rejects.toThrow('受信执行目的地');
    await expect(executeCharacterImageTask(destination.beforeSubmit, plan)).rejects.toBe(completed);
    await expect(executeCharacterImageTask(destination.beforeSubmit, plan)).rejects.toThrow('不能重复提交');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    destination.release();
    expect(isCharacterImageTaskContext(destination.beforeSubmit)).toBe(false);
  });

  it('retains bounded task identities and rejects credentials, raw query bodies and cross-connection downloads', () => {
    expect(() => validateCharacterImageTaskRecovery(receipt())).not.toThrow();
    expect(() => validateCharacterImageTaskRecovery({ ...receipt(), apiKey: 'secret' } as CharacterImageTaskRecovery)).toThrow('未知字段');
    expect(() => validateCharacterImageTaskRecovery({ ...receipt(), tasks: [{ taskId: 'job-credential' }] }, ['credential'])).toThrow();
    expect(() => validateCharacterImageTaskRecovery({ ...receipt(), tasks: [{ taskId: 'job-1', recoveryContext: { prompt: 'private' } }] })).toThrow();
    expect(() => validateCharacterImageTaskRecovery({ ...receipt(), mediaDownloadAccess: {
      providerConfigId: 'other', origin: 'https://other.example', auth: { type: 'bearer' },
    } })).toThrow('原连接不一致');
    expect(() => validateCharacterImageTaskRecovery({ ...receipt(), kind: 'protocol',
      query: { modelId: 'image', digest: 'b'.repeat(64), body: 'private request' } as CharacterImageTaskRecovery['query'],
    })).toThrow('查询协议');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), write: vi.fn(), start: vi.fn(),
}));
vi.mock('../../src/services/providerSecretService', () => ({ readAppSecret: mocks.read, writeAppSecret: mocks.write }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({ config: {} }) } }));
vi.mock('../../src/services/mcp/mcpBridgeService', () => ({ startMcpBridge: mocks.start }));

const savedToken = 'ab'.repeat(32);
beforeEach(() => {
  vi.resetModules();
  mocks.read.mockReset().mockResolvedValue(null);
  mocks.write.mockReset().mockResolvedValue(true);
  mocks.start.mockReset().mockResolvedValue({ sessionId: 'running', port: 43123, transport: 'stdio' });
});

describe('MCP token persistence', () => {
  it('reads the winner after a cross-process creation conflict without retrying the write', async () => {
    const { StorageError } = await import('../../src/services/storageDiagnostics');
    mocks.read.mockResolvedValueOnce(null).mockResolvedValueOnce(savedToken);
    mocks.write.mockRejectedValueOnce(new StorageError('secret-write', 'conflict'));
    const service = await import('../../src/services/mcp/mcpSessionConfig');
    expect(await service.ensureMcpSessionToken()).toBe(savedToken);
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(service.getMcpTokenPersistence()).toBe('persistent');
  });

  it('conditions token rotation on the exact stored value and preserves conflict errors', async () => {
    const { StorageError } = await import('../../src/services/storageDiagnostics');
    mocks.read.mockResolvedValue(savedToken.toUpperCase());
    mocks.write.mockRejectedValueOnce(new StorageError('secret-write', 'conflict'));
    const service = await import('../../src/services/mcp/mcpSessionConfig');
    await expect(service.rotateMcpSessionToken()).rejects.toMatchObject({ code: 'conflict' });
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith('mcp/token', expect.any(String), { value: savedToken.toUpperCase() });
  });

  it('reads the existing token without rewriting it', async () => {
    mocks.read.mockResolvedValue(savedToken.toUpperCase());
    const service = await import('../../src/services/mcp/mcpSessionConfig');
    expect(await service.ensureMcpSessionToken()).toBe(savedToken);
    expect(service.getMcpTokenPersistence()).toBe('persistent');
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('shares concurrent initialization and persists only once', async () => {
    const service = await import('../../src/services/mcp/mcpSessionConfig');
    const tokens = await Promise.all(Array.from({ length: 8 }, () => service.ensureMcpSessionToken()));
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith('mcp/token', tokens[0], { value: null });
  });

  it('never overwrites a token on read failure and allows a later retry', async () => {
    mocks.read.mockRejectedValueOnce(new Error('read failed')).mockResolvedValue(savedToken);
    const service = await import('../../src/services/mcp/mcpSessionConfig');
    await expect(service.ensureMcpSessionToken()).rejects.toThrow();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(await service.ensureMcpSessionToken()).toBe(savedToken);
  });

  it.each(['', 'invalid-token'])('does not replace corrupt token %s', async (value) => {
    mocks.read.mockResolvedValue(value);
    const service = await import('../../src/services/mcp/mcpSessionConfig');
    await expect(service.ensureMcpSessionToken()).rejects.toMatchObject({ code: 'corrupt' });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('keeps a stable, marked session-only token after failed initial persistence', async () => {
    mocks.write.mockResolvedValue(false);
    const service = await import('../../src/services/mcp/mcpSessionConfig');
    const first = await service.ensureMcpSessionToken();
    expect(service.getMcpTokenPersistence()).toBe('session-only');
    expect(await service.ensureMcpSessionToken()).toBe(first);
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.write).toHaveBeenCalledOnce();
  });

  it('uses memory only for explicit unavailability, never for permission denial', async () => {
    const { StorageError } = await import('../../src/services/storageDiagnostics');
    const service = await import('../../src/services/mcp/mcpSessionConfig');
    mocks.read.mockRejectedValueOnce(new StorageError('secret-read', 'permission'));
    await expect(service.ensureMcpSessionToken()).rejects.toMatchObject({ code: 'permission' });
    mocks.read.mockRejectedValue(new StorageError('secret-read', 'unavailable'));
    const token = await service.ensureMcpSessionToken();
    expect(await service.ensureMcpSessionToken()).toBe(token);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(service.getMcpTokenPersistence()).toBe('session-only');
  });

  it('does not create a token when looking up an already running bridge', async () => {
    const service = await import('../../src/services/mcp/mcpSessionConfig');
    expect(await service.readRunningMcpToken('existing')).toBeNull();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('preserves the actual active bridge token when reading or rotating fails', async () => {
    mocks.read.mockResolvedValue(savedToken);
    const service = await import('../../src/services/mcp/mcpSessionConfig');
    await service.startConfiguredMcpBridge();
    mocks.read.mockRejectedValue(new Error('read failed'));
    await expect(service.rotateMcpSessionToken()).rejects.toThrow();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(await service.readRunningMcpToken('running')).toBe(savedToken);
    mocks.read.mockResolvedValue(savedToken);
    mocks.write.mockResolvedValue(false);
    await expect(service.rotateMcpSessionToken()).rejects.toMatchObject({ operation: 'secret-write' });
    expect(await service.readRunningMcpToken('running')).toBe(savedToken);
  });

  it('rotates successfully and keeps the prior active token until bridge restart', async () => {
    mocks.read.mockResolvedValue(savedToken);
    mocks.write.mockImplementation(async (_key: string, value: string) => { mocks.read.mockResolvedValue(value); return true; });
    const service = await import('../../src/services/mcp/mcpSessionConfig');
    await service.startConfiguredMcpBridge();
    const token = await service.rotateMcpSessionToken();
    expect(token).not.toBe(savedToken);
    expect(await service.readRunningMcpToken('running')).toBe(savedToken);
    expect((await service.startConfiguredMcpBridge()).token).toBe(token);
  });
});

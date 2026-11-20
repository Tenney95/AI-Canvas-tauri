/**
 * comfyMemory — 回归测试：ComfyUI memory resources。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.fetch }));

import {
  fetchComfyMemoryStats,
  isLoopbackComfyUrl,
  maybeAutoReleaseComfyMemory,
  releaseComfyMemory,
} from '../../src/services/comfyMemory';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => mocks.fetch.mockReset());

describe('ComfyUI memory resources', () => {
  it('parses device and PyTorch VRAM counters from system_stats', async () => {
    mocks.fetch.mockResolvedValue(json({
      devices: [{
        name: 'RTX 4090', type: 'cuda', index: 0,
        vram_total: 24 * 1024 ** 3, vram_free: 3 * 1024 ** 3,
        torch_vram_total: 22 * 1024 ** 3, torch_vram_free: 2 * 1024 ** 3,
      }],
    }));

    await expect(fetchComfyMemoryStats('http://127.0.0.1:8188/')).resolves.toEqual({
      devices: [{
        name: 'RTX 4090', type: 'cuda', index: 0,
        vramTotal: 24 * 1024 ** 3, vramFree: 3 * 1024 ** 3,
        torchVramTotal: 22 * 1024 ** 3, torchVramFree: 2 * 1024 ** 3,
      }],
    });
  });

  it('rejects a successful response without recognizable device counters', async () => {
    mocks.fetch.mockResolvedValue(json({ devices: [{ name: 'CPU' }] }));
    await expect(fetchComfyMemoryStats('http://127.0.0.1:8188')).rejects.toThrow('未返回可识别');
  });

  it.each([
    ['unload-models', { unload_models: true, free_memory: false }],
    ['free-memory', { unload_models: true, free_memory: true }],
  ] as const)('sends the official /free payload for %s', async (mode, payload) => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 200 }));
    await releaseComfyMemory('http://127.0.0.1:8188/', mode);
    expect(mocks.fetch).toHaveBeenCalledWith('http://127.0.0.1:8188/free', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(payload),
    }));
  });

  it('recognizes only explicit HTTP loopback targets for automatic release', () => {
    expect(isLoopbackComfyUrl('http://127.0.0.1:8188')).toBe(true);
    expect(isLoopbackComfyUrl('https://localhost:8188')).toBe(true);
    expect(isLoopbackComfyUrl('http://[::1]:8188')).toBe(true);
    expect(isLoopbackComfyUrl('http://192.168.1.20:8188')).toBe(false);
    expect(isLoopbackComfyUrl('not-a-url')).toBe(false);
  });

  it('never changes a remote server automatically', async () => {
    await expect(maybeAutoReleaseComfyMemory('http://comfy.example:8188', 'free-memory'))
      .resolves.toBe('skipped-remote');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('leaves a busy local queue untouched', async () => {
    mocks.fetch.mockResolvedValue(json({ queue_running: [[0, 'prompt-2']], queue_pending: [] }));
    await expect(maybeAutoReleaseComfyMemory('http://localhost:8188', 'free-memory'))
      .resolves.toBe('skipped-busy');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('requires both local queues to confirm they are empty', async () => {
    mocks.fetch.mockResolvedValue(json({ queue_pending: [] }));
    await expect(maybeAutoReleaseComfyMemory('http://localhost:8188', 'free-memory')).resolves.toBe('skipped-busy');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('releases an idle local server according to the selected policy', async () => {
    mocks.fetch
      .mockResolvedValueOnce(json({ queue_running: [], queue_pending: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(maybeAutoReleaseComfyMemory('http://localhost:8188', 'unload-models'))
      .resolves.toBe('released');
    expect(mocks.fetch).toHaveBeenLastCalledWith('http://localhost:8188/free', expect.objectContaining({
      body: JSON.stringify({ unload_models: true, free_memory: false }),
    }));
  });
});

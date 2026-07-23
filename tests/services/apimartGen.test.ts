import { beforeEach, describe, expect, it, vi } from 'vitest';

const pollingMocks = vi.hoisted(() => ({
  cleanupNodePolling: vi.fn(),
  registerNodePolling: vi.fn(() => new AbortController().signal),
  removePendingTask: vi.fn(),
  savePendingTask: vi.fn(),
  updatePendingTask: vi.fn(),
}));

vi.mock('../../src/services/pollManager', () => pollingMocks);

import { generateApimartImagesBatch } from '../../src/services/ai/apimartGen';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('APIMart image polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    pollingMocks.registerNodePolling.mockReturnValue(new AbortController().signal);
  });

  it('stops polling immediately when the task fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 200,
        data: [{ task_id: 'task-failed', status: 'submitted' }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 200,
        data: {
          id: 'task-failed',
          status: 'failed',
          progress: 100,
          error: {
            code: 'task_failed',
            message: '安全违规：上游图像生成请求被拒绝',
            type: 'task_failed',
          },
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateApimartImagesBatch(
      'api-key',
      'https://api.example.com',
      'gpt-image',
      'prompt',
      '2K',
      '1:1',
      { width: 2048, height: 2048 },
    )).rejects.toThrow('APIMart 图片生成失败: 安全违规：上游图像生成请求被拒绝');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cleans up node polling when cancellation interrupts task submission', async () => {
    const controller = new AbortController();
    let submitSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      submitSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        submitSignal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const generation = generateApimartImagesBatch(
      'api-key',
      'https://api.example.com',
      'gpt-image',
      'prompt',
      '2K',
      '1:1',
      { width: 2048, height: 2048 },
      [],
      1,
      'node-1',
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    controller.abort();

    await expect(generation).rejects.toMatchObject({ name: 'AbortError' });
    expect(submitSignal?.aborted).toBe(true);
    expect(pollingMocks.cleanupNodePolling).toHaveBeenCalledWith('node-1');
    expect(pollingMocks.removePendingTask).toHaveBeenCalledWith('node-1');
  });
});

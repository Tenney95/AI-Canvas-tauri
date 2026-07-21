import { describe, expect, it, vi } from 'vitest';
import { generateApimartImagesBatch } from '../../src/services/ai/apimartGen';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('APIMart image polling', () => {
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
});

/** 首次等待和恢复查询共享火山只读状态协议，不触发生成提交。 */
import { beforeEach, expect, it, vi } from 'vitest';
const http = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: http }));
import { pollVolcengineVideoTask } from '../../src/services/ai/providers/volcengineVideoQuery';
import { PollTimeoutError } from '../../src/services/pollTask';
const options = { apiKey: 'test', baseUrl: 'https://example.com/api/v3', taskId: 'task-1', maxDuration: 10000 };
beforeEach(() => { http.mockReset(); });

it('成功解析视频和用量，只查询原任务', async () => {
  http.mockResolvedValue(new Response(JSON.stringify({ status: 'succeeded', content: { video_url: 'https://example.com/video.mp4' }, usage: { completion_tokens: 7 } })));
  const onFailed = vi.fn();
  await expect(pollVolcengineVideoTask({ ...options, onFailed })).resolves.toEqual({ url: 'https://example.com/video.mp4', completionTokens: 7 });
  expect(http).toHaveBeenCalledOnce();
  expect(http.mock.calls[0][0]).toBe('https://example.com/api/v3/contents/generations/tasks/task-1');
  expect(http.mock.calls[0][1].method).toBeUndefined();
  expect(onFailed).not.toHaveBeenCalled();
});

it.each(['failed', 'cancelled'])('远端 %s 回传终态给原有账本处理', async (status) => {
  http.mockResolvedValue(new Response(JSON.stringify({ status, error: { message: 'remote failure' } })));
  const onFailed = vi.fn();
  await expect(pollVolcengineVideoTask({ ...options, onFailed })).rejects.toThrow('任务失败: remote failure');
  expect(onFailed).toHaveBeenCalledWith(status);
});

it.each([408, 504])('HTTP %s 属于查询超时，不冒充远端失败或重投', async (status) => {
  http.mockResolvedValue(new Response('', { status }));
  const onFailed = vi.fn();
  await expect(pollVolcengineVideoTask({ ...options, onFailed })).rejects.toBeInstanceOf(PollTimeoutError);
  expect(onFailed).not.toHaveBeenCalled();
  expect(http).toHaveBeenCalledOnce();
});

it('缺少视频地址的成功响应仍拒绝交付', async () => {
  http.mockResolvedValue(new Response(JSON.stringify({ status: 'succeeded' })));
  await expect(pollVolcengineVideoTask({ ...options, onFailed: vi.fn() })).rejects.toThrow('未返回视频地址');
});

it('已取消的查询不发出网络请求', async () => {
  await expect(pollVolcengineVideoTask({ ...options, onFailed: vi.fn(), signal: AbortSignal.abort() })).rejects.toThrow();
  expect(http).not.toHaveBeenCalled();
});

it('鉴权失败立即结束查询，没有远端失败回调或自动重试', async () => {
  http.mockResolvedValue(new Response('', { status: 401 }));
  const onFailed = vi.fn();
  await expect(pollVolcengineVideoTask({ ...options, onFailed })).rejects.toThrow('HTTP 401');
  expect(http).toHaveBeenCalledOnce();
  expect(onFailed).not.toHaveBeenCalled();
});

it('缺少用量时保留 undefined，不伪造精确账单', async () => {
  http.mockResolvedValue(new Response(JSON.stringify({ status: 'succeeded', content: { video_url: 'https://example.com/video.mp4' } })));
  await expect(pollVolcengineVideoTask({ ...options, onFailed: vi.fn() })).resolves.toEqual({ url: 'https://example.com/video.mp4', completionTokens: undefined });
});

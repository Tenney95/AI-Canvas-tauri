/**
 * modelProtocolTestSession — 回归测试：protocol trial session recovery。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneralModelCategory } from '../../src/types';
import type { ModelExecutionProtocol, ResolvedModelProtocolPoll } from '../../src/types/aiTypes';
import { PollTaskFailedError, PollTimeoutError } from '../../src/services/pollTask';
import { ModelProtocolHttpError } from '../../src/services/ai/modelProtocolHttp';

const transport = vi.hoisted(() => ({ submit: vi.fn(), poll: vi.fn() }));
vi.mock('../../src/services/ai/modelProtocol', async (original) => ({
  ...await original<typeof import('../../src/services/ai/modelProtocol')>(),
  submitModelProtocol: (...args: unknown[]) => transport.submit(...args),
  pollResolvedModelProtocol: (...args: unknown[]) => transport.poll(...args),
}));

import {
  MAX_PROTOCOL_TEST_SESSIONS,
  discardProtocolTestSession,
  getProtocolTestSession,
  pauseProtocolTestSession,
  resumeProtocolTestSession,
  startProtocolTestSession,
  subscribeProtocolTestSession,
  type ProtocolTestSessionIdentity,
} from '../../src/services/ai/modelProtocolTestSession';

const poll: ResolvedModelProtocolPoll = {
  method: 'GET', url: 'https://gateway.example/v1/tasks/task-1', auth: { type: 'bearer' },
  statusPath: 'status', successValues: ['completed'], failureValues: ['failed'],
  resultUrlPath: 'url', intervalMs: 1000,
};
const protocol: ModelExecutionProtocol = {
  version: 2, mode: 'async', submit: { method: 'POST', path: '/videos' },
  response: { type: 'json', taskIdPath: 'id' },
  poll: { method: 'GET', path: '/tasks/{{submit.id}}', response: {
    statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], result: { urlPath: 'url' },
  } },
};
const identities: ProtocolTestSessionIdentity[] = [];
function identity(scopeId = 'custom-connection'): ProtocolTestSessionIdentity {
  const value = { scopeId, modelId: 'custom-video', baseUrl: 'https://gateway.example/v1' };
  identities.push(value);
  return value;
}
function start(target: ProtocolTestSessionIdentity, apiKey = 'private-key-old', category?: GeneralModelCategory) {
  return startProtocolTestSession({ identity: target, apiKey, category, protocol, variables: {
    model: target.modelId, prompt: 'private-submit-prompt', referenceVideoUrls: ['https://cdn.example/private.mp4'],
  } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  transport.submit.mockReset().mockResolvedValue({ taskId: 'task-1', poll });
  transport.poll.mockReset().mockResolvedValue({ urls: ['https://cdn.example/result.mp4'] });
});
afterEach(() => {
  identities.splice(0).forEach(discardProtocolTestSession);
});

describe('protocol trial session recovery', () => {
  it.each([
    ['polluted URL', 'this field is generated text', 'HTTP(S)'],
    ['wrong inline MIME', 'data:audio/wav;base64,UklGRg==', 'MIME'],
  ])('keeps the original category and task identity after a %s result', async (_label, url, errorText) => {
    const target = identity();
    transport.poll.mockResolvedValueOnce({ urls: [url] });
    await expect(start(target, 'private-key-old', 'video')).rejects.toThrow(errorText);
    expect(getProtocolTestSession(target)).toEqual({
      status: 'paused', category: 'video', taskId: 'task-1', canResume: true, pauseReason: 'query-error',
    });
    await expect(resumeProtocolTestSession({ identity: target, apiKey: 'private-key-new' }))
      .resolves.toEqual({ urls: ['https://cdn.example/result.mp4'], taskId: 'task-1' });
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(getProtocolTestSession(target)).toBeUndefined();
  });

  it('checks synchronous results against the submitted category before clearing the session', async () => {
    const target = identity();
    transport.submit.mockResolvedValueOnce({ text: 'a prompt rather than a video' });
    await expect(start(target, 'private-key-old', 'video')).rejects.toThrow('有效媒体结果地址');
    expect(getProtocolTestSession(target)).toMatchObject({ status: 'failed', category: 'video', canResume: false });
    expect(transport.poll).not.toHaveBeenCalled();
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });

  it('clears a synchronous session only after delivering a result matching its category', async () => {
    const target = identity();
    transport.submit.mockResolvedValueOnce({ text: 'generated text' });
    await expect(start(target, 'private-key-old', 'text')).resolves.toEqual({ text: 'generated text' });
    expect(getProtocolTestSession(target)).toBeUndefined();
    expect(transport.poll).not.toHaveBeenCalled();
  });

  it.each([new PollTimeoutError(), new TypeError('Failed to fetch')])('resumes the original task after %s with the current Key', async (error) => {
    const target = identity();
    transport.poll.mockRejectedValueOnce(error);
    await expect(start(target)).rejects.toBe(error);
    expect(getProtocolTestSession(target)).toEqual({
      status: 'paused', taskId: 'task-1', canResume: true, pauseReason: 'query-error',
    });
    expect(JSON.stringify(getProtocolTestSession(target))).not.toContain('private');
    const result = await resumeProtocolTestSession({ identity: target, apiKey: 'private-key-new' });
    expect(result).toEqual({ urls: ['https://cdn.example/result.mp4'], taskId: 'task-1' });
    expect(transport.submit).toHaveBeenCalledTimes(1);
    expect(transport.poll.mock.calls[1]).toEqual([
      poll, 'private-key-new', expect.any(AbortSignal), target.baseUrl, undefined, undefined, 'task-1',
    ]);
    expect(getProtocolTestSession(target)).toBeUndefined();
  });

  it('pauses a query without delivering a late result and keeps recovery after reopening', async () => {
    const target = identity();
    const response = deferred<{ urls: string[] }>();
    transport.poll.mockReturnValueOnce(response.promise);
    const running = start(target);
    await Promise.resolve();
    const unsubscribe = subscribeProtocolTestSession(target, vi.fn());
    unsubscribe();
    pauseProtocolTestSession(target);
    expect(transport.poll.mock.calls[0][2].aborted).toBe(true);
    expect(getProtocolTestSession(target)).toMatchObject({ status: 'paused', taskId: 'task-1', canResume: false });
    response.resolve({ urls: ['https://cdn.example/late.mp4'] });
    await expect(running).rejects.toMatchObject({ code: 'paused' });
    const reopened = { ...target, baseUrl: `${target.baseUrl}/` };
    expect(getProtocolTestSession(reopened)).toMatchObject({ status: 'paused', canResume: true });
    await expect(resumeProtocolTestSession({ identity: reopened, apiKey: 'private-key-new' }))
      .resolves.toMatchObject({ taskId: 'task-1' });
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });

  it('retains a task ID arriving after submission was paused', async () => {
    const target = identity();
    const response = deferred<{ taskId: string; poll: ResolvedModelProtocolPoll }>();
    transport.submit.mockReturnValueOnce(response.promise);
    const updates = vi.fn();
    const unsubscribe = subscribeProtocolTestSession(target, updates);
    const running = start(target);
    pauseProtocolTestSession(target);
    expect(getProtocolTestSession(target)).toMatchObject({ status: 'uncertain', canResume: false });
    response.resolve({ taskId: 'task-late', poll });
    await expect(running).rejects.toMatchObject({ code: 'paused' });
    expect(getProtocolTestSession(target)).toEqual({
      status: 'paused', taskId: 'task-late', canResume: true, pauseReason: 'user',
    });
    expect(updates).toHaveBeenLastCalledWith(getProtocolTestSession(target));
    expect(transport.poll).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('blocks a second submission when a cancelled submission has no task identity', async () => {
    const target = identity();
    const response = deferred<never>();
    transport.submit.mockReturnValueOnce(response.promise);
    const running = start(target);
    pauseProtocolTestSession(target);
    response.reject(new DOMException('The request was aborted', 'AbortError'));
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(getProtocolTestSession(target)).toMatchObject({ status: 'uncertain', canResume: false });
    await expect(start(target)).rejects.toMatchObject({ code: 'existing-session' });
    await expect(resumeProtocolTestSession({ identity: target, apiKey: 'private-key-new' }))
      .rejects.toMatchObject({ code: 'not-resumable' });
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });

  it('does not label a terminal upstream failure as a resumable pause', async () => {
    const target = identity();
    transport.poll.mockRejectedValueOnce(new PollTaskFailedError('模型任务失败：rejected'));
    await expect(start(target)).rejects.toBeInstanceOf(PollTaskFailedError);
    expect(getProtocolTestSession(target)).toMatchObject({ status: 'failed', taskId: 'task-1', canResume: false });
    await expect(resumeProtocolTestSession({ identity: target, apiKey: 'private-key-new' }))
      .rejects.toMatchObject({ code: 'not-resumable' });
  });

  it('binds recovery to connection scope, model and complete base URL', async () => {
    const target = identity();
    transport.poll.mockRejectedValueOnce(new PollTimeoutError());
    await expect(start(target)).rejects.toBeInstanceOf(PollTimeoutError);
    for (const unrelated of [
      { ...target, scopeId: 'other-connection' },
      { ...target, modelId: 'other-model' },
      { ...target, baseUrl: 'https://other-gateway.example/v1' },
      { ...target, baseUrl: 'https://gateway.example/v2' },
    ]) {
      expect(getProtocolTestSession(unrelated)).toBeUndefined();
      await expect(resumeProtocolTestSession({ identity: unrelated, apiKey: 'private-key-new' }))
        .rejects.toMatchObject({ code: 'not-resumable' });
    }
    expect(transport.poll).toHaveBeenCalledTimes(1);
  });

  it('checks query and binary download origins before using the current Key', async () => {
    for (const descriptor of [
      { ...poll, url: 'https://other-gateway.example/tasks/task-1' },
      { ...poll, resultDownload: { url: 'https://other-gateway.example/tasks/task-1/content' } },
    ]) {
      const target = identity(`origin-${identities.length}`);
      transport.submit.mockResolvedValueOnce({ taskId: 'task-1', poll: descriptor });
      await expect(start(target)).rejects.toMatchObject({ code: 'different-origin' });
      expect(getProtocolTestSession(target)).toMatchObject({ status: 'paused', canResume: true });
      await expect(resumeProtocolTestSession({ identity: target, apiKey: 'private-key-new' }))
        .rejects.toMatchObject({ code: 'different-origin' });
    }
    expect(transport.poll).not.toHaveBeenCalled();
  });

  it('redacts a Key echoed in an upstream error and exposes no request data in snapshots', async () => {
    const target = identity();
    transport.poll.mockRejectedValueOnce(new Error('Invalid credential private-key-old'));
    await expect(start(target)).rejects.toThrow('Invalid credential [REDACTED]');
    expect(getProtocolTestSession(target)).toEqual({
      status: 'paused', taskId: 'task-1', canResume: true, pauseReason: 'query-error',
    });
    expect(Object.keys(getProtocolTestSession(target)!).sort()).toEqual(['canResume', 'pauseReason', 'status', 'taskId']);
    expect(getProtocolTestSession(target)).toBe(getProtocolTestSession(target));
  });

  it('discards explicitly without restoring a late task descriptor', async () => {
    const target = identity();
    const response = deferred<{ taskId: string; poll: ResolvedModelProtocolPoll }>();
    transport.submit.mockReturnValueOnce(response.promise);
    const running = start(target);
    discardProtocolTestSession(target);
    response.resolve({ taskId: 'task-late', poll });
    await expect(running).rejects.toMatchObject({ code: 'paused' });
    expect(getProtocolTestSession(target)).toBeUndefined();
    expect(transport.poll).not.toHaveBeenCalled();
  });

  it('limits retained sessions without evicting unresolved tasks', async () => {
    transport.submit.mockRejectedValue(new ModelProtocolHttpError(400, '模型请求失败 (400)'));
    for (let index = 0; index < MAX_PROTOCOL_TEST_SESSIONS; index += 1) {
      await expect(start(identity(`bounded-${index}`))).rejects.toBeInstanceOf(ModelProtocolHttpError);
    }
    await expect(start(identity('over-capacity'))).rejects.toMatchObject({ code: 'session-limit' });
    expect(getProtocolTestSession(identities[0])).toMatchObject({ status: 'failed', canResume: false });
    expect(transport.submit).toHaveBeenCalledTimes(MAX_PROTOCOL_TEST_SESSIONS);
  });

  it('allows local reads and cleanup while the Base URL draft is incomplete', () => {
    const target = { ...identity(), baseUrl: 'not-a-url' };
    expect(getProtocolTestSession(target)).toBeUndefined();
    pauseProtocolTestSession(target);
    discardProtocolTestSession(target);
    const unsubscribe = subscribeProtocolTestSession(target, vi.fn());
    unsubscribe();
  });
});

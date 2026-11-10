import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedModelExecutionProtocol } from '../../src/types/aiTypes';
import { submitModelProtocol } from '../../src/services/ai/modelProtocol';
import { corsSafeFetch } from '../../src/services/ai/httpTransport';
import { captureNativeProtocolContext } from '../../src/services/nativeModelProtocolTask';
import { normalizeRelayonVideoSubmitResponse } from '../../src/services/ai/providers/relayonTaskIdentity';

vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: vi.fn() }));

const protocol: NormalizedModelExecutionProtocol = {
  version: 2, mode: 'async', auth: { type: 'bearer' },
  submit: { method: 'POST', path: '/videos', bodyEncoding: 'json', body: { model: 'minimax-h3', prompt: '{{prompt}}' } },
  response: { type: 'json', taskIdPath: 'id', errorPath: 'error.message' },
  poll: { method: 'GET', path: '/videos/{{submit.id}}',
    response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], result: { urlPath: 'url' } } },
};
const options = { protocol, apiKey: 'fixture-private-key', baseUrl: 'https://relay.example/v1', variables: { prompt: 'scene' } };
const respond = (payload: unknown) => vi.mocked(corsSafeFetch).mockResolvedValueOnce(new Response(JSON.stringify(payload), {
  status: 200, headers: { 'Content-Type': 'application/json' },
}));

beforeEach(() => { vi.mocked(corsSafeFetch).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('万象异步提交的原任务身份兼容', () => {
  it.each([
    { payload: { id: 'task-original' }, expected: 'task-original' },
    { payload: { task_id: 'task-original' }, expected: 'task-original' },
    { payload: { id: 'task-original', task_id: 'task-original' }, expected: 'task-original' },
    { payload: { id: '', task_id: 'task-original' }, expected: 'task-original' },
    { payload: { id: 'task-original', task_id: false }, expected: 'task-original' },
    { payload: { id: 42, task_id: '42' }, expected: '42' },
    { payload: { task_id: 0 }, expected: '0' },
  ])('有效原身份统一用于查询与耐久恢复 %#', async ({ payload, expected }) => {
    respond({ ...payload, token: 'unpersisted-token', prompt: 'unpersisted-body' });
    const result = await submitModelProtocol({ ...options, normalizeSubmitResponse: normalizeRelayonVideoSubmitResponse,
      captureRecoveryContext: (value) => captureNativeProtocolContext(protocol, value, {}, [options.apiKey]) });
    expect(result.taskId).toBe(expected);
    expect(result.poll?.url).toBe(`${options.baseUrl}/videos/${expected}`);
    expect(result.recoveryContext).toEqual({ submit: { id: expected } });
    expect(corsSafeFetch).toHaveBeenCalledOnce();
  });

  it('两个有效但冲突的身份保持未知，不挑选一个或再次提交', async () => {
    respond({ id: 'first-identity', task_id: 'another-identity' });
    const error = await submitModelProtocol({ ...options, normalizeSubmitResponse: normalizeRelayonVideoSubmitResponse })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: '万象提交响应中的任务身份不一致，原提交已保留，未重新提交生成' });
    expect(error).not.toHaveProperty('nativeTaskId');
    expect(corsSafeFetch).toHaveBeenCalledOnce();
  });

  it.each([null, [], {}, { id: '' }, { task_id: '  ' }, { id: false, task_id: {} }].map((payload) => ({ payload })))(
    '无有效身份时沿用未确认提交错误 %#', async ({ payload }) => {
      respond(payload);
      await expect(submitModelProtocol({ ...options, normalizeSubmitResponse: normalizeRelayonVideoSubmitResponse }))
        .rejects.toThrow('未找到任务 ID');
      expect(corsSafeFetch).toHaveBeenCalledOnce();
    },
  );

  it.each([NaN, Infinity, -Infinity, false, {}, []].map((value) => ({ value })))('非法标量不升级为有效任务 ID %#', ({ value }) => {
    const payload = { task_id: value };
    expect(normalizeRelayonVideoSubmitResponse(payload)).toBe(payload);
  });

  it('未设置回调的其它协议仍只读取声明路径，不隐式猜测 task_id', async () => {
    respond({ task_id: 'unconfigured-alias' });
    await expect(submitModelProtocol(options)).rejects.toThrow('未找到任务 ID：id');
    respond({ id: 'declared-identity' });
    expect(await submitModelProtocol(options)).toMatchObject({ taskId: 'declared-identity' });
    expect(corsSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('同步结果不运行仅用于异步任务身份的回调', async () => {
    const normalize = vi.fn(normalizeRelayonVideoSubmitResponse);
    respond({ url: 'https://cdn.example/result.mp4' });
    const synchronous: NormalizedModelExecutionProtocol = { version: 2, mode: 'sync', auth: protocol.auth,
      submit: protocol.submit, response: { type: 'json', result: { urlPath: 'url' } } };
    expect(await submitModelProtocol({ ...options, protocol: synchronous, normalizeSubmitResponse: normalize }))
      .toEqual({ urls: ['https://cdn.example/result.mp4'] });
    expect(normalize).not.toHaveBeenCalled();
  });

  it('业务校验先检查原响应，失败后不运行身份规范化', async () => {
    const payload = { task_id: 'task-original', code: 17 };
    const normalize = vi.fn(normalizeRelayonVideoSubmitResponse);
    respond(payload);
    await expect(submitModelProtocol({ ...options, normalizeSubmitResponse: normalize,
      validateResponse: (value) => { expect(value).toEqual(payload); throw new Error('provider rejected'); } }))
      .rejects.toThrow('provider rejected');
    expect(normalize).not.toHaveBeenCalled();
    expect(corsSafeFetch).toHaveBeenCalledOnce();
  });

  it('规范化后的安全原 ID 在恢复投影失败时仍保留，异常不带 Key', async () => {
    respond({ task_id: 'accepted-original' });
    const error = await submitModelProtocol({ ...options, normalizeSubmitResponse: normalizeRelayonVideoSubmitResponse,
      captureRecoveryContext: () => { throw new Error(`unsafe ${options.apiKey}`); } })
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ nativeTaskId: 'accepted-original' });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(String((error as Error).cause)).not.toContain(options.apiKey);
    expect(corsSafeFetch).toHaveBeenCalledOnce();
  });

  it('规范化器异常先脱敏，不保留回调抛出的含密钥正文', async () => {
    respond({ task_id: 'task-original' });
    const error = await submitModelProtocol({ ...options,
      normalizeSubmitResponse: () => { throw new Error(`normalization ${options.apiKey}`); } })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(options.apiKey);
    expect(corsSafeFetch).toHaveBeenCalledOnce();
  });

  it.each(['fixture-private-key', 'https://untrusted.example/task', 'C:/private/path'])(
    '规范化别名也不能把凭据或地址作为原生恢复 ID %#', async (id) => {
      respond({ task_id: id });
      const error = await submitModelProtocol({ ...options, normalizeSubmitResponse: normalizeRelayonVideoSubmitResponse,
        captureRecoveryContext: () => { throw new Error('unsafe context'); } })
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty('nativeTaskId');
      expect(corsSafeFetch).toHaveBeenCalledOnce();
    },
  );
});

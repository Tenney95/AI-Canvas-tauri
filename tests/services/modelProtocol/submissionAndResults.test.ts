import { describe, expect, it, vi } from 'vitest';
import type { ModelExecutionProtocol, NormalizedModelExecutionProtocol, ProtocolJsonValue } from '../../../src/types/aiTypes';
import {
  buildModelProtocolRequest,
  executeModelProtocol,
  parseModelExecutionProtocol,
  pollResolvedModelProtocol,
  submitModelProtocol,
} from '../../../src/services/ai/modelProtocol';
import { runConfiguredModelProtocol } from '../../../src/services/ai/modelProtocolRuntime';
import { useAppStore } from '../../../src/store/useAppStore';
import {
  fetchSameOriginResultUrls,
  ModelProtocolHttpError,
  pcmS16LeToWav,
  readBinaryModelProtocolResult,
  readJsonResponse,
  redactModelProtocolError,
} from '../../../src/services/ai/modelProtocolHttp';
import { PollTaskFailedError, PollTimeoutError } from '../../../src/services/pollTask';
import {
  getPendingTasksForProject,
  MediaTaskPausedError,
  resumePendingTasks,
  savePendingTask,
} from '../../../src/services/pollManager';
import {
  RELAYON_MODEL_MANIFEST,
  RELAYON_VIDEO_RESULT_URL_PATHS,
  getRelayonVideoRecoveryProfiles,
} from '../../../src/services/ai/providers/relayonModelManifest';
import { getHttpResponseError, HttpResponseError } from '../../../src/services/ai/httpUtils';
import * as httpTransport from '../../../src/services/ai/httpTransport';
import { jsonResponse, setupProtocolFixture } from './protocolFixture';

setupProtocolFixture();

const pngResult = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vYkAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));

const wavResult = Uint8Array.from(pcmS16LeToWav(new Uint8Array([0, 0]), 24000, 1));

const encodedResult = (bytes: Uint8Array, mime: string) => `data:${mime};base64,${btoa(String.fromCharCode(...bytes))}`;

describe('声明式协议的请求响应调试关联', () => {
  it.each([200, 400])('HTTP %s 在既有消费点记录原JSON且只读取一次，不clone响应', async (status) => {
    const payload = status === 200 ? { data: [{ url: 'https://cdn.example/original.png' }], usage: { input_tokens: 7 } }
      : { error: { code: 'source_fetch_failed', message: '参考素材无法读取' } };
    const response = jsonResponse(payload, status);
    const json = vi.spyOn(response, 'json'); const text = vi.spyOn(response, 'text');
    const clone = vi.spyOn(response, 'clone').mockImplementation(() => { throw new Error('调试日志不能克隆响应'); });
    const log = vi.spyOn(httpTransport, 'logAiResponse').mockImplementation(() => undefined);
    const debug = { url: 'https://gateway.example/v1/images/edits', method: 'POST', source: 'Model Protocol',
      traceId: 'read-response-fixture', apiKey: 'fixture-response-key', sensitive: false };
    try {
      const pending = readJsonResponse(response, '模型请求失败', 'error.message', debug.apiKey, debug);
      if (status === 200) await expect(pending).resolves.toEqual(payload);
      else await expect(pending).rejects.toMatchObject({ status: 400, message: expect.stringContaining('参考素材无法读取') });
      expect(log).toHaveBeenCalledExactlyOnceWith(response, payload, debug);
      expect(text).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled();
      expect(clone).not.toHaveBeenCalled(); expect(response.bodyUsed).toBe(true);
    } finally { log.mockRestore(); clone.mockRestore(); text.mockRestore(); json.mockRestore(); }
  });

  it.each(['<!doctype html><html>upstream gateway returned HTML</html>', '{"unfinished":'])(
    'HTTP200非JSON原文进入调试日志且保留原结构错误：%s', async (rawText) => {
      const response = new Response(rawText, { headers: { 'Content-Type': 'text/html' } });
      const text = vi.spyOn(response, 'text'); const json = vi.spyOn(response, 'json'); const clone = vi.spyOn(response, 'clone');
      const log = vi.spyOn(httpTransport, 'logAiResponse').mockImplementation(() => undefined);
      const debug = { url: 'https://gateway.example/v1/images/edits', method: 'POST', source: 'Model Protocol', traceId: 'invalid-json-fixture' };
      try {
        await expect(readJsonResponse(response, '模型请求失败', undefined, '', debug))
          .rejects.toThrow('模型请求失败：响应必须是 JSON 对象或数组');
        expect(log).toHaveBeenCalledExactlyOnceWith(response, rawText, debug);
        expect(text).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled(); expect(clone).not.toHaveBeenCalled();
        expect(response.bodyUsed).toBe(true);
      } finally { log.mockRestore(); clone.mockRestore(); json.mockRestore(); text.mockRestore(); }
    },
  );

  it('HTTP200业务失败在验证器抛错前记录完整原始返回，不进行第二次请求', async () => {
    const payload = { status: 'failed', error: { code: 'upstream_failed', message: '上游业务拒绝' }, usage: { output_tokens: 0 } };
    const response = jsonResponse(payload);
    const fetchMock = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(httpTransport, 'logAiResponse').mockImplementation(() => undefined);
    const validateResponse = vi.fn(() => {
      expect(log).toHaveBeenCalledWith(response, payload, expect.objectContaining({ source: 'Model Protocol' }));
      throw new Error('保留原业务失败');
    });
    try {
      await expect(submitModelProtocol({ apiKey: 'business-key-fixture', baseUrl: 'https://gateway.example/v1', variables: {},
        protocol: { version: 2, mode: 'sync', submit: { method: 'POST', path: '/render', body: { model: 'image-fixture' } },
          response: { type: 'json', result: { urlPath: 'url' } } }, validateResponse })).rejects.toThrow('保留原业务失败');
      expect(validateResponse).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });

  it('文本提交分支沿原读取记录返回文本，不clone或再次请求', async () => {
    const text = 'model-text-output-fixture';
    const response = new Response(text, { headers: { 'Content-Type': 'text/plain' } });
    const fetchMock = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch', fetchMock);
    const read = vi.spyOn(response, 'text'); const clone = vi.spyOn(response, 'clone');
    const log = vi.spyOn(httpTransport, 'logAiResponse').mockImplementation(() => undefined);
    try {
      await expect(submitModelProtocol({ apiKey: 'text-key-fixture', baseUrl: 'https://gateway.example/v1', variables: {},
        protocol: { version: 2, mode: 'sync', submit: { method: 'POST', path: '/text', body: { model: 'text-fixture' } },
          response: { type: 'text' } } })).resolves.toEqual({ text });
      expect(log).toHaveBeenCalledExactlyOnceWith(response, text, expect.objectContaining({
        url: 'https://gateway.example/v1/text', method: 'POST', source: 'Model Protocol',
        apiKey: 'text-key-fixture', traceId: expect.any(String),
      }));
      expect(read).toHaveBeenCalledOnce(); expect(clone).not.toHaveBeenCalled();
      expect(response.bodyUsed).toBe(true); expect(fetchMock).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); clone.mockRestore(); read.mockRestore(); }
  });

  it('二进制提交分支只记录安全摘要，原结果和单次流读取保持不变', async () => {
    const response = new Response(pngResult, { headers: { 'Content-Type': 'image/png' } });
    const fetchMock = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch', fetchMock);
    const read = vi.spyOn(response.body!, 'getReader'); const clone = vi.spyOn(response, 'clone');
    const log = vi.spyOn(httpTransport, 'logAiResponse').mockImplementation(() => undefined);
    const url = encodedResult(pngResult, 'image/png');
    try {
      await expect(submitModelProtocol({ apiKey: 'binary-key-fixture', baseUrl: 'https://gateway.example/v1', variables: {},
        protocol: { version: 2, mode: 'sync', submit: { method: 'POST', path: '/binary', body: { model: 'image-fixture' } },
          response: { type: 'binary', result: { mimeType: 'image/png' } } } })).resolves.toEqual({ urls: [url] });
      expect(log).toHaveBeenCalledExactlyOnceWith(response, { type: 'binary', mimeType: 'image/png', encodedLength: url.length },
        expect.objectContaining({ url: 'https://gateway.example/v1/binary', method: 'POST', source: 'Model Protocol',
          apiKey: 'binary-key-fixture', traceId: expect.any(String) }));
      expect(JSON.stringify(log.mock.calls.map((call) => call[1]))).not.toContain(url);
      expect(read).toHaveBeenCalledOnce(); expect(clone).not.toHaveBeenCalled();
      expect(response.bodyUsed).toBe(true); expect(fetchMock).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); clone.mockRestore(); read.mockRestore(); }
  });

  it.each([false, true])('每次轮询关联自己的请求响应，保留POST标量及隐私标记：sensitive=%s', async (sensitive) => {
    const payloads = [{ status: 'running', progress: 25 }, { status: 'completed', url: 'https://cdn.example/query-result.mp4' }];
    const responses = payloads.map((payload) => jsonResponse(payload));
    const fetchMock = vi.fn().mockResolvedValueOnce(responses[0]).mockResolvedValueOnce(responses[1]);
    vi.stubGlobal('fetch', fetchMock);
    const transport = vi.spyOn(httpTransport, 'corsSafeFetch');
    const log = vi.spyOn(httpTransport, 'logAiResponse').mockImplementation(() => undefined);
    const body = { task_id: 'existing-task', transparent: false, frame_count: 9 };
    try {
      await expect(pollResolvedModelProtocol({ method: 'POST', url: 'https://gateway.example/v1/tasks/query',
        bodyEncoding: 'json', body, statusPath: 'status', successValues: ['completed'], failureValues: ['failed'],
        resultUrlPath: 'url', intervalMs: 1, maxAttempts: 2, retry: { maxRetries: 0 }, sensitive,
      }, 'poll-key-fixture', undefined, 'https://gateway.example/v1')).resolves.toMatchObject({ urls: [payloads[1].url] });
      expect(fetchMock).toHaveBeenCalledTimes(2); expect(log).toHaveBeenCalledTimes(2);
      const traces = transport.mock.calls.map(([, , options]) => options?.debug?.traceId);
      if (!sensitive) {
        expect(traces.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
        expect(new Set(traces).size).toBe(2);
      } else expect(traces).toEqual([undefined, undefined]);
      for (const [index, call] of transport.mock.calls.entries()) {
        expect(call[2]?.sensitive === true).toBe(sensitive);
        if (!sensitive) expect(call[2]?.debug).toMatchObject({ body, bodyEncoding: 'json', traceId: traces[index], stage: 'poll', apiKey: 'poll-key-fixture' });
        else expect(call[2]).toEqual({ sensitive: true });
        expect(JSON.parse(String(call[1]?.body))).toEqual(body);
        expect(log.mock.calls[index]).toEqual([responses[index], payloads[index], {
          url: 'https://gateway.example/v1/tasks/query', method: 'POST', source: 'Model Protocol',
          traceId: traces[index], apiKey: 'poll-key-fixture', sensitive,
        }]);
      }
    } finally { log.mockRestore(); transport.mockRestore(); }
  });

  it('缺少crypto.randomUUID时日志标识使用后备值，不阻断原轮询', async () => {
    vi.stubGlobal('crypto', {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'completed', url: 'https://cdn.example/fallback.mp4' })));
    const transport = vi.spyOn(httpTransport, 'corsSafeFetch');
    const log = vi.spyOn(httpTransport, 'logAiResponse').mockImplementation(() => undefined);
    try {
      await expect(pollResolvedModelProtocol({ method: 'GET', url: 'https://gateway.example/v1/tasks/original',
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url',
        intervalMs: 1,
      }, 'fallback-key', undefined, 'https://gateway.example/v1')).resolves.toMatchObject({ urls: ['https://cdn.example/fallback.mp4'] });
      expect(transport).toHaveBeenCalledOnce();
      expect(transport.mock.calls[0][2]?.debug).toMatchObject({ traceId: expect.stringMatching(/^ai-/), stage: 'poll' });
    } finally { log.mockRestore(); transport.mockRestore(); }
  });

  it.each([false, true])('同源结果下载失败把敏感标记交给响应日志，保留错误语义：sensitive=%s', async (sensitive) => {
    const payload = { error: { message: 'download-key-fixture refused result' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload, 403)));
    const log = vi.spyOn(httpTransport, 'logAiResponse').mockImplementation(() => undefined);
    try {
      await expect(fetchSameOriginResultUrls(['https://gateway.example/content/original'], 'https://gateway.example/v1',
        undefined, 'download-key-fixture', 'image/png', undefined, undefined, sensitive))
        .rejects.toMatchObject({ status: 403, message: expect.stringContaining('[REDACTED]') });
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0][1]).toEqual(payload);
      expect(log.mock.calls[0][2]).toEqual({ url: 'https://gateway.example/content/original', method: 'GET',
        source: 'Model Protocol', apiKey: 'download-key-fixture', sensitive });
    } finally { log.mockRestore(); }
  });
});

describe('火山声明式协议的 TOS 隐私边界', () => {
  const signed = 'https://reference-bucket.tos-cn-beijing.ivolces.com/ai-canvas/ark-reference/input.png?X-Tos-Signature=private-fixture-signature';
  const asyncProtocol = (): NormalizedModelExecutionProtocol => ({ version: 2, mode: 'async',
    submit: { method: 'POST', path: '/generate', body: { image: '{{imageUrls}}' } },
    response: { type: 'json', taskIdPath: 'id' }, poll: { method: 'GET', path: '/tasks/{{submit.id}}',
      retry: { maxRetries: 0 }, response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed'],
        errorPath: 'error.message', result: { urlPath: 'url' } } } });
  const configure = (connectionId = 'ark-protocol', catalogId = 'volcengine') => {
    const previous = useAppStore.getState(); localStorage.clear();
    useAppStore.setState({ currentProjectId: 'ark-protocol-project', projectExecutionContext: undefined, nodes: [],
      config: { ...previous.config, providers: { ...previous.config.providers, [connectionId]: {
        name: 'Protocol fixture', catalogId, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'private-ark-key',
      } } } });
    return () => { localStorage.clear(); useAppStore.setState(previous, true); };
  };
  const model = (protocol: ModelExecutionProtocol, providerConfigId = 'ark-protocol') => ({
    id: 'ark-model', name: 'Ark fixture', modelId: 'ark-image', category: 'image' as const, providerConfigId,
    executionProfile: { preset: 'custom' as const, protocol },
  });

  it.each([true, false])('按真实catalog开启敏感传输，custom同名连接保持原行为：official=%s', async (official) => {
    const restore = configure('volcengine', official ? 'volcengine' : 'custom-openai');
    const transport = vi.spyOn(httpTransport, 'corsSafeFetch');
    const protocol: ModelExecutionProtocol = { version: 2, mode: 'sync', submit: asyncProtocol().submit,
      response: { type: 'json', result: { urlPath: 'url' } } };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ url: 'https://cdn.example/result.png' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await runConfiguredModelProtocol({ category: 'image', model: model(protocol, 'volcengine'), variables: { imageUrls: [signed] } });
      expect(transport).toHaveBeenCalledOnce();
      expect(transport.mock.calls[0][2]?.sensitive === true).toBe(official);
      if (!official) expect(transport.mock.calls[0][2]?.debug).toMatchObject({ stage: 'submit', bodyEncoding: 'json',
        body: { image: [signed] }, traceId: expect.any(String) });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).image).toEqual([signed]);
    } finally { transport.mockRestore(); restore(); }
  });

  it('已提交火山查询中断时保留ID与敏感标记，恢复查询错误也在出口脱敏', async () => {
    const restore = configure(); const transport = vi.spyOn(httpTransport, 'corsSafeFetch');
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'accepted-ark-task' }))
      .mockRejectedValueOnce(new TypeError(`network error ${signed}`));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(runConfiguredModelProtocol({ category: 'image', nodeId: 'ark-node', model: model(asyncProtocol()),
        variables: { imageUrls: [signed] } })).rejects.toMatchObject({ name: 'MediaTaskPausedError',
        taskReceipt: { taskId: 'accepted-ark-task' } });
      const saved = getPendingTasksForProject('ark-protocol-project')[0];
      expect(saved).toMatchObject({ taskId: 'accepted-ark-task', submitted: true, protocolPoll: { sensitive: true } });
      expect(JSON.stringify(saved)).not.toContain('X-Tos-');
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'failed', error: { message: `下载失败 ${signed}` } }));
      const error = await pollResolvedModelProtocol(saved.protocolPoll!, 'private-ark-key', undefined,
        'https://ark.cn-beijing.volces.com/api/v3').catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(PollTaskFailedError);
      expect((error as Error).message).toContain('[REDACTED]');
      expect((error as Error).stack).not.toContain('X-Tos-');
      expect(transport.mock.calls.every((call) => call[2]?.sensitive === true)).toBe(true);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    } finally { transport.mockRestore(); restore(); }
  });

  it.each(['variable', 'literal'] as const)('提交前拒绝会将签名素材写入持久化轮询的%s模板', async (source) => {
    const restore = configure(); const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const protocol = asyncProtocol();
    protocol.poll = { ...protocol.poll!, method: 'POST', body: { source: source === 'variable' ? '{{imageUrls}}' : signed } };
    try {
      await expect(runConfiguredModelProtocol({ category: 'image', nodeId: 'ark-node', model: model(protocol),
        variables: { imageUrls: [signed] } })).rejects.toThrow('轮询描述不能保存 TOS 签名');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getPendingTasksForProject('ark-protocol-project')).toEqual([]);
    } finally { restore(); }
  });

  it('响应回显签名素材时仅保留已付费任务ID，不落盘轮询输入或重新提交', async () => {
    const restore = configure(); const protocol = asyncProtocol();
    protocol.poll!.headers = { 'X-Reference': '{{submit.reference}}' };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'known-ark-task', reference: signed }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(runConfiguredModelProtocol({ category: 'image', nodeId: 'ark-node', model: model(protocol),
        variables: { imageUrls: [signed] } })).rejects.toMatchObject({ name: 'MediaTaskPausedError',
        taskReceipt: { taskId: 'known-ark-task' } });
      const saved = getPendingTasksForProject('ark-protocol-project')[0];
      expect(saved).toMatchObject({ submitted: true, taskId: 'known-ark-task', mediaRecoveryState: 'query_paused' });
      expect(saved.protocolPoll).toBeUndefined();
      expect(JSON.stringify(saved)).not.toContain('X-Tos-');
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { restore(); }
  });

  it('敏感的异步文本协议把隐私标记传至提交、轮询和同源结果下载', async () => {
    const protocol = asyncProtocol();
    protocol.poll!.response.result = { mimeType: 'image/png', download: { method: 'GET', path: '/tasks/{{submit.id}}/content' } };
    const transport = vi.spyOn(httpTransport, 'corsSafeFetch');
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'private-task' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed' }))
      .mockResolvedValueOnce(new Response(pngResult, { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await executeModelProtocol({ apiKey: 'private-key', baseUrl: 'https://gateway.example/v1', protocol,
        variables: { imageUrls: [signed] }, sensitive: true });
      expect(result.urls).toEqual([encodedResult(pngResult, 'image/png')]);
      expect(transport).toHaveBeenCalledTimes(3);
      expect(transport.mock.calls.every((call) => call[2]?.sensitive === true)).toBe(true);
    } finally { transport.mockRestore(); }
  });
});

describe('structured submission failures', () => {
  const protocol: ModelExecutionProtocol = { version: 2, mode: 'async',
    submit: { method: 'POST', path: '/images', body: { prompt: '{{prompt}}' } },
    response: { type: 'json', taskIdPath: 'id', errorPath: 'error.message' },
    poll: { method: 'GET', path: '/tasks/{{submit.id}}', retry: { maxRetries: 0 },
      response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], result: { urlPath: 'url' } } } };

  it('新项目同步与异步声明式媒体缺少宿主提交守卫时拒绝，不创建旧待续回执', async () => {
    const previous = useAppStore.getState();
    localStorage.clear();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    useAppStore.setState({ currentProjectId: 'new-canvas', projectExecutionContext: { kind: 'canvas', schemaVersion: 2,
      modelGeneration: 1, projectId: 'p', projectEpoch: 1, canvasId: 'new-canvas', canvasEpoch: 1,
      canvasRevision: 0, episodeId: null, runtimeEpoch: 'run' },
      config: { ...previous.config, providers: { ...previous.config.providers,
        'structured-submit': { name: 'Fixture', baseUrl: 'https://gateway.example/v1', apiKey: 'fixture' } } } });
    try {
      await expect(runConfiguredModelProtocol({ category: 'image', nodeId: 'new-node',
        model: { id: 'structured', name: 'Fixture', modelId: 'fixture', category: 'image', providerConfigId: 'structured-submit',
          executionProfile: { preset: 'custom', protocol } }, variables: { prompt: 'scene' } })).rejects.toThrow('未提交请求');
      const synchronous: ModelExecutionProtocol = { version: 2, mode: 'sync', submit: protocol.submit,
        response: { type: 'json', result: { urlPath: 'url' } } };
      await expect(runConfiguredModelProtocol({ category: 'image', nodeId: 'new-node',
        model: { id: 'structured', name: 'Fixture', modelId: 'fixture', category: 'image', providerConfigId: 'structured-submit',
          executionProfile: { preset: 'custom', protocol: synchronous } }, variables: { prompt: 'scene' } })).rejects.toThrow('未提交请求');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getPendingTasksForProject('new-canvas')).toEqual([]);
    } finally { localStorage.clear(); useAppStore.setState(previous, true); }
  });

  async function configuredRequest(response: Response | Error, queryResponse?: Response) {
    const previous = useAppStore.getState();
    localStorage.clear();
    useAppStore.setState({ currentProjectId: 'structured-submit-project', nodes: [],
      config: { ...previous.config, providers: { ...previous.config.providers,
        'structured-submit': { name: 'Fixture', baseUrl: 'https://gateway.example/v1', apiKey: 'private-fixture-key' } } } });
    const fetchMock = response instanceof Error ? vi.fn().mockRejectedValueOnce(response) : vi.fn().mockResolvedValueOnce(response);
    if (queryResponse) fetchMock.mockResolvedValueOnce(queryResponse);
    vi.stubGlobal('fetch', fetchMock);
    try {
      const error = await runConfiguredModelProtocol({ category: 'image', nodeId: 'structured-node',
        model: { id: 'structured', name: 'Fixture', modelId: 'fixture', category: 'image', providerConfigId: 'structured-submit',
          executionProfile: { preset: 'custom', protocol } }, variables: { prompt: 'scene' } }).catch((reason: unknown) => reason);
      return { error, tasks: getPendingTasksForProject('structured-submit-project'), fetchMock };
    } finally {
      localStorage.clear();
      useAppStore.setState(previous, true);
    }
  }

  it.each([
    { status: 200, payload: { error: { code: 'rate_limit_exceeded', message: 'Request rejected' } } },
    { status: 429, payload: { error: { code: 'rate_limit_exceeded', message: 'Request rejected' } } },
    { status: 500, payload: { error: { code: 'insufficient_quota', message: 'Request rejected' } } },
    { status: 200, payload: { status: 'failed', error: { message: 'Generation failed' } } },
  ])('removes only a confirmed rejection before a task ID was accepted (HTTP $status)', async ({ status, payload }) => {
    const { error, tasks, fetchMock } = await configuredRequest(jsonResponse(payload, status));
    expect(error).toBeInstanceOf(ModelProtocolHttpError);
    expect(error).toMatchObject({ status, definitiveFailure: true });
    expect(tasks).toEqual([]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://gateway.example/v1/images', expect.objectContaining({ method: 'POST' }));
  });

  it.each([
    jsonResponse({ status: 'failed', error: { code: 'rate_limit_exceeded', message: 'Gateway timeout' } }, 504),
    jsonResponse({ error: { code: 'upstream_error', message: 'Upstream unavailable' } }, 500),
    jsonResponse({ message: 'rate_limit_exceeded' }, 429),
    new TypeError('connection interrupted'),
  ])('retains uncertain submissions without an automatic retry %#', async (response) => {
    const { error, tasks, fetchMock } = await configuredRequest(response);
    expect(error).toBeInstanceOf(MediaTaskPausedError);
    expect(tasks).toEqual([expect.objectContaining({ submitted: false, taskId: '', mediaRecoveryState: 'submit_unknown' })]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('preserves an accepted task when a later query receives a definitive HTTP rejection', async () => {
    const { error, tasks, fetchMock } = await configuredRequest(jsonResponse({ id: 'accepted-original' }),
      jsonResponse({ error: { code: 'invalid_api_key', message: 'Query denied' } }, 401));
    expect(error).toBeInstanceOf(MediaTaskPausedError);
    expect(tasks).toEqual([expect.objectContaining({ submitted: true, taskId: 'accepted-original', mediaRecoveryState: 'query_paused' })]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
  });

  it('accepts usable results and IDs without treating an empty errorPath as a failure', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'accepted', error: { message: '' } }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }], error: false, status: 'completed' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await submitModelProtocol({ protocol, apiKey: 'fixture', baseUrl: 'https://gateway.example/v1', variables: {} }))
      .toMatchObject({ taskId: 'accepted' });
    const sync: ModelExecutionProtocol = { version: 2, mode: 'sync', submit: protocol.submit,
      response: { type: 'json', errorPath: 'error', result: { urlPath: 'data.*.url' } } };
    expect(await submitModelProtocol({ protocol: sync, apiKey: 'fixture', baseUrl: 'https://gateway.example/v1', variables: {} }))
      .toEqual({ urls: ['https://cdn.example/result.png'] });
  });

  it('保留已经收到的原任务 ID，即使恢复投影被安全校验拒绝也不重新提交', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'accepted-original', token: 'private-query-value' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(submitModelProtocol({ protocol, apiKey: 'fixture', baseUrl: 'https://gateway.example/v1', variables: {},
      captureRecoveryContext: () => { throw new Error('不可持久化凭据'); } })).rejects.toMatchObject({ nativeTaskId: 'accepted-original' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('恢复投影错误的 ID fallback 不保存服务商回显的 Key 或地址', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    for (const id of ['private-credential', 'https://untrusted.invalid/id', 'C:/private/path']) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id }));
      const error = await submitModelProtocol({ protocol, apiKey: 'private-credential', baseUrl: 'https://gateway.example/v1', variables: {},
        captureRecoveryContext: () => { throw new Error('unsafe context'); } }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error); expect(error).not.toHaveProperty('nativeTaskId');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not infer failure from a numeric provider code or override a usable result with unrelated error metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ code: 500, id: 'accepted-original',
      error: { code: 'rate_limit_exceeded' } }))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', data: [{ url: 'https://cdn.example/result.png' }], error: { code: 'invalid_request' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 500, message: 'Private numeric codes require a provider contract' }));
    vi.stubGlobal('fetch', fetchMock);
    const options = { apiKey: 'fixture', baseUrl: 'https://gateway.example/v1', variables: {} };
    expect(await submitModelProtocol({ ...options, protocol })).toMatchObject({ taskId: 'accepted-original' });
    const sync: ModelExecutionProtocol = { version: 2, mode: 'sync', submit: protocol.submit,
      response: { type: 'json', result: { urlPath: 'data.*.url' }, errorPath: 'error.message' } };
    expect(await submitModelProtocol({ ...options, protocol: sync })).toEqual({ urls: ['https://cdn.example/result.png'] });
    const unknown = await submitModelProtocol({ ...options, protocol }).catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(Error);
    expect(getHttpResponseError(unknown)).toBeUndefined();
  });

  it.each(['submit-rejected', 'task-failed'] as const)('clears only the original failed receipt after a project switch: %s', async (phase) => {
    const previous = useAppStore.getState();
    localStorage.clear();
    useAppStore.setState({ currentProjectId: 'original-project', nodes: [], config: { ...previous.config,
      providers: { ...previous.config.providers, 'original-connection': { name: 'Fixture', apiKey: 'fixture', baseUrl: 'https://gateway.example/v1' } } } });
    let finish!: (response: Response) => void;
    const heldResponse = new Promise<Response>((resolve) => { finish = resolve; });
    const fetchMock = phase === 'submit-rejected' ? vi.fn().mockReturnValueOnce(heldResponse)
      : vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'accepted-original' })).mockReturnValueOnce(heldResponse);
    vi.stubGlobal('fetch', fetchMock);
    try {
      const pending = runConfiguredModelProtocol({ category: 'image', nodeId: 'same-node',
        model: { id: 'fixture', name: 'Fixture', modelId: 'fixture', category: 'image', providerConfigId: 'original-connection',
          executionProfile: { preset: 'custom', protocol } }, variables: {} }).catch((error: unknown) => error);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(phase === 'submit-rejected' ? 1 : 2));
      useAppStore.setState({ currentProjectId: 'new-project' });
      const otherReceipt = savePendingTask({ nodeId: 'same-node', projectId: 'new-project', nodeType: 'ai-image',
        provider: 'general', providerConfigId: 'original-connection', taskType: 'custom-protocol', taskId: 'unrelated-new-task', submitted: true });
      finish(jsonResponse(phase === 'submit-rejected' ? { error: { code: 'rate_limit_exceeded', message: 'Rejected' } }
        : { status: 'failed', error: { message: 'Task failed' } }));
      expect(await pending).toBeInstanceOf(phase === 'submit-rejected' ? ModelProtocolHttpError : PollTaskFailedError);
      expect(getPendingTasksForProject('original-project')).toEqual([expect.objectContaining({ terminalFailure: true })]);
      expect(getPendingTasksForProject('new-project')).toEqual([expect.objectContaining(otherReceipt)]);
      useAppStore.setState({ currentProjectId: 'original-project', nodes: [{ id: 'same-node', type: 'ai-image',
        position: { x: 0, y: 0 }, data: { type: 'ai-image', label: 'Original', status: 'loading' } }] });
      await resumePendingTasks('original-project');
      expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'error', mediaTaskState: undefined });
      expect(getPendingTasksForProject('original-project')).toEqual([]);
      expect(getPendingTasksForProject('new-project')).toEqual([expect.objectContaining(otherReceipt)]);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    } finally {
      localStorage.clear();
      useAppStore.setState(previous, true);
    }
  });

  it('keeps safe HTTP failure metadata when redacting direct or wrapped errors', () => {
    const direct = new ModelProtocolHttpError(429, 'Rejected private-fixture-key', 2500, true);
    expect(redactModelProtocolError(direct, 'private-fixture-key')).toMatchObject({ status: 429, retryAfterMs: 2500,
      definitiveFailure: true, message: 'Rejected [REDACTED]' });
    const wrapped = new Error('Rejected private-fixture-key', { cause: new HttpResponseError(200, 'Explicit failure', true) });
    const redacted = redactModelProtocolError(wrapped, 'private-fixture-key');
    expect(getHttpResponseError(redacted)).toMatchObject({ status: 200, definitiveFailure: true, message: 'Rejected [REDACTED]' });
    expect(redacted).not.toHaveProperty('cause');
    const hidden = redactModelProtocolError(new Error('Submission context', { cause: direct }), 'private-fixture-key');
    expect(hidden).toBeInstanceOf(ModelProtocolHttpError);
    expect(hidden).toMatchObject({ status: 429, retryAfterMs: 2500, definitiveFailure: true, message: 'Submission context' });
    expect(hidden).not.toHaveProperty('cause');
  });
});

async function mp4Result(): Promise<Uint8Array<ArrayBuffer>> {
  const { Output, BufferTarget, Mp4OutputFormat, EncodedVideoPacketSource, EncodedPacket } = await import('mediabunny');
  const target = new BufferTarget();
  const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: 'in-memory' }) });
  const video = new EncodedVideoPacketSource('vp9');
  output.addVideoTrack(video);
  await output.start();
  await video.add(new EncodedPacket(new Uint8Array([0x82, 0x49, 0x83, 0x42, 0, 0, 0]), 'key', 0, 1), {
    decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
  });
  video.close();
  await output.finalize();
  return new Uint8Array(target.buffer!);
}

describe('厂商提交幂等身份与明确结果路径', () => {
  const syncProtocol: ModelExecutionProtocol = { version: 2, mode: 'sync',
    submit: { method: 'POST', path: '/images', body: { model: '{{model}}', prompt: '{{prompt}}' } },
    response: { type: 'json', result: { urlPath: 'data.*.url' } } };

  it('固定四候选的同步协议保存全部结果和交付数量，请求 n 仍为一个作业', async () => {
    const previous = useAppStore.getState();
    localStorage.clear();
    const urls = Array.from({ length: 4 }, (_, index) => `https://cdn.example/mj-${index + 1}.png`);
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ data: urls.map((url) => ({ url })) }));
    vi.stubGlobal('fetch', fetchMock);
    useAppStore.setState({ currentProjectId: 'four-candidates-project', nodes: [], config: { ...previous.config,
      providers: { ...previous.config.providers, 'relay-four': { name: '图片组', catalogId: 'relayonapi',
        baseUrl: 'https://relayonapi.com/v1', apiKey: 'four-candidates-fixture' } } } });
    try {
      const result = await runConfiguredModelProtocol({ category: 'image', nodeId: 'four-candidates-node',
        expectedImageOutputs: 4, variables: { model: 'Midjourney v8.2', prompt: 'test', n: 1 },
        model: { id: 'mj-four', name: 'MJ', modelId: 'Midjourney v8.2', category: 'image', providerConfigId: 'relay-four',
          executionProfile: { preset: 'custom', protocol: { ...syncProtocol, submit: { ...syncProtocol.submit,
            body: { model: '{{model}}', prompt: '{{prompt}}', n: '{{n}}' } } } } } });
      expect([...result]).toEqual(urls);
      expect(result.taskReceipt).toMatchObject({ nodeId: 'four-candidates-node', projectId: 'four-candidates-project' });
      const tasks = getPendingTasksForProject('four-candidates-project');
      expect(tasks).toEqual([expect.objectContaining({ batchCount: 4, expectedImageOutputs: 4, resultUrls: urls, submitted: true,
        mediaRecoveryState: 'delivery_pending', taskId: result.taskReceipt!.taskId })]);
      expect(JSON.stringify(tasks)).not.toContain('four-candidates-fixture');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ model: 'Midjourney v8.2', prompt: 'test', n: 1 });
    } finally {
      localStorage.clear();
      useAppStore.setState(previous, true);
    }
  });

  it('重复本地构建复用同一内部幂等标识，合并不同大小写而不改鉴权', () => {
    const protocol = structuredClone(syncProtocol);
    protocol.submit.headers = { 'idempotency-key': 'user-static-key', 'IDEMPOTENCY-KEY': 'another-static-key' };
    const options = { apiKey: 'fixture-secret', baseUrl: 'https://gateway.example/v1', protocol,
      variables: { model: 'image', prompt: 'draft' }, idempotencyKey: 'internal-request-0001' };
    for (let index = 0; index < 2; index += 1) {
      const built = buildModelProtocolRequest(options);
      const headers = new Headers(built.init.headers);
      expect(headers.get('idempotency-key')).toBe('internal-request-0001');
      expect(headers.get('authorization')).toBe('Bearer fixture-secret');
      expect(Object.keys(built.init.headers!).filter((name) => name.toLowerCase() === 'idempotency-key'))
        .toEqual(['Idempotency-Key']);
      expect(built.init.body).not.toContain('internal-request-0001');
    }
    expect(buildModelProtocolRequest({ ...options, idempotencyKey: undefined }).init.headers)
      .toMatchObject({ 'idempotency-key': 'user-static-key', 'IDEMPOTENCY-KEY': 'another-static-key' });
  });

  it.each(['short', 'request-id\r\nInjected: yes', 'request id with spaces', 'x'.repeat(129)])(
    '拒绝不安全的内部幂等标识 %#', (idempotencyKey) => {
      expect(() => buildModelProtocolRequest({ apiKey: 'fixture', baseUrl: 'https://gateway.example/v1',
        protocol: syncProtocol, variables: {}, idempotencyKey })).toThrow('提交幂等标识');
    },
  );

  it('幂等 Header 不能覆盖同名鉴权字段', () => {
    expect(() => buildModelProtocolRequest({ apiKey: 'private-auth', baseUrl: 'https://gateway.example/v1',
      protocol: { ...syncProtocol, auth: { type: 'header', name: 'iDeMpOtEnCy-KeY' } },
      variables: {}, idempotencyKey: 'internal-request-0001' })).toThrow('已用于鉴权');
  });

  it.each(['sync', 'async'] as const)('真实 RelayOn 连接的无节点 %s 调用每次只生成一个新幂等号', async (mode) => {
    const previous = useAppStore.getState();
    const uuidSpy = vi.spyOn(crypto, 'randomUUID');
    const protocol: ModelExecutionProtocol = mode === 'sync' ? syncProtocol : {
      version: 2, mode: 'async', submit: syncProtocol.submit, response: { type: 'json', taskIdPath: 'id' },
      poll: { method: 'GET', path: '/tasks/{{submit.id}}', response: { statusPath: 'status',
        successValues: ['completed'], failureValues: ['failed'], result: { urlPath: 'url' } } },
    };
    let submitted = 0;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        submitted += 1;
        return mode === 'sync' ? jsonResponse({ data: [{ url: 'https://cdn.example/image.png' }] })
          : jsonResponse({ id: `original-${submitted}` });
      }
      expect(new Headers(init?.headers).has('Idempotency-Key')).toBe(false);
      return jsonResponse({ status: 'completed', url: 'https://cdn.example/image.png' });
    });
    vi.stubGlobal('fetch', fetchMock);
    useAppStore.setState({ config: { ...previous.config, providers: { ...previous.config.providers,
      'relay-alias': { name: 'My Relay', catalogId: 'relayonapi', baseUrl: 'https://relayonapi.com/v1', apiKey: 'own-key' },
    } } });
    try {
      for (let index = 0; index < 2; index += 1) {
        const result = await runConfiguredModelProtocol({ category: 'image',
          model: { id: 'image', name: 'Image', category: 'image', modelId: 'image', providerConfigId: 'relay-alias',
            executionProfile: { preset: 'custom', protocol } }, variables: { model: 'image', prompt: 'draft' } });
        expect([...result]).toEqual(['https://cdn.example/image.png']);
        expect(result.mediaDownloadAccess).toEqual({ providerConfigId: 'relay-alias', origin: 'https://relayonapi.com' });
      }
      const keys = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
        .map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'));
      expect(keys).toHaveLength(2);
      expect(keys.every((key) => /^[a-f0-9-]{36}$/i.test(key ?? ''))).toBe(true);
      expect(new Set(keys).size).toBe(2);
      // 调试 trace 也生成 UUID；仅把实际 POST 头中的标识计作业务幂等号。
      expect(uuidSpy.mock.results.filter((result) => result.type === 'return' && keys.includes(result.value))
        .map((result) => result.value)).toEqual(keys);
    } finally {
      uuidSpy.mockRestore();
      useAppStore.setState({ config: previous.config });
    }
  });

  it('内部提交幂等号不进入轮询及同源二进制下载', async () => {
    const protocol: ModelExecutionProtocol = { version: 2, mode: 'async', submit: syncProtocol.submit,
      response: { type: 'json', taskIdPath: 'id' }, poll: { method: 'GET', path: '/tasks/{{submit.id}}',
        response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], result: {
          mimeType: 'image/png', download: { method: 'GET', path: '/tasks/{{submit.id}}/content' },
        } } } };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'download-original' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed' }))
      .mockResolvedValueOnce(new Response(pngResult, { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);
    await executeModelProtocol({ apiKey: 'fixture-secret', baseUrl: 'https://gateway.example/v1', protocol,
      variables: {}, idempotencyKey: 'internal-request-0001' });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Idempotency-Key')).toBe('internal-request-0001');
    for (const [, init] of fetchMock.mock.calls.slice(1)) {
      expect(new Headers(init?.headers).has('Idempotency-Key')).toBe(false);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-secret');
    }
  });

  it('万象完整旧 A 模板的新提交采用顶层参数，task_id 同时用于轮询和鉴权取件', async () => {
    const previous = useAppStore.getState();
    const selected = RELAYON_MODEL_MANIFEST.find((model) => model.id === 'sd-2.0-A')!;
    const profile = getRelayonVideoRecoveryProfiles(selected.id, selected.executionProfile).find((candidate) => (
      candidate.protocol?.version === 2 && (candidate.protocol.submit.body as Record<string, ProtocolJsonValue>).output !== undefined
    ))!;
    const model = { ...selected, executionProfile: profile, modelId: selected.id, providerConfigId: 'relay-alias' };
    const before = structuredClone(model);
    const video = await mp4Result();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ task_id: 'task-id-only' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed' }))
      .mockResolvedValueOnce(new Response(video, { headers: { 'Content-Type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetchMock);
    useAppStore.setState({ currentProjectId: null, projectExecutionContext: undefined,
      config: { ...previous.config, providers: { ...previous.config.providers,
        'relay-alias': { name: '原万象视频', catalogId: 'relayonapi', baseUrl: 'https://relayonapi.com/v1', apiKey: 'own-key' },
      } } });
    try {
      const urls = await runConfiguredModelProtocol({ category: 'video', model,
        variables: { model: selected.id, prompt: 'draft', durationText: '10', resolution: '720p', aspectRatio: '9:16' } });
      expect([...urls]).toEqual([encodedResult(video, 'video/mp4')]);
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ model: selected.id, prompt: 'draft',
        seconds: '10', resolution: '720p', aspect_ratio: '9:16', references: [] });
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://relayonapi.com/v1/videos',
        'https://relayonapi.com/v1/videos/task-id-only', 'https://relayonapi.com/v1/videos/task-id-only/content']);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      expect(urls.mediaDownloadAccess?.origin).toBe('https://relayonapi.com');
      for (const [, init] of fetchMock.mock.calls) expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer own-key');
      expect(model).toEqual(before);
    } finally {
      useAppStore.setState({ config: previous.config, currentProjectId: previous.currentProjectId, projectExecutionContext: previous.projectExecutionContext });
    }
  });

  it.each(['url', 'video_url', 'content.video_url'])('RelayOn 内置视频只读取本批确认的兼容结果路径 %s', async (path) => {
    const previous = useAppStore.getState();
    const selected = RELAYON_MODEL_MANIFEST.find((model) => model.id === 'doubao-seedance-2-0-260128')!;
    const resultUrl = 'https://cdn.example/video.mp4?signature=keep%2Fthis';
    const result = path === 'content.video_url' ? { content: { video_url: resultUrl } } : { [path]: resultUrl };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'video-original' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', ...result }));
    vi.stubGlobal('fetch', fetchMock);
    useAppStore.setState({ config: { ...previous.config, providers: { ...previous.config.providers,
      'relay-alias': { name: 'My Relay', catalogId: 'relayonapi', baseUrl: 'https://relayonapi.com/v1', apiKey: 'own-key' },
    } } });
    try {
      const urls = await runConfiguredModelProtocol({ category: 'video',
        model: { ...selected, modelId: selected.id, providerConfigId: 'relay-alias' },
        variables: { model: selected.id, prompt: 'draft', duration: 10, resolution: '720p', aspectRatio: '16:9' } });
      expect([...urls]).toEqual([resultUrl]);
      expect(urls.mediaDownloadAccess).toEqual({ providerConfigId: 'relay-alias', origin: 'https://relayonapi.com', auth: { type: 'bearer' } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe('https://relayonapi.com/v1/videos/video-original');
    } finally {
      useAppStore.setState({ config: previous.config });
    }
  });

  it.each(['取消查询', '非法结果地址'])('%s 保留原任务及明确结果路径，继续查询不重新生成', async (failure) => {
    const previous = useAppStore.getState();
    localStorage.clear();
    const selected = RELAYON_MODEL_MANIFEST.find((model) => model.id === 'doubao-seedance-2-0-260128')!;
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'recover-original' }))
      .mockImplementationOnce(async () => {
        if (failure === '取消查询') {
          controller.abort();
          throw new DOMException('Query cancelled', 'AbortError');
        }
        return jsonResponse({ status: 'completed', video_url: 'not-a-media-url' });
      });
    vi.stubGlobal('fetch', fetchMock);
    useAppStore.setState({ currentProjectId: 'relayon-recovery', nodes: [{ id: 'relay-video', type: 'ai-video',
      position: { x: 0, y: 0 }, data: { type: 'ai-video', label: 'Video', status: 'loading' } }],
    config: { ...previous.config, providers: { ...previous.config.providers,
      'relay-alias': { name: 'My Relay', catalogId: 'relayonapi', baseUrl: 'https://relayonapi.com/v1', apiKey: 'own-key' },
    } } });
    try {
      await expect(runConfiguredModelProtocol({ category: 'video', nodeId: 'relay-video', signal: controller.signal,
        model: { ...selected, modelId: selected.id, providerConfigId: 'relay-alias' },
        variables: { model: selected.id, prompt: 'draft', duration: 10, resolution: '720p', aspectRatio: '16:9' } }))
        .rejects.toMatchObject({ name: 'MediaTaskPausedError', taskReceipt: { taskId: 'recover-original' } });
      const saved = getPendingTasksForProject('relayon-recovery')[0];
      expect(saved).toMatchObject({ submitted: true, taskId: 'recover-original', providerConfigId: 'relay-alias',
        protocolPoll: { resultUrlFallbackPaths: [...RELAYON_VIDEO_RESULT_URL_PATHS] } });
      expect(JSON.stringify(saved)).not.toContain('own-key');
      expect(new Headers(saved.protocolPoll?.headers).has('Idempotency-Key')).toBe(false);
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'completed', url: 'https://cdn.example/recovered.mp4',
        video_url: 'https://cdn.example/recovered.mp4', content: { video_url: 'https://cdn.example/recovered.mp4' } }));
      await expect(pollResolvedModelProtocol(saved.protocolPoll!, 'own-key', undefined, 'https://relayonapi.com/v1'))
        .resolves.toEqual({ urls: ['https://cdn.example/recovered.mp4'] });
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      expect(fetchMock.mock.calls[2][0]).toBe('https://relayonapi.com/v1/videos/recover-original');
    } finally {
      localStorage.clear();
      useAppStore.setState({ config: previous.config, currentProjectId: previous.currentProjectId, nodes: previous.nodes });
    }
  });

  it.each(['自定义同名连接', '修改过的协议'])('%s 不继承 RelayOn 结果兜底', async (scenario) => {
    const previous = useAppStore.getState();
    const selected = structuredClone(RELAYON_MODEL_MANIFEST.find((model) => model.id === 'doubao-seedance-2-0-260128')!);
    if (scenario === '修改过的协议') {
      const protocol = parseModelExecutionProtocol(selected.executionProfile!.protocol!);
      protocol.poll!.response.result.urlPath = 'user_result';
      selected.executionProfile = { preset: 'custom', protocol };
    }
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'guard-original' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', video_url: 'https://cdn.example/video.mp4' }));
    vi.stubGlobal('fetch', fetchMock);
    useAppStore.setState({ config: { ...previous.config, providers: { ...previous.config.providers,
      relayonapi: { name: 'Relay', catalogId: scenario === '自定义同名连接' ? 'custom-openai' : 'relayonapi',
        baseUrl: 'https://relayonapi.com/v1', apiKey: 'own-key' },
    } } });
    try {
      await expect(runConfiguredModelProtocol({ category: 'video',
        model: { ...selected, modelId: selected.id, providerConfigId: 'relayonapi' },
        variables: { model: selected.id, prompt: 'draft', duration: 10, resolution: '720p', aspectRatio: '16:9' } }))
        .rejects.toThrow('未返回配置的结果');
      if (scenario === '自定义同名连接') expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('Idempotency-Key')).toBe(false);
    } finally {
      useAppStore.setState({ config: previous.config });
    }
  });
});

describe('binary model result boundaries', () => {
  it.each(['sync', 'download', 'fetchUrl'] as const)('recognizes actual media with generic or missing MIME through %s', async (mode) => {
    const video = await mp4Result();
    for (const [bytes, mime] of [[pngResult, 'image/png'], [wavResult, 'audio/wav'], [video, 'video/mp4']] as const) {
      for (const contentType of ['application/octet-stream', undefined]) {
        const binaryResponse = () => new Response(bytes, { headers: contentType ? { 'Content-Type': contentType } : {} });
        const protocol: ModelExecutionProtocol = mode === 'sync'
          ? { version: 2, mode: 'sync', submit: { method: 'POST', path: '/render' },
            response: { type: 'binary', result: { mimeType: mime } } }
          : { version: 2, mode: 'async', submit: { method: 'POST', path: '/render' },
            response: { type: 'json', taskIdPath: 'id' }, poll: { method: 'GET', path: '/tasks/{{submit.id}}',
              response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], result: {
                mimeType: mime, ...(mode === 'download' ? { download: { method: 'GET', path: '/tasks/{{submit.id}}/content' } }
                  : { urlPath: 'urls', fetchUrl: true }),
              } } } };
        const fetchMock = vi.fn();
        if (mode !== 'sync') fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'original-task' }))
          .mockResolvedValueOnce(jsonResponse({ status: 'completed', urls: ['https://gateway.example/v1/content'] }));
        fetchMock.mockResolvedValueOnce(binaryResponse());
        vi.stubGlobal('fetch', fetchMock);
        const result = await executeModelProtocol({ apiKey: 'secret', baseUrl: 'https://gateway.example/v1', protocol, variables: {} });
        expect(result.urls).toEqual([encodedResult(bytes, mime)]);
        expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      }
    }
  });

  it.each([
    ['application/octet-stream', '{"error":{"message":"denied"}}'],
    ['video/mp4', `\ufeff${' '.repeat(5000)}{"error":"denied"}`],
    ['image/png', '<!doctype html><html><body>denied</body></html>'],
    ['audio/wav', '<?xml version="1.0"?><html><body>denied</body></html>'],
    ['video/mp4', '"request denied"'],
  ])('rejects an error document disguised as %s', async (contentType, body) => {
    await expect(readBinaryModelProtocolResult(new Response(body, { headers: { 'Content-Type': contentType } }), 'video/mp4'))
      .rejects.toThrow('JSON 或 HTML');
  });

  it('does not promote unknown bytes using only a configured media MIME', async () => {
    await expect(readBinaryModelProtocolResult(new Response(new Uint8Array([0, 1, 2, 3])), 'video/mp4'))
      .rejects.toThrow('不能仅按配置 MIME');
    await expect(readBinaryModelProtocolResult(new Response(wavResult), 'video/mp4'))
      .resolves.toBe(encodedResult(wavResult, 'audio/wav'));
    await expect(readBinaryModelProtocolResult(new Response(wavResult, { headers: { 'Content-Type': 'image/png' } }), 'image/png'))
      .resolves.toBe(encodedResult(wavResult, 'audio/wav'));
  });

  it('rejects excessive declared bytes before consuming a result body', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    await expect(readBinaryModelProtocolResult(new Response(body, { headers: { 'Content-Length': String(64 * 1024 * 1024 + 1) } })))
      .rejects.toThrow('64 MiB');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each([undefined, '1'])('counts actual chunks against one shared budget with Content-Length %s', async (contentLength) => {
    const budget = { usedBytes: 0, maxBytes: wavResult.byteLength * 2 - 1 };
    await readBinaryModelProtocolResult(new Response(wavResult), 'audio/wav', undefined, budget);
    const cancelled = vi.fn();
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunk++ === 0) controller.enqueue(wavResult.subarray(0, wavResult.length - 1));
        else controller.enqueue(wavResult.subarray(wavResult.length - 1));
      }, cancel: cancelled,
    });
    await expect(readBinaryModelProtocolResult(new Response(body, {
      headers: contentLength ? { 'Content-Length': contentLength } : {},
    }), 'audio/wav', undefined, budget)).rejects.toThrow('累计超过下载预算');
    expect(budget.usedBytes).toBe(budget.maxBytes);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('cancels a pending body read and releases its reader', async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const pending = readBinaryModelProtocolResult(new Response(body), 'video/mp4', controller.signal);
    controller.abort(new DOMException('stopped', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('validates every URL and the result count before issuing any GET', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSameOriginResultUrls(Array.from({ length: 33 }, (_, index) => `https://gateway.example/${index}`),
      'https://gateway.example/v1', undefined, 'secret')).rejects.toThrow('32');
    await expect(fetchSameOriginResultUrls(['https://gateway.example/first', 'https://elsewhere.example/second'],
      'https://gateway.example/v1', undefined, 'secret')).rejects.toThrow('不同源');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies the byte limit to failed result downloads before reading error bodies', async () => {
    const cancelled = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled }), {
      status: 401, headers: { 'Content-Length': String(64 * 1024 * 1024 + 1) },
    })));
    await expect(fetchSameOriginResultUrls(['https://gateway.example/result'], 'https://gateway.example/v1', undefined, 'secret'))
      .rejects.toThrow('64 MiB');
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('cancels a hanging result error body and releases its reader', async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchSameOriginResultUrls(['https://gateway.example/result'], 'https://gateway.example/v1',
      undefined, 'secret', undefined, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort(new DOMException('stopped', 'AbortError'));
    await rejected;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('preserves the HTTP error classification for empty failed result downloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 304 })));
    await expect(fetchSameOriginResultUrls(['https://gateway.example/result'], 'https://gateway.example/v1', undefined, 'secret'))
      .rejects.toMatchObject({ name: 'ModelProtocolHttpError', status: 304 });
  });

  it('downloads at most two results concurrently and preserves result order', async () => {
    const requests: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { requests.push(resolve); }));
    vi.stubGlobal('fetch', fetchMock);
    const urls = [0, 1, 2].map((index) => `https://gateway.example/${index}`);
    const results = [0, 1, 2].map((value) => Uint8Array.from(pcmS16LeToWav(new Uint8Array([value, 0]), 24000, 1)));
    const pending = fetchSameOriginResultUrls(urls, 'https://gateway.example/v1', undefined, 'secret');
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1](new Response(results[1]));
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    requests[2](new Response(results[2]));
    requests[0](new Response(results[0]));
    await expect(pending).resolves.toEqual(results.map((bytes) => encodedResult(bytes, 'audio/wav')));
  });

  it.each(['cancel', 'failure'] as const)('stops queued downloads on %s and discards an uncooperative late response', async (mode) => {
    const controller = new AbortController();
    const requests: Array<{ resolve: (response: Response) => void; signal: AbortSignal }> = [];
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
      requests.push({ resolve, signal: init!.signal! });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchSameOriginResultUrls([0, 1, 2].map((index) => `https://gateway.example/${index}`),
      'https://gateway.example/v1', undefined, 'secret', 'video/mp4', controller.signal);
    const rejected = expect(pending).rejects.toThrow(mode === 'cancel' ? 'stopped' : 'JSON 或 HTML');
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    if (mode === 'cancel') controller.abort(new DOMException('stopped', 'AbortError'));
    else requests[0].resolve(jsonResponse({ error: 'denied' }));
    await rejected;
    expect(requests.every((request) => request.signal.aborted)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    requests[1].resolve(new Response(body));
    if (mode === 'cancel') requests[0].resolve(new Response(pngResult));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('declarative model execution protocol', () => {
  it.each([['sync', 'json'], ['async', 'json'], ['sync', 'size'], ['async', 'size']] as const)(
    'rejects HTTP 200 %s binary video output with %s failure before delivery', async (mode, failure) => {
    localStorage.clear();
    const projectId = `runtime-output-${mode}`;
    useAppStore.setState((state) => ({ currentProjectId: projectId,
      nodes: [{ id: 'runtime-video', type: 'ai-video', position: { x: 0, y: 0 },
        data: { type: 'ai-video', label: 'Video', status: 'loading' } }],
      config: { ...state.config, providers: { ...state.config.providers,
        output: { name: 'Output', apiKey: 'fixture-output-key', baseUrl: 'https://gateway.example/v1' } } } }));
    const protocol: ModelExecutionProtocol = mode === 'sync'
      ? { version: 2, mode: 'sync', submit: { method: 'POST', path: '/videos' },
        response: { type: 'binary', result: { mimeType: 'video/mp4' } } }
      : { version: 2, mode: 'async', submit: { method: 'POST', path: '/videos' },
        response: { type: 'json', taskIdPath: 'id' }, poll: { method: 'GET', path: '/videos/{{submit.id}}',
          intervalMs: 1000, response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed'],
            result: { mimeType: 'video/mp4', download: { method: 'GET', path: '/videos/{{submit.id}}/content' } } } } };
    let originalAttempt: string | undefined;
    const fetchMock = vi.fn();
    if (mode === 'async') {
      fetchMock.mockImplementationOnce(async () => {
        originalAttempt = getPendingTasksForProject(projectId)[0].attemptId;
        return jsonResponse({ id: 'original-binary-task' });
      }).mockResolvedValueOnce(jsonResponse({ status: 'completed' }));
    }
    fetchMock.mockResolvedValueOnce(failure === 'json'
      ? jsonResponse({ error: { message: 'upstream returned an error document' } })
      : new Response(wavResult, { headers: { 'Content-Length': String(64 * 1024 * 1024 + 1) } }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = runConfiguredModelProtocol({ category: 'video', nodeId: 'runtime-video',
      model: { id: 'runtime-model', name: 'Runtime model', modelId: 'video-model', category: 'video', providerConfigId: 'output',
        executionProfile: { preset: 'custom', protocol } }, variables: { model: 'video-model', prompt: 'video' } });
    if (mode === 'sync') {
      await expect(pending).rejects.toThrow(failure === 'json' ? 'MIME' : '64 MiB');
      expect(getPendingTasksForProject(projectId)).toEqual([]);
    } else {
      await expect(pending).rejects.toMatchObject({ name: 'MediaTaskPausedError', taskReceipt: {
        taskId: 'original-binary-task', attemptId: expect.any(String),
      } });
      expect(getPendingTasksForProject(projectId)[0]).toMatchObject({ taskId: 'original-binary-task',
        attemptId: originalAttempt, submitted: true, mediaRecoveryState: 'query_paused' });
    }
    expect(useAppStore.getState().nodes[0].data.status).not.toBe('success');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(mode === 'sync' ? 1 : 3);
    localStorage.clear();
  });

  it('redacts a query key using the same form encoding as the actual request URL', async () => {
    const apiKey = 'fixture~! private/key=';
    const formEncoded = new URLSearchParams({ key: apiKey }).toString().slice('key='.length);
    const protocol: ModelExecutionProtocol = { version: 2, mode: 'sync', auth: { type: 'query', name: 'key' },
      submit: { method: 'GET', path: '/generate' }, response: { type: 'json', result: { urlPath: 'url' } } };
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => jsonResponse({ message: `Request ${String(url)} denied` }, 401));
    vi.stubGlobal('fetch', fetchMock);

    const error = await executeModelProtocol({ protocol, apiKey, baseUrl: 'https://gateway.example/v1', variables: {} })
      .catch((reason: unknown) => reason);

    expect(String(fetchMock.mock.calls[0][0])).toContain(`key=${formEncoded}`);
    expect(formEncoded).not.toBe(encodeURIComponent(apiKey));
    expect(error).toBeInstanceOf(ModelProtocolHttpError);
    expect((error as Error).message).toContain('key=[REDACTED]');
    expect((error as Error).message).not.toContain(formEncoded);
    expect((error as Error).message).not.toContain(apiKey);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['sync', 'async', 'poll'] as const)('redacts HTTP 200 %s validator errors without re-submitting generation', async (stage) => {
    const apiKey = 'fixture~! validation/key=';
    const formEncoded = new URLSearchParams({ key: apiKey }).toString().slice('key='.length);
    const payload = { status: 'failed', error: `Rejected ${apiKey}; query=${formEncoded}` };
    const original = Object.freeze(new Error(payload.error, { cause: new Error(apiKey) }));
    const validateResponse = vi.fn((value: unknown) => {
      if ((value as { status?: string }).status === 'failed') throw original;
    });
    const protocol: ModelExecutionProtocol = stage === 'sync'
      ? { version: 2, mode: 'sync', submit: { method: 'POST', path: '/generate' },
        response: { type: 'json', result: { urlPath: 'url' } } }
      : { version: 2, mode: 'async', submit: { method: 'POST', path: '/generate' },
        response: { type: 'json', taskIdPath: 'id' }, poll: { method: 'GET', path: '/tasks/{{submit.id}}',
          intervalMs: 1000, response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed'],
            result: { urlPath: 'url' } } } };
    const fetchMock = vi.fn();
    if (stage === 'poll') fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'original-task' }));
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));
    vi.stubGlobal('fetch', fetchMock);

    const options = { protocol, apiKey, baseUrl: 'https://gateway.example/v1', variables: {}, validateResponse };
    const pending = stage === 'poll'
      ? submitModelProtocol(options).then((submitted) => pollResolvedModelProtocol(
        submitted.poll!, apiKey, undefined, options.baseUrl, validateResponse,
      ))
      : executeModelProtocol(options);
    const error = await pending.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBe(original);
    expect((error as Error).message).toContain('[REDACTED]');
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as Error).message).not.toContain(formEncoded);
    expect((error as Error).stack).not.toContain(apiKey);
    expect((error as Error).cause).toBeUndefined();
    expect(original.message).toContain(apiKey);
    expect(validateResponse).toHaveBeenCalledTimes(stage === 'poll' ? 2 : 1);
    expect(fetchMock).toHaveBeenCalledTimes(stage === 'poll' ? 2 : 1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('keeps classified validator errors and safe errors intact while dropping private causes', () => {
    const apiKey = 'fixture-private-key';
    const message = `Rejected ${apiKey}`;
    const http = Object.freeze(new ModelProtocolHttpError(429, message, 2500));
    const safeHttp = redactModelProtocolError(http, apiKey);
    expect(safeHttp).toBeInstanceOf(ModelProtocolHttpError);
    expect(safeHttp).toMatchObject({ status: 429, retryAfterMs: 2500, message: 'Rejected [REDACTED]' });
    expect(safeHttp).not.toBe(http);
    for (const original of [new PollTaskFailedError(message), new PollTimeoutError(message), new TypeError(message), new DOMException(message, 'AbortError')]) {
      const safe = redactModelProtocolError(original, apiKey);
      expect(safe).toBeInstanceOf(original.constructor);
      expect(safe).toMatchObject({ name: original.name, message: 'Rejected [REDACTED]' });
      expect((safe as Error).cause).toBeUndefined();
      expect((safe as Error).stack).not.toContain(apiKey);
    }
    const safeOriginal = Object.freeze(new Error('request denied'));
    expect(redactModelProtocolError(safeOriginal, apiKey)).toBe(safeOriginal);
    expect(redactModelProtocolError(message, apiKey)).toBe('Rejected [REDACTED]');
    expect(redactModelProtocolError('request denied', apiKey)).toBe('request denied');
  });

  it.each(['json', 'text', 'binary'] as const)('redacts echoed credentials from synchronous %s failures', async (type) => {
    const apiKey = 'fixture+private/key=';
    const protocol: ModelExecutionProtocol = {
      version: 2, mode: 'sync', submit: { method: 'POST', path: '/generate' },
      response: type === 'json'
        ? { type, errorPath: 'error.message', result: { urlPath: 'url' } }
        : { type, errorPath: 'error.message' },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: {
      message: `Invalid key ${apiKey}; encoded=${encodeURIComponent(apiKey)}; request denied`,
    } }, 401, { 'Retry-After': '2' }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await executeModelProtocol({ protocol, apiKey, baseUrl: 'https://gateway.example/v1', variables: {} })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ModelProtocolHttpError);
    expect(error).toMatchObject({ status: 401, retryAfterMs: 2000 });
    const message = (error as Error).message;
    expect(message).toContain('request denied');
    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain(apiKey);
    expect(message).not.toContain(encodeURIComponent(apiKey));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('redacts a rejected async submit before a task or caller can retain the error', async () => {
    const apiKey = 'fixture+async/private';
    const protocol: ModelExecutionProtocol = { version: 2, mode: 'async',
      submit: { method: 'POST', path: '/generate' }, response: { type: 'json', taskIdPath: 'id' },
      poll: { method: 'GET', path: '/tasks/{{submit.id}}', response: { statusPath: 'status',
        successValues: ['completed'], failureValues: ['failed'], result: { urlPath: 'url' } } } };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: `Invalid API key ${apiKey}` }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const error = await executeModelProtocol({ protocol, apiKey, baseUrl: 'https://gateway.example/v1', variables: {} })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: 'ModelProtocolHttpError', status: 401 });
    expect((error as Error).message).toContain('[REDACTED]');
    expect((error as Error).stack).not.toContain(apiKey);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['http', 'task'] as const)('redacts a resumed %s query failure without re-submitting generation', async (failure) => {
    const apiKey = 'fixture+rotated/private';
    const detail = `Rejected ${apiKey}; encoded=${encodeURIComponent(apiKey)}`;
    const fetchMock = vi.fn().mockResolvedValue(failure === 'http'
      ? jsonResponse({ message: detail }, 401)
      : jsonResponse({ status: 'failed', detail }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await pollResolvedModelProtocol({ url: 'https://gateway.example/v1/tasks/original', method: 'GET',
      statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], errorPath: 'detail', resultUrlPath: 'url',
      intervalMs: 1, retry: { maxRetries: 0 } }, apiKey, undefined, 'https://gateway.example/v1')
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[REDACTED]');
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as Error).message).not.toContain(encodeURIComponent(apiKey));
    expect((error as Error).stack).not.toContain(apiKey);
    if (failure === 'http') expect(error).toMatchObject({ name: 'ModelProtocolHttpError', status: 401 });
    else expect(error).toMatchObject({ name: 'PollTaskFailedError' });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://gateway.example/v1/tasks/original', expect.objectContaining({ method: 'GET' }));
  });

  it('extracts a configured JSON base64 result as a data URL', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      output: { image: 'aGVsbG8=' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'sync',
      responseType: 'json',
      submit: { method: 'POST', path: '/render', body: { prompt: '{{prompt}}' } },
      resultBase64Path: 'output.image',
      resultMimeType: 'image/png',
    } as unknown as ModelExecutionProtocol;

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { prompt: 'test' },
    });

    expect(result.urls).toEqual(['data:image/png;base64,aGVsbG8=']);
  });

  it('supports raw text responses without a JSON result path', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('plain model output', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'sync',
      responseType: 'text',
      submit: { method: 'POST', path: '/generate', body: { prompt: '{{prompt}}' } },
    } as unknown as ModelExecutionProtocol;

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { prompt: 'test' },
    });

    expect(result.text).toBe('plain model output');
  });

  it('supports raw synchronous binary responses as media data URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(Uint8Array.from([0, 1, 2, 255]), {
      status: 200,
      headers: { 'Content-Type': 'image/webp' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'sync',
      responseType: 'binary',
      resultMimeType: 'image/png',
      submit: { method: 'POST', path: '/render', body: { prompt: '{{prompt}}' } },
    } as unknown as ModelExecutionProtocol;

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { prompt: 'test' },
    });

    expect(result.urls).toEqual(['data:image/webp;base64,AAEC/w==']);
  });
});

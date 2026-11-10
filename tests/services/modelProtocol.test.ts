/**
 * modelProtocol — 回归测试：声明式协议、共享基础规则与执行边界。
 */
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ModelExecutionProfile, ModelExecutionProtocol, ProtocolJsonValue } from '../../src/types/aiTypes';
import {
  buildModelProtocolRequest,
  comparableProtocol,
  executeModelProtocol,
  getDefaultCustomProtocol,
  getModelProtocolPreset,
  modelProtocolUsesVariable,
  normalizeFrames8n1,
  parseModelExecutionProtocol,
  pollResolvedModelProtocol,
  submitModelProtocol,
  previewModelProtocolRequest,
  previewModelProtocolResponse,
  validateModelExecutionProtocol,
} from '../../src/services/ai/modelProtocol';
import {
  findModelProtocolForEachCapabilityConflicts,
  findUnusedReferenceVariables,
  runConfiguredModelProtocol,
} from '../../src/services/ai/modelProtocolRuntime';
import { useAppStore } from '../../src/store/useAppStore';
import { createWorkflowApiDraft } from '../../src/services/workflowApi/workflowApiDefinition';
import { readModelProtocolPathValues } from '../../src/services/ai/modelProtocolResponse';
import { isRecord } from '../../src/services/ai/modelProtocolShared';
import { serializeModelProtocolBody } from '../../src/services/ai/modelProtocolBody';
import {
  fetchSameOriginResultUrls, ModelProtocolHttpError, pcmS16LeToWav,
  readBinaryModelProtocolResult, redactModelProtocolError, throwIfDefinitiveModelResponseFailure,
} from '../../src/services/ai/modelProtocolHttp';
import { PollTaskFailedError, PollTimeoutError } from '../../src/services/pollTask';
import { buildGeneralVideoProtocolVariables } from '../../src/services/ai/generateVideo';
import { getPendingTasksForProject, MediaTaskPausedError, resumePendingTasks, savePendingTask, VideoPollingPausedError } from '../../src/services/pollManager';
import {
  assertImageModelCapability, assertModelCapabilityProtocol, resolveConfiguredImageParameters, resolveConfiguredImageQuality,
  resolveConfiguredImageBackground,
} from '../../src/services/ai/modelCapabilityValidation';
import { RELAYON_MODEL_MANIFEST, RELAYON_VIDEO_RESULT_URL_PATHS } from '../../src/services/ai/providers/relayonModelManifest';
import { getHttpResponseError, HttpResponseError } from '../../src/services/ai/httpUtils';

it('结构化批项拒绝使用数值下标errorPath保留上游原文与失败元数据', () => {
  const message = 'Non posso generare questa immagine per motivi di sicurezza.';
  let error: unknown;
  try {
    throwIfDefinitiveModelResponseFailure({ data: [{ error: { code: 'content_policy_violation', message } }] }, 200, 'data.0.error.message');
  } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(ModelProtocolHttpError);
  expect(error).toMatchObject({ status: 200, definitiveFailure: true, message });
});

const jsonResponse = (
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

const pngResult = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vYkAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
const wavResult = Uint8Array.from(pcmS16LeToWav(new Uint8Array([0, 0]), 24000, 1));
const encodedResult = (bytes: Uint8Array, mime: string) => `data:${mime};base64,${btoa(String.fromCharCode(...bytes))}`;

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
      expect(uuidSpy).toHaveBeenCalledTimes(2);
      const keys = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
        .map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'));
      expect(keys).toHaveLength(2);
      expect(keys.every((key) => /^[a-f0-9-]{36}$/i.test(key ?? ''))).toBe(true);
      expect(new Set(keys).size).toBe(2);
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

  it.each(['url', 'video_url', 'content.video_url'])('RelayOn 内置视频只读取本批确认的兼容结果路径 %s', async (path) => {
    const previous = useAppStore.getState();
    const selected = RELAYON_MODEL_MANIFEST.find((model) => model.id === 'sd-2.0-c1')!;
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
    const selected = RELAYON_MODEL_MANIFEST.find((model) => model.id === 'sd-2.0-c1')!;
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
    const selected = structuredClone(RELAYON_MODEL_MANIFEST.find((model) => model.id === 'sd-2.0-c1')!);
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

  it('checks video ratio mappings across reachable operations and input modes', () => {
    const protocol: ModelExecutionProtocol = { version: 2, mode: 'sync',
      submit: { method: 'POST', path: '/videos', body: { prompt: '{{prompt}}', aspect_ratio: '16:9' } },
      response: { type: 'json', result: { urlPath: 'url' } } };
    const model = { id: 'custom-video', name: 'Custom Video', provider: 'custom', category: 'video' as const,
      executionProfile: { preset: 'custom' as const, protocol } };

    const operationMulti = { operations: ['text-to-video' as const], supportsStandaloneAudio: false,
      operationCapabilities: { 'text-to-video': { ratios: ['16:9', '9:16'] } } };
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: operationMulti })).toThrow('可调比例');

    const operationSingles = { operations: ['text-to-video' as const, 'image-to-video' as const],
      supportsStandaloneAudio: false, allowFrameAndReferenceMix: false,
      operationCapabilities: { 'text-to-video': { ratios: ['16:9'] }, 'image-to-video': { ratios: ['9:16'] } } };
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: operationSingles })).toThrow('可调比例');

    const differentModes = { operations: ['image-to-video' as const], allowFrameAndReferenceMix: false,
      inputModeCapabilities: { keyframe: { ratios: ['16:9'] }, reference: { ratios: ['9:16'] } } };
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: differentModes })).toThrow('可调比例');

    protocol.submit.body = { prompt: '{{prompt}}', aspect_ratio: '{{aspectRatio}}' };
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: operationMulti })).not.toThrow();
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: operationSingles })).not.toThrow();
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: differentModes })).not.toThrow();

    protocol.submit.body = { prompt: '{{prompt}}', aspect_ratio: '16:9' };
    const singleReachable = { operations: ['text-to-video' as const], supportsStandaloneAudio: false,
      ratios: ['9:16'], operationCapabilities: { 'text-to-video': { ratios: ['16:9'] },
        'video-to-video': { ratios: ['9:16'] } } };
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: singleReachable })).not.toThrow();
    const singleMode = { operations: ['text-to-video' as const], supportsStandaloneAudio: false,
      operationCapabilities: { 'text-to-video': { ratios: ['16:9', '9:16'] } },
      inputModeCapabilities: { text: { ratios: ['16:9'] } } };
    expect(() => assertModelCapabilityProtocol({ ...model, videoCapability: singleMode })).not.toThrow();
  });

  it('checks fixed pixel combinations without inventing pixels for adaptive image ratios', () => {
    const capability = { resolutions: ['2K'], ratios: ['1:1', 'auto', 'adaptive'],
      dimensionPresets: { '2K': { '1:1': [2048, 2048] as const } } };
    expect(() => assertImageModelCapability(capability)).not.toThrow();
    expect(() => assertImageModelCapability({ ...capability, ratios: ['16:9'] })).toThrow('缺少像素尺寸映射');
  });

  it('keeps interface-default background distinct from an explicit auto parameter', () => {
    const capability = { backgrounds: ['auto', 'opaque', 'transparent'] };
    expect(resolveConfiguredImageBackground(undefined, 'transparent')).toBeUndefined();
    expect(resolveConfiguredImageBackground({}, 'transparent')).toBeUndefined();
    expect(resolveConfiguredImageBackground(capability)).toBeUndefined();
    expect(resolveConfiguredImageBackground({ ...capability, defaultBackground: 'opaque' })).toBe('opaque');
    expect(resolveConfiguredImageBackground({ ...capability, defaultBackground: 'opaque' }, '')).toBeUndefined();
    expect(resolveConfiguredImageBackground(capability, 'AUTO')).toBe('auto');
    expect(resolveConfiguredImageParameters(capability, { count: 1, imageBackground: 'TRANSPARENT' }))
      .toMatchObject({ imageBackground: 'transparent' });
    expect(resolveConfiguredImageParameters(capability, { count: 1, imageBackground: '' })).not.toHaveProperty('imageBackground');
    expect(() => resolveConfiguredImageBackground(capability, 'white')).toThrow('不支持背景');
    expect(() => assertImageModelCapability({ backgrounds: ['auto', 'AUTO'] })).toThrow('backgrounds');
    expect(() => assertImageModelCapability({ backgrounds: ['transparent'], defaultBackground: 'auto' })).toThrow('defaultBackground');
    // 质量/背景单独解析时不能触发既有 auto 比例像素表的完整校验。
    expect(resolveConfiguredImageBackground({ ...capability, ratios: ['auto'], resolutions: ['1K'], dimensionPresets: { '1K': {} } }, 'transparent'))
      .toBe('transparent');
  });

  it('requires a single adjustable transparent option to map background and preserves same-value fixed contracts', () => {
    const protocol = getModelProtocolPreset('openai-gpt-image');
    const model = { id: 'custom-image', name: 'Custom Image', provider: 'custom', category: 'image' as const,
      imageCapability: { backgrounds: ['transparent'] }, executionProfile: { preset: 'custom' as const, protocol } };
    expect(() => assertModelCapabilityProtocol(model)).not.toThrow();
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}' };
    expect(() => assertModelCapabilityProtocol(model)).toThrow('{{imageBackground}}');
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}', background: '{{imageQuality}}' };
    expect(() => assertModelCapabilityProtocol(model)).toThrow('{{imageBackground}}');
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}', background: 'transparent' };
    expect(() => assertModelCapabilityProtocol(model)).not.toThrow();
    expect(() => assertModelCapabilityProtocol({ ...model, imageCapability: { backgrounds: ['opaque', 'transparent'] } }))
      .toThrow('{{imageBackground}}');
  });

  it('rejects a declared or fixed transparent background with explicit JPEG without rewriting the protocol', () => {
    const protocol = getModelProtocolPreset('openai-gpt-image');
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}', background: '{{imageBackground}}', output_format: 'jpeg' };
    const model = { id: 'custom-image', name: 'Custom Image', provider: 'custom', category: 'image' as const,
      imageCapability: { backgrounds: ['transparent'] }, executionProfile: { preset: 'custom' as const, protocol } };
    expect(() => assertModelCapabilityProtocol(model)).toThrow('透明背景不能与固定 output_format: jpeg');
    expect(protocol.submit.body).toHaveProperty('output_format', 'jpeg');
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}', background: 'transparent', output_format: 'jpeg' };
    expect(() => assertModelCapabilityProtocol({ ...model, imageCapability: undefined })).toThrow('透明背景不能与固定 output_format: jpeg');
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}', background: '{{imageBackground}}', output_format: 'png' };
    expect(() => assertModelCapabilityProtocol(model)).not.toThrow();
  });

  it.each(['openai-image', 'openai-gpt-image', 'gpt-image-gateway-json'] as const)('maps optional %s background independently', (preset) => {
    const protocol = getModelProtocolPreset(preset);
    const variables = { model: 'image-model', prompt: 'draft', size: '2048x2048', imageQuality: 'high', imageBackground: 'transparent' };
    const request = buildModelProtocolRequest({ apiKey: 'fixture', baseUrl: 'https://gateway.example/v1', protocol, variables });
    expect(JSON.parse(String(request.init.body))).toMatchObject({ quality: 'high', background: 'transparent' });
    const omitted = buildModelProtocolRequest({ apiKey: 'fixture', baseUrl: 'https://gateway.example/v1', protocol,
      variables: { ...variables, imageBackground: undefined } });
    expect(JSON.parse(String(omitted.init.body))).not.toHaveProperty('background');
  });

  it('resolves declared image quality without inventing a channel default', () => {
    const capability = { qualities: ['low', 'medium', 'high'] };
    expect(resolveConfiguredImageQuality(undefined, 'max')).toBeUndefined();
    expect(resolveConfiguredImageQuality({}, 'high')).toBeUndefined();
    expect(resolveConfiguredImageQuality(capability)).toBeUndefined();
    expect(resolveConfiguredImageQuality({ ...capability, defaultQuality: 'medium' })).toBe('medium');
    expect(resolveConfiguredImageParameters(capability, { imageSize: '2K', imageQuality: 'HIGH', count: 1 }))
      .toMatchObject({ imageSize: '2K', imageQuality: 'high' });
    expect(() => resolveConfiguredImageQuality(capability, 'max')).toThrow('不支持质量 max');
    expect(() => assertImageModelCapability({ qualities: ['high', 'HIGH'] })).toThrow('qualities');
    expect(() => assertImageModelCapability({ qualities: ['low'], defaultQuality: 'max' })).toThrow('defaultQuality');
  });

  it('requires adjustable quality to consume its own variable instead of resolution', () => {
    const protocol = getModelProtocolPreset('openai-gpt-image');
    const model = { id: 'custom-image', name: 'Custom Image', provider: 'custom', category: 'image' as const,
      imageCapability: { qualities: ['low', 'high'] }, executionProfile: { preset: 'custom' as const, protocol } };
    expect(() => assertModelCapabilityProtocol(model)).not.toThrow();
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}', quality: '{{imageSize}}' };
    expect(() => assertModelCapabilityProtocol(model)).toThrow('{{imageQuality}}');
    protocol.submit.body = { model: '{{model}}', prompt: '{{prompt}}', quality: 'high' };
    expect(() => assertModelCapabilityProtocol({ ...model, imageCapability: { qualities: ['high'], defaultQuality: 'high' } })).not.toThrow();
  });

  it.each(['openai-image', 'openai-gpt-image', 'gpt-image-gateway-json'] as const)('maps %s quality and omits it when undeclared', (preset) => {
    const protocol = getModelProtocolPreset(preset);
    const variables = { model: 'image-model', prompt: 'draft', size: '2048x2048', imageSize: '2K', imageQuality: 'max', n: 1 };
    const request = buildModelProtocolRequest({ apiKey: 'fixture', baseUrl: 'https://gateway.example/v1', protocol, variables });
    expect(JSON.parse(String(request.init.body))).toMatchObject({ size: '2048x2048', quality: 'max' });
    const omitted = buildModelProtocolRequest({ apiKey: 'fixture', baseUrl: 'https://gateway.example/v1', protocol, variables: { ...variables, imageQuality: undefined } });
    expect(JSON.parse(String(omitted.init.body))).not.toHaveProperty('quality');
  });

  it.each(['image', 'audio'] as const)('retains a submitted %s task after a non-timeout query failure', async (category) => {
    localStorage.clear();
    useAppStore.setState((state) => ({ currentProjectId: 'media-query-project',
      nodes: [{ id: 'media-query-node', type: category === 'image' ? 'ai-image' : 'ai-audio', position: { x: 0, y: 0 },
        data: { type: category === 'image' ? 'ai-image' : 'ai-audio', label: 'Media', status: 'loading' } }],
      config: { ...state.config, providers: { ...state.config.providers,
        recovery: { name: 'Recovery', apiKey: 'fixture-secret', baseUrl: 'https://gateway.example/v1' } } } }));
    const protocol: ModelExecutionProtocol = { version: 2, mode: 'async',
      submit: { method: 'POST', path: '/generate', body: { model: '{{model}}', prompt: '{{prompt}}' } },
      response: { type: 'json', taskIdPath: 'id' }, poll: { method: 'GET', path: '/tasks/{{submit.id}}',
        retry: { maxRetries: 0 }, response: { statusPath: 'status', successValues: ['completed'],
          failureValues: ['failed'], result: { urlPath: 'url' } } } };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'original-media-task' }))
      .mockRejectedValueOnce(new TypeError('network disconnected'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(runConfiguredModelProtocol({ category, nodeId: 'media-query-node',
      model: { id: 'media', name: 'Media', modelId: 'media', category, providerConfigId: 'recovery',
        executionProfile: { preset: 'custom', protocol } }, variables: { model: 'media', prompt: 'private prompt' } }))
      .rejects.toMatchObject({ name: 'MediaTaskPausedError', taskReceipt: { taskId: 'original-media-task' } });
    expect(getPendingTasksForProject('media-query-project')[0]).toMatchObject({ taskId: 'original-media-task', submitted: true,
      mediaRecoveryState: 'query_paused', protocolPoll: { url: 'https://gateway.example/v1/tasks/original-media-task' } });
    expect(JSON.stringify(getPendingTasksForProject('media-query-project'))).not.toContain('private prompt');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    localStorage.clear();
  });

  it('keeps an interrupted async submit as unknown without claiming that the provider rejected it', async () => {
    localStorage.clear();
    useAppStore.setState((state) => ({ currentProjectId: 'unknown-submit', nodes: [],
      config: { ...state.config, providers: { ...state.config.providers,
        recovery: { name: 'Recovery', apiKey: 'fixture-secret', baseUrl: 'https://gateway.example/v1' } } } }));
    const protocol: ModelExecutionProtocol = { version: 2, mode: 'async',
      submit: { method: 'POST', path: '/images', body: { model: '{{model}}', prompt: '{{prompt}}' } },
      response: { type: 'json', taskIdPath: 'id' }, poll: { method: 'GET', path: '/images/{{submit.id}}', response: {
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], result: { urlPath: 'url' } } } };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connection lost')));
    await expect(runConfiguredModelProtocol({ category: 'image', nodeId: 'unknown-node', model: {
      id: 'unknown-model', name: 'Unknown model', category: 'image', modelId: 'unknown-model', providerConfigId: 'recovery',
      executionProfile: { preset: 'custom', protocol } }, variables: { model: 'unknown-model', prompt: 'image' } }))
      .rejects.toBeInstanceOf(MediaTaskPausedError);
    expect(getPendingTasksForProject('unknown-submit')[0]).toMatchObject({ taskId: '', submitted: false,
      mediaRecoveryState: 'submit_unknown' });
    localStorage.clear();
  });
  it('retains an async video query descriptor when the declared polling budget expires', async () => {
    localStorage.clear();
    useAppStore.setState((state) => ({ currentProjectId: 'slow-project',
      nodes: [{ id: 'slow-protocol', type: 'ai-video', position: { x: 0, y: 0 },
        data: { type: 'ai-video', label: 'Slow', prompt: 'video', status: 'loading' } }],
      config: { ...state.config, providers: { ...state.config.providers,
        slow: { name: 'Slow', apiKey: 'fixture-key', baseUrl: 'https://gateway.example/v1' } } } }));
    const protocol: ModelExecutionProtocol = { version: 2, mode: 'async', auth: { type: 'bearer' },
      submit: { method: 'POST', path: '/videos', body: { model: '{{model}}', prompt: '{{prompt}}' } },
      response: { type: 'json', taskIdPath: 'id' }, poll: { method: 'GET', path: '/videos/{{submit.id}}',
        intervalMs: 1000, maxAttempts: 1, response: { statusPath: 'status', successValues: ['completed'],
          failureValues: ['failed'], result: { urlPath: 'url' } } } };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'task-retained' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'queued' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(runConfiguredModelProtocol({ nodeId: 'slow-protocol', category: 'video',
      model: { id: 'slow', name: 'Slow', modelId: 'slow', category: 'video', providerConfigId: 'slow',
        executionProfile: { preset: 'custom', protocol } }, variables: { model: 'slow', prompt: 'video' } }))
      .rejects.toBeInstanceOf(VideoPollingPausedError);
    expect(getPendingTasksForProject('slow-project')[0]).toMatchObject({ taskId: 'task-retained',
      videoRecoveryState: 'paused', protocolPoll: { url: 'https://gateway.example/v1/videos/task-retained' } });
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'idle', videoTaskState: 'paused', error: undefined });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    localStorage.clear();
  });
  it.each([
    ['data.results.0.url', ['https://cdn.example/first.mp4']],
    ['data.results[0].url', ['https://cdn.example/first.mp4']],
    ['data.results.*.url', ['https://cdn.example/first.mp4', 'https://cdn.example/second.mp4']],
    ['data.results[*].url', ['https://cdn.example/first.mp4', 'https://cdn.example/second.mp4']],
  ])('previews workflow result path %s', (path, expected) => {
    const protocol = parseModelExecutionProtocol(createWorkflowApiDraft().manifest.protocol);
    expect(protocol.poll!.response.result.urlPath).toBe('data.results.0.url');
    protocol.poll!.response.result.urlPath = path;
    expect(validateModelExecutionProtocol(protocol)).toEqual([]);
    const preview = previewModelProtocolResponse(protocol, {
      data: { status: 'completed', results: [
        { url: 'https://cdn.example/first.mp4' },
        { url: 'https://cdn.example/second.mp4' },
      ] },
    });
    expect(preview.find((entry) => entry.id === 'poll-result-url')).toMatchObject({
      matchCount: expected.length, values: expected,
    });
  });

  it('keeps missing and unsafe bracket paths from matching', () => {
    const payload = { data: { results: [{ url: 'https://cdn.example/first.mp4' }] } };
    expect(readModelProtocolPathValues(payload, 'data.results[9].url')).toEqual([]);
    expect(readModelProtocolPathValues({ data: { results: [] } }, 'data.results[*].url')).toEqual([]);
    expect(readModelProtocolPathValues(payload, 'data.results[*].constructor')).toEqual([]);
    expect(readModelProtocolPathValues(payload, 'data.results[0].__proto__')).toEqual([]);
  });

  it('does not invent an endpoint for a new custom video protocol', () => {
    const protocol = getDefaultCustomProtocol('video');
    expect(protocol.submit.path).toBe('');
    expect(protocol.poll?.path).toBe('');
    expect(validateModelExecutionProtocol(protocol)).toContain('提交请求 path必须是以 / 开头的同源相对路径');
    expect(JSON.stringify(protocol)).not.toContain('/videos/generations');
  });

  it('recognizes dotted variable paths without accepting similar prefixes', () => {
    const source = JSON.stringify({
      image: '{{imageUrls.0}}',
      nested: '{{ imageUrls.0.url }}',
      lookalike: '{{imageUrlsExtra}}',
    });

    expect(modelProtocolUsesVariable(source, 'imageUrls')).toBe(true);
    expect(modelProtocolUsesVariable(source, 'imageUrls.0')).toBe(true);
    expect(modelProtocolUsesVariable('{{imageUrlsExtra}}', 'imageUrls')).toBe(false);
    expect(modelProtocolUsesVariable('{{imageUrls}}', 'imageUrl')).toBe(false);
  });

  it('emits version 2 presets with explicit submit and polling response blocks', () => {
    const protocol = getModelProtocolPreset('agnes-video') as unknown as Record<string, unknown>;
    const poll = protocol.poll as Record<string, unknown>;

    expect(protocol).toMatchObject({
      version: 2,
      mode: 'async',
      response: {
        type: 'json',
        taskIdPath: 'video_id',
      },
    });
    expect(poll.response).toEqual({
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed', 'error'],
      result: { urlPath: 'url', mimeType: 'video/mp4' },
      errorPath: 'error',
      progressPath: 'progress',
    });
    expect(protocol).not.toHaveProperty('taskIdPath');
    expect(poll).not.toHaveProperty('statusPath');
    expect(poll).not.toHaveProperty('resultUrlPath');
  });

  it('upgrades a legacy version 1 protocol to the canonical version 2 response shape', () => {
    const upgraded = parseModelExecutionProtocol({
      version: 1,
      mode: 'async',
      submit: { method: 'POST', path: '/videos', body: { prompt: '{{prompt}}' } },
      taskIdPath: 'video_id',
      errorPath: 'error.message',
      poll: {
        method: 'GET',
        path: '/status/{{submit.video_id}}',
        statusPath: 'state',
        successValues: ['done'],
        failureValues: ['failed'],
        resultUrlPath: 'output.url',
        resultMimeType: 'video/mp4',
        errorPath: 'error',
        progressPath: 'progress',
      },
    } as ModelExecutionProtocol) as unknown as Record<string, unknown>;
    const poll = upgraded.poll as Record<string, unknown>;

    expect(upgraded).toMatchObject({
      version: 2,
      mode: 'async',
      response: {
        type: 'json',
        taskIdPath: 'video_id',
        errorPath: 'error.message',
      },
    });
    expect(poll.response).toEqual({
      statusPath: 'state',
      successValues: ['done'],
      failureValues: ['failed'],
      result: { urlPath: 'output.url', mimeType: 'video/mp4' },
      errorPath: 'error',
      progressPath: 'progress',
    });
    expect(upgraded).not.toHaveProperty('taskIdPath');
    expect(upgraded).not.toHaveProperty('errorPath');
    expect(poll).not.toHaveProperty('statusPath');
  });

  it('validates the nested version 2 response shape', () => {
    const protocol = {
      version: 2,
      mode: 'sync',
      submit: { method: 'POST', path: '/images', body: { prompt: '{{prompt}}' } },
      response: {
        type: 'json',
        result: { base64Path: 'data.*.b64_json', mimeType: 'image/png' },
        errorPath: 'error.message',
      },
    };

    expect(validateModelExecutionProtocol(protocol)).toEqual([]);
    expect(validateModelExecutionProtocol({
      ...protocol,
      response: { type: 'json', result: { base64Path: 'data.*.b64_json' } },
    })).toContain('Base64 结果必须配置 MIME 类型');
    expect(validateModelExecutionProtocol({
      ...protocol,
      resultUrlPath: 'legacy.url',
    })).toContain('version 2 响应字段必须配置在 response 中');
  });

  it('previews configured synchronous JSON response paths without exposing base64 data', () => {
    const protocol = {
      version: 1,
      mode: 'sync',
      submit: { method: 'POST', path: '/render', body: {} },
      resultUrlPath: 'data.*.url',
      resultTextPath: 'data.0.caption',
      resultBase64Path: 'data.*.b64_json',
      resultMimeType: 'image/png',
      errorPath: 'error.message',
    } as ModelExecutionProtocol;

    const preview = previewModelProtocolResponse(protocol, {
      data: [{
        url: 'https://cdn.example/result.png',
        caption: '生成完成',
        b64_json: 'aGVsbG8=',
      }],
    });

    expect(preview).toEqual([
      {
        id: 'result-url',
        label: 'URL 结果',
        path: 'data.*.url',
        matchCount: 1,
        values: ['https://cdn.example/result.png'],
      },
      {
        id: 'result-text',
        label: '文本结果',
        path: 'data.0.caption',
        matchCount: 1,
        values: ['生成完成'],
      },
      {
        id: 'result-base64',
        label: 'Base64 结果',
        path: 'data.*.b64_json',
        matchCount: 1,
        values: ['[Base64 8 字符]'],
      },
      {
        id: 'submit-error',
        label: '错误信息',
        path: 'error.message',
        matchCount: 0,
        values: [],
      },
    ]);
    expect(JSON.stringify(preview)).not.toContain('aGVsbG8=');
  });

  it('previews asynchronous submit and polling response paths together', () => {
    const protocol = getModelProtocolPreset('agnes-video');

    const preview = previewModelProtocolResponse(protocol, {
      video_id: 'video-1',
      status: 'completed',
      progress: 100,
      url: 'https://cdn.example/video.mp4',
      error: null,
    });

    expect(preview).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task-id', values: ['video-1'] }),
      expect.objectContaining({ id: 'status', values: ['completed'] }),
      expect.objectContaining({ id: 'poll-result-url', values: ['https://cdn.example/video.mp4'] }),
      expect.objectContaining({ id: 'progress', values: ['100'] }),
    ]));
  });

  it('previews a rendered request with masked credentials and no network call', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const protocol: ModelExecutionProtocol = {
      version: 1,
      mode: 'sync',
      auth: { type: 'header', name: 'X-API-Key', prefix: 'Token ' },
      submit: {
        method: 'POST',
        path: '/render',
        query: {
          language: 'zh',
          optional: '{{imageUrls}}',
        },
        body: {
          model: '{{model}}',
          prompt: '{{prompt}}',
          width: '{{width}}',
          height: '{{height}}',
          reference_images: '{{imageUrls}}',
        },
      },
      resultUrlPath: 'data.url',
    };

    const preview = previewModelProtocolRequest({
      baseUrl: 'https://preview.invalid/v1',
      protocol,
      variables: {
        model: 'image-model',
        prompt: 'A glass cube',
        width: 1024,
        height: 768,
      },
    });

    expect(preview).toEqual({
      method: 'POST',
      relativeUrl: '/v1/render?language=zh',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'Token ********',
      },
      body: {
        model: 'image-model',
        prompt: 'A glass cube',
        width: 1024,
        height: 768,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders video-to-video operation semantics into a custom request', () => {
    const protocol: ModelExecutionProtocol = {
      version: 1,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/videos',
        body: {
          operation: '{{videoOperation}}',
          video_urls: '{{videoUrls}}',
        },
      },
      resultUrlPath: 'data.url',
    };

    const preview = previewModelProtocolRequest({
      baseUrl: 'https://preview.invalid/v1',
      protocol,
      variables: {
        videoOperation: 'video-to-video',
        videoUrls: ['https://cdn.example/reference.mp4'],
      },
    });

    expect(preview.body).toEqual({
      operation: 'video-to-video',
      video_urls: ['https://cdn.example/reference.mp4'],
    });
  });

  it('omits a whole conditional content item when its reference variable is absent', () => {
    const protocol: ModelExecutionProtocol = {
      version: 2,
      mode: 'sync',
      auth: { type: 'none' },
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: {
          content: [
            { type: 'text', text: '{{prompt}}' },
            {
              $whenPresent: '{{imageUrls.0}}',
              $value: {
                type: 'image_url',
                image_url: { url: '{{imageUrls.0}}' },
                role: 'first_frame',
              },
            },
          ],
        },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    };

    const withoutReference = buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com/v1',
      protocol,
      variables: { prompt: '挥手', imageUrls: [] },
    });
    expect(withoutReference.renderedBody).toEqual({
      content: [{ type: 'text', text: '挥手' }],
    });

    const withReference = buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com/v1',
      protocol,
      variables: { prompt: '挥手', imageUrls: ['https://cdn.example.com/first.png'] },
    });
    expect(withReference.renderedBody).toEqual({
      content: [
        { type: 'text', text: '挥手' },
        {
          type: 'image_url',
          image_url: { url: 'https://cdn.example.com/first.png' },
          role: 'first_frame',
        },
      ],
    });
  });

  it('renders conditional array items before form and multipart serialization', () => {
    const formProtocol: ModelExecutionProtocol = {
      version: 2,
      mode: 'sync',
      auth: { type: 'none' },
      submit: {
        method: 'POST',
        path: '/form-video',
        bodyEncoding: 'form-urlencoded',
        body: {
          references: [{
            $whenPresent: '{{imageUrls.0}}',
            $value: '{{imageUrls.0}}',
          }],
        },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    };
    const withoutFormReference = buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com',
      protocol: formProtocol,
      variables: { imageUrls: [] },
    });
    expect(withoutFormReference.renderedBody).toEqual({ references: [] });
    expect(String(withoutFormReference.init.body)).toBe('');

    const withFormReference = buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com',
      protocol: formProtocol,
      variables: { imageUrls: ['https://cdn.example.com/ref.png'] },
    });
    expect(new URLSearchParams(String(withFormReference.init.body)).getAll('references'))
      .toEqual(['https://cdn.example.com/ref.png']);

    const multipartProtocol: ModelExecutionProtocol = {
      ...formProtocol,
      submit: {
        method: 'POST',
        path: '/multipart-video',
        bodyEncoding: 'multipart',
        body: {
          images: [{
            $whenPresent: '{{imageUrls.0}}',
            $value: {
              $file: '{{imageUrls.0}}',
              filename: 'reference.txt',
            },
          }],
        },
      },
    };
    expect(previewModelProtocolRequest({
      baseUrl: 'https://relay.example.com',
      protocol: multipartProtocol,
      variables: { imageUrls: [] },
    }).body).toEqual({ images: [] });
    expect(previewModelProtocolRequest({
      baseUrl: 'https://relay.example.com',
      protocol: multipartProtocol,
      variables: { imageUrls: ['data:text/plain;base64,aGVsbG8='] },
    }).body).toEqual({
      images: [{
        $file: '[data URL text/plain, 5 bytes]',
        filename: 'reference.txt',
      }],
    });
  });

  it('expands trusted reference URL arrays into ordered JSON content objects', () => {
    const protocol: ModelExecutionProtocol = {
      version: 2,
      mode: 'sync',
      auth: { type: 'none' },
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: {
          content: [
            { type: 'text', text: '{{prompt}}' },
            {
              $forEach: '{{referenceImageUrls}}',
              $value: {
                type: 'image_url',
                image_url: { url: '{{referenceImageUrls}}' },
                role: 'reference_image',
              },
            },
            {
              $forEach: '{{referenceVideoUrls}}',
              $value: {
                type: 'video_url',
                video_url: { url: '{{referenceVideoUrls}}' },
                role: 'reference_video',
              },
            },
            {
              $forEach: '{{referenceAudioUrls}}',
              $value: {
                type: 'audio_url',
                audio_url: { url: '{{referenceAudioUrls}}' },
                role: 'reference_audio',
              },
            },
          ],
        },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    };

    expect(buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com/v1',
      protocol,
      variables: { prompt: '挥手' },
    }).renderedBody).toEqual({ content: [{ type: 'text', text: '挥手' }] });

    expect(buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com/v1',
      protocol,
      variables: {
        prompt: '挥手',
        referenceImageUrls: ['https://cdn.example.com/1.png', 'https://cdn.example.com/2.png'],
        referenceVideoUrls: ['https://cdn.example.com/1.mp4'],
        referenceAudioUrls: ['https://cdn.example.com/1.mp3'],
      },
    }).renderedBody).toEqual({
      content: [
        { type: 'text', text: '挥手' },
        { type: 'image_url', image_url: { url: 'https://cdn.example.com/1.png' }, role: 'reference_image' },
        { type: 'image_url', image_url: { url: 'https://cdn.example.com/2.png' }, role: 'reference_image' },
        { type: 'video_url', video_url: { url: 'https://cdn.example.com/1.mp4' }, role: 'reference_video' },
        { type: 'audio_url', audio_url: { url: 'https://cdn.example.com/1.mp3' }, role: 'reference_audio' },
      ],
    });
  });

  it.each([
    {
      label: 'untrusted source root',
      directive: {
        $forEach: '{{prompt}}',
        $value: { url: '{{prompt}}' },
      },
      bodyEncoding: undefined,
      error: '$forEach 必须是 referenceImageUrls',
    },
    {
      label: 'dotted source path',
      directive: {
        $forEach: '{{referenceImageUrls.0}}',
        $value: { url: '{{referenceImageUrls.0}}' },
      },
      bodyEncoding: undefined,
      error: '$forEach 必须是 referenceImageUrls',
    },
    {
      label: 'source is not consumed',
      directive: {
        $forEach: '{{referenceImageUrls}}',
        $value: { url: 'https://fixed.example/ref.png' },
      },
      bodyEncoding: undefined,
      error: '必须使用完整模板 {{referenceImageUrls}}',
    },
    {
      label: 'scalar output',
      directive: {
        $forEach: '{{referenceImageUrls}}',
        $value: '{{referenceImageUrls}}',
      },
      bodyEncoding: undefined,
      error: '$value 必须是 JSON 对象',
    },
    {
      label: 'non-json body',
      directive: {
        $forEach: '{{referenceImageUrls}}',
        $value: { url: '{{referenceImageUrls}}' },
      },
      bodyEncoding: 'form-urlencoded' as const,
      error: '数组展开项只支持 JSON 请求体',
    },
  ])('rejects unsafe array expansion directives: $label', ({ directive, bodyEncoding, error }) => {
    expect(validateModelExecutionProtocol({
      version: 2,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/video_generation',
        ...(bodyEncoding ? { bodyEncoding } : {}),
        body: { content: [directive] },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    })).toContainEqual(expect.stringContaining(error));
  });

  it('rejects non-array and oversized runtime values for array expansion', () => {
    const protocol: ModelExecutionProtocol = {
      version: 2,
      mode: 'sync',
      auth: { type: 'none' },
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: {
          content: [{
            $forEach: '{{referenceImageUrls}}',
            $value: { url: '{{referenceImageUrls}}' },
          }],
        },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    };

    expect(() => buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com',
      protocol,
      variables: { referenceImageUrls: 'https://cdn.example.com/ref.png' },
    })).toThrow('必须是字符串数组');
    expect(() => buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com',
      protocol,
      variables: {
        referenceImageUrls: Array.from({ length: 65 }, (_, index) => `https://cdn.example.com/${index}.png`),
      },
    })).toThrow('最多允许 64 项');
  });

  it('allows array expansion only as a direct body array item', () => {
    const directive = {
      $forEach: '{{referenceImageUrls}}',
      $value: { url: '{{referenceImageUrls}}' },
    };
    expect(validateModelExecutionProtocol({
      version: 2,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: { nested: directive },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    })).toContainEqual(expect.stringContaining('数组展开项只能用于请求体数组元素'));

    expect(validateModelExecutionProtocol({
      version: 2,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: {
          content: [{
            ...directive,
            $whenPresent: '{{referenceImageUrls.0}}',
          }],
        },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    })).toContainEqual(expect.stringContaining('必须且只能包含 $forEach 和 $value'));
  });

  it('validates maxBodyBytes as a bounded positive integer', () => {
    for (const maxBodyBytes of [0, -1, 1.5, 512 * 1024 * 1024 + 1]) {
      expect(validateModelExecutionProtocol({
        version: 2,
        mode: 'sync',
        submit: {
          method: 'POST',
          path: '/video_generation',
          maxBodyBytes,
          body: { prompt: '{{prompt}}' },
        },
        response: { type: 'json', result: { urlPath: 'url' } },
      })).toContainEqual(expect.stringContaining('maxBodyBytes 必须是'));
    }
    expect(validateModelExecutionProtocol({
      version: 2,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/video_generation',
        maxBodyBytes: 64 * 1024 * 1024,
        body: { prompt: '{{prompt}}' },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    })).toEqual([]);
  });

  it('rejects maxBodyBytes for multipart and poll requests', () => {
    expect(validateModelExecutionProtocol({
      version: 2,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/video_generation',
        bodyEncoding: 'multipart',
        maxBodyBytes: 1024,
        body: { prompt: '{{prompt}}' },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    })).toContainEqual(expect.stringContaining('multipart 时不支持 maxBodyBytes'));

    expect(validateModelExecutionProtocol({
      version: 2,
      mode: 'async',
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: { prompt: '{{prompt}}' },
      },
      response: { type: 'json', taskIdPath: 'task_id' },
      poll: {
        method: 'POST',
        path: '/query/video_generation',
        maxBodyBytes: 1024,
        body: { task_id: '{{submit.task_id}}' },
        response: {
          statusPath: 'status',
          successValues: ['completed'],
          failureValues: ['failed'],
          result: { urlPath: 'url' },
        },
      },
    })).toContainEqual(expect.stringContaining('轮询请求不支持 maxBodyBytes'));
  });

  it('blocks an oversized submit using the actual serialized UTF-8 byte length', () => {
    const rendered = { prompt: '猫' };
    const actualBytes = new TextEncoder().encode(JSON.stringify(rendered)).byteLength;
    const protocol: ModelExecutionProtocol = {
      version: 2,
      mode: 'sync',
      auth: { type: 'none' },
      submit: {
        method: 'POST',
        path: '/video_generation',
        maxBodyBytes: actualBytes - 1,
        body: { prompt: '{{prompt}}' },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    };

    expect(() => buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com',
      protocol,
      variables: { prompt: '猫' },
    })).toThrow(`序列化后为 ${actualBytes} 字节`);

    protocol.submit.maxBodyBytes = actualBytes;
    expect(buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://relay.example.com',
      protocol,
      variables: { prompt: '猫' },
    }).init.body).toBe(JSON.stringify(rendered));
  });

  it.each([
    {
      label: 'missing value',
      directive: { $whenPresent: '{{imageUrls.0}}' },
      error: '条件项必须且只能包含',
    },
    {
      label: 'missing condition',
      directive: { $value: {} },
      error: '条件项必须且只能包含',
    },
    {
      label: 'non-template condition',
      directive: { $whenPresent: 'imageUrls.0', $value: {} },
      error: '$whenPresent 必须是一个完整的受信变量模板',
    },
    {
      label: 'unknown variable root',
      directive: { $whenPresent: '{{unknownReferences.0}}', $value: {} },
      error: '使用了不允许的变量 unknownReferences.0',
    },
    {
      label: 'blocked path segment',
      directive: { $whenPresent: '{{imageUrls.__proto__}}', $value: {} },
      error: '使用了不安全的变量路径 imageUrls.__proto__',
    },
  ])('rejects malformed conditional content directives: $label', ({ directive, error }) => {
    const invalid = {
      version: 2,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: {
          content: [directive],
        },
      },
      response: { type: 'json', result: { urlPath: 'url' } },
    };

    expect(validateModelExecutionProtocol(invalid)).toContainEqual(expect.stringContaining(error));
  });

  it.each([
    {
      label: 'query',
      submit: {
        method: 'POST',
        path: '/video_generation',
        query: {
          optional: { $whenPresent: '{{imageUrls.0}}', $value: 'yes' },
        },
        body: {},
      },
    },
    {
      label: 'whole body',
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: { $whenPresent: '{{imageUrls.0}}', $value: { image: '{{imageUrls.0}}' } },
      },
    },
    {
      label: 'ordinary object field',
      submit: {
        method: 'POST',
        path: '/video_generation',
        body: {
          optional: { $whenPresent: '{{imageUrls.0}}', $value: { image: '{{imageUrls.0}}' } },
        },
      },
    },
  ])('allows conditional directives only in body array items: $label', ({ submit }) => {
    expect(validateModelExecutionProtocol({
      version: 2,
      mode: 'sync',
      submit,
      response: { type: 'json', result: { urlPath: 'url' } },
    })).toContainEqual(expect.stringContaining('条件项只能用于请求体数组元素'));
  });

  it('normalizes arbitrary video frame counts to 8 * n + 1', () => {
    expect(normalizeFrames8n1(77)).toBe(81);
    expect(normalizeFrames8n1(121)).toBe(121);
    expect(getModelProtocolPreset('agnes-video').poll?.intervalMs).toBe(10000);
  });

  it('executes the Agnes video submit and video_id polling contract', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        task_id: 'task-1',
        video_id: 'video-1',
        status: 'queued',
      }))
      .mockResolvedValueOnce(jsonResponse({
        video_id: 'video-1',
        status: 'completed',
        progress: 100,
        url: 'https://cdn.example/video.mp4',
        error: null,
      }));
    vi.stubGlobal('fetch', fetchMock);

    const protocol = getModelProtocolPreset('agnes-video');
    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      protocol,
      variables: {
        model: 'agnes-video-v2.0',
        prompt: 'A cinematic cat',
        frames: 121,
        frames8n1: 121,
        fps: 24,
      },
    });

    expect(result.urls).toEqual(['https://cdn.example/video.mp4']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://apihub.agnes-ai.com/v1/videos');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'agnes-video-v2.0',
      prompt: 'A cinematic cat',
      height: 768,
      width: 1152,
      num_frames: 121,
      frame_rate: 24,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://apihub.agnes-ai.com/agnesapi?video_id=video-1',
    );
  });

  it('polls an asynchronous text protocol and extracts its configured text path', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ job: { id: 'text-task' } }))
      .mockResolvedValueOnce(jsonResponse({ state: 'done', output: { text: '异步文本' } }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'async',
      submit: {
        method: 'POST',
        path: '/responses',
        body: { model: '{{model}}', prompt: '{{prompt}}' },
      },
      taskIdPath: 'job.id',
      poll: {
        method: 'GET',
        path: '/responses/{{submit.job.id}}',
        statusPath: 'state',
        successValues: ['done'],
        failureValues: ['failed'],
        resultTextPath: 'output.text',
        intervalMs: 1000,
      },
    } as unknown as ModelExecutionProtocol;

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { model: 'async-text', prompt: '测试' },
    });

    expect(result.text).toBe('异步文本');
    expect(result.taskId).toBe('text-task');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://gateway.example/v1/responses/text-task');
  });

  it('posts form-encoded polling requests and extracts JSON base64 results', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ task_id: 'image-task' }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'completed',
        output: { image: 'aGVsbG8=' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'async',
      submit: {
        method: 'POST',
        path: '/render',
        body: { model: '{{model}}', prompt: '{{prompt}}' },
      },
      taskIdPath: 'task_id',
      poll: {
        method: 'POST',
        path: '/render/status',
        bodyEncoding: 'form-urlencoded',
        body: { task_id: '{{submit.task_id}}' },
        statusPath: 'status',
        successValues: ['completed'],
        failureValues: ['failed'],
        resultBase64Path: 'output.image',
        resultMimeType: 'image/png',
        intervalMs: 1000,
      },
    } as unknown as ModelExecutionProtocol;

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { model: 'async-image', prompt: '测试' },
    });

    expect(result.urls).toEqual(['data:image/png;base64,aGVsbG8=']);
    const pollInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(pollInit.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    });
    expect(pollInit.body).toBe('task_id=image-task');
  });

  it('executes the OpenAI-compatible image preset with nested extra_body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      data: [{ url: 'https://cdn.example/image.png' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://apihub.agnes-ai.com/v1/',
      protocol: getModelProtocolPreset('openai-image'),
      variables: {
        model: 'agnes-image-2.0-flash',
        prompt: 'A glass cube',
        size: '1024x768',
      },
    });

    expect(result.urls).toEqual(['https://cdn.example/image.png']);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'agnes-image-2.0-flash',
      prompt: 'A glass cube',
      size: '1024x768',
      extra_body: { response_format: 'url' },
    });
  });

  it('extracts results from a top-level JSON array', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([
      { url: 'https://cdn.example/array-image.png' },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'sync',
      submit: { method: 'POST', path: '/render', body: { prompt: '{{prompt}}' } },
      resultUrlPath: '0.url',
    } as ModelExecutionProtocol;

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { prompt: 'test' },
    });

    expect(result.urls).toEqual(['https://cdn.example/array-image.png']);
  });

  it('executes the OpenAI-compatible chat preset and extracts text', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: '配置成功' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol: getModelProtocolPreset('openai-chat' as never),
      variables: {
        model: 'chat-model',
        messages: [{ role: 'user', content: '测试' }],
        stream: false,
      },
    });

    expect(result.text).toBe('配置成功');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/chat/completions');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'chat-model',
      messages: [{ role: 'user', content: '测试' }],
      stream: false,
    });
  });

  it('maps size variables into string, split and semantic request fields', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ url: 'https://cdn.example/image.png' }));
    vi.stubGlobal('fetch', fetchMock);

    const protocol = {
      version: 1,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/render',
        headers: {
          'X-Client': 'ai-canvas',
          'X-Optional-Format': '{{audioFormat}}',
        },
        query: { aspect: '{{aspectRatio}}', optional: '{{audioVoice}}' },
        body: {
          model: '{{model}}',
          size: '{{size}}',
          width: '{{width}}',
          height: '{{height}}',
          resolution: '{{imageSize}}',
          aspect_ratio: '{{aspectRatio}}',
          optional_voice: '{{audioVoice}}',
        },
      },
      resultUrlPath: 'url',
    } as unknown as ModelExecutionProtocol;

    await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: {
        model: 'image-model',
        size: '1024x768',
        width: 1024,
        height: 768,
        imageSize: '1K',
        aspectRatio: '4:3',
      },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/render?aspect=4%3A3');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer secret',
      'X-Client': 'ai-canvas',
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('X-Optional-Format');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'image-model',
      size: '1024x768',
      width: 1024,
      height: 768,
      resolution: '1K',
      aspect_ratio: '4:3',
    });
  });

  it('encodes a rendered request body as application/x-www-form-urlencoded', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      url: 'https://cdn.example/form-image.png',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/render',
        bodyEncoding: 'form-urlencoded',
        body: {
          prompt: '{{prompt}}',
          tags: ['one', 'two'],
          options: { width: '{{width}}', enabled: true },
        },
      },
      resultUrlPath: 'url',
    } as unknown as ModelExecutionProtocol;

    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { prompt: '玻璃 cube', width: 1024 },
    });

    expect(result.urls).toEqual(['https://cdn.example/form-image.png']);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    });
    expect(init.body).toBe(
      'prompt=%E7%8E%BB%E7%92%83+cube&tags=one&tags=two&options=%7B%22width%22%3A1024%2C%22enabled%22%3Atrue%7D',
    );
  });

  it('encodes controlled data URL files as multipart form data and redacts preview bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      url: 'https://cdn.example/multipart-image.png',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/edit',
        bodyEncoding: 'multipart',
        body: {
          prompt: '{{prompt}}',
          image: {
            $file: '{{imageUrls.0}}',
            filename: 'reference.txt',
          },
        },
      },
      resultUrlPath: 'url',
    } as unknown as ModelExecutionProtocol;
    const variables = {
      prompt: 'edit it',
      imageUrls: ['data:text/plain;base64,aGVsbG8='],
    };

    const preview = previewModelProtocolRequest({
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables,
    });
    const result = await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables,
    });

    expect(preview.body).toEqual({
      prompt: 'edit it',
      image: {
        $file: '[data URL text/plain, 5 bytes]',
        filename: 'reference.txt',
      },
    });
    expect(JSON.stringify(preview.body)).not.toContain('aGVsbG8=');
    expect(result.urls).toEqual(['https://cdn.example/multipart-image.png']);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      'Content-Type': expect.stringMatching(/^multipart\/form-data; boundary=/),
    });
    const bodyText = new TextDecoder().decode(init.body as ArrayBuffer);
    expect(bodyText).toContain('name="prompt"');
    expect(bodyText).toContain('edit it');
    expect(bodyText).toContain('name="image"; filename="reference.txt"');
    expect(bodyText).toContain('Content-Type: text/plain');
    expect(bodyText).toContain('hello');
  });

  it('rejects multipart file sources that are not inline data URLs', async () => {
    const protocol = {
      version: 1,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: '/edit',
        bodyEncoding: 'multipart',
        body: { image: { $file: '{{imageUrls.0}}' } },
      },
      resultUrlPath: 'url',
    } as unknown as ModelExecutionProtocol;

    await expect(executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { imageUrls: ['C:\\private\\reference.png'] },
    })).rejects.toThrow('multipart 文件只支持 data URL');
  });

  it('encodes file arrays and redacts every file in multipart previews', () => {
    const protocol = {
      version: 1, mode: 'sync',
      submit: { method: 'POST', path: '/edit', bodyEncoding: 'multipart',
        body: { 'image[]': { $file: '{{imageUrls}}', filename: 'reference.png' } },
      },
      resultUrlPath: 'url',
    } as unknown as ModelExecutionProtocol;
    const options = { baseUrl: 'https://gateway.example', protocol, variables: {
      imageUrls: ['data:image/png;base64,aGVsbG8=', 'data:image/jpeg;base64,d29ybGQ='],
    } };
    const preview = previewModelProtocolRequest(options);
    expect(preview.body).toEqual({ 'image[]': [
      { $file: '[data URL image/png, 5 bytes]', filename: 'reference.png' },
      { $file: '[data URL image/jpeg, 5 bytes]', filename: 'reference.jpg' },
    ] });
    expect(JSON.stringify(preview)).not.toContain('aGVsbG8=');
    expect(JSON.stringify(preview)).not.toContain('d29ybGQ=');
    expect(() => buildModelProtocolRequest({ ...options, apiKey: 'secret',
      variables: { imageUrls: ['data:image/png;base64,aGVsbG8=', '/private/image.png'] },
    })).toThrow('multipart 文件只支持 data URL');
    const empty = buildModelProtocolRequest({ ...options, apiKey: 'secret', variables: { imageUrls: [] } });
    expect(new TextDecoder().decode(empty.init.body as ArrayBuffer)).not.toContain('filename=');
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

  it('validates request encodings and response mode compatibility', () => {
    const invalidEncoding = {
      version: 1,
      mode: 'sync',
      submit: { method: 'POST', path: '/render', bodyEncoding: 'xml', body: {} },
      resultUrlPath: 'url',
    };
    const invalidAsyncResponse = {
      ...getModelProtocolPreset('agnes-video'),
      response: {
        ...getModelProtocolPreset('agnes-video').response,
        type: 'binary',
      },
    };
    const missingBase64Mime = {
      version: 1,
      mode: 'sync',
      submit: { method: 'POST', path: '/render', body: {} },
      resultBase64Path: 'data.image',
    };

    expect(validateModelExecutionProtocol(invalidEncoding)).toContain(
      '请求体编码只支持 json、form-urlencoded 或 multipart',
    );
    expect(validateModelExecutionProtocol(invalidAsyncResponse)).toContain(
      '异步协议的提交与轮询响应必须使用 JSON',
    );
    expect(validateModelExecutionProtocol(missingBase64Mime)).toContain(
      'Base64 结果必须配置 MIME 类型',
    );
  });

  it.each([
    {
      auth: { type: 'header', name: 'X-API-Key', prefix: 'Token ' },
      expectedUrl: 'https://gateway.example/v1/render',
      expectedHeaders: { 'X-API-Key': 'Token secret' },
    },
    {
      auth: { type: 'query', name: 'key' },
      expectedUrl: 'https://gateway.example/v1/render?key=secret',
      expectedHeaders: {},
    },
    {
      auth: { type: 'none' },
      expectedUrl: 'https://gateway.example/v1/render',
      expectedHeaders: {},
    },
  ])('supports $auth.type authentication without persisting the key', async ({
    auth,
    expectedUrl,
    expectedHeaders,
  }) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ url: 'https://cdn.example/image.png' }));
    vi.stubGlobal('fetch', fetchMock);
    const protocol = {
      version: 1,
      mode: 'sync',
      auth,
      submit: { method: 'POST', path: '/render', body: { prompt: '{{prompt}}' } },
      resultUrlPath: 'url',
    } as unknown as ModelExecutionProtocol;

    await executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      protocol,
      variables: { prompt: 'test' },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedUrl);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject(expectedHeaders);
    if (auth.type !== 'bearer') {
      expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
    }
    expect(JSON.stringify(protocol)).not.toContain('secret');
  });

  it('rejects dangerous static headers and invalid custom authentication names', () => {
    const protocol = {
      version: 1,
      mode: 'sync',
      auth: { type: 'header', name: 'Authorization' },
      submit: {
        method: 'POST',
        path: '/render',
        headers: { Host: 'other.example', Cookie: 'session=secret' },
      },
      resultUrlPath: 'url',
    } as unknown as ModelExecutionProtocol;

    expect(validateModelExecutionProtocol(protocol)).toEqual(expect.arrayContaining([
      expect.stringContaining('Authorization'),
      expect.stringContaining('Host'),
      expect.stringContaining('Cookie'),
    ]));
  });

  it('rejects absolute request paths and unknown template variables', () => {
    const unsafeProtocol: ModelExecutionProtocol = {
      version: 1,
      mode: 'sync',
      submit: {
        method: 'POST',
        path: 'https://other.example/generate',
        body: { prompt: '{{systemPrompt}}' },
      },
      resultUrlPath: 'data.0.url',
    };

    expect(validateModelExecutionProtocol(unsafeProtocol)).toEqual(expect.arrayContaining([
      expect.stringContaining('相对路径'),
      expect.stringContaining('systemPrompt'),
    ]));
  });

  it('rejects a persisted polling URL from a different origin', async () => {
    await expect(pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://other.example/tasks/1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 3000,
    }, 'secret', undefined, 'https://apihub.agnes-ai.com/v1')).rejects.toThrow('不同源');
  });

  it('retries a rate-limited status query without resubmitting the paid task', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 'rate_limit',
        message: 'video status query rate limit exceeded',
      }, 429))
      .mockResolvedValueOnce(jsonResponse({
        status: 'completed',
        url: 'https://cdn.example/recovered.mp4',
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://apihub.agnes-ai.com/agnesapi?video_id=video-1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 1,
    }, 'secret', undefined, 'https://apihub.agnes-ai.com/v1');

    expect(result.urls).toEqual(['https://cdn.example/recovered.mp4']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries configured transient status responses and resets after success', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'temporarily unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse({
        status: 'completed',
        url: 'https://cdn.example/recovered-from-503.mp4',
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://api.example/tasks/video-1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 1,
      retry: {
        httpStatuses: [503],
        maxRetries: 2,
        backoff: 'fixed',
        maxDelayMs: 1000,
        honorRetryAfter: true,
        retryNetworkErrors: true,
      },
    }, 'secret', undefined, 'https://api.example/v1');

    expect(result.urls).toEqual(['https://cdn.example/recovered-from-503.mp4']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After before issuing the next status query', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse(
          { message: 'slow down' },
          429,
          { 'Retry-After': '2' },
        ))
        .mockResolvedValueOnce(jsonResponse({
          status: 'completed',
          url: 'https://cdn.example/retry-after.mp4',
        }));
      vi.stubGlobal('fetch', fetchMock);

      const resultPromise = pollResolvedModelProtocol({
        method: 'GET',
        url: 'https://api.example/tasks/video-1',
        statusPath: 'status',
        successValues: ['completed'],
        failureValues: ['failed'],
        resultUrlPath: 'url',
        intervalMs: 1000,
        retry: {
          httpStatuses: [429],
          maxRetries: 1,
          backoff: 'fixed',
          maxDelayMs: 5000,
          honorRetryAfter: true,
          retryNetworkErrors: false,
        },
      }, 'secret', undefined, 'https://api.example/v1');

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(resultPromise).resolves.toMatchObject({
        urls: ['https://cdn.example/retry-after.mp4'],
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling at the configured maximum attempt count', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      status: 'processing',
    })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://api.example/tasks/video-1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 1,
      maxAttempts: 2,
    }, 'secret', undefined, 'https://api.example/v1')).rejects.toThrow('模型任务轮询超时');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes the cancellation signal to every polling request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://api.example/tasks/video-1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 1,
    }, 'secret', controller.signal, 'https://api.example/v1')).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).not.toBe(controller.signal);
  });

  it('uses the configured consecutive query retry limit', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      message: 'video status query rate limit exceeded',
    }, 429)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://api.example/tasks/video-1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 1,
      retry: {
        httpStatuses: [429],
        maxRetries: 1,
        backoff: 'fixed',
        maxDelayMs: 1000,
        honorRetryAfter: true,
        retryNetworkErrors: true,
      },
    }, 'secret', undefined, 'https://api.example/v1')).rejects.toThrow(
      'video status query rate limit exceeded',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not classify an HTTP business error message as a network transport error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'network error in upstream payload' }, 400))
      .mockResolvedValueOnce(jsonResponse({
        status: 'completed',
        url: 'https://cdn.example/should-not-be-reached.mp4',
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://api.example/tasks/video-1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 1,
      retry: {
        httpStatuses: [503],
        maxRetries: 2,
        backoff: 'fixed',
        maxDelayMs: 1000,
        honorRetryAfter: true,
        retryNetworkErrors: true,
      },
    }, 'secret', undefined, 'https://api.example/v1')).rejects.toThrow(
      'network error in upstream payload',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('validates polling limits and retry strategy fields', () => {
    const protocol = getModelProtocolPreset('agnes-video');
    Object.assign(protocol.poll!, {
      maxAttempts: 0,
      maxDurationMs: 500,
      retry: {
        httpStatuses: [99, 429, 700],
        maxRetries: 11,
        backoff: 'random',
        maxDelayMs: 500,
        honorRetryAfter: 'yes',
        retryNetworkErrors: 'yes',
      },
    });

    expect(validateModelExecutionProtocol(protocol)).toEqual(expect.arrayContaining([
      '最大轮询次数必须在 1 到 10000 之间',
      '最大轮询时长必须在 1000 到 86400000 毫秒之间',
      '重试 HTTP 状态码必须是 100 到 599 的整数',
      '连续错误重试次数必须在 0 到 10 之间',
      '重试退避策略只支持 fixed、linear 或 exponential',
      '最大重试间隔必须在 1000 到 300000 毫秒之间',
      'Retry-After 开关必须是布尔值',
      '网络错误重试开关必须是布尔值',
    ]));
  });

  it('rejects async polling with a hard-coded task id and accepts submit binding in the body', () => {
    const protocol = getModelProtocolPreset('agnes-video');
    protocol.poll!.path = '/query/video_generation/424010985738629';
    delete protocol.poll!.query;

    const bindingError =
      '异步轮询请求的 path、query 或 body 必须引用任务 ID 变量 {{submit.video_id}}，不能引用其他提交字段或写死任务 ID';
    expect(validateModelExecutionProtocol(protocol)).toContain(bindingError);

    protocol.poll!.method = 'POST';
    protocol.poll!.body = { video_id: '{{submit.video_id}}' };
    expect(validateModelExecutionProtocol(protocol)).not.toContain(bindingError);

    protocol.poll!.body = { video_id: '{{submit.status}}' };
    expect(validateModelExecutionProtocol(protocol)).toContain(bindingError);
  });

  it('stops after three consecutive rate-limited status query retries', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      code: 'rate_limit',
      message: 'video status query rate limit exceeded',
    }, 429)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollResolvedModelProtocol({
      method: 'GET',
      url: 'https://apihub.agnes-ai.com/agnesapi?video_id=video-1',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      resultUrlPath: 'url',
      intervalMs: 1,
    }, 'secret', undefined, 'https://apihub.agnes-ai.com/v1')).rejects.toThrow(
      'video status query rate limit exceeded',
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('surfaces unavailable deployments without automatically resubmitting paid generation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      error: {
        message: 'No deployments available for selected model, Try again in 5 seconds.',
        code: '429',
      },
    }, 429));
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeModelProtocol({
      apiKey: 'secret',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      protocol: getModelProtocolPreset('agnes-video'),
      variables: {
        model: 'agnes-video-v2.0',
        prompt: 'A cinematic cat',
        frames: 121,
        frames8n1: 121,
        fps: 24,
      },
    })).rejects.toThrow('暂无可用部署');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('reference media coverage in custom protocols', () => {
  const buildVideoReferences = (withOtherMedia = false, inline = false) => {
    const imageUrls = inline
      ? ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB']
      : ['https://cdn.example/a.png', 'https://cdn.example/b.png'];
    return buildGeneralVideoProtocolVariables(
      'seedance2.5 超特价10图3视3音',
      { model: 'general/video', provider: 'general', prompt: imageUrls[0] },
      {
        prompt: imageUrls[0], imageUrls,
        videoUrls: withOtherMedia ? ['https://cdn.example/reference.mp4'] : [],
        audioUrls: withOtherMedia ? ['https://cdn.example/reference.mp3'] : [],
        operation: withOtherMedia ? 'video-to-video' : 'image-to-video',
      },
    );
  };

  it.each([
    { images: '{{imageUrls}}', videos: '{{videoUrls}}', audios: '{{audioUrls}}' },
    { images: '{{referenceImageUrls}}', videos: '{{referenceVideoUrls}}', audios: '{{referenceAudioUrls}}' },
    { image_with_roles: '{{imageWithRoles}}', videos: '{{videoUrls}}', audios: '{{audioUrls}}' },
    { content: '{{seedanceContent}}' },
    { references: '{{referenceUrls}}' },
  ])('accepts all runtime aliases when the real media are delivered by %j', (body) => {
    expect(findUnusedReferenceVariables(JSON.stringify({ submit: { body } }),
      buildVideoReferences(true))).toEqual([]);
  });

  it.each([false, true])('accepts two connected images without inventing video/audio gaps (inline=%s)', (inline) => {
    expect(findUnusedReferenceVariables(JSON.stringify({
      submit: { body: { images: '{{imageUrls}}', videos: '{{videoUrls}}', audios: '{{audioUrls}}' } },
    }), buildVideoReferences(false, inline))).toEqual([]);
  });

  it('ignores Seedance prompt, type and role metadata when checking transport paths', () => {
    const variables = buildVideoReferences();
    for (const path of ['seedanceContent.0.text', 'seedanceContent.1.type', 'seedanceContent.1.role']) {
      expect(findUnusedReferenceVariables(JSON.stringify({
        submit: { body: { metadata: `{{${path}}}` } },
      }), variables)).toEqual(['referenceImageUrls']);
    }
  });

  it('preserves Seedance indexes and still requires all images for indexed transport', () => {
    const variables = buildVideoReferences();
    const source = (path: string) => JSON.stringify({ submit: { body: { images: `{{${path}}}` } } });
    expect(findUnusedReferenceVariables(source('seedanceContent.1.image_url.url'), variables))
      .toEqual(['referenceImageUrls']);
    expect(findUnusedReferenceVariables(source('seedanceContent.1'), variables))
      .toEqual(['referenceImageUrls']);
    expect(findUnusedReferenceVariables(JSON.stringify({ submit: { body: {
      first: '{{seedanceContent.1.image_url.url}}', second: '{{seedanceContent.2.image_url.url}}',
    } } }), variables)).toEqual([]);
  });

  it('reports only missing media types even when every compatibility alias is present', () => {
    expect(findUnusedReferenceVariables(JSON.stringify({
      submit: { body: { images: '{{imageUrls}}' } },
    }), buildVideoReferences(true)).sort()).toEqual(['referenceAudioUrls', 'referenceVideoUrls']);
  });

  it('submits the configured video arrays, polls and downloads with actual runtime variables', async () => {
    const protocol: ModelExecutionProtocol = {
      version: 2, mode: 'async',
      submit: { method: 'POST', path: '/v1/videos', pathMode: 'origin', body: {
        model: '{{model}}', prompt: '{{prompt}}',
        images: '{{imageUrls}}', videos: '{{videoUrls}}', audios: '{{audioUrls}}',
      } },
      response: { type: 'json', taskIdPath: 'id' },
      poll: { method: 'GET', path: '/v1/videos/{{submit.id}}', pathMode: 'origin', response: {
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'],
        result: { download: { method: 'GET', path: '/v1/videos/{{submit.id}}/content', pathMode: 'origin' } },
      } },
    };
    useAppStore.setState({ configHydrated: true, config: {
      ...useAppStore.getState().config,
      providers: { 'custom-reference-fixture': {
        apiKey: 'fixture-key', baseUrl: 'https://gateway.example/v1',
      } },
    } } as never);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'video-fixture', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'video-fixture', status: 'completed' }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'video/mp4' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const variables = buildVideoReferences(true);
    const urls = await runConfiguredModelProtocol({
      category: 'video', variables, model: {
        id: 'reference-fixture', name: 'seedance2.5 超特价10图3视3音',
        modelId: 'seedance2.5 超特价10图3视3音', category: 'video',
        providerConfigId: 'custom-reference-fixture', executionProfile: { preset: 'custom', protocol },
      },
    });
    expect([...urls]).toEqual(['data:video/mp4;base64,AQID']);
    expect(urls.mediaDownloadAccess).toEqual({ providerConfigId: 'custom-reference-fixture', origin: 'https://gateway.example' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      model: variables.model, prompt: variables.prompt,
      images: variables.imageUrls, videos: variables.videoUrls, audios: variables.audioUrls,
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://gateway.example/v1/videos', 'https://gateway.example/v1/videos/video-fixture',
      'https://gateway.example/v1/videos/video-fixture/content',
    ]);
  });

  it('flags reference media that the protocol has no field for', () => {
    const withImageField = JSON.stringify({ submit: { body: { image_urls: '{{imageUrls}}' } } });
    const textOnly = JSON.stringify({ submit: { body: { model: '{{model}}', prompt: '{{prompt}}' } } });
    const variables = {
      imageUrls: ['https://cdn.example/ref.png'],
      referenceImageUrls: ['https://cdn.example/ref.png'],
      videoUrls: [],
    };

    expect(findUnusedReferenceVariables(withImageField, variables)).toEqual([]);
    expect(findUnusedReferenceVariables(textOnly, variables).sort())
      .toEqual(['referenceImageUrls']);
    // 没有连参考素材就不该提示
    expect(findUnusedReferenceVariables(textOnly, { imageUrls: [] })).toEqual([]);
  });

  it('renders the GPT-Image gateway JSON preset with only supplied reference images', () => {
    const protocol = getModelProtocolPreset('gpt-image-gateway-json');
    expect(validateModelExecutionProtocol(protocol)).toEqual([]);
    const built = buildModelProtocolRequest({
      apiKey: 'fixture-key', baseUrl: 'https://gateway.example/v1', protocol,
      variables: { model: 'gpt-image-2', prompt: '画一只猫', size: '1024x1024', n: 1,
        imageUrls: ['https://assets.example/first.png', 'https://assets.example/second.png'] },
    });
    expect(JSON.parse(String(built.init.body))).toMatchObject({
      model: 'gpt-image-2', n: 1, response_format: 'url',
      images: ['https://assets.example/first.png', 'https://assets.example/second.png'],
    });
    expect(built.init.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
  });

  it('keeps the official, Google and xAI image choices as valid distinct requests', () => {
    const official = getModelProtocolPreset('openai-gpt-image');
    const google = getModelProtocolPreset('google-image-native');
    const xai = getModelProtocolPreset('xai-image-native');
    for (const protocol of [official, google, xai]) {
      expect(validateModelExecutionProtocol(protocol)).toEqual([]);
    }
    expect(official.submit.path).toBe('/images/generations');
    expect(official.response.result?.base64Path).toBe('data.*.b64_json');
    expect(google.submit.path).toBe('/v1beta/interactions');
    expect(google.auth).toMatchObject({ type: 'header', name: 'x-goog-api-key' });
    expect(xai.submit.path).toBe('/images/generations');
    expect(xai.auth).toMatchObject({ type: 'bearer' });
  });

  it('treats Seedance content text as prompt data and its typed media as delivered references', () => {
    const protocol = JSON.stringify({ submit: { body: { content: '{{seedanceContent}}' } } });
    expect(findUnusedReferenceVariables(protocol, {
      seedanceContent: [{ type: 'text', text: '镜头向前推进' }],
    })).toEqual([]);
    expect(findUnusedReferenceVariables(protocol, {
      seedanceContent: [
        { type: 'text', text: '镜头向前推进' },
        { type: 'image_url', image_url: { url: 'https://cdn.example/ref.png' } },
      ],
      referenceImageUrls: ['https://cdn.example/ref.png'],
    })).toEqual([]);
  });

  it('checks submit only and requires each provided media group to be consumed', () => {
    const protocol = JSON.stringify({
      submit: {
        body: { image_url: '{{imageUrls.0}}' },
      },
      poll: {
        path: '/tasks/{{submit.task_id}}',
        body: {
          video_url: '{{videoUrls.0}}',
          audio_url: '{{audioUrls.0}}',
        },
      },
    });

    expect(findUnusedReferenceVariables(protocol, {
      imageUrls: ['https://cdn.example/ref.png'],
      videoUrls: ['https://cdn.example/ref.mp4'],
      audioUrls: ['https://cdn.example/ref.mp3'],
    }).sort()).toEqual(['audioUrls', 'videoUrls']);

    const wrongGenericTransport = JSON.stringify({
      submit: { body: { references: '{{referenceUrls}}' } },
    });
    expect(findUnusedReferenceVariables(wrongGenericTransport, {
      imageUrls: ['data:image/png;base64,AAAA'],
      inlineReferences: ['data:image/png;base64,AAAA'],
    })).toEqual(['imageUrls']);
  });

  it('checks first frame, last frame and ordinary reference images independently', () => {
    const protocol = JSON.stringify({
      submit: {
        body: {
          first_frame: '{{firstImage}}',
        },
      },
    });
    expect(findUnusedReferenceVariables(protocol, {
      firstImage: 'https://cdn.example/first.png',
      lastImage: 'https://cdn.example/last.png',
      imageUrls: ['https://cdn.example/first.png', 'https://cdn.example/last.png'],
    })).toEqual(['lastImage']);

    expect(findUnusedReferenceVariables(JSON.stringify({
      submit: { body: { images: '{{imageUrls}}' } },
    }), {
      firstImage: 'https://cdn.example/first.png',
      lastImage: 'https://cdn.example/last.png',
      referenceImageUrls: ['https://cdn.example/reference.png'],
      imageUrls: [
        'https://cdn.example/first.png',
        'https://cdn.example/last.png',
        'https://cdn.example/reference.png',
      ],
    })).toEqual([]);
  });

  it('does not treat .0 as full consumption when a canonical reference array has multiple items', () => {
    const firstOnly = JSON.stringify({
      submit: {
        body: {
          image: '{{referenceImageUrls.0}}',
          video: '{{referenceVideoUrls.0}}',
          audio: '{{referenceAudioUrls.0}}',
        },
      },
    });
    const multiple = {
      referenceImageUrls: ['https://cdn.example/1.png', 'https://cdn.example/2.png'],
      referenceVideoUrls: ['https://cdn.example/1.mp4', 'https://cdn.example/2.mp4'],
      referenceAudioUrls: ['https://cdn.example/1.mp3', 'https://cdn.example/2.mp3'],
    };
    expect(findUnusedReferenceVariables(firstOnly, multiple).sort()).toEqual([
      'referenceAudioUrls',
      'referenceImageUrls',
      'referenceVideoUrls',
    ]);

    expect(findUnusedReferenceVariables(firstOnly, {
      referenceImageUrls: ['https://cdn.example/1.png'],
      referenceVideoUrls: ['https://cdn.example/1.mp4'],
      referenceAudioUrls: ['https://cdn.example/1.mp3'],
    })).toEqual([]);
  });

  it('accepts whole arrays and $forEach values as full canonical reference delivery', () => {
    const protocol = JSON.stringify({
      submit: {
        body: {
          images: '{{referenceImageUrls}}',
          content: [
            {
              $forEach: '{{referenceVideoUrls}}',
              $value: { video_url: { url: '{{referenceVideoUrls}}' } },
            },
            {
              $forEach: '{{referenceAudioUrls}}',
              $value: { audio_url: { url: '{{referenceAudioUrls}}' } },
            },
          ],
        },
      },
    });
    expect(findUnusedReferenceVariables(protocol, {
      referenceImageUrls: ['https://cdn.example/1.png', 'https://cdn.example/2.png'],
      referenceVideoUrls: ['https://cdn.example/1.mp4', 'https://cdn.example/2.mp4'],
      referenceAudioUrls: ['https://cdn.example/1.mp3', 'https://cdn.example/2.mp3'],
    })).toEqual([]);
  });

  it('does not count a $whenPresent condition as transporting the reference', () => {
    const protocol = JSON.stringify({
      submit: {
        body: {
          content: [{
            $whenPresent: '{{referenceImageUrls.0}}',
            $value: { type: 'marker' },
          }],
        },
      },
    });
    expect(findUnusedReferenceVariables(protocol, {
      referenceImageUrls: ['https://cdn.example/ref.png'],
    })).toEqual(['referenceImageUrls']);
  });

  it('reports a local conflict when capability exceeds the $forEach safety ceiling', () => {
    const protocol = {
      submit: {
        body: {
          content: [{
            $forEach: '{{referenceImageUrls}}',
            $value: { image_url: { url: '{{referenceImageUrls}}' } },
          }],
        },
      },
    };
    expect(findModelProtocolForEachCapabilityConflicts(protocol, {
      maxImageReferences: 65,
    })).toContainEqual(expect.stringContaining('maxImageReferences=65'));
    expect(findModelProtocolForEachCapabilityConflicts(protocol, {
      maxImageReferences: 64,
    })).toEqual([]);
    expect(findModelProtocolForEachCapabilityConflicts({
      submit: { body: { images: '{{referenceImageUrls}}' } },
    }, {
      maxImageReferences: 100,
    })).toEqual([]);
  });
});

describe('missing API key', () => {
  it('拦下没有 API Key 的调用，而不是发出不带 Authorization 头的请求', () => {
    const protocol = getModelProtocolPreset('openai-image');
    expect(() => buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://api.example.com/v1',
      protocol,
      variables: { model: 'm', prompt: 'p' },
    })).toThrow('还没有填写 API Key');

    // 协议明确声明不需要鉴权时照常放行
    expect(() => buildModelProtocolRequest({
      apiKey: '',
      baseUrl: 'https://api.example.com/v1',
      protocol: { ...protocol, auth: { type: 'none' } },
      variables: { model: 'm', prompt: 'p' },
    })).not.toThrow();
  });
});

describe('undeliverable reference media', () => {
  it('协议接不住参考素材时直接失败，并给出可抄的修法', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fixture transport failure'));
    vi.stubGlobal('fetch', fetchMock);
    useAppStore.setState({
      configHydrated: true,
      config: {
        ...useAppStore.getState().config,
        providers: {
          'custom-relay': {
            name: 'Relay', apiKey: 'k', baseUrl: 'https://api.example.com',
            catalogId: 'custom-openai', selectedModels: [],
          },
        },
      },
    } as never);
    const model = {
      id: 'm1',
      name: 'Seedance 900',
      modelId: 'lec-seed-2-0-900',
      category: 'video' as const,
      providerConfigId: 'custom-relay',
      executionProfile: {
        preset: 'custom' as const,
        protocol: {
          version: 2 as const,
          mode: 'async' as const,
          // 只映射第 1 项不能代表完整接收多项参考素材。
          submit: {
            method: 'POST' as const,
            path: '/v1/videos',
            body: { model: '{{model}}', prompt: '{{prompt}}', image: '{{imageUrls.0}}' },
          },
          response: { type: 'json' as const, taskIdPath: 'id' },
          poll: {
            method: 'GET' as const,
            path: '/v1/videos/{{submit.id}}',
            response: {
              statusPath: 'status',
              successValues: ['completed'],
              failureValues: ['failed'],
              result: { urlPath: 'output' },
            },
          },
        },
      },
    };

    await expect(runConfiguredModelProtocol({
      model,
      category: 'video',
      variables: {
        model: 'lec-seed-2-0-900',
        prompt: '图片1、图片2，释放法术',
        imageUrls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
      },
    })).rejects.toThrow('没有完整接收参考图');
    await expect(runConfiguredModelProtocol({
      model,
      category: 'video',
      variables: {
        model: 'lec-seed-2-0-900',
        prompt: '图片1、图片2，释放法术',
        imageUrls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
      },
    })).rejects.toThrow('无法完整发送');
    expect(fetchMock).not.toHaveBeenCalled();

    // 空参考进入模拟提交，不访问外网；同时确认前面的校验失败没有发出请求。
    await expect(runConfiguredModelProtocol({
      model,
      category: 'video',
      variables: { model: 'lec-seed-2-0-900', prompt: '释放法术', imageUrls: [] },
    })).rejects.not.toThrow('没有完整接收参考图');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('协议共享基础规则', () => {
  it('比较完整规范协议时忽略对象键序，保留数组顺序且不改写输入', () => {
    const base = getDefaultCustomProtocol('image');
    const profile = (body: ProtocolJsonValue): ModelExecutionProfile => ({
      preset: 'custom', protocol: { ...structuredClone(base), submit: { ...base.submit, body } },
    });
    const original = profile({ model: '{{model}}', prompt: '{{prompt}}', nested: { z: 2, a: 1 }, refs: ['A', 'B'] });
    const reordered = profile({ refs: ['A', 'B'], nested: { a: 1, z: 2 }, prompt: '{{prompt}}', model: '{{model}}' });
    const changed = profile({ refs: ['B', 'A'], nested: { a: 1, z: 2 }, prompt: '{{prompt}}', model: '{{model}}' });
    const before = structuredClone(original);
    const comparable = comparableProtocol(original);
    expect(comparable).toBeDefined();
    expect(comparableProtocol(reordered)).toBe(comparable);
    expect(comparableProtocol(changed)).not.toBe(comparable);
    expect(original).toEqual(before);
  });

  it('未配置、无自定义协议及原生文本协议均不产生比较键', () => {
    const profiles: Array<ModelExecutionProfile | undefined> = [
      undefined, { preset: 'custom' }, { preset: 'anthropic-chat' }, { preset: 'gemini-chat' },
    ];
    for (const profile of profiles) expect(comparableProtocol(profile)).toBeUndefined();
  });

  it('已知 JSON 保留成员类型，未知对象的成员仍是 unknown', () => {
    const known = JSON.parse('{"value":[1]}') as ProtocolJsonValue | undefined;
    if (!isRecord(known)) throw new Error('JSON 对象未被识别');
    expectTypeOf(known).toEqualTypeOf<Record<string, ProtocolJsonValue>>();
    expect(known.value).toEqual([1]);

    const unknownValue: unknown = { value: () => 'callable' };
    if (!isRecord(unknownValue)) throw new Error('对象未被识别');
    expectTypeOf(unknownValue).toEqualTypeOf<Record<string, unknown>>();
    expect(typeof unknownValue.value).toBe('function');
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
  });

  it.each(['__proto__', 'prototype', 'constructor'])('校验与响应读取均拒绝自身危险字段 %s', (segment) => {
    const payload: unknown = JSON.parse(`{"data":{"${segment}":{"url":"https://cdn.example/result.png"}}}`);
    const path = `data.${segment}.url`;
    expect(readModelProtocolPathValues(payload, path)).toEqual([]);
    const protocol = getDefaultCustomProtocol('image');
    protocol.response.result = { urlPath: path };
    expect(validateModelExecutionProtocol(protocol).some((error) => error.includes('不允许的路径片段'))).toBe(true);
  });

  it.each(['image/png\r\nInjected: yes', 'image', 'image/png; charset=utf-8'])('校验与 multipart 编码均拒绝无效 MIME %s', (mimeType) => {
    const protocol = getDefaultCustomProtocol('image');
    protocol.response.result = { base64Path: 'data.0.b64_json', mimeType };
    expect(validateModelExecutionProtocol(protocol).some((error) => error.includes('MIME'))).toBe(true);
    expect(() => serializeModelProtocolBody({
      file: { $file: 'data:image/png;base64,AA==', contentType: mimeType },
    }, 'multipart', {})).toThrow('contentType 无效');
  });
});

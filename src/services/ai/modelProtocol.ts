/**
 * Declarative model protocol parser and executor.
 * Profiles may map trusted generation variables into JSON, but cannot execute code,
 * override authorization headers, or send requests to a different origin.
 *
 * 本文件是调用协议的统一入口：实现已按职责拆到 modelProtocol* 子模块，
 * 这里只保留顶层编排（提交 / 执行）与对外 API 的再导出，外部 import 路径保持不变。
 */
import type {
  ModelExecutionProfile,
  NormalizedModelExecutionProtocol,
} from '../../types/aiTypes';
import { corsSafeFetch, logAiRequest, logAiResponse, type AiResponseLogContext } from './httpTransport';
import { redactModelProtocolMultipartPreview } from './modelProtocolBody';
import { readModelProtocolFirstScalar, readModelProtocolUrls } from './modelProtocolResponse';
import {
  ensureSuccessfulRawResponse,
  fetchSameOriginResultUrls,
  normalizeBase64Result,
  readJsonResponse,
  readSandTaskResponse,
  readMagiGatewayTaskResponse,
  readBinaryModelProtocolResult,
  redactModelProtocolError,
  throwIfDefinitiveModelResponseFailure,
} from './modelProtocolHttp';
import {
  getModelProtocolPreset,
} from './modelProtocolPresets';
import { pollResolvedModelProtocol, resolvePoll } from './modelProtocolPoll';
import {
  applyQueryAuthentication, assertModelProtocolApiKey, buildModelProtocolRequest, buildRequestInit,
  buildSameOriginUrl, renderRequestBody,
} from './modelProtocolRequest';
import {
  FOR_EACH_KEY,
  FOR_EACH_VARIABLE_ROOTS,
  FULL_TEMPLATE_RE,
  TEMPLATE_RE,
  isRecord,
} from './modelProtocolShared';
import { parseModelExecutionProtocol } from './modelProtocolValidation';
import { isSafeNativeProtocolTaskId } from '../nativeProtocolContext';
import { sandTaskRequest, validateSandTask } from './providers/sandVideoContract';
import { waitForSandRequest } from './providers/sandRateLimit';
import { magiGatewayTaskRequest, validateMagiGatewayTask } from './providers/magiVideoGateways';
import type {
  BuiltModelProtocolRequest,
  ExecuteModelProtocolOptions,
  ExecuteModelProtocolResult,
  SubmitModelProtocolOptions,
  SubmittedModelProtocol,
} from './modelProtocolTypes';

export type {
  BuildModelProtocolRequestOptions,
  BuiltModelProtocolRequest,
  ExecuteModelProtocolOptions,
  ExecuteModelProtocolResult,
  ModelProtocolRequestPreview,
  ModelProtocolVariables,
  SubmitModelProtocolOptions,
  SubmittedModelProtocol,
} from './modelProtocolTypes';

export type { ModelProtocolResponsePreviewEntry } from './modelProtocolResponse';

export { MODEL_PROTOCOL_MAX_FOR_EACH_ITEMS } from './modelProtocolShared';

export {
  getDefaultCustomProtocol,
  getModelProtocolPreset,
  getModelProtocolPresetVideoCapability,
  normalizeFrames8n1,
} from './modelProtocolPresets';

export {
  parseModelExecutionProtocol,
  previewModelProtocolResponse,
  validateModelExecutionProtocol,
} from './modelProtocolValidation';

export { buildModelProtocolRequest, previewModelProtocolRequest } from './modelProtocolRequest';

export {
  getDefaultModelProtocolPollRetryConfig,
  pollResolvedModelProtocol,
} from './modelProtocolPoll';

/** 判断序列化协议中是否引用了指定的受信模板变量。 */
export function modelProtocolUsesVariable(source: string, ...variables: string[]): boolean {
  const requested = variables.filter(Boolean);
  if (requested.length === 0) return false;
  return [...source.matchAll(TEMPLATE_RE)].some((match) => {
    const templatePath = match[1];
    return requested.some((variable) => (
      templatePath === variable || templatePath.startsWith(`${variable}.`)
    ));
  });
}

export { collectModelProtocolTemplatePaths } from './modelProtocolShared';

/** 返回协议中实际使用 `$forEach` 展开的受信数组变量。 */
export function collectModelProtocolForEachVariables(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!isRecord(item)) return;
    const source = item[FOR_EACH_KEY];
    if (typeof source === 'string') {
      const path = FULL_TEMPLATE_RE.exec(source)?.[1];
      if (path && FOR_EACH_VARIABLE_ROOTS.has(path)) found.add(path);
    }
    Object.values(item).forEach(visit);
  };
  visit(value);
  return [...found];
}

export function resolveModelExecutionProfile(
  profile: ModelExecutionProfile | undefined,
): NormalizedModelExecutionProtocol | null {
  if (!profile) return null;
  if (profile.preset === 'plugin') throw new Error('插件协议必须通过原生活动预设执行');
  // 原生文本预设经 chatApiProtocol 转换消息、工具与流式事件，不能按声明式 JSON 执行。
  if (profile.preset === 'openai-responses' || profile.preset === 'anthropic-chat' || profile.preset === 'gemini-chat') return null;
  if (profile.preset === 'custom') {
    if (!profile.protocol) throw new Error('自定义调用协议不能为空');
    return parseModelExecutionProtocol(profile.protocol);
  }
  return getModelProtocolPreset(profile.preset);
}

/** 规范化完整协议的稳定比较键；无可解析协议时返回 undefined。 */
export function comparableProtocol(profile: ModelExecutionProfile | undefined, options?: { ignorePollSchedule?: boolean }): string | undefined {
  try {
    if (profile?.preset === 'plugin') return JSON.stringify({ preset: 'plugin', pluginId: profile.plugin?.pluginId, presetId: profile.plugin?.presetId });
    const protocol = resolveModelExecutionProfile(profile);
    if (!protocol) return undefined;
    const comparable = options?.ignorePollSchedule && protocol.poll ? {
      ...protocol,
      poll: { ...protocol.poll, intervalMs: undefined, maxAttempts: undefined, maxDurationMs: undefined, retry: undefined },
    } : protocol;
    return JSON.stringify(comparable, (_key, value: unknown) => (
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value
    ));
  } catch {
    return undefined;
  }
}

/** 文件已经准备好时，只渲染表单字段；上传时再把对应的文件流放进去。 */
export function prepareRelayonVideoSubmission(options: SubmitModelProtocolOptions) {
  if (!options.relayonUpload) throw new Error('万象视频上传缺少已准备的文件');
  const protocol = parseModelExecutionProtocol(options.protocol);
  const { submit, auth } = protocol;
  if (submit.method !== 'POST' || submit.bodyEncoding !== 'multipart') throw new Error('万象视频上传需要文件表单');
  assertModelProtocolApiKey(auth, options.apiKey);
  const renderedBody = renderRequestBody(submit, options.variables);
  if (!isRecord(renderedBody)) throw new Error('万象视频上传缺少表单字段');
  const url = buildSameOriginUrl(options.baseUrl, submit, options.variables);
  const init = buildRequestInit(submit, auth, options.apiKey, options.variables, undefined, options.signal, options.idempotencyKey);
  const built = { protocol, url: applyQueryAuthentication(url, auth, options.apiKey), init, renderedBody };
  return { renderedBody, submit: () => submitBuiltModelProtocol(options, built) };
}

export async function submitModelProtocol(options: SubmitModelProtocolOptions): Promise<SubmittedModelProtocol> {
  if (options.relayonUpload) return prepareRelayonVideoSubmission(options).submit();
  return submitBuiltModelProtocol(options, buildModelProtocolRequest(options));
}

async function submitBuiltModelProtocol(options: SubmitModelProtocolOptions, built: BuiltModelProtocolRequest): Promise<SubmittedModelProtocol> {
  const protocol = built.protocol;
  const sand = sandTaskRequest(built.url, built.init.method);
  const gateway = protocol.poll?.magiGateway === true ? magiGatewayTaskRequest(built.url, built.init.method)?.gateway : undefined;
  if (protocol.poll?.magiGateway === true && (!gateway || protocol.mode !== 'async'
    || protocol.response.taskIdPath !== gateway.idPath || options.relayonUpload)) {
    throw new Error('MAGI-2 需要匹配的异步 JSON 任务协议');
  }
  if (sand) {
    if (protocol.mode !== 'async' || protocol.response.taskIdPath !== 'id' || options.relayonUpload) throw new Error('Sand AI 需要异步 JSON 任务协议');
    await waitForSandRequest(sand.site.origin, 'create', options.signal);
  }
  const context: Record<string, unknown> = { ...options.variables };
  if (options.beforeSubmit) {
    await options.beforeSubmit();
    options.signal?.throwIfAborted();
  }
  const traceId = import.meta.env.DEV && !options.sensitive && !sand && !gateway
    ? globalThis.crypto?.randomUUID?.() ?? `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` : undefined;
  const debug: AiResponseLogContext = { url: built.url, method: built.init.method,
    source: 'Model Protocol', traceId, apiKey: options.apiKey, sensitive: options.sensitive };
  // 只在真实提交点展示渲染后的值，不在预览/预检时冒充已发出的请求。
  const requestDebug = traceId ? { traceId, stage: 'submit' as const, apiKey: options.apiKey,
    bodyEncoding: protocol.submit.bodyEncoding ?? 'json',
    body: !options.relayonUpload && protocol.submit.bodyEncoding === 'multipart' && built.renderedBody !== undefined
      ? redactModelProtocolMultipartPreview(built.renderedBody) : built.renderedBody } : undefined;
  let response: Response;
  if (options.relayonUpload && built.renderedBody !== undefined) {
    if (requestDebug) logAiRequest(built.url, built.init, 'Model Protocol', requestDebug);
    response = await options.relayonUpload.submit(built.url, built.init, built.renderedBody, options.signal);
  } else if (sand || gateway) {
    response = await corsSafeFetch(built.url, { ...built.init, redirect: 'error', credentials: 'omit',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) },
    { sensitive: true, ...(gateway ? { magiGateway: true } : {}) });
  } else {
    response = await (options.sensitive ? corsSafeFetch(built.url, built.init, { sensitive: true })
      : requestDebug ? corsSafeFetch(built.url, built.init, { debug: requestDebug })
        : corsSafeFetch(built.url, built.init));
  }
  const responseConfig = protocol.response;

  if (protocol.mode === 'sync') {
    if (responseConfig.type === 'text') {
      await ensureSuccessfulRawResponse(response, '模型请求失败', responseConfig.errorPath, options.apiKey, debug);
      const text = await response.text();
      logAiResponse(response, text, debug);
      if (!text) throw new Error('模型响应中未找到文本结果');
      return { text };
    }
    if (responseConfig.type === 'binary') {
      await ensureSuccessfulRawResponse(response, '模型请求失败', responseConfig.errorPath, options.apiKey, debug);
      const url = await readBinaryModelProtocolResult(response, responseConfig.result?.mimeType, options.signal);
      logAiResponse(response, { type: 'binary', mimeType: responseConfig.result?.mimeType ?? response.headers.get('content-type'),
        encodedLength: url.length }, debug);
      return { urls: [url] };
    }
    const payload = await readJsonResponse(response, '模型请求失败', responseConfig.errorPath, options.apiKey, debug);
    try {
      options.validateResponse?.(payload);
    } catch (error) {
      throw redactModelProtocolError(error, options.apiKey);
    }
    const resultConfig = responseConfig.result!;
    let urls = resultConfig.urlPath ? readModelProtocolUrls(payload, resultConfig.urlPath) : [];
    if (resultConfig.fetchUrl) {
      urls = await fetchSameOriginResultUrls(
        urls,
        options.baseUrl,
        protocol.auth,
        options.apiKey,
        resultConfig.mimeType,
        options.signal,
        undefined,
        options.sensitive,
      );
    }
    const base64Urls = resultConfig.base64Path
      ? readModelProtocolUrls(payload, resultConfig.base64Path).map((value) =>
          normalizeBase64Result(value, resultConfig.mimeType!, resultConfig.base64Transform))
      : [];
    const textValue = resultConfig.textPath
      ? readModelProtocolFirstScalar(payload, resultConfig.textPath)
      : undefined;
    const text = textValue === undefined || textValue === null ? undefined : String(textValue);
    const mediaUrls = [...urls, ...base64Urls];
    if (mediaUrls.length === 0 && !text) {
      throwIfDefinitiveModelResponseFailure(payload, response.status, responseConfig.errorPath, options.apiKey);
      throw new Error('模型响应中未找到配置的结果');
    }
    return {
      ...(mediaUrls.length > 0 ? { urls: mediaUrls } : {}),
      ...(text ? { text } : {}),
    };
  }

  let payload: unknown = sand ? await readSandTaskResponse(response, 'create', sand.createStatus)
    : gateway ? await readMagiGatewayTaskResponse(response, gateway.name, gateway.createStatuses)
    : await readJsonResponse(response, '模型请求失败', responseConfig.errorPath, options.apiKey, debug);
  try {
    if (sand) validateSandTask(payload, undefined, options.apiKey);
    if (gateway) validateMagiGatewayTask(gateway, payload, undefined, options.apiKey);
    options.validateResponse?.(payload);
    if (options.normalizeSubmitResponse) payload = options.normalizeSubmitResponse(payload);
  } catch (error) {
    throw redactModelProtocolError(error, options.apiKey);
  }
  const taskIdValue = readModelProtocolFirstScalar(payload, responseConfig.taskIdPath!);
  if (!(typeof taskIdValue === 'string' && taskIdValue.trim())
    && !(typeof taskIdValue === 'number' && Number.isFinite(taskIdValue))) {
    throwIfDefinitiveModelResponseFailure(payload, response.status, responseConfig.errorPath, options.apiKey);
    throw new Error(`模型提交响应中未找到任务 ID：${responseConfig.taskIdPath}`);
  }
  const pollContext = { ...context, submit: payload };
  try {
    return {
      taskId: String(taskIdValue),
      ...(options.captureRecoveryContext ? { recoveryContext: options.captureRecoveryContext(payload) } : {}),
      poll: resolvePoll(options.baseUrl, protocol.poll!, protocol.auth, pollContext),
    };
  } catch (error) {
    // 任务已获服务商ID；恢复字段校验失败也不能把已付费请求误记为无ID。
    if (options.captureRecoveryContext) throw Object.assign(new Error('原任务已提交，但查询恢复字段不能安全保存',
      { cause: redactModelProtocolError(error, options.apiKey) }),
      isSafeNativeProtocolTaskId(String(taskIdValue), [options.apiKey]) ? { nativeTaskId: String(taskIdValue) } : {});
    throw error;
  }
}

export async function executeModelProtocol(
  options: ExecuteModelProtocolOptions,
): Promise<ExecuteModelProtocolResult> {
  const submitted = await submitModelProtocol(options);
  if (submitted.urls) return { urls: submitted.urls };
  if (submitted.text) return { text: submitted.text };
  if (!submitted.poll) throw new Error('异步调用协议未生成轮询配置');
  return {
    ...await pollResolvedModelProtocol(
      submitted.poll,
      options.apiKey,
      options.signal,
      options.baseUrl,
      undefined,
      options.sensitive,
      submitted.taskId,
    ),
    taskId: submitted.taskId,
  };
}

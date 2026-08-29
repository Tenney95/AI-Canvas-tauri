/**
 * ai/modelProtocolPoll — 异步协议的轮询执行与重试。
 *
 * 轮询请求同样强制同源（调用方传入 allowedBaseUrl 时再校验一次），
 * 只对瞬时网络错误与可重试 HTTP 状态码退避重试，避免把业务错误也重放一遍。
 */
import { pollTask } from '../pollTask';
import type {
  ModelProtocolAuthConfig,
  ModelProtocolPollRetryConfig,
  ModelProtocolPollTemplate,
  ProtocolJsonValue,
  ResolvedModelProtocolPoll,
} from '../../types/aiTypes';
import { serializeModelProtocolBody } from './modelProtocolBody';
import { corsSafeFetch } from './httpTransport';
import {
  ModelProtocolHttpError,
  fetchSameOriginResultUrls,
  normalizeBase64Result,
  readJsonResponse,
} from './modelProtocolHttp';
import { readModelProtocolFirstScalar, readModelProtocolUrls } from './modelProtocolResponse';
import {
  applyQueryAuthentication,
  assertSerializedBodyWithinLimit,
  buildSameOriginUrl,
  renderRequestBody,
  renderRequestHeaders,
} from './modelProtocolRequest';
import {
  DEFAULT_MAX_QUERY_RETRIES,
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_RETRY_HTTP_STATUSES,
  resolveAuthentication,
  validateHeaderName,
} from './modelProtocolShared';
import type { ExecuteModelProtocolResult } from './modelProtocolTypes';
import { validateAuthentication } from './modelProtocolValidation';

export function resolvePoll(
  baseUrl: string,
  poll: ModelProtocolPollTemplate,
  auth: ModelProtocolAuthConfig | undefined,
  context: Record<string, unknown>,
): ResolvedModelProtocolPoll {
  if (poll.bodyEncoding === 'multipart') {
    throw new Error('异步轮询请求不支持 multipart 请求体');
  }
  const headers = renderRequestHeaders(poll, { type: 'none' }, '', context);
  const body = renderRequestBody(poll, context);
  if (poll.method !== 'GET' && body !== undefined) {
    const serializedBody = serializeModelProtocolBody(body, poll.bodyEncoding, headers);
    assertSerializedBodyWithinLimit(poll, serializedBody, '轮询请求体');
  }
  const response = poll.response;
  const result = response.result;
  return {
    method: poll.method,
    url: buildSameOriginUrl(baseUrl, poll, context),
    auth: structuredClone(resolveAuthentication(auth)),
    headers,
    bodyEncoding: poll.bodyEncoding,
    body,
    statusPath: response.statusPath,
    successValues: [...response.successValues],
    failureValues: [...response.failureValues],
    resultUrlPath: result.urlPath,
    resultTextPath: result.textPath,
    resultBase64Path: result.base64Path,
    resultMimeType: result.mimeType,
    resultBase64Transform: result.base64Transform
      ? structuredClone(result.base64Transform)
      : undefined,
    resultFetchUrl: result.fetchUrl,
    errorPath: response.errorPath,
    progressPath: response.progressPath,
    intervalMs: poll.intervalMs ?? 3000,
    maxAttempts: poll.maxAttempts,
    maxDurationMs: poll.maxDurationMs,
    retry: poll.retry ? structuredClone(poll.retry) : undefined,
  };
}

function normalizeStatus(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : String(value ?? '').toLowerCase();
}

export function getDefaultModelProtocolPollRetryConfig(): Required<ModelProtocolPollRetryConfig> {
  return {
    httpStatuses: [...DEFAULT_RETRY_HTTP_STATUSES],
    maxRetries: DEFAULT_MAX_QUERY_RETRIES,
    backoff: 'fixed',
    maxDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
    honorRetryAfter: true,
    retryNetworkErrors: true,
  };
}

function resolvePollRetryConfig(
  value: ModelProtocolPollRetryConfig | undefined,
): Required<ModelProtocolPollRetryConfig> {
  const defaults = getDefaultModelProtocolPollRetryConfig();
  return {
    ...defaults,
    ...value,
    httpStatuses: value?.httpStatuses ?? defaults.httpStatuses,
  };
}

function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (
    typeof DOMException !== 'undefined'
    && error instanceof DOMException
    && ['NetworkError', 'TimeoutError'].includes(error.name)
  ) {
    return true;
  }
  return error instanceof Error
    && /failed to fetch|network error|connection (?:closed|reset)|timed? out/i.test(error.message);
}

function calculateRetryDelayMs(
  intervalMs: number,
  retryCount: number,
  retry: Required<ModelProtocolPollRetryConfig>,
  retryAfterMs?: number,
): number {
  const multiplier = retry.backoff === 'exponential'
    ? 2 ** Math.max(0, retryCount - 1)
    : retry.backoff === 'linear'
      ? retryCount
      : 1;
  const backoffDelay = intervalMs * multiplier;
  const requestedDelay = retry.honorRetryAfter && retryAfterMs !== undefined
    ? Math.max(backoffDelay, retryAfterMs)
    : backoffDelay;
  return Math.max(intervalMs, Math.min(retry.maxDelayMs, requestedDelay));
}

async function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  if (signal?.aborted) throw new Error('任务已被取消');
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('任务已被取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function buildResolvedRequestInit(
  poll: ResolvedModelProtocolPoll,
  apiKey: string,
): RequestInit {
  const errors: string[] = [];
  validateAuthentication(poll.auth, errors);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(poll.headers ?? {})) {
    validateHeaderName(name, '轮询请求 ', errors);
    headers[name] = value;
  }
  if (errors.length > 0) throw new Error(errors[0]);

  const auth = resolveAuthentication(poll.auth);
  if (apiKey && auth.type === 'bearer') {
    headers.Authorization = `${auth.prefix ?? 'Bearer '}${apiKey}`;
  } else if (apiKey && auth.type === 'header') {
    headers[auth.name!] = `${auth.prefix ?? ''}${apiKey}`;
  }
  const body = poll.method === 'GET' || poll.body === undefined
    ? undefined
    : serializeModelProtocolBody(poll.body, poll.bodyEncoding, headers);
  return {
    method: poll.method,
    headers,
    body,
  };
}

export async function pollResolvedModelProtocol(
  poll: ResolvedModelProtocolPoll,
  apiKey: string,
  signal?: AbortSignal,
  allowedBaseUrl?: string,
): Promise<ExecuteModelProtocolResult> {
  if (allowedBaseUrl) {
    const pollUrl = new URL(poll.url);
    const baseUrl = new URL(allowedBaseUrl);
    if (pollUrl.origin !== baseUrl.origin) {
      throw new Error('轮询地址与厂商连接地址不同源');
    }
  }
  const successValues = new Set(poll.successValues.map(normalizeStatus));
  const failureValues = new Set(poll.failureValues.map(normalizeStatus));
  const retry = resolvePollRetryConfig(poll.retry);
  const retryHttpStatuses = new Set(retry.httpStatuses);
  const pollStartedAt = Date.now();
  let consecutiveErrors = 0;
  let pendingExtraDelayMs = 0;
  const result = await pollTask<ProtocolJsonValue, ExecuteModelProtocolResult>({
    fetchState: async () => {
      if (pendingExtraDelayMs > 0) {
        const maxDurationMs = poll.maxDurationMs ?? Infinity;
        if (Date.now() - pollStartedAt + pendingExtraDelayMs >= maxDurationMs) {
          throw new Error('模型任务轮询超时');
        }
        const delayMs = pendingExtraDelayMs;
        pendingExtraDelayMs = 0;
        await waitForRetryDelay(delayMs, signal);
      }
      try {
        const response = await corsSafeFetch(
          applyQueryAuthentication(poll.url, poll.auth, apiKey),
          {
            ...buildResolvedRequestInit(poll, apiKey),
            signal,
          },
        );
        const payload = await readJsonResponse(response, '模型任务查询失败', poll.errorPath);
        consecutiveErrors = 0;
        return payload;
      } catch (error) {
        const retryAfterMs = error instanceof ModelProtocolHttpError ? error.retryAfterMs : undefined;
        const retryableHttpError = error instanceof ModelProtocolHttpError
          && retryHttpStatuses.has(error.status);
        const retryableNetworkError = retry.retryNetworkErrors
          && !(error instanceof ModelProtocolHttpError)
          && isTransientNetworkError(error);
        if ((retryableHttpError || retryableNetworkError) && consecutiveErrors < retry.maxRetries) {
          consecutiveErrors += 1;
          const retryDelayMs = calculateRetryDelayMs(
            poll.intervalMs,
            consecutiveErrors,
            retry,
            retryAfterMs,
          );
          pendingExtraDelayMs = Math.max(0, retryDelayMs - poll.intervalMs);
          return {};
        }
        throw error;
      }
    },
    isComplete: (payload) => {
      const status = normalizeStatus(readModelProtocolFirstScalar(payload, poll.statusPath));
      if (!successValues.has(status)) return null;
      const urls = poll.resultUrlPath ? readModelProtocolUrls(payload, poll.resultUrlPath) : [];
      const base64Urls = poll.resultBase64Path
        ? readModelProtocolUrls(payload, poll.resultBase64Path).map((value) =>
            normalizeBase64Result(value, poll.resultMimeType!, poll.resultBase64Transform))
        : [];
      const textValue = poll.resultTextPath
        ? readModelProtocolFirstScalar(payload, poll.resultTextPath)
        : undefined;
      const text = textValue === undefined || textValue === null ? undefined : String(textValue);
      const mediaUrls = [...urls, ...base64Urls];
      if (mediaUrls.length === 0 && !text) throw new Error('模型任务完成但未返回配置的结果');
      return {
        ...(mediaUrls.length > 0 ? { urls: mediaUrls } : {}),
        ...(text ? { text } : {}),
      };
    },
    isFailed: (payload) => {
      const status = normalizeStatus(readModelProtocolFirstScalar(payload, poll.statusPath));
      if (!failureValues.has(status)) return null;
      const detail = poll.errorPath ? readModelProtocolFirstScalar(payload, poll.errorPath) : undefined;
      return `模型任务失败：${detail || status}`;
    },
    interval: poll.intervalMs,
    maxAttempts: poll.maxAttempts,
    maxDuration: poll.maxDurationMs,
    timeoutMsg: '模型任务轮询超时',
    signal,
  });
  if (result.urls && poll.resultFetchUrl) {
    if (!allowedBaseUrl) throw new Error('同源结果下载缺少厂商连接地址');
    return {
      ...result,
      urls: await fetchSameOriginResultUrls(
        result.urls,
        allowedBaseUrl,
        poll.auth,
        apiKey,
        poll.resultMimeType,
        signal,
      ),
    };
  }
  return result;
}

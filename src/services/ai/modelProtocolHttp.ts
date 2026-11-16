/**
 * ai/modelProtocolHttp — 协议执行过程中的 HTTP 细节与结果解码。
 *
 * 错误响应按协议声明的 errorPath 抽取上游文案；结果下载强制同源，
 * Base64 / PCM 结果在前端转成 data URL，避免把二进制处理散落到各调用方。
 */
import type { ModelProtocolAuthConfig, ModelProtocolResultConfig, ProtocolJsonValue } from '../../types/aiTypes';
import { corsSafeFetch } from './httpTransport';
import { readModelProtocolFirstScalar } from './modelProtocolResponse';
import { MIME_TYPE_RE, isRecord, resolveAuthentication, validateHeaderName } from './modelProtocolShared';
import { applyQueryAuthentication } from './modelProtocolRequest';
import { PollTaskFailedError, PollTimeoutError, withPollRequestDeadline } from '../pollTask';
import { parseRasterImageDimensions } from '../rasterImageDimensions';
import { classifyHttpResponseFailure, getHttpResponseError, HttpResponseError } from './httpUtils';

const RESULT_MAX_BYTES = 64 * 1024 * 1024;
const RESULT_TOTAL_MAX_BYTES = 128 * 1024 * 1024;
const RESULT_MAX_COUNT = 32;

interface BinaryResultBudget {
  usedBytes: number;
  maxBytes: number;
}

export class ModelProtocolHttpError extends HttpResponseError {
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    message: string,
    retryAfterMs?: number,
    definitiveFailure = classifyHttpResponseFailure(status, undefined),
  ) {
    super(status, message, definitiveFailure);
    this.name = 'ModelProtocolHttpError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** 只移除本次连接的凭据，保留错误状态和上游的其他诊断信息。 */
export function redactModelProtocolErrorText(message: string, apiKey: string): string {
  if (!apiKey) return message;
  // 查询鉴权用表单规则编码，空格和部分标点与 encodeURIComponent 不同。
  const formEncoded = new URLSearchParams({ key: apiKey }).toString().slice('key='.length);
  const secrets = [...new Set([apiKey, encodeURIComponent(apiKey), formEncoded])]
    .sort((left, right) => right.length - left.length);
  return secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), message);
}

/** 验证器也可能回显 Key；重建异常，避免修改冻结对象或带出原始 cause 和堆栈。 */
export function redactModelProtocolError(error: unknown, apiKey: string): unknown {
  const exception = typeof DOMException !== 'undefined' && error instanceof DOMException ? error : undefined;
  const message = error instanceof Error ? error.message : exception?.message ?? (typeof error === 'string' ? error : undefined);
  if (message === undefined) return error;
  const safeMessage = redactModelProtocolErrorText(message, apiKey);
  const httpError = getHttpResponseError(error);
  const sensitiveHttpCause = httpError && httpError !== error
    && redactModelProtocolErrorText(httpError.message, apiKey) !== httpError.message;
  if (safeMessage === message && !sensitiveHttpCause) return error;
  if (typeof error === 'string') return safeMessage;
  if (error instanceof ModelProtocolHttpError) return new ModelProtocolHttpError(error.status, safeMessage, error.retryAfterMs, error.definitiveFailure);
  if (httpError instanceof ModelProtocolHttpError) return new ModelProtocolHttpError(httpError.status, safeMessage, httpError.retryAfterMs, httpError.definitiveFailure);
  if (httpError) return new HttpResponseError(httpError.status, safeMessage, httpError.definitiveFailure);
  if (error instanceof PollTaskFailedError) return new PollTaskFailedError(safeMessage);
  if (error instanceof PollTimeoutError) return new PollTimeoutError(safeMessage);
  if (exception) return new DOMException(safeMessage, redactModelProtocolErrorText(exception.name, apiKey));
  const safeError = error instanceof TypeError ? new TypeError(safeMessage) : new Error(safeMessage);
  if (error instanceof Error) safeError.name = redactModelProtocolErrorText(error.name, apiKey);
  return safeError;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

/** 仅在提交没有交付结果或任务 ID 时调用，不能把可用结果旁的诊断字段当成拒绝。 */
export function throwIfDefinitiveModelResponseFailure(
  payload: unknown,
  status: number,
  errorPath?: string,
  apiKey = '',
): void {
  if (!classifyHttpResponseFailure(status, payload)) return;
  const configured = errorPath && (isRecord(payload) || Array.isArray(payload))
    ? readModelProtocolFirstScalar(payload, errorPath) : undefined;
  const record = isRecord(payload) ? payload : undefined;
  const error = record && isRecord(record.error) ? record.error : undefined;
  const detail = [configured, error?.message, record?.message, record?.msg]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  throw new ModelProtocolHttpError(status,
    redactModelProtocolErrorText(detail?.trim() || '模型请求已被平台明确拒绝或执行失败', apiKey), undefined, true);
}

export async function readJsonResponse(
  response: Response,
  label: string,
  errorPath?: string,
  apiKey = '',
): Promise<ProtocolJsonValue> {
  if (!response.ok) {
    const rawText = await response.text().catch(() => '');
    let payload: unknown;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }
    const configuredMessage = errorPath && (isRecord(payload) || Array.isArray(payload))
      ? readModelProtocolFirstScalar(payload, errorPath)
      : undefined;
    const message = configuredMessage !== undefined && configuredMessage !== null
      ? String(configuredMessage)
      : isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
        ? payload.error.message
        : isRecord(payload) && typeof payload.message === 'string'
          ? payload.message
          : rawText.trim() || `${label} (${response.status})`;
    if (response.status === 429 && /no deployments available/i.test(message)) {
      throw new ModelProtocolHttpError(response.status, '所选模型暂无可用部署，请稍后手动重试（429）',
        parseRetryAfterMs(response.headers.get('Retry-After')), classifyHttpResponseFailure(response.status, payload));
    }
    throw new ModelProtocolHttpError(
      response.status,
      `${label} (${response.status}): ${redactModelProtocolErrorText(message, apiKey)}`,
      parseRetryAfterMs(response.headers.get('Retry-After')),
      classifyHttpResponseFailure(response.status, payload),
    );
  }
  const payload = await response.json().catch(() => null) as unknown;
  if (!isRecord(payload) && !Array.isArray(payload)) {
    throw new Error(`${label}：响应必须是 JSON 对象或数组`);
  }
  return payload as ProtocolJsonValue;
}

export async function ensureSuccessfulRawResponse(
  response: Response,
  label: string,
  errorPath?: string,
  apiKey = '',
): Promise<Response> {
  if (response.ok) return response;
  await readJsonResponse(response, label, errorPath, apiKey);
  return response;
}

export function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64Bytes(value: string): Uint8Array {
  const encoded = /^data:[^;,]+;base64,/i.test(value)
    ? value.slice(value.indexOf(',') + 1)
    : value;
  const normalized = encoded.replace(/\s/g, '');
  try {
    const binary = atob(normalized);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error('模型响应中的 Base64 结果无效');
  }
}

export function pcmS16LeToWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  if (pcm.byteLength % blockAlign !== 0) {
    throw new Error('模型响应中的 PCM 数据长度与声道配置不匹配');
  }
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      wav[offset + index] = value.charCodeAt(index);
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

export function normalizeBase64Result(
  value: string,
  mimeType: string,
  transform?: ModelProtocolResultConfig['base64Transform'],
): string {
  if (transform?.type === 'pcm-s16le-to-wav') {
    const wav = pcmS16LeToWav(
      decodeBase64Bytes(value),
      transform.sampleRate,
      transform.channels ?? 1,
    );
    return `data:audio/wav;base64,${encodeBytesBase64(wav)}`;
  }
  if (/^data:[^;,]+;base64,/i.test(value)) return value;
  return `data:${mimeType};base64,${encodeBytesBase64(decodeBase64Bytes(value))}`;
}

async function resolveBinaryMimeType(
  bytes: Uint8Array,
  contentType: string | null,
  fallbackMimeType?: string,
  signal?: AbortSignal,
): Promise<string> {
  const responseMime = contentType?.split(';')[0]?.trim().toLowerCase();
  const declaredMime = responseMime && MIME_TYPE_RE.test(responseMime)
    && !['application/octet-stream', 'binary/octet-stream', 'application/binary'].includes(responseMime)
    ? responseMime : undefined;
  const header = bytes.subarray(0, 1024 * 1024);
  let textStart = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (textStart < bytes.length && [9, 10, 13, 32].includes(bytes[textStart])) textStart += 1;
  const prefix = new TextDecoder().decode(bytes.subarray(textStart, textStart + 4096)).trimStart();
  // 有些网关返回 200，甚至沿用媒体头；错误正文仍不能作为生成结果保存。
  if (/^[{["]/.test(prefix) || /^(?:true|false|null)(?:\s|$)|^-?\d/.test(prefix)
    || /^(?:<\?xml\b[^>]*>\s*)?(?:<!doctype\s+html\b|<(?:html|head|body|script|error)\b)/i.test(prefix)
    || (declaredMime && /^(?:application\/(?:[^/]+\+)?json|text\/html)$/.test(declaredMime))) {
    throw new Error('模型二进制结果实际返回了 JSON 或 HTML，请检查厂商响应的 MIME 与结果映射');
  }

  if (parseRasterImageDimensions(header)) {
    const ascii = (start: number, length: number) => String.fromCharCode(...header.subarray(start, start + length));
    if (ascii(1, 3) === 'PNG') return 'image/png';
    if (header[0] === 0xff && header[1] === 0xd8) return 'image/jpeg';
    if (ascii(0, 3) === 'GIF') return 'image/gif';
    if (ascii(0, 4) === 'RIFF') return 'image/webp';
    if (ascii(0, 2) === 'BM') return 'image/bmp';
    if (/^(?:<\?xml\b[^>]*>\s*)?<svg\b/i.test(prefix)) return 'image/svg+xml';
  }
  // 通用 MIME 只按真实内容识别；只探测本地字节，不解析会再次联网的 HLS 清单。
  const { Input, BufferSource, ALL_FORMATS, HLS } = await import('mediabunny');
  signal?.throwIfAborted();
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS.filter((format) => format !== HLS) });
  const cancel = () => input.dispose();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const tracks = await input.getTracks();
    const mimeType = tracks.length ? (await input.getMimeType()).split(';')[0].trim().toLowerCase() : '';
    signal?.throwIfAborted();
    if (/^(?:audio|video)\//.test(mimeType)) return mimeType;
  } catch {
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener('abort', cancel);
    input.dispose();
  }
  if (declaredMime) return declaredMime;
  if (fallbackMimeType && /^(?:image|audio|video)\//i.test(fallbackMimeType)) {
    throw new Error('无法从模型二进制内容识别媒体类型，不能仅按配置 MIME 交付结果');
  }
  return fallbackMimeType ?? 'application/octet-stream';
}

/** 成功和失败响应共用字节预算；不相信 Content-Length，也不先整包读入内存。 */
async function readBinaryResultBytes(
  response: Response,
  signal?: AbortSignal,
  budget: BinaryResultBudget = { usedBytes: 0, maxBytes: RESULT_MAX_BYTES },
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) { signal?.throwIfAborted(); return new Uint8Array(); }
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  let complete = false;
  try {
    signal?.throwIfAborted();
    const assertSize = (size: number) => {
      if (size > RESULT_MAX_BYTES) throw new Error('模型单个二进制结果超过 64 MiB，请改用结果 URL 或原生文件下载');
      if (budget.usedBytes + size > budget.maxBytes) throw new Error('模型二进制结果累计超过下载预算，请减少结果数量或改用结果 URL');
    };
    const contentLength = Number(response.headers.get('Content-Length'));
    if (Number.isSafeInteger(contentLength) && contentLength >= 0) assertSize(contentLength);
    const parts: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (totalBytes + value.byteLength > RESULT_MAX_BYTES) assertSize(RESULT_MAX_BYTES + 1);
      assertSize(value.byteLength);
      totalBytes += value.byteLength;
      budget.usedBytes += value.byteLength;
      parts.push(value);
    }
    complete = true;
    const bytes = parts.length === 1 ? parts[0] : new Uint8Array(totalBytes);
    if (parts.length > 1) {
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    }
    return bytes;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

export async function readBinaryModelProtocolResult(
  response: Response,
  fallbackMimeType?: string,
  signal?: AbortSignal,
  budget?: BinaryResultBudget,
): Promise<string> {
  const bytes = await readBinaryResultBytes(response, signal, budget);
  if (!bytes.length) throw new Error('模型二进制结果内容为空');
  const mimeType = await resolveBinaryMimeType(bytes, response.headers.get('Content-Type'), fallbackMimeType, signal);
  signal?.throwIfAborted();
  return `data:${mimeType};base64,${encodeBytesBase64(bytes)}`;
}

function buildResultAuthenticationHeaders(
  auth: ModelProtocolAuthConfig | undefined,
  apiKey: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  if (extraHeaders !== undefined && !isRecord(extraHeaders)) throw new Error('结果下载请求头必须是 JSON 对象');
  const headers: Record<string, string> = {};
  const errors: string[] = [];
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    validateHeaderName(name, '结果下载请求 ', errors);
    if (typeof value !== 'string') errors.push('结果下载请求头的值必须是字符串');
    headers[name] = value;
  }
  if (errors.length > 0) throw new Error(errors[0]);
  if (!apiKey) return headers;
  const resolvedAuth = resolveAuthentication(auth);
  if (resolvedAuth.type === 'bearer') {
    headers.Authorization = `${resolvedAuth.prefix ?? 'Bearer '}${apiKey}`;
  }
  if (resolvedAuth.type === 'header') {
    headers[resolvedAuth.name!] = `${resolvedAuth.prefix ?? ''}${apiKey}`;
  }
  return headers;
}

export async function fetchSameOriginResultUrls(
  urls: readonly string[],
  baseUrl: string,
  auth: ModelProtocolAuthConfig | undefined,
  apiKey: string,
  fallbackMimeType?: string,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
  sensitive = false,
): Promise<string[]> {
  signal?.throwIfAborted();
  if (urls.length > RESULT_MAX_COUNT) throw new Error('模型结果下载数量超过 32 个，请收窄结果 URL 映射');
  const headers = buildResultAuthenticationHeaders(auth, apiKey, extraHeaders);
  const allowedOrigin = new URL(baseUrl).origin;
  const resultUrls = urls.map((rawUrl) => {
    const url = new URL(rawUrl);
    if (url.origin !== allowedOrigin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('模型结果下载地址与厂商连接地址不同源');
    }
    return applyQueryAuthentication(url.toString(), auth, apiKey);
  });
  const controller = new AbortController();
  const downloadSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const budget = { usedBytes: 0, maxBytes: RESULT_TOTAL_MAX_BYTES };
  const results = new Array<string>(urls.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && nextIndex < resultUrls.length) {
      const index = nextIndex++;
      try {
        downloadSignal.throwIfAborted();
        const init = { method: 'GET', headers, signal: downloadSignal };
        const request = sensitive ? corsSafeFetch(resultUrls[index], init, { sensitive: true })
          : corsSafeFetch(resultUrls[index], init);
        void request.then((response) => {
          if (downloadSignal.aborted) void response.body?.cancel().catch(() => undefined);
        }, () => undefined);
        const response = await withPollRequestDeadline(() => request, downloadSignal, Infinity);
        if (downloadSignal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          downloadSignal.throwIfAborted();
        }
        if (!response.ok) {
          const bytes = await readBinaryResultBytes(response, downloadSignal, budget);
          downloadSignal.throwIfAborted();
          await ensureSuccessfulRawResponse(new Response(bytes.length ? Uint8Array.from(bytes) : null, {
            status: response.status, headers: response.headers,
          }), '模型结果下载失败', undefined, apiKey);
        } else results[index] = await readBinaryModelProtocolResult(response, fallbackMimeType, downloadSignal, budget);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = downloadSignal.aborted ? downloadSignal.reason : error;
          controller.abort(failure);
        }
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(2, urls.length) }, worker));
  if (failed) throw failure;
  downloadSignal.throwIfAborted();
  return results;
}

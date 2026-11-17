/** 开发模式的上传诊断；只输出脱敏元数据和有界错误响应，不记录素材正文或持久化。 */
export interface UploadDiagnosticContext {
  id: string;
  source: 'uguu' | 'custom';
  endpoint: string;
  startedAt: number;
  secrets: string[];
}

const MAX_ERROR_BYTES = 1024 * 1024;
const PRIVATE_KEY = /authorization|api[-_]?key|token|secret|password|credential|cookie|signature|(?:^|[-_])sig$|^key$|base64|filecontent|image_data|^(?:files?|image|video|audio|buffer|payload)$/i;
const REPLAYED_PAYLOAD_KEY = /^(?:file[-_]?names?|(?:request|response)[_-]?body|body|data|bytes)$/i;
const RESPONSE_HEADERS = new Set(['content-type', 'content-length', 'server', 'date', 'via', 'location', 'retry-after',
  'x-request-id', 'request-id', 'x-correlation-id', 'cf-ray', 'x-cache', 'x-envoy-upstream-service-time']);

function secretVariants(values: string[]): string[] {
  return [...new Set(values.flatMap((value) => {
    if (!value) return [];
    const urlEncoded = encodeURIComponent(value);
    const formEncoded = new URLSearchParams({ value }).toString().slice('value='.length);
    const jsonEncoded = JSON.stringify(value).slice(1, -1);
    const encoded = [value, urlEncoded, formEncoded, jsonEncoded,
      value.replace(/\//g, '\\/'), jsonEncoded.replace(/\//g, '\\/'),
      urlEncoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
      formEncoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase())];
    try { encoded.push(btoa(`${value}:`), btoa(value)); } catch { /* 非 ASCII 密钥仍按原文及 URL 编码脱敏。 */ }
    return encoded;
  }))].sort((a, b) => b.length - a.length);
}

function cleanText(value: string, secrets: string[]): string {
  let text = value;
  for (const secret of secretVariants(secrets)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, '[REDACTED AUTH]')
    .replace(/((?:api[-_]?key|token|secret|password|authorization|cookie|signature)(?:["']|&quot;|&#34;)?\s*[=:]\s*(?:["']|&quot;|&#34;)?)[^\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/data:[^\s"'<>]*;base64,[A-Za-z0-9+/=]+/gi, '[OMITTED MEDIA]')
    .replace(/[A-Za-z0-9+/=_-]{256,}/g, '[OMITTED ENCODED DATA]')
    .replace(/(?<![\w])(?:[a-z]:[\\/]|\\\\)[^\s"'<>]+/gi, '[REDACTED LOCAL PATH]')
    .replace(/(?<![\w:])\/(?:Users|home|tmp|private|var|mnt)\/[^\s"'<>]+/g, '[REDACTED LOCAL PATH]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => safeUrl(url));
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '[OMITTED URL]';
    url.username = ''; url.password = ''; url.hash = '';
    for (const name of [...url.searchParams.keys()]) url.searchParams.set(name, '[REDACTED]');
    return url.href;
  } catch { return '[INVALID URL]'; }
}

function cleanValue(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 20) return '[OMITTED NESTED DATA]';
  if (typeof value === 'string') return cleanText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => cleanValue(item, secrets, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [cleanText(key, secrets), PRIVATE_KEY.test(key) || depth > 0 && REPLAYED_PAYLOAD_KEY.test(key)
      && (key.toLowerCase() !== 'bytes' || typeof item !== 'number')
      ? '[REDACTED]' : cleanValue(item, secrets, depth + 1)]));
  return value;
}

function emit(context: UploadDiagnosticContext | undefined, stage: string, details: Record<string, unknown>): void {
  if (!context || !import.meta.env.DEV) return;
  // 诊断不能改变请求结果；输出单行 JSON，便于用户完整复制而不依赖控制台对象展开。
  try {
    console.info('[Upload Diagnostics]', JSON.stringify(cleanValue({ id: context.id, source: context.source, stage,
      timestamp: new Date().toISOString(), elapsedMs: Date.now() - context.startedAt,
      endpoint: safeUrl(context.endpoint), ...details }, context.secrets)));
  } catch { /* 控制台不可用时保持上传的原结果。 */ }
}

export function startUploadDiagnostics(source: UploadDiagnosticContext['source'], endpoint: string,
  form: FormData, secrets: string[] = []): UploadDiagnosticContext | undefined {
  if (!import.meta.env.DEV) return undefined;
  try {
    const context = { id: `upload-${crypto.randomUUID()}`, source, endpoint, startedAt: Date.now(), secrets };
    const fields = [...form.entries()].map(([name, value]) => typeof value === 'string'
      ? { name, type: 'text', value: '[OMITTED FORM VALUE]' }
      : { name, type: 'file', bytes: value.size, mimeType: value.type,
        filenameExtension: value.name.match(/\.([a-zA-Z0-9]{1,12})$/)?.[1] ?? null });
    emit(context, 'request', { method: 'POST', fields });
    return context;
  } catch { return undefined; }
}

export function logUploadTransport(context: UploadDiagnosticContext | undefined, details: {
  transport: 'browser-fetch' | 'tauri-stream' | 'tauri-buffered'; requestId?: string;
  contentType?: string; wireBytes?: number; native?: unknown; headers?: HeadersInit;
}): void {
  if (!context || !import.meta.env.DEV) return;
  try {
    const { headers, native, ...summary } = details;
    const safeHeaders = headers ? [...new Headers(headers)].filter(([name]) =>
      ['content-type', 'accept', 'user-agent', 'accept-language'].includes(name.toLowerCase())) : [];
    // 原生元数据采用白名单，未来扩展 IPC 不会意外把完整对象带入日志。
    const network = native && typeof native === 'object' ? native as Record<string, unknown> : {};
    const names = ['httpVersion', 'remoteAddress', 'finalUrl', 'proxyEnvironment', 'noProxyPresent',
      'proxySnapshotTimeMs', 'userAgent', 'proxyPolicy'];
    emit(context, 'transport', { ...summary, headers: safeHeaders,
      network: Object.fromEntries(names.filter((name) => name in network).map((name) => [name, network[name]])) });
  } catch { /* 日志输入异常不能影响 HTTP 请求。 */ }
}

export function logUploadNetworkFailure(context: UploadDiagnosticContext | undefined, error: unknown): void {
  try { emit(context, 'network-error', { error: error instanceof Error ? error.message : String(error) }); }
  catch { /* 异常对象无法转换时不替换原上传错误。 */ }
}

/** 只消费失败响应。读取上限和超时独立标记；绝不为诊断再次发请求。 */
export async function logUploadFailureResponse(context: UploadDiagnosticContext | undefined,
  response: Response, signal?: AbortSignal): Promise<void> {
  if (!context) { await response.body?.cancel().catch(() => undefined); return; }
  const headers = [...response.headers].filter(([name]) => RESPONSE_HEADERS.has(name.toLowerCase()));
  const omittedHeaders = [...response.headers.keys()].filter((name) => !RESPONSE_HEADERS.has(name.toLowerCase()));
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !/json|text|html|xml/i.test(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    emit(context, 'http-error', { status: response.status, headers, omittedHeaders, body: '[OMITTED NON-TEXT RESPONSE]' });
    return;
  }
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0; let text = ''; let truncated = false; let interrupted = '';
  const cancel = (reason: string) => { interrupted = reason; void reader?.cancel().catch(() => undefined); };
  const abort = () => cancel('aborted');
  const timer = setTimeout(() => cancel('diagnostic-read-timeout'), 5000);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    while (reader && !interrupted) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = MAX_ERROR_BYTES - bytes;
      const chunk = part.value.subarray(0, remaining);
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (part.value.byteLength > remaining) { truncated = true; await reader.cancel(); break; }
    }
    text += decoder.decode();
  } catch { interrupted ||= 'response-read-failed'; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); reader?.releaseLock(); }
  let body: unknown = text.includes('\u0000') ? '[OMITTED BINARY RESPONSE]' : text;
  if (body === text) try { body = JSON.parse(text); } catch { /* HTML／纯文本网关错误也保留脱敏正文。 */ }
  emit(context, 'http-error', { status: response.status, statusText: response.statusText, headers, omittedHeaders,
    body, bodyBytesRead: bytes, bodyLimitBytes: MAX_ERROR_BYTES, truncated, interrupted: interrupted || null });
}

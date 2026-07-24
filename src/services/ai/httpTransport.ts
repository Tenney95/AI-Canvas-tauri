/** Fetch-compatible AI transport with a Tauri-native streaming path that bypasses WebView CORS. */

type ProxyFetchStreamEvent =
  | { event: 'meta'; status: number; headers: [string, string][] }
  | { event: 'chunk'; body: string }
  | { event: 'done' };

const SENSITIVE_KEY_RE = /(?:authorization|api[-_]?key|access[-_]?key|token|secret|password|credential|signature|cookie)/i;
const LOCAL_MEDIA_RE = /^(?:asset|blob|data|file):/i;
const WINDOWS_ABSOLUTE_PATH_RE = /(?:^|[\s"'(=])[a-z]:[\\/]/i;
const UNIX_ABSOLUTE_PATH_RE = /(?:^|[\s"'(=])\/(?:Users|home|root|private|var\/folders|tmp)\//;
const MAX_LOGGED_STRING_LENGTH = 1000;

type SanitizedValue =
  | null
  | boolean
  | number
  | string
  | SanitizedValue[]
  | { [key: string]: SanitizedValue };

function mediaScheme(value: string): string {
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  return scheme || (value.includes('asset.localhost') ? 'asset.localhost' : 'local');
}

function sanitizeUrl(value: string): SanitizedValue {
  if (LOCAL_MEDIA_RE.test(value) || value.includes('asset.localhost')) {
    return { type: 'local-media', scheme: mediaScheme(value), length: value.length };
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'tauri:'].includes(url.protocol)) return value;
    for (const [name, queryValue] of url.searchParams.entries()) {
      url.searchParams.set(
        name,
        SENSITIVE_KEY_RE.test(name) ? '[REDACTED]' : sanitizeString(queryValue),
      );
    }
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function sanitizeString(value: string): string {
  if (WINDOWS_ABSOLUTE_PATH_RE.test(value) || UNIX_ABSOLUTE_PATH_RE.test(value)) {
    return '[REDACTED_TEXT_WITH_LOCAL_PATH]';
  }
  if (value.length > MAX_LOGGED_STRING_LENGTH) {
    return `${value.slice(0, MAX_LOGGED_STRING_LENGTH)}... [length=${value.length}]`;
  }
  return value;
}

function sanitizeValue(
  value: unknown,
  key = '',
  seen = new WeakSet<object>(),
): SanitizedValue {
  if (SENSITIVE_KEY_RE.test(key)) return '[REDACTED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (LOCAL_MEDIA_RE.test(value) || value.includes('asset.localhost') || /^https?:\/\//i.test(value)) {
      return sanitizeUrl(value);
    }
    return sanitizeString(value);
  }
  if (value instanceof Blob) {
    return {
      type: value instanceof File ? 'file' : 'blob',
      mimeType: value.type || 'application/octet-stream',
      size: value.size,
      ...(value instanceof File ? { name: sanitizeString(value.name) } : {}),
    };
  }
  if (value instanceof ArrayBuffer) return { type: 'array-buffer', byteLength: value.byteLength };
  if (ArrayBuffer.isView(value)) return { type: 'binary-view', byteLength: value.byteLength };
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    const sanitized: Record<string, SanitizedValue> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      sanitized[entryKey] = sanitizeValue(entryValue, entryKey, seen);
    }
    return sanitized;
  }
  return String(value);
}

function sanitizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  const normalized = new Headers(headers);
  normalized.forEach((value, name) => {
    result[name] = SENSITIVE_KEY_RE.test(name) ? '[REDACTED]' : sanitizeString(value);
  });
  return result;
}

function sanitizeBody(body: BodyInit | null | undefined): SanitizedValue | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    try {
      return sanitizeValue(JSON.parse(body));
    } catch {
      return sanitizeString(body);
    }
  }
  if (body instanceof URLSearchParams) {
    return sanitizeValue(Object.fromEntries(body.entries()));
  }
  if (body instanceof FormData) {
    const entries: Record<string, SanitizedValue | SanitizedValue[]> = {};
    for (const [name, value] of body.entries()) {
      const next = sanitizeValue(value, name);
      const current = entries[name];
      entries[name] = current === undefined
        ? next
        : Array.isArray(current) ? [...current, next] : [current, next];
    }
    return entries as Record<string, SanitizedValue>;
  }
  return sanitizeValue(body);
}

export function logAiRequest(
  url: string,
  init: RequestInit = {},
  source = 'HTTP',
): void {
  if (!import.meta.env.DEV) return;
  console.info('[AI Request]', {
    source,
    method: (init.method || 'GET').toUpperCase(),
    url: sanitizeUrl(url),
    headers: sanitizeHeaders(init.headers),
    body: sanitizeBody(init.body),
  });
}

function createRequestId(): string {
  return `proxy-${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

function createAbortError(): DOMException {
  return new DOMException('请求已取消', 'AbortError');
}

function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

interface EncodedRequestBody {
  body: string | null;
  contentType?: string;
}

async function encodeRequestBody(
  body: BodyInit | null | undefined,
): Promise<EncodedRequestBody> {
  if (body === undefined || body === null) return { body: null };
  if (typeof body === 'string') {
    return { body: encodeBytesBase64(new TextEncoder().encode(body)) };
  }
  if (body instanceof URLSearchParams) {
    return { body: encodeBytesBase64(new TextEncoder().encode(body.toString())) };
  }
  if (body instanceof Blob) {
    return { body: encodeBytesBase64(new Uint8Array(await body.arrayBuffer())) };
  }
  if (body instanceof ArrayBuffer) {
    return { body: encodeBytesBase64(new Uint8Array(body)) };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      body: encodeBytesBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
    };
  }
  if (body instanceof FormData) {
    const request = new Request('http://localhost', { method: 'POST', body });
    return {
      body: encodeBytesBase64(new Uint8Array(await request.arrayBuffer())),
      contentType: request.headers.get('Content-Type') || undefined,
    };
  }
  throw new Error('原生协议传输不支持流式请求体');
}

function decodeBase64Body(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function normalizeTransportError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' && error ? error : '原生 HTTP 请求失败');
}

export async function corsSafeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  logAiRequest(url, init);
  const signal = init.signal ?? undefined;
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return fetch(url, init);
  }
  if (signal?.aborted) throw createAbortError();

  const requestHeaders = new Headers(init.headers);
  const encodedBody = await encodeRequestBody(init.body);
  if (encodedBody.contentType && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', encodedBody.contentType);
  }
  const headers = Array.from(requestHeaders.entries());
  if (signal?.aborted) throw createAbortError();
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  const requestId = createRequestId();
  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let responseResolved = false;
    let finished = false;

    const cleanup = () => {
      signal?.removeEventListener('abort', handleAbort);
    };
    const cancelNativeRequest = () => {
      void invoke('cancel_proxy_fetch', { requestId }).catch((error) => {
        console.warn('[httpTransport] cancel_proxy_fetch failed:', error);
      });
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        controller.error(error);
      } catch {
        // The consumer may already have canceled the stream.
      }
      if (!responseResolved) reject(error);
    };
    const finish = () => {
      if (finished) return;
      if (!responseResolved) {
        fail(new Error('原生 HTTP 响应缺少状态信息'));
        return;
      }
      finished = true;
      cleanup();
      controller.close();
    };
    const handleAbort = () => {
      cancelNativeRequest();
      fail(createAbortError());
    };
    const stream = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
      cancel() {
        if (finished) return;
        finished = true;
        cleanup();
        cancelNativeRequest();
      },
    });
    const channel = new Channel<ProxyFetchStreamEvent>();
    channel.onmessage = (event) => {
      try {
        if (finished) return;
        if (event.event === 'meta') {
          if (responseResolved) {
            cancelNativeRequest();
            fail(new Error('原生 HTTP 响应重复返回状态信息'));
            return;
          }
          responseResolved = true;
          resolve(new Response(stream, {
            status: event.status,
            headers: new Headers(event.headers),
          }));
          return;
        }
        if (event.event === 'chunk') {
          controller.enqueue(decodeBase64Body(event.body));
          return;
        }
        finish();
      } catch (error) {
        cancelNativeRequest();
        fail(normalizeTransportError(error));
      }
    };

    signal?.addEventListener('abort', handleAbort, { once: true });
    if (signal?.aborted) {
      handleAbort();
      return;
    }

    void invoke<void>('proxy_stream_fetch', {
      req: {
        requestId,
        url,
        method: init.method || 'GET',
        headers,
        body: encodedBody.body,
      },
      onEvent: channel,
    }).catch((error) => fail(normalizeTransportError(error)));
  });
}

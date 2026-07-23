/** Fetch-compatible AI transport with a Tauri-native streaming path that bypasses WebView CORS. */

type ProxyFetchStreamEvent =
  | { event: 'meta'; status: number; headers: [string, string][] }
  | { event: 'chunk'; body: string }
  | { event: 'done' };

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

async function encodeRequestBody(body: BodyInit | null | undefined): Promise<string | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') {
    return encodeBytesBase64(new TextEncoder().encode(body));
  }
  if (body instanceof URLSearchParams) {
    return encodeBytesBase64(new TextEncoder().encode(body.toString()));
  }
  if (body instanceof Blob) {
    return encodeBytesBase64(new Uint8Array(await body.arrayBuffer()));
  }
  if (body instanceof ArrayBuffer) {
    return encodeBytesBase64(new Uint8Array(body));
  }
  if (ArrayBuffer.isView(body)) {
    return encodeBytesBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  if (body instanceof FormData) {
    throw new Error('原生协议传输需要先序列化 multipart 请求体');
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
  const signal = init.signal ?? undefined;
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return fetch(url, init);
  }
  if (signal?.aborted) throw createAbortError();

  const headers = Array.from(new Headers(init.headers).entries());
  const body = await encodeRequestBody(init.body);
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
        body,
      },
      onEvent: channel,
    }).catch((error) => fail(normalizeTransportError(error)));
  });
}

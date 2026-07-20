/** Browser fetch with a Tauri-native fallback for JSON APIs that do not allow WebView CORS. */

interface ProxyFetchResponse {
  status: number;
  body: string;
  headers: [string, string][];
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

function decodeBase64Body(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function corsSafeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal ?? undefined;
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return fetch(url, init);
  }
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');

  const headers = Array.from(new Headers(init.headers).entries());
  const body = await encodeRequestBody(init.body);
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke<ProxyFetchResponse>('proxy_fetch', {
    req: {
      url,
      method: init.method || 'GET',
      headers,
      body,
    },
  });
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');

  return new Response(decodeBase64Body(result.body), {
    status: result.status,
    headers: new Headers(result.headers),
  });
}

/** Browser fetch with a Tauri-native fallback for JSON APIs that do not allow WebView CORS. */

interface ProxyFetchResponse {
  status: number;
  body: string;
  headers: [string, string][];
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
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
  if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
    throw new Error('原生协议传输只支持字符串请求体');
  }

  const headers = Array.from(new Headers(init.headers).entries());
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke<ProxyFetchResponse>('proxy_fetch', {
    req: {
      url,
      method: init.method || 'GET',
      headers,
      body: typeof init.body === 'string' ? encodeUtf8Base64(init.body) : null,
    },
  });
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');

  return new Response(decodeBase64Body(result.body), {
    status: result.status,
    headers: new Headers(result.headers),
  });
}

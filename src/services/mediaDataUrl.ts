const DATA_URL_HEADER_MAX_CHARS = 4096;
const BASE64_DECODE_CHUNK_CHARS = 256 * 1024;
const YIELD_EVERY_CHARS = 1024 * 1024;

export const MEDIA_DATA_URL_BYTE_LIMITS = {
  image: 32 * 1024 * 1024,
  video: 64 * 1024 * 1024,
  audio: 32 * 1024 * 1024,
  other: 8 * 1024 * 1024,
} as const;

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('操作已取消', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  throwIfAborted(signal);
}

export interface DecodeDataUrlOptions {
  /** 调用方已完成同一 Data URL 的预算扫描时复用结果，避免再次 O(n) 扫描。 */
  expectedBytes?: number;
  maxBytes?: number;
  label?: string;
  signal?: AbortSignal;
}

export async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境缺少内容摘要能力');
  const input = bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await subtle.digest('SHA-256', input));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * 分块解码 Data URL，避免把完整 Base64 正文一次性交给 atob()。
 * 调用方仍需根据媒体类型决定 maxBytes；这里仅执行通用上限。
 */
export async function decodeDataUrlBytesAsync(
  dataUrl: string,
  options: DecodeDataUrlOptions = {},
): Promise<Uint8Array> {
  throwIfAborted(options.signal);
  const boundedHeader = dataUrl.slice(0, DATA_URL_HEADER_MAX_CHARS + 2);
  const commaIndex = boundedHeader.indexOf(',');
  if (commaIndex < 0) throw new Error('Data URL 格式无效：缺少内容分隔符');
  const metadata = dataUrl.slice(0, commaIndex);
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  const label = options.label ?? '媒体';

  if (!/;base64(?:;|$)/i.test(metadata)) {
    const response = await fetch(dataUrl, { signal: options.signal });
    if (!response.ok) throw new Error(`读取 Data URL 失败：HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error(`${label}大小超过允许的内存转换上限`);
    }
    return new Uint8Array(buffer);
  }

  let estimatedBytes: number;
  if (options.expectedBytes === undefined) {
    let payloadLength = 0;
    let lastCharacter = '';
    let secondLastCharacter = '';
    for (let index = commaIndex + 1; index < dataUrl.length; index += 1) {
      const code = dataUrl.charCodeAt(index);
      if (code !== 32 && (code < 9 || code > 13)) {
        payloadLength += 1;
        secondLastCharacter = lastCharacter;
        lastCharacter = dataUrl[index];
      }
      if ((index - commaIndex) % YIELD_EVERY_CHARS === 0) {
        await yieldToEventLoop(options.signal);
      }
    }
    const padding = lastCharacter === '=' ? (secondLastCharacter === '=' ? 2 : 1) : 0;
    estimatedBytes = Math.max(0, Math.floor((payloadLength * 3) / 4) - padding);
  } else {
    estimatedBytes = options.expectedBytes;
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0) {
      throw new Error('Data URL 预估字节数无效');
    }
  }
  if (estimatedBytes > maxBytes) {
    throw new Error(`${label}大小超过允许的内存转换上限`);
  }

  const bytes = new Uint8Array(estimatedBytes);
  let outputOffset = 0;
  const appendBinary = (binary: string) => {
    if (outputOffset + binary.length > bytes.length) {
      throw new Error('Data URL 解码长度与预估不一致');
    }
    for (let index = 0; index < binary.length; index += 1) {
      bytes[outputOffset] = binary.charCodeAt(index);
      outputOffset += 1;
    }
  };
  let carry = '';
  for (let start = commaIndex + 1; start < dataUrl.length; start += BASE64_DECODE_CHUNK_CHARS) {
    throwIfAborted(options.signal);
    const end = Math.min(dataUrl.length, start + BASE64_DECODE_CHUNK_CHARS);
    const cleaned = carry + dataUrl.slice(start, end).replace(/\s/g, '');
    const isLast = end === dataUrl.length;
    const usableLength = isLast ? cleaned.length : cleaned.length - (cleaned.length % 4);
    if (usableLength > 0) {
      appendBinary(atob(cleaned.slice(0, usableLength)));
    }
    carry = cleaned.slice(usableLength);
    if ((start - commaIndex) % YIELD_EVERY_CHARS < BASE64_DECODE_CHUNK_CHARS) {
      await yieldToEventLoop(options.signal);
    }
  }
  if (carry) {
    appendBinary(atob(carry));
  }
  if (options.expectedBytes !== undefined && outputOffset !== options.expectedBytes) {
    throw new Error('Data URL 解码长度与预估不一致');
  }
  return outputOffset === bytes.length ? bytes : bytes.slice(0, outputOffset);
}

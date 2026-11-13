/** 方舟错误出口：移除上游回显的 TOS 预签名链接，再沿用既有凭据脱敏和错误分类。 */
import { getHttpResponseError } from '../httpUtils';
import { redactModelProtocolError, redactModelProtocolErrorText } from '../modelProtocolHttp';

function signedTosUrls(message: string): string[] {
  // 兼容原始链接、encodeURIComponent 和再次编码；只用于识别，不改写实际请求 URL。
  return Array.from(message.matchAll(/https?(?::(?:\/|\\\/){2}|%3a%2f%2f|%253a%252f%252f)[^\s"'<>]+/gi), ([candidate]) => candidate)
    .filter((candidate) => {
      let decoded = candidate.replaceAll('\\/', '/');
      for (let pass = 0; pass < 2; pass += 1) {
        // 仅解码 ASCII 结构即可识别；截断的 UTF-8 或非法转义不能阻止签名脱敏。
        decoded = decoded.replace(/%([\da-f]{2})/gi, (_escape, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      }
      try {
        const url = new URL(decoded);
        return /(?:^|\.)tos-[a-z\d-]+\.(?:i?volces\.com|bytepluses\.com)$/i.test(url.hostname.replace(/\.$/, ''))
          && /[?&]X-Tos-(?:Signature|Credential)=/i.test(decoded);
      } catch { return false; }
    });
}

export function redactVolcengineErrorText(message: string, apiKey = ''): string {
  const safe = signedTosUrls(message).reduce((text, url) => redactModelProtocolErrorText(text, url), message);
  return redactModelProtocolErrorText(safe, apiKey);
}

export function redactVolcengineError(error: unknown, apiKey = ''): unknown {
  const message = typeof error === 'string' ? error
    : error instanceof Error || (typeof DOMException !== 'undefined' && error instanceof DOMException) ? error.message : '';
  const httpError = getHttpResponseError(error);
  let safe = error;
  // 复用既有重建规则，保留 HTTP 状态、明确拒绝、重试时长、取消及轮询错误类型。
  for (const text of [message, httpError?.message ?? '']) {
    for (const url of signedTosUrls(text)) safe = redactModelProtocolError(safe, url);
  }
  return redactModelProtocolError(safe, apiKey);
}

/**
 * Base URL 规范化与端点候选。
 *
 * 用户粘贴的接口地址常见三类问题：漏写协议、带尾斜杠、直接把 `/chat/completions`
 * 这类完整端点当成 Base URL 贴进来。下游有十几处 `${baseUrl}${path}` 拼接各自 trim，
 * 既重复又有遗漏，所以统一在写进配置前收敛一次。
 */

import type { ChatApiProtocol } from '../../types';

/** 用户常误贴的完整端点后缀；只剥端点本身，保留 /v1 之类的版本段。 */
const PASTED_ENDPOINT_RE =
  /\/(?:chat\/completions|completions|responses|messages(?:\/count_tokens)?|models(?:\/[^/]+:(?:streamGenerateContent|generateContent))?|embeddings|images\/generations|videos|audio\/(?:speech|transcriptions))\/?$/i;

/** 去掉首尾空白、补全协议、剥掉查询与误贴的端点后缀，并统一去掉尾斜杠。 */
export function normalizeBaseUrl(
  raw: string | null | undefined,
  _protocol: ChatApiProtocol = 'openai-compatible',
): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    // 解析不了就只做最保守的清理，交给调用方的错误提示
    return value.replace(/\/+$/, '');
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(PASTED_ENDPOINT_RE, '');
  return url.toString().replace(/\/+$/, '');
}

/**
 * 拉取模型目录 / 验证连接时的探测顺序。
 * 地址里已有版本段（/v1、/v1beta/openai）就不再猜；否则按协议补 `/v1` 或 `/v1beta` 候选 ——
 * 中转站只给根域名是最常见的填写遗漏。
 */
export function baseUrlCandidates(
  raw: string | null | undefined,
  protocol: ChatApiProtocol = 'openai-compatible',
): string[] {
  const base = normalizeBaseUrl(raw, protocol);
  if (!base) return [];
  let pathname: string;
  try {
    pathname = new URL(base).pathname;
  } catch {
    return [base];
  }
  if (/\/v\d/i.test(pathname)) return [base];
  return [base, `${base}/${protocol === 'gemini-native' ? 'v1beta' : 'v1'}`];
}

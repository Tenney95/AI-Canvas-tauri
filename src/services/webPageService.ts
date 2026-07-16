import { invoke } from '@tauri-apps/api/core';
import type { WebSource } from '../types/chat';
import { normalizePublicWebUrl } from './webSearchService';

interface NativeWebReadResponse {
  url: string;
  status: number;
  contentType: string;
  body: string;
  fetchedAt: number;
}

export interface WebPageResult {
  source: WebSource;
  text: string;
  truncated: boolean;
}

function extractReadableText(body: string, contentType: string): { title?: string; text: string } {
  if (contentType.startsWith('application/json')) {
    return { text: body.replace(/\s+/g, ' ').trim() };
  }
  const parser = new DOMParser();
  const document = parser.parseFromString(body, 'text/html');
  document.querySelectorAll(
    'script,style,noscript,svg,canvas,iframe,nav,footer,form,button,input',
  ).forEach((element) => element.remove());
  const title = document.querySelector('title')?.textContent?.replace(/\s+/g, ' ').trim();
  const root = document.querySelector('article,main') ?? document.body;
  return {
    title,
    text: root?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  };
}

export async function readWebPage(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<WebPageResult> {
  const normalized = normalizePublicWebUrl(rawUrl);
  if (!normalized) throw new Error('网页 URL 未通过本地安全校验');
  if (typeof window === 'undefined' || !('__TAURI__' in window)) {
    throw new Error('受控网页读取仅在 Tauri 桌面环境可用');
  }
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  const response = await invoke<NativeWebReadResponse>('assistant_web_read', {
    url: normalized,
  });
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  const extracted = extractReadableText(response.body, response.contentType);
  if (!extracted.text) throw new Error('网页没有可读取的正文');
  const limit = 40_000;
  const text = extracted.text.slice(0, limit);
  const finalUrl = normalizePublicWebUrl(response.url);
  if (!finalUrl) throw new Error('网页最终地址未通过安全校验');
  const parsed = new URL(finalUrl);
  return {
    source: {
      id: `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      title: extracted.title || parsed.hostname,
      url: finalUrl,
      domain: parsed.hostname,
      snippet: text.slice(0, 500),
      fetchedAt: response.fetchedAt,
      sourceType: 'page',
    },
    text,
    truncated: extracted.text.length > limit,
  };
}

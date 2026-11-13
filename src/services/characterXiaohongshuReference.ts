import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { bytePartsToBase64Async } from './fs/core';
import { t } from '../i18n';

const HEADER_BYTES = 57;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export interface CharacterXiaohongshuReference {
  id: string;
  url: string;
  label: string;
  sourceUrl: string;
  stagedBytes: number;
}

export function openCharacterXiaohongshuReference(sessionId: string): Promise<void> {
  return invoke('xiaohongshu_reference_open', {
    sessionId,
    title: t('小红书参考 · AI Canvas'),
    importLabel: t('导入当前图片'),
    importingLabel: t('正在处理小红书照片…'),
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  });
}

export function focusCharacterXiaohongshuReference(sessionId: string): Promise<void> {
  return invoke('xiaohongshu_reference_focus', { sessionId });
}

export function closeCharacterXiaohongshuReference(sessionId: string): Promise<void> {
  return invoke('xiaohongshu_reference_close', { sessionId });
}

export function listenForCharacterXiaohongshuWindow(
  event: 'xiaohongshu-reference-import-requested' | 'xiaohongshu-reference-closed', sessionId: string, onEvent: () => void,
) {
  return getCurrentWebview().listen<{ sessionId: string }>(event, ({ payload }) => {
    if (payload?.sessionId === sessionId) onEvent();
  });
}

export function setCharacterXiaohongshuStatus(sessionId: string, status: 'importing' | 'imported' | 'failed', message?: string): Promise<void> {
  return invoke('xiaohongshu_reference_set_status', { sessionId, status, message });
}

export async function importCharacterXiaohongshuReference(sessionId: string, signal: AbortSignal): Promise<CharacterXiaohongshuReference> {
  signal.throwIfAborted();
  const result = await invoke<ArrayBuffer | Uint8Array>('xiaohongshu_reference_import', { sessionId });
  signal.throwIfAborted();
  const packet = result instanceof Uint8Array ? result : new Uint8Array(result);
  const mime = IMAGE_TYPES[packet[0] - 1];
  const noteId = new TextDecoder().decode(packet.subarray(1, 25));
  const image = packet.subarray(HEADER_BYTES);
  if (!mime || !/^[a-f0-9]{24}$/.test(noteId) || !image.length || image.length > MAX_IMAGE_BYTES) {
    throw new Error(t('小红书照片导入结果无效'));
  }
  const digest = Array.from(packet.subarray(25, HEADER_BYTES), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const payload = await bytePartsToBase64Async([image], signal);
  signal.throwIfAborted();
  return {
    id: `xhs-${digest}`,
    url: `data:${mime};base64,${payload}`,
    label: t('小红书参考图'),
    sourceUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
    stagedBytes: image.length,
  };
}

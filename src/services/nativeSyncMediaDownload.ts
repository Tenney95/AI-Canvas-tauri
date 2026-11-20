/** 同步响应没有远端任务 ID。原临时链接只在本机解封，恢复只重复下载。 */
import type { MediaDownloadAccess } from '../types/aiTypes';
import { sanitizeMediaDownloadAccess, sanitizeMediaResultUrls } from './ai/mediaDownloadAccess';
import { arrayBufferToBase64 } from './fs/core';
import { retainNativeMediaOutputs } from './indexedDb/nativeMediaCollectionRepository';
import { assertNativeMediaResultRetention, isNativeMediaLeaseCurrent, recordNativeSyncDownload, type NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import type { NativeProjectOptions } from './indexedDb/nativeProjectRepository';
import { persistNativeMediaResult } from './nativeMediaResultPersistence';
import { readAppSecret, writeAppSecret } from './providerSecretService';

const KEY = 'media/sync-download-key-v1';
const decode = (value: string) => Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
const unavailable = () => new Error('无法读取原同步媒体的本机下载回执');

async function getDownloadKey(create: boolean) {
  let stored = await readAppSecret(KEY);
  if (!stored && create) {
    const proposed = arrayBufferToBase64(crypto.getRandomValues(new Uint8Array(32)).buffer);
    // 同时首次使用的窗口只能建立一个密钥；冲突时读取已提交的值。
    if (await writeAppSecret(KEY, proposed, { value: null }).catch(() => false)) stored = proposed;
    else stored = await readAppSecret(KEY);
  }
  if (!stored) throw unavailable();
  const bytes = decode(stored);
  if (bytes.length !== 32) throw unavailable();
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function binding(record: NativeMediaTaskRecord) {
  return new TextEncoder().encode(JSON.stringify([record.operationId, record.ownerProjectId, record.canvasId,
    record.providerConfigId, record.providerBase, record.protocolDigest, record.resultRootRef]));
}

/** 内联字节及含厂商 Key 的结果只走原立即落盘流程。凭据库暂时不可用也不丢弃本轮响应。 */
export async function prepareNativeSyncDownload(record: NativeMediaTaskRecord, rawUrls: string[], access: MediaDownloadAccess,
  excludedSecret?: string, options?: NativeProjectOptions): Promise<NativeMediaTaskRecord> {
  const urls = sanitizeMediaResultUrls(rawUrls, excludedSecret, 128);
  if (!urls || excludedSecret && JSON.stringify(access).includes(excludedSecret)) return record;
  const bytes = new TextEncoder().encode(JSON.stringify({ urls, access }));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  let ciphertext: ArrayBuffer;
  try {
    const key = await getDownloadKey(true);
    ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: binding(record) }, key, bytes);
  } catch { return record; }
  try {
    return await recordNativeSyncDownload(record, { count: urls.length, sealed: arrayBufferToBase64(iv.buffer) + '.' + arrayBufferToBase64(ciphertext) }, options);
  } catch {
    // 例如账本剩余空间不足以保存描述，仍尝试按原租约立即保留已经返回的字节。
    await assertNativeMediaResultRetention(record, options);
    return record;
  }
}

export async function saveNativeSyncDownload(record: NativeMediaTaskRecord, options: NativeProjectOptions = {}): Promise<NativeMediaTaskRecord> {
  const pending = record.syncDownload;
  if (!pending) throw unavailable();
  let current = record;
  // 最后一个候选已经写入时（例如结算前退出），直接按原字节集合结算。
  if (pending.saved.length < pending.count) {
    const [iv, encrypted] = pending.sealed.split('.');
    const key = await getDownloadKey(false);
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: binding(record) }, key, decode(encrypted));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    const urls = sanitizeMediaResultUrls(data.urls, undefined, 128), mediaDownloadAccess = sanitizeMediaDownloadAccess(data.access);
    if (!urls || urls.length !== pending.count || !mediaDownloadAccess || mediaDownloadAccess.providerConfigId !== record.providerConfigId
      || mediaDownloadAccess.origin !== new URL(record.providerBase).origin) throw unavailable();
    const assertCurrent = async () => {
      if (!await isNativeMediaLeaseCurrent(current, options)) throw new Error('原同步媒体的下载租约已变化');
    };
    for (const url of urls.slice(pending.saved.length)) {
      const file = await persistNativeMediaResult(url, record.canvasId, { category: record.category, label: '原同步媒体',
        missingFileMessage: '同步媒体尚未保存到原项目目录', mediaDownloadAccess, signal: options.signal, assertCurrent });
      current = await recordNativeSyncDownload(current, file, options);
    }
  }
  return retainNativeMediaOutputs(current, current.syncDownload!.saved, options);
}

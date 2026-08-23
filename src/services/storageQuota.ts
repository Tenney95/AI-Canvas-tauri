/**
 * storageQuota — 存储容量探测与保存失败归因
 *
 * 保存失败最常见的两类原因是「浏览器 IndexedDB 配额用尽」和「磁盘写满」，
 * 二者原始报错都很晦涩（DOMException / os error 28），这里统一归因成
 * 可以直接给用户看的中文说明，并附上实际用量。
 */

export type StorageFailureKind = 'quota' | 'disk-full' | 'unknown';

export interface StorageEstimate {
  usage: number;
  quota: number;
  /** 已用比例 0~1；quota 为 0 时是 0 */
  ratio: number;
}

/** 用量超过这个比例就该提醒用户清理了 */
export const STORAGE_PRESSURE_RATIO = 0.85;

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** IndexedDB 配额耗尽：各浏览器抛的名字/错误码都不一样 */
export function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  // Safari 老版本只给 code 22
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.code === 22) return true;
  return /quota|配额/i.test(errorText(error));
}

/** Tauri 侧写文件失败：磁盘写满 */
export function isDiskFullError(error: unknown): boolean {
  return /no space left|os error 28|ENOSPC|磁盘.*(已满|不足)|disk (is )?full/i.test(errorText(error));
}

export function classifyStorageError(error: unknown): StorageFailureKind {
  if (isQuotaError(error)) return 'quota';
  if (isDiskFullError(error)) return 'disk-full';
  return 'unknown';
}

/** 读取浏览器存储配额；不支持 navigator.storage 的环境返回 null */
export async function estimateBrowserStorage(): Promise<StorageEstimate | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota, ratio: quota > 0 ? usage / quota : 0 };
  } catch {
    return null;
  }
}

/** 用量是否已经逼近配额（用于保存前预警） */
export async function isStorageUnderPressure(): Promise<StorageEstimate | null> {
  const estimate = await estimateBrowserStorage();
  if (!estimate || estimate.quota <= 0) return null;
  return estimate.ratio >= STORAGE_PRESSURE_RATIO ? estimate : null;
}

/**
 * 把保存异常翻译成一句用户能看懂的原因，配额类错误会附带实际用量。
 */
export async function describeStorageError(error: unknown): Promise<{ kind: StorageFailureKind; reason: string }> {
  const kind = classifyStorageError(error);
  if (kind === 'disk-full') {
    return { kind, reason: '磁盘空间不足，无法写入项目文件' };
  }
  if (kind === 'quota') {
    const estimate = await estimateBrowserStorage();
    const usageText = estimate && estimate.quota > 0
      ? `（已用 ${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}）`
      : '';
    return { kind, reason: `浏览器存储配额已用尽${usageText}，请到「设置 → 存储健康中心」清理` };
  }
  const message = error instanceof Error ? error.message : String(error ?? '未知错误');
  return { kind, reason: message.slice(0, 120) };
}

/** 存储边界仅传递白名单分类；原始错误可能含路径或凭据，不保留 cause。 */
export type StorageOperation = 'secret-read' | 'secret-write' | 'secret-delete' | 'secret-probe'
  | 'toolbar-read' | 'toolbar-write' | 'config-read';
export type StorageErrorCode = 'unavailable' | 'busy' | 'interrupted' | 'permission'
  | 'corrupt' | 'version' | 'quota' | 'conflict' | 'unknown';

const descriptions: Record<StorageErrorCode, string> = {
  unavailable: '存储暂不可用', busy: '存储正忙，请稍后重试', interrupted: '读取被中断，请重试',
  permission: '存储访问被拒绝', corrupt: '存储数据格式异常', version: '存储版本不兼容',
  quota: '存储空间不足', conflict: '数据已被其他操作修改，请重新加载', unknown: '存储操作失败，请重试',
};

export class StorageError extends Error {
  readonly operation: StorageOperation;
  readonly code: StorageErrorCode;
  readonly attempt: number;
  constructor(
    operation: StorageOperation,
    code: StorageErrorCode,
    attempt = 1,
  ) {
    super(`${operation.startsWith('secret-') ? '凭据' : operation === 'config-read' ? '应用配置' : '工具栏'}：${descriptions[code]}`);
    this.name = 'StorageError';
    this.operation = operation;
    this.code = code;
    this.attempt = attempt;
  }
}

export function classifyStorageError(error: unknown): StorageErrorCode {
  if (error instanceof StorageError) return error.code;
  if (typeof error !== 'object' || error === null) return 'unknown';
  // 不把 message、路径或任意原生 code 直接作为日志字段。
  const { name, code } = error as { name?: unknown; code?: unknown };
  switch (code) {
    case 'unavailable': return 'unavailable';
    case 'busy': return 'busy';
    case 'interrupted': return 'interrupted';
    case 'permission_denied': return 'permission';
    case 'invalid_data': return 'corrupt';
    case 'conflict': return 'conflict';
    case 'quota': return 'quota';
  }
  switch (name) {
    case 'AbortError': return 'interrupted';
    case 'TimeoutError': return 'busy';
    case 'NotAllowedError':
    case 'SecurityError': return 'permission';
    case 'DataError':
    case 'DataCloneError':
    case 'SyntaxError': return 'corrupt';
    case 'VersionError': return 'version';
    case 'QuotaExceededError': return 'quota';
    default: return 'unknown';
  }
}

export function storageError(operation: StorageOperation, error: unknown, attempt = 1): StorageError {
  return new StorageError(operation, classifyStorageError(error), attempt);
}

export function reportStorageError(operation: StorageOperation, error: unknown): StorageError {
  const safe = storageError(operation, error, error instanceof StorageError ? error.attempt : 1);
  console.warn('[storage]', { operation: safe.operation, code: safe.code, attempt: safe.attempt });
  return safe;
}

/** 仅重试明确的瞬时读取故障，最多三次；调用方必须每次创建新读取/事务。 */
export async function readStorageWithRetry<T>(
  operation: 'secret-read' | 'toolbar-read' | 'config-read',
  read: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      const safe = storageError(operation, error, attempt);
      if (attempt >= 3 || (safe.code !== 'busy' && safe.code !== 'interrupted')) throw safe;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 50));
    }
  }
}

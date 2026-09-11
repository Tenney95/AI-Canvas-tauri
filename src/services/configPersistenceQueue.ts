/** 配置保存、旧凭据迁移与凭据删除共用的串行持久化边界。 */
const CONFIG_PERSISTENCE_LOCK = 'ai-canvas:config-persistence';

let persistenceTail: Promise<void> = Promise.resolve();
let pendingOperations = 0;
let lastOperationFailed = false;
let closing = false;
let frozen = false;

interface SettingsParticipant {
  flush: (retry: boolean) => Promise<void>;
  hasUnsaved: () => boolean;
}
const participants = new Map<string, SettingsParticipant>();
const pendingProducers = new Set<() => Promise<void>>();

export function registerSettingsPersistence(id: string, participant: SettingsParticipant): void {
  participants.set(id, participant);
}

export function registerSettingsProducer(flush: () => Promise<void>): () => void {
  pendingProducers.add(flush);
  return () => { pendingProducers.delete(flush); };
}

export function isSettingsClosing(): boolean { return closing; }
export function areSettingsMutationsFrozen(): boolean { return frozen; }
export function resumeSettingsPersistence(): void { closing = false; frozen = false; }
export function getConfigPersistenceState(): { pending: number; failed: boolean } {
  return { pending: pendingOperations, failed: lastOperationFailed };
}

export async function drainConfigPersistence(): Promise<void> {
  let current: Promise<void>;
  do { current = persistenceTail; await current; } while (current !== persistenceTail);
}

/** 先收集防抖修改，再冻结新写入意图，最后等待 Store 和共享队列到达终态。 */
export async function prepareSettingsClose(retry = false): Promise<boolean> {
  closing = true;
  frozen = false;
  let failed = false;
  for (const flush of pendingProducers) {
    try { await flush(); } catch { failed = true; }
  }
  frozen = true;
  for (const participant of participants.values()) {
    try { await participant.flush(retry); } catch { failed = true; }
  }
  await drainConfigPersistence();
  return !failed && [...participants.values()].every((participant) => !participant.hasUnsaved());
}

/**
 * 按调用顺序执行，单次失败不会阻断后续操作。
 * 支持 Web Locks 时也协调同源窗口；不支持时仅保证当前窗口的顺序。
 * operation 必须覆盖完整持久化过程，不得再次调用本函数等待嵌套操作。
 */
export function enqueueConfigPersistence<T>(operation: () => Promise<T>): Promise<T> {
  pendingOperations += 1;
  const result = persistenceTail.then(async () => {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (typeof locks?.request === 'function') {
      // 锁请求失败时直接拒绝，不能无锁重试造成跨窗口交错。
      return locks.request(CONFIG_PERSISTENCE_LOCK, { mode: 'exclusive' }, operation);
    }
    return operation();
  });
  persistenceTail = result.then(
    () => { pendingOperations -= 1; lastOperationFailed = false; },
    () => { pendingOperations -= 1; lastOperationFailed = true; },
  );
  return result;
}

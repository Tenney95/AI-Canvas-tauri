/** 配置保存、旧凭据迁移与凭据删除共用的串行持久化边界。 */
const CONFIG_PERSISTENCE_LOCK = 'ai-canvas:config-persistence';

let persistenceTail: Promise<void> = Promise.resolve();

/**
 * 按调用顺序执行，单次失败不会阻断后续操作。
 * 支持 Web Locks 时也协调同源窗口；不支持时仅保证当前窗口的顺序。
 * operation 必须覆盖完整持久化过程，不得再次调用本函数等待嵌套操作。
 */
export function enqueueConfigPersistence<T>(operation: () => Promise<T>): Promise<T> {
  const result = persistenceTail.then(async () => {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (typeof locks?.request === 'function') {
      // 锁请求失败时直接拒绝，不能无锁重试造成跨窗口交错。
      return locks.request(CONFIG_PERSISTENCE_LOCK, { mode: 'exclusive' }, operation);
    }
    return operation();
  });
  persistenceTail = result.then(() => undefined, () => undefined);
  return result;
}

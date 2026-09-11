/** 热更新复用同一个 Store；旧监听器与新动态模块都必须读到同一份任务状态。 */
import { create, type StateCreator, type StoreApi, type UseBoundStore } from 'zustand';

export function createOrRefreshHotStore<T extends object>(
  creator: StateCreator<T>,
  hotData?: { appStore?: UseBoundStore<StoreApi<T>> },
): UseBoundStore<StoreApi<T>> {
  const previous = hotData?.appStore;
  if (!previous) {
    const store = create<T>()(creator);
    // 依赖模块重新求值不保证先触发 dispose，必须在首次载入即保留引用。
    if (hotData) hotData.appStore = store;
    return store;
  }
  // 在原 Store 上重新构造 action 闭包，不能从另一 Store 复制绑定到别处的 action。
  const fresh = creator(previous.setState, previous.getState, previous);
  const current = previous.getState();
  const next = { ...fresh, ...current };
  for (const key of Object.keys(fresh) as Array<keyof T>) {
    if (typeof fresh[key] === 'function') next[key] = fresh[key];
  }
  previous.setState(next, true);
  return previous;
}

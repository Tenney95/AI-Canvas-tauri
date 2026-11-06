/** 宿主管理的清理作用域；撤销立即生效，异步清理按逆序完成。 */
export function createPluginLifecycleScope() {
  let active = true;
  let completion: Promise<void> | undefined;
  const cleanups: Array<() => void | Promise<void>> = [];
  return {
    isActive: () => active,
    defer(cleanup: () => void | Promise<void>): void {
      if (!active) { void Promise.resolve().then(cleanup).catch(() => undefined); return; }
      cleanups.push(cleanup);
    },
    dispose(): Promise<void> {
      if (completion) return completion;
      active = false;
      let complete!: () => void;
      let fail!: (error: unknown) => void;
      completion = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
      const run = async () => {
        const errors: unknown[] = [];
        while (cleanups.length) {
          try {
            const cleanup = cleanups.pop()!();
            if (cleanup && typeof cleanup.then === 'function') await cleanup;
          } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new Error('部分插件资源清理未完成');
      };
      void run().then(complete, fail);
      return completion;
    },
  };
}

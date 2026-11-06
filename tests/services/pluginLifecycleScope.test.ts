import { describe, expect, it } from 'vitest';
import { createPluginLifecycleScope } from '../../src/services/plugins/pluginLifecycleScope';

describe('plugin lifecycle cleanup', () => {
  it('revokes immediately and awaits reverse, idempotent async cleanup', async () => {
    const scope = createPluginLifecycleScope();
    const order: number[] = [];
    scope.defer(() => { order.push(1); });
    scope.defer(async () => { await Promise.resolve(); order.push(2); });
    const completion = scope.dispose();
    expect(scope.isActive()).toBe(false);
    expect(scope.dispose()).toBe(completion);
    await completion;
    expect(order).toEqual([2, 1]);
  });
  it('continues cleanup after a failing disposer', async () => {
    const scope = createPluginLifecycleScope();
    let cleaned = false;
    scope.defer(() => { cleaned = true; });
    scope.defer(() => { throw new Error('private details'); });
    await expect(scope.dispose()).rejects.toThrow('部分插件资源清理未完成');
    expect(cleaned).toBe(true);
  });
});

/** 共用节点错误是持久状态展示，不能因时间经过或组件重挂载清除。 */
import type { EffectCallback } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({
  node: { id: 'original-node', data: { status: 'error' as string, error: '服务商明确拒绝本次请求' as string | undefined } },
  update: vi.fn(), cleanup: [] as Array<() => void>,
}));
// 即使旧组件在渲染时注册effect，其真实倒计时也会被本夹具推进并暴露Store写入。
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useEffect: (effect: EffectCallback) => {
  const cleanup = effect(); if (cleanup) driver.cleanup.push(cleanup);
} }));
vi.mock('@iconify/react', () => ({ Icon: () => <span aria-hidden="true" /> }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: Object.assign(
  (select: (state: { updateNodeDataTransient: typeof driver.update }) => unknown) => select({ updateNodeDataTransient: driver.update }),
  { getState: () => ({ nodes: [driver.node] }) },
) }));
import NodeError from '../../src/components/nodes/shared/NodeError';

const render = () => driver.node.data.error ? renderToStaticMarkup(<NodeError nodeId={driver.node.id} message={driver.node.data.error} />) : '';
beforeEach(() => {
  vi.useFakeTimers(); driver.cleanup = []; driver.node.data = { status: 'error', error: '服务商明确拒绝本次请求' };
  driver.update.mockReset().mockImplementation((_id: string, patch: Partial<typeof driver.node.data>) => Object.assign(driver.node.data, patch));
});
afterEach(() => { driver.cleanup.splice(0).forEach((cleanup) => cleanup()); vi.useRealTimers(); });

it('超过原21.1秒清除期限仍显示完整错误，不写Store或把error状态改成idle', () => {
  expect(render()).toContain('role="alert"');
  vi.advanceTimersByTime(60_000);
  expect(driver.update).not.toHaveBeenCalled();
  expect(driver.node.data).toEqual({ status: 'error', error: '服务商明确拒绝本次请求' });
  expect(render()).toContain('服务商明确拒绝本次请求');
  expect(render()).not.toContain('node-error--fading');
});

it('重挂载或后续报错保持当前消息，只有运行入口清除后才不再渲染', () => {
  render(); driver.cleanup.splice(0).forEach((cleanup) => cleanup());
  expect(render()).toContain('服务商明确拒绝本次请求');
  driver.node.data.error = '另一轮请求失败';
  expect(render()).toContain('另一轮请求失败'); vi.advanceTimersByTime(60_000);
  expect(driver.update).not.toHaveBeenCalled(); expect(render()).toContain('另一轮请求失败');
  // 与生成入口开始运行时的状态变更一致，展示组件不自行发起清理。
  driver.node.data = { status: 'loading', error: undefined };
  expect(render()).toBe('');
});

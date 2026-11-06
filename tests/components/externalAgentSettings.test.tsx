import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ cursor: 0, effectsCursor: 0, values: [] as unknown[],
  effects: [] as Array<{ dependencies?: readonly unknown[]; cleanup?: () => void }>, pending: [] as Array<() => void> }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useId: () => 'external-agent-key',
  useState: <T,>(initial: T | (() => T)) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.values[index] as T, (next: T | ((previous: T) => T)) => {
      hooks.values[index] = typeof next === 'function' ? (next as (previous: T) => T)(hooks.values[index] as T) : next;
    }];
  },
  useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
    const index = hooks.effectsCursor++, previous = hooks.effects[index];
    if (previous && dependencies?.length === previous.dependencies?.length && dependencies?.every((value, i) => Object.is(value, previous.dependencies?.[i]))) return;
    hooks.pending.push(() => { previous?.cleanup?.(); hooks.effects[index] = { dependencies, cleanup: effect() ?? undefined }; });
  },
}));
const host = vi.hoisted(() => ({ status: vi.fn(), write: vi.fn(), remove: vi.fn(), register: vi.fn(), configure: vi.fn(), removeRuntime: vi.fn(), t: (key: string) => key }));
vi.mock('../../src/i18n', () => ({ useT: () => host.t }));
vi.mock('../../src/services/providerSecretService', () => ({ writeAppSecret: host.write, deleteAppSecret: host.remove }));
vi.mock('../../src/services/chat/externalAgents/externalAgentRegistry', () => ({
  getExternalAgentStatus: host.status, registerCodexRuntime: host.register, configureCodexRuntime: host.configure, removeCodexRuntime: host.removeRuntime,
}));
import ExternalAgentSettings from '../../src/components/settings/ExternalAgentSettings';
let view: ReactElement;
function render() {
  hooks.cursor = hooks.effectsCursor = 0;
  view = ExternalAgentSettings();
  hooks.pending.splice(0).forEach((effect) => effect());
}
function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function button(label: string) {
  const result = elements(view).find((element) => element.type === 'button' && element.props.children === label);
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
async function click(label: string) {
  const target = button(label);
  if (!target.props.disabled && typeof target.props.onClick === 'function') target.props.onClick();
  await settle();
}
beforeEach(() => {
  hooks.values = []; hooks.effects = []; hooks.pending = [];
  host.status.mockReset().mockResolvedValue({ registered: true, version: '0.167.0', configured: true, compatible: true, available: false, enabled: false });
  host.configure.mockReset(); host.write.mockReset().mockResolvedValue(true);
  host.remove.mockReset().mockResolvedValue(true); host.register.mockReset(); host.removeRuntime.mockReset();
});
afterEach(() => { hooks.effects.forEach((effect) => effect.cleanup?.()); });
describe('外部执行器设置', () => {
  it('显式说明进程信任与费用边界，启用仅发送布尔开关', async () => {
    render(); await settle();
    expect(renderToStaticMarkup(view)).toContain('不构成系统沙箱');
    expect(renderToStaticMarkup(view)).toContain('不复用 ChatGPT 订阅额度');
    expect(button('启用执行器').props.disabled).toBe(false);
    host.configure.mockResolvedValue({ registered: true, enabled: true, available: true, configured: true, compatible: true, version: '0.167.0' });
    await click('启用执行器');
    expect(host.configure).toHaveBeenCalledWith(true);
    expect(host.status.mock.calls).toHaveLength(1);
  });
  it('写入新凭据前先停用执行器，成功后清空输入', async () => {
    host.status.mockResolvedValue({ registered: true, version: '0.167.0', configured: true, compatible: true, available: true, enabled: true });
    render(); await settle();
    const input = elements(view).find((element) => element.type === 'input' && element.props.type === 'password')!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'demo-key' } }); render();
    host.configure.mockResolvedValue({ registered: true, enabled: false });
    await click('保存凭据');
    expect(host.configure).toHaveBeenCalledWith(false);
    expect(host.write).toHaveBeenCalledOnce();
    expect(host.configure.mock.invocationCallOrder[0]).toBeLessThan(host.write.mock.invocationCallOrder[0]);
    expect(elements(view).find((element) => element.type === 'input' && element.props.type === 'password')?.props.value).toBe('');
  });
});

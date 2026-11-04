/** API Key 列表余额：运行真实组件的查询生命周期，不触发桌面或厂商请求。 */
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { ApiProviderConfig } from '../../src/types';
import type { ProviderBalance } from '../../src/services/testConnection';

interface EffectSlot { deps?: readonly unknown[]; cleanup?: () => void }
const driver = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[],
  state: {} as AppState, query: vi.fn(), save: vi.fn(),
}));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const index = driver.cursor++;
    if (!(index in driver.slots)) driver.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [driver.slots[index], (next: T | ((current: T) => T)) => {
      driver.slots[index] = typeof next === 'function' ? (next as (current: T) => T)(driver.slots[index] as T) : next;
    }];
  },
  useRef: <T,>(initial: T) => { const index = driver.cursor++; return driver.slots[index] ??= { current: initial }; },
  useMemo: <T,>(factory: () => T) => factory(), useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = driver.cursor++;
    const previous = driver.slots[index] as EffectSlot | undefined;
    if (previous && deps && previous.deps?.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
    driver.effects.push(() => {
      previous?.cleanup?.();
      driver.slots[index] = { deps, cleanup: effect() || undefined } satisfies EffectSlot;
    });
  },
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: Object.assign(<T,>(selector: (state: AppState) => T) => selector(driver.state), { getState: () => driver.state }) }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string, params?: Record<string, string | number>) => Object.entries(params ?? {})
  .reduce((value, [key, replacement]) => value.replaceAll(`{${key}}`, String(replacement)), text) }));
vi.mock('../../src/services/testConnection', async () => ({
  ...await vi.importActual<typeof import('../../src/services/testConnection')>('../../src/services/testConnection'),
  queryProviderBalance: driver.query,
}));
vi.mock('../../src/services/providerSecretService', () => ({ isSecretStoreAvailable: async () => true, deleteAppSecret: vi.fn() }));
vi.mock('@iconify/react', () => ({ Icon: 'icon' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../src/components/shared/AnimatedButton', () => ({ default: 'button' }));
vi.mock('../../src/components/shared/ProviderBadge', () => ({ default: 'badge' }));
vi.mock('../../src/components/settings/ProviderConnectionDialog', () => ({ default: 'dialog' }));
vi.mock('../../src/components/settings/DreaminaLoginModal', () => ({ default: 'dreamina' }));
vi.mock('../../src/components/nodes/shared/defaultModels', () => ({ defaultModelGroups: [] }));

import ApiKeySettings from '../../src/components/settings/ApiKeySettings';

let tree: unknown;
function render() {
  driver.cursor = 0;
  tree = ApiKeySettings({ onClose: vi.fn() });
  for (const effect of driver.effects.splice(0)) effect();
}
function elements(value: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function balances(): string[] {
  return elements(tree).filter((element) => typeof element.props['data-tooltip'] === 'string'
    && (element.props['data-tooltip'] as string).includes('剩余额度')).map((element) => text(element.props.children));
}
function setProviders(providers: Record<string, ApiProviderConfig>) {
  driver.state = { ...driver.state, config: { ...driver.state.config, providers } };
}
function connection(catalogId: string, apiKey: string, baseUrl?: string): ApiProviderConfig {
  return { catalogId, name: catalogId, apiKey, baseUrl, selectedModels: [] };
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }

beforeEach(() => {
  driver.slots = []; driver.cursor = 0; driver.effects = [];
  driver.query.mockReset().mockResolvedValue(undefined); driver.save.mockReset();
  driver.state = { config: { providers: {} }, workflows: [], configSecretReadErrors: [],
    saveConfig: driver.save, saveProviderConfig: driver.save } as unknown as AppState;
  vi.stubGlobal('window', {});
});
afterEach(() => {
  for (const slot of driver.slots) (slot as EffectSlot | undefined)?.cleanup?.();
  vi.unstubAllGlobals();
});

describe('厂商卡片剩余额度', () => {
  it('按真实 catalogId 查询，显示 0 和可用算力，不写连接配置或借用自定义名称', async () => {
    setProviders({ 'lib-user': connection('libapi', 'lib-key'), 'toapis-user': connection('toapis', 'to-key'),
      libapi: connection('custom-openai', 'custom-key', 'https://custom.example/v1') });
    driver.query.mockImplementation(async (provider: string) => provider === 'libapi'
      ? { amount: '85.288882', unit: '算力', scope: 'account' }
      : { amount: '0', unit: '积分', scope: 'account' });
    render(); await settle();
    expect(balances()).toEqual(expect.arrayContaining(['85.288882 算力', '0 积分']));
    expect(driver.query.mock.calls.map((call) => call.slice(0, 2))).toEqual([['libapi', 'lib-key'], ['toapis', 'to-key']]);
    expect(driver.save).not.toHaveBeenCalled();
    render(); await settle();
    expect(driver.query).toHaveBeenCalledTimes(2);
  });

  it('更换 Key 或站点时立即隐藏旧值，取消查询并拒绝迟到的余额', async () => {
    let resolveOld!: (value: ProviderBalance) => void;
    driver.query.mockImplementationOnce(() => new Promise<ProviderBalance>((resolve) => { resolveOld = resolve; }));
    setProviders({ toapis: connection('toapis', 'old-key', 'https://toapis.cn/v1') });
    render();
    const oldSignal = driver.query.mock.calls[0]?.[3] as AbortSignal;
    driver.query.mockResolvedValueOnce({ amount: '42', unit: '积分', scope: 'account' });
    setProviders({ toapis: connection('toapis', 'new-key', 'https://toapis.com/v1') });
    render();
    expect(balances()).toEqual([]);
    expect(oldSignal.aborted).toBe(true);
    resolveOld({ amount: '999', unit: '积分', scope: 'account' });
    await settle();
    expect(balances()).toEqual(['42 积分']);
    expect(driver.query.mock.calls[1]?.slice(0, 3)).toEqual(['toapis', 'new-key', 'https://toapis.com/v1']);
  });

  it('查询失败不显示 0，删除连接后取消查询', async () => {
    setProviders({ toapis: connection('toapis', 'to-key') });
    render(); await settle();
    expect(balances()).toEqual([]);
    const signal = driver.query.mock.calls[0]?.[3] as AbortSignal;
    setProviders({}); render();
    expect(signal.aborted).toBe(true);
    expect(driver.save).not.toHaveBeenCalled();
  });

  it('删除后按同 ID 和 Key 重建，不显示之前的旧余额', async () => {
    const provider = connection('toapis', 'to-key');
    setProviders({ toapis: provider });
    driver.query.mockResolvedValueOnce({ amount: '50', unit: '积分', scope: 'account' });
    render(); await settle();
    expect(balances()).toEqual(['50 积分']);
    setProviders({}); render();
    setProviders({ toapis: provider }); render();
    expect(balances()).toEqual([]);
    await settle();
    expect(balances()).toEqual([]);
    expect(driver.query).toHaveBeenCalledTimes(2);
  });

  it('关闭面板中止查询，迟到结果不再写回已卸载的组件', async () => {
    let finish!: (balance: ProviderBalance) => void;
    driver.query.mockImplementationOnce(() => new Promise<ProviderBalance>((resolve) => { finish = resolve; }));
    setProviders({ toapis: connection('toapis', 'to-key') }); render();
    for (const slot of driver.slots) (slot as EffectSlot | undefined)?.cleanup?.();
    expect((driver.query.mock.calls[0]?.[3] as AbortSignal).aborted).toBe(true);
    const slots = [...driver.slots];
    finish({ amount: '99', unit: '积分', scope: 'account' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(driver.slots).toEqual(slots);
  });

  it('RH 模型和工作流余额分别来自当前站点的对应密钥，不借另一站、不合计', async () => {
    const base = 'https://www.runninghub.cn/openapi/v2';
    setProviders({
      'runninghub-model': { ...connection('runninghub-model', 'cn-model', base), runninghubSiteCredentials: true },
      runninghub: { ...connection('runninghub', 'cn-workflow', base), runninghubSiteCredentials: true },
      'runninghub-credential-cn-model': connection('runninghub-model', 'cn-model', base),
      'runninghub-credential-cn-workflow': connection('runninghub', 'cn-workflow', base),
      'runninghub-credential-ai-model': connection('runninghub-model', 'ai-model', 'https://www.runninghub.ai/openapi/v2'),
    });
    driver.query.mockImplementation(async (_provider: string, key: string) => ({ amount: key === 'cn-model' ? '5' : '8', unit: '积分', scope: 'account' }));
    render(); await settle();
    expect(driver.query.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ['runninghub-model', 'cn-model', base], ['runninghub', 'cn-workflow', base],
    ]);
    expect(balances()).toEqual(['5 积分', '8 积分']);
  });
});

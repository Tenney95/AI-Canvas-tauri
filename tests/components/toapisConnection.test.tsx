import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface HookScope { values: unknown[]; index: number }
const driver = vi.hoisted(() => ({ scope: null as HookScope | null, catalog: vi.fn(), external: vi.fn() }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const scope = driver.scope!;
    const index = scope.index++;
    if (!(index in scope.values)) scope.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [scope.values[index] as T, (next: T | ((current: T) => T)) => {
      scope.values[index] = typeof next === 'function' ? (next as (current: T) => T)(scope.values[index] as T) : next;
    }];
  },
  useRef: <T,>(value: T) => { const scope = driver.scope!; return scope.values[scope.index++] ??= { current: value }; },
  useMemo: <T,>(factory: () => T) => factory(),
  useEffect: () => {},
}));
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({ workflows: [] }) } }));
vi.mock('../../src/services/ai/providerCatalogService', async (original) => ({
  ...await original<typeof import('../../src/services/ai/providerCatalogService')>(),
  fetchProviderModelCatalog: (...args: unknown[]) => driver.catalog(...args),
}));
vi.mock('../../src/components/settings/providerConnection/providerConnectionShared', async (original) => ({
  ...await original<typeof import('../../src/components/settings/providerConnection/providerConnectionShared')>(),
  openExternal: (...args: unknown[]) => driver.external(...args),
}));
import ProviderConnectionDialog from '../../src/components/settings/ProviderConnectionDialog';
import ProviderConnectionForm from '../../src/components/settings/providerConnection/ProviderConnectionForm';
import ProviderModelSection from '../../src/components/settings/providerConnection/ProviderModelSection';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';
import type { ProviderModelSelection } from '../../src/types';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
let props: ComponentProps<typeof ProviderConnectionDialog>;
let tree: unknown;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function render() { driver.scope!.index = 0; tree = ProviderConnectionDialog(props); }
function form() { return elements(tree).find((element) => element.type === ProviderConnectionForm)!.props as unknown as ComponentProps<typeof ProviderConnectionForm>; }
function section() { return elements(tree).find((element) => element.type === ProviderModelSection)!.props as unknown as ComponentProps<typeof ProviderModelSection>; }
function click(text: string) {
  const button = elements(tree).find((element) => element.props.children === text && typeof element.props.onClick === 'function')!;
  return (button.props.onClick as () => void)();
}

beforeEach(() => {
  driver.scope = { values: [], index: 0 }; driver.catalog.mockReset(); driver.external.mockReset();
  vi.stubGlobal('document', { body: {} });
  const selected = getProviderDefinition('toapis')!.models!.find((model) => model.id === 'gpt-image-2')!;
  const config = { name: 'ToAPIs', catalogId: 'toapis', apiKey: 'shared-fixture', baseUrl: 'https://toapis.cn/v1', selectedModels: [selected] };
  props = { isOpen: true, connectionId: 'toapis-user', initialConfig: config,
    providerConfigs: { 'toapis-user': config }, connectedProviderIds: ['toapis'],
    fallbackModels: { toapis: [...getProviderDefinition('toapis')!.models!] },
    dreaminaLoggedIn: false, dreaminaLoading: false, onDreaminaLogin: vi.fn(),
    onClose: vi.fn(), onSave: vi.fn(), onSaveCccGroups: vi.fn(),
  };
});
afterEach(() => vi.unstubAllGlobals());

describe('ToAPIs 国内与国际站共用凭据', () => {
  it('切换保留同一份 Key 和选择，保存所选站点，邀请链接随站点改变', () => {
    render(); form().setBaseUrl('https://toapis.com/v1'); render();
    expect(form().apiKey).toBe('shared-fixture');
    expect(section().selectedModels.map((model) => model.id)).toEqual(['gpt-image-2']);
    const content = ProviderConnectionForm(form());
    const external = elements(content).find((element) => element.props.className === 'provider-external-link')!;
    (external.props.onClick as () => void)();
    expect(driver.external).toHaveBeenCalledExactlyOnceWith('https://toapis.com/login?aff=SnMr');
    click('保存更改');
    expect(props.onSave).toHaveBeenCalledWith('toapis-user', expect.objectContaining({
      catalogId: 'toapis', baseUrl: 'https://toapis.com/v1', apiKey: 'shared-fixture',
    }), undefined);
  });

  it('取消站点修改不会持久化，也不会改动原凭据', () => {
    render(); form().setBaseUrl('https://toapis.com/v1'); render(); click('取消');
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.initialConfig).toMatchObject({ baseUrl: 'https://toapis.cn/v1', apiKey: 'shared-fixture' });
  });

  it('切换会取消旧站请求，迟到结果不能覆盖新站目录，旧站独有选择不残留', async () => {
    let finish!: (result: unknown) => void;
    driver.catalog.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(); const old = section().onFetchModels(); render();
    const oldSignal = driver.catalog.mock.calls[0][0].signal as AbortSignal;
    form().setBaseUrl('https://toapis.com/v1'); render();
    expect(oldSignal.aborted).toBe(true);
    expect(form().apiKey).toBe('shared-fixture');
    const remote: ProviderModelSelection = { id: 'grok-4.7', name: 'Grok', provider: 'toapis', category: 'text', executionProfile: { preset: 'openai-chat' } };
    driver.catalog.mockResolvedValueOnce({ models: [remote], source: 'remote' });
    await section().onFetchModels(); render();
    finish({ source: 'remote', models: [{ id: 'stale-image', name: 'Stale', provider: 'toapis', category: 'image' }] });
    await old; render();
    expect(section().models.map((model) => model.id)).toEqual(['grok-4.7']);
    expect(section().selectedModels).toEqual([]);
    expect(driver.catalog.mock.calls[1][0].config).toMatchObject({ baseUrl: 'https://toapis.com/v1', apiKey: 'shared-fixture' });
  });

  it('修改 Key 会取消旧目录请求，旧 Key 的迟到结果不能标为验证成功', async () => {
    let finish!: (result: unknown) => void;
    driver.catalog.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(); const old = section().onFetchModels(); render();
    const oldSignal = driver.catalog.mock.calls[0][0].signal as AbortSignal;
    form().setApiKey('replacement-fixture'); render();
    expect(oldSignal.aborted).toBe(true);
    finish({ source: 'remote', models: [{ id: 'stale-image', name: 'Stale', provider: 'toapis', category: 'image' }] });
    await old; render();
    expect(form().apiKey).toBe('replacement-fixture');
    expect(form().catalogStatus).toBe('idle');
    expect(section().models.some((model) => model.id === 'stale-image')).toBe(false);
    expect(section().selectedModels.map((model) => model.id)).toEqual(['gpt-image-2']);
  });
});

/**
 * toapisConnection — 回归测试：ToAPIs 国内与国际站共用凭据。
 */
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
  const model = getProviderDefinition('toapis')!.models!.find((item) => item.id === 'gpt-image-2')!;
  const selected: ProviderModelSelection = {
    ...model,
    imageCapability: { ...model.imageCapability, maxBatchCount: 2 },
    executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
      submit: { method: 'POST', path: '/user/images', body: { model: '{{model}}', prompt: '{{prompt}}',
        size: '{{aspectRatio}}', resolution: '{{imageSize}}', n: '{{n}}', reference_images: '{{imageUrls}}' } },
      response: { type: 'json', result: { urlPath: 'data.*.url' } },
    } },
  };
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
  it('打开和切换站点保留同一份 Key 与已选自定义模型，邀请链接随站点改变', () => {
    render();
    const selected = props.initialConfig!.selectedModels![0];
    expect(section().selectedModels).toEqual([expect.objectContaining({
      id: selected.id, executionProfile: selected.executionProfile, imageCapability: selected.imageCapability,
    })]);
    form().setBaseUrl('https://toapis.com/v1'); render();
    expect(form().apiKey).toBe('shared-fixture');
    expect(section().selectedModels).toEqual([expect.objectContaining({
      id: selected.id, executionProfile: selected.executionProfile, imageCapability: selected.imageCapability,
    })]);
    const content = ProviderConnectionForm(form());
    const external = elements(content).find((element) => element.props.className === 'provider-external-link')!;
    (external.props.onClick as () => void)();
    expect(driver.external).toHaveBeenCalledExactlyOnceWith('https://toapis.com/login?aff=SnMr');
    click('保存更改');
    expect(props.onSave).toHaveBeenCalledWith('toapis-user', expect.objectContaining({
      catalogId: 'toapis', baseUrl: 'https://toapis.com/v1', apiKey: 'shared-fixture',
      selectedModels: [expect.objectContaining({
        id: selected.id, provider: 'toapis-user', executionProfile: selected.executionProfile, imageCapability: selected.imageCapability,
      })],
    }), undefined);
  });

  it('取消站点修改不会持久化，也不会改动原凭据', () => {
    render(); form().setBaseUrl('https://toapis.com/v1'); render(); click('取消');
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.initialConfig).toMatchObject({ baseUrl: 'https://toapis.cn/v1', apiKey: 'shared-fixture' });
  });

  it('切换会取消旧站请求，新站目录缺失已选模型时保留原勾选和配置', async () => {
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
    const selected = props.initialConfig!.selectedModels![0];
    expect(section().models.map((model) => model.id)).toEqual(['grok-4.7', 'gpt-image-2']);
    expect(section().selectedModels).toEqual([expect.objectContaining({
      id: selected.id, executionProfile: selected.executionProfile, imageCapability: selected.imageCapability,
    })]);
    click('保存更改');
    expect(props.onSave).toHaveBeenCalledWith('toapis-user', expect.objectContaining({
      baseUrl: 'https://toapis.com/v1', apiKey: 'shared-fixture', selectedModels: [expect.objectContaining({
        id: selected.id, provider: 'toapis-user', executionProfile: selected.executionProfile, imageCapability: selected.imageCapability,
      })],
    }), undefined);
    expect(driver.catalog.mock.calls[1][0].config).toMatchObject({ baseUrl: 'https://toapis.com/v1', apiKey: 'shared-fixture' });
  });

  it('目录刷新保留请求期间新勾选的模型', async () => {
    let finish!: (result: unknown) => void;
    driver.catalog.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render();
    const pending = section().onFetchModels();
    render();
    section().onToggleModel('seedance-2-5');
    finish({ source: 'remote', models: [props.initialConfig!.selectedModels![0]] });
    await pending;
    render();
    expect(section().selectedModels.map((model) => model.id)).toEqual(['gpt-image-2', 'seedance-2-5']);
    expect(form().catalogStatus).toBe('warning');
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

describe('Magpie 目录快照与手动配置', () => {
  function setupMagpie() {
    const model: ProviderModelSelection = { id: 'm', name: 'Model', category: 'text', provider: 'magpie-user' };
    const config = { name: 'Magpie', catalogId: 'magpie', baseUrl: 'https://magpie.example/v1', apiKey: 'fixture',
      selectedModels: [{ ...model, contextWindow: 64_000 }],
      catalogModels: [{ ...model, catalogTextLimits: { source: 'magpie' as const, contextWindow: 128_000 } }],
      catalogUpdatedAt: 1,
    };
    props = { ...props, connectionId: 'magpie-user', initialConfig: config, providerConfigs: { 'magpie-user': config } };
  }

  it('刷新失败保留目录，收到完整空目录后保留已选模型和手动窗口', async () => {
    setupMagpie();
    render();
    driver.catalog.mockRejectedValueOnce(new Error('目录暂不可用'));
    await section().onFetchModels();
    render();
    expect(section().catalogStatus).toBe('error');
    expect(section().magpieCatalogIds?.has('m')).toBe(true);
    expect(section().selectedModels[0]).toMatchObject({
      contextWindow: 64_000, catalogTextLimits: { contextWindow: 128_000 },
    });

    driver.catalog.mockResolvedValueOnce({ source: 'remote', models: [] });
    await section().onFetchModels();
    render();
    expect(section().magpieCatalogIds?.has('m')).toBe(false);
    expect(section().selectedModels[0]).toMatchObject({ id: 'm', contextWindow: 64_000 });
    expect(section().selectedModels[0].catalogTextLimits).toBeUndefined();
    await click('保存更改');
    expect(props.onSave).toHaveBeenCalledWith('magpie-user', expect.objectContaining({
      catalogModels: [], selectedModels: [expect.objectContaining({ id: 'm', contextWindow: 64_000 })],
    }), undefined);
  });

  it('编辑期间修改协议可取消查询，旧查询迟到时仍保留手动值', async () => {
    setupMagpie();
    let complete!: (value: unknown) => void;
    driver.catalog.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    render();
    const pending = section().onFetchModels();
    render();
    form().setChatApiProtocol('openai-responses');
    render();
    expect(driver.catalog.mock.calls[0][0].signal.aborted).toBe(true);
    complete({ source: 'remote', models: [{ id: 'stale', category: 'text', name: 'Stale' }] });
    await pending;
    render();
    expect(section().magpieCatalogIds).toBeUndefined();
    expect(section().models.map((model) => model.id)).toEqual(['m']);
    expect(section().selectedModels[0]).toMatchObject({ contextWindow: 64_000 });
  });
});

describe('厂商目录策略保持已有交互', () => {
  function fixtureModel(id: string): ProviderModelSelection {
    return { id, name: id, provider: 'fixture-connection', category: 'text', executionProfile: { preset: 'openai-chat' } };
  }

  function editConnection(catalogId: 'toapis' | 'libapi' | 'custom-openai') {
    const config = { name: '测试连接', catalogId, apiKey: 'fixture', baseUrl: 'https://gateway.example/v1',
      selectedModels: [fixtureModel('kept'), fixtureModel('retired')], catalogModels: [fixtureModel('cached')] };
    props = { ...props, connectionId: 'fixture-connection', initialConfig: config,
      providerConfigs: { 'fixture-connection': config }, connectedProviderIds: [catalogId],
      fallbackModels: { [catalogId]: [fixtureModel('fallback-only')] } };
    driver.scope = { values: [], index: 0 };
  }

  it.each([
    { catalogId: 'toapis', expected: ['fallback-only'] },
    { catalogId: 'libapi', expected: ['fallback-only'] },
    { catalogId: 'custom-openai', expected: ['fallback-only'] },
  ] as const)('新建 $catalogId 时使用该厂商初始列表，不把本地清单当远端验证', ({ catalogId, expected }) => {
    props = { ...props, connectionId: undefined, initialConfig: undefined,
      providerConfigs: {}, connectedProviderIds: [], fallbackModels: { [catalogId]: [fixtureModel('fallback-only')] } };
    driver.scope = { values: [], index: 0 };
    render();
    const choice = elements(tree).find((element) => element.key === catalogId)!;
    (choice.props.onClick as () => void)();
    render();
    expect(section().models.map((model) => model.id)).toEqual([...expected]);
    expect(section().selectedModels).toEqual([]);
    expect(driver.catalog).not.toHaveBeenCalled();
  });

  it.each([
    { catalogId: 'toapis', expected: ['fallback-only', 'cached', 'kept', 'retired'] },
    { catalogId: 'libapi', expected: ['fallback-only', 'cached', 'kept', 'retired'] },
    { catalogId: 'custom-openai', expected: ['fallback-only', 'cached', 'kept', 'retired'] },
  ] as const)('编辑 $catalogId 时保留缓存与勾选，并按原规则合并初始清单', ({ catalogId, expected }) => {
    editConnection(catalogId);
    render();
    expect(section().models.map((model) => model.id)).toEqual([...expected]);
    expect(section().selectedModels.map((model) => model.id)).toEqual(['kept', 'retired']);
  });

  it('LibAPI 未填 Key 也预置全部四类已适配型号，等待用户勾选而不请求远端', () => {
    const defaults = [...getProviderDefinition('libapi')!.models!];
    props = { ...props, connectionId: undefined, initialConfig: undefined,
      providerConfigs: {}, connectedProviderIds: [], fallbackModels: { libapi: defaults } };
    driver.scope = { values: [], index: 0 };
    render();
    const choice = elements(tree).find((element) => element.key === 'libapi')!;
    (choice.props.onClick as () => void)();
    render();
    expect(section().models.map((model) => model.id)).toEqual(defaults.map((model) => model.id));
    expect(section().models.filter((model) => model.category === 'text')).toHaveLength(8);
    expect(section().models.filter((model) => model.category === 'image')).toHaveLength(22);
    expect(section().models.filter((model) => model.category === 'video')).toHaveLength(31);
    expect(section().models.filter((model) => model.category === 'audio')).toHaveLength(6);
    expect(section().selectedModels).toEqual([]);
    expect(section().missingCredentials).toBe(true);
    expect(driver.catalog).not.toHaveBeenCalled();
  });

  it.each(['toapis', 'libapi', 'custom-openai'] as const)('%s 刷新成功时正确更新勾选，拉取失败保留原目录', async (catalogId) => {
    editConnection(catalogId);
    render();
    const before = section().models.map((model) => model.id);
    driver.catalog.mockRejectedValueOnce(new Error('目录暂不可用'));
    await section().onFetchModels();
    render();
    expect(form().catalogStatus).toBe('error');
    expect(section().models.map((model) => model.id)).toEqual(before);
    expect(section().selectedModels.map((model) => model.id)).toEqual(['kept', 'retired']);
    driver.catalog.mockResolvedValueOnce({ source: 'remote', models: [fixtureModel('kept'), fixtureModel('new')] });
    await section().onFetchModels();
    render();
    const expectedModels = {
      toapis: ['kept', 'retired', 'new'], libapi: ['kept', 'new'], 'custom-openai': [...before, 'new'],
    }[catalogId];
    expect(section().models.map((model) => model.id)).toEqual(expectedModels);
    expect(section().selectedModels.map((model) => model.id)).toEqual(catalogId === 'libapi' ? ['kept'] : ['kept', 'retired']);
    expect(form().catalogStatus).toBe(catalogId === 'toapis' ? 'warning' : 'ready');
  });

  it.each(['toapis', 'libapi'] as const)('%s 的验证连接沿用目录拉取与权限刷新', async (catalogId) => {
    editConnection(catalogId);
    render();
    driver.catalog.mockResolvedValueOnce({ source: 'remote', models: [fixtureModel('kept')] });
    await form().onTestConnection();
    render();
    expect(driver.catalog).toHaveBeenCalledOnce();
    expect(driver.catalog.mock.calls[0][0]).toMatchObject({ providerId: catalogId,
      config: { catalogId, apiKey: 'fixture' } });
    const expected = catalogId === 'toapis' ? ['kept', 'retired'] : ['kept'];
    expect(section().models.map((model) => model.id)).toEqual(expected);
    expect(section().selectedModels.map((model) => model.id)).toEqual(expected);
  });

  it('万象编辑模型参数沿用原连接的分组和 Key，保留目录未返回的勾选', async () => {
    const connectionId = 'my-claude-connection';
    const selected = { ...fixtureModel('claude-opus-5-5'), provider: connectionId };
    const normalizedSelection = { ...selected, name: 'Claude Opus 5.5' };
    const config = { name: '旧 Claude 连接', catalogId: 'relayonapi', relayonGroup: 'ClaudeMax号池',
      apiKey: 'legacy-relay-fixture', baseUrl: 'https://relayonapi.com/v1', selectedModels: [selected] };
    props = { ...props, connectionId, initialConfig: config, providerConfigs: { [connectionId]: config },
      forceSingleGroupEdit: true, fallbackModels: { relayonapi: [...getProviderDefinition('relayonapi')!.models!] } };
    render();
    driver.catalog.mockResolvedValue({ source: 'remote', models: [] });
    await form().onTestConnection();
    render();
    await section().onFetchModels();
    render();
    expect(driver.catalog).toHaveBeenCalledTimes(2);
    for (const [request] of driver.catalog.mock.calls) {
      expect(request).toMatchObject({ providerId: connectionId,
        config: { catalogId: config.catalogId, relayonGroup: config.relayonGroup, apiKey: config.apiKey, baseUrl: config.baseUrl } });
    }
    expect(form().catalogStatus).toBe('warning');
    expect(section().selectedModels).toEqual([expect.objectContaining(normalizedSelection)]);
    await click('保存更改');
    expect(props.onSave).toHaveBeenCalledWith(connectionId, expect.objectContaining({
      relayonGroup: config.relayonGroup, apiKey: config.apiKey, selectedModels: [expect.objectContaining(normalizedSelection)],
    }), undefined);
  });

  it('LibAPI 修改 Key 同样取消旧请求，旧权限的迟到目录不能污染新 Key', async () => {
    editConnection('libapi');
    let finish!: (result: unknown) => void;
    driver.catalog.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render();
    const pending = section().onFetchModels();
    const oldSignal = driver.catalog.mock.calls[0][0].signal as AbortSignal;
    render();
    form().setApiKey('new-fixture');
    render();
    expect(oldSignal.aborted).toBe(true);
    finish({ source: 'remote', models: [fixtureModel('stale')] });
    await pending;
    render();
    expect(form().apiKey).toBe('new-fixture');
    expect(form().catalogStatus).toBe('idle');
    expect(section().models.some((model) => model.id === 'stale')).toBe(false);
    expect(section().selectedModels.map((model) => model.id)).toEqual(['kept', 'retired']);
  });
});

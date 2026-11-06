/**
 * cccGroupConnection — 回归测试：CCC simultaneous group settings。
 */
import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface HookScope { values: unknown[]; index: number }
const driver = vi.hoisted(() => ({ scope: null as HookScope | null, catalog: vi.fn() }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const scope = driver.scope!;
    const index = scope.index++;
    if (!(index in scope.values)) scope.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [scope.values[index] as T, (value: T | ((previous: T) => T)) => {
      scope.values[index] = typeof value === 'function' ? (value as (previous: T) => T)(scope.values[index] as T) : value;
    }];
  },
  useRef: <T,>(initial: T) => {
    const scope = driver.scope!;
    return scope.values[scope.index++] ??= { current: initial };
  },
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
import ProviderConnectionDialog from '../../src/components/settings/ProviderConnectionDialog';
import { CccGroupConnectionsForm } from '../../src/components/settings/providerConnection/ProviderConnectionForm';
import AnimatedButton from '../../src/components/shared/AnimatedButton';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';
import { CCC_PROVIDER_GROUPS } from '../../src/services/ai/cccProviderGroups';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
type Props = ComponentProps<typeof CccGroupConnectionsForm>;
let props: Props;
let tree: unknown;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function render() {
  driver.scope!.index = 0;
  tree = CccGroupConnectionsForm(props);
}
function field(label: string) {
  return elements(tree).find((element) => element.props['aria-label'] === label)!;
}
function key(group: string, value: string) {
  (field(`${group} API Key`).props.onChange as (event: unknown) => void)({ target: { value } }); render();
}
function toggle(group: string, modelId: string) {
  (field(`启用 ${group} ${modelId}`).props.onChange as () => void)(); render();
}
function selectAll(group: string, checked: boolean) {
  (field(`选择全部模型 ${group}`).props.onChange as (event: unknown) => void)({ target: { checked } }); render();
}
function currentModelIds(group: string): string[] {
  const current = elements(field(group)).find((element) => element.type === 'details' && !element.props['aria-label']);
  return elements(current).flatMap((element) => {
    const label = element.props['aria-label'];
    return element.type === 'input' && typeof label === 'string' && label.startsWith(`启用 ${group} `)
      ? [label.slice(`启用 ${group} `.length)] : [];
  });
}
async function pull(group: string) {
  await (field(`拉取模型 ${group}`).props.onClick as () => Promise<void>)(); render();
}
async function save() {
  const button = elements(tree).find((element) => element.type === AnimatedButton && element.props.children === '保存全部分组')!;
  expect(button.props.disabled).toBe(false);
  await (button.props.onClick as () => Promise<void>)(); render();
}
const banana = '🍌香蕉（官k）';
const stable = 'CCC生图稳定';

beforeEach(() => {
  driver.scope = { values: [], index: 0 };
  driver.catalog.mockReset().mockResolvedValue({ source: 'remote', models: [
    { id: 'gpt-image-2', name: 'GPT Image 2', category: 'image', provider: 'cccapi' },
  ] });
  vi.stubGlobal('document', { body: {} });
  props = { providerConfigs: {}, presetModels: [...getProviderDefinition('cccapi')!.models!],
    onClose: vi.fn(), onSave: vi.fn().mockResolvedValue(undefined),
  };
});

describe('CCC simultaneous group settings', () => {
  it('shows all eight Key fields and their own models at once without a group switch', () => {
    render();
    for (const group of CCC_PROVIDER_GROUPS) expect(field(`${group.name} API Key`)).toBeDefined();
    expect(elements(tree).filter((element) => element.type === 'section')).toHaveLength(8);
    expect(field(`启用 ${banana} Nano-Banana-pro`)).toBeDefined();
    expect(currentModelIds(banana)).toEqual(['Nano-Banana-pro', 'Nano-Banana-2', 'Nano-Banana-2.1']);
    expect(field(`启用 ${banana} nano-banana-pro`)).toBeUndefined();
    for (const id of currentModelIds(banana)) expect(field(`启用 ${banana} ${id}`).props.checked).toBe(false);
    expect(field(`启用 ${banana} gpt-image-2`)).toBeUndefined();
    expect(field(`启用 ${stable} gpt-image-2`)).toBeDefined();
    expect(elements(tree).some((element) => element.type === 'select')).toBe(false);
    expect(driver.catalog).not.toHaveBeenCalled();
  });

  it('keeps a nine-model stale catalog out of the current list while preserving six legacy selections', async () => {
    const catalog = props.presetModels.filter((model) => /^(?:gemini-.*image|nano-banana)/i.test(model.id));
    const legacy = catalog.filter((model) => !['Nano-Banana-pro', 'Nano-Banana-2', 'Nano-Banana-2.1'].includes(model.id))
      .map((model) => ({ ...model, provider: 'cccapi-banana' }));
    expect(catalog).toHaveLength(9);
    expect(legacy).toHaveLength(6);
    props.providerConfigs = { 'cccapi-banana': { name: '香蕉', catalogId: 'cccapi', cccGroup: banana,
      apiKey: 'banana-fixture', catalogModels: catalog, selectedModels: legacy } };
    render();
    expect(currentModelIds(banana)).toEqual(['Nano-Banana-pro', 'Nano-Banana-2', 'Nano-Banana-2.1']);
    const compatibility = field(`已保存的兼容型号 ${banana}`);
    expect(compatibility.type).toBe('details');
    expect(compatibility.props.open).toBeUndefined();
    for (const model of legacy) expect(elements(compatibility).some((element) =>
      element.props['aria-label'] === `启用 ${banana} ${model.id}` && element.props.checked === true)).toBe(true);
    for (const id of currentModelIds(banana)) expect(field(`启用 ${banana} ${id}`).props.checked).toBe(false);
    await save();
    expect(vi.mocked(props.onSave).mock.calls[0][0]['cccapi-banana'].selectedModels).toEqual(legacy);
    selectAll(banana, true);
    for (const model of legacy) expect(field(`启用 ${banana} ${model.id}`).props.checked).toBe(true);
    selectAll(banana, false);
    expect(field(`选择全部模型 ${banana}`).props.checked).toBe(false);
    await save();
    expect(vi.mocked(props.onSave).mock.calls[1][0]['cccapi-banana'].selectedModels).toEqual(legacy);
    toggle(banana, legacy[0].id);
    await save();
    expect(vi.mocked(props.onSave).mock.calls[2][0]['cccapi-banana'].selectedModels).toEqual(legacy.slice(1));
  });

  it('retains saved canonical custom protocols and capabilities through initialization and refresh', async () => {
    const preset = props.presetModels.find((model) => model.id === 'Nano-Banana-pro')!;
    const selected = { ...preset, provider: 'cccapi-banana', imageCapability: {
      resolutions: ['2K'], defaultResolution: '2K', ratios: ['9:16'], defaultRatio: '9:16',
      supportsImageReference: true, maxImageReferences: 2,
    }, executionProfile: { preset: 'custom' as const, protocol: { version: 2 as const, mode: 'sync' as const,
      submit: { method: 'POST' as const, path: '/my-image', headers: { 'X-Mode': 'custom' },
        body: { prompt: '{{prompt}}', images: '{{imageUrls}}' } },
      response: { type: 'json' as const, result: { urlPath: 'result.image' } },
    } } };
    props.providerConfigs = { 'cccapi-banana': { name: '香蕉', catalogId: 'cccapi', cccGroup: banana,
      apiKey: 'banana-fixture', catalogModels: [preset], selectedModels: [selected] } };
    render(); await save();
    expect(vi.mocked(props.onSave).mock.calls[0][0]['cccapi-banana'].selectedModels).toEqual([selected]);
    driver.catalog.mockResolvedValueOnce({ source: 'remote', models: [preset] });
    await pull(banana);
    expect(currentModelIds(banana)).toEqual(['Nano-Banana-pro']);
    expect(field(`已保存的兼容型号 ${banana}`)).toBeUndefined();
    await save();
    expect(vi.mocked(props.onSave).mock.calls[1][0]['cccapi-banana'].selectedModels).toEqual([selected]);
  });

  it('keeps missing canonical and legacy selections in compatibility after refresh without enabling new candidates', async () => {
    const canonical = { ...props.presetModels.find((model) => model.id === 'Nano-Banana-pro')!, provider: 'cccapi-banana' };
    const legacy = { ...props.presetModels.find((model) => model.id === 'gemini-3-pro-image-preview')!,
      provider: 'cccapi-banana', imageCapability: { supportsImageReference: true, maxImageReferences: 3 } };
    props.providerConfigs = { 'cccapi-banana': { name: '香蕉', catalogId: 'cccapi', cccGroup: banana,
      apiKey: 'banana-fixture', selectedModels: [canonical, legacy] } };
    render();
    driver.catalog.mockResolvedValueOnce({ source: 'remote', models: [
      props.presetModels.find((model) => model.id === 'Nano-Banana-2')!,
    ] });
    await pull(banana);
    expect(currentModelIds(banana)).toEqual(['Nano-Banana-2']);
    expect(field(`启用 ${banana} Nano-Banana-2`).props.checked).toBe(false);
    const compatibility = field(`已保存的兼容型号 ${banana}`);
    for (const model of [canonical, legacy]) expect(elements(compatibility).some((element) =>
      element.props['aria-label'] === `启用 ${banana} ${model.id}` && element.props.checked === true)).toBe(true);
    expect(elements(tree).some((element) => element.props.role === 'status' && element.props.children ===
      '部分已选模型未出现在本次目录中，已保留原配置，请确认该 Key 和分组权限。')).toBe(true);
    await save();
    expect(vi.mocked(props.onSave).mock.calls[0][0]['cccapi-banana']).toMatchObject({
      apiKey: 'banana-fixture', selectedModels: [canonical, legacy],
    });
  });

  it('does not graft template capabilities onto a saved custom protocol that only accepts prompt', async () => {
    const preset = props.presetModels.find((model) => model.id === 'Nano-Banana-pro')!;
    const selected = structuredClone(preset);
    selected.provider = 'cccapi-banana';
    selected.executionProfile = { preset: 'custom', protocol: { version: 2, mode: 'sync',
      submit: { method: 'POST', path: '/my-image', body: { prompt: '{{prompt}}' } },
      response: { type: 'json', result: { urlPath: 'result.image' } },
    } };
    delete selected.imageCapability;
    props.providerConfigs = { 'cccapi-banana': { name: '香蕉', catalogId: 'cccapi', cccGroup: banana,
      apiKey: 'banana-fixture', catalogModels: [preset], selectedModels: [selected] } };
    render(); await save();
    const initialized = vi.mocked(props.onSave).mock.calls[0][0]['cccapi-banana'].selectedModels![0];
    expect(initialized).not.toHaveProperty('imageCapability');
    expect(initialized).toEqual(selected);
    driver.catalog.mockResolvedValueOnce({ source: 'remote', models: [preset] });
    await pull(banana); await save();
    const refreshed = vi.mocked(props.onSave).mock.calls[1][0]['cccapi-banana'].selectedModels![0];
    expect(refreshed).not.toHaveProperty('imageCapability');
    expect(refreshed).toEqual(selected);
  });

  it('does not take over an explicitly custom connection whose ID happens to be cccapi', async () => {
    props.providerConfigs = { cccapi: { name: '自己的接口', catalogId: 'custom-openai', cccGroup: banana,
      apiKey: 'custom-fixture', selectedModels: [{ id: 'my-image', name: '自己的图片', category: 'image', provider: 'cccapi' }] } };
    render();
    expect(field(`${banana} API Key`).props.value).toBe('');
    expect(field(`启用 ${banana} my-image`)).toBeUndefined();
    key(banana, 'new-banana-fixture');
    await save();
    const saved = vi.mocked(props.onSave).mock.calls[0][0];
    expect(saved).not.toHaveProperty('cccapi');
    expect(Object.values(saved)).toHaveLength(1);
    expect(Object.values(saved)[0].apiKey).toBe('new-banana-fixture');
  });

  it('preserves unselected cached custom contracts before the user enables them', async () => {
    const preset = props.presetModels.find((model) => model.id === 'Nano-Banana-pro')!;
    const cached = structuredClone(preset);
    cached.provider = 'cccapi-banana';
    cached.executionProfile = { preset: 'custom', protocol: { version: 2, mode: 'sync',
      submit: { method: 'POST', path: '/cached-custom', body: { prompt: '{{prompt}}' } },
      response: { type: 'json', result: { urlPath: 'image.url' } },
    } };
    delete cached.imageCapability;
    props.providerConfigs = { 'cccapi-banana': { name: '香蕉', catalogId: 'cccapi', cccGroup: banana,
      apiKey: 'banana-fixture', catalogModels: [cached], selectedModels: [] } };
    render();
    expect(field(`启用 ${banana} Nano-Banana-pro`).props.checked).toBe(false);
    driver.catalog.mockResolvedValueOnce({ source: 'remote', models: [preset] });
    await pull(banana);
    toggle(banana, 'Nano-Banana-pro');
    await save();
    const selected = vi.mocked(props.onSave).mock.calls[0][0]['cccapi-banana'].selectedModels![0];
    expect(selected).not.toHaveProperty('imageCapability');
    expect(selected).toEqual(cached);
  });

  it('keeps multiple Keys and selections while editing and saves all groups in one call', async () => {
    render();
    key(banana, 'banana-fixture'); toggle(banana, 'Nano-Banana-pro');
    key(stable, 'stable-fixture'); toggle(stable, 'gpt-image-2');
    expect(field(`${banana} API Key`).props.value).toBe('banana-fixture');
    expect(field(`启用 ${banana} Nano-Banana-pro`).props.checked).toBe(true);
    await save();
    expect(props.onSave).toHaveBeenCalledTimes(1);
    const connections = vi.mocked(props.onSave).mock.calls[0][0];
    expect(Object.keys(connections)).toHaveLength(2);
    const [bananaId, bananaConfig] = Object.entries(connections).find(([, config]) => config.cccGroup === banana)!;
    const [stableId, stableConfig] = Object.entries(connections).find(([, config]) => config.cccGroup === stable)!;
    expect(bananaId).not.toBe(stableId);
    expect(bananaConfig.apiKey).toBe('banana-fixture');
    expect(bananaConfig.baseUrl).toBe('https://cccapi.cn/v1');
    expect(bananaConfig.selectedModels).toEqual([expect.objectContaining({ id: 'Nano-Banana-pro', provider: bananaId })]);
    expect(stableConfig.apiKey).toBe('stable-fixture');
    expect(stableConfig.baseUrl).toBe('https://cccapi.cn/v1');
    expect(stableConfig.selectedModels).toEqual([expect.objectContaining({ id: 'gpt-image-2', provider: stableId })]);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    // Simulate a reopen using restored configuration: no Key needs to be entered again.
    props.providerConfigs = connections; driver.scope = { values: [], index: 0 }; render();
    expect(field(`${banana} API Key`).props.value).toBe('banana-fixture');
    expect(field(`${stable} API Key`).props.value).toBe('stable-fixture');
    expect(field(`启用 ${banana} Nano-Banana-pro`).props.checked).toBe(true);
    expect(field(`启用 ${stable} gpt-image-2`).props.checked).toBe(true);
    await save();
    expect(Object.keys(vi.mocked(props.onSave).mock.calls[1][0])).toEqual(Object.keys(connections));
  });

  it('keeps legacy, duplicate and unknown-group connection identities and credentials', async () => {
    props.providerConfigs = {
      cccapi: { name: 'CCC', apiKey: 'legacy-fixture', selectedModels: [{ id: 'old-model', name: 'Old', category: 'text', provider: 'cccapi' }] },
      'cccapi-a': { name: 'CCC', apiKey: 'a-fixture', catalogId: 'cccapi', cccGroup: stable },
      'cccapi-b': { name: 'CCC', apiKey: 'b-fixture', catalogId: 'cccapi', cccGroup: stable },
      'cccapi-new': { name: 'CCC', apiKey: 'new-fixture', catalogId: 'cccapi', cccGroup: '新分组', baseUrl: 'https://custom.example/v1' },
    };
    render(); await save();
    const connections = vi.mocked(props.onSave).mock.calls[0][0];
    expect(Object.keys(connections)).toEqual(expect.arrayContaining(['cccapi', 'cccapi-a', 'cccapi-b', 'cccapi-new']));
    expect(connections.cccapi.apiKey).toBe('legacy-fixture');
    expect(connections.cccapi.selectedModels?.[0].id).toBe('old-model');
    expect(connections['cccapi-b'].apiKey).toBe('b-fixture');
    expect(connections['cccapi-new'].cccGroup).toBe('新分组');
    expect(connections['cccapi-new'].baseUrl).toBe('https://custom.example/v1');
  });

  it('refreshes only the requested group and preserves matching user metadata', async () => {
    props.providerConfigs = { 'cccapi-stable': { name: 'CCC', catalogId: 'cccapi', cccGroup: stable, apiKey: 'stable-fixture', selectedModels: [
      { id: 'gpt-image-2', name: 'Image', category: 'image', provider: 'cccapi-stable', description: '我的说明', descriptionManual: true },
      { id: 'gpt-image-1', name: 'Old', category: 'image', provider: 'cccapi-stable' },
    ] } };
    render(); key(banana, 'banana-fixture'); toggle(banana, 'Nano-Banana-pro');
    await pull(stable);
    expect(driver.catalog).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'cccapi-stable', config: expect.objectContaining({ cccGroup: stable, apiKey: 'stable-fixture' }) }));
    expect(field(`启用 ${stable} gpt-image-1`)).toBeUndefined();
    expect(field(`${banana} API Key`).props.value).toBe('banana-fixture');
    await save();
    expect(vi.mocked(props.onSave).mock.calls[0][0]['cccapi-stable'].selectedModels).toEqual([
      expect.objectContaining({ id: 'gpt-image-2', description: '我的说明', descriptionManual: true }),
    ]);
  });

  it('ignores an old response when its Key changes without affecting another group request', async () => {
    render(); key(stable, 'old-fixture'); key(banana, 'banana-fixture');
    let finish!: (value: unknown) => void;
    driver.catalog.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const fetching = pull(stable);
    key(stable, 'new-fixture');
    const oldSignal = driver.catalog.mock.calls[0][0].signal;
    driver.catalog.mockResolvedValueOnce({ source: 'remote', models: [{ id: 'Nano-Banana-pro', name: 'Banana', category: 'image', provider: 'cccapi' }] });
    await pull(banana);
    expect(oldSignal.aborted).toBe(true);
    expect(driver.catalog.mock.calls[1][0].signal.aborted).toBe(false);
    finish({ source: 'remote', models: [{ id: 'stale-model', name: 'Stale', category: 'image', provider: 'cccapi' }] });
    await fetching; render();
    expect(field(`启用 ${stable} stale-model`)).toBeUndefined();
    expect(field(`${stable} API Key`).props.value).toBe('new-fixture');
    expect(field(`启用 ${banana} Nano-Banana-pro`)).toBeDefined();
  });

  it('reports a single-group directory error while preserving all Keys and models', async () => {
    render(); key(stable, 'invalid-fixture'); key(banana, 'banana-fixture'); toggle(banana, 'Nano-Banana-pro');
    driver.catalog.mockRejectedValueOnce(new Error('目录失败（403）'));
    await pull(stable);
    expect(elements(tree).some((element) => element.props.role === 'alert' && element.props.children === '目录失败（403）')).toBe(true);
    expect(field(`启用 ${stable} gpt-image-2`)).toBeDefined();
    expect(field(`${banana} API Key`).props.value).toBe('banana-fixture');
    expect(field(`启用 ${banana} Nano-Banana-pro`).props.checked).toBe(true);
  });

  it('keeps all drafts open after save failure and supports retry', async () => {
    render(); key(banana, 'banana-fixture'); key(stable, 'stable-fixture');
    vi.mocked(props.onSave).mockRejectedValueOnce(new Error('保存失败'));
    await save();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(field(`${banana} API Key`).props.value).toBe('banana-fixture');
    expect(field(`${stable} API Key`).props.value).toBe('stable-fixture');
    await save(); expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('preserves legacy implicit model activation until the user explicitly edits the selection', async () => {
    props.providerConfigs = { 'cccapi-stable': { name: 'CCC', catalogId: 'cccapi', cccGroup: stable, apiKey: 'stable-fixture' } };
    render(); await save();
    expect(vi.mocked(props.onSave).mock.calls[0][0]['cccapi-stable'].selectedModels).toBeUndefined();
    toggle(stable, 'gpt-image-2'); toggle(stable, 'gpt-image-2'); await save();
    expect(vi.mocked(props.onSave).mock.calls[1][0]['cccapi-stable'].selectedModels).toEqual([]);
  });

  it('keeps the legacy image request defaults when saving multiple groups', async () => {
    props.providerConfigs = { 'cccapi-stable': { name: 'CCC', catalogId: 'cccapi', cccGroup: stable, apiKey: 'stable-fixture',
      imageProtocolDefault: { preset: 'gpt-image-gateway-json' }, imageReferenceRequestModeDefault: 'generation-json-image-data-urls',
      selectedModels: [{ id: 'gpt-image-2', name: 'Image', category: 'image', provider: 'cccapi-stable' }],
    } };
    render(); key(banana, 'banana-fixture'); await save();
    expect(vi.mocked(props.onSave).mock.calls[0][0]['cccapi-stable'].selectedModels).toEqual([
      expect.objectContaining({ id: 'gpt-image-2', executionProfile: { preset: 'gpt-image-gateway-json' }, imageReferenceRequestMode: 'generation-json-image-data-urls' }),
    ]);
  });

  it('cancels pending directory work on save and leaves that group retryable after a save failure', async () => {
    render(); key(stable, 'stable-fixture');
    let finish!: (value: unknown) => void;
    driver.catalog.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const fetching = pull(stable); render();
    expect(field(`拉取模型 ${stable}`).props.disabled).toBe(true);
    vi.mocked(props.onSave).mockRejectedValueOnce(new Error('保存失败'));
    await save();
    expect(driver.catalog.mock.calls[0][0].signal.aborted).toBe(true);
    expect(field(`拉取模型 ${stable}`).props.disabled).toBe(false);
    finish({ source: 'remote', models: [] }); await fetching;
    expect(field(`启用 ${stable} gpt-image-2`)).toBeDefined();
  });

  it('can save model choices before a Key is filled without creating unused blank groups', async () => {
    render(); toggle(banana, 'Nano-Banana-pro'); await save();
    const connections = Object.values(vi.mocked(props.onSave).mock.calls[0][0]);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ cccGroup: banana, apiKey: '', selectedModels: [expect.objectContaining({ id: 'Nano-Banana-pro' })] });
  });

  it('copies only the requested saved group and provides no actions for blank groups', async () => {
    props.providerConfigs = { 'cccapi-stable': { name: 'CCC', catalogId: 'cccapi', cccGroup: stable, apiKey: 'stable-fixture' } };
    props.onCopyConnection = vi.fn().mockResolvedValue(undefined);
    props.onRemoveConnection = vi.fn().mockResolvedValue(true);
    render();
    expect(field(`复制分组配置 ${banana}`)).toBeUndefined();
    expect(field(`删除分组 ${banana}`)).toBeUndefined();
    await (field(`复制分组配置 ${stable}`).props.onClick as () => Promise<void>)();
    expect(props.onCopyConnection).toHaveBeenCalledExactlyOnceWith('cccapi-stable');
    expect(props.onRemoveConnection).not.toHaveBeenCalled();
  });

  it('confirms deletion of one group, preserves other drafts and never resurrects the removed connection on save', async () => {
    props.providerConfigs = { 'cccapi-stable': { name: 'CCC', catalogId: 'cccapi', cccGroup: stable, apiKey: 'stable-fixture',
      selectedModels: [{ id: 'gpt-image-2', name: 'Image', category: 'image', provider: 'cccapi-stable' }],
    } };
    props.onRemoveConnection = vi.fn().mockResolvedValue(true);
    render(); key(banana, 'banana-draft'); toggle(banana, 'Nano-Banana-pro');
    (field(`删除分组 ${stable}`).props.onClick as () => void)(); render();
    expect(props.onRemoveConnection).not.toHaveBeenCalled();
    await (field(`确认删除 ${stable}`).props.onClick as () => Promise<void>)(); render();
    expect(props.onRemoveConnection).toHaveBeenCalledExactlyOnceWith('cccapi-stable');
    expect(elements(tree).filter((element) => element.type === 'section')).toHaveLength(8);
    expect(field(`${stable} API Key`).props.value).toBe('');
    expect(field(`启用 ${stable} gpt-image-2`).props.checked).toBe(false);
    expect(field(`${banana} API Key`).props.value).toBe('banana-draft');
    expect(field(`启用 ${banana} Nano-Banana-pro`).props.checked).toBe(true);
    await save();
    expect(vi.mocked(props.onSave).mock.calls[0][0]).not.toHaveProperty('cccapi-stable');
    expect(Object.values(vi.mocked(props.onSave).mock.calls[0][0])).toHaveLength(1);
    key(stable, 'replacement-fixture'); await save();
    const replacement = Object.entries(vi.mocked(props.onSave).mock.calls[1][0]).find(([, config]) => config.cccGroup === stable)!;
    expect(replacement[0]).not.toBe('cccapi-stable');
    expect(replacement[1].apiKey).toBe('replacement-fixture');
  });

  it('keeps a failed deletion retryable and ignores the aborted directory result', async () => {
    props.providerConfigs = { 'cccapi-stable': { name: 'CCC', catalogId: 'cccapi', cccGroup: stable, apiKey: 'stable-fixture' } };
    props.onRemoveConnection = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    let finish!: (value: unknown) => void;
    driver.catalog.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render();
    const fetching = pull(stable); render();
    (field(`删除分组 ${stable}`).props.onClick as () => void)(); render();
    await (field(`确认删除 ${stable}`).props.onClick as () => Promise<void>)(); render();
    expect(field(`${stable} API Key`).props.value).toBe('stable-fixture');
    expect(field(`确认删除 ${stable}`).props.disabled).toBe(false);
    expect(field(`拉取模型 ${stable}`).props.disabled).toBe(false);
    expect(driver.catalog.mock.calls[0][0].signal.aborted).toBe(true);
    finish({ source: 'remote', models: [{ id: 'stale', name: 'Stale', category: 'image', provider: 'cccapi' }] });
    await fetching;
    expect(field(`启用 ${stable} stale`)).toBeUndefined();
    await (field(`确认删除 ${stable}`).props.onClick as () => Promise<void>)(); render();
    expect(field(`${stable} API Key`).props.value).toBe('');
  });

  it('opens the simultaneous group form from the provider picker and from any saved CCC connection', () => {
    const parentProps: ComponentProps<typeof ProviderConnectionDialog> = { isOpen: true, providerConfigs: {}, connectedProviderIds: ['cccapi'],
      fallbackModels: { cccapi: props.presetModels }, dreaminaLoggedIn: false, dreaminaLoading: false,
      onDreaminaLogin: vi.fn(), onClose: vi.fn(), onSave: vi.fn(), onSaveCccGroups: vi.fn(),
      onCopyCccGroup: vi.fn(), onRemoveCccGroup: vi.fn(),
    };
    driver.scope!.index = 0;
    tree = ProviderConnectionDialog(parentProps);
    const button = elements(tree).find((element) => element.props.className === 'provider-picker-item'
      && elements(element).some((child) => child.props.children === 'CCC API'))!;
    (button.props.onClick as () => void)(); driver.scope!.index = 0;
    tree = ProviderConnectionDialog(parentProps);
    expect(elements(tree).find((element) => element.type === CccGroupConnectionsForm)!.props.onSave).toBe(parentProps.onSaveCccGroups);
    expect(elements(tree).find((element) => element.type === CccGroupConnectionsForm)!.props.onCopyConnection).toBe(parentProps.onCopyCccGroup);
    expect(elements(tree).find((element) => element.type === CccGroupConnectionsForm)!.props.onRemoveConnection).toBe(parentProps.onRemoveCccGroup);
    driver.scope = { values: [], index: 0 };
    parentProps.connectionId = 'cccapi-stable';
    parentProps.initialConfig = { name: 'CCC', apiKey: 'saved-fixture', catalogId: 'cccapi', cccGroup: stable };
    parentProps.providerConfigs['cccapi-stable'] = parentProps.initialConfig;
    tree = ProviderConnectionDialog(parentProps);
    expect(elements(tree).find((element) => element.type === CccGroupConnectionsForm)!.props.providerConfigs).toBe(parentProps.providerConfigs);
  });
});

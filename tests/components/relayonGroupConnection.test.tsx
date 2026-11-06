/**
 * relayonGroupConnection — 回归测试：万象分组连接。
 */
import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface HookScope { values: unknown[]; index: number }
const driver = vi.hoisted(() => ({ scope: null as HookScope | null, catalog: vi.fn() }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const scope = driver.scope!; const index = scope.index++;
    if (!(index in scope.values)) scope.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [scope.values[index] as T, (value: T | ((previous: T) => T)) => {
      scope.values[index] = typeof value === 'function' ? (value as (previous: T) => T)(scope.values[index] as T) : value;
    }];
  },
  useRef: <T,>(initial: T) => { const scope = driver.scope!; return scope.values[scope.index++] ??= { current: initial }; },
  useEffect: () => {},
}));
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('../../src/services/ai/providerCatalogService', async (original) => ({
  ...await original<typeof import('../../src/services/ai/providerCatalogService')>(),
  fetchProviderModelCatalog: (...args: unknown[]) => driver.catalog(...args),
}));
import { CccGroupConnectionsForm } from '../../src/components/settings/providerConnection/ProviderConnectionForm';
import AnimatedButton from '../../src/components/shared/AnimatedButton';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';
import { RELAYON_PROVIDER_GROUPS } from '../../src/services/ai/relayonProviderGroups';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
type Props = ComponentProps<typeof CccGroupConnectionsForm>;
let props: Props; let tree: unknown;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function render() { driver.scope!.index = 0; tree = CccGroupConnectionsForm(props); }
function field(label: string) { return elements(tree).find((element) => element.props['aria-label'] === label)!; }
function key(group: string, value: string) {
  (field(`${group} API Key`).props.onChange as (event: unknown) => void)({ target: { value } }); render();
}
function toggle(group: string, id: string) { (field(`启用 ${group} ${id}`).props.onChange as () => void)(); render(); }
async function save() {
  const button = elements(tree).find((item) => item.type === AnimatedButton && item.props.children === '保存全部分组')!;
  await (button.props.onClick as () => Promise<void>)(); render();
}
beforeEach(() => {
  driver.scope = { values: [], index: 0 }; driver.catalog.mockReset();
  props = { provider: 'relayonapi', providerConfigs: {}, presetModels: [...getProviderDefinition('relayonapi')!.models!],
    onSave: vi.fn().mockResolvedValue(undefined), onClose: vi.fn(), onEditRelayGroup: vi.fn() };
});

describe('万象分组连接', () => {
  it('shows six groups with independent preset models and saves separate keys and identities', async () => {
    render();
    for (const group of RELAYON_PROVIDER_GROUPS) expect(field(`${group.name} API Key`)).toBeDefined();
    expect(field('启用 image Image-2.5-Flare')).toBeDefined();
    expect(field('启用 video Image-2.5-Flare')).toBeUndefined();
    for (const id of ['image-2.6-01', 'Midjourney v6', 'Midjourney v6.1', 'Midjourney v7', 'Midjourney v8.1', 'Midjourney v8.2']) {
      expect(field(`启用 image ${id}`)).toBeDefined();
      expect(field(`启用 image ${id}`).props.checked).toBe(false);
      expect(field(`启用 video ${id}`)).toBeUndefined();
    }
    for (const id of ['minimax-h3', 'sd-2.0-c3', 'sd-2.5-c1']) {
      expect(field(`启用 video ${id}`)).toBeDefined();
      expect(field(`启用 image ${id}`)).toBeUndefined();
    }
    key('image', 'image-fixture'); toggle('image', 'Image-2.5-Flare');
    key('video', 'video-fixture'); toggle('video', 'sd-2.5-A');
    await save();
    const connections = vi.mocked(props.onSave).mock.calls[0][0];
    const image = Object.entries(connections).find(([, config]) => config.relayonGroup === 'image')!;
    const video = Object.entries(connections).find(([, config]) => config.relayonGroup === 'video')!;
    expect(image[0]).not.toBe(video[0]);
    expect(image[1].apiKey).toBe('image-fixture'); expect(video[1].apiKey).toBe('video-fixture');
    expect(image[1].selectedModels).toEqual([expect.objectContaining({ id: 'Image-2.5-Flare', provider: image[0] })]);
    expect(video[1].selectedModels).toEqual([expect.objectContaining({ id: 'sd-2.5-A', provider: video[0] })]);
  });

  it('assigns an old connection explicitly without changing its ID, key, selected model or custom protocol', async () => {
    const model = { id: 'Image-2.5-Flare', name: '我的模型', category: 'image' as const, provider: 'relayonapi',
      categoryManual: true, executionProfile: { preset: 'openai-image' as const } };
    props.providerConfigs = {
      relayonapi: { name: '旧连接', apiKey: 'legacy-fixture', selectedModels: [model] },
      'relayonapi-existing': { name: '已有图片连接', apiKey: 'other-fixture', catalogId: 'relayonapi', relayonGroup: 'image' },
    };
    render();
    (field('所属分组 relayonapi').props.onChange as (value: string) => void)('image'); render();
    expect(field('编辑模型参数 relayonapi').props.disabled).toBe(true);
    await save();
    const connections = vi.mocked(props.onSave).mock.calls[0][0];
    expect(connections.relayonapi).toEqual(expect.objectContaining({ name: '旧连接', apiKey: 'legacy-fixture', relayonGroup: 'image' }));
    expect(connections.relayonapi.selectedModels).toEqual([expect.objectContaining(model)]);
    expect(connections['relayonapi-existing']).toBeUndefined();
  });

  it('keeps a custom provider with a built-in-looking ID out of the grouped editor', () => {
    props.providerConfigs = { relayonapi: { name: '自定义', apiKey: 'fixture', catalogId: 'custom-openai' } };
    render();
    expect(elements(tree).filter((item) => item.type === 'section')).toHaveLength(6);
    expect(field('所属分组 relayonapi')).toBeUndefined();
  });

  it('only edits a saved group after all unsaved drafts are saved', () => {
    props.providerConfigs = { 'relayonapi-image': { name: '图片', apiKey: 'fixture', catalogId: 'relayonapi', relayonGroup: 'image' } };
    render();
    (field('编辑模型参数 relayonapi-image').props.onClick as () => void)();
    expect(props.onEditRelayGroup).toHaveBeenCalledWith('relayonapi-image');
    key('video', 'new-fixture');
    expect(field('编辑模型参数 relayonapi-image').props.disabled).toBe(true);
  });

  it('copies and removes only the requested saved group without reviving it on save', async () => {
    props.providerConfigs = {
      'relayonapi-image': { name: '图片', apiKey: 'image-fixture', catalogId: 'relayonapi', relayonGroup: 'image' },
      'relayonapi-video': { name: '视频', apiKey: 'video-fixture', catalogId: 'relayonapi', relayonGroup: 'video' },
    };
    props.onCopyConnection = vi.fn().mockResolvedValue(undefined);
    props.onRemoveConnection = vi.fn().mockResolvedValue(true);
    render();
    await (field('复制分组配置 image').props.onClick as () => Promise<void>)();
    expect(props.onCopyConnection).toHaveBeenCalledWith('relayonapi-image');
    (field('删除分组 image').props.onClick as () => void)(); render();
    await (field('确认删除 image').props.onClick as () => Promise<void>)(); render();
    expect(props.onRemoveConnection).toHaveBeenCalledWith('relayonapi-image');
    await save();
    const saved = vi.mocked(props.onSave).mock.calls[0][0];
    expect(saved['relayonapi-image']).toBeUndefined();
    expect(saved['relayonapi-video']).toBeUndefined();
  });

  it('keeps the saved catalog and selection if group refresh fails', async () => {
    props.providerConfigs = { 'relayonapi-image': { name: '图片', apiKey: 'fixture', catalogId: 'relayonapi', relayonGroup: 'image', selectedModels: [
      { id: 'Image-2.5-Flare', name: '图片', category: 'image', provider: 'relayonapi-image' },
    ] } };
    driver.catalog.mockRejectedValue(new Error('无法获取分组目录'));
    render();
    await (field('拉取模型 image').props.onClick as () => Promise<void>)(); render();
    expect(field('启用 image Image-2.5-Flare').props.checked).toBe(true);
    await save();
    expect(vi.mocked(props.onSave).mock.calls[0][0]['relayonapi-image']).toBeUndefined();
  });

  it('does not rewrite unchanged legacy connections, and changes only the key when it is edited', async () => {
    const old = { name: '原连接名称', apiKey: 'old-fixture', selectedModels: [{
      id: 'Image-2.5-Flare', name: '手工名称', category: 'image' as const, provider: 'relayonapi',
      executionProfile: { preset: 'openai-image' as const }, imageReferenceRequestMode: 'edits-multipart' as const,
    }], catalogModels: [{ id: 'older', name: '旧目录', category: 'text' as const, provider: 'relayonapi' }] };
    props.providerConfigs = { relayonapi: old };
    render(); await save();
    expect(vi.mocked(props.onSave).mock.calls[0][0]).toEqual({});
    key('旧连接（未指定分组）', 'new-fixture'); await save();
    expect(vi.mocked(props.onSave).mock.calls[1][0].relayonapi).toEqual({ ...old, apiKey: 'new-fixture' });
  });
});

/**
 * imageLosslessCompressionToolbar — 回归测试：image lossless compression toolbar。
 */
import type { ComponentProps, ReactElement } from 'react';
import type { ToolbarLayout } from '../../src/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({
  hooks: [] as unknown[],
  index: 0,
  projectId: 'original-project',
  layout: undefined as ToolbarLayout | undefined,
  compress: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const index = driver.index++;
    if (!(index in driver.hooks)) driver.hooks[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [driver.hooks[index], (value: T | ((previous: T) => T)) => {
      driver.hooks[index] = typeof value === 'function' ? (value as (previous: T) => T)(driver.hooks[index] as T) : value;
    }];
  },
  useRef: <T,>(initial: T) => {
    const index = driver.index++;
    if (!(index in driver.hooks)) driver.hooks[index] = { current: initial };
    return driver.hooks[index];
  },
  useMemo: <T,>(factory: () => T) => factory(),
  useCallback: <T,>(callback: T) => callback,
  useEffect: () => undefined,
}));
vi.mock('../../src/i18n', () => ({
  useT: () => (text: string, parameters?: Record<string, unknown>) => text.replace(/\{(\w+)\}/g,
    (placeholder, key: string) => String(parameters?.[key] ?? placeholder)),
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ showToast: driver.toast, userPresets: [], addNodeWithEdge: vi.fn() }),
    { getState: () => ({ currentProjectId: driver.projectId }) },
  ),
}));
vi.mock('../../src/services/imageLosslessCompression', () => ({ compressImageNode: driver.compress }));
vi.mock('../../src/services/generationService', () => ({ executeGeneration: vi.fn() }));
vi.mock('../../src/services/presetSequenceService', () => ({ requestPresetSequence: () => false }));
vi.mock('../../src/components/nodes/shared/toolbar/presetAction', () => ({
  resolvePresetAction: () => null, resolvePresetDef: () => null, createPresetNode: vi.fn(),
}));
vi.mock('../../src/services/plugins/pluginRuntime', () => ({ getAvailableNodePluginTools: () => [] }));
vi.mock('../../src/components/nodes/shared/toolbar/NodePluginToolbarButtons', () => ({
  useNodePluginToolbar: () => ({ renderButton: () => null, dialog: null }),
}));
vi.mock('../../src/components/nodes/shared/toolbar/ToolbarEditor', () => ({ default: () => null }));
vi.mock('../../src/components/nodes/shared/toolbar/ToolbarMoreMenu', () => ({ default: () => null }));
vi.mock('../../src/hooks/useToolbarEdit', async () => {
  const { getDefaultLayout, getButtonRegistry } = await import('../../src/components/nodes/shared/toolbar/toolbarRegistry');
  return {
    useToolbarEdit: () => {
      const layout = driver.layout ?? getDefaultLayout('ai-image');
      return { layout, registry: getButtonRegistry('ai-image'), isEditing: false, longPressHandlers: {},
        activeButtonKeys: new Set(layout.zones.flatMap((zone) => zone.buttonKeys)) };
    },
  };
});

import ImageNodeToolbar from '../../src/components/nodes/shared/image/ImageNodeToolbar';
import ToolbarZones from '../../src/components/nodes/shared/toolbar/ToolbarZones';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  if (element.type === ToolbarZones) {
    return [element, ...elements(ToolbarZones(element.props as unknown as ComponentProps<typeof ToolbarZones>))];
  }
  return [element, ...elements(element.props.children)];
}

function render() {
  driver.index = 0;
  const component = ImageNodeToolbar as unknown as { type: (props: { nodeId: string }) => unknown };
  return component.type({ nodeId: 'source-image' });
}

function compressionButton(tree = render()) {
  const button = elements(tree).find((element) => element.props['aria-label'] === '无损压缩');
  expect(button).toBeDefined();
  return button!;
}

function click(button: Element) {
  const event = { stopPropagation: vi.fn() };
  (button.props.onClick as (value: typeof event) => void)(event);
  expect(event.stopPropagation).toHaveBeenCalledOnce();
}

beforeEach(() => {
  driver.hooks = [];
  driver.index = 0;
  driver.projectId = 'original-project';
  driver.layout = undefined;
  driver.compress.mockReset();
  driver.toast.mockReset();
});

describe('image lossless compression toolbar', () => {
  it('calls the node service once, disables the busy button, and reports the saved copy', async () => {
    let complete!: (result: { status: 'compressed'; originalBytes: number; compressedBytes: number; nodeId: string }) => void;
    driver.compress.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const button = compressionButton();
    click(button);
    click(button);
    await vi.waitFor(() => expect(driver.compress).toHaveBeenCalledExactlyOnceWith('source-image'));
    const busy = compressionButton();
    expect(busy.props.disabled).toBe(true);
    expect(busy.props['aria-busy']).toBe(true);
    expect(busy.props['data-tooltip']).toBe('无损压缩中...');
    expect(elements(busy).find((element) => element.props.icon === 'mdi:loading')?.props.className).toBe('animate-spin');
    complete({ status: 'compressed', originalBytes: 1000, compressedBytes: 600, nodeId: 'compressed-copy' });
    await vi.waitFor(() => expect(driver.toast).toHaveBeenCalledExactlyOnceWith('已创建无损压缩副本，体积减少 40.0%'));
    expect(compressionButton().props.disabled).toBe(false);
  });

  it('reports that no extra node was created when compression has no benefit', async () => {
    driver.compress.mockResolvedValue({ status: 'unchanged', originalBytes: 1000, compressedBytes: 1000 });
    click(compressionButton());
    await vi.waitFor(() => expect(driver.toast).toHaveBeenCalledExactlyOnceWith('图片无需进一步无损压缩，未创建副本'));
    expect(compressionButton().props.disabled).toBe(false);
  });

  it('does not call the service when the project changes while its module is loading', async () => {
    click(compressionButton());
    driver.projectId = 'different-project';
    await vi.waitFor(() => expect(compressionButton().props.disabled).toBe(false));
    expect(driver.compress).not.toHaveBeenCalled();
    expect(driver.toast).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)('does not toast a late service %s after switching projects', async (outcome) => {
    let complete!: () => void;
    driver.compress.mockImplementation(() => new Promise((resolve, reject) => {
      complete = () => outcome === 'success'
        ? resolve({ status: 'compressed', originalBytes: 1000, compressedBytes: 600, nodeId: 'copy' })
        : reject(new Error('压缩副本保存失败，原图已保留'));
    }));
    click(compressionButton());
    await vi.waitFor(() => expect(driver.compress).toHaveBeenCalledExactlyOnceWith('source-image'));
    driver.projectId = 'different-project';
    complete();
    await vi.waitFor(() => expect(compressionButton().props.disabled).toBe(false));
    expect(driver.toast).not.toHaveBeenCalled();
  });

  it('shows the fixed service error and permits another attempt', async () => {
    driver.compress.mockRejectedValueOnce(new Error('压缩副本保存失败，原图已保留'))
      .mockResolvedValueOnce({ status: 'unchanged', originalBytes: 1000, compressedBytes: 1000 });
    click(compressionButton());
    await vi.waitFor(() => expect(driver.toast).toHaveBeenCalledWith('压缩副本保存失败，原图已保留', 'error'));
    expect(compressionButton().props.disabled).toBe(false);
    click(compressionButton());
    await vi.waitFor(() => expect(driver.compress).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(driver.toast).toHaveBeenCalledWith('图片无需进一步无损压缩，未创建副本'));
  });

  it('uses a short fallback for a non-Error failure', async () => {
    driver.compress.mockRejectedValue('untrusted failure details');
    click(compressionButton());
    await vi.waitFor(() => expect(driver.toast).toHaveBeenCalledExactlyOnceWith('图片无损压缩失败', 'error'));
  });

  it('silently finishes an expired operation', async () => {
    const error = new Error('stale operation');
    error.name = 'AbortError';
    driver.compress.mockRejectedValue(error);
    click(compressionButton());
    await vi.waitFor(() => expect(driver.compress).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(compressionButton().props.disabled).toBe(false));
    expect(driver.toast).not.toHaveBeenCalled();
  });

  it('reuses the same action inside More without changing a saved custom layout', async () => {
    driver.layout = { version: 8, zones: [{ id: 'custom', name: '自定义', buttonKeys: ['copyFile', 'more'] }] };
    driver.compress.mockResolvedValue({ status: 'unchanged', originalBytes: 1000, compressedBytes: 1000 });
    const tree = render();
    expect(elements(tree).find((element) => element.props['aria-label'] === '无损压缩')).toBeUndefined();
    const more = elements(tree).find((element) => typeof element.props.renderItem === 'function');
    expect(more).toBeDefined();
    expect((more!.props.items as Array<{ key: string }>).map((item) => item.key)).toContain('losslessCompress');
    const hidden = (more!.props.renderItem as (key: string) => unknown)('losslessCompress');
    click(compressionButton(hidden));
    await vi.waitFor(() => expect(driver.compress).toHaveBeenCalledExactlyOnceWith('source-image'));
    await vi.waitFor(() => expect(driver.toast).toHaveBeenCalledOnce());
    expect(driver.layout.zones[0].buttonKeys).toEqual(['copyFile', 'more']);
  });
});

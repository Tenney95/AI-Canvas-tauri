import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import type { AvailableNodePluginTool } from '../../src/types/plugin';

const hooks = vi.hoisted(() => ({
  index: 0, values: [] as unknown[], effects: [] as Array<() => void | (() => void)>,
}));
const mocks = vi.hoisted(() => ({
  getState: vi.fn(), open: vi.fn(), unavailable: vi.fn(), frame: vi.fn(), toast: vi.fn(),
  dispose: vi.fn(), close: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useMemo: <T,>(factory: () => T) => factory(),
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  useRef: <T,>(value: T) => {
    const index = hooks.index++;
    hooks.values[index] ??= { current: value };
    return hooks.values[index];
  },
  useState: <T,>(initial: T | (() => T)) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.values[index], (value: T) => { hooks.values[index] = value; }];
  },
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mocks.getState()), { getState: mocks.getState }),
}));
vi.mock('../../src/services/plugins/pluginRuntime', () => ({ executeNodePluginTool: vi.fn() }));
vi.mock('../../src/services/plugins/pluginUiWindowService', () => ({
  openPluginUiWindow: mocks.open, pluginUiWindowUnavailableReason: mocks.unavailable,
}));
vi.mock('../../src/services/plugins/pluginUiSessionService', () => ({ createPluginUiFrameSession: mocks.frame }));
vi.mock('../../src/services/plugins/pluginModelCatalog', () => ({
  buildPluginModelCatalog: () => [], collectDeclaredModelCategories: () => [],
}));

import NodePluginToolDialog from '../../src/components/nodes/shared/toolbar/NodePluginToolDialog';
import ModalOverlay from '../../src/components/shared/ModalOverlay';
import PopupCloseButton from '../../src/components/shared/PopupCloseButton';

const fixture: AvailableNodePluginTool = {
  pluginId: 'com.example.review', pluginName: '逐帧拉片', runtime: 'javascript', source: '', permissions: ['ui.custom'],
  tool: {
    id: 'review', title: '逐帧拉片', placements: ['node-toolbar'], nodeTypes: ['ai-video'], inputFields: ['label'],
    output: { mode: 'update-current', fields: [] },
    dialog: { ui: 'review', presentation: 'window', fields: [{ id: 'prompt', label: '要求', type: 'textarea', defaultValue: '分析镜头' }] },
  },
};
let pluginTool: AvailableNodePluginTool;
let cleanup: Array<() => void>;

function render() {
  hooks.index = 0;
  hooks.effects = [];
  return NodePluginToolDialog({ pluginTool, nodeId: 'video-1', onClose: mocks.close });
}
function elements(root: unknown): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(root)) return root.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(root)) return [];
  return [root, ...elements(root.props.children)];
}
function windowButton() {
  return elements(render()).find((item) => item.type === 'button' && item.props['aria-label'] === '在独立窗口打开');
}
function clickWindowButton() {
  (windowButton()!.props.onClick as () => void)();
}
async function mount() {
  render();
  cleanup = hooks.effects.map((effect) => effect()).filter((value): value is () => void => typeof value === 'function');
  await vi.waitFor(() => expect(elements(render()).some((item) => item.type === 'iframe')).toBe(true));
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.values = [];
  cleanup = [];
  pluginTool = structuredClone(fixture);
  mocks.unavailable.mockReturnValue(null);
  mocks.open.mockResolvedValue({});
  mocks.getState.mockReturnValue({ config: { theme: 'dark' }, showToast: mocks.toast, installedPlugins: [{ id: fixture.pluginId, enabled: true }] });
  mocks.frame.mockResolvedValue({
    sessionId: 'frame-session', src: '/plugin-ui-host.html?session=frame-session&export=review',
    attach: vi.fn(), updateTheme: vi.fn(), dispose: mocks.dispose,
  });
  vi.stubGlobal('window', { location: { href: 'http://localhost/' } });
});
afterEach(() => {
  cleanup.forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

describe('plugin dialog window button', () => {
  it('opens a modal and sandboxed frame by default, with the window button beside close', async () => {
    expect(render()?.type).toBe(ModalOverlay);
    await mount();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.frame).toHaveBeenCalledOnce();
    const tree = elements(render());
    const frame = tree.find((item) => item.type === 'iframe')!;
    expect(frame.props.sandbox).toBe('allow-scripts');
    const actions = tree.find((item) => Array.isArray(item.props.children)
      && item.props.children.some((child) => isValidElement(child) && child.type === PopupCloseButton))!;
    const children = actions.props.children as ReactElement[];
    expect(children[0].props).toMatchObject({ 'aria-label': '在独立窗口打开', disabled: false });
    expect(children[1].type).toBe(PopupCloseButton);
    expect(tree.some((item) => item.props.role === 'status')).toBe(false);
  });

  it('opens only on click, deduplicates pending clicks and closes the modal only after success', async () => {
    await mount();
    let complete!: () => void;
    mocks.open.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const frameSrc = elements(render()).find((item) => item.type === 'iframe')!.props.src;
    clickWindowButton();
    clickWindowButton();
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'video-1', exportName: 'review', parameters: { prompt: '分析镜头' } }));
    expect(windowButton()!.props.disabled).toBe(true);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(elements(render()).find((item) => item.type === 'iframe')!.props.src).toBe(frameSrc);
    complete();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.dispose.mock.invocationCallOrder[0]).toBeLessThan(mocks.close.mock.invocationCallOrder[0]);
    expect(mocks.frame).toHaveBeenCalledOnce();
  });

  it('keeps the editor after open failure and allows another attempt', async () => {
    await mount();
    mocks.open.mockRejectedValueOnce(new Error('原生创建失败'));
    clickWindowButton();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('原生创建失败', 'error'));
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(elements(render()).some((item) => item.type === 'iframe')).toBe(true);
    clickWindowButton();
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
  });

  it('disables unsupported desktop presentation and does not call native code', async () => {
    mocks.unavailable.mockReturnValue('当前不是 Tauri 桌面环境');
    await mount();
    expect(windowButton()!.props).toMatchObject({ disabled: true, title: '当前不是 Tauri 桌面环境' });
    clickWindowButton();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('does not add a native action to modal-only tools', () => {
    pluginTool.tool.dialog!.presentation = 'modal';
    expect(render()?.type).toBe(ModalOverlay);
    expect(windowButton()).toBeUndefined();
  });
});

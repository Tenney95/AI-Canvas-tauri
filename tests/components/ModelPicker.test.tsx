import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelMenuProps, ModelPickerGroup, ModelPickerProps } from '../../src/components/shared/ModelPicker';

const hooks = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>, refCursor: 0,
  states: [] as unknown[], stateCursor: 0,
  layouts: [] as Array<() => void | (() => void)>,
}));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useId: () => 'model-menu',
  useCallback: <T,>(fn: T) => fn,
  useRef: <T,>(initial: T) => {
    const index = hooks.refCursor++;
    return hooks.refs[index] ?? (hooks.refs[index] = { current: initial });
  },
  useState: <T,>(initial: T | (() => T)) => {
    const index = hooks.stateCursor++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.states[index] as T, (next: T | ((current: T) => T)) => {
      hooks.states[index] = typeof next === 'function' ? (next as (current: T) => T)(hooks.states[index] as T) : next;
    }] as const;
  },
  useEffect: () => {},
  useLayoutEffect: (fn: () => void | (() => void)) => { hooks.layouts.push(fn); },
}));
vi.mock('react-dom', () => ({ createPortal: (child: unknown) => child }));

import ModelPicker, { ModelMenu } from '../../src/components/shared/ModelPicker';

interface ElementLike { type: unknown; props: Record<string, unknown> & { children?: unknown } }
function elements(node: unknown): ElementLike[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ElementLike;
  return [element, ...elements(element.props.children)];
}
function invoke(node: ElementLike, handler: string, event: unknown) {
  (node.props[handler] as (event: unknown) => void)(event);
}
function renderMenu(options: ModelMenuProps) {
  hooks.refCursor = 0; hooks.stateCursor = 0; hooks.layouts = [];
  return elements(ModelMenu(options));
}
function renderPicker(options: ModelPickerProps) {
  hooks.refCursor = 0; hooks.stateCursor = 0; hooks.layouts = [];
  return elements(ModelPicker(options));
}
function byGroup(nodes: ElementLike[], id: string) {
  return nodes.find((node) => node.props['data-model-menu-group'] === id)!;
}
function byOwner(nodes: ElementLike[], id: string) {
  return nodes.find((node) => node.props['data-model-menu-owner'] === id)!;
}
function event(key = '', target: unknown = {}) {
  return { key, target, nativeEvent: { isComposing: false, keyCode: 0 }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}
function fakeControl(group?: string, owner?: string, checked = false) {
  const control = {
    dataset: { modelMenuGroup: group, modelMenuOwner: owner },
    focus: vi.fn(), getAttribute: (name: string) => name === 'aria-checked' && checked ? 'true' : null,
    closest: (): unknown => control,
  };
  return control;
}
function fakeMenu(controls: ReturnType<typeof fakeControl>[], clearScope = false) {
  const scope = { querySelectorAll: vi.fn(() => controls) };
  return {
    querySelectorAll: vi.fn(() => controls), contains: () => true, focus: vi.fn(),
    closest: (selector: string) => clearScope && selector === '.ui-model-menu__surface' ? scope : null,
  };
}
const groups: ModelPickerGroup[] = [
  { id: 'volcengine', label: '火山引擎', items: [{ value: 'volcengine/video', label: '视频模型' }] },
  { id: 'cccapi', label: 'CCC API', items: [{ value: 'general/ccc', label: '图像模型 · 标准分组' }] },
  { id: 'locked', label: '未配置厂商', disabled: true, disabledReason: '请先配置厂商', items: [{ value: 'locked/model', label: '不可调用模型' }] },
];
function props(extra: Partial<ModelMenuProps> = {}): ModelMenuProps {
  return { groups, onChange: vi.fn(), expandedGroupIds: [], onGroupToggle: vi.fn(), ...extra };
}
beforeEach(() => {
  hooks.refs = []; hooks.states = []; hooks.refCursor = 0; hooks.stateCursor = 0; hooks.layouts = [];
  vi.stubGlobal('document', { body: {} });
});

describe('公共 ModelMenu', () => {
  it('折叠内容不进入焦点树，禁用厂商不会展开或选中', () => {
    const options = props({ expandedGroupIds: ['locked'] });
    const nodes = renderMenu(options);
    expect(nodes.filter((node) => node.props.role === 'menuitemradio')).toHaveLength(0);
    expect(byGroup(nodes, 'locked').props.disabled).toBe(true);
    expect(byGroup(nodes, 'locked').props.title).toBe('请先配置厂商');
    invoke(byGroup(nodes, 'locked'), 'onClick', event());
    expect(options.onGroupToggle).not.toHaveBeenCalled();
    expect(options.onChange).not.toHaveBeenCalled();
  });

  it('首次挂载聚焦当前模型厂商，右键展开并进入模型，左键返回标题', () => {
    const options = props({ value: 'general/ccc' });
    let nodes = renderMenu(options);
    const first = fakeControl('volcengine'); const selected = fakeControl('cccapi');
    hooks.refs[0].current = fakeMenu([first, selected]);
    hooks.layouts.splice(0).forEach((fn) => fn());
    expect(selected.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    invoke(nodes[0], 'onKeyDown', event('ArrowRight', selected));
    expect(options.onGroupToggle).toHaveBeenCalledExactlyOnceWith('cccapi');

    nodes = renderMenu({ ...options, expandedGroupIds: ['cccapi'] });
    const model = fakeControl(undefined, 'cccapi', true);
    hooks.refs[0].current = fakeMenu([first, selected, model]);
    hooks.layouts.splice(0).forEach((fn) => fn());
    expect(model.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    invoke(nodes[0], 'onKeyDown', event('ArrowLeft', model));
    expect(selected.focus).toHaveBeenCalledTimes(2);
    expect(options.onGroupToggle).toHaveBeenCalledTimes(2);
  });

  it('Home、End 和方向键包含单独清空行，保持禁用项不进入导航', () => {
    const nodes = renderMenu(props({ expandedGroupIds: ['cccapi'] }));
    const clear = fakeControl(); const header = fakeControl('cccapi'); const item = fakeControl(undefined, 'cccapi');
    hooks.refs[0].current = fakeMenu([clear, header, item], true);
    invoke(nodes[0], 'onKeyDown', event('ArrowUp', header));
    expect(clear.focus).toHaveBeenCalledOnce();
    invoke(nodes[0], 'onKeyDown', event('End', clear));
    expect(item.focus).toHaveBeenCalledOnce();
    invoke(nodes[0], 'onKeyDown', event('Home', item));
    expect(clear.focus).toHaveBeenCalledTimes(2);
  });

  it('Esc 交给菜单关闭，IME 不触发选择或阻止原生候选操作', () => {
    const options = props({ onClose: vi.fn() });
    const nodes = renderMenu(options);
    const composing = { ...event('Enter'), nativeEvent: { isComposing: true, keyCode: 229 } };
    invoke(nodes[0], 'onKeyDown', composing);
    expect(composing.stopPropagation).toHaveBeenCalledOnce();
    expect(composing.preventDefault).not.toHaveBeenCalled();
    expect(options.onChange).not.toHaveBeenCalled();
    const escape = event('Escape'); invoke(nodes[0], 'onKeyDown', escape);
    expect(options.onClose).toHaveBeenCalledOnce();
    expect(escape.preventDefault).toHaveBeenCalledOnce();
  });

  it('展开的大模型清单不截断，并保留原始模型身份', () => {
    const largeGroup = { id: 'many', label: '完整目录', items: Array.from({ length: 700 }, (_, index) => ({ value: `model/${index}`, label: `模型 ${index}` })) };
    const options = props({ groups: [largeGroup], expandedGroupIds: ['many'] });
    const nodes = renderMenu(options);
    const items = nodes.filter((node) => node.props.role === 'menuitemradio');
    expect(items).toHaveLength(700);
    invoke(items[699], 'onClick', event());
    expect(options.onChange).toHaveBeenCalledExactlyOnceWith('model/699');
  });

  it('禁用模型即使直接调用点击处理也不能触发选择', () => {
    const options = props({ groups: [{ id: 'offline', label: '工作流', items: [{ value: 'comfyui/offline', label: '离线工作流', disabled: true }] }], expandedGroupIds: ['offline'] });
    const nodes = renderMenu(options);
    expect(byOwner(nodes, 'offline').props.disabled).toBe(true);
    invoke(byOwner(nodes, 'offline'), 'onClick', event());
    expect(options.onChange).not.toHaveBeenCalled();
  });
});

describe('ModelPicker 表单入口', () => {
  it('禁用时卸载 Portal，重新启用不会恢复旧的展开状态', () => {
    hooks.states[0] = true;
    let nodes = renderPicker({ groups, onChange: vi.fn(), disabled: true });
    expect(nodes.some((node) => node.props['data-ui-select-portal'] === '')).toBe(false);
    expect(hooks.states[0]).toBe(false);
    nodes = renderPicker({ groups, onChange: vi.fn(), disabled: false });
    expect(nodes.some((node) => node.props['data-ui-select-portal'] === '')).toBe(false);
  });

  it('空值行单独清空，关闭并恢复焦点先于宿主可能卸载界面的回调', () => {
    hooks.states[0] = true;
    const order: string[] = [];
    const onChange = vi.fn(() => { order.push('change'); });
    const nodes = renderPicker({ groups, value: 'general/ccc', onChange, clearLabel: '不选择模型', name: 'analysisModel' });
    hooks.refs[1].current = { focus: () => { order.push('focus'); } };
    const clear = nodes.find((node) => String(node.props.className).includes('ui-model-picker__clear'))!;
    invoke(clear, 'onClick', event());
    expect(onChange).toHaveBeenCalledExactlyOnceWith('');
    expect(order).toEqual(['focus', 'change']);
    expect(hooks.states[0]).toBe(false);
    const formInput = nodes.find((node) => node.type === 'input' && node.props.name === 'analysisModel')!;
    expect(formInput.props.value).toBe('general/ccc');
  });
});

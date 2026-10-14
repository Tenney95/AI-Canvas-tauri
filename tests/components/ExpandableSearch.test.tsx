import type { EffectCallback, KeyboardEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpandableSearchProps } from '../../src/components/shared/ExpandableSearch';

const hooks = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>,
  cursor: 0,
  layoutCursor: 0,
  layoutDeps: [] as Array<readonly unknown[] | undefined>,
  layoutEffects: [] as EffectCallback[],
}));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useId: () => 'expandable-search-input',
  useRef: <T,>(value: T) => {
    const index = hooks.cursor++;
    return hooks.refs[index] ?? (hooks.refs[index] = { current: value });
  },
  useLayoutEffect: (effect: EffectCallback, deps: readonly unknown[]) => {
    const index = hooks.layoutCursor++;
    const previous = hooks.layoutDeps[index];
    if (!previous || deps.some((value, offset) => !Object.is(value, previous[offset]))) hooks.layoutEffects.push(effect);
    hooks.layoutDeps[index] = deps;
  },
  useEffect: () => {},
  useState: <T,>(initial: T) => [initial, vi.fn()] as const,
}));

import ExpandableSearch from '../../src/components/shared/ExpandableSearch';
import MentionPicker from '../../src/components/shared/MentionPicker';

interface ElementLike { type: unknown; props: Record<string, unknown> & { children?: unknown } }
function elements(node: unknown): ElementLike[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ElementLike;
  return [element, ...elements(element.props.children)];
}
function props(extra: Partial<ExpandableSearchProps> = {}): ExpandableSearchProps {
  return { expanded: false, value: '', onExpandedChange: vi.fn(), onChange: vi.fn(), ...extra };
}
function render(options: ExpandableSearchProps) {
  hooks.cursor = 0;
  hooks.layoutCursor = 0;
  hooks.layoutEffects = [];
  const nodes = elements(ExpandableSearch(options));
  return {
    input: nodes.find((node) => node.type === 'input')!,
    trigger: nodes.find((node) => node.type === 'button')!,
    field: nodes.find((node) => String(node.props.className).includes('ui-expandable-search__field'))!,
  };
}
function invoke(node: ElementLike, name: string, event: unknown = { detail: 0, stopPropagation: vi.fn() }) {
  (node.props[name] as (event: unknown) => void)(event);
}
function keyEvent(key: string, extra: Record<string, unknown> = {}) {
  return { key, nativeEvent: { isComposing: false, keyCode: 0 }, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
}

beforeEach(() => {
  hooks.refs = []; hooks.cursor = 0; hooks.layoutCursor = 0; hooks.layoutDeps = []; hooks.layoutEffects = [];
});

describe('ExpandableSearch 焦点与选择边界', () => {
  it('关闭时隐藏输入，按钮鼠标按下保留编辑器选区，点击只请求展开', () => {
    const options = props();
    const { input, trigger, field } = render(options);
    expect(input.props.disabled).toBe(true);
    expect(input.props.tabIndex).toBe(-1);
    expect(field.props.inert).toBe(true);
    expect(trigger.props['aria-expanded']).toBe(false);
    const pointer = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    invoke(trigger, 'onMouseDown', pointer);
    expect(pointer.preventDefault).toHaveBeenCalledOnce();
    invoke(trigger, 'onClick');
    expect(options.onExpandedChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(options.onChange).not.toHaveBeenCalled();
  });

  it('展开时仅聚焦搜索输入，保留当前列表与活动项的 ARIA 关联', () => {
    const { input, field } = render(props({ expanded: true, listId: 'reference-options', activeDescendant: 'node-39' }));
    const focus = vi.fn();
    hooks.refs[0].current = { focus };
    hooks.layoutEffects.forEach((effect) => effect());
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(field.props.inert).toBe(false);
    expect(input.props.disabled).toBe(false);
    expect(input.props.role).toBe('combobox');
    expect(input.props['aria-controls']).toBe('reference-options');
    expect(input.props['aria-activedescendant']).toBe('node-39');
  });

  it('Esc 清空并收起，将焦点恢复交给调用方，避免关闭宿主或提交生成', () => {
    const options = props({ expanded: true, value: '角色', onCollapse: vi.fn(), onKeyDown: vi.fn() });
    const { input } = render(options);
    const event = keyEvent('Escape');
    invoke(input, 'onKeyDown', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(options.onChange).toHaveBeenCalledExactlyOnceWith('');
    expect(options.onExpandedChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(options.onCollapse).toHaveBeenCalledOnce();
    expect(options.onKeyDown).not.toHaveBeenCalled();
  });

  it('关闭按钮默认恢复自身焦点，并清除隐藏的查询条件', () => {
    const options = props({ expanded: true, value: '#39' });
    const { trigger } = render(options);
    const focus = vi.fn();
    hooks.refs[1].current = { focus };
    invoke(trigger, 'onClick');
    expect(options.onChange).toHaveBeenCalledExactlyOnceWith('');
    expect(options.onExpandedChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it('指针按下即收起，弹窗移动后丢失 click 仍关闭，随后的 click 不重新打开', () => {
    const options = props({ expanded: true, value: '#39', onCollapse: vi.fn() });
    const { trigger } = render(options);
    const pointer = { button: 0, isPrimary: true, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    invoke(trigger, 'onPointerDown', pointer);
    expect(pointer.preventDefault).toHaveBeenCalledOnce();
    expect(pointer.stopPropagation).toHaveBeenCalledOnce();
    expect(options.onChange).toHaveBeenCalledExactlyOnceWith('');
    expect(options.onExpandedChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(options.onCollapse).toHaveBeenCalledOnce();

    const collapsed = render({ ...options, expanded: false, value: '' });
    invoke(collapsed.trigger, 'onClick', { detail: 1, stopPropagation: vi.fn() });
    expect(options.onExpandedChange).toHaveBeenCalledTimes(1);
    // 下一次指针操作可正常重新展开。
    invoke(collapsed.trigger, 'onPointerDown', pointer);
    invoke(collapsed.trigger, 'onClick', { detail: 1, stopPropagation: vi.fn() });
    expect(options.onExpandedChange).toHaveBeenLastCalledWith(true);
    expect(options.onExpandedChange).toHaveBeenCalledTimes(2);
  });

  it('指针关闭后没有收到 click，键盘仍能重新展开', () => {
    const options = props({ expanded: true, onCollapse: vi.fn() });
    const { trigger } = render(options);
    invoke(trigger, 'onPointerDown', { button: 0, isPrimary: true, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    const collapsed = render({ ...options, expanded: false });
    invoke(collapsed.trigger, 'onKeyDown', keyEvent('Enter'));
    invoke(collapsed.trigger, 'onClick');
    expect(options.onExpandedChange).toHaveBeenLastCalledWith(true);
    expect(options.onExpandedChange).toHaveBeenCalledTimes(2);
  });

  it('组合输入期间不交出 Enter 或 Esc，结束后由调用方处理列表键盘选择', () => {
    const onKeyDown = vi.fn<(event: KeyboardEvent<HTMLInputElement>) => void>();
    const options = props({ expanded: true, onKeyDown });
    const { input } = render(options);
    invoke(input, 'onCompositionStart');
    const escape = keyEvent('Escape');
    const enter = keyEvent('Enter');
    invoke(input, 'onKeyDown', escape);
    invoke(input, 'onKeyDown', enter);
    expect(escape.stopPropagation).toHaveBeenCalledOnce();
    expect(enter.stopPropagation).toHaveBeenCalledOnce();
    expect(escape.preventDefault).not.toHaveBeenCalled();
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(options.onExpandedChange).not.toHaveBeenCalled();
    invoke(input, 'onCompositionEnd');
    invoke(input, 'onKeyDown', keyEvent('Enter', { nativeEvent: { isComposing: true, keyCode: 0 } }));
    invoke(input, 'onKeyDown', keyEvent('Enter', { nativeEvent: { isComposing: false, keyCode: 229 } }));
    expect(onKeyDown).not.toHaveBeenCalled();
    const arrow = keyEvent('ArrowDown');
    invoke(input, 'onKeyDown', arrow);
    expect(arrow.stopPropagation).toHaveBeenCalledOnce();
    expect(onKeyDown).toHaveBeenCalledExactlyOnceWith(arrow);
  });

  it('禁用时既不聚焦也不打开搜索', () => {
    const options = props({ expanded: true, disabled: true });
    const { input, trigger } = render(options);
    const focus = vi.fn();
    hooks.refs[0].current = { focus };
    hooks.layoutEffects.forEach((effect) => effect());
    invoke(trigger, 'onClick');
    expect(input.props.disabled).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    expect(options.onExpandedChange).not.toHaveBeenCalled();
  });
});

function renderPicker(keys: string[], activeKey?: string, query = '', activeTab = 'nodes') {
  hooks.cursor = 0;
  hooks.layoutCursor = 0;
  hooks.layoutEffects = [];
  return MentionPicker({
    tabs: [], activeTab, activeKey, onTabChange: () => {},
    search: props({ expanded: true, value: query }),
    items: keys.map((key) => ({ key, label: key, onSelect: () => {} })),
  });
}
function flushLayout() {
  return hooks.layoutEffects.splice(0).map((effect) => effect());
}

describe('引用资源弹窗尺寸过渡', () => {
  it('首次定位不动画，内容增高只通知一次，根高度过渡结束和卸载正确收尾', () => {
    let notifyResize = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    class FakeResizeObserver {
      constructor(callback: () => void) { notifyResize = callback; }
      observe = observe;
      disconnect = disconnect;
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    try {
      const onHeightChange = vi.fn();
      const tree = MentionPicker({
        tabs: [], activeTab: 'nodes', onTabChange: () => {}, items: [], onHeightChange,
      });
      const picker = { offsetHeight: 286, clientHeight: 284 };
      const content = { offsetHeight: 284 };
      const inner = elements(tree).find((node) => node.props.className === 'mention-picker-content')!;
      (tree.props.ref as { current: unknown }).current = picker;
      (inner.props.ref as { current: unknown }).current = content;
      const cleanups = flushLayout();
      expect(observe).toHaveBeenCalledExactlyOnceWith(content);
      expect(onHeightChange).toHaveBeenCalledExactlyOnceWith(286, false);

      content.offsetHeight = 500;
      notifyResize();
      expect(onHeightChange).toHaveBeenLastCalledWith(502, true);
      expect(onHeightChange).toHaveBeenCalledTimes(2);
      notifyResize();
      expect(onHeightChange).toHaveBeenCalledTimes(2);

      invoke(tree, 'onTransitionEnd', { target: content, currentTarget: picker, propertyName: 'height' });
      invoke(tree, 'onTransitionEnd', { target: picker, currentTarget: picker, propertyName: 'opacity' });
      expect(onHeightChange).toHaveBeenCalledTimes(2);
      invoke(tree, 'onTransitionEnd', { target: picker, currentTarget: picker, propertyName: 'height' });
      expect(onHeightChange).toHaveBeenLastCalledWith(502, false);
      expect(onHeightChange).toHaveBeenCalledTimes(3);

      cleanups.forEach((cleanup) => { if (typeof cleanup === 'function') cleanup(); });
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('引用资源列表分页滚动', () => {
  it('追加结果保留位置，即使旧高亮项已在视区外；切换高亮仍正常滚动', () => {
    const tree = renderPicker(['first', 'second'], 'first');
    expect(tree.props['data-reference-preview-open']).toBe('');
    const grid = { scrollTop: 0, offsetHeight: 100, getBoundingClientRect: () => ({ top: 100, bottom: 200, height: 100 }) };
    hooks.refs[0].current = grid;
    flushLayout();
    grid.scrollTop = 200;
    hooks.refs[1].current = { getBoundingClientRect: () => ({ top: 80, bottom: 120 }) };
    renderPicker(['first', 'second', 'third'], 'first');
    flushLayout();
    expect(grid.scrollTop).toBe(200);

    hooks.refs[1].current = { getBoundingClientRect: () => ({ top: 220, bottom: 260 }) };
    renderPicker(['first', 'second', 'third'], 'third');
    flushLayout();
    expect(grid.scrollTop).toBe(260);
  });

  it('更换关键词、分类或替换结果仍从顶部显示', () => {
    renderPicker(['first', 'second']);
    const grid = { scrollTop: 200 };
    hooks.refs[0].current = grid;
    flushLayout();
    grid.scrollTop = 200;
    renderPicker(['first', 'second', 'third'], undefined, '角色');
    flushLayout();
    expect(grid.scrollTop).toBe(0);

    grid.scrollTop = 200;
    renderPicker(['first', 'second', 'third'], undefined, '角色', 'assets');
    flushLayout();
    expect(grid.scrollTop).toBe(0);

    grid.scrollTop = 200;
    renderPicker(['replacement'], undefined, '角色', 'assets');
    flushLayout();
    expect(grid.scrollTop).toBe(0);
  });
});

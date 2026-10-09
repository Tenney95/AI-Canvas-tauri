import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindDialogFocus } from '../../src/hooks/useDialogFocus';

class FocusElement {
  ownerDocument: FocusDocument;
  isConnected = true;
  tabIndex = 0;
  disabled = false;
  inert = false;
  visible = true;
  children: FocusElement[] = [];
  constructor(doc: FocusDocument) { this.ownerDocument = doc; }
  focus = vi.fn(() => { this.ownerDocument.activeElement = this; });
  contains(element: unknown): boolean { return element === this || this.children.some((child) => child.contains(element)); }
  querySelectorAll() { return this.children; }
  matches() { return this.disabled; }
  closest() { return this.inert ? this : null; }
  getClientRects() { return this.visible ? [{}] : []; }
}

class FocusDocument extends EventTarget {
  activeElement: FocusElement | null = null;
}

let doc: FocusDocument;
let frames: Map<number, FrameRequestCallback>;
let cleanups: Array<() => void>;
let nextFrame: number;

function mount(zIndex = 250, escapeOnKeyUp = false, onClose = vi.fn()) {
  const panel = new FocusElement(doc);
  panel.tabIndex = -1;
  panel.children = [new FocusElement(doc), new FocusElement(doc)];
  const dispose = bindDialogFocus(panel as unknown as HTMLElement, onClose, { zIndex, escapeOnKeyUp });
  cleanups.push(dispose);
  return { panel, first: panel.children[0], last: panel.children[1], dispose, onClose };
}

function key(type: 'keydown' | 'keyup', value: string, extras = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), { key: value, shiftKey: false, repeat: false, isComposing: false, ...extras });
  doc.dispatchEvent(event);
  return event;
}

function paint() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(0));
}

beforeEach(() => {
  doc = new FocusDocument(); frames = new Map(); cleanups = []; nextFrame = 0;
  vi.stubGlobal('HTMLElement', FocusElement);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});

afterEach(() => { cleanups.reverse().forEach((dispose) => dispose()); });

describe('弹窗焦点与键盘层级', () => {
  it('嵌套弹窗挂载时，父层的延迟聚焦不能抢走子层焦点', () => {
    const parent = mount();
    const child = mount();
    paint();
    expect(doc.activeElement).toBe(child.first);
    expect(parent.first.focus).not.toHaveBeenCalled();
  });

  it('Tab 在子层中间不受父层干扰，首尾与反向导航只在子层循环', () => {
    mount();
    const child = mount();
    paint();
    expect(key('keydown', 'Tab').defaultPrevented).toBe(false);
    doc.activeElement = child.last;
    expect(key('keydown', 'Tab').defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(child.first);
    expect(key('keydown', 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(child.last);
  });

  it('Escape 只关闭最上层，重复按键和同一次释放不能关闭刚露出的父层', () => {
    const parent = mount(250, true);
    const child = mount(275, false, vi.fn(() => child.dispose()));
    key('keydown', 'Escape');
    expect(child.onClose).toHaveBeenCalledOnce();
    key('keydown', 'Escape', { repeat: true });
    key('keyup', 'Escape');
    expect(parent.onClose).not.toHaveBeenCalled();
    key('keydown', 'Escape');
    key('keyup', 'Escape');
    expect(parent.onClose).toHaveBeenCalledOnce();
  });

  it('按视觉 zIndex 选顶层，而不是仅按 effect 注册顺序', () => {
    const child = mount(275);
    const parent = mount(250);
    paint();
    expect(doc.activeElement).toBe(child.first);
    key('keydown', 'Escape');
    expect(child.onClose).toHaveBeenCalledOnce();
    expect(parent.onClose).not.toHaveBeenCalled();
  });

  it('关闭子层恢复父层触发按钮，关闭父层恢复外部触发按钮', () => {
    const trigger = new FocusElement(doc);
    doc.activeElement = trigger;
    const parent = mount(); paint();
    doc.activeElement = parent.last;
    const child = mount(); paint();
    child.dispose();
    expect(doc.activeElement).toBe(parent.last);
    parent.dispose();
    expect(doc.activeElement).toBe(trigger);
  });

  it('父层先卸载时不抢焦点，子层关闭后跳过已关闭的父层', () => {
    const trigger = new FocusElement(doc);
    doc.activeElement = trigger;
    const parent = mount(); paint();
    const child = mount(); paint();
    parent.dispose();
    expect(doc.activeElement).toBe(child.first);
    child.dispose();
    expect(doc.activeElement).toBe(trigger);
  });

  it('跳过隐藏、禁用、inert 和负 tabIndex 控件，空面板仍可圈定焦点', () => {
    const dialog = mount();
    dialog.first.disabled = true;
    dialog.last.inert = true;
    const hidden = new FocusElement(doc); hidden.visible = false;
    const negative = new FocusElement(doc); negative.tabIndex = -2;
    dialog.panel.children.push(hidden, negative);
    paint();
    expect(doc.activeElement).toBe(dialog.panel);
    expect(key('keydown', 'Tab').defaultPrevented).toBe(true);
  });

  it('保留已聚焦的子控件；不消费 IME 或已经由下拉处理的 Escape', () => {
    const dialog = mount();
    doc.activeElement = dialog.last;
    paint();
    expect(doc.activeElement).toBe(dialog.last);
    key('keydown', 'Escape', { isComposing: true });
    const prevented = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    prevented.preventDefault();
    doc.dispatchEvent(prevented);
    expect(dialog.onClose).not.toHaveBeenCalled();
  });

  it('注销后取消排队聚焦并移除键盘监听', () => {
    const dialog = mount();
    dialog.dispose();
    paint();
    key('keydown', 'Escape');
    expect(dialog.onClose).not.toHaveBeenCalled();
    expect(dialog.first.focus).not.toHaveBeenCalled();
  });
});

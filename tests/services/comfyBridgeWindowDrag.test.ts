import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../src-tauri/src/media/comfyui/bridge.js', import.meta.url), 'utf8');
const install = source.match(/const installWindowControls = \(\) => \{[\s\S]*?\r?\n {2}\};/);
if (!install) throw new Error('找不到 ComfyUI 窗口控件安装入口');

class TestElement {
  constructor(readonly selectors: string[] = [], readonly parent: TestElement | null = null) {}
  closest(selector: string): TestElement | null {
    if (selector.split(',').some((part) => this.selectors.includes(part.trim()))) return this;
    return this.parent?.closest(selector) ?? null;
  }
}

interface DragEvent {
  target: TestElement;
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
  pointerId: number;
  isPrimary: boolean;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
}

function harness() {
  let height = 52;
  class TestHTMLElement extends TestElement {
    dataset = {};
    setAttribute = vi.fn();
    appendChild = vi.fn();
    querySelectorAll = () => [];
    getBoundingClientRect = () => ({ top: 0, bottom: height });
  }
  const listeners = new Map<string, (event: DragEvent) => void>();
  const requestHostAction = vi.fn();
  runInNewContext(`${install![0]}\ninstallWindowControls();`, {
    Element: TestElement,
    HTMLElement: TestHTMLElement,
    isMacOS: false,
    aiCanvasComfyStyles: '',
    aiCanvasComfyIcon: '',
    requestHostAction,
    document: {
      body: { appendChild: vi.fn() }, head: { appendChild: vi.fn() },
      getElementById: () => null,
      createElement: () => new TestHTMLElement(),
      documentElement: { classList: { toggle: vi.fn() } },
    },
    window: { addEventListener: (type: string, listener: (event: DragEvent) => void) => listeners.set(type, listener) },
  });
  const fire = (type: string, overrides: Partial<DragEvent> = {}) => {
    const event: DragEvent = {
      target: new TestHTMLElement(['.actionbar-container']), clientX: 150, clientY: 44,
      button: 0, buttons: 1, pointerId: 1, isPrimary: true,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides,
    };
    listeners.get(type)!(event);
    return event;
  };
  return { fire, requestHostAction, resize: (value: number) => { height = value; } };
}

describe('ComfyUI 窗口顶部拖拽', () => {
  it('工具栏空白超过 32px 仍能拖动，只启动一次原生拖拽', () => {
    const h = harness();
    const down = h.fire('pointerdown');
    h.fire('pointermove', { clientX: 152 });
    expect(h.requestHostAction).not.toHaveBeenCalled();
    h.fire('pointermove', { clientX: 156 });
    h.fire('pointermove', { clientX: 180, clientY: 100 });
    expect(h.requestHostAction).toHaveBeenCalledExactlyOnceWith('start-dragging');
    expect(down.preventDefault).toHaveBeenCalled();
    expect(down.stopPropagation).toHaveBeenCalled();
  });

  it('菜单换行后按新高度拖拽，下面的画布不触发拖窗', () => {
    const h = harness();
    h.resize(80);
    h.fire('pointerdown', { clientY: 81 });
    h.fire('pointermove', { clientX: 160 });
    expect(h.requestHostAction).not.toHaveBeenCalled();
    h.fire('pointerdown', { clientY: 72 });
    h.fire('pointermove', { clientX: 160, clientY: 72 });
    expect(h.requestHostAction).toHaveBeenCalledExactlyOnceWith('start-dragging');
  });

  it.each(['button', '[role="tab"]', '[role="slider"]', '.p-dialog-mask', '.p-menu'])('点中 %s 内的 SVG 不触发拖窗', (selector) => {
    const h = harness();
    const target = new TestElement(['svg'], new TestElement([selector]));
    const down = h.fire('pointerdown', { target, clientY: 20 });
    h.fire('pointermove', { clientX: 160 });
    expect(h.requestHostAction).not.toHaveBeenCalled();
    expect(down.preventDefault).not.toHaveBeenCalled();
  });

  it.each(['pointerup', 'pointercancel', 'blur'])('%s 后不会留下拖拽状态', (event) => {
    const h = harness();
    h.fire('pointerdown');
    h.fire(event);
    h.fire('pointermove', { clientX: 160 });
    expect(h.requestHostAction).not.toHaveBeenCalled();
  });

  it('右键、次指针和松开左键后的移动不触发拖窗', () => {
    const h = harness();
    h.fire('pointerdown', { button: 2 });
    h.fire('pointermove', { clientX: 160 });
    h.fire('pointerdown', { isPrimary: false });
    h.fire('pointermove', { clientX: 160 });
    h.fire('pointerdown');
    h.fire('pointermove', { clientX: 160, buttons: 0 });
    h.fire('pointermove', { clientX: 170 });
    expect(h.requestHostAction).not.toHaveBeenCalled();
  });
});

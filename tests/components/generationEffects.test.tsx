/**
 * generationEffects — 回归测试：内置生成特效。
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODE_FRAMES, resolvePreset, type OrbState } from '../../src/vendor/generation-effects/thinking-orbs/src/engine';
import { BorderBeam } from '../../src/vendor/generation-effects/border-beam/src';
import { FRAG_SHADER_SRC, VERT_SHADER_SRC } from '../../src/vendor/generation-effects/metal-fx/src/engine/shaders';
import { ensureSharedRenderer, teardownSharedRenderer } from '../../src/vendor/generation-effects/metal-fx/src/engine/renderer/core';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
  teardownSharedRenderer();
  vi.restoreAllMocks();
  vi.doUnmock('react');
  vi.doUnmock('framer-motion');
  vi.doUnmock('../../src/vendor/generation-effects/metal-fx/src/engine/glow/glow');
  vi.unstubAllGlobals();
});

function metalEnvironment() {
  let now = 2000, nextRaf = 0, layoutReads = 0, callbacks = 0;
  const queue = new Map<number, FrameRequestCallback>();
  const drawImage = vi.fn();
  const gl = new Proxy({}, { get: (_target, key) => {
    if (key === 'getShaderParameter' || key === 'getProgramParameter') return () => true;
    if (key === 'getUniformLocation' || key === 'getExtension') return () => null;
    if (key === 'getAttribLocation') return () => 0;
    if (typeof key === 'string' && /^[A-Z_0-9]+$/.test(key)) return 1;
    return () => ({});
  } });
  const context = new Proxy({ drawImage }, { get: (target, key) => {
    if (key === 'drawImage') return target.drawImage;
    if (key === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
    if (key === 'createLinearGradient') return () => ({ addColorStop() {} });
    return () => {};
  } });
  class Element extends EventTarget {
    width = 40; height = 40; isConnected = true; innerHTML = '';
    children: Element[] = []; parentNode: Element | null = null;
    attributes = new Map<string, string>();
    style = { position: '', isolation: '', setProperty: vi.fn(), removeProperty: vi.fn() };
    tagName: string;
    constructor(tagName = 'DIV') { super(); this.tagName = tagName; }
    get firstChild() { return this.children[0] ?? null; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    hasAttribute(name: string) { return this.attributes.has(name); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    getContext(kind: string) { return kind === 'webgl2' ? gl : context; }
    getBoundingClientRect() { layoutReads++; return { left: 0, top: 0, width: 40, height: 40, right: 40, bottom: 40 }; }
    appendChild(child: Element) { this.children.push(child); child.parentNode = this; }
    insertBefore(child: Element, before: Element | null) {
      const index = before === null ? this.children.length : this.children.indexOf(before);
      this.children.splice(index, 0, child); child.parentNode = this;
    }
    removeChild(child: Element) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    remove() { this.parentNode?.removeChild(this); }
  }
  class Document extends EventTarget {
    hidden = false; documentElement = new Element(); body = new Element(); head = new Element();
    createElement(tag: string) { return new Element(tag.toUpperCase()); }
    getElementById() { return null; }
  }
  const document = new Document();
  const window = Object.assign(new EventTarget(), {
    devicePixelRatio: 1,
    matchMedia: (query: string) => ({ matches: query === '(pointer: fine)' || query === '(hover: hover)', addEventListener() {}, removeEventListener() {} }),
  });
  const requestFrame = vi.fn((callback: FrameRequestCallback) => { queue.set(++nextRaf, callback); return nextRaf; });
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('OffscreenCanvas', undefined);
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('requestAnimationFrame', requestFrame);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => queue.delete(id));
  vi.stubGlobal('getComputedStyle', () => ({ borderTopLeftRadius: '20px', position: 'static' }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  return {
    document, queue, requestFrame, drawImage,
    canvas: () => new Element() as unknown as HTMLCanvasElement,
    element: (tag = 'DIV') => new Element(tag),
    layoutReads: () => layoutReads, callbacks: () => callbacks,
    move() { const event = new Event('pointermove'); Object.assign(event, { pointerType: 'mouse', clientX: 40, clientY: 20 }); document.dispatchEvent(event); },
    frames(count: number) {
      for (let i = 0; i < count; i++) {
        now += 1000 / 60;
        const pending = [...queue.values()]; queue.clear();
        pending.forEach((callback) => { callbacks++; callback(now); });
      }
    },
  };
}

describe('内置生成特效', () => {
  it('九种思考状态、两种尺寸的逐帧数据与原 0.3.1 包一致', () => {
    const states: OrbState[] = ['working', 'searching', 'solving', 'listening', 'connecting', 'composing', 'breathing', 'weaving', 'shaping'];
    const frames = [];
    for (const state of states) for (const size of [20, 64] as const) for (const t of [0, 0.75, 2.25]) {
      const { mode, speed, opts } = resolvePreset(state, size);
      const frame = MODE_FRAMES[mode](size, t * speed, opts);
      expect(frame.dots.length).toBeGreaterThan(0);
      for (const dot of frame.dots) {
        expect([dot.x, dot.y, dot.r, dot.white].every(Number.isFinite)).toBe(true);
        expect(dot.r).toBeGreaterThan(0);
      }
      frames.push({ state, size, t, frame });
    }
    // 基准来自原 npm 0.3.1 包；统一到 1e-9 精度，避免平台三角函数尾数差异导致误报。
    const serialized = JSON.stringify(frames, (_key, value: unknown) =>
      typeof value === 'number' ? Number(value.toFixed(9)) : value);
    expect(digest(serialized)).toBe('e0aa7653511b33b68267e073ec969c52492ecf17ca2de24b550b685e68b5f259');
  });

  it('两段着色器与原 metal-fx 2.0.10 包逐字节一致', () => {
    expect(digest(VERT_SHADER_SRC)).toBe('d6e27de82436a9b8b91e215f1191bb64b771c46a1c7bbbcaea4d28fc948c1731');
    expect(digest(FRAG_SHADER_SRC)).toBe('bfefe9d474e890f75302bddaacc00d7d04b98cb7147d059a365f97c9665f5463');
  });

  it.each([['working', 1132], ['composing', 2198], ['breathing', 1945]] as const)(
    '%s 复用同一角度的三角函数，不增加每帧计算', (state, calls) => {
      const sine = vi.spyOn(Math, 'sin');
      const cosine = vi.spyOn(Math, 'cos');
      const { mode, speed, opts } = resolvePreset(state, 64);
      MODE_FRAMES[mode](64, 0.5 * speed, opts);
      expect(sine.mock.calls.length + cosine.mock.calls.length).toBe(calls);
    },
  );

  it('边框暂停保留激活画面，所有类型和明暗主题均可独立渲染', () => {
    for (const size of ['md', 'sm', 'line', 'pulse-outside', 'pulse-inner'] as const) {
      for (const theme of ['dark', 'light'] as const) {
        const markup = renderToStaticMarkup(<BorderBeam size={size} theme={theme} paused><div>生成中</div></BorderBeam>);
        expect(markup).toContain('data-active=""');
        expect(markup).toContain('data-paused=""');
        expect(markup).not.toContain('data-fading=""');
        expect(markup).not.toMatch(/NaN|undefinedpx/);
      }
    }
  });

  it('旧 WebGL 画布的迟到事件不会停掉或重建新渲染器', () => {
    const gl = new Proxy({}, {
      get: (_target, key) => {
        if (key === 'getShaderParameter' || key === 'getProgramParameter') return () => true;
        if (key === 'getUniformLocation' || key === 'getExtension') return () => null;
        if (key === 'getAttribLocation') return () => 0;
        if (typeof key === 'string' && /^[A-Z_0-9]+$/.test(key)) return 1;
        return () => ({});
      },
    });
    class Canvas extends EventTarget { width = 0; height = 0; getContext() { return gl; } }
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.stubGlobal('document', { createElement: () => new Canvas() });
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const old = ensureSharedRenderer();
    teardownSharedRenderer();
    const current = ensureSharedRenderer();
    const program = current.program;
    old.glCanvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    old.glCanvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(current.contextLost).toBe(false);
    expect(current.program).toBe(program);
    current.glCanvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(current.contextLost).toBe(true);
    current.glCanvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(current.contextLost).toBe(false);
    expect(current.program).not.toBe(program);
  });

  it('光标没有可显示效果时不扫描节点，启停、精确边界与隐藏恢复保持原交互', async () => {
    vi.resetModules();
    const env = metalEnvironment();
    const core = await import('../../src/vendor/generation-effects/metal-fx/src/engine/renderer/core');
    const loop = await import('../../src/vendor/generation-effects/metal-fx/src/engine/renderer/loop');
    const cursor = await import('../../src/vendor/generation-effects/metal-fx/src/engine/cursor/light');
    const inst = loop.createInstance({ hostCanvas: env.canvas(), cssWidth: 40, cssHeight: 40, cornerRadius: 20, kind: 'circle', paused: true });
    loop.pauseShared();
    cursor.attachCursorLight();
    cleanups.push(() => { cursor.detachCursorLight(); loop.destroyInstance(inst); core.teardownSharedRenderer(); });
    env.requestFrame.mockClear();
    for (let i = 0; i < 60; i++) { env.move(); env.frames(1); }
    expect(env.layoutReads()).toBe(0);
    expect(env.requestFrame).not.toHaveBeenCalled();
    expect(env.callbacks()).toBe(0);

    cursor.setCursorLightConfig({ catchLight: true });
    env.move(); env.frames(60);
    expect(env.layoutReads()).toBe(60);
    expect(inst.cursorLight).toMatchObject({ x: 40, y: 20 });
    expect(Number.isFinite(inst.cursorLight?.w)).toBe(true);
    const weight = inst.cursorLight!.w;
    expect(weight).toBeGreaterThan(0.9);
    cursor.setCursorLightConfig({ enabled: false });
    env.frames(1);
    expect(inst.cursorLight!.w).toBeLessThan(weight);
    expect(inst.cursorLight!.w).toBeGreaterThan(0);
    env.frames(119);
    expect(env.layoutReads()).toBe(60);
    expect(inst.cursorLight).toBeNull();
    expect(env.queue.size).toBe(0);

    cursor.setCursorLightConfig({ enabled: true });
    env.move(); env.frames(10);
    env.document.hidden = true;
    env.document.dispatchEvent(new Event('visibilitychange'));
    const callbacks = env.callbacks(), reads = env.layoutReads();
    cursor.setCursorLightConfig({ enabled: true });
    env.frames(60);
    expect(env.callbacks()).toBe(callbacks);
    expect(env.layoutReads()).toBe(reads);
    expect(env.queue.size).toBe(0);
    env.document.hidden = false;
    env.document.dispatchEvent(new Event('visibilitychange'));
    env.frames(120);
    expect(env.queue.size).toBe(0);
    expect(inst.cursorLight).toBeNull();
    env.move(); env.frames(5);
    expect(inst.cursorLight!.w).toBeGreaterThan(0);
  });

  it('关闭光晕只停止光晕更新，金属边框、句柄与共享渲染器保持同一实例', async () => {
    vi.resetModules();
    const env = metalEnvironment();
    const refs: Array<{ current: unknown }> = [], states: unknown[] = [];
    const effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }> = [];
    const pending: Array<() => void> = [];
    let refIndex = 0, stateIndex = 0, effectIndex = 0;
    const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = effectIndex++, previous = effects[index];
      if (previous && deps?.length === previous.deps?.length && deps?.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
      pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: run() ?? undefined }; });
    };
    vi.doMock('react', async () => ({
      ...await vi.importActual<typeof import('react')>('react'),
      forwardRef: (render: (props: unknown, ref: null) => ReactNode) => (props: unknown) => render(props, null),
      useMemo: (factory: () => unknown) => factory(), useImperativeHandle: () => {},
      useEffect: effect, useLayoutEffect: effect,
      useRef: (initial: unknown) => refs[refIndex++] ??= { current: initial },
      useState: (initial: unknown) => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
        return [states[index], (value: unknown) => { states[index] = value; }];
      },
    }));
    const handles = {}, injectGlow = vi.fn(() => handles), updateGlow = vi.fn((_handles: unknown) => false);
    vi.doMock('../../src/vendor/generation-effects/metal-fx/src/engine/glow/glow', () => ({
      injectGlow, updateGlow, updateGlowMask: vi.fn(), carryGlowState: vi.fn(),
    }));
    const { MetalFx } = await import('../../src/vendor/generation-effects/metal-fx/src/MetalFx');
    const core = await import('../../src/vendor/generation-effects/metal-fx/src/engine/renderer/core');
    cleanups.push(() => { effects.slice().reverse().forEach((entry) => entry.cleanup?.()); core.teardownSharedRenderer(); });
    type ElementProps = { ref?: { current: unknown }; children?: ReactNode };
    const bindRefs = (node: ReactNode) => {
      if (Array.isArray(node)) { node.forEach(bindRefs); return; }
      if (!node || typeof node !== 'object' || !('props' in node)) return;
      const element = node as ReactElement<ElementProps>;
      if (element.props.ref && element.props.ref.current === null) element.props.ref.current = env.element();
      bindRefs(element.props.children);
    };
    const render = (disableGlow: boolean) => {
      refIndex = stateIndex = effectIndex = 0;
      bindRefs(MetalFx({ variant: 'circle', theme: 'dark', disableGlow, children: '生成' }));
      pending.splice(0).forEach((run) => run());
    };
    render(false);
    const shared = core.SHARED!, inst = [...shared.instances][0];
    expect(shared.glowQueue).toEqual([inst]);
    env.frames(12);
    expect(updateGlow).toHaveBeenCalled();
    const copies = env.drawImage.mock.calls.length;
    updateGlow.mockClear();
    render(true); env.frames(12);
    expect(core.SHARED).toBe(shared);
    expect([...shared.instances]).toEqual([inst]);
    expect(shared.glowQueue).toEqual([]);
    expect(updateGlow).not.toHaveBeenCalled();
    expect(env.drawImage.mock.calls.length).toBeGreaterThan(copies);
    expect(injectGlow).toHaveBeenCalledOnce();
    render(false); env.frames(12);
    expect(shared.glowQueue).toEqual([inst]);
    expect(updateGlow).toHaveBeenCalled();
    expect(updateGlow.mock.calls.every(([actual]) => actual === handles)).toBe(true);
    expect(injectGlow).toHaveBeenCalledOnce();
    expect(core.SHARED).toBe(shared);
  });

  it('UI Kit 把邻近反射绑定到输入框容器，真实绘制层可注册、绘制和清理', async () => {
    vi.resetModules();
    const env = metalEnvironment();
    let stateIndex = 0;
    vi.doMock('react', async () => ({
      ...await vi.importActual<typeof import('react')>('react'),
      useEffect: () => {}, useRef: (initial: unknown) => ({ current: initial }),
      useState: (initial: unknown) => {
        const index = stateIndex++;
        return [index === 0 ? true : initial === 'beam' ? 'metal' : typeof initial === 'function' ? initial() : initial, () => {}];
      },
    }));
    vi.doMock('framer-motion', () => ({ useReducedMotion: () => false }));
    const { default: Preview } = await import('../../src/components/styleGuide/StyleGuideGenerationEffects');
    type Props = { ref?: { current: unknown }; className?: string; reflectionTargets?: Array<{ current: unknown }>; children?: ReactNode };
    const elements: ReactElement<Props>[] = [];
    const walk = (node: ReactNode) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object' || !('props' in node)) return;
      const element = node as ReactElement<Props>;
      elements.push(element); walk(element.props.children);
    };
    walk(Preview({ theme: 'dark' }));
    const metal = elements.find((element) => element.props.reflectionTargets);
    const ref = metal!.props.reflectionTargets![0];
    const surface = elements.find((element) => element.props.ref === ref)!;
    expect(surface.type).toBe('div');
    expect(surface.props.className?.split(' ')).toContain('ui-input-group');
    expect((surface.props.children as ReactElement).type).toBe('input');

    const host = env.element('DIV'), input = env.element('INPUT'), anchorEl = env.element();
    host.appendChild(input); ref.current = host;
    anchorEl.getBoundingClientRect = () => ({ left: 60, top: 0, width: 40, height: 40, right: 100, bottom: 40 });
    const loop = await import('../../src/vendor/generation-effects/metal-fx/src/engine/renderer/loop');
    const core = await import('../../src/vendor/generation-effects/metal-fx/src/engine/renderer/core');
    const { addReflectionTarget, paintReflections, removeReflectionTarget } = await import('../../src/vendor/generation-effects/metal-fx/src/engine/reflection/paint');
    const inst = loop.createInstance({ hostCanvas: env.canvas(), cssWidth: 40, cssHeight: 40, cornerRadius: 20, kind: 'circle', paused: true });
    cleanups.push(() => { removeReflectionTarget(host as unknown as HTMLElement); loop.destroyInstance(inst); core.teardownSharedRenderer(); });
    expect(addReflectionTarget(input as unknown as HTMLElement, inst, anchorEl as unknown as HTMLElement)).toBeNull();
    const target = addReflectionTarget(ref.current as HTMLElement, inst, anchorEl as unknown as HTMLElement)!;
    expect(target).not.toBeNull();
    expect(host.hasAttribute('data-metal-fx-reflect-host')).toBe(true);
    expect(host.children[0].children.map((child) => child.tagName)).toEqual(['CANVAS', 'CANVAS']);
    expect(host.children[1]).toBe(input);
    env.drawImage.mockClear();
    paintReflections();
    expect(env.drawImage.mock.calls.some(([source]) => source === inst.canvas)).toBe(true);
    removeReflectionTarget(host as unknown as HTMLElement);
    expect(host.children).toEqual([input]);
    expect(host.hasAttribute('data-metal-fx-reflect-host')).toBe(false);
    expect([target.canvas.width, target.canvas.height, target.strokeCanvas.width, target.strokeCanvas.height]).toEqual([0, 0, 0, 0]);
    expect(host.style).toMatchObject({ position: '', isolation: '' });
  });

  it('三个模块可从源码打包，不依赖原 npm 包或 Paper 运行时', async () => {
    const result = await build({
      stdin: {
        contents: [
          "export * from './src/vendor/generation-effects/thinking-orbs/src';",
          "export * from './src/vendor/generation-effects/border-beam/src';",
          "export * from './src/vendor/generation-effects/metal-fx/src';",
        ].join('\n'),
        resolveDir: resolve('.'),
      },
      bundle: true, write: false, format: 'esm', platform: 'browser', metafile: true,
      external: ['react', 'react-dom', 'react/jsx-runtime'],
    });
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs.some((path) => path.includes('paper-shaders/liquid-metal.ts'))).toBe(true);
    expect(inputs.some((path) => /node_modules\/(thinking-orbs|border-beam|metal-fx|@paper-design)/.test(path))).toBe(false);
    expect(result.outputFiles[0].text.length).toBeGreaterThan(0);
  });
});

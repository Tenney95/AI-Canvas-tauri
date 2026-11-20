/// <reference types="@webgpu/types" />

type ColorPixel = [red: number, green: number, blue: number, alpha: number];

export type HtmlInCanvasProbeResult =
  | { status: 'supported'; pixel: ColorPixel; elementGeometry: boolean }
  | { status: 'unsupported' | 'failed'; reason: string; pixel?: ColorPixel };

interface DrawableCanvas extends HTMLCanvasElement {
  requestPaint?: () => void;
  getElementTransform?: unknown;
  updateElementGeometry?: unknown;
}

interface ElementCopyQueue extends GPUQueue {
  drawElementImageToTexture?: (
    source: { source: HTMLElement },
    target: { texture: GPUTexture; size: GPUExtent3D; premultipliedAlpha: boolean },
  ) => void;
}

const SAMPLE_SIZE = 4;
const ROW_ALIGNMENT = 256;
const TIMEOUT_MS = 6000;
let activeProbe: Promise<HtmlInCanvasProbeResult> | undefined;

/** Exercise the experimental DOM snapshot path in the actual WebView. */
async function readHtmlInCanvasPixel(): Promise<HtmlInCanvasProbeResult> {
  if (!import.meta.env.DEV || typeof document === 'undefined' || !navigator.gpu) {
    return { status: 'unsupported', reason: 'webgpu-unavailable' };
  }
  const canvas: DrawableCanvas = document.createElement('canvas');
  const requestPaint = canvas.requestPaint?.bind(canvas);
  if (!requestPaint) return { status: 'unsupported', reason: 'canvas-request-paint-unavailable' };

  const controller = new AbortController();
  const { signal } = controller;
  let device: GPUDevice | undefined;
  let texture: GPUTexture | undefined;
  let readback: GPUBuffer | undefined;
  const drawing: { context?: GPUCanvasContext } = {};
  let timer: number | undefined;
  let stage = 'adapter';

  const sample = async (): Promise<HtmlInCanvasProbeResult> => {
    const gpu = navigator.gpu;
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    signal.throwIfAborted();
    if (!adapter) return { status: 'unsupported', reason: 'adapter-unavailable' };

    stage = 'device';
    const acquired = await adapter.requestDevice();
    // Native WebGPU requests cannot be aborted. Dispose a late device immediately.
    if (signal.aborted) {
      acquired.destroy();
      signal.throwIfAborted();
    }
    device = acquired;
    const queue: ElementCopyQueue = device.queue;
    if (typeof queue.drawElementImageToTexture !== 'function') {
      return { status: 'unsupported', reason: 'draw-element-to-texture-unavailable' };
    }

    stage = 'canvas';
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    canvas.setAttribute('content', 'drawable');
    canvas.setAttribute('aria-hidden', 'true');
    // Keep the sample in the rendering tree without intercepting any input.
    Object.assign(canvas.style, {
      position: 'fixed',
      right: '0',
      bottom: '0',
      width: `${SAMPLE_SIZE}px`,
      height: `${SAMPLE_SIZE}px`,
      pointerEvents: 'none',
    });
    const stamp = document.createElement('div');
    stamp.setAttribute('drawable', '');
    Object.assign(stamp.style, {
      width: `${SAMPLE_SIZE}px`,
      height: `${SAMPLE_SIZE}px`,
      backgroundColor: 'rgb(255 0 0)',
    });
    canvas.append(stamp);
    const context = canvas.getContext('webgpu');
    if (!context) return { status: 'unsupported', reason: 'webgpu-context-unavailable' };
    drawing.context = context;

    stage = 'paint';
    context.configure({ device, format: gpu.getPreferredCanvasFormat(), alphaMode: 'premultiplied' });
    await new Promise<void>((resolve) => {
      canvas.addEventListener('paint', () => resolve(), { once: true, signal });
      signal.addEventListener('abort', () => resolve(), { once: true });
      document.body.append(canvas);
      requestPaint();
    });
    signal.throwIfAborted();

    stage = 'draw';
    device.pushErrorScope('validation');
    const size = { width: SAMPLE_SIZE, height: SAMPLE_SIZE };
    texture = device.createTexture({
      size,
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    queue.drawElementImageToTexture({ source: stamp }, { texture, size, premultipliedAlpha: false });
    readback = device.createBuffer({
      size: ROW_ALIGNMENT,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const commands = device.createCommandEncoder();
    commands.copyTextureToBuffer(
      { texture, origin: { x: SAMPLE_SIZE / 2, y: SAMPLE_SIZE / 2 } },
      { buffer: readback, bytesPerRow: ROW_ALIGNMENT },
      { width: 1, height: 1 },
    );
    queue.submit([commands.finish()]);
    if (await device.popErrorScope()) return { status: 'failed', reason: 'gpu-validation' };
    signal.throwIfAborted();

    stage = 'readback';
    await readback.mapAsync(GPUMapMode.READ);
    signal.throwIfAborted();
    const [red, green, blue, alpha] = new Uint8Array(readback.getMappedRange(), 0, 4);
    const pixel: ColorPixel = [red, green, blue, alpha];
    if (red < 250 || green > 5 || blue > 5 || alpha < 250) {
      return { status: 'failed', reason: 'unexpected-pixel', pixel };
    }
    return {
      status: 'supported',
      pixel,
      elementGeometry: typeof canvas.getElementTransform === 'function' && typeof canvas.updateElementGeometry === 'function',
    };
  };

  try {
    const deadline = new Promise<HtmlInCanvasProbeResult>((resolve) => {
      timer = window.setTimeout(() => resolve({ status: 'failed', reason: `${stage}-timeout` }), TIMEOUT_MS);
    });
    return await Promise.race([sample(), deadline]);
  } catch {
    return { status: 'failed', reason: stage };
  } finally {
    window.clearTimeout(timer);
    controller.abort();
    canvas.remove();
    drawing.context?.unconfigure();
    readback?.destroy();
    texture?.destroy();
    device?.destroy();
  }
}

export function probeHtmlInCanvas(): Promise<HtmlInCanvasProbeResult> {
  activeProbe ??= readHtmlInCanvasPixel().finally(() => { activeProbe = undefined; });
  return activeProbe;
}

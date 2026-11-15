/**
 * projectSnapshotService — 回归测试：projectSnapshotService。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
const comfyImages = vi.hoisted(() => ({ matches: vi.fn(() => false), acquire: vi.fn() }));
vi.mock('../../src/services/comfyImageSource', () => ({
  shouldLoadNativeComfyImage: comfyImages.matches,
  acquireComfyImageSource: comfyImages.acquire,
}));
import {
  captureCurrentCanvasSnapshot,
  getProjectSnapshotBitmapSize,
  isProjectSnapshotDataUrl,
  PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH,
  toProjectSnapshotRect,
} from '../../src/services/projectSnapshotService';
import { createProjectSnapshotGeometry, projectSnapshotGeometry } from '../../src/services/projectSnapshotGeometry';
import { registerCanvasViewportController } from '../../src/services/canvasViewportService';
import type { ProjectSnapshotWorkerRequest, ProjectSnapshotWorkerResponse } from '../../src/services/projectSnapshotWorker';

function geometryNode(id: string, x: number, y: number, extra: Partial<Node<BaseNodeData>> = {}): Node<BaseNodeData> {
  return { id, type: 'ai-image', position: { x, y }, data: { type: 'ai-image', label: id, nodeWidth: 100, nodeHeight: 80 }, ...extra };
}

function installMediaCapture(count = 4, mode: 'hold' | 'blocked' | 'transfer-error' = 'hold') {
  const rect = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 450, width: 800, height: 450 };
  let mounted = true;
  const originalReads = vi.fn(() => { if (!mounted) throw new Error('source unmounted'); });
  class SnapshotImage {
    private readonly index: number;
    constructor(index: number) { this.index = index; }
    complete = true;
    get currentSrc() { originalReads(); return `https://private.example/image-${this.index}.png?token=private-token`; }
    get src() { return this.currentSrc; }
    get naturalWidth() { originalReads(); return 4_000; }
    get naturalHeight() { originalReads(); return 2_000; }
    getBoundingClientRect() {
      originalReads();
      return { ...rect, right: 200, bottom: 120, width: 200, height: 120 };
    }
  }
  const draws: Array<{ source: unknown; width: number; height: number }> = [];
  const surfaces: Array<{ width: number; height: number }> = [];
  const readPixels = vi.fn((width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
  class SnapshotCanvas {
    width = 0;
    height = 0;
    getContext() {
      return {
        drawImage: (source: unknown) => {
          if (source instanceof SnapshotImage) originalReads();
          draws.push({ source, width: this.width, height: this.height });
        },
        getImageData: (_x: number, _y: number, width: number, height: number) => readPixels(width, height),
      };
    }
  }
  const images = Array.from({ length: count }, (_, index) => new SnapshotImage(index));
  const root = { getBoundingClientRect: () => rect, querySelectorAll: () => images };
  const palette = { card: '#fffefe', border: '#cbcbd1', text: '#23232a', textSecondary: '#5a5a65', muted: '#81818e', hover: '#eeeeef' };
  const variables: Record<string, string> = {
    '--theme-bg': '#fafafa', '--theme-card': palette.card, '--theme-border': palette.border,
    '--theme-text': palette.text, '--theme-text-secondary': palette.textSecondary,
    '--theme-text-muted': palette.muted, '--theme-hover': palette.hover,
  };
  const requests: ProjectSnapshotWorkerRequest[] = [];
  const transfers: Transferable[][] = [];
  const createBitmap = vi.fn(() => { throw new Error('ImageBitmap must not be used'); });
  const workers: Array<{ onmessage: ((event: MessageEvent<ProjectSnapshotWorkerResponse>) => void) | null; onerror?: () => void }> = [];
  vi.stubGlobal('HTMLImageElement', SnapshotImage);
  vi.stubGlobal('HTMLCanvasElement', SnapshotCanvas);
  vi.stubGlobal('document', {
    documentElement: {}, querySelector: () => root,
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error('unexpected DOM cloning');
      const canvas = new SnapshotCanvas(); surfaces.push(canvas); return canvas;
    },
  });
  vi.stubGlobal('window', { setTimeout, clearTimeout, btoa });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => variables[name] ?? '', objectFit: 'contain' }));
  vi.stubGlobal('OffscreenCanvas', class {});
  vi.stubGlobal('createImageBitmap', createBitmap);
  vi.stubGlobal('Worker', class {
    onmessage: ((event: MessageEvent<ProjectSnapshotWorkerResponse>) => void) | null = null;
    onerror?: () => void;
    constructor() { if (mode === 'blocked') throw new Error('blocked'); workers.push(this); }
    postMessage(request: ProjectSnapshotWorkerRequest, transfer: Transferable[]) {
      if (mode === 'transfer-error') throw new DOMException('private transfer details', 'DataCloneError');
      requests.push(request); transfers.push(transfer);
    }
    terminate() {}
  });
  const unregister = registerCanvasViewportController({
    getSnapshot: () => ({ x: 0, y: 0, zoom: 1, visibleBounds: rect }),
    setViewport: async () => {}, fitView: async () => {},
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { images, draws, surfaces, readPixels, createBitmap, requests, transfers, palette, originalReads,
    unregister: () => { for (const worker of workers) worker.onerror?.(); unregister(); },
    unmount: () => { mounted = false; },
    respond: () => {
      for (const request of requests) workers[0].onmessage?.({ data: {
        id: request.id, ok: true, buffer: new ArrayBuffer(4), mimeType: 'image/webp',
      } } as MessageEvent<ProjectSnapshotWorkerResponse>);
    },
  };
}

function installCorsReloads() {
  let maxActive = 0;
  const images: ReloadImage[] = [];
  class ReloadImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decoding = '';
    complete = true;
    naturalWidth = 4_000;
    naturalHeight = 2_000;
    readonly assignmentOrder: string[] = [];
    requestedSource = '';
    decode = vi.fn(async () => {});
    private origin = '';
    private source = '';
    constructor() { images.push(this); }
    set crossOrigin(value: string) { this.origin = value; this.assignmentOrder.push('crossOrigin'); }
    get crossOrigin() { return this.origin; }
    set src(value: string) {
      if (this.origin !== 'anonymous') throw new Error('CORS must be set before src');
      this.assignmentOrder.push('src'); this.source = value; this.requestedSource = value;
      maxActive = Math.max(maxActive, images.filter((image) => image.source).length);
    }
    get src() { return this.source; }
    removeAttribute(name: string) { if (name === 'src') this.source = ''; }
  }
  vi.stubGlobal('Image', ReloadImage);
  return { images, maxActive: () => maxActive };
}

async function renderWithSnapshotWorker(convertToBlob: (options: ImageEncodeOptions) => Promise<Blob>) {
  let respond!: (value: ProjectSnapshotWorkerResponse) => void;
  const response = new Promise<ProjectSnapshotWorkerResponse>((resolve) => { respond = resolve; });
  const scope = {
    onmessage: null as ((event: MessageEvent<ProjectSnapshotWorkerRequest>) => void) | null,
    postMessage: vi.fn((message: ProjectSnapshotWorkerResponse) => respond(message)),
  };
  const context = {
    fillRect: vi.fn(), save: vi.fn(), scale: vi.fn(), restore: vi.fn(),
    beginPath: vi.fn(), roundRect: vi.fn(), clip: vi.fn(), drawImage: vi.fn(), putImageData: vi.fn(),
  };
  const surfaces: Array<{ width: number; height: number }> = [];
  vi.stubGlobal('self', scope);
  vi.stubGlobal('ImageData', class {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  });
  vi.stubGlobal('OffscreenCanvas', class {
    width: number;
    height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; surfaces.push(this); }
    getContext() { return context; }
    convertToBlob(options: ImageEncodeOptions) { return convertToBlob(options); }
  });
  vi.resetModules();
  await import('../../src/services/projectSnapshotWorker');
  const request: ProjectSnapshotWorkerRequest = {
    id: 101, width: 480, height: 270, sourceWidth: 800, sourceHeight: 450,
    backgroundColor: '#fafafa',
    palette: { card: '#fff', border: '#ccc', text: '#222', textSecondary: '#555', muted: '#888', hover: '#eee' },
    geometry: { nodes: [], edges: [] }, viewport: { x: 0, y: 0, zoom: 1 },
    media: [{ x: 0, y: 0, width: 1, height: 1, fit: 'fill', pixelWidth: 2, pixelHeight: 2, pixels: new ArrayBuffer(16) }],
  };
  scope.onmessage!({ data: request } as MessageEvent<ProjectSnapshotWorkerRequest>);
  const result = await response;
  return { result, mediaSurfaces: surfaces.slice(1), context };
}

describe('projectSnapshotService', () => {
  afterEach(() => {
    comfyImages.matches.mockReset().mockReturnValue(false);
    comfyImages.acquire.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('accepts bounded image data URLs only', () => {
    expect(isProjectSnapshotDataUrl('data:image/webp;base64,AAAA')).toBe(true);
    expect(isProjectSnapshotDataUrl('https://example.com/preview.webp')).toBe(false);
    expect(isProjectSnapshotDataUrl(`data:image/webp;base64,${'A'.repeat(PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH)}`)).toBe(false);
  });

  it('encodes oversized WebKit PNG fallback as JPEG and reports the actual image format', async () => {
    const convertToBlob = vi.fn(async ({ type }: ImageEncodeOptions) => new Blob(
      [new Uint8Array(type === 'image/webp' ? 300_000 : 1_024)],
      { type: type === 'image/webp' ? 'image/png' : 'image/jpeg' },
    ));

    const { result, mediaSurfaces, context } = await renderWithSnapshotWorker(convertToBlob);

    expect(convertToBlob.mock.calls.map(([options]) => options.type)).toEqual(['image/webp', 'image/jpeg']);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.buffer.byteLength).toBe(1_024);
    expect(context.putImageData).toHaveBeenCalledOnce();
    expect(mediaSurfaces).toEqual([{ width: 0, height: 0 }]);
  });

  it('reports a worker failure when every supported encoding exceeds the snapshot budget', async () => {
    const convertToBlob = vi.fn(async ({ type }: ImageEncodeOptions) => new Blob([new Uint8Array(300_000)], { type }));

    const { result, mediaSurfaces } = await renderWithSnapshotWorker(convertToBlob);

    expect(convertToBlob.mock.calls.map(([options]) => options.type)).toEqual(expect.arrayContaining(['image/webp', 'image/jpeg']));
    expect(result).toMatchObject({ id: 101, ok: false, error: expect.stringContaining('exceeds size budget') });
    expect(result).not.toHaveProperty('buffer');
    expect(mediaSurfaces).toEqual([{ width: 0, height: 0 }]);
  });

  it('returns an in-budget WebP without re-encoding it as another format', async () => {
    const convertToBlob = vi.fn(async () => new Blob([new Uint8Array(512)], { type: 'image/webp' }));

    const { result, mediaSurfaces } = await renderWithSnapshotWorker(convertToBlob);

    expect(convertToBlob).toHaveBeenCalledOnce();
    expect(convertToBlob).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/webp' }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.mimeType).toBe('image/webp');
    expect(result.buffer.byteLength).toBe(512);
    expect(mediaSurfaces).toEqual([{ width: 0, height: 0 }]);
  });

  it('maps visible DOM bounds into canvas-relative worker coordinates', () => {
    const root = { left: 100, top: 50, right: 900, bottom: 500, width: 800, height: 450 };
    expect(toProjectSnapshotRect({
      left: 220,
      top: 140,
      right: 420,
      bottom: 300,
      width: 200,
      height: 160,
    }, root)).toEqual({ x: 120, y: 90, width: 200, height: 160 });
    expect(toProjectSnapshotRect({
      left: 920,
      top: 140,
      right: 1020,
      bottom: 300,
      width: 100,
      height: 160,
    }, root)).toBeNull();
  });

  it('downsamples media to its thumbnail footprint while preserving its aspect ratio', () => {
    expect(getProjectSnapshotBitmapSize({
      displayHeight: 300,
      displayWidth: 400,
      fit: 'contain',
      scaleX: 0.6,
      scaleY: 0.6,
      sourceHeight: 2_000,
      sourceWidth: 4_000,
    })).toEqual({ width: 240, height: 120 });
  });

  it('keeps enough pixels for cover media without retaining the full source image', () => {
    expect(getProjectSnapshotBitmapSize({
      displayHeight: 300,
      displayWidth: 400,
      fit: 'cover',
      scaleX: 0.6,
      scaleY: 0.6,
      sourceHeight: 2_000,
      sourceWidth: 4_000,
    })).toEqual({ width: 360, height: 180 });
    expect(getProjectSnapshotBitmapSize({
      displayHeight: 450,
      displayWidth: 800,
      fit: 'cover',
      scaleX: 0.6,
      scaleY: 0.6,
      sourceHeight: 8_000,
      sourceWidth: 4_000,
    })).toEqual({ width: 240, height: 480 });
  });

  it('passes only bounded geometry to the worker, excluding business data and references', () => {
    const node = geometryNode('image', 20, 30);
    node.data = { ...node.data, label: '图'.repeat(80), prompt: 'private prompt', filePath: 'private-path', imageUrl: 'private-url' };
    const geometry = createProjectSnapshotGeometry({ nodes: [node], edges: [] });
    expect(geometry.nodes[0].label).toHaveLength(48);
    expect(JSON.stringify(geometry)).not.toMatch(/private|prompt|filePath|imageUrl|"data"/);
    expect(geometry.nodes[0]).toMatchObject({ x: 20, y: 30, width: 100, height: 80 });
  });

  it('keeps bounded text previews but excludes prompts, paths, URLs and unrelated node data', () => {
    const geometry = createProjectSnapshotGeometry({ nodes: [geometryNode('text', 20, 30, {
      type: 'ai-text', data: { type: 'ai-text', label: '文本', prompt: 'private-prompt', filePath: '/private/source.txt',
        output: `可见正文 @asset{%2Fprivate%2Fimage.png} https://private.example/image.png C:\\private\\source.txt /private/source.txt ${'长'.repeat(1_200)}` },
    })], edges: [] });
    const preview = geometry.nodes[0].preview;

    expect(preview?.kind).toBe('text');
    if (preview?.kind !== 'text') throw new Error('text preview missing');
    expect(preview.text).toContain('可见正文');
    expect(preview.text.length).toBeLessThanOrEqual(800);
    expect(JSON.stringify(geometry)).not.toMatch(/private|@asset|https:|filePath|prompt|"data"/);
    const projected = projectSnapshotGeometry(geometry, { x: 10, y: 20, zoom: 2 }, 800, 450);
    expect(projected.nodes[0]).toMatchObject({ x: 50, y: 80, preview });
  });

  it('bounds shotlist previews to display columns and rows without carrying media or hidden fields', () => {
    const geometry = createProjectSnapshotGeometry({ nodes: [geometryNode('shots', 0, 0, {
      type: 'ai-shotlist', data: { type: 'ai-shotlist', label: '分镜表', prompt: 'private-prompt',
        shotlistColumns: ['shotNo', 'shotSize', 'camera', 'content', 'dialogue', 'duration', 'audio', 'note'],
        shotlistRows: Array.from({ length: 20 }, (_, index) => ({
          id: `row-${index}`, shotNo: '99', shotSize: '近景', camera: '推进', duration: 3,
          content: `画面${index} ${'长'.repeat(200)}`, dialogue: '台词 /private/script.txt',
          audio: 'hidden-audio', note: 'hidden-note',
          frame: { nodeId: 'image', url: 'https://private.example/frame.png', kind: 'image' as const },
        })),
      },
    })], edges: [] });
    const preview = geometry.nodes[0].preview;

    expect(preview?.kind).toBe('shotlist');
    if (preview?.kind !== 'shotlist') throw new Error('shotlist preview missing');
    expect(preview.rows).toHaveLength(6);
    expect(preview.columns.length).toBeLessThanOrEqual(6);
    expect(preview.rows[0][0]).toBe('1');
    for (const row of preview.rows) {
      expect(row).toHaveLength(preview.columns.length);
      for (const cell of row) expect(cell.length).toBeLessThanOrEqual(80);
    }
    expect(JSON.stringify(geometry)).not.toMatch(/private|hidden-audio|hidden-note|frame\.png|"prompt"|"data"/);
    expect(projectSnapshotGeometry(geometry, { x: 0, y: 0, zoom: 1 }, 800, 450).nodes[0].preview).toEqual(preview);
  });

  it('resolves parent coordinates and node origins before viewport clipping', () => {
    const geometry = createProjectSnapshotGeometry({ nodes: [
      geometryNode('group', 100, 50, { type: 'group' }),
      geometryNode('child', 40, 30, { parentId: 'group', origin: [0.5, 0.5] }),
      geometryNode('outside', -1_000, 0),
    ], edges: [] });
    const result = projectSnapshotGeometry(geometry, { x: -100, y: 10, zoom: 2 }, 800, 450);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.find((node) => node.label === 'child')).toMatchObject({ x: 80, y: 90, width: 200, height: 160 });
  });

  it('uses persisted numeric group style dimensions when measurements are unavailable', () => {
    const geometry = createProjectSnapshotGeometry({ nodes: [
      geometryNode('group', 0, 0, { type: 'group', style: { width: 900, height: 600 }, data: { type: 'comment', label: 'group' } }),
      geometryNode('invalid-style', 0, 0, { type: 'group', style: { width: '100%', height: 0 }, data: { type: 'comment', label: 'invalid-style' } }),
    ], edges: [] });
    expect(geometry.nodes[0]).toMatchObject({ width: 900, height: 600 });
    expect(geometry.nodes[1]).toMatchObject({ width: 280, height: 160 });
  });

  it('omits cyclic parent chains, collapsed descendants and hidden-node edges', () => {
    const geometry = createProjectSnapshotGeometry({ nodes: [
      geometryNode('cycle-a', 0, 0, { parentId: 'cycle-b' }),
      geometryNode('cycle-b', 0, 0, { parentId: 'cycle-a' }),
      geometryNode('collapsed', 0, 0, { type: 'group', data: { type: 'comment', label: 'collapsed', groupCollapsed: true } }),
      geometryNode('child', 10, 10, { parentId: 'collapsed' }),
      geometryNode('hidden', 10, 10, { hidden: true }),
    ], edges: [{ id: 'hidden-edge', source: 'hidden', target: 'collapsed' }] });
    const result = projectSnapshotGeometry(geometry, { x: 0, y: 0, zoom: 1 }, 800, 450);
    expect(result.nodes.map((node) => node.label)).toEqual(['collapsed']);
    expect(result.edges).toEqual([]);
  });

  it('uses simple handle endpoints and keeps edges crossing the visible viewport', () => {
    const geometry = createProjectSnapshotGeometry({ nodes: [
      geometryNode('left', -150, 30),
      geometryNode('right', 900, 30),
    ], edges: [{ id: 'crossing', source: 'left', target: 'right', sourceHandle: 'right', targetHandle: 'left' }] });
    const result = projectSnapshotGeometry(geometry, { x: 0, y: 0, zoom: 1 }, 800, 450);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([{ points: [{ x: -50, y: 70 }, { x: 900, y: 70 }] }]);
    expect(projectSnapshotGeometry(geometry, { x: 0, y: 0, zoom: Number.NaN }, 800, 450)).toEqual({ nodes: [], edges: [] });
  });

  it('preserves the old thumbnail when worker support or geometry is missing', async () => {
    const querySelector = vi.fn();
    vi.stubGlobal('document', { querySelector });
    vi.stubGlobal('Worker', undefined);
    expect(await captureCurrentCanvasSnapshot('missing-geometry')).toBeNull();
    expect(await captureCurrentCanvasSnapshot('missing-worker', { nodes: [], edges: [] })).toBeNull();
    expect(querySelector).not.toHaveBeenCalled();
  });

  it('fails without DOM cloning when the worker fails', async () => {
    const querySelectorAll = vi.fn(() => []);
    const postMessage = vi.fn();
    const canvasRoot = {
      getBoundingClientRect: () => ({ width: 800, height: 450 }),
      querySelectorAll,
    };
    vi.stubGlobal('document', { documentElement: {}, querySelector: vi.fn(() => canvasRoot) });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'black' }));
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('createImageBitmap', undefined);
    vi.stubGlobal('Worker', class {
      onmessage: unknown;
      onerror?: () => void;
      postMessage() { postMessage(); this.onerror?.(); }
      terminate() {}
    });
    const unregister = registerCanvasViewportController({
      getSnapshot: () => ({ x: 0, y: 0, zoom: 1, visibleBounds: { x: 0, y: 0, width: 800, height: 450 } }),
      setViewport: async () => {},
      fitView: async () => {},
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const geometry = { nodes: [geometryNode('node', 0, 0)], edges: [] };
      const first = captureCurrentCanvasSnapshot('worker-failed', geometry);
      expect(captureCurrentCanvasSnapshot('worker-failed', { ...geometry })).toBe(first);
      const changed = captureCurrentCanvasSnapshot('worker-failed', { ...geometry, nodes: [...geometry.nodes] });
      expect(changed).not.toBe(first);
      expect(await Promise.all([first, changed])).toEqual([null, null]);
      expect(postMessage).toHaveBeenCalledTimes(2);
      expect(querySelectorAll).toHaveBeenCalledTimes(2);
    } finally {
      unregister();
    }
  });

  it('reads every media into bounded RGBA buffers before unmounting and transfers only those buffers', async () => {
    const harness = installMediaCapture();
    try {
      const geometry = { nodes: [], edges: [] };
      const capture = captureCurrentCanvasSnapshot('frozen-before-unmount', geometry);
      expect(captureCurrentCanvasSnapshot('frozen-before-unmount', geometry)).toBe(capture);
      const fresh = captureCurrentCanvasSnapshot('frozen-before-unmount', geometry, { fresh: true });
      expect(fresh).not.toBe(capture);
      expect(captureCurrentCanvasSnapshot('frozen-before-unmount', geometry)).toBe(fresh);

      expect(harness.draws.map((draw) => draw.source)).toEqual([...harness.images, ...harness.images]);
      expect(harness.readPixels).toHaveBeenCalledTimes(8);
      for (const draw of harness.draws) {
        expect(draw.width).toBeGreaterThan(0);
        expect(draw.height).toBeGreaterThan(0);
        expect(Math.max(draw.width, draw.height)).toBeLessThanOrEqual(480);
      }
      const readsBeforeUnmount = harness.originalReads.mock.calls.length;
      harness.unmount();
      await vi.waitFor(() => expect(harness.requests).toHaveLength(2));
      harness.respond();

      for (const snapshot of await Promise.all([capture, fresh])) expect(snapshot).toMatch(/^data:image\/webp;base64,/);
      expect(harness.originalReads).toHaveBeenCalledTimes(readsBeforeUnmount);
      expect(harness.createBitmap).not.toHaveBeenCalled();
      for (const [width, height] of harness.readPixels.mock.calls) {
        expect(width).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(0);
        expect(Math.max(width, height)).toBeLessThanOrEqual(480);
      }
      for (const [index, request] of harness.requests.entries()) {
        expect(request.media).toHaveLength(4);
        expect(harness.transfers[index]).toEqual(request.media.map((media) => media.pixels));
        for (const media of request.media) {
          expect(media.pixels).toBeInstanceOf(ArrayBuffer);
          expect(media.pixels.byteLength).toBe(media.pixelWidth * media.pixelHeight * 4);
          expect(media).not.toHaveProperty('bitmap');
          for (const key of ['source', 'src', 'element', 'currentSrc']) expect(media).not.toHaveProperty(key);
        }
      }
      expect(harness.requests[0].media).toHaveLength(4);
      expect(harness.requests[0].palette).toEqual(harness.palette);
      expect(harness.requests[0].backgroundColor).toBe('#fafafa');
      expect(harness.surfaces.every((surface) => surface.width === 0 && surface.height === 0)).toBe(true);
    } finally { harness.unregister(); }
  });

  it('can capture media when createImageBitmap is unavailable', async () => {
    const harness = installMediaCapture(1);
    vi.stubGlobal('createImageBitmap', undefined);
    try {
      const capture = captureCurrentCanvasSnapshot('without-image-bitmap', { nodes: [], edges: [] });
      await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
      harness.respond();
      expect(await capture).toMatch(/^data:image\/webp;base64,/);
      expect(harness.requests[0].media[0].pixels).toBeInstanceOf(ArrayBuffer);
      expect(harness.createBitmap).not.toHaveBeenCalled();
    } finally { harness.unregister(); }
  });

  it('reloads tainted images anonymously with two concurrent requests and transfers clean pixels after unmount', async () => {
    const harness = installMediaCapture(4);
    const cors = installCorsReloads();
    for (let index = 0; index < 4; index++) {
      harness.readPixels.mockImplementationOnce(() => { throw new DOMException('tainted original image', 'SecurityError'); });
    }
    try {
      const capture = captureCurrentCanvasSnapshot('tainted-media-reload', { nodes: [], edges: [] });
      expect(cors.images).toHaveLength(2);
      const readsBeforeUnmount = harness.originalReads.mock.calls.length;
      harness.unmount();
      cors.images[0].onload?.(); cors.images[1].onload?.();
      await vi.waitFor(() => expect(cors.images).toHaveLength(4));
      cors.images[2].onload?.(); cors.images[3].onload?.();
      await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
      harness.respond();

      expect(await capture).toMatch(/^data:image\/webp;base64,/);
      expect(harness.originalReads).toHaveBeenCalledTimes(readsBeforeUnmount);
      expect(cors.maxActive()).toBeLessThanOrEqual(2);
      expect(cors.images.map((image) => image.requestedSource)).toEqual(Array.from({ length: 4 }, (_, index) =>
        `https://private.example/image-${index}.png?token=private-token`));
      for (const image of cors.images) {
        expect(image.assignmentOrder.slice(0, 2)).toEqual(['crossOrigin', 'src']);
        expect(image.decode).toHaveBeenCalledOnce();
        expect(image.src).toBe(''); expect(image.onload).toBeNull(); expect(image.onerror).toBeNull();
      }
      expect(harness.requests[0].media).toHaveLength(4);
      expect(harness.transfers[0].every((transfer) => transfer instanceof ArrayBuffer)).toBe(true);
      for (const media of harness.requests[0].media) {
        for (const key of ['source', 'src', 'element', 'currentSrc', 'bitmap']) expect(media).not.toHaveProperty(key);
      }
      expect(harness.surfaces.every((surface) => surface.width === 0 && surface.height === 0)).toBe(true);
    } finally { harness.unregister(); }
  });

  it('keeps the previous snapshot when anonymous image reload fails and reports only a safe stage', async () => {
    const harness = installMediaCapture(1);
    const cors = installCorsReloads();
    harness.readPixels.mockImplementation(() => { throw new DOMException('private media source', 'SecurityError'); });
    try {
      const capture = captureCurrentCanvasSnapshot('pixels-denied', { nodes: [], edges: [] });
      expect(cors.images).toHaveLength(1);
      cors.images[0].onerror?.();
      expect(await capture).toBeNull();
      expect(harness.requests).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith('[项目快照] 捕获未完成', { stage: 'media-origin', reason: 'load-error', count: 1 });
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/private media source|private-token|private\.example/);
      expect(cors.images[0].src).toBe('');
      expect(harness.surfaces.every((surface) => surface.width === 0 && surface.height === 0)).toBe(true);
    } finally { harness.unregister(); }
  });

  it('reloads a legacy Comfy image through a native blob and releases it after copying pixels', async () => {
    const harness = installMediaCapture(1);
    const cors = installCorsReloads();
    const source = 'http://127.0.0.1:8188/view?filename=legacy.png&type=output';
    Object.defineProperty(harness.images[0], 'currentSrc', { value: source });
    harness.readPixels.mockImplementationOnce(() => { throw new DOMException('tainted image', 'SecurityError'); });
    comfyImages.matches.mockReturnValue(true);
    const release = vi.fn();
    comfyImages.acquire.mockResolvedValue({ src: 'blob:native-snapshot', release });
    try {
      const capture = captureCurrentCanvasSnapshot('native-comfy-snapshot', { nodes: [], edges: [] });
      await vi.waitFor(() => expect(cors.images[0].requestedSource).toBe('blob:native-snapshot'));
      expect(comfyImages.acquire).toHaveBeenCalledWith(source, expect.any(AbortSignal));
      cors.images[0].onload?.();
      await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
      expect(release).toHaveBeenCalledOnce();
      expect(cors.images[0].src).toBe('');
      harness.respond();
      expect(await capture).toMatch(/^data:image\/webp;base64,/);
      for (const media of harness.requests[0].media) expect(media).not.toHaveProperty('source');
    } finally { harness.unregister(); }
  });

  it('does not retry a failed native snapshot reload with the original Comfy URL', async () => {
    const harness = installMediaCapture(1);
    const cors = installCorsReloads();
    Object.defineProperty(harness.images[0], 'currentSrc', { value: 'http://127.0.0.1:8188/view?filename=denied.png' });
    harness.readPixels.mockImplementationOnce(() => { throw new DOMException('tainted image', 'SecurityError'); });
    comfyImages.matches.mockReturnValue(true);
    comfyImages.acquire.mockRejectedValue(new Error('HTTP 403'));
    try {
      expect(await captureCurrentCanvasSnapshot('native-comfy-denied', { nodes: [], edges: [] })).toBeNull();
      expect(cors.images[0].requestedSource).toBe('');
      expect(harness.requests).toEqual([]);
    } finally { harness.unregister(); }
  });

  it('cancels pending native snapshot reads at the existing media deadline and releases late blobs', async () => {
    vi.useFakeTimers();
    const harness = installMediaCapture(1);
    const cors = installCorsReloads();
    Object.defineProperty(harness.images[0], 'currentSrc', { value: 'http://127.0.0.1:8188/view?filename=late.png' });
    harness.readPixels.mockImplementationOnce(() => { throw new DOMException('tainted image', 'SecurityError'); });
    comfyImages.matches.mockReturnValue(true);
    const release = vi.fn();
    let resolveRead!: (lease: { src: string; release: () => void }) => void;
    comfyImages.acquire.mockImplementation(() => new Promise((resolve) => { resolveRead = resolve; }));
    try {
      const capture = captureCurrentCanvasSnapshot('native-comfy-late', { nodes: [], edges: [] });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await capture).toBeNull();
      expect(comfyImages.acquire.mock.calls[0][1].aborted).toBe(true);
      resolveRead({ src: 'blob:late-snapshot', release });
      await Promise.resolve();
      expect(release).toHaveBeenCalledOnce();
      expect(cors.images[0].requestedSource).toBe('');
    } finally { harness.unregister(); }
  });

  it('cleans timed-out image reloads and ignores decode completion after the capture deadline', async () => {
    vi.useFakeTimers();
    const harness = installMediaCapture(1);
    const cors = installCorsReloads();
    harness.readPixels.mockImplementationOnce(() => { throw new DOMException('tainted image', 'SecurityError'); });
    let completeDecode!: () => void;
    try {
      const capture = captureCurrentCanvasSnapshot('late-origin-decode', { nodes: [], edges: [] });
      expect(cors.images).toHaveLength(1);
      const image = cors.images[0];
      image.decode.mockImplementation(() => new Promise<void>((resolve) => { completeDecode = resolve; }));
      image.onload?.();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(await capture).toBeNull();
      expect(image.src).toBe(''); expect(image.onload).toBeNull(); expect(image.onerror).toBeNull();
      completeDecode();
      await Promise.resolve();
      expect(harness.readPixels).toHaveBeenCalledOnce();
      expect(harness.requests).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith('[项目快照] 捕获未完成', { stage: 'media-origin', reason: 'TimeoutError', count: 1 });
    } finally { harness.unregister(); }
  });

  it('keeps the previous snapshot if buffer transfer fails and does not expose the original error', async () => {
    const harness = installMediaCapture(1, 'transfer-error');
    try {
      expect(await captureCurrentCanvasSnapshot('buffer-transfer-failed', { nodes: [], edges: [] })).toBeNull();
      expect(console.warn).toHaveBeenCalledWith('[项目快照] 捕获未完成', { stage: 'worker-transfer', reason: 'DataCloneError', count: 1 });
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private transfer details');
      expect(harness.surfaces.every((surface) => surface.width === 0 && surface.height === 0)).toBe(true);
    } finally { harness.unregister(); }
  });

  it('keeps the previous snapshot when worker construction is blocked', async () => {
    const harness = installMediaCapture(1, 'blocked');
    try {
      expect(await captureCurrentCanvasSnapshot('worker-blocked', { nodes: [], edges: [] })).toBeNull();
      expect(harness.surfaces.every((surface) => surface.width === 0 && surface.height === 0)).toBe(true);
    } finally {
      harness.unregister();
    }
  });
});

/**
 * 将轻量画布几何与有界媒体像素交给 Worker，生成受尺寸和体积约束的项目缩略图。
 */
import { getCanvasViewportController } from './canvasViewportService';
import {
  createProjectSnapshotGeometry,
  type ProjectSnapshotGeometryInput,
  type ProjectSnapshotViewport,
} from './projectSnapshotGeometry';
import { isProjectSnapshotDataUrl, PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH } from './projectSnapshotValidation';
import { acquireComfyImageSource, shouldLoadNativeComfyImage, type ComfyImageSourceLease } from './comfyImageSource';
export { isProjectSnapshotDataUrl, PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH } from './projectSnapshotValidation';
import type {
  ProjectSnapshotMedia,
  ProjectSnapshotPalette,
  ProjectSnapshotRect,
  ProjectSnapshotWorkerRequest,
  ProjectSnapshotWorkerResponse,
} from './projectSnapshotWorker';

const SNAPSHOT_WIDTH = 480;
const SNAPSHOT_HEIGHT = 270;
const SNAPSHOT_TIMEOUT_MS = 8_000;
const SNAPSHOT_MEDIA_BUDGET_MS = 1_800;
const SNAPSHOT_MEDIA_MAX_CANDIDATES = 24;
const SNAPSHOT_MEDIA_MAX_COUNT = 12;
const SNAPSHOT_MEDIA_MAX_EDGE = Math.max(SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);

type SnapshotFailureStage = 'context' | 'media-freeze' | 'media-pixels' | 'media-origin' | 'worker-transfer' | 'worker-render' | 'encode-size' | 'capture';
interface SnapshotDiagnostics {
  failure?: { stage: SnapshotFailureStage; reason: string; count: number };
}

function errorName(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  return typeof name === 'string' && ['Error', 'TypeError', 'RangeError', 'SecurityError', 'DataCloneError',
    'InvalidStateError', 'NotSupportedError', 'EncodingError', 'AbortError', 'TimeoutError'].includes(name) ? name : 'UnknownError';
}

function noteFailure(diagnostics: SnapshotDiagnostics, stage: SnapshotFailureStage, reason: string, count = 1): void {
  if (!diagnostics.failure) diagnostics.failure = { stage, reason, count };
  else if (diagnostics.failure.stage === stage && diagnostics.failure.reason === reason) diagnostics.failure.count += count;
}

const activeCaptures = new Map<string, {
  geometry: ProjectSnapshotGeometryInput;
  viewportKey: string;
  promise: Promise<string | null>;
}>();
const pendingWorkerCaptures = new Map<number, {
  resolve: (response: ProjectSnapshotWorkerResponse & { ok: true }) => void;
  reject: (error: Error) => void;
  timer: number;
  diagnostics: SnapshotDiagnostics;
}>();
let snapshotWorker: Worker | null = null;
let nextWorkerCaptureId = 1;
let disposed = false;
const activeImageLoads = new Set<() => void>();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposed = true;
    snapshotWorker?.terminate();
    snapshotWorker = null;
    for (const pending of pendingWorkerCaptures.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error('snapshot service disposed'));
    }
    pendingWorkerCaptures.clear();
    activeCaptures.clear();
    for (const cancel of activeImageLoads) cancel();
    activeImageLoads.clear();
  });
}

export function toProjectSnapshotRect(
  elementRect: Pick<DOMRect, 'bottom' | 'height' | 'left' | 'right' | 'top' | 'width'>,
  rootRect: Pick<DOMRect, 'bottom' | 'height' | 'left' | 'right' | 'top' | 'width'>,
): ProjectSnapshotRect | null {
  if (
    elementRect.right <= rootRect.left
    || elementRect.left >= rootRect.right
    || elementRect.bottom <= rootRect.top
    || elementRect.top >= rootRect.bottom
    || elementRect.width < 1
    || elementRect.height < 1
  ) return null;

  return {
    x: elementRect.left - rootRect.left,
    y: elementRect.top - rootRect.top,
    width: elementRect.width,
    height: elementRect.height,
  };
}

function getSnapshotWorker(): Worker {
  if (disposed) throw new Error('snapshot service disposed');
  if (snapshotWorker) return snapshotWorker;
  const worker = new Worker(new URL('./projectSnapshotWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<ProjectSnapshotWorkerResponse>) => {
    const pending = pendingWorkerCaptures.get(event.data.id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingWorkerCaptures.delete(event.data.id);
    if (event.data.ok) pending.resolve(event.data);
    else {
      noteFailure(pending.diagnostics, 'worker-render', 'worker-response-error');
      pending.reject(new Error('snapshot worker render failed'));
    }
  };
  worker.onerror = () => {
    for (const pending of pendingWorkerCaptures.values()) {
      window.clearTimeout(pending.timer);
      noteFailure(pending.diagnostics, 'worker-render', 'worker-error');
      pending.reject(new Error('snapshot worker failed'));
    }
    pendingWorkerCaptures.clear();
    worker.terminate();
    if (snapshotWorker === worker) snapshotWorker = null;
  };
  snapshotWorker = worker;
  return worker;
}

function renderSnapshotInWorker(
  request: Omit<ProjectSnapshotWorkerRequest, 'id'>,
  diagnostics: SnapshotDiagnostics,
): Promise<ProjectSnapshotWorkerResponse & { ok: true }> {
  let worker: Worker;
  try {
    worker = getSnapshotWorker();
  } catch (error) {
    noteFailure(diagnostics, 'worker-render', errorName(error));
    return Promise.reject(error);
  }
  const id = nextWorkerCaptureId++;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingWorkerCaptures.delete(id);
      noteFailure(diagnostics, 'worker-render', 'TimeoutError');
      reject(new Error('snapshot worker timeout'));
    }, SNAPSHOT_TIMEOUT_MS);
    pendingWorkerCaptures.set(id, { resolve, reject, timer, diagnostics });
    try {
      const message: ProjectSnapshotWorkerRequest = { ...request, id };
      worker.postMessage(message, request.media.map((item) => item.pixels));
    } catch (error) {
      window.clearTimeout(timer);
      pendingWorkerCaptures.delete(id);
      noteFailure(diagnostics, 'worker-transfer', errorName(error));
      reject(new Error('snapshot worker transfer failed'));
    }
  });
}

function arrayBufferToDataUrl(buffer: ArrayBuffer, mimeType: string): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${mimeType};base64,${window.btoa(binary)}`;
}

function getMediaFit({ objectFit }: Pick<CSSStyleDeclaration, 'objectFit'>): ProjectSnapshotMedia['fit'] {
  if (objectFit === 'cover' || objectFit === 'fill') return objectFit;
  return 'contain';
}

interface PreparedSnapshotMedia extends ProjectSnapshotRect {
  element: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;
  fit: ProjectSnapshotMedia['fit'];
  sourceHeight: number;
  sourceWidth: number;
}

interface ReloadableSnapshotImage extends ProjectSnapshotRect {
  fit: ProjectSnapshotMedia['fit'];
  pixelWidth: number;
  pixelHeight: number;
  source: string;
}

type FrozenSnapshotMedia = ProjectSnapshotMedia | ReloadableSnapshotImage;

function getMediaSourceSize(
  element: PreparedSnapshotMedia['element'],
): Pick<PreparedSnapshotMedia, 'sourceHeight' | 'sourceWidth'> | null {
  if (element instanceof HTMLImageElement) {
    return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0
      ? { sourceWidth: element.naturalWidth, sourceHeight: element.naturalHeight }
      : null;
  }
  if (element instanceof HTMLVideoElement) {
    return element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && element.videoWidth > 0
      && element.videoHeight > 0
      ? { sourceWidth: element.videoWidth, sourceHeight: element.videoHeight }
      : null;
  }
  return element.width > 0 && element.height > 0
    ? { sourceWidth: element.width, sourceHeight: element.height }
    : null;
}

export function getProjectSnapshotBitmapSize({
  displayHeight,
  displayWidth,
  fit,
  scaleX,
  scaleY,
  sourceHeight,
  sourceWidth,
}: {
  displayHeight: number;
  displayWidth: number;
  fit: ProjectSnapshotMedia['fit'];
  scaleX: number;
  scaleY: number;
  sourceHeight: number;
  sourceWidth: number;
}): { height: number; width: number } {
  const outputWidth = Math.max(1, displayWidth * scaleX);
  const outputHeight = Math.max(1, displayHeight * scaleY);
  const widthScale = outputWidth / sourceWidth;
  const heightScale = outputHeight / sourceHeight;
  const fitScale = fit === 'contain'
    ? Math.min(widthScale, heightScale)
    : Math.max(widthScale, heightScale);
  const edgeScale = Math.min(
    SNAPSHOT_MEDIA_MAX_EDGE / sourceWidth,
    SNAPSHOT_MEDIA_MAX_EDGE / sourceHeight,
  );
  const resizeScale = Math.min(1, fitScale, edgeScale);
  return {
    width: Math.max(1, Math.round(sourceWidth * resizeScale)),
    height: Math.max(1, Math.round(sourceHeight * resizeScale)),
  };
}

function prepareSnapshotMedia(
  canvasRoot: HTMLElement,
  rootRect: DOMRect,
): PreparedSnapshotMedia[] {
  const elements = canvasRoot.querySelectorAll<HTMLImageElement | HTMLVideoElement | HTMLCanvasElement>(
    '.react-flow__node img, .react-flow__node video, .react-flow__node canvas',
  );
  const prepared: PreparedSnapshotMedia[] = [];
  for (let index = 0; index < Math.min(elements.length, SNAPSHOT_MEDIA_MAX_CANDIDATES); index += 1) {
    if (prepared.length >= SNAPSHOT_MEDIA_MAX_COUNT) break;
    const element = elements[index];
    const rect = toProjectSnapshotRect(element.getBoundingClientRect(), rootRect);
    const sourceSize = getMediaSourceSize(element);
    if (!rect || !sourceSize) continue;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) continue;
    prepared.push({ ...rect, ...sourceSize, element, fit: getMediaFit(style) });
  }
  return prepared;
}

/** 卸载前先读取小尺寸 RGBA；污染图片只留下地址快照，不再读取原节点。 */
function freezeSnapshotMedia(
  prepared: PreparedSnapshotMedia[],
  scaleX: number,
  scaleY: number,
  deadline: number,
  diagnostics: SnapshotDiagnostics,
): FrozenSnapshotMedia[] | null {
  const captured: FrozenSnapshotMedia[] = [];
  let stage: SnapshotFailureStage = 'media-freeze';
  try {
    for (const { element, sourceHeight, sourceWidth, ...media } of prepared) {
      stage = 'media-freeze';
      if (Date.now() >= deadline) {
        noteFailure(diagnostics, stage, 'TimeoutError');
        return null;
      }
      const size = getProjectSnapshotBitmapSize({
        displayHeight: media.height,
        displayWidth: media.width,
        fit: media.fit,
        scaleX,
        scaleY,
        sourceHeight,
        sourceWidth,
      });
      const canvas = document.createElement('canvas');
      try {
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext('2d');
        if (!context) {
          noteFailure(diagnostics, stage, '2d-unavailable');
          return null;
        }
        context.drawImage(element, 0, 0, canvas.width, canvas.height);
        stage = 'media-pixels';
        let image: ImageData;
        try {
          image = context.getImageData(0, 0, canvas.width, canvas.height);
        } catch (error) {
          if (errorName(error) !== 'SecurityError' || !(element instanceof HTMLImageElement)) throw error;
          const source = element.currentSrc || element.src;
          if (!source) throw error;
          captured.push({ x: media.x, y: media.y, width: media.width, height: media.height, fit: media.fit,
            pixelWidth: canvas.width, pixelHeight: canvas.height, source });
          continue;
        }
        // 同步读回不能硬中断，完成后再检查预算，超时仍保留旧预览。
        if (Date.now() >= deadline) {
          noteFailure(diagnostics, stage, 'TimeoutError');
          return null;
        }
        captured.push({ x: media.x, y: media.y, width: media.width, height: media.height, fit: media.fit,
          pixelWidth: image.width, pixelHeight: image.height, pixels: image.data.buffer });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    return captured;
  } catch (error) {
    noteFailure(diagnostics, stage, errorName(error));
    return null;
  }
}

/** 污染图片只重载一次；Comfy 通过原生有界读取，其余沿用匿名 CORS。 */
function reloadSnapshotImage(
  media: ReloadableSnapshotImage,
  deadline: number,
  diagnostics: SnapshotDiagnostics,
): Promise<ProjectSnapshotMedia | null> {
  if (disposed) return Promise.resolve(null);
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    noteFailure(diagnostics, 'media-origin', 'TimeoutError');
    return Promise.resolve(null);
  }
  let image: HTMLImageElement;
  try { image = new Image(); } catch (error) {
    noteFailure(diagnostics, 'media-origin', errorName(error));
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const request = new AbortController();
    let lease: ComfyImageSourceLease | undefined;
    let finished = false;
    const cancel = (): void => finish(null);
    const finish = (result: ProjectSnapshotMedia | null, reason?: string): void => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      image.onload = image.onerror = null;
      image.removeAttribute('src');
      request.abort();
      lease?.release();
      activeImageLoads.delete(cancel);
      if (reason) noteFailure(diagnostics, 'media-origin', reason);
      resolve(result);
    };
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => {
      void (async () => {
        try {
          if (typeof image.decode === 'function') await image.decode();
          if (finished) return;
          if (disposed) { finish(null); return; }
          if (Date.now() >= deadline) { finish(null, 'TimeoutError'); return; }
          const canvas = document.createElement('canvas');
          try {
            canvas.width = media.pixelWidth;
            canvas.height = media.pixelHeight;
            const context = canvas.getContext('2d');
            if (!context) { finish(null, '2d-unavailable'); return; }
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
            if (Date.now() >= deadline) { finish(null, 'TimeoutError'); return; }
            finish({ x: media.x, y: media.y, width: media.width, height: media.height, fit: media.fit,
              pixelWidth: pixels.width, pixelHeight: pixels.height, pixels: pixels.data.buffer });
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        } catch (error) { finish(null, errorName(error)); }
      })();
    };
    image.onerror = () => finish(null, 'load-error');
    const timer = window.setTimeout(() => finish(null, 'TimeoutError'), remaining);
    activeImageLoads.add(cancel);
    if (shouldLoadNativeComfyImage(media.source)) {
      void acquireComfyImageSource(media.source, request.signal).then((result) => {
        if (finished) { result.release(); return; }
        lease = result;
        if (!result.src.startsWith('blob:')) { finish(null, 'native-source-unavailable'); return; }
        try { image.src = result.src; } catch (error) { finish(null, errorName(error)); }
      }, (error) => finish(null, errorName(error)));
    } else {
      try { image.src = media.source; } catch (error) { finish(null, errorName(error)); }
    }
  });
}

async function resolveSnapshotMedia(
  frozen: FrozenSnapshotMedia[],
  deadline: number,
  diagnostics: SnapshotDiagnostics,
): Promise<ProjectSnapshotMedia[] | null> {
  const results = frozen.map((media) => 'source' in media ? null : media);
  const pending = frozen.flatMap((media, index) => 'source' in media ? [{ media, index }] : []);
  let nextIndex = 0;
  let failed = false;
  const loadNext = async () => {
    while (!disposed && !failed && nextIndex < pending.length) {
      const { media, index } = pending[nextIndex++];
      const result = await reloadSnapshotImage(media, deadline, diagnostics);
      if (!result) { failed = true; return; }
      results[index] = result;
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, pending.length) }, () => loadNext()));
  return failed || disposed ? null : results.filter((media): media is ProjectSnapshotMedia => media !== null);
}

function supportsWorkerSnapshot(): boolean {
  return typeof Worker !== 'undefined'
    && typeof OffscreenCanvas !== 'undefined';
}

async function captureVisibleCanvasInWorker(
  canvasRoot: HTMLElement,
  rootRect: DOMRect,
  backgroundColor: string,
  palette: ProjectSnapshotPalette,
  input: ProjectSnapshotGeometryInput,
  viewport: ProjectSnapshotViewport,
  diagnostics: SnapshotDiagnostics,
): Promise<string | null> {
  const geometry = createProjectSnapshotGeometry(input);
  const preparedMedia = prepareSnapshotMedia(canvasRoot, rootRect);
  const scaleX = SNAPSHOT_WIDTH / rootRect.width;
  const scaleY = SNAPSHOT_HEIGHT / rootRect.height;
  const deadline = Date.now() + SNAPSHOT_MEDIA_BUDGET_MS;
  const frozen = freezeSnapshotMedia(preparedMedia, scaleX, scaleY, deadline, diagnostics);
  if (!frozen) return null;
  const media = await resolveSnapshotMedia(frozen, deadline, diagnostics);
  if (!media) return null;
  const response = await renderSnapshotInWorker({
    width: SNAPSHOT_WIDTH,
    height: SNAPSHOT_HEIGHT,
    sourceWidth: rootRect.width,
    sourceHeight: rootRect.height,
    backgroundColor,
    palette,
    geometry,
    viewport,
    media,
  }, diagnostics);
  const snapshot = arrayBufferToDataUrl(response.buffer, response.mimeType);
  const snapshotLength = snapshot.length;
  if (isProjectSnapshotDataUrl(snapshot)) return snapshot;
  noteFailure(diagnostics, 'encode-size', snapshotLength > PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH ? 'oversize' : 'invalid-data-url');
  return null;
}

interface CanvasCaptureContext {
  canvasRoot: HTMLElement;
  rect: DOMRect;
  viewport: ProjectSnapshotViewport;
}

function readCanvasCaptureContext(): CanvasCaptureContext | null {
  if (typeof document === 'undefined' || !supportsWorkerSnapshot()) return null;
  const canvasRoot = document.querySelector<HTMLElement>('.react-flow');
  if (!canvasRoot) return null;

  const rect = canvasRoot.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const currentViewport = getCanvasViewportController()?.getSnapshot();
  if (!currentViewport || ![currentViewport.x, currentViewport.y, currentViewport.zoom].every(Number.isFinite)
    || currentViewport.zoom <= 0) return null;
  const viewport = { x: currentViewport.x, y: currentViewport.y, zoom: currentViewport.zoom };
  return { canvasRoot, rect, viewport };
}

async function captureVisibleCanvas(input: ProjectSnapshotGeometryInput, context: CanvasCaptureContext, diagnostics: SnapshotDiagnostics): Promise<string | null> {
  const { canvasRoot, rect, viewport } = context;
  const rootStyles = getComputedStyle(document.documentElement);
  const backgroundColor = rootStyles.getPropertyValue('--theme-bg').trim()
    || getComputedStyle(canvasRoot).backgroundColor;
  const text = rootStyles.getPropertyValue('--theme-text').trim() || rootStyles.color;
  const textSecondary = rootStyles.getPropertyValue('--theme-text-secondary').trim() || text;
  const palette: ProjectSnapshotPalette = {
    card: rootStyles.getPropertyValue('--theme-card').trim() || backgroundColor,
    border: rootStyles.getPropertyValue('--theme-border').trim() || textSecondary,
    text,
    textSecondary,
    muted: rootStyles.getPropertyValue('--theme-text-muted').trim() || textSecondary,
    hover: rootStyles.getPropertyValue('--theme-hover').trim() || backgroundColor,
  };

  return captureVisibleCanvasInWorker(canvasRoot, rect, backgroundColor, palette, input, viewport, diagnostics);
}

/** 捕获当前可见画布；默认复用在途采集，离开时可以强制重新捕获。 */
export function captureCurrentCanvasSnapshot(
  captureKey = 'current-canvas',
  geometry?: ProjectSnapshotGeometryInput,
  options: { fresh?: boolean } = {},
): Promise<string | null> {
  // Missing geometry keeps the previous thumbnail; never clone the live DOM on return.
  if (!geometry || disposed) return Promise.resolve(null);
  const diagnostics: SnapshotDiagnostics = {};
  let context: CanvasCaptureContext | null = null;
  try {
    context = readCanvasCaptureContext();
  } catch (error) {
    noteFailure(diagnostics, 'context', errorName(error));
  }
  if (!context) {
    noteFailure(diagnostics, 'context', 'unavailable');
    console.warn('[项目快照] 捕获未完成', diagnostics.failure);
    return Promise.resolve(null);
  }
  const viewportKey = `${context.viewport.x},${context.viewport.y},${context.viewport.zoom},${context.rect.width},${context.rect.height}`;
  const activeCapture = activeCaptures.get(captureKey);
  if (!options.fresh && activeCapture?.geometry.nodes === geometry.nodes && activeCapture.geometry.edges === geometry.edges
    && activeCapture.viewportKey === viewportKey) return activeCapture.promise;

  const capture = captureVisibleCanvas(geometry, context, diagnostics)
    .catch((error) => {
      noteFailure(diagnostics, 'capture', errorName(error));
      return null;
    })
    .finally(() => {
      if (activeCaptures.get(captureKey)?.promise === capture) activeCaptures.delete(captureKey);
      if (!disposed && diagnostics.failure) console.warn('[项目快照] 捕获未完成', diagnostics.failure);
    });
  activeCaptures.set(captureKey, { geometry, viewportKey, promise: capture });
  return capture;
}

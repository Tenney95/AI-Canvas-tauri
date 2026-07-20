import { toCanvas } from 'html-to-image';
import type {
  ProjectSnapshotEdge,
  ProjectSnapshotMedia,
  ProjectSnapshotNode,
  ProjectSnapshotRect,
  ProjectSnapshotWorkerRequest,
  ProjectSnapshotWorkerResponse,
} from './projectSnapshotWorker';

const SNAPSHOT_WIDTH = 480;
const SNAPSHOT_HEIGHT = 270;
const SNAPSHOT_QUALITIES = [0.7, 0.5, 0.35] as const;
const SNAPSHOT_TIMEOUT_MS = 8_000;
const SNAPSHOT_MEDIA_TIMEOUT_MS = 800;
const SNAPSHOT_MEDIA_BUDGET_MS = 1_800;
const SNAPSHOT_MEDIA_CONCURRENCY = 2;
const SNAPSHOT_MEDIA_MAX_EDGE = Math.max(SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);
export const PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH = 350_000;
const TRANSPARENT_IMAGE_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

const EXCLUDED_CLASS_NAMES = new Set([
  'react-flow__controls',
  'react-flow__minimap',
  'react-flow__panel',
  'react-flow__attribution',
  'react-flow__selection',
  'react-flow__nodesselection-rect',
  'react-flow__resize-control',
  'gooey-btn-wrapper',
]);

// html-to-image 会直接读取这些元素的当前帧；本地媒体或跨域内容可能污染 Canvas，
// 导致整个项目快照失败。保留节点外壳，只跳过不稳定的媒体表面。
const EXCLUDED_TAG_NAMES = new Set(['CANVAS', 'IFRAME', 'VIDEO']);

const activeCaptures = new Map<string, Promise<string | null>>();
const pendingWorkerCaptures = new Map<number, {
  resolve: (response: ProjectSnapshotWorkerResponse & { ok: true }) => void;
  reject: (error: Error) => void;
  timer: number;
}>();
let snapshotWorker: Worker | null = null;
let nextWorkerCaptureId = 1;

export function shouldIncludeProjectSnapshotNode(node: HTMLElement): boolean {
  if (EXCLUDED_TAG_NAMES.has(node.tagName?.toUpperCase())) return false;
  for (const className of EXCLUDED_CLASS_NAMES) {
    if (node.classList?.contains(className)) return false;
  }
  return true;
}

export function isProjectSnapshotDataUrl(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('data:image/')
    && value.length <= PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH;
}

export function encodeProjectSnapshot(
  canvas: Pick<HTMLCanvasElement, 'toDataURL'>,
): string | null {
  for (const quality of SNAPSHOT_QUALITIES) {
    const snapshot = canvas.toDataURL('image/webp', quality);
    if (isProjectSnapshotDataUrl(snapshot)) return snapshot;
  }
  return null;
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('capture timeout')), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function getSnapshotWorker(): Worker {
  if (snapshotWorker) return snapshotWorker;
  const worker = new Worker(new URL('./projectSnapshotWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<ProjectSnapshotWorkerResponse>) => {
    const pending = pendingWorkerCaptures.get(event.data.id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingWorkerCaptures.delete(event.data.id);
    if (event.data.ok) pending.resolve(event.data);
    else pending.reject(new Error(event.data.error));
  };
  worker.onerror = () => {
    for (const pending of pendingWorkerCaptures.values()) {
      window.clearTimeout(pending.timer);
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
): Promise<ProjectSnapshotWorkerResponse & { ok: true }> {
  const worker = getSnapshotWorker();
  const id = nextWorkerCaptureId++;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingWorkerCaptures.delete(id);
      reject(new Error('snapshot worker timeout'));
    }, SNAPSHOT_TIMEOUT_MS);
    pendingWorkerCaptures.set(id, { resolve, reject, timer });
    try {
      const message: ProjectSnapshotWorkerRequest = { ...request, id };
      worker.postMessage(message, request.media.map((item) => item.bitmap));
    } catch (error) {
      window.clearTimeout(timer);
      pendingWorkerCaptures.delete(id);
      for (const media of request.media) media.bitmap.close();
      reject(error instanceof Error ? error : new Error(String(error)));
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

function collectSnapshotNodes(canvasRoot: HTMLElement, rootRect: DOMRect): ProjectSnapshotNode[] {
  return Array.from(canvasRoot.querySelectorAll<HTMLElement>('.react-flow__node')).flatMap((node) => {
    const rect = toProjectSnapshotRect(node.getBoundingClientRect(), rootRect);
    if (!rect) return [];
    const labelElement = node.querySelector<HTMLElement>('.node-label-text');
    const labelRoot = node.querySelector<HTMLElement>('.node-label');
    return [{
      ...rect,
      kind: labelRoot?.dataset.labelKind ?? 'default',
      label: labelElement?.textContent?.trim().slice(0, 48) ?? '',
    }];
  });
}

function collectSnapshotEdges(canvasRoot: HTMLElement, rootRect: DOMRect): ProjectSnapshotEdge[] {
  return Array.from(canvasRoot.querySelectorAll<SVGPathElement>('.react-flow__edge-path')).flatMap((path) => {
    try {
      const length = path.getTotalLength();
      const matrix = path.getScreenCTM();
      if (!matrix || length < 1) return [];
      const sampleCount = Math.min(32, Math.max(2, Math.ceil(length / 80)));
      const points = Array.from({ length: sampleCount + 1 }, (_, index) => {
        const point = path.getPointAtLength((length * index) / sampleCount);
        return {
          x: (point.x * matrix.a) + (point.y * matrix.c) + matrix.e - rootRect.left,
          y: (point.x * matrix.b) + (point.y * matrix.d) + matrix.f - rootRect.top,
        };
      });
      return [{ points }];
    } catch {
      return [];
    }
  });
}

function getMediaFit(element: Element): ProjectSnapshotMedia['fit'] {
  const objectFit = getComputedStyle(element).objectFit;
  if (objectFit === 'cover' || objectFit === 'fill') return objectFit;
  return 'contain';
}

interface PreparedSnapshotMedia extends ProjectSnapshotRect {
  element: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;
  fit: ProjectSnapshotMedia['fit'];
  sourceHeight: number;
  sourceWidth: number;
}

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
  const elements = Array.from(canvasRoot.querySelectorAll<HTMLImageElement | HTMLVideoElement | HTMLCanvasElement>(
    '.react-flow__node img, .react-flow__node video, .react-flow__node canvas',
  ));
  return elements.flatMap((element) => {
    const rect = toProjectSnapshotRect(element.getBoundingClientRect(), rootRect);
    const sourceSize = getMediaSourceSize(element);
    if (!rect || !sourceSize) return [];
    return [{ ...rect, ...sourceSize, element, fit: getMediaFit(element) }];
  });
}

function captureSnapshotMediaBitmap(
  prepared: PreparedSnapshotMedia,
  scaleX: number,
  scaleY: number,
  timeoutMs: number,
): Promise<ProjectSnapshotMedia | null> {
  const {
    element,
    sourceHeight,
    sourceWidth,
    ...media
  } = prepared;
  const size = getProjectSnapshotBitmapSize({
    displayHeight: media.height,
    displayWidth: media.width,
    fit: media.fit,
    scaleX,
    scaleY,
    sourceHeight,
    sourceWidth,
  });

  return new Promise((resolve) => {
    let finished = false;
    const timer = window.setTimeout(() => {
      finished = true;
      resolve(null);
    }, timeoutMs);

    let bitmapPromise: Promise<ImageBitmap>;
    try {
      bitmapPromise = createImageBitmap(element, {
        resizeHeight: size.height,
        resizeQuality: 'low',
        resizeWidth: size.width,
      });
    } catch {
      window.clearTimeout(timer);
      resolve(null);
      return;
    }

    void bitmapPromise.then(
      (bitmap) => {
        if (finished) {
          bitmap.close();
          return;
        }
        finished = true;
        window.clearTimeout(timer);
        resolve({ ...media, bitmap });
      },
      () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

async function createSnapshotMediaBitmaps(
  prepared: PreparedSnapshotMedia[],
  scaleX: number,
  scaleY: number,
): Promise<ProjectSnapshotMedia[]> {
  const captured: Array<ProjectSnapshotMedia | null> = new Array(prepared.length).fill(null);
  const deadline = Date.now() + SNAPSHOT_MEDIA_BUDGET_MS;
  let nextIndex = 0;

  const captureNext = async (): Promise<void> => {
    while (nextIndex < prepared.length) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      const index = nextIndex;
      nextIndex += 1;
      captured[index] = await captureSnapshotMediaBitmap(
        prepared[index],
        scaleX,
        scaleY,
        Math.max(1, Math.min(SNAPSHOT_MEDIA_TIMEOUT_MS, remainingMs)),
      );
    }
  };

  const workers = Math.min(SNAPSHOT_MEDIA_CONCURRENCY, prepared.length);
  await Promise.all(Array.from({ length: workers }, () => captureNext()));
  return captured.filter((item): item is ProjectSnapshotMedia => item !== null);
}

function supportsWorkerSnapshot(): boolean {
  return typeof Worker !== 'undefined'
    && typeof OffscreenCanvas !== 'undefined'
    && typeof createImageBitmap === 'function';
}

async function captureVisibleCanvasInWorker(
  canvasRoot: HTMLElement,
  rootRect: DOMRect,
  backgroundColor: string,
): Promise<string | null> {
  const nodes = collectSnapshotNodes(canvasRoot, rootRect);
  const edges = collectSnapshotEdges(canvasRoot, rootRect);
  const preparedMedia = prepareSnapshotMedia(canvasRoot, rootRect);
  const scaleX = SNAPSHOT_WIDTH / rootRect.width;
  const scaleY = SNAPSHOT_HEIGHT / rootRect.height;
  // Start bitmap extraction before project switching can unmount the old canvas.
  const media = await createSnapshotMediaBitmaps(preparedMedia, scaleX, scaleY);
  const response = await renderSnapshotInWorker({
    width: SNAPSHOT_WIDTH,
    height: SNAPSHOT_HEIGHT,
    sourceWidth: rootRect.width,
    sourceHeight: rootRect.height,
    backgroundColor,
    nodes,
    edges,
    media,
  });
  const snapshot = arrayBufferToDataUrl(response.buffer, response.mimeType);
  return isProjectSnapshotDataUrl(snapshot) ? snapshot : null;
}

async function captureVisibleCanvasFallback(
  canvasRoot: HTMLElement,
  rootRect: DOMRect,
  backgroundColor: string,
): Promise<string | null> {
  const canvas = await withTimeout(toCanvas(canvasRoot, {
    width: Math.round(rootRect.width),
    height: Math.round(rootRect.height),
    canvasWidth: SNAPSHOT_WIDTH,
    canvasHeight: SNAPSHOT_HEIGHT,
    backgroundColor,
    cacheBust: false,
    filter: shouldIncludeProjectSnapshotNode,
    imagePlaceholder: TRANSPARENT_IMAGE_PLACEHOLDER,
    pixelRatio: 1,
    skipFonts: true,
  }), SNAPSHOT_TIMEOUT_MS);
  return encodeProjectSnapshot(canvas);
}

async function captureVisibleCanvas(): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  const canvasRoot = document.querySelector<HTMLElement>('.react-flow');
  if (!canvasRoot) return null;

  const rect = canvasRoot.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;

  const rootStyles = getComputedStyle(document.documentElement);
  const backgroundColor = rootStyles.getPropertyValue('--theme-bg').trim()
    || getComputedStyle(canvasRoot).backgroundColor;

  if (supportsWorkerSnapshot()) {
    try {
      return await captureVisibleCanvasInWorker(canvasRoot, rect, backgroundColor);
    } catch (error) {
      console.warn('[项目快照] Worker 捕获失败，使用兼容模式:', error);
    }
  }
  return captureVisibleCanvasFallback(canvasRoot, rect, backgroundColor);
}

/** 捕获当前可见 React Flow 画布；同一项目的并发调用复用同一次编码。 */
export function captureCurrentCanvasSnapshot(captureKey = 'current-canvas'): Promise<string | null> {
  const activeCapture = activeCaptures.get(captureKey);
  if (activeCapture) return activeCapture;

  const capture = captureVisibleCanvas()
    .catch((error) => {
      console.warn('[项目快照] 捕获失败:', error instanceof Error ? error.message : error);
      return null;
    })
    .finally(() => {
      activeCaptures.delete(captureKey);
    });
  activeCaptures.set(captureKey, capture);
  return capture;
}

/** MCP 专用瞬时窗口和截图运行时；只操作 AI Canvas 自身固定窗口。 */
import { toCanvas } from 'html-to-image';
import {
  getMcpCaptureEncodingSteps,
  MCP_CAPTURE_MAX_BYTES,
  MCP_CAPTURE_MIME,
  McpCaptureLimitError,
  type McpCaptureWorkerRequest,
  type McpCaptureWorkerResponse,
} from './mcpCaptureEncoding';

export const APP_WINDOW_LABELS = [
  'main', 'chat-assistant', 'asset-search', 'video-editor', 'director-desk', 'comfyui',
] as const;
export type AppWindowLabel = typeof APP_WINDOW_LABELS[number];
export type CapturableWindowLabel = Extract<
  AppWindowLabel,
  'main' | 'chat-assistant' | 'asset-search' | 'video-editor'
>;

export interface AppWindowState {
  label: AppWindowLabel;
  position?: { x: number; y: number };
  innerSize?: { width: number; height: number };
  outerSize?: { width: number; height: number };
  scaleFactor?: number;
  focused: boolean;
  visible: boolean;
  minimized: boolean;
  maximized: boolean;
  fullscreen: boolean;
}

export interface WindowCaptureResult {
  data: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
}

interface CaptureOptions {
  target: CapturableWindowLabel;
  maxWidth: number;
  quality: number;
  redactSensitive: boolean;
}

const CAPTURE_REQUEST_EVENT = 'mcp-ui-capture-request';
const CAPTURE_RESPONSE_EVENT = 'mcp-ui-capture-response';
const CAPTURE_TIMEOUT_MS = 12_000;
const ENCODING_TIMEOUT_MS = 8_000;
const MAX_PENDING_CAPTURES = 2;
const MAX_REMOTE_CAPTURES = 4;
const CAPTURABLE_LABELS = new Set<string>(['main', 'chat-assistant', 'asset-search', 'video-editor']);
const documentCaptures = new Map<string, Promise<WindowCaptureResult>>();
const remoteCaptures = new Map<string, Promise<WindowCaptureResult>>();
const responderRequests = new Set<string>();
let documentCaptureTail: Promise<void> = Promise.resolve();

function captureKey(options: Omit<CaptureOptions, 'target'>): string {
  return `${options.maxWidth}:${options.quality}:${options.redactSensitive}`;
}

function validateCaptureOptions(options: CaptureOptions): void {
  if (!options || !CAPTURABLE_LABELS.has(options.target)) throw new Error('不支持截取该应用窗口');
  if (!Number.isInteger(options.maxWidth) || options.maxWidth < 320 || options.maxWidth > 1920
    || !Number.isFinite(options.quality) || options.quality < 0.4 || options.quality > 0.92
    || typeof options.redactSensitive !== 'boolean') throw new Error('窗口截图参数无效');
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function isSensitiveElement(node: Node): boolean {
  // html-to-image 也会把 Text 节点交给 filter；只有 Element 才有 closest。
  if (!(node instanceof Element)) return false;
  if (node.closest('[data-mcp-sensitive="true"]')) return true;
  if (!(node instanceof HTMLInputElement)) return false;
  const marker = `${node.name} ${node.id} ${node.autocomplete}`.toLowerCase();
  return node.type === 'password' || /(api.?key|token|secret|password|authorization)/.test(marker);
}

function captureBufferResult(buffer: ArrayBuffer, width: number, height: number): WindowCaptureResult {
  if (buffer.byteLength > MCP_CAPTURE_MAX_BYTES) throw new McpCaptureLimitError();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return { data: btoa(binary), mimeType: MCP_CAPTURE_MIME, width, height };
}

async function encodeInWorker(canvas: HTMLCanvasElement, quality: number): Promise<WindowCaptureResult> {
  const bitmap = await createImageBitmap(canvas);
  let worker: Worker | undefined;
  let timer: number | undefined;
  try {
    worker = new Worker(new URL('./mcpCaptureWorker.ts', import.meta.url), { type: 'module' });
    const currentWorker = worker;
    const response = await new Promise<McpCaptureWorkerResponse & { ok: true }>((resolve, reject) => {
      timer = window.setTimeout(() => reject(new Error('截图编码超时')), ENCODING_TIMEOUT_MS);
      currentWorker.onmessage = (event: MessageEvent<McpCaptureWorkerResponse>) => {
        if (event.data.ok) resolve(event.data);
        else reject(event.data.oversized ? new McpCaptureLimitError() : new Error(event.data.error));
      };
      currentWorker.onerror = () => reject(new Error('截图编码 Worker 不可用'));
      currentWorker.onmessageerror = () => reject(new Error('截图编码结果无效'));
      const request: McpCaptureWorkerRequest = { bitmap, quality };
      currentWorker.postMessage(request, [bitmap]);
    });
    return captureBufferResult(response.buffer, response.width, response.height);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    worker?.terminate();
    bitmap.close();
  }
}

async function encodeOnMainThread(source: HTMLCanvasElement, quality: number): Promise<WindowCaptureResult> {
  const canvas = document.createElement('canvas');
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('截图画布不可用');
    for (const step of getMcpCaptureEncodingSteps(source.width, source.height, quality)) {
      canvas.width = step.width;
      canvas.height = step.height;
      context.drawImage(source, 0, 0, step.width, step.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => result ? resolve(result) : reject(new Error('截图编码失败')), MCP_CAPTURE_MIME, step.quality);
      });
      if (blob.type !== MCP_CAPTURE_MIME) throw new Error('截图 JPEG 编码不可用');
      if (blob.size <= MCP_CAPTURE_MAX_BYTES) {
        return captureBufferResult(await blob.arrayBuffer(), step.width, step.height);
      }
    }
    throw new McpCaptureLimitError();
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function renderCurrentDocument(options: Omit<CaptureOptions, 'target'>): Promise<WindowCaptureResult> {
  // 弹窗通过 Portal 挂在 body 上，只截 #root 会漏掉它们。
  const root = document.body;
  const sourceWidth = Math.max(1, root.clientWidth || window.innerWidth);
  const sourceHeight = Math.max(1, root.clientHeight || window.innerHeight);
  const width = Math.min(sourceWidth, options.maxWidth);
  const height = Math.max(1, Math.round(sourceHeight * (width / sourceWidth)));
  // DOM 只能在本窗口采集一次；压缩重试及兼容降级均复用这张已过滤画布。
  const canvas = await toCanvas(root, {
    backgroundColor: getComputedStyle(document.documentElement).backgroundColor || '#0a0a0f',
    canvasWidth: width,
    canvasHeight: height,
    pixelRatio: 1,
    cacheBust: false,
    filter: options.redactSensitive ? (node) => !isSensitiveElement(node) : undefined,
  });
  try {
    if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
      && typeof createImageBitmap === 'function') {
      try {
        return await encodeInWorker(canvas, options.quality);
      } catch (error) {
        if (error instanceof McpCaptureLimitError) throw error;
        // Worker 已终止后再降级；不重新克隆 DOM，也不改变本次脱敏选项。
      }
    }
    return await encodeOnMainThread(canvas, options.quality);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function captureCurrentDocument(options: Omit<CaptureOptions, 'target'>): Promise<WindowCaptureResult> {
  const key = captureKey(options);
  const existing = documentCaptures.get(key);
  if (existing) return existing;
  if (documentCaptures.size >= MAX_PENDING_CAPTURES) return Promise.reject(new Error('窗口截图繁忙，请稍后重试'));
  // 客户端超时不代表 html-to-image 已取消；只在底层采集及编码真正结束时释放名额。
  const capture = documentCaptureTail.then(() => renderCurrentDocument(options))
    .finally(() => documentCaptures.delete(key));
  documentCaptures.set(key, capture);
  // 队尾只保留完成信号，不长期持有上一次截图的 Base64。
  documentCaptureTail = capture.then(() => {}, () => {});
  return capture;
}

async function readWindowState(handle: import('@tauri-apps/api/window').Window): Promise<AppWindowState> {
  const [position, innerSize, outerSize, scaleFactor, focused, visible, minimized, maximized, fullscreen] = await Promise.all([
    handle.outerPosition(), handle.innerSize(), handle.outerSize(), handle.scaleFactor(),
    handle.isFocused(), handle.isVisible(), handle.isMinimized(), handle.isMaximized(), handle.isFullscreen(),
  ]);
  return {
    label: handle.label as AppWindowLabel,
    position: { x: position.x, y: position.y },
    innerSize: { width: innerSize.width, height: innerSize.height },
    outerSize: { width: outerSize.width, height: outerSize.height },
    scaleFactor,
    focused,
    visible,
    minimized,
    maximized,
    fullscreen,
  };
}

export async function listAppWindows(): Promise<AppWindowState[]> {
  if (!isTauriRuntime()) {
    return [{
      label: 'main',
      innerSize: { width: window.innerWidth, height: window.innerHeight },
      outerSize: { width: window.outerWidth, height: window.outerHeight },
      scaleFactor: window.devicePixelRatio,
      focused: document.hasFocus(),
      visible: document.visibilityState === 'visible',
      minimized: false,
      maximized: false,
      fullscreen: !!document.fullscreenElement,
    }];
  }
  const { getAllWindows } = await import('@tauri-apps/api/window');
  const allowed = new Set<string>(APP_WINDOW_LABELS);
  return Promise.all((await getAllWindows()).filter((item) => allowed.has(item.label)).map(readWindowState));
}

export async function getAppWindowState(label: AppWindowLabel): Promise<AppWindowState> {
  const state = (await listAppWindows()).find((item) => item.label === label);
  if (!state) throw new Error(`应用窗口未打开: ${label}`);
  return state;
}

async function getWindowHandle(label: AppWindowLabel) {
  if (!isTauriRuntime()) throw new Error('当前不是 Tauri 桌面运行环境');
  const { Window } = await import('@tauri-apps/api/window');
  const handle = await Window.getByLabel(label);
  if (!handle) throw new Error(`应用窗口未打开: ${label}`);
  return handle;
}

export async function focusAppWindow(label: AppWindowLabel): Promise<void> {
  const handle = await getWindowHandle(label);
  if (await handle.isMinimized()) await handle.unminimize();
  await handle.show();
  await handle.setFocus();
}

export async function setAppWindowBounds(
  label: AppWindowLabel,
  bounds: { x?: number; y?: number; width?: number; height?: number },
): Promise<void> {
  const handle = await getWindowHandle(label);
  const { PhysicalPosition, PhysicalSize } = await import('@tauri-apps/api/dpi');
  if (bounds.x !== undefined && bounds.y !== undefined) {
    await handle.setPosition(new PhysicalPosition(bounds.x, bounds.y));
  }
  if (bounds.width !== undefined && bounds.height !== undefined) {
    await handle.setSize(new PhysicalSize(bounds.width, bounds.height));
  }
}

export async function captureAppWindow(options: CaptureOptions): Promise<WindowCaptureResult> {
  validateCaptureOptions(options);
  options = { ...options };
  if (!isTauriRuntime()) return captureCurrentDocument(options);
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  if (getCurrentWindow().label === options.target) return captureCurrentDocument(options);

  const key = `${options.target}:${captureKey(options)}`;
  const existing = remoteCaptures.get(key);
  if (existing) return existing;
  if (remoteCaptures.size >= MAX_REMOTE_CAPTURES) throw new Error('窗口截图繁忙，请稍后重试');
  const capture = requestWindowCapture(options).finally(() => remoteCaptures.delete(key));
  remoteCaptures.set(key, capture);
  return capture;
}

async function requestWindowCapture(options: CaptureOptions): Promise<WindowCaptureResult> {
  const { emitTo, listen } = await import('@tauri-apps/api/event');
  const requestId = `capture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<WindowCaptureResult>((resolve, reject) => {
    let unlisten: (() => void) | undefined;
    let settled = false;
    const timer = window.setTimeout(() => {
      settled = true;
      unlisten?.();
      reject(new Error(`窗口截图响应超时: ${options.target}`));
    }, CAPTURE_TIMEOUT_MS);
    void listen<{ requestId: string; result?: WindowCaptureResult; error?: string }>(CAPTURE_RESPONSE_EVENT, (event) => {
      if (settled || event.payload.requestId !== requestId) return;
      settled = true;
      window.clearTimeout(timer);
      unlisten?.();
      if (event.payload.result) resolve(event.payload.result);
      else reject(new Error(event.payload.error || '窗口截图失败'));
    }).then((dispose) => {
      // 监听安装可能比客户端期限更晚完成，不能漏清理或在超时后再启动采集。
      if (settled) { dispose(); return; }
      unlisten = dispose;
      return emitTo(options.target, CAPTURE_REQUEST_EVENT, { requestId, options });
    }).catch((error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unlisten?.();
      reject(error);
    });
  });
}

export async function installMcpScreenshotResponder(): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const { emitTo, listen } = await import('@tauri-apps/api/event');
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const currentLabel = getCurrentWindow().label;
  if (!CAPTURABLE_LABELS.has(currentLabel)) return () => {};
  return listen<{ requestId: string; options: CaptureOptions }>(CAPTURE_REQUEST_EVENT, (event) => {
    const { requestId, options } = event.payload;
    if (typeof requestId !== 'string' || requestId.length > 128 || responderRequests.has(requestId)) return;
    if (options?.target !== currentLabel) return;
    try {
      validateCaptureOptions(options);
      if (responderRequests.size >= MAX_REMOTE_CAPTURES) throw new Error('窗口截图繁忙，请稍后重试');
    } catch (error) {
      void emitTo('main', CAPTURE_RESPONSE_EVENT, { requestId, error: error instanceof Error ? error.message : '窗口截图参数无效' }).catch(() => {});
      return;
    }
    // 客户端连续超时重试，也只保留有限个等待者，不为仍未结束的 DOM 采集增加监听链。
    responderRequests.add(requestId);
    void captureCurrentDocument(options)
      .then((result) => emitTo('main', CAPTURE_RESPONSE_EVENT, { requestId, result }))
      .catch((error) => emitTo('main', CAPTURE_RESPONSE_EVENT, {
        requestId,
        error: error instanceof Error ? error.message : '窗口截图失败',
      }))
      .catch(() => {})
      .finally(() => responderRequests.delete(requestId));
  });
}

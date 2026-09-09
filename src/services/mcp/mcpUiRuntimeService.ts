/** MCP 专用瞬时窗口和截图运行时；只操作 AI Canvas 自身固定窗口。 */
import { toJpeg } from 'html-to-image';

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
const MAX_IMAGE_BASE64_CHARS = 2_600_000;

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

async function captureCurrentDocument(options: Omit<CaptureOptions, 'target'>): Promise<WindowCaptureResult> {
  const root = document.getElementById('root') ?? document.body;
  const sourceWidth = Math.max(1, root.clientWidth || window.innerWidth);
  const sourceHeight = Math.max(1, root.clientHeight || window.innerHeight);
  let width = Math.min(sourceWidth, options.maxWidth);
  let height = Math.max(1, Math.round(sourceHeight * (width / sourceWidth)));
  let quality = options.quality;
  let dataUrl = '';

  for (let attempt = 0; attempt < 4; attempt += 1) {
    dataUrl = await toJpeg(root, {
      backgroundColor: getComputedStyle(document.documentElement).backgroundColor || '#0a0a0f',
      canvasWidth: width,
      canvasHeight: height,
      pixelRatio: 1,
      quality,
      cacheBust: false,
      filter: options.redactSensitive ? (node) => !isSensitiveElement(node) : undefined,
    });
    if (dataUrl.length <= MAX_IMAGE_BASE64_CHARS) break;
    width = Math.max(320, Math.round(width * 0.75));
    height = Math.max(180, Math.round(height * 0.75));
    quality = Math.max(0.4, quality - 0.12);
  }
  if (dataUrl.length > MAX_IMAGE_BASE64_CHARS) throw new Error('截图压缩后仍超过 MCP 图像上限');
  const marker = 'base64,';
  const markerIndex = dataUrl.indexOf(marker);
  if (markerIndex < 0) throw new Error('截图编码格式无效');
  return { data: dataUrl.slice(markerIndex + marker.length), mimeType: 'image/jpeg', width, height };
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
  if (!isTauriRuntime()) return captureCurrentDocument(options);
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  if (getCurrentWindow().label === options.target) return captureCurrentDocument(options);

  const { emitTo, listen } = await import('@tauri-apps/api/event');
  const requestId = `capture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<WindowCaptureResult>((resolve, reject) => {
    let unlisten: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      unlisten?.();
      reject(new Error(`窗口截图响应超时: ${options.target}`));
    }, 12_000);
    void listen<{ requestId: string; result?: WindowCaptureResult; error?: string }>(CAPTURE_RESPONSE_EVENT, (event) => {
      if (event.payload.requestId !== requestId) return;
      window.clearTimeout(timer);
      unlisten?.();
      if (event.payload.result) resolve(event.payload.result);
      else reject(new Error(event.payload.error || '窗口截图失败'));
    }).then((dispose) => {
      unlisten = dispose;
      return emitTo(options.target, CAPTURE_REQUEST_EVENT, { requestId, options });
    }).catch((error) => {
      window.clearTimeout(timer);
      unlisten?.();
      reject(error);
    });
  });
}

export async function installMcpScreenshotResponder(): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const { emitTo, listen } = await import('@tauri-apps/api/event');
  return listen<{ requestId: string; options: CaptureOptions }>(CAPTURE_REQUEST_EVENT, (event) => {
    void captureCurrentDocument(event.payload.options)
      .then((result) => emitTo('main', CAPTURE_RESPONSE_EVENT, { requestId: event.payload.requestId, result }))
      .catch((error) => emitTo('main', CAPTURE_RESPONSE_EVENT, {
        requestId: event.payload.requestId,
        error: error instanceof Error ? error.message : '窗口截图失败',
      }));
  });
}

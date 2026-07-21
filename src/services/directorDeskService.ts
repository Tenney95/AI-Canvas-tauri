/**
 * 3D 导演台（xiaozangao/3d-director-desk）宿主通信
 * - 本地默认：http://127.0.0.1:5173
 * - 通过 iframe + postMessage 对接，截图/导出回写画布节点
 */

export const DIRECTOR_DESK_ORIGIN_KEY = 'canvas-director-desk-origin';
export const DEFAULT_DIRECTOR_DESK_ORIGIN = 'http://127.0.0.1:5173';

export type DirectorCaptureItem = {
  dataUrl: string;
  fileName: string;
};

export type DirectorExtensionAction =
  | 'capabilities.get'
  | 'project.get'
  | 'timeline.get'
  | 'export.frame'
  | 'export.video'
  | 'plugin.result.submit'
  | 'plugin.results.list';

export function getDirectorDeskOrigin(): string {
  try {
    const saved = localStorage.getItem(DIRECTOR_DESK_ORIGIN_KEY)?.trim();
    if (saved) return saved.replace(/\/+$/, '');
  } catch {
    /* ignore */
  }
  return DEFAULT_DIRECTOR_DESK_ORIGIN;
}

export function setDirectorDeskOrigin(origin: string) {
  const normalized = origin.trim().replace(/\/+$/, '');
  if (!normalized) {
    localStorage.removeItem(DIRECTOR_DESK_ORIGIN_KEY);
    return;
  }
  localStorage.setItem(DIRECTOR_DESK_ORIGIN_KEY, normalized);
}

export function getHostOriginForDirector(): string {
  try {
    return window.location.origin;
  } catch {
    return 'http://localhost:1420';
  }
}

export function buildDirectorDeskIframeSrc(instanceId: string, theme: 'dark' | 'light' = 'dark'): string {
  const origin = getDirectorDeskOrigin();
  const hostOrigin = encodeURIComponent(getHostOriginForDirector());
  const id = encodeURIComponent(instanceId);
  return `${origin}/?instanceId=${id}&theme=${theme}&hostOrigin=${hostOrigin}`;
}

export function isDirectorDeskMessage(event: MessageEvent, expectedOrigin?: string): boolean {
  const origin = expectedOrigin ?? getDirectorDeskOrigin();
  return event.origin === origin;
}

export function requestDirectorAction(
  target: Window,
  action: DirectorExtensionAction,
  options?: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<unknown> {
  const requestId = crypto.randomUUID();
  const directorOrigin = getDirectorDeskOrigin();

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error(`3D 导演台请求超时：${action}`));
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      if (!isDirectorDeskMessage(event, directorOrigin)) return;
      if (event.data?.type !== 'storyai:director-desk:response') return;
      const payload = event.data.payload;
      if (!payload || payload.requestId !== requestId) return;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (!payload.ok) {
        reject(new Error(payload.error?.message || `3D 导演台请求失败：${action}`));
        return;
      }
      resolve(payload.data);
    }

    window.addEventListener('message', onMessage);
    target.postMessage(
      {
        type: 'storyai:director-desk:request',
        payload: { requestId, action, ...(options ? { options } : {}) },
      },
      directorOrigin,
    );
  });
}

export function postDirectorSession(
  target: Window,
  payload: { instanceId: string; theme?: 'dark' | 'light' },
) {
  target.postMessage(
    {
      type: 'storyai:director-desk-session',
      payload,
    },
    getDirectorDeskOrigin(),
  );
}

export function postDirectorPanorama(
  target: Window,
  payload: {
    edgeId?: string;
    sourceNodeId?: string;
    imageUrl: string;
    fileName?: string;
  },
) {
  target.postMessage(
    {
      type: 'storyai:director-desk-panorama',
      payload,
    },
    getDirectorDeskOrigin(),
  );
}

/** 从节点数据中收集可用于图生视频的参考图 URL 列表 */
export function collectDirectorImageUrls(data: {
  imageUrl?: unknown;
  directorCaptureUrls?: unknown;
  directorCaptureFilePaths?: unknown;
}): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    const url = value.trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };

  push(data.imageUrl);
  if (Array.isArray(data.directorCaptureUrls)) {
    for (const item of data.directorCaptureUrls) push(item);
  }
  return urls;
}

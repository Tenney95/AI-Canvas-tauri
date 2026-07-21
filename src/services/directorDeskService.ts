/**
 * 3D 导演台（Tenney95/3d-director-desk）宿主通信
 * - 开发环境：http://127.0.0.1:5178
 * - 生产环境：应用内置 director-desk/index.html
 * - 通过 Tauri 独立窗口对接，截图/导出回写画布节点
 */

export const DIRECTOR_DESK_ORIGIN_KEY = 'canvas-director-desk-origin';
export const DEFAULT_DIRECTOR_DESK_ORIGIN = 'http://127.0.0.1:5178';
export const BUNDLED_DIRECTOR_DESK_ENTRY = 'director-desk/index.html';

export type DirectorDeskRuntimeMode = 'development' | 'production';

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

export function buildDirectorDeskWindowUrl(
  instanceId: string,
  theme: 'dark' | 'light' = 'dark',
  runtimeMode: DirectorDeskRuntimeMode = import.meta.env.DEV ? 'development' : 'production',
): string {
  const params = new URLSearchParams({
    instanceId,
    theme,
    transport: 'tauri',
    hostWindowLabel: 'main',
  });
  if (runtimeMode === 'production') {
    return `${BUNDLED_DIRECTOR_DESK_ENTRY}?${params.toString()}`;
  }

  const url = new URL(`${getDirectorDeskOrigin()}/`);
  url.search = params.toString();
  return url.toString();
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

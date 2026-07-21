/**
 * 3D 导演台（Tenney95/3d-director-desk）宿主通信
 * - 开发与生产环境均在按需安装后通过 director-desk:// 本地协议加载
 * - 通过 Tauri 独立窗口对接，截图/导出回写画布节点
 */

export const DIRECTOR_DESK_RUNTIME_ENTRY = 'director-desk://localhost/index.html';

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

export function buildDirectorDeskWindowUrl(
  instanceId: string,
  theme: 'dark' | 'light' = 'dark',
): string {
  const params = new URLSearchParams({
    instanceId,
    theme,
    transport: 'tauri',
    hostWindowLabel: 'main',
  });
  return `${DIRECTOR_DESK_RUNTIME_ENTRY}?${params.toString()}`;
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

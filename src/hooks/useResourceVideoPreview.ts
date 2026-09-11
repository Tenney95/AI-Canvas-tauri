import { useCallback, useState } from 'react';
import { getConvertFileSrc } from '../services/fileService';

/** 每个资源窗口只展开一项；切换范围或移除条目时同步失效。 */
export function useResourceVideoPreview(scope: string, availableIds: readonly string[]) {
  const [selection, setSelection] = useState<{ scope: string; id: string | null }>({ scope, id: null });
  const valid = selection.scope === scope && (selection.id === null || availableIds.includes(selection.id));
  if (!valid) setSelection({ scope, id: null });
  const setExpanded = useCallback((id: string | null) => setSelection({ scope, id }), [scope]);
  return { expandedId: valid ? selection.id : null, setExpanded };
}

/** 悬浮层按原视频比例等比缩放，并限制在当前窗口内；不影响列表排布。 */
export function getResourceVideoFloatingRect(
  anchor: { left: number; top: number; width: number; height?: number },
  media: { width: number; height: number },
  viewport: { left?: number; top?: number; width: number; height: number },
  toolbarHeight = 34,
) {
  const width = Number.isFinite(media.width) && media.width > 0 ? media.width : 640;
  const height = Number.isFinite(media.height) && media.height > 0 ? media.height : 360;
  const scale = Math.min(1, 720 / width, Math.max(1, viewport.width - 24) / width,
    Math.max(1, viewport.height - toolbarHeight - 24) / height);
  const videoWidth = width * scale;
  const videoHeight = height * scale;
  const left = viewport.left ?? 0;
  const top = viewport.top ?? 0;
  const anchorHeight = anchor.height ?? anchor.width * height / width;
  const align = (center: number, start: number, length: number) => {
    const relative = (center - start) / Math.max(1, length);
    return relative < 0.4 ? 0 : relative > 0.6 ? 1 : 0.5;
  };
  const alignX = align(anchor.left + anchor.width / 2, left, viewport.width);
  const alignY = align(anchor.top + anchorHeight / 2, top, viewport.height);
  const targetLeft = Math.max(left + 12, Math.min(anchor.left + (anchor.width - videoWidth) * alignX, left + viewport.width - videoWidth - 12));
  const targetTop = Math.max(top + 12, Math.min(anchor.top + (anchorHeight - videoHeight - toolbarHeight) * alignY, top + viewport.height - videoHeight - toolbarHeight - 12));
  return {
    width: videoWidth, height: videoHeight,
    left: targetLeft, top: targetTop,
    bounds: { left, top, width: viewport.width, height: viewport.height },
    // 同一组变换用于进场起点和退场终点，严格返回实际点击的缩略图矩形。
    thumbnail: {
      x: anchor.left - targetLeft, y: anchor.top - targetTop,
      scaleX: anchor.width / videoWidth, scaleY: anchorHeight / (videoHeight + toolbarHeight),
    },
  };
}

/** 仅转换已有文件条目的地址，不读取文件内容，也不扩大文件授权。 */
export async function resolveResourceVideoSource(src?: string, filePath?: string): Promise<string | undefined> {
  if (filePath && /^(?:[a-z]:[/\\]|[/\\])/i.test(filePath)) {
    try {
      const convert = await getConvertFileSrc();
      if (convert) return convert(filePath);
    } catch { /* 已有网络/内存媒体地址仍可使用。 */ }
  }
  return src || undefined;
}

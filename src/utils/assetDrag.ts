/**
 * assetDrag — 从资源搜索窗口发起原生 OS 文件拖拽（tauri-plugin-drag）
 *
 * 拖拽的文件路径以 OS 级 file drag 形式被主窗口接收（tauri://drag-drop），
 * 复用主窗口既有的拖放建节点逻辑（useNodeCreation）：仅在真正「放下」到主窗口
 * 时、于落点位置创建节点。
 *
 * 注意：startDrag 必须在 dragstart 事件里【同步】发起，否则会丢失鼠标按下的拖拽
 * 手势，导致 OS 立即在光标处放下文件（表现为「轻轻一拖就创建、且位置错乱」）。
 * 因此占位预览图需提前用 prepareDragIcon() 创建好缓存，拖拽时同步可用。
 */
import { startDrag } from '@crabnebula/tauri-plugin-drag';
import { ensureBinaryFile, joinPath, type AssetFileEntry } from '../services/fileService';
import { getPerformanceModeEnabled } from '../services/performanceModeRuntime';

/** 1x1 透明 PNG —— 非图片文件拖拽时的占位预览图（startDrag 的 icon 必填） */
const FALLBACK_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let _fallbackIconPath: string | null = null;
const DRAG_ICON_SIZE = 80;
const imageIcons = new Map<string, string>();
const pendingIcons = new Set<string>();

function thumbnailIcon(image: HTMLImageElement): string | undefined {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) return;
  try {
    const scale = Math.min(1, DRAG_ICON_SIZE / image.naturalWidth, DRAG_ICON_SIZE / image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch { return; }
}

/** 加载时准备占位图；悬停时提前解码图片，使系统拖拽同步使用小缩略图。 */
export async function prepareDragIcon(file?: AssetFileEntry): Promise<void> {
  if (file?.category === 'image' && file.assetUrl) {
    // 性能模式由同步拖拽入口复用已展示的小图或占位，不因悬停另解码原图。
    if (getPerformanceModeEnabled()) return;
    const key = file.assetUrl;
    if (imageIcons.has(key) || pendingIcons.has(key)) return;
    pendingIcons.add(key);
    const image = new Image();
    // 普通展示图片可能污染 canvas；单独用 CORS 加载，允许导出缩略图。
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const icon = thumbnailIcon(image);
      if (icon) {
        imageIcons.set(key, icon);
        if (imageIcons.size > 64) imageIcons.delete(imageIcons.keys().next().value!);
      }
      pendingIcons.delete(key);
      image.onload = image.onerror = null;
    };
    image.onerror = () => { pendingIcons.delete(key); image.onload = image.onerror = null; };
    image.src = key;
    return;
  }
  if (_fallbackIconPath) return;
  try {
    const { appDataDir } = await import('@tauri-apps/api/path');
    const dir = joinPath(await appDataDir(), '.cache');
    const path = joinPath(dir, 'drag-icon.png');
    const bin = atob(FALLBACK_ICON_B64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await ensureBinaryFile(path, bytes);
    _fallbackIconPath = path;
  } catch {
    /* ignore */
  }
}

/**
 * 同步发起文件拖拽（务必在 dragstart 内同步调用）。
 * 图片使用最长边 80px 的 PNG 缩略图，不把原图交给系统预览。
 */
export function startAssetDrag(file: AssetFileEntry, onEnd?: () => void, source?: Element | null): void {
  if (!file.path) { onEnd?.(); return; }
  const image = file.category === 'image' ? source?.querySelector<HTMLImageElement>('img') : null;
  const icon = (file.assetUrl && imageIcons.get(file.assetUrl))
    || (image && thumbnailIcon(image))
    || _fallbackIconPath || `data:image/png;base64,${FALLBACK_ICON_B64}`;
  // 原生拖拽会暂停 DOM 鼠标事件；完成和取消统一通过插件回调释放监听。
  void startDrag({ item: [file.path], icon, mode: 'copy' }, onEnd ? () => onEnd() : undefined)
    .catch(() => { onEnd?.(); console.warn('[assetDrag] startDrag 失败'); });
}

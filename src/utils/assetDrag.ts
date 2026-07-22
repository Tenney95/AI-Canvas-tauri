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

/** 1x1 透明 PNG —— 非图片文件拖拽时的占位预览图（startDrag 的 icon 必填） */
const FALLBACK_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let _fallbackIconPath: string | null = null;

/** 预创建占位预览图并缓存路径（窗口加载时调用一次，使拖拽时同步可用） */
export async function prepareDragIcon(): Promise<void> {
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
 * 图片用自身做预览图，其它类型用预创建的占位图。
 */
export function startAssetDrag(file: AssetFileEntry): void {
  if (!file.path) return;
  const icon = file.category === 'image' ? file.path : (_fallbackIconPath || file.path);
  void startDrag({ item: [file.path], icon, mode: 'copy' })
    .catch((err) => console.warn('[assetDrag] startDrag 失败:', err));
}

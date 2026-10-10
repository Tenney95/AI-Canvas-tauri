/**
 * clipboardService — 系统级剪贴板写入封装
 *
 * - 文本：navigator.clipboard.writeText（web 标准，Tauri/浏览器均可用）
 * - 图像：优先写原格式位图；WebView 不支持时降级为 Tauri 系统文件剪贴板
 * - 视频/音频文件：调用 Rust 命令 copy_files_to_clipboard（CF_HDROP 格式，可在资源管理器粘贴）
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv } from './fs/core';
import { localMediaUrlToPath } from '../utils/mediaUrl';

/** MIME 子类型 → 扩展名映射（用于推断图像类型） */
function mimeFromUrl(url: string): string {
  const m = url.match(/^data:(image\/[\w.+-]+)[;,]/i);
  if (m) return m[1].toLowerCase();
  const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() || '';
  const extMap: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  };
  return extMap[ext] || 'image/png';
}

export interface ImageClipboardOptions {
  filePath?: string;
  projectId?: string | null;
}

/** 保留原始格式，通过既有文件服务和原生授权命令复制文件。 */
async function copyImageFile(imageUrl: string, options: ImageClipboardOptions): Promise<boolean> {
  if (!isTauriEnv()) return false;
  const localPath = localMediaUrlToPath(imageUrl) || options.filePath;
  if (localPath) return copyFile(localPath);
  if (!options.projectId) return false;

  const { downloadUrlAndSave } = await import('./fileService');
  const saved = await downloadUrlAndSave(imageUrl, options.projectId, 'image', undefined, {
    deduplicateByContent: true,
    throwOnError: true,
  });
  return saved ? copyFile(saved.filePath) : false;
}

/** 复制文本到系统剪贴板 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 读取剪贴板文本；无权限或为空时返回空串。 */
export async function readText(): Promise<string> {
  try {
    return (await navigator.clipboard.readText()) || '';
  } catch {
    return '';
  }
}

export type NativeClipboardContent = { kind: 'text'; text: string } | { kind: 'image'; dataUrl: string };

/** Windows MCP 无用户手势读取；命令仅允许主窗口，原生端限制格式与体积。 */
export async function readNativeClipboard(): Promise<NativeClipboardContent> {
  return invoke<NativeClipboardContent>('read_canvas_clipboard');
}

/** 读取当前系统剪贴板中的真实目录，原生端复核权限，不使用应用内复制缓存。 */
export async function readClipboardFolders(): Promise<string[]> {
  if (!isTauriEnv()) throw new Error('文件夹剪贴板仅支持桌面应用');
  return invoke<string[]>('read_asset_folder_clipboard');
}

/**
 * 优先按原格式复制位图；WebView 不支持时，桌面端降级为系统文件剪贴板。
 * 无本地文件的图片先保存到调用方捕获的项目，不修改节点或原始图片。
 */
export async function copyImage(imageUrl: string, options: ImageClipboardOptions = {}): Promise<boolean> {
  if (!imageUrl) return false;
  try {
    const mime = mimeFromUrl(imageUrl);
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined'
      || (typeof ClipboardItem.supports === 'function' && !ClipboardItem.supports(mime))) {
      return await copyImageFile(imageUrl, options);
    }

    // WebKit 要求 write() 在用户手势内立即调用；图片读取作为 Promise 延后完成。
    const blobPromise = fetch(imageUrl).then(async (response) => {
      if (!response.ok) throw new Error(`图片读取失败 (${response.status})`);
      const blob = await response.blob();
      if (blob.type && blob.type !== 'application/octet-stream' && blob.type !== mime) {
        throw new Error(`图片类型不匹配 (${blob.type})`);
      }
      return blob.type === mime ? blob : new Blob([blob], { type: mime });
    });
    // 写入可能先因格式不支持失败；仍消费延后读取的拒绝，避免未处理的 Promise。
    void blobPromise.catch(() => {});
    try {
      const item = new ClipboardItem({ [mime]: blobPromise });
      await navigator.clipboard.write([item]);
    } catch (error) {
      // 部分 WebView 没有 supports()，在实际写入时才报告格式不支持。
      if (error instanceof Error && error.name === 'NotSupportedError') {
        return await copyImageFile(imageUrl, options);
      }
      throw error;
    }
    return true;
  } catch {
    console.error('[剪贴板] 复制图片失败');
    return false;
  }
}

/**
 * 复制视频/音频文件到系统剪贴板（CF_HDROP 格式，可在资源管理器粘贴）。
 * 仅 Tauri 桌面环境可用；浏览器环境返回 false。
 */
export async function copyFile(filePath: string): Promise<boolean> {
  if (!filePath || !isTauriEnv()) return false;
  try {
    await invoke('copy_files_to_clipboard', { paths: [filePath] });
    return true;
  } catch {
    return false;
  }
}

/**
 * 复制多个文件到系统剪贴板（CF_HDROP 格式，一次写入多个文件路径）。
 * 仅 Tauri 桌面环境可用；空列表或非 Tauri 环境返回 false。
 */
export async function copyFiles(filePaths: string[]): Promise<boolean> {
  if (filePaths.length === 0 || !isTauriEnv()) return false;
  try {
    await invoke('copy_files_to_clipboard', { paths: filePaths });
    return true;
  } catch {
    return false;
  }
}

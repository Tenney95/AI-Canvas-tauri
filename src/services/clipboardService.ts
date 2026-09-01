/**
 * clipboardService — 系统级剪贴板写入封装
 *
 * - 文本：navigator.clipboard.writeText（web 标准，Tauri/浏览器均可用）
 * - 图像：navigator.clipboard.write([ClipboardItem])（写位图，可粘贴到 PS/聊天）
 * - 视频/音频文件：调用 Rust 命令 copy_files_to_clipboard（CF_HDROP 格式，可在资源管理器粘贴）
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv } from './fs/core';

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

/**
 * 复制图像到系统剪贴板（位图格式，可粘贴到 PS、聊天工具）。
 * 支持 data: URL 和 http(s) URL（在 Tauri 环境用 fetch 拉取）。
 */
export async function copyImage(imageUrl: string): Promise<boolean> {
  if (!imageUrl) return false;
  try {
    const mime = mimeFromUrl(imageUrl);
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      throw new Error('当前 WebView 不支持图片剪贴板');
    }
    if (typeof ClipboardItem.supports === 'function' && !ClipboardItem.supports(mime)) {
      throw new Error(`当前 WebView 不支持复制 ${mime}`);
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
    const item = new ClipboardItem({ [mime]: blobPromise });
    await navigator.clipboard.write([item]);
    return true;
  } catch (error) {
    console.error('[剪贴板] 复制图片失败:', error);
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

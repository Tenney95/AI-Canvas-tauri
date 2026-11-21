import { open, save } from '@tauri-apps/plugin-dialog';
import { open as fsOpen, readFile as tauriReadFile, stat, writeFile } from '@tauri-apps/plugin-fs';
import { isTauriEnv, sanitizeFileName } from './core';

export interface AgentTextFileSelection {
  path: string;
  fileName: string;
  size: number;
  extension: string;
}

const AGENT_TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'yaml', 'yml',
  'xml', 'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'log',
];

/** 通过原生选择器选择 Agent 可读取的文本文件；路径只返回给授权服务，不进入模型。 */
export async function selectAgentTextFiles(
  title = '授权当前对话读取本地文件',
  includeImages = false,
): Promise<AgentTextFileSelection[]> {
  if (!isTauriEnv()) throw new Error('本地文件授权仅在 Tauri 桌面环境可用');
  const selected = await open({
    multiple: true,
    directory: false,
    title,
    filters: [{ name: includeImages ? '图片、文本与数据文件' : '文本与数据文件',
      extensions: includeImages ? [...AGENT_TEXT_EXTENSIONS, 'png', 'jpg', 'jpeg', 'webp'] : AGENT_TEXT_EXTENSIONS }],
  });
  if (!selected) return [];
  const paths = Array.isArray(selected) ? selected : [selected];
  const files: AgentTextFileSelection[] = [];
  for (const path of paths.slice(0, 10)) {
    const fileName = path.split(/[/\\]/).pop() || '未命名文件';
    const extension = fileName.split('.').pop()?.toLowerCase() || '';
    if (!AGENT_TEXT_EXTENSIONS.includes(extension) && !(includeImages && /^(png|jpe?g|webp)$/.test(extension))) continue;
    const metadata = await stat(path);
    if (!metadata.isFile) continue;
    files.push({ path, fileName, size: metadata.size, extension });
  }
  return files;
}

/** 只用于原生选择器返回的图片，读取前后都限制体积并检查真实图片头。 */
export async function readAgentSelectedImage(path: string): Promise<{ bytes: Uint8Array; extension: string }> {
  if (!isTauriEnv()) throw new Error('图片附件仅在 Tauri 桌面环境可用');
  const metadata = await stat(path);
  if (!metadata.isFile || metadata.size > 8 * 1024 * 1024) throw new Error('参考图必须是 8 MB 以内的图片文件');
  const bytes = await tauriReadFile(path);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('参考图超过 8 MB');
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const extension = bytes[0] === 0x89 && ascii(1, 3) === 'PNG' ? 'png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'jpg'
      : ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' ? 'webp' : undefined;
  const { parseRasterImageDimensions } = await import('../rasterImageDimensions');
  const dimensions = parseRasterImageDimensions(bytes);
  if (!extension || !dimensions) throw new Error('请选择有效的 PNG、JPEG 或 WebP 图片');
  if (dimensions.width * dimensions.height > 16_000_000) throw new Error('参考图超过 1600 万像素，请缩小后上传');
  return { bytes, extension };
}

/** 读取已经由授权服务复核过的路径；严格限制字节数并使用 UTF-8 解码。 */
export async function readAgentAuthorizedTextFile(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!isTauriEnv()) throw new Error('本地文件读取仅在 Tauri 桌面环境可用');
  const checkAbort = () => { if (signal?.aborted) throw new DOMException('读取已取消', 'AbortError'); };
  const tooLarge = () => new Error(`文件超过 ${Math.floor(maxBytes / 1024)} KB 读取限制`);
  try {
    checkAbort();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('文件读取限制无效');
    const metadata = await stat(path);
    checkAbort();
    if (!metadata.isFile) throw new Error('授权目标已不再是文件');
    if (metadata.size > maxBytes) throw tooLarge();
    const file = await fsOpen(path, { read: true });
    let content: string;
    try {
      checkAbort();
      const parts: Uint8Array[] = [];
      let total = 0;
      let ended = false;
      while (!ended) {
        // 最多多读一个字节识别增长；缓冲按实际分块增长，不按调用方上限预分配。
        const part = new Uint8Array(Math.min(64 * 1024, maxBytes - total + 1));
        let filled = 0;
        while (filled < part.length) {
          checkAbort();
          const count = await file.read(part.subarray(filled));
          checkAbort();
          if (count === null || count === 0) { ended = true; break; }
          if (!Number.isSafeInteger(count) || count < 0 || count > part.length - filled) {
            throw new Error('授权文件返回了无效读取长度');
          }
          filled += count;
          total += count;
          if (total > maxBytes) throw tooLarge();
        }
        if (filled) parts.push(part.subarray(0, filled));
      }
      const bytes = parts.length === 1 ? parts[0] : new Uint8Array(total);
      if (parts.length > 1) {
        let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      }
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('文件不是有效的 UTF-8 文本'); }
    } finally { await file.close(); }
    checkAbort();
    return content;
  } catch (error) {
    checkAbort();
    throw error;
  }
}

/** 用户确认后通过原生保存对话框写入文本；返回值不包含绝对路径。 */
export async function saveAgentTextOutput(
  content: string,
  suggestedName: string,
  title = '保存 Agent 输出',
): Promise<{ fileName: string } | null> {
  if (!isTauriEnv()) throw new Error('本地文件写入仅在 Tauri 桌面环境可用');
  const safeName = sanitizeFileName(suggestedName || 'agent-output.txt');
  const destPath = await save({
    defaultPath: safeName,
    title,
    filters: [{ name: '文本文件', extensions: ['txt', 'md', 'json', 'csv'] }],
  });
  if (!destPath) return null;
  await writeFile(destPath, new TextEncoder().encode(content));
  return { fileName: destPath.split(/[/\\]/).pop() || safeName };
}

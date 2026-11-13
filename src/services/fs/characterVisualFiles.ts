import { exists, mkdir, remove, writeFile } from '@tauri-apps/plugin-fs';
import type { MediaDownloadAccess } from '../../types/aiTypes';
import { isRemoteMediaUrl, isTauriAssetUrl } from '../../utils/mediaUrl';
import { t } from '../../i18n';
import { downloadGeneratedImageToPath } from '../fileService';
import { parseRasterImageDimensions } from '../rasterImageDimensions';
import { getAssetUrlFromPath, joinPath } from './core';
import { readImageSourceBlob } from './imageSourceBlob';

export class CharacterVisualResultConflictError extends Error {
  constructor() { super(t('候选文件已被其他内容占用')); this.name = 'CharacterVisualResultConflictError'; }
}

export function isCharacterVisualInputUrl(value: string | undefined): value is string {
  return !!value && (isTauriAssetUrl(value) || /^(?:blob:|data:image\/(?:png|jpeg|webp|gif|avif);base64,)/i.test(value));
}

export function characterVisualImageFormat(bytes: Uint8Array): { mime: string; extension: string } {
  const header = (start: number, value: string) => [...value].every((character, index) =>
    bytes[start + index] === character.charCodeAt(0));
  if (bytes[0] === 0x89 && header(1, 'PNG\r\n\x1a\n')) return { mime: 'image/png', extension: 'png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', extension: 'jpg' };
  if (header(0, 'RIFF') && header(8, 'WEBP')) return { mime: 'image/webp', extension: 'webp' };
  if (header(0, 'GIF87a') || header(0, 'GIF89a')) return { mime: 'image/gif', extension: 'gif' };
  if (header(4, 'ftypavif') || header(4, 'ftypavis')) return { mime: 'image/avif', extension: 'avif' };
  throw new Error(t('不支持此图片格式'));
}

/** 下载先走原生长度和文件头校验，正式候选使用真实图片扩展名。 */
export async function saveCharacterVisualResult(
  url: string, directory: string, stem: string, access?: MediaDownloadAccess, signal = new AbortController().signal,
): Promise<{ filePath: string; width: number; height: number }> {
  if (!/^[a-z0-9-]{1,64}$/i.test(stem)) throw new Error(t('原候选图片文件不可用'));
  await mkdir(directory, { recursive: true });
  const stagingPath = joinPath(directory, `.${crypto.randomUUID()}.incoming`);
  let downloaded: string | undefined;
  try {
    if (isRemoteMediaUrl(url)) downloaded = await downloadGeneratedImageToPath(url, stagingPath, { mediaDownloadAccess: access, signal });
    const source = downloaded ? await getAssetUrlFromPath(downloaded) : url;
    if (!isCharacterVisualInputUrl(source)) throw new Error(t('原候选图片文件不可用'));
    const bytes = new Uint8Array(await (await readImageSourceBlob(source, signal)).arrayBuffer());
    const format = characterVisualImageFormat(bytes);
    const dimensions = parseRasterImageDimensions(bytes.subarray(0, 256 * 1024));
    if (!['png', 'jpg', 'webp'].includes(format.extension)
      || !dimensions || dimensions.width * dimensions.height > 64 * 1024 * 1024) {
      throw new Error(t('原候选图片文件不可用'));
    }
    signal.throwIfAborted();
    const filePath = joinPath(directory, `${stem}.${format.extension}`);
    if (await exists(filePath)) {
      const previous = new Uint8Array(await (await readImageSourceBlob(await getAssetUrlFromPath(filePath), signal)).arrayBuffer());
      if (previous.length !== bytes.length || !previous.every((value, index) => value === bytes[index])) throw new CharacterVisualResultConflictError();
      return { filePath, ...dimensions };
    }
    await writeFile(filePath, bytes, { createNew: true });
    return { filePath, ...dimensions };
  } finally {
    if (downloaded) await remove(downloaded).catch(() => undefined);
  }
}

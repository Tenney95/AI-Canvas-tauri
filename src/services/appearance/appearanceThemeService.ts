import type { AppearanceTheme } from '../../types';
import { normalizeAppearanceTheme } from './appearanceDefaults';
import { deleteAppearanceThemeFromDb, getAllAppearanceThemes, saveAppearanceThemeToDb } from '../indexedDb/catalogRepository';
import { bytePartsToBase64Async, isTauriEnv } from '../fs/core';
import { isEmbeddedThemeImage, isThemeImageReference, MAX_THEME_IMAGE_BYTES, readThemeImage, storeThemeImage, validateThemeImage } from '../fs/themeAssets';
import { decodeDataUrlBytesAsync, sha256BytesHex } from '../mediaDataUrl';

// 最多八个图片槽位，每张 5MB；导出内嵌资源编码后的上限。
export const MAX_APPEARANCE_THEME_BYTES = 64 * 1024 * 1024;
const MAX_THEME_IMAGES = 8;

function imageSlots(theme: AppearanceTheme): { imageDataUrl?: string }[] {
  return [theme.canvas, theme.handle, theme.node.backgroundImage, theme.ui.surfaceImage,
    theme.ui.button.normal.backgroundImage, theme.ui.button.normal.hoverBackgroundImage,
    theme.ui.button.primary.backgroundImage, theme.ui.button.primary.hoverBackgroundImage,
  ].filter((slot): slot is NonNullable<typeof slot> => Boolean(slot));
}

function imageSources(theme: AppearanceTheme): string[] {
  return [...new Set(imageSlots(theme).map((slot) => slot.imageDataUrl).filter((source): source is string => Boolean(source)))];
}

async function embeddedImageBlob(source: string): Promise<Blob> {
  if (!isEmbeddedThemeImage(source)) throw new Error('主题图片格式不受支持');
  const bytes = await decodeDataUrlBytesAsync(source, { maxBytes: MAX_THEME_IMAGE_BYTES, label: '主题图片' });
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: source.slice(5, source.indexOf(';')) });
}

async function blobReference(blob: Blob): Promise<string> {
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[blob.type];
  if (!extension) throw new Error('主题图片格式不受支持');
  return `theme-asset:${await sha256BytesHex(new Uint8Array(await blob.arrayBuffer()))}.${extension}`;
}

/** 仅桌面端迁移旧图片；全部落盘成功才返回新快照，失败时调用方保留原配置。 */
export async function persistAppearanceImages(theme: AppearanceTheme): Promise<AppearanceTheme> {
  if (!isTauriEnv() || !imageSources(theme).some(isEmbeddedThemeImage)) return theme;
  const next = structuredClone(theme);
  const migrated = new Map<string, string>();
  for (const slot of imageSlots(next)) {
    const source = slot.imageDataUrl;
    if (!isEmbeddedThemeImage(source)) continue;
    let reference = migrated.get(source);
    if (!reference) {
      reference = await storeThemeImage(await embeddedImageBlob(source));
      migrated.set(source, reference);
    }
    slot.imageDataUrl = reference;
  }
  return next;
}

export async function loadAppearanceThemes(): Promise<AppearanceTheme[]> {
  return getAllAppearanceThemes();
}
export async function saveAppearanceTheme(theme: AppearanceTheme): Promise<AppearanceTheme> {
  const next = await persistAppearanceImages(theme);
  await saveAppearanceThemeToDb(next);
  return next;
}

export async function deleteAppearanceTheme(id: string): Promise<void> {
  await deleteAppearanceThemeFromDb(id);
}

/** 导出时才读取文件并携带图片；同图只携带一次，不把资源正文写回 Store。 */
export async function exportAppearanceTheme(input: AppearanceTheme): Promise<Blob> {
  const theme = structuredClone(normalizeAppearanceTheme(input));
  const replacements = new Map<string, string>();
  const exported = new Set<string>();
  const imageParts: BlobPart[] = [];
  for (const source of imageSources(theme)) {
    const blob = isThemeImageReference(source) ? await readThemeImage(source) : await embeddedImageBlob(source);
    const reference = isThemeImageReference(source) ? source : await blobReference(blob);
    replacements.set(source, reference);
    if (exported.has(reference)) continue;
    exported.add(reference);
    const dataUrl = `data:${blob.type};base64,${await bytePartsToBase64Async([new Uint8Array(await blob.arrayBuffer())])}`;
    imageParts.push(`${imageParts.length ? ',' : ''}${JSON.stringify(reference)}:${JSON.stringify(dataUrl)}`);
  }
  for (const slot of imageSlots(theme)) {
    if (slot.imageDataUrl) slot.imageDataUrl = replacements.get(slot.imageDataUrl);
  }
  const blob = new Blob([
    `{"format":"ai-canvas-theme","version":2,"theme":${JSON.stringify(theme)},"images":{`,
    ...imageParts, '}}',
  ], { type: 'application/json' });
  if (blob.size > MAX_APPEARANCE_THEME_BYTES) throw new Error('主题文件不能超过 64MB');
  return blob;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function importAppearanceTheme(file: File): Promise<AppearanceTheme> {
  if (file.size > MAX_APPEARANCE_THEME_BYTES) throw new Error('主题文件不能超过 64MB');
  let document: unknown;
  try {
    document = JSON.parse(await file.text());
  } catch (error) {
    throw new Error('主题文件不是有效的 JSON，请重新选择导出的主题文件', { cause: error });
  }
  if (!isRecord(document)) throw new Error('主题文件格式不受支持');
  const packaged = document.format === 'ai-canvas-theme';
  if (packaged && document.version !== 2) throw new Error('主题文件版本不受支持');
  const raw = packaged ? document.theme : document;
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !['ui', 'canvas', 'node', 'edge', 'handle', 'motion'].every((key) => isRecord(raw[key]))) {
    throw new Error('主题文件格式不受支持');
  }
  // 运行时规范化可以退回底色；导入不能把不受支持的图片静默丢弃。
  for (const path of ['canvas', 'handle', 'node.backgroundImage', 'ui.surfaceImage',
    'ui.button.normal.backgroundImage', 'ui.button.normal.hoverBackgroundImage',
    'ui.button.primary.backgroundImage', 'ui.button.primary.hoverBackgroundImage']) {
    let value: unknown = raw;
    for (const key of path.split('.')) value = isRecord(value) ? value[key] : undefined;
    if (isRecord(value) && value.imageDataUrl != null && !isThemeImageReference(value.imageDataUrl) && !isEmbeddedThemeImage(value.imageDataUrl)) {
      throw new Error('主题包含不受支持的图片引用，请重新导出完整主题');
    }
  }
  const theme = normalizeAppearanceTheme(raw);
  const sources = imageSources(theme);
  const images = packaged && isRecord(document.images) ? document.images : {};
  if (Object.keys(images).length > MAX_THEME_IMAGES) throw new Error('主题图片数量超过限制');
  // 全部校验完成后再写入本地目录，损坏/缺失资源不得激活半成品主题。
  const blobs = new Map<string, Blob>();
  for (const source of sources) {
    const embedded = isThemeImageReference(source) ? images[source] : source;
    if (typeof embedded !== 'string') throw new Error('主题文件缺少背景图片，请从原设备重新导出');
    const blob = await embeddedImageBlob(embedded);
    if (isThemeImageReference(source) && await blobReference(blob) !== source) throw new Error('主题图片摘要不匹配');
    await validateThemeImage(blob);
    blobs.set(source, blob);
  }
  const replacements = new Map<string, string>();
  for (const [source, blob] of blobs) replacements.set(source, await storeThemeImage(blob));
  for (const slot of imageSlots(theme)) {
    if (slot.imageDataUrl) slot.imageDataUrl = replacements.get(slot.imageDataUrl);
  }
  const now = Date.now();
  return {
    ...theme,
    id: `imported-${crypto.randomUUID()}`,
    name: `${theme.name}（导入）`,
    builtin: false,
    createdAt: now,
    updatedAt: now,
  };
}

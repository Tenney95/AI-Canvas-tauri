import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { isTauriEnv } from './core';

export const MAX_THEME_IMAGE_BYTES = 5 * 1024 * 1024;
const THEME_IMAGE_REFERENCE = /^theme-asset:([a-f0-9]{64}\.(?:png|jpg|webp|svg))$/;
const EMBEDDED_THEME_IMAGE = /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[a-z0-9+/]+={0,2}$/i;

/** 持久化只存固定目录中的内容摘要文件名，不存安装路径或运行时 URL。 */
export function isThemeImageReference(value: unknown): value is string {
  return typeof value === 'string' && THEME_IMAGE_REFERENCE.test(value);
}

export function isEmbeddedThemeImage(value: unknown): value is string {
  return typeof value === 'string' && EMBEDDED_THEME_IMAGE.test(value);
}

export function resolveThemeImageSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  const match = THEME_IMAGE_REFERENCE.exec(source);
  if (match) return isTauriEnv() ? convertFileSrc(match[1], 'theme-image') : undefined;
  return source;
}

export async function validateThemeImage(blob: Blob): Promise<void> {
  if (!blob.size || blob.size > MAX_THEME_IMAGE_BYTES) throw new Error('背景图片须大于 0 字节且不能超过 5MB');
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.onload = () => image.naturalWidth && image.naturalHeight ? resolve() : reject(new Error('图片内容无效'));
      image.onerror = () => reject(new Error('图片内容无效'));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function storeThemeImage(file: Blob): Promise<string> {
  await validateThemeImage(file);
  if (!isTauriEnv()) {
    // Web 演示没有安装目录，沿用内嵌图片；桌面端始终走二进制落盘。
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.onabort = () => reject(new Error('图片读取已取消'));
      reader.readAsDataURL(file);
    });
  }
  let name: string;
  try {
    name = await invoke<string>('store_theme_image', new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    throw new Error(typeof error === 'string' ? error : '主题图片保存失败，请检查安装目录的 theme 文件夹权限', { cause: error });
  }
  const reference = `theme-asset:${name}`;
  if (!isThemeImageReference(reference)) throw new Error('主题图片保存结果无效');
  return reference;
}

export async function readThemeImage(reference: string): Promise<Blob> {
  if (!isThemeImageReference(reference)) throw new Error('主题图片引用无效');
  const source = resolveThemeImageSource(reference);
  if (!source) throw new Error('本地主题图片需要在桌面端导出');
  const response = await fetch(source);
  if (!response.ok) throw new Error('主题图片不存在或已损坏，请重新上传后导出');
  const blob = await response.blob();
  if (!blob.size || blob.size > MAX_THEME_IMAGE_BYTES) throw new Error('主题图片大小无效');
  return blob;
}

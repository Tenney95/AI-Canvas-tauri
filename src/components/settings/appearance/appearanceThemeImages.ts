import type { CSSProperties } from 'react';
import { t as translate } from '../../../i18n';
import { resolveThemeImageSource, storeThemeImage } from '../../../services/fs/themeAssets';

export async function uploadThemeImage(file: File): Promise<string> {
  const declaredType = file.type.split(';')[0].trim().toLowerCase();
  const mimeType = (!declaredType || declaredType === 'application/octet-stream') && /\.svg$/i.test(file.name)
    ? 'image/svg+xml' : declaredType;
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(mimeType)) throw new Error(translate('请选择 PNG、JPG、WebP 或 SVG 图片'));
  return storeThemeImage(file.type === mimeType ? file : new Blob([file], { type: mimeType }));
}

export function imagePreviewStyle(imageDataUrl: string | undefined, size: CSSProperties['backgroundSize'] = 'cover'): CSSProperties | undefined {
  const source = resolveThemeImageSource(imageDataUrl);
  return source
    ? { backgroundImage: `url(${source})`, backgroundPosition: 'center', backgroundRepeat: 'no-repeat', backgroundSize: size === 'fill' ? '100% 100%' : size }
    : undefined;
}

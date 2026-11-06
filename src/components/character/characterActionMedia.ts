/** 画布节点转为角色动作素材；只投影已有媒体，不读取文件或写入 Store。 */
import { generateId } from '../../store/store.utils';
import type { BaseNodeData } from '../../types';
import type { CharacterActionMedia } from '../../types/dramaAssets';

export function actionMediaFromCanvasNode(node?: { data: BaseNodeData }): CharacterActionMedia | null {
  if (!node) return null;
  const data = node.data;
  const name = data.fileName || data.label || '画布动作素材';
  if (data.videoUrl) {
    const extension = (data.fileName || data.filePath || data.videoUrl)
      .split(/[?#]/, 1)[0]
      .split('.')
      .pop()
      ?.toLowerCase();
    const mimeType = extension === 'webm'
      ? 'video/webm'
      : extension === 'mov'
        ? 'video/quicktime'
        : extension === 'm4v'
          ? 'video/x-m4v'
          : 'video/mp4';
    const now = Date.now();
    return {
      id: `action-media-${generateId()}`,
      kind: 'video',
      name,
      mimeType,
      assetId: data.assetId,
      relativePath: data.relativePath,
      filePath: data.filePath,
      url: data.videoUrl,
      createdAt: now,
      updatedAt: now,
    };
  }
  const imageUrl = data.imageUrl || data.thumbnailUrl;
  if (!imageUrl) return null;
  const imageIdentity = [data.fileName, data.filePath, imageUrl]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  const isGif = /\.gif(?:[?#]|$)/i.test(imageIdentity) || imageUrl.startsWith('data:image/gif');
  const extension = (data.fileName || data.filePath || imageUrl)
    .split(/[?#]/, 1)[0]
    .split('.')
    .pop()
    ?.toLowerCase();
  const dataMimeType = imageUrl.match(/^data:(image\/[^;,]+)/i)?.[1]?.toLowerCase();
  const mimeType = isGif
    ? 'image/gif'
    : dataMimeType
      ?? (extension === 'jpg' || extension === 'jpeg'
        ? 'image/jpeg'
        : extension === 'webp'
          ? 'image/webp'
          : extension === 'avif'
            ? 'image/avif'
            : 'image/png');
  const now = Date.now();
  return {
    id: `action-media-${generateId()}`,
    kind: isGif ? 'gif' : 'image',
    name,
    mimeType,
    assetId: data.assetId,
    relativePath: data.relativePath,
    filePath: data.filePath,
    url: imageUrl,
    createdAt: now,
    updatedAt: now,
  };
}

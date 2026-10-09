import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';

let imageKeyCache = new WeakMap<readonly Node<BaseNodeData>[], Map<string, string>>();

/** 所有分组共用当前节点数组的封面索引；仅保留最新一份，避免历史快照滞留大图字符串。 */
export function getGroupChildImageKey(nodes: readonly Node<BaseNodeData>[], groupId: string): string {
  let imageKeys = imageKeyCache.get(nodes);
  if (!imageKeys) {
    const images = new Map<string, string[]>();
    for (const node of nodes) {
      if (!node.parentId) continue;
      const url = node.data.thumbnailUrl || node.data.imageUrl;
      if (!url) continue;
      const groupImages = images.get(node.parentId);
      if (groupImages) groupImages.push(url);
      else images.set(node.parentId, [url]);
    }
    imageKeys = new Map(Array.from(images, ([id, urls]) => [id, urls.join('|')]));
    imageKeyCache = new WeakMap([[nodes, imageKeys]]);
  }
  return imageKeys.get(groupId) ?? '';
}

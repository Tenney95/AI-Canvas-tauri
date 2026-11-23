/**
 * groupChildImageKey — 维护分组子节点图片封面的索引与缓存键。
 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';

type CanvasNodes = readonly Node<BaseNodeData>[];
let imageKeyCache = new WeakMap<CanvasNodes, Map<string, string>>();
let previousNodes: WeakRef<CanvasNodes> | undefined;
const VIDEO_COVER = Symbol('video-cover');

export type GroupCoverItem =
  | { id: string; kind: 'image'; url: string }
  | { id: string; kind: 'video' };

function coverSource(node: Node<BaseNodeData>): string | typeof VIDEO_COVER | undefined {
  const type = node.type ?? node.data.type;
  return type === 'ai-video' || type === 'source-video' ? VIDEO_COVER : node.data.thumbnailUrl || node.data.imageUrl;
}

function sameCover(current: Node<BaseNodeData>, previous: Node<BaseNodeData>): boolean {
  if (current === previous) return true;
  if (current.id !== previous.id || current.parentId !== previous.parentId) return false;
  return !current.parentId || coverSource(current) === coverSource(previous);
}

/** 分组共用最近一次索引。拖动只改位置时沿用原封面，关掉画布后也能回收节点和图片地址。 */
export function getGroupChildImageKey(nodes: CanvasNodes, groupId: string): string {
  const cached = imageKeyCache.get(nodes);
  if (cached) return cached.get(groupId) ?? '';

  const previous = previousNodes?.deref();
  let imageKeys = previous && nodes.length === previous.length && nodes.every((node, index) => sameCover(node, previous[index]))
    ? imageKeyCache.get(previous) : undefined;
  if (!imageKeys) {
    const images = new Map<string, GroupCoverItem[]>();
    for (const node of nodes) {
      if (!node.parentId) continue;
      const source = coverSource(node);
      if (!source) continue;
      const cover: GroupCoverItem = source === VIDEO_COVER
        ? { id: node.id, kind: 'video' }
        : { id: node.id, kind: 'image', url: source };
      const groupImages = images.get(node.parentId);
      if (groupImages) groupImages.push(cover);
      else images.set(node.parentId, [cover]);
    }
    imageKeys = new Map(Array.from(images, ([id, covers]) => [id, JSON.stringify(covers)]));
  }
  previousNodes = typeof WeakRef === 'function' ? new WeakRef(nodes) : undefined;
  imageKeyCache = new WeakMap([[nodes, imageKeys]]);
  return imageKeys.get(groupId) ?? '';
}

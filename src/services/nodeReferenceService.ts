/**
 * 解析工作流输入中的画布节点、剧本资产和本地资产引用，并替换为可提交的实际内容。
 */
import { useAppStore } from '../store/useAppStore';
import { resolveDramaActionMediaRef, resolveDramaAssetImageRef } from './dramaAssetPrompt';
import { parseDramaMentionId } from '../types/dramaAssets';

/** 解析 workflowInputs 值中的 @{nodeId:label} / @drama{id:name} 引用，替换为对应输出内容 */
export function resolveNodeReferences(value: string): string {
  const store = useAppStore.getState();
  const { nodes } = store;
  // 文件资产引用在工作流文本输入中不适用，直接移除标记
  let cleaned = value.replace(/@asset\{[^}]+\}/g, '');

  cleaned = cleaned.replace(/@drama\{([^:]+):([^}]+)\}/g, (_match, dramaId: string, dramaName: string) => {
    // 延迟 require 形状的 import 在顶部已有 store；简介格式与 promptResolver 一致
    const lib = store.dramaAssets;
    // 工作流文本输入只能塞一个地址，#all 在这里退化成主视觉那一张
    const { assetId, referenceImageId, actionId, actionMediaId } = parseDramaMentionId(dramaId);
    const asset =
      lib.characters.find((a) => a.id === assetId)
      || lib.scenes.find((a) => a.id === assetId)
      || lib.props.find((a) => a.id === assetId);
    if (actionId !== undefined) {
      const media = resolveDramaActionMediaRef(asset, actionId, actionMediaId);
      if (!media) throw new Error(`动作素材引用已失效：${dramaName || '未命名动作'}`);
      return media.url;
    }
    if (!asset) return dramaName || _match;
    const imageReference = resolveDramaAssetImageRef(
      asset,
      nodes as Array<{ id: string; data?: Record<string, unknown> }>,
      referenceImageId,
    );
    if (imageReference) return imageReference.imageUrl;
    // 无图：展开单条简介字段（与 formatDramaAssetTextBrief 同信息，避免循环依赖用内联）
    const parts = [
      asset.name,
      asset.summary,
      asset.visualNotes,
      asset.kind === 'character' ? (asset as { identity?: string }).identity : undefined,
      asset.kind === 'character' ? (asset as { wardrobeDefault?: string }).wardrobeDefault : undefined,
    ].filter(Boolean);
    return parts.join('，') || dramaName;
  });

  const chipRegex = /@\{([^:]+):([^}]+)\}/g;
  return cleaned.replace(chipRegex, (_match, nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return _match;
    // 文本节点的输出在 data.output 中
    const output = node.data.output as string | undefined;
    if (typeof output === 'string' && output.trim()) return output;
    // 图片 / 导演台节点的输出在 data.imageUrl 或 directorCaptureUrls 中
    const imageUrl = node.data.imageUrl as string | undefined;
    if (typeof imageUrl === 'string' && imageUrl.trim()) return imageUrl;
    if (Array.isArray(node.data.directorCaptureUrls)) {
      const first = (node.data.directorCaptureUrls as string[]).find((u) => typeof u === 'string' && u.trim());
      if (first) return first;
    }
    // 视频 / 音频同理
    const videoUrl = node.data.videoUrl as string | undefined;
    if (typeof videoUrl === 'string' && videoUrl.trim()) return videoUrl;
    const audioUrl = node.data.audioUrl as string | undefined;
    if (typeof audioUrl === 'string' && audioUrl.trim()) return audioUrl;
    // 无法解析，保留原文
    return _match;
  });
}

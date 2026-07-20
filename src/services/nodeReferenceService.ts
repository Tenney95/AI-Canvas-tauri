import { useAppStore } from '../store/useAppStore';

/** 解析 workflowInputs 值中的 @{nodeId:label} 引用，替换为对应节点的实际输出内容 */
export function resolveNodeReferences(value: string): string {
  const { nodes } = useAppStore.getState();
  // 资产引用在工作流文本输入中不适用，直接移除标记
  const cleaned = value.replace(/@asset\{[^}]+\}/g, '');
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

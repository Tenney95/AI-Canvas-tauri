import { useAppStore } from '../store/useAppStore';

/** 解析 workflowInputs 值中的 @{nodeId:label} / @drama{id:name} 引用，替换为对应输出内容 */
export function resolveNodeReferences(value: string): string {
  const store = useAppStore.getState();
  const { nodes } = store;
  // 文件资产引用在工作流文本输入中不适用，直接移除标记
  let cleaned = value.replace(/@asset\{[^}]+\}/g, '');

  cleaned = cleaned.replace(/@drama\{([^:]+):([^}]+)\}/g, (_match, dramaId: string, dramaName: string) => {
    const lib = store.dramaAssets;
    const asset =
      lib.characters.find((a) => a.id === dramaId)
      || lib.scenes.find((a) => a.id === dramaId)
      || lib.props.find((a) => a.id === dramaId);
    if (!asset) return dramaName || _match;
    if (asset.imageNodeId) {
      const imgNode = nodes.find((n) => n.id === asset.imageNodeId);
      const imageUrl =
        (imgNode?.data?.imageUrl as string | undefined)
        || asset.imageUrl;
      if (imageUrl) return imageUrl;
    }
    const bits = [asset.name, asset.summary, asset.visualNotes].filter(Boolean);
    return bits.join('，') || dramaName;
  });

  const chipRegex = /@\{([^:]+):([^}]+)\}/g;
  return cleaned.replace(chipRegex, (_match, nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return _match;
    // 文本节点的输出在 data.output 中
    const output = node.data.output as string | undefined;
    if (typeof output === 'string' && output.trim()) return output;
    // 图片节点的输出在 data.imageUrl 中
    const imageUrl = node.data.imageUrl as string | undefined;
    if (typeof imageUrl === 'string' && imageUrl.trim()) return imageUrl;
    // 视频 / 音频同理
    const videoUrl = node.data.videoUrl as string | undefined;
    if (typeof videoUrl === 'string' && videoUrl.trim()) return videoUrl;
    const audioUrl = node.data.audioUrl as string | undefined;
    if (typeof audioUrl === 'string' && audioUrl.trim()) return audioUrl;
    // 无法解析，保留原文
    return _match;
  });
}

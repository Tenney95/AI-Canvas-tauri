/**
 * nodes/shared/mentionEditorSources — @ 提及候选来源解析。
 * 收集画布上可被引用的生成节点（含上游连线输出）与工作流 IO 节点，
 * 解析出带缩略图、输出类型与自引用标记的提及条目，供提示词编辑器联想补全。
 */
import type { AppState } from '../../../store/useAppStore';
import type { BaseNodeData, NodeType, StoryboardCellOverride, WorkflowIONodeType } from '../../../types';
import { bestNodeThumb } from './mentionEditorDom';
import { resolveDramaVoiceRef } from '../../../services/dramaAssetPrompt';

export interface CanvasMentionItem {
  id: string;
  label: string;
  type: NodeType;
  displayId: number | undefined;
  hasOutput: boolean;
  outputType: 'image' | 'video' | 'audio' | 'text';
  thumbnailUrl: string | undefined;
  isSelf: boolean;
  /** 仅用于候选匹配；文件只保留名称，不暴露完整路径。 */
  searchValues?: Array<string | number | undefined | null>;
}

export interface WorkflowMentionItem {
  id: string;
  label: string;
  _ioNodeId: string;
  _ioType: WorkflowIONodeType;
}

/** 每个查询词可匹配不同字段，兼容全角字符与节点编号。 */
export function matchesMentionQuery(
  query: string,
  values: Array<string | number | undefined | null>,
): boolean {
  const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystacks = values.filter((value) => value != null).map((value) => normalize(String(value)));
  return terms.every((term) => haystacks.some((value) => value.includes(term)));
}

function nodeSearchValues(id: string, data: BaseNodeData): CanvasMentionItem['searchValues'] {
  return [
    id,
    data.label,
    data.displayId,
    data.displayId == null ? undefined : `#${data.displayId}`,
    data.fileName,
    data.filePath?.split(/[\\/]/).pop(),
  ];
}

export function resolveCanvasMentionNodes(
  nodeId: string | undefined,
  nodes: AppState['nodes'],
  edges: AppState['edges'],
  scope: 'connected' | 'project' = 'connected',
): CanvasMentionItem[] {
  if (!nodeId && scope === 'connected') return [];
  const currentNode = nodes.find((node) => node.id === nodeId);
  const rawSourceIds = new Set(edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source));
  if (currentNode?.parentId) {
    edges.filter((edge) => edge.target === currentNode.parentId)
      .forEach((edge) => rawSourceIds.add(edge.source));
  }

  const sourceNodeIds = new Set<string>();
  for (const sourceId of rawSourceIds) {
    const sourceNode = nodes.find((node) => node.id === sourceId);
    if (sourceNode?.type === 'group') {
      nodes.filter((node) => node.parentId === sourceId)
        .forEach((node) => sourceNodeIds.add(node.id));
    } else {
      sourceNodeIds.add(sourceId);
    }
  }

  const list: CanvasMentionItem[] = nodes
    .filter((node) => node.id !== nodeId && node.type !== 'group'
      && (scope === 'project'
        ? !!node.data.type && node.data.type !== 'canvas-note' && !node.data.hiddenByCharacterLibrary
        : sourceNodeIds.has(node.id)))
    .map((node) => ({
      id: node.id,
      label: (node.data.label as string) || '节点',
      type: node.data.type,
      displayId: node.data.displayId as number | undefined,
      hasOutput: !!node.data.output,
      outputType: node.data.imageUrl ? 'image' : node.data.videoUrl ? 'video' : node.data.audioUrl ? 'audio' : 'text',
      thumbnailUrl: bestNodeThumb(node.data),
      isSelf: false,
      searchValues: nodeSearchValues(node.id, node.data),
    }));

  const expanded: CanvasMentionItem[] = [];
  for (const item of list) {
    expanded.push(item);
    if (item.type !== 'ai-storyboard') continue;
    const storyboard = nodes.find((node) => node.id === item.id);
    if (!storyboard) continue;
    const data = storyboard.data as BaseNodeData;
    const cols = Math.max(1, data.storyboardCols || 3);
    const rows = Math.max(1, data.storyboardRows || 3);
    const extracted = data.storyboardExtracted ?? [];
    const overrides = data.storyboardOverrides ?? [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < cols; column += 1) {
        const index = row * cols + column;
        if (extracted[index] && !overrides[index]) continue;
        expanded.push({
          id: `${item.id}/cell/${index}`,
          label: `${item.label} · 第${row + 1}行${column + 1}列`,
          type: 'ai-image',
          displayId: undefined,
          hasOutput: true,
          outputType: 'image',
          thumbnailUrl: (overrides[index] as StoryboardCellOverride | null)?.url || data.imageUrl,
          isSelf: false,
          searchValues: [...(item.searchValues ?? []), `${item.id}/cell/${index}`, `第${row + 1}行${column + 1}列`],
        });
      }
    }
  }

  if (currentNode && currentNode.type !== 'group'
    && (scope !== 'project'
      || (!!currentNode.data.type && currentNode.data.type !== 'canvas-note' && !currentNode.data.hiddenByCharacterLibrary))) {
    const { output, imageUrl, videoUrl, audioUrl } = currentNode.data;
    if ((typeof output === 'string' && output.trim()) || imageUrl || videoUrl || audioUrl) {
      expanded.unshift({
        id: currentNode.id,
        label: currentNode.data.label || '节点',
        type: currentNode.data.type,
        displayId: currentNode.data.displayId,
        hasOutput: true,
        outputType: imageUrl ? 'image' : videoUrl ? 'video' : audioUrl ? 'audio' : 'text',
        thumbnailUrl: bestNodeThumb(currentNode.data),
        isSelf: true,
        searchValues: nodeSearchValues(currentNode.id, currentNode.data),
      });
    }
  }
  return expanded;
}

export function resolveWorkflowMentionNodes(
  selectedWorkflowId: string | undefined,
  ioNodes: Array<{ nodeId: string; title: string; type: WorkflowIONodeType }>,
): WorkflowMentionItem[] {
  if (!selectedWorkflowId) return [];
  return ioNodes.map((io) => ({
    id: `wf:${io.nodeId}`,
    label: io.title,
    _ioNodeId: io.nodeId,
    _ioType: io.type,
  }));
}

export function resolveDramaMentionItems(
  dramaAssets: AppState['dramaAssets'],
  query: string,
  nodeType?: NodeType,
  globalCharacters: AppState['globalCharacters'] = [],
) {
  const items = [
    ...[
      ...dramaAssets.characters,
      ...globalCharacters.map((asset) => ({ ...asset, id: `global/${asset.id}` })),
    ].map((asset) => ({
      id: asset.id,
      name: asset.name,
      aliases: asset.aliases,
      kind: asset.kind as string,
      imageNodeId: asset.imageNodeId,
      imageUrl: asset.imageUrl,
      referenceImages: asset.referenceImages,
      voice: nodeType === 'ai-audio' ? resolveDramaVoiceRef(asset) : null,
    })),
    ...dramaAssets.scenes.map((asset) => ({
      id: asset.id,
      name: asset.name,
      aliases: undefined,
      kind: asset.kind as string,
      imageNodeId: asset.imageNodeId,
      imageUrl: asset.imageUrl,
      referenceImages: undefined,
      voice: null,
    })),
    ...dramaAssets.props.map((asset) => ({
      id: asset.id,
      name: asset.name,
      aliases: undefined,
      kind: asset.kind as string,
      imageNodeId: asset.imageNodeId,
      imageUrl: asset.imageUrl,
      referenceImages: undefined,
      voice: null,
    })),
  ];
  const candidates = nodeType === 'ai-audio' ? items.filter((item) => item.voice) : items;
  // 分类数量和筛选共用完整候选，不能提前截断而丢失排在后面的场景或道具。
  if (!query) return candidates;
  return candidates.filter((asset) => matchesMentionQuery(query, [asset.name, asset.id, ...(asset.aliases ?? [])]));
}

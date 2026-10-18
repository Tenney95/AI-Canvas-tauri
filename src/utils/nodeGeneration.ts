import type { BaseNodeData, NodeType } from '../types';

/** 素材身份与生成能力分开：兼容原始节点，不迁移画布中的节点类型。 */
const GENERATION_TYPES: Partial<Record<NodeType, NodeType>> = {
  'source-text': 'ai-text',
  'source-image': 'ai-image',
  'source-video': 'ai-video',
  'source-audio': 'ai-audio',
  'ai-markdown': 'ai-text',
};

export function getGenerationNodeType(type: NodeType): NodeType;
export function getGenerationNodeType(type: string | undefined): string | undefined;
export function getGenerationNodeType(type: string | undefined): string | undefined {
  return type ? GENERATION_TYPES[type as NodeType] ?? type : type;
}

/** 普通生成节点沿用原对象，源节点只在本次调用中适配，正文与引用保持原值。 */
export function resolveGenerationNodeData(data: BaseNodeData | undefined): BaseNodeData | undefined {
  if (!data) return data;
  const type = getGenerationNodeType(data.type);
  return type === data.type ? data : { ...data, type };
}

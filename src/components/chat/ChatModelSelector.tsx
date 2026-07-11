/**
 * ChatModelSelector — 对话栏模型选择器包装
 *
 * 直接复用节点中使用的 ModelSelector 组件，实现与 TextNode / ImageNode / VideoNode
 * 完全一致的模型选择体验（相同的模型列表、分组、供应商、API Key 检查）。
 *
 * 桥接 chat config 与 ModelSelector 之间的数据格式差异：
 * - config.assistantXxxModelId ∈ GeneralModelConfig.id
 * - ModelSelector.selectedModel = `general/${config.assistantXxxModelId}`
 * - category → nodeType:  text→ai-text, image→ai-image, video→ai-video
 */
import { useCallback } from 'react';
import ModelSelector from '../nodes/shared/ModelSelector';
import type { ModelOption, NodeType } from '../../types';

const CATEGORY_NODE_TYPE_MAP: Record<string, NodeType> = {
  text: 'ai-text',
  image: 'ai-image',
  video: 'ai-video',
};

interface ChatModelSelectorProps {
  category: 'text' | 'image' | 'video';
  selectedId?: string;
  onSelect: (modelId: string | undefined) => void;
}

export default function ChatModelSelector({ category, selectedId, onSelect }: ChatModelSelectorProps) {
  const nodeType = CATEGORY_NODE_TYPE_MAP[category];

  // config ID → ModelSelector 的 'general/{id}' 格式
  const selectedModel = selectedId ? `general/${selectedId}` : undefined;

  const handleSelect = useCallback(
    (model: ModelOption) => {
      // 通用模型 value 为 'general/{id}'，剥离前缀还原为 config id；
      // 供应商模型 value 直接使用（resolveAssistantModel 负责查找对应配置）
      const id = model.value.startsWith('general/') ? model.value.slice('general/'.length) : model.value;
      onSelect(id);
    },
    [onSelect],
  );

  return (
    <ModelSelector
      nodeType={nodeType}
      selectedModel={selectedModel}
      onSelect={handleSelect}
    />
  );
}

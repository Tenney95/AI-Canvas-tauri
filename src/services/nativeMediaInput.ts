/** v2 输入合同：只有生成参数和配置参与摘要，产物与加载状态不参与。 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import type { AppState } from '../store/useAppStore';
import { generationInputSnapshot } from './chat/canvasNodeVersion';

export function nativeMediaInputMaterial(node: Node<BaseNodeData>, state: Pick<AppState, 'projects' | 'currentProjectId' | 'config' | 'customStyles'>): string {
  const settings = state.projects.find((project) => project.id === state.currentProjectId)?.settings;
  const kind = node.data.type === 'ai-image' ? 'image' : node.data.type === 'ai-audio' ? 'audio' : 'video';
  const modelRef = (node.data.model || settings?.defaultModels?.[kind])?.replace(/^general\//, '');
  const model = state.config.generalModels?.find((entry) => entry.id === modelRef);
  return JSON.stringify(['media-input-v2', node.type, generationInputSnapshot(node.data, settings), model, state.customStyles]);
}

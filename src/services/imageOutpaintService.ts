/** 扩图只创建一个生成节点；独立垫图随节点保存并交给统一媒体执行器。 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import type { OutpaintSettings } from '../types/media';
import { t } from '../i18n';
import { useAppStore } from '../store/useAppStore';
import { derivedNodePlacement, generateId } from '../store/store.utils';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation, type CanvasDerivationGuard } from './canvasDerivationGuard';
import type { GenerationResult } from './generationService';
import { executeGenerationWithImagePromptChoice } from './imagePromptOverflowService';

export async function startImageOutpaint(
  sourceNodeId: string,
  expectedImageUrl: string,
  compositeDataUrl: string,
  settings: OutpaintSettings,
  sourceGuard?: CanvasDerivationGuard,
): Promise<GenerationResult> {
  const store = useAppStore.getState();
  const source = store.nodes.find((node) => node.id === sourceNodeId);
  const derivation = sourceGuard ?? (source && registerCanvasDerivation(store, sourceNodeId));
  if (!source || !derivation) {
    if (derivation) completeCanvasDerivation(derivation);
    store.showToast(t('图片节点已失效，请重试'), 'error');
    return { success: false };
  }
  const nodeId = `node-${generateId()}`;
  try {
    if (derivation.sourceNodeId !== sourceNodeId || (source.data.imageUrl || source.data.thumbnailUrl) !== expectedImageUrl
      || !isCanvasDerivationFresh(derivation, useAppStore.getState())) {
      store.showToast(t('图片节点已失效，请重试'), 'error');
      return { success: false };
    }
    const prompt = 'Outpaint and naturally extend this image to fill the entire frame. '
      + 'Seamlessly continue the existing scene, lighting, perspective, colors and art style into the transparent/empty areas. '
      + 'Keep the original content completely unchanged and ensure smooth transitions at the edges.';
    const width = Number(source.data.nodeWidth) || 280;
    const node: Node<BaseNodeData> = {
      id: nodeId,
      type: 'ai-image',
      ...derivedNodePlacement(source),
      data: {
        type: 'ai-image', role: 'generator', status: 'idle',
        label: t('{name} 扩图', { name: source.data.label || t('图像') }),
        prompt: settings.prompt.trim() ? `${prompt} ${settings.prompt.trim()}` : prompt,
        model: settings.model, provider: settings.provider,
        workflowId: settings.workflowId,
        workflowInputs: settings.workflowInputs ? { ...settings.workflowInputs } : undefined,
        aspectRatio: settings.size, imageSize: source.data.imageSize || '2K', batchCount: 1,
        // 预览可以被结果替换；真正的输入保持独立，重试不会改用上次产物。
        imageUrl: compositeDataUrl, imageWidth: settings.width, imageHeight: settings.height,
        nodeWidth: width, nodeHeight: Math.max(120, Math.round(width * settings.height / settings.width)),
        outpaintInput: { url: compositeDataUrl, width: settings.width, height: settings.height },
      },
    };
    store.addNode(node);
  } finally {
    completeCanvasDerivation(derivation);
  }
  return executeGenerationWithImagePromptChoice(nodeId);
}

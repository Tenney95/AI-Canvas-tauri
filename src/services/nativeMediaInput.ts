/** 原生媒体回执的输入材料，只在内存中用于比对和计算摘要。 */
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import type { AppState } from '../store/useAppStore';
import { generationInputSnapshot } from './chat/canvasNodeVersion';
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { sha256BytesHex } from './mediaDataUrl';
import { videoInputFingerprintMaterial } from './videoBatchPlanning';

type MediaInputState = Pick<AppState, 'projects' | 'currentProjectId' | 'config' | 'customStyles'>
  & Partial<Pick<AppState, 'nodes' | 'edges' | 'workflows' | 'dramaAssets'>>;
type FingerprintScheme = NativeMediaTaskRecord['fingerprintScheme'];

export function nativeMediaInputMaterial(node: Node<BaseNodeData>, state: MediaInputState,
  scheme: 'media-input-v2' | 'media-input-v3' = 'media-input-v2', dramaAssets = state.dramaAssets): string {
  const settings = state.projects.find((project) => project.id === state.currentProjectId)?.settings;
  const kind = ['ai-image', 'ai-animation', 'ai-panorama'].includes(node.data.type) ? 'image' : node.data.type === 'ai-audio' ? 'audio' : 'video';
  const modelRef = (node.data.model || settings?.defaultModels?.[kind])?.replace(/^general\//, '');
  const model = state.config.generalModels?.find((entry) => entry.id === modelRef);
  const original = ['media-input-v2', node.type, generationInputSnapshot(node.data, settings), model, state.customStyles];
  if (scheme === 'media-input-v2') return JSON.stringify(original);
  const edges = (state.edges ?? []).filter((edge) => edge.target === node.id);
  const referenced = new Set(edges.map((edge) => edge.source));
  const text = JSON.stringify([node.data.prompt, node.data.workflowInputs, node.data.videoReferences, node.data.comfyRefmods]);
  for (const match of text.matchAll(/@\{([^}:]+)(?::[^}]*)?\}/g)) referenced.add(match[1]);
  const sources = [...referenced].sort().map((id) => {
    const source = state.nodes?.find((item) => item.id === id);
    return source ? [id, source.type, generationInputSnapshot(source.data, settings),
      source.data.imageUrl, source.data.videoUrl, source.data.audioUrl, source.data.output,
      source.data.relativePath, source.data.filePath, source.data.assetId,
      'storageRootRef' in source.data ? source.data.storageRootRef : undefined] : [id, null];
  });
  const providerId = model?.providerConfigId ?? node.data.provider ?? (node.data.model || settings?.defaultModels?.[kind])?.split('/')[0];
  const provider = providerId ? state.config.providers[providerId] : undefined;
  const workflow = state.workflows?.find((item) => item.id === node.data.workflowId);
  return JSON.stringify(['media-input-v3', original, edges.map((edge) => [edge.id, edge.source, edge.sourceHandle, edge.targetHandle]), sources,
    workflow, provider && { baseUrl: provider.baseUrl, selectedModels: provider.selectedModels }, dramaAssets]);
}

export function nativeCanvasMediaInputMaterial(node: Node<BaseNodeData>,
  state: MediaInputState & Parameters<typeof videoInputFingerprintMaterial>[1], scheme: FingerprintScheme): string {
  if (scheme !== 'media-input-v2' && scheme !== 'media-input-v3') return videoInputFingerprintMaterial(node, state);
  const library = state.dramaAssets;
  // 打开短剧资产页会更新浏览时间，画布任务只关心里面的素材有没有变。
  const assets = scheme === 'media-input-v3' && library?.lastViewedAt !== undefined
    ? { ...library, lastViewedAt: undefined } : library;
  return nativeMediaInputMaterial(node, state, scheme, assets);
}

export async function matchesNativeCanvasMediaInputFingerprint(node: Node<BaseNodeData>, state: MediaInputState,
  scheme: FingerprintScheme, material: string, expectedDigest: string): Promise<boolean> {
  const encoder = new TextEncoder();
  if (await sha256BytesHex(encoder.encode(material)) === expectedDigest) return true;
  // 老 v3 回执连浏览时间一起算，只有原来的完整摘要仍然对得上才能回填。
  if (scheme !== 'media-input-v3' || state.dramaAssets?.lastViewedAt === undefined) return false;
  return await sha256BytesHex(encoder.encode(nativeMediaInputMaterial(node, state, scheme))) === expectedDigest;
}

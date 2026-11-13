import type { Node } from '@xyflow/react';
import { t } from '../i18n';
import type { BaseNodeData } from '../types';
import type { VideoReferenceItem } from '../types/aiTypes';
import { buildDramaMentionId, formatDramaMention, parseDramaMentionId, type DramaCharacter } from '../types/dramaAssets';
import type { CanvasContext } from '../types/project';
import { matchesAssetUsage } from './assetUsageService';
import { resolveDramaAssetImageRef } from './dramaAssetPrompt';
import { isTauriAssetUrl } from '../utils/mediaUrl';

const editableNodeTypes = new Set(['ai-text', 'ai-markdown', 'ai-image', 'ai-video', 'ai-audio', 'ai-animation', 'ai-panorama']);
const safeReferenceId = (id: string) => /^[A-Za-z0-9_.-]{1,256}$/.test(id) && id !== 'all';

export interface CharacterVisualReferenceChange {
  nodeId: string;
  label: string;
  originalPrompt?: string;
  nextPrompt?: string;
  originalVideoReferences?: VideoReferenceItem[];
  nextVideoReferences?: VideoReferenceItem[];
  promptMatches: number;
  videoMatches: number;
}

export interface CharacterVisualReferencePlan {
  context: CanvasContext;
  characterId: string;
  referenceId: string;
  referenceUrl: string;
  changes: CharacterVisualReferenceChange[];
}

export function planCharacterVisualReferences(
  context: CanvasContext, nodes: Node<BaseNodeData>[], character: DramaCharacter, referenceId: string,
  blockedNodeIds: ReadonlySet<string> = new Set(),
): CharacterVisualReferencePlan {
  if (!safeReferenceId(character.id) || !safeReferenceId(referenceId)) throw new Error(t('角色参考图身份无效'));
  const selected = resolveDramaAssetImageRef(character, nodes, referenceId);
  if (!selected || !isTauriAssetUrl(selected.imageUrl)) throw new Error(t('请先把目标图片保存为角色参考图'));
  const known = new Set((character.referenceImages ?? []).map((image) => image.id));
  const assetTarget = { kind: 'creative', scope: 'project', assetKind: 'character', assetId: character.id,
    ownerId: context.projectId, name: character.name } as const;
  const usageContext = { ownerId: context.projectId, projectKinds: new Map([[character.id, character.kind]]) };
  const roleVideoId = `character:${character.id}`;

  const changes = nodes.flatMap((node): CharacterVisualReferenceChange[] => {
    if (blockedNodeIds.has(node.id) || !editableNodeTypes.has(node.data.type) || node.data.role === 'source' || node.data.status === 'loading'
      || node.data.mediaTaskState || node.data.videoTaskState || node.data.generationStartedAt) return [];
    const originalPrompt = node.data.prompt;
    let promptMatches = 0;
    const nextPrompt = originalPrompt && matchesAssetUsage(originalPrompt, assetTarget, usageContext)
      ? originalPrompt.replace(/@drama\{([^:}\r\n]+):([^}\r\n]*)\}/g, (raw, id: string, label: string) => {
        const parsed = parseDramaMentionId(id);
        if (parsed.assetId !== character.id || !parsed.referenceImageId || parsed.referenceImageId === referenceId
          || !known.has(parsed.referenceImageId) || parsed.mergeAll || parsed.actionId !== undefined
          || parsed.voiceClipId !== undefined) return raw;
        promptMatches++;
        return formatDramaMention(buildDramaMentionId(character.id, referenceId), label);
      }) : originalPrompt;

    const originalVideoReferences = node.data.videoReferences;
    let videoMatches = 0;
    const nextVideoReferences = node.data.type === 'ai-video' ? originalVideoReferences?.map((reference) => {
      if (reference.id !== roleVideoId || reference.kind !== 'character' || reference.role !== 'reference'
        || (reference.mediaKind && reference.mediaKind !== 'image') || reference.provider || reference.sourceNodeId
        || reference.url === selected.imageUrl) return reference;
      videoMatches++;
      const updated: VideoReferenceItem & { filePath?: string; relativePath?: string } = { ...reference, url: selected.imageUrl };
      delete updated.previewUrl;
      delete updated.assetId;
      delete updated.filePath;
      delete updated.relativePath;
      return updated;
    }) : undefined;

    if (!promptMatches && !videoMatches) return [];
    return [{ nodeId: node.id, label: node.data.label || node.id, promptMatches, videoMatches,
      ...(promptMatches ? { originalPrompt, nextPrompt } : {}),
      ...(videoMatches ? { originalVideoReferences, nextVideoReferences } : {}) }];
  });

  return { context, characterId: character.id, referenceId, referenceUrl: selected.imageUrl, changes };
}

/**
 * batchExecute — 批量执行节点工具函数
 *
 * 策略：
 * - 有连线关系的节点 → 按拓扑序依次执行（保证依赖顺序）
 * - 没有连线的独立节点 → 并发执行（Promise.all）
 * - 两组之间也并发执行
 */
import type { Node, Edge } from '@xyflow/react';
import type { BaseNodeData, OutputHistoryEntry } from '../types';
import { ANIMATION_FRAME_GRIDS } from '../types';
import {
  generateText,
  generateImage,
  generateVideo,
  generateAudio,
  buildPanoramaPrompt,
} from '../services/aiService';
import {
  buildAnimationSpritePrompt,
  resolveAnimationSheetAspectRatio,
} from '../services/ai/animationPrompt';
import { persistAudioGenerationResult } from '../services/ai/generateAudio';
import { downloadUrlAndSave } from '../services/fileService';

export interface BatchContext {
  commitToHistory: () => void;
  updateNodeDataTransient: (nodeId: string, data: Partial<BaseNodeData>) => void;
  recordOutputHistory: (
    nodeId: string,
    entry: Omit<OutputHistoryEntry, 'id' | 'projectId'>,
  ) => Promise<void>;
  currentProjectId: string | null;
}

type AINodeType =
  | 'ai-text'
  | 'ai-image'
  | 'ai-animation'
  | 'ai-panorama'
  | 'ai-video'
  | 'ai-audio';

const EXECUTABLE_NODE_TYPES = new Set<AINodeType>([
  'ai-text',
  'ai-image',
  'ai-animation',
  'ai-panorama',
  'ai-video',
  'ai-audio',
]);

// ── 执行单个节点 ──
async function executeOneNode(node: Node<BaseNodeData>, ctx: BatchContext): Promise<boolean> {
  const d = node.data!;
  const nt = d.type as AINodeType;
  const prompt = (d.prompt as string) || '';

  ctx.updateNodeDataTransient(node.id, { status: 'loading', error: undefined });
  try {
    if (nt === 'ai-text') {
      const result = await generateText({ prompt, model: d.model!, provider: d.provider! });
      const { postProcessDramaExtractOutput } = await import('../services/dramaAssetExtract');
      const processed = postProcessDramaExtractOutput(prompt, result);
      ctx.updateNodeDataTransient(node.id, { output: processed.output, status: 'success' });
      ctx.recordOutputHistory(node.id, {
        nodeId: node.id,
        nodeLabel: d.label,
        timestamp: Date.now(),
        prompt,
        output: processed.output,
        nodeType: 'ai-text',
        model: d.model!,
        provider: d.provider!,
        status: 'success',
      });
      if (processed.ok && processed.parsed) {
        const { useAppStore } = await import('../store/useAppStore');
        useAppStore.getState().mergeDramaExtract(processed.parsed, {
          sourceNodeId: node.id,
          modelId: d.model,
        });
      }
    } else if (nt === 'ai-image' || nt === 'ai-animation') {
      const isAnimation = nt === 'ai-animation';
      const imageSize = (d.imageSize as string) || '2K';
      const animationAction = d.animationAction ?? 'idle';
      const animationFrames = d.animationFrames ?? 8;
      const aspectRatio = isAnimation
        ? resolveAnimationSheetAspectRatio(animationFrames, d.provider!)
        : (d.aspectRatio as string) || '1:1';
      const requestPrompt = isAnimation
        ? buildAnimationSpritePrompt(prompt, animationAction, animationFrames, aspectRatio)
        : prompt;
      const result = await generateImage({
        prompt: requestPrompt,
        model: d.model!,
        provider: d.provider!,
        imageSize,
        aspectRatio,
        workflowId: d.workflowId,
        workflowInputs: d.workflowInputs,
        nodeId: node.id,
      });
      const saved = ctx.currentProjectId
        ? await downloadUrlAndSave(result.url, ctx.currentProjectId, 'ai-image', d.label).catch(() => null)
        : null;
      const mediaUrl = saved?.assetUrl || result.url;
      ctx.updateNodeDataTransient(node.id, {
        imageUrl: mediaUrl,
        sourceUrl: result.url,
        filePath: saved?.filePath,
        thumbnailUrl: result.url,
        output: result.url,
        status: 'success',
        imageWidth: result.width,
        imageHeight: result.height,
        ...(isAnimation ? { aspectRatio } : {}),
      });
      {
        const { useAppStore } = await import('../store/useAppStore');
        useAppStore.getState().syncDramaAssetImageFromNode?.(node.id, mediaUrl);
      }
      ctx.recordOutputHistory(node.id, {
        nodeId: node.id,
        nodeLabel: d.label,
        timestamp: Date.now(),
        prompt,
        output: result.url,
        nodeType: nt,
        model: d.model!,
        provider: d.provider!,
        status: 'success',
        mediaUrl: result.url,
        filePath: saved?.filePath,
        params: isAnimation
          ? {
              imageSize,
              aspectRatio,
              animationAction,
              animationFrames,
              grid: ANIMATION_FRAME_GRIDS[animationFrames],
            }
          : { imageSize, aspectRatio },
      });
    } else if (nt === 'ai-panorama') {
      const imageSize = (d.imageSize as string) || '2K';
      const aspectRatio = (d.aspectRatio as string) || '2:1';
      const result = await generateImage({
        prompt: buildPanoramaPrompt(prompt),
        model: d.model!,
        provider: d.provider!,
        imageSize,
        aspectRatio,
        workflowId: d.workflowId,
        workflowInputs: d.workflowInputs,
        nodeId: node.id,
      });
      const saved = ctx.currentProjectId
        ? await downloadUrlAndSave(
            result.url,
            ctx.currentProjectId,
            'ai-panorama',
            d.label,
          ).catch(() => null)
        : null;
      const mediaUrl = saved?.assetUrl || result.url;
      ctx.updateNodeDataTransient(node.id, {
        imageUrl: mediaUrl,
        sourceUrl: result.url,
        filePath: saved?.filePath,
        thumbnailUrl: result.url,
        output: result.url,
        status: 'success',
        imageWidth: result.width,
        imageHeight: result.height,
      });
      ctx.recordOutputHistory(node.id, {
        nodeId: node.id,
        nodeLabel: d.label,
        timestamp: Date.now(),
        prompt,
        output: result.url,
        nodeType: 'ai-panorama',
        model: d.model!,
        provider: d.provider!,
        status: 'success',
        mediaUrl: result.url,
        filePath: saved?.filePath,
        params: { imageSize, aspectRatio },
      });
    } else if (nt === 'ai-video') {
      const result = await generateVideo({
        prompt,
        model: d.model!,
        provider: d.provider!,
        videoResolution: (d.videoResolution as number) || 832,
        videoFps: (d.videoFps as number) || 24,
        videoFrames: (d.videoFrames as number) || 77,
        seedanceResolution: (d.seedanceResolution as string) || '720p',
        seedanceRatio: (d.seedanceRatio as string) || '16:9',
        seedanceDuration: (d.seedanceDuration as number) || 5,
        generateAudio: d.generateAudio as boolean | undefined,
        workflowId: d.workflowId,
        workflowInputs: d.workflowInputs,
        nodeId: node.id,
      });
      const saved = ctx.currentProjectId
        ? await downloadUrlAndSave(result.url, ctx.currentProjectId, 'ai-video', d.label).catch(() => null)
        : null;
      const mediaUrl = saved?.assetUrl || result.url;
      ctx.updateNodeDataTransient(node.id, {
        videoUrl: mediaUrl,
        sourceUrl: result.url,
        filePath: saved?.filePath,
        thumbnailUrl: result.url,
        output: result.url,
        status: 'success',
      });
      ctx.recordOutputHistory(node.id, {
        nodeId: node.id,
        nodeLabel: d.label,
        timestamp: Date.now(),
        prompt,
        output: result.url,
        nodeType: 'ai-video',
        model: d.model!,
        provider: d.provider!,
        status: 'success',
        mediaUrl: result.url,
        filePath: saved?.filePath,
        params: {
          videoResolution: d.videoResolution,
          videoFps: d.videoFps,
          videoFrames: d.videoFrames,
          seedanceResolution: d.seedanceResolution,
          seedanceRatio: d.seedanceRatio,
          seedanceDuration: d.seedanceDuration,
          generateAudio: d.generateAudio,
        },
      });
    } else {
      // ai-audio
      const result = await generateAudio({
        prompt,
        model: d.model!,
        provider: d.provider!,
        audioVoice: d.audioVoice,
        audioFormat: d.audioFormat,
        audioSpeed: d.audioSpeed,
        musicTitle: d.musicTitle,
        musicLyrics: d.musicLyrics,
        musicBpm: d.musicBpm,
        musicDuration: d.musicDuration,
        autoGenerateLyrics: d.autoGenerateLyrics,
        workflowId: d.workflowId,
        workflowInputs: d.workflowInputs,
        nodeId: node.id,
      });
      const persisted = await persistAudioGenerationResult(result, ctx.currentProjectId, d.label);
      ctx.updateNodeDataTransient(node.id, {
        audioUrl: persisted.mediaUrl,
        sourceUrl: persisted.sourceUrl,
        filePath: persisted.filePath,
        thumbnailUrl: persisted.mediaUrl,
        output: persisted.outputUrl,
        musicClipId: result.clipId,
        ...(result.title ? { musicTitle: result.title } : {}),
        ...(result.lyrics ? { musicLyrics: result.lyrics } : {}),
        status: 'success',
      });
      ctx.recordOutputHistory(node.id, {
        nodeId: node.id,
        nodeLabel: d.label,
        timestamp: Date.now(),
        prompt,
        output: persisted.outputUrl,
        nodeType: 'ai-audio',
        model: d.model!,
        provider: d.provider!,
        status: 'success',
        mediaUrl: persisted.mediaUrl,
        filePath: persisted.filePath,
        params: {
          audioVoice: d.audioVoice,
          audioFormat: d.audioFormat,
          audioSpeed: d.audioSpeed,
          musicTitle: result.title || d.musicTitle,
          musicBpm: d.musicBpm,
          musicDuration: d.musicDuration,
          autoGenerateLyrics: d.autoGenerateLyrics,
        },
      });
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : typeof err === 'string' && err.trim() ? err : '生成失败';
    ctx.updateNodeDataTransient(node.id, { status: 'error', error: msg });
    ctx.recordOutputHistory(node.id, {
      nodeId: node.id,
      nodeLabel: d.label,
      timestamp: Date.now(),
      prompt,
      output: '',
      nodeType: nt,
      model: d.model!,
      provider: d.provider!,
      status: 'error',
      error: msg,
    });
    return false;
  }
}

// ── 过滤可执行节点 ──
function isExecutableNode(node: Node<BaseNodeData>, nodeIdSet: Set<string>): boolean {
  return Boolean(
    nodeIdSet.has(node.id)
      && node.type !== 'group'
      && node.data?.type
      && EXECUTABLE_NODE_TYPES.has(node.data.type as AINodeType)
      && node.data.model
      && node.data.provider
      && (node.data.prompt || '').trim()
      && node.data.status !== 'loading',
  );
}

export function hasBatchExecutableNodes(
  nodeIds: string[],
  nodes: Node<BaseNodeData>[],
): boolean {
  const nodeIdSet = new Set(nodeIds);
  return nodes.some((node) => isExecutableNode(node, nodeIdSet));
}

function filterExecutable(nodeIds: string[], nodes: Node<BaseNodeData>[]): Node<BaseNodeData>[] {
  const nodeIdSet = new Set(nodeIds);
  return nodes.filter((node) => isExecutableNode(node, nodeIdSet));
}

// ── 拓扑排序（先压缩强连通分量，确保环内节点也进入结果）──
function topologicalSort(
  nodeIds: string[],
  edges: { source: string; target: string }[],
): string[] {
  const idSet = new Set(nodeIds);
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
  }
  for (const e of edges) {
    if (idSet.has(e.source) && idSet.has(e.target)) {
      adjacency.get(e.source)!.push(e.target);
    }
  }

  const inputOrder = new Map(nodeIds.map((id, index) => [id, index]));
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (id: string) => {
    indices.set(id, nextIndex);
    lowLinks.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);

    for (const target of adjacency.get(id) || []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id)!, indices.get(target)!));
      }
    }

    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    component.sort((left, right) => inputOrder.get(left)! - inputOrder.get(right)!);
    components.push(component);
  };

  for (const id of nodeIds) {
    if (!indices.has(id)) visit(id);
  }

  const componentByNode = new Map<string, number>();
  const componentRank = components.map((component, componentIndex) => {
    for (const id of component) componentByNode.set(id, componentIndex);
    return Math.min(...component.map((id) => inputOrder.get(id)!));
  });
  const outgoing = components.map(() => new Set<number>());
  const indegree = components.map(() => 0);
  for (const [source, targets] of adjacency) {
    const sourceComponent = componentByNode.get(source)!;
    for (const target of targets) {
      const targetComponent = componentByNode.get(target)!;
      if (
        sourceComponent !== targetComponent
        && !outgoing[sourceComponent].has(targetComponent)
      ) {
        outgoing[sourceComponent].add(targetComponent);
        indegree[targetComponent] += 1;
      }
    }
  }

  const queue = components
    .map((_, index) => index)
    .filter((index) => indegree[index] === 0)
    .sort((left, right) => componentRank[left] - componentRank[right]);
  const order: string[] = [];
  while (queue.length > 0) {
    const componentIndex = queue.shift()!;
    order.push(...components[componentIndex]);
    for (const targetComponent of outgoing[componentIndex]) {
      indegree[targetComponent] -= 1;
      if (indegree[targetComponent] === 0) {
        queue.push(targetComponent);
        queue.sort((left, right) => componentRank[left] - componentRank[right]);
      }
    }
  }

  return order;
}

// ── 主入口 ──
export async function batchExecuteNodes(
  nodeIds: string[],
  nodes: Node<BaseNodeData>[],
  edges: Edge[],
  ctx: BatchContext,
): Promise<{ ok: number; fail: number }> {
  const toRun = filterExecutable(nodeIds, nodes);
  if (toRun.length === 0) return { ok: 0, fail: 0 };
  ctx.commitToHistory();

  // Identify which nodes have edges between them
  const executableIds = new Set(toRun.map((node) => node.id));
  const connectedIds = new Set<string>();
  for (const e of edges) {
    if (executableIds.has(e.source) && executableIds.has(e.target)) {
      connectedIds.add(e.source);
      connectedIds.add(e.target);
    }
  }

  // Split: connected vs isolated
  const connectedNodes = toRun.filter((n) => connectedIds.has(n.id));
  const isolatedNodes = toRun.filter((n) => !connectedIds.has(n.id));

  // Topological sort for connected nodes
  const order = topologicalSort(
    connectedNodes.map((n) => n.id),
    edges,
  );
  const orderedConnected = order
    .map((id) => connectedNodes.find((n) => n.id === id))
    .filter(Boolean) as Node<BaseNodeData>[];

  let ok = 0,
    fail = 0;

  const runConnected = async () => {
    for (const node of orderedConnected) {
      const success = await executeOneNode(node, ctx);
      if (success) ok++;
      else fail++;
    }
  };

  const runIsolated = async () => {
    const results = await Promise.all(isolatedNodes.map((n) => executeOneNode(n, ctx)));
    for (const r of results) {
      if (r) ok++;
      else fail++;
    }
  };

  // Run connected (sequential) and isolated (parallel) concurrently
  await Promise.all([runConnected(), runIsolated()]);

  return { ok, fail };
}

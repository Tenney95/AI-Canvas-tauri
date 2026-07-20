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
import { generateText, generateImage, generateVideo, generateAudio } from '../services/aiService';
import { persistAudioGenerationResult } from '../services/ai/generateAudio';
import { downloadUrlAndSave } from '../services/fileService';

export interface BatchContext {
  updateNodeData: (nodeId: string, data: Partial<BaseNodeData>) => void;
  recordOutputHistory: (nodeId: string, entry: Omit<OutputHistoryEntry, 'id'>) => Promise<void>;
  currentProjectId: string | null;
}

type AINodeType = 'ai-text' | 'ai-image' | 'ai-video' | 'ai-audio';

// ── 执行单个节点 ──
async function executeOneNode(node: Node<BaseNodeData>, ctx: BatchContext): Promise<boolean> {
  const d = node.data!;
  const nt = d.type as AINodeType;
  const prompt = (d.prompt as string) || '';

  ctx.updateNodeData(node.id, { status: 'loading', error: undefined });
  try {
    if (nt === 'ai-text') {
      const result = await generateText({ prompt, model: d.model!, provider: d.provider! });
      const { postProcessDramaExtractOutput } = await import('../services/dramaAssetExtract');
      const processed = postProcessDramaExtractOutput(prompt, result);
      ctx.updateNodeData(node.id, { output: processed.output, status: 'success' });
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
    } else if (nt === 'ai-image') {
      const result = await generateImage({
        prompt,
        model: d.model!,
        provider: d.provider!,
        imageSize: (d.imageSize as string) || '2K',
        aspectRatio: (d.aspectRatio as string) || '1:1',
        workflowId: d.workflowId,
        workflowInputs: d.workflowInputs,
        nodeId: node.id,
      });
      const saved = ctx.currentProjectId
        ? await downloadUrlAndSave(result.url, ctx.currentProjectId, 'ai-image', d.label).catch(() => null)
        : null;
      const mediaUrl = saved?.assetUrl || result.url;
      ctx.updateNodeData(node.id, {
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
        nodeType: 'ai-image',
        model: d.model!,
        provider: d.provider!,
        status: 'success',
        mediaUrl: result.url,
        filePath: saved?.filePath,
        params: { imageSize: d.imageSize, aspectRatio: d.aspectRatio },
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
        generateAudio: (d.generateAudio as boolean) || false,
        workflowId: d.workflowId,
        workflowInputs: d.workflowInputs,
        nodeId: node.id,
      });
      const saved = ctx.currentProjectId
        ? await downloadUrlAndSave(result.url, ctx.currentProjectId, 'ai-video', d.label).catch(() => null)
        : null;
      const mediaUrl = saved?.assetUrl || result.url;
      ctx.updateNodeData(node.id, {
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
      ctx.updateNodeData(node.id, {
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
    ctx.updateNodeData(node.id, { status: 'error', error: msg });
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
function filterExecutable(nodeIds: string[], nodes: Node<BaseNodeData>[]): Node<BaseNodeData>[] {
  return nodes.filter(
    (n) =>
      nodeIds.includes(n.id) &&
      n.type !== 'group' &&
      n.data?.type &&
      ['ai-text', 'ai-image', 'ai-video', 'ai-audio'].includes(n.data.type) &&
      n.data?.model &&
      n.data?.provider &&
      (n.data?.prompt || '').trim() &&
      n.data?.status !== 'loading',
  );
}

// ── 拓扑排序（Kahn 算法）─ ─
function topologicalSort(
  nodeIds: string[],
  edges: { source: string; target: string }[],
): string[] {
  const idSet = new Set(nodeIds);

  // Build adjacency and indegree (only edges within the set)
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
    indegree.set(id, 0);
  }

  for (const e of edges) {
    if (idSet.has(e.source) && idSet.has(e.target)) {
      adjacency.get(e.source)!.push(e.target);
      indegree.set(e.target, (indegree.get(e.target) || 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const neighbor of adjacency.get(current) || []) {
      const newDeg = indegree.get(neighbor)! - 1;
      indegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
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

  // Identify which nodes have edges between them
  const connectedIds = new Set<string>();
  for (const e of edges) {
    if (nodeIds.includes(e.source) && nodeIds.includes(e.target)) {
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

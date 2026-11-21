/**
 * pluginNodeSetPreparation — 准备插件返回的节点集、资源文件和视频预检，并提供回滚。
 */
import { invoke } from '@tauri-apps/api/core';
import { getNodeBounds } from '../../utils/nodeBounds';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import type {
  PluginModelSummary,
  PluginNodeSetData,
  PluginJsonValue,
  PluginInvocationResources,
  PluginInvocationIdentity,
  PluginNativeMediaArtifactRef,
  PluginNodeSetVideoGeneration,
} from '../../types/plugin';
import { useAppStore } from '../../store/useAppStore';
import { computeImageNodeDimensions, derivedNodePlacement, generateId } from '../../store/store.utils';
import { moveToTrash, saveBinaryToProjectData } from '../fileService';
import { sha256BytesHex } from '../mediaDataUrl';
import { inspectVideoNode } from '../videoBatchPlanning';
import type { VideoPreflightItem } from '../../types/videoBatch';
import { readPluginDerivedResourceForOutput, type PluginResourceReadContext } from './pluginResourceService';
import { buildPluginModelCatalog } from './pluginModelCatalog';
import { rewritePluginPromptReferences } from './pluginPromptReferenceService';
import { recordValue } from './pluginRuntimeContract';

async function readNativeMediaArtifact(
  identity: PluginInvocationIdentity,
  artifact: PluginNativeMediaArtifactRef,
  assertFresh: () => void,
): Promise<Uint8Array> {
  assertFresh();
  const raw = await invoke<unknown>('read_plugin_media_artifact', { identity, artifactId: artifact.artifactId });
  assertFresh();
  if (!Array.isArray(raw) || raw.length !== artifact.size
    || raw.some((byte) => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('原生视频产物字节或大小无效');
  }
  const bytes = Uint8Array.from(raw as number[]);
  if (bytes[4] !== 102 || bytes[5] !== 116 || bytes[6] !== 121 || bytes[7] !== 112
    || await sha256BytesHex(bytes) !== artifact.sha256) throw new Error('原生视频产物文件头或摘要不匹配');
  assertFresh();
  return bytes;
}

interface PreparedPluginNodeSet {
  nodes: Node<BaseNodeData>[];
  edges: Edge[];
  nodeIdsByKey: Record<string, string>;
  rollback: () => Promise<void>;
  assertGenerationModelsFresh: () => void;
  assertReferencesFresh: () => Promise<void>;
  videoPreflight: VideoPreflightItem[];
}

/** 宿主后台物料编排的显示位置；不从插件返回值或 UI JSON 解析。 */
export type PluginMaterialLayout = { position: { x: number; y: number }; nodeWidth: number; nodeHeight: number; gap: number };

export async function preparePluginNodeSet(options: {
  nodeSet: PluginNodeSetData;
  sourceNode: Node<BaseNodeData>;
  projectId: string;
  resourceContext: PluginResourceReadContext;
  assertFresh: () => void;
  artifacts?: PluginNativeMediaArtifactRef[];
  identity?: PluginInvocationIdentity;
  models: PluginModelSummary[];
  resources: PluginInvocationResources;
  materialLayout?: PluginMaterialLayout;
}): Promise<PreparedPluginNodeSet> {
  const savedPaths: string[] = [];
  const originalReferenceData = options.nodeSet.nodes.map((item) => item.data);
  // 仅已授权的调用级 token 可回填为宿主规范引用；路径不经过插件/Python。
  const rewriteValue = async (value: PluginJsonValue): Promise<PluginJsonValue> => {
    if (typeof value === 'string') return rewritePluginPromptReferences(value, { context: options.resourceContext, resources: options.resources });
    if (Array.isArray(value)) return Promise.all(value.map(rewriteValue));
    if (value && typeof value === 'object') {
      const entries: Array<[string, PluginJsonValue]> = [];
      for (const [key, item] of Object.entries(value)) entries.push([key, await rewriteValue(item)]);
      return Object.fromEntries(entries);
    }
    return value;
  };
  if (options.resourceContext.permissions.includes('prompt.references.read')) {
    const rewritten: PluginNodeSetData['nodes'] = [];
    for (const item of options.nodeSet.nodes) {
      const data = await rewriteValue(item.data) as Record<string, PluginJsonValue>;
      options.assertFresh();
      rewritten.push({ ...item, data });
    }
    options.nodeSet = { ...options.nodeSet, nodes: rewritten };
  } else if (JSON.stringify(options.nodeSet.nodes).includes('@{plugin-ref-')) {
    throw new Error('插件未声明 prompt.references.read 权限');
  }
  const assertReferencesFresh = async () => {
    if (options.resourceContext.permissions.includes('prompt.references.read')) {
      for (const data of originalReferenceData) await rewriteValue(data);
    }
    options.assertFresh();
  };
  const { resolveMediaModel } = options.nodeSet.nodes.some((item) => item.generation)
    ? await import('../ai/generationRuntime') : { resolveMediaModel: undefined };
  const resolveGeneration = (generation: PluginNodeSetVideoGeneration) => {
    const state = useAppStore.getState();
    if (!options.models.some((model) => model.id === generation.modelId && model.category === 'video')
      || !buildPluginModelCatalog(state.config, ['video']).some((model) => model.id === generation.modelId && model.category === 'video')
      || !resolveMediaModel) throw new Error('视频生成模型未配置或不在本次安全目录');
    const resolved = resolveMediaModel('video', generation.modelId);
    const model = state.config.generalModels?.find((entry) => `general/${entry.id}` === generation.modelId);
    const workflow = resolved.workflowId ? state.workflows.find((entry) => entry.id === resolved.workflowId) : undefined;
    const server = workflow?.serverId ? state.config.comfyServers?.find((entry) => entry.id === workflow.serverId) : undefined;
    return { resolved, fingerprint: JSON.stringify([resolved, model, workflow, server?.url, state.config.comfyUIUrl,
      model ? state.config.providers[model.providerConfigId]?.baseUrl : undefined]) };
  };
  const generations = new Map(options.nodeSet.nodes.flatMap((item) => item.generation
    ? [[item.key, resolveGeneration(item.generation)] as const] : []));
  const assertGenerationModelsFresh = () => {
    for (const item of options.nodeSet.nodes) {
      if (item.generation && resolveGeneration(item.generation).fingerprint !== generations.get(item.key)?.fingerprint) {
        throw new Error('视频模型或工作流配置已变化，请重新检查');
      }
    }
  };
  const savedImages = new Map<string, {
    nodeId: string;
    assetUrl: string;
    filePath: string;
    fileName: string;
    dimensions: { nodeWidth: number; nodeHeight: number };
    pixelDimensions?: { width: number; height: number };
  }>();
  const nodeIds = new Map(options.nodeSet.nodes.map((item) => [item.key, `node-${generateId()}`]));
  const savedVideos = new Map<string, { assetUrl: string; filePath: string; fileName: string }>();
  const rollback = async () => {
    await Promise.all(savedPaths.map((filePath) => moveToTrash(filePath)));
  };
  const validateImages = () => {
    options.assertFresh();
    for (const item of options.nodeSet.nodes) {
      if (item.resourceId) readPluginDerivedResourceForOutput(
        options.resourceContext, item.resourceId, item.representation ?? 'original',
      );
    }
  };

  try {
    // 整批先验证选择的表示，缺少线稿时不能先保存部分原图。
    validateImages();
    const videoBytes = new Map<string, Uint8Array>();
    for (const artifact of options.artifacts ?? []) {
      if (!options.identity) throw new Error('视频产物缺少原生调用身份');
      videoBytes.set(artifact.key, await readNativeMediaArtifact(options.identity, artifact, options.assertFresh));
    }
    const retainedArtifactKeys = new Set(options.nodeSet.nodes.flatMap((item) => item.artifactKey ? [item.artifactKey] : []));
    for (const artifact of options.artifacts ?? []) {
      if (!retainedArtifactKeys.has(artifact.key)) continue;
      options.assertFresh();
      const saved = await saveBinaryToProjectData(videoBytes.get(artifact.key)!, options.projectId, `plugin-video-${artifact.key}.mp4`, { throwOnError: true });
      if (saved) savedPaths.push(saved.filePath);
      if (!saved?.assetUrl) throw new Error(`无法保存视频产物「${artifact.key}」`);
      options.assertFresh();
      savedVideos.set(artifact.key, { ...saved, fileName: saved.filePath.replace(/\\/gu, '/').split('/').at(-1)! });
    }
    for (const item of options.nodeSet.nodes) {
      if (!item.resourceId) continue;
      options.assertFresh();
      const derived = readPluginDerivedResourceForOutput(options.resourceContext, item.resourceId, item.representation ?? 'original');
      const extension = derived.resource.mediaType === 'image/png'
        ? 'png'
        : derived.resource.mediaType === 'image/webp' ? 'webp' : 'jpg';
      const fileName = `video-frame-${item.key}.${extension}`;
      const saved = await saveBinaryToProjectData(derived.bytes, options.projectId, fileName);
      if (saved) savedPaths.push(saved.filePath);
      if (!saved?.assetUrl) throw new Error(`无法保存抽帧图像「${item.key}」`);
      // 像素尺寸不是节点展示尺寸；从宿主保存的图像计算，避免竖图落入默认横框。
      const dimensions = await computeImageNodeDimensions(saved.assetUrl);
      options.assertFresh();
      savedImages.set(item.key, {
        nodeId: nodeIds.get(item.key)!,
        assetUrl: saved.assetUrl,
        filePath: saved.filePath,
        fileName: saved.filePath.replace(/\\/gu, '/').split('/').at(-1) ?? fileName,
        dimensions,
        pixelDimensions: derived.dimensions,
      });
    }

    // 保存含异步操作；提交前再次确认派生批次仍有效。
    validateImages();
    const base = derivedNodePlacement(options.sourceNode);
    if (options.materialLayout) base.position = { ...options.materialLayout.position };
    const nodes = options.nodeSet.nodes.map((item) => {
      const image = savedImages.get(item.key);
      const video = item.artifactKey ? savedVideos.get(item.artifactKey) : undefined;
      const data = { ...item.data } as Record<string, unknown>;
      if (item.generation) {
        const model = generations.get(item.key)!.resolved;
        const parameters = item.generation.parameters;
        Object.assign(data, { model: model.requestModel, provider: model.provider,
          ...(model.workflowId ? { workflowId: model.workflowId } : {}),
          ...(parameters?.duration !== undefined ? { seedanceDuration: parameters.duration } : {}),
          ...(parameters?.aspectRatio !== undefined ? { seedanceRatio: parameters.aspectRatio } : {}),
          ...(parameters?.resolution !== undefined ? { seedanceResolution: parameters.resolution } : {}),
          ...(parameters?.videoResolution !== undefined ? { videoResolution: parameters.videoResolution } : {}),
          ...(parameters?.videoFps !== undefined ? { videoFps: parameters.videoFps } : {}),
          ...(parameters?.videoFrames !== undefined ? { videoFrames: parameters.videoFrames } : {}),
          ...(parameters?.generateAudio !== undefined ? { generateAudio: parameters.generateAudio } : {}),
        });
      }
      if (data.frameAnalysis && typeof data.frameAnalysis === 'object' && !Array.isArray(data.frameAnalysis)) {
        data.frameAnalysis = {
          ...(data.frameAnalysis as Record<string, unknown>),
          sourceVideoNodeId: options.sourceNode.id,
          sourceVideoName: String(options.sourceNode.data.label || '视频').slice(0, 240),
        };
      }
      if (Array.isArray(data.shotlistRows)) {
        data.shotlistRows = data.shotlistRows.map((rawRow) => {
          const row = recordValue(rawRow);
          const frameKey = typeof row.frameKey === 'string' ? row.frameKey : undefined;
          const frameImage = frameKey ? savedImages.get(frameKey) : undefined;
          if (frameKey && !frameImage) throw new Error(`分镜行引用了无效画面 key: ${frameKey}`);
          const { frameKey: _frameKey, video: _video, ...cleanRow } = row;
          return {
            ...cleanRow,
            ...(row.frameAnalysis && typeof row.frameAnalysis === 'object' ? {
              frameAnalysis: {
                ...recordValue(row.frameAnalysis),
                sourceVideoNodeId: options.sourceNode.id,
                sourceVideoName: String(options.sourceNode.data.label || '视频').slice(0, 240),
              },
            } : {}),
            frame: frameImage ? {
              nodeId: frameImage.nodeId,
              kind: 'image',
              url: frameImage.assetUrl,
              filePath: frameImage.filePath,
            } : null,
          };
        });
      }
      if (image) {
        data.imageUrl = image.assetUrl;
        data.filePath = image.filePath;
        data.fileName = image.fileName;
        data.nodeWidth = image.dimensions.nodeWidth;
        data.nodeHeight = image.dimensions.nodeHeight;
        if (image.pixelDimensions) {
          data.imageWidth = image.pixelDimensions.width;
          data.imageHeight = image.pixelDimensions.height;
        }
      }
      if (video) {
        data.videoUrl = video.assetUrl;
        data.output = video.assetUrl;
        data.filePath = video.filePath;
        data.fileName = video.fileName;
        data.relativePath = video.fileName;
      }
      return {
        id: nodeIds.get(item.key)!,
        type: item.nodeType,
        position: { ...base.position },
        ...(base.parentId ? { parentId: base.parentId } : {}),
        data: {
          label: typeof data.label === 'string' ? data.label : item.key,
          type: item.nodeType,
          role: 'source',
          status: 'success',
          ...data,
          ...(item.generation ? { role: 'prompt', status: 'idle' } : {}),
          ...(options.materialLayout ? { nodeWidth: options.materialLayout.nodeWidth, nodeHeight: options.materialLayout.nodeHeight } : {}),
        } as BaseNodeData,
      };
    });
    // 分镜表比普通媒体节点宽；按真实度量排物料，生成节点始终位于参考素材右侧。
    const dimensions = new Map(nodes.map((node) => {
      const fallback = node.type === 'ai-shotlist' ? { width: 720, height: 380 }
        : node.type === 'ai-markdown' ? { width: 280, height: 200 }
          : getNodeBounds({ ...node, data: { ...node.data, nodeWidth: undefined, nodeHeight: undefined } }, nodes);
      if (!(typeof node.data.nodeWidth === 'number' && Number.isFinite(node.data.nodeWidth) && node.data.nodeWidth > 0)) node.data.nodeWidth = fallback.width;
      if (!(typeof node.data.nodeHeight === 'number' && Number.isFinite(node.data.nodeHeight) && node.data.nodeHeight > 0)) node.data.nodeHeight = fallback.height;
      return [node.id, getNodeBounds(node, nodes)] as const;
    }));
    const generatedNodeIds = new Set([...generations.keys()].map((key) => nodeIds.get(key)!));
    let materialX = base.position.x;
    let materialY = base.position.y;
    let materialRowHeight = 0;
    let materialRight = base.position.x;
    const materials = nodes.filter((node) => !generatedNodeIds.has(node.id));
    for (const [index, node] of materials.entries()) {
      if (options.materialLayout) {
        node.position = { x: base.position.x, y: base.position.y + index * (options.materialLayout.nodeHeight + options.materialLayout.gap) };
        continue;
      }
      if (index > 0 && index % 4 === 0) {
        materialY += Math.max(280, materialRowHeight + 80);
        materialX = base.position.x;
        materialRowHeight = 0;
      }
      const size = dimensions.get(node.id)!;
      node.position = { x: materialX, y: materialY };
      materialRight = Math.max(materialRight, materialX + size.width);
      materialX += size.width + 80;
      materialRowHeight = Math.max(materialRowHeight, size.height);
    }
    let generatedY = base.position.y;
    for (const node of nodes.filter((item) => generatedNodeIds.has(item.id))) {
      node.position = { x: materials.length ? materialRight + 80 : base.position.x, y: generatedY };
      generatedY += dimensions.get(node.id)!.height + 80;
    }
    const edges = (options.nodeSet.edges ?? []).map((edge) => ({
      id: `edge-${generateId()}`,
      source: nodeIds.get(edge.sourceKey)!,
      target: nodeIds.get(edge.targetKey)!,
      sourceHandle: 'right',
      targetHandle: 'left',
    }));
    await assertReferencesFresh();
    assertGenerationModelsFresh();
    const state = useAppStore.getState();
    const workspace = { ...state, nodes: [...state.nodes, ...nodes], edges: [...state.edges, ...edges] };
    const generationIds = new Set([...generations.keys()].map((key) => nodeIds.get(key)!));
    const videoPreflight = nodes.filter((node) => generationIds.has(node.id)).map((node) => inspectVideoNode(node, workspace));
    if (videoPreflight.some((item) => item.issues.length)) throw new Error('视频生成节点预检失败，请检查模型与本批参考媒体');
    return { nodes, edges, nodeIdsByKey: Object.fromEntries(nodeIds), rollback, assertGenerationModelsFresh, assertReferencesFresh, videoPreflight };
  } catch (error) {
    await rollback();
    throw error;
  }
}

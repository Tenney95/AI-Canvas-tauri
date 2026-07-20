/**
 * generationService — 独立于对话框的节点生成执行器
 *
 * 供 Toolbar 快捷指令直接调用，也供 AINodeDialog 复用。
 */
import type { BaseNodeData, ImagePostProcess } from '../types';
import { MAX_IMAGE_BATCH_COUNT } from '../types/aiTypes';
import { generateText, generateImage, generateImagesBatch, generateVideo, generateAudio, buildPanoramaPrompt } from './aiService';
import { persistAudioGenerationResult } from './ai/generateAudio';
import { downloadUrlAndSave } from './fileService';
import { applyImageBatchResults } from './imageBatchService';
import { generateId } from '../store/store.utils';
import { useAppStore } from '../store/useAppStore';
import {
  getProjectModelKind,
  parseProjectModelRef,
  resolveProjectGenerationPrompt,
} from './projectSettingsService';
import { postProcessDramaExtractOutput } from './dramaAssetExtract';

export interface GenerationResult {
  success: boolean;
  message?: string;
}

export async function executeGeneration(
  nodeId: string,
  overridePrompt?: string,
  postProcess?: ImagePostProcess,
  /** 直接传入节点数据（避免读 store 的时序问题），不传则从 store 读 */
  passData?: BaseNodeData,
): Promise<GenerationResult> {
  const store = useAppStore.getState();
  const data: BaseNodeData | undefined = passData ?? (store.nodes.find((n) => n.id === nodeId)?.data as BaseNodeData | undefined);
  if (!data) return { success: false, message: '节点不存在' };

  const nodeType = data?.type;
  const rawPrompt = overridePrompt ?? (data?.prompt as string) ?? '';

  if (!rawPrompt.trim()) {
    store.showToast('请输入提示词', 'error');
    return { success: false, message: '提示词为空' };
  }

  const projectSettings = store.projects.find(
    (project) => project.id === store.currentProjectId,
  )?.settings;
  const effectivePrompt = resolveProjectGenerationPrompt({
    prompt: rawPrompt,
    data,
    settings: projectSettings,
    customStyles: store.customStyles,
  });
  const projectModelKind = getProjectModelKind(nodeType);
  const projectModel = parseProjectModelRef(
    projectModelKind ? projectSettings?.defaultModels?.[projectModelKind] : undefined,
  );
  const parsedNodeModel = parseProjectModelRef(data?.model);
  const nodeModel = data?.model || projectModel?.model;
  const nodeProvider = data?.provider || parsedNodeModel?.provider || projectModel?.provider;
  if (!nodeModel || !nodeProvider) {
    store.showToast('请先在底部模型选择器中选择一个模型', 'error');
    return { success: false, message: '未选择模型' };
  }

  const submittingProjectId = store.currentProjectId;
  const isStillCurrentSubmission = () => {
    const s = useAppStore.getState();
    return s.currentProjectId === submittingProjectId && s.nodes.some((n) => n.id === nodeId);
  };

  store.updateNodeDataTransient(nodeId, { status: 'loading', error: undefined });

  try {
    if (nodeType === 'ai-image') {
      const imageSize = (data.imageSize as string) || '2K';
      const aspectRatio = (data.aspectRatio as string) || '1:1';
      const batchCount = Math.min(MAX_IMAGE_BATCH_COUNT, Math.max(1, Math.floor(Number(data.batchCount) || 1)));
      if (batchCount > 1) {
        if (postProcess) throw new Error('批量生成暂不支持图片后处理，请将数量设为 1');
        store.showToast(`正在批量生成 ${batchCount} 张图片`);
        const batch = await generateImagesBatch({
          prompt: effectivePrompt, model: nodeModel, provider: nodeProvider,
          imageSize, aspectRatio, nodeId,
        }, batchCount);
        if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
        await applyImageBatchResults({
          nodeId,
          batch,
          projectId: submittingProjectId,
          prompt: effectivePrompt,
          imageSize,
          aspectRatio,
        });
        return { success: true };
      }
      const result = await generateImage({
        prompt: effectivePrompt, model: nodeModel, provider: nodeProvider,
        imageSize, aspectRatio, nodeId,
      });
      if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };

      const saved = submittingProjectId
        ? await downloadUrlAndSave(result.url, submittingProjectId, 'ai-image', data.label).catch(() => null)
        : null;
      const mediaUrl = saved?.assetUrl || result.url;
      store.updateNodeData(nodeId, {
        imageUrl: mediaUrl, sourceUrl: result.url, filePath: saved?.filePath,
        thumbnailUrl: result.url, output: result.url, status: 'success',
        imageWidth: result.width, imageHeight: result.height,
      });
      store.recordOutputHistory(nodeId, {
        nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
        output: result.url, nodeType: 'ai-image', model: nodeModel, provider: nodeProvider,
        status: 'success', mediaUrl: result.url, filePath: saved?.filePath,
        params: { imageSize, aspectRatio },
      });

      if (postProcess === 'character-8-direction-grid' && saved?.filePath) {
        const { checkModelExists, createCharacterDirectionGrid, downloadModel } = await import('./onnxService');
        try {
          const mattingModelName = 'rmbg-1.4.onnx';
          if (!(await checkModelExists(mattingModelName))) {
            store.showToast('首次使用正在下载主体识别模型（约 176MB）');
            await downloadModel(mattingModelName);
          }
          if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
          const gridResult = await createCharacterDirectionGrid(
            saved.filePath, mattingModelName, `direction-grid-${nodeId}-${Date.now()}`,
          );
          if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };

          const { convertFileSrc } = await import('@tauri-apps/api/core');
          const sourceNode = useAppStore.getState().nodes.find((item) => item.id === nodeId);
          if (sourceNode) {
            store.addNode({
              id: `node-${generateId()}`,
              type: 'ai-storyboard',
              position: { x: sourceNode.position.x + ((sourceNode.data.nodeWidth as number) || 280) + 60, y: sourceNode.position.y },
              data: { label: `${data.label} 8向宫格`, type: 'ai-storyboard', role: 'source', status: 'success', imageUrl: convertFileSrc(gridResult.grid_path), filePath: gridResult.grid_path, imageWidth: gridResult.grid_size, imageHeight: gridResult.grid_size, storyboardRows: 3, storyboardCols: 3, nodeWidth: 360, nodeHeight: 360 },
            });
          }
          store.showToast('角色 8 向宫格已生成');
        } catch {
          store.showToast(`原图已生成，8 向宫格处理失败`, 'error');
        }
      } else {
        store.showToast('图片生成完成');
      }
    } else if (nodeType === 'ai-panorama') {
      const imageSize = (data.imageSize as string) || '2K';
      const aspectRatio = (data.aspectRatio as string) || '2:1';
      const result = await generateImage({
        prompt: buildPanoramaPrompt(effectivePrompt), model: nodeModel, provider: nodeProvider,
        imageSize, aspectRatio, nodeId,
      });
      if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
      const saved = submittingProjectId
        ? await downloadUrlAndSave(result.url, submittingProjectId, 'ai-panorama', data.label).catch(() => null)
        : null;
      const mediaUrl = saved?.assetUrl || result.url;
      store.updateNodeData(nodeId, {
        imageUrl: mediaUrl, sourceUrl: result.url, filePath: saved?.filePath,
        thumbnailUrl: result.url, output: result.url, status: 'success',
        imageWidth: result.width, imageHeight: result.height,
      });
      store.recordOutputHistory(nodeId, {
        nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
        output: result.url, nodeType: 'ai-panorama', model: nodeModel, provider: nodeProvider,
        status: 'success', mediaUrl: result.url, filePath: saved?.filePath,
        params: { imageSize, aspectRatio },
      });
      store.showToast('全景图生成完成');
    } else if (nodeType === 'ai-video') {
      const videoResolution = (data.videoResolution as number) || 832;
      const videoFps = (data.videoFps as number) || 24;
      const videoFrames = (data.videoFrames as number) || 77;
      const seedanceResolution = (data.seedanceResolution as string) || '720p';
      const seedanceRatio = (data.seedanceRatio as string) || '16:9';
      const seedanceDuration = (data.seedanceDuration as number) || 5;
      const genAudio = (data.generateAudio as boolean) || false;
      const result = await generateVideo({
        prompt: effectivePrompt, model: nodeModel, provider: nodeProvider,
        videoResolution, videoFps, videoFrames, seedanceResolution, seedanceRatio,
        seedanceDuration, generateAudio: genAudio, nodeId,
      });
      if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
      const saved = submittingProjectId
        ? await downloadUrlAndSave(result.url, submittingProjectId, 'ai-video', data.label).catch(() => null)
        : null;
      store.updateNodeData(nodeId, {
        videoUrl: saved?.assetUrl || result.url, sourceUrl: result.url, filePath: saved?.filePath,
        thumbnailUrl: result.url, output: result.url, status: 'success',
      });
      store.recordOutputHistory(nodeId, {
        nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
        output: result.url, nodeType: 'ai-video', model: nodeModel, provider: nodeProvider,
        status: 'success', mediaUrl: result.url, filePath: saved?.filePath,
        params: { videoResolution, videoFps, videoFrames, seedanceResolution, seedanceRatio, seedanceDuration, generateAudio: genAudio },
      });
      store.showToast('视频生成完成');
    } else if (nodeType === 'ai-audio') {
      const result = await generateAudio({
        prompt: effectivePrompt,
        model: nodeModel,
        provider: nodeProvider,
        audioVoice: data.audioVoice,
        audioFormat: data.audioFormat,
        audioSpeed: data.audioSpeed,
        musicTitle: data.musicTitle,
        musicLyrics: data.musicLyrics,
        musicBpm: data.musicBpm,
        musicDuration: data.musicDuration,
        autoGenerateLyrics: data.autoGenerateLyrics,
        nodeId,
      });
      if (!isStillCurrentSubmission()) {
        if (result.url.startsWith('blob:')) URL.revokeObjectURL(result.url);
        return { success: false, message: '任务已取消' };
      }
      const persisted = await persistAudioGenerationResult(result, submittingProjectId, data.label);
      store.updateNodeData(nodeId, {
        audioUrl: persisted.mediaUrl, sourceUrl: persisted.sourceUrl, filePath: persisted.filePath,
        thumbnailUrl: persisted.mediaUrl, output: persisted.outputUrl,
        musicClipId: result.clipId,
        ...(result.title ? { musicTitle: result.title } : {}),
        ...(result.lyrics ? { musicLyrics: result.lyrics } : {}),
        status: 'success',
      });
      store.recordOutputHistory(nodeId, {
        nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
        output: persisted.outputUrl, nodeType: 'ai-audio', model: nodeModel, provider: nodeProvider,
        status: 'success', mediaUrl: persisted.mediaUrl, filePath: persisted.filePath,
        params: {
          audioVoice: data.audioVoice,
          audioFormat: data.audioFormat,
          audioSpeed: data.audioSpeed,
          musicTitle: result.title || data.musicTitle,
          musicBpm: data.musicBpm,
          musicDuration: data.musicDuration,
          autoGenerateLyrics: data.autoGenerateLyrics,
        },
      });
      store.showToast('音频生成完成');
    } else {
      const result = await generateText({ prompt: effectivePrompt, model: nodeModel, provider: nodeProvider });
      if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
      const processed = postProcessDramaExtractOutput(effectivePrompt, result);
      store.updateNodeData(nodeId, { output: processed.output, status: 'success' });
      store.recordOutputHistory(nodeId, {
        nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
        output: processed.output, nodeType: 'ai-text', model: nodeModel, provider: nodeProvider, status: 'success',
      });
      if (processed.kind) {
        if (processed.ok && processed.parsed) {
          store.mergeDramaExtract(processed.parsed, {
            sourceNodeId: nodeId,
            modelId: nodeModel,
          });
        }
        const kindLabel =
          processed.kind === 'character' ? '人物' : processed.kind === 'scene' ? '场景' : '道具';
        store.showToast(
          processed.ok
            ? `${kindLabel}简介已提取并入库`
            : '已提取，但 JSON 未完全规范化，请检查输出',
          processed.ok ? undefined : 'error',
        );
      }
    }
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : (typeof err === 'string' && err.trim() ? err : '生成失败');
    if (msg === '任务已被取消') return { success: false, message: '任务已取消' };
    if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
    store.updateNodeDataTransient(nodeId, { status: 'error', error: msg });
    store.recordOutputHistory(nodeId, {
      nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
      output: '', nodeType: nodeType as 'ai-text' | 'ai-image' | 'ai-video' | 'ai-audio' | 'ai-panorama',
      model: nodeModel, provider: nodeProvider, status: 'error', error: msg,
    });
    store.showToast(msg, 'error');
    return { success: false, message: msg };
  }
}

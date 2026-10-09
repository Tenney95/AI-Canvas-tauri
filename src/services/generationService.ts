/**
 * generationService — 独立于对话框的节点生成执行器
 *
 * 供 Toolbar 快捷指令直接调用，也供 AINodeDialog 复用。
 */
import type { BaseNodeData, ImagePostProcess } from '../types';
import { MAX_IMAGE_BATCH_COUNT } from '../types/aiTypes';
import { generateText, generateImage, generateImagesBatch, generateVideo, generateAudio, buildPanoramaPrompt } from './aiService';
import { persistAudioGenerationResult } from './ai/generateAudio';
import { persistMediaUrlToProjectData } from './fileService';
import {
  applyImageBatchResults,
  failImageBatchNodes,
  prepareImageBatchNodes,
} from './imageBatchService';
import { derivedNodePlacement, generateId } from '../store/store.utils';
import { useAppStore } from '../store/useAppStore';
import {
  getProjectModelKind,
  parseProjectModelRef,
  resolveProjectGenerationPrompt,
} from './projectSettingsService';
import { postProcessDramaExtractOutput } from './dramaAssetExtract';
import { convertFileSrc } from '@tauri-apps/api/core';
import { resolveVideoSubmissionControls } from './ai/videoRequestResolver';
import { generateShotlistRows } from './shotlistService';
import { isCloudWorkflow, getCloudWorkflowPersistedOutput } from './workflowExecutionService';
import { completeWorkflowApiNodeTask } from './workflowApi/workflowApiAdapter';
import { completeRunningHubNodeTask } from './ai/providers/runninghubWorkflow';
import { registerCanvasDerivation, isCanvasDerivationFresh, completeCanvasDerivation } from './canvasDerivationGuard';
import { videoInputFingerprint } from './videoBatchPlanning';

export interface GenerationResult {
  success: boolean;
  message?: string;
}

/** 全片复刻等宿主任务的执行租约；不持久化到节点或项目。 */
export interface GenerationLease {
  signal?: AbortSignal;
  assertFresh: () => void | Promise<void>;
}

export async function executeGeneration(
  nodeId: string,
  overridePrompt?: string,
  postProcess?: ImagePostProcess,
  /** 直接传入节点数据（避免读 store 的时序问题），不传则从 store 读 */
  passData?: BaseNodeData,
  lease?: GenerationLease,
): Promise<GenerationResult> {
  let leaseValid = true;
  const assertLease = async () => {
    if (!lease) return;
    try {
      if (lease.signal?.aborted) throw new Error('任务已取消');
      await lease.assertFresh();
      if (lease.signal?.aborted) throw new Error('任务已取消');
    } catch {
      leaseValid = false;
      throw new Error('任务已取消');
    }
  };
  if (lease) {
    try { await assertLease(); } catch { return { success: false, message: '任务已取消' }; }
  }
  const store = useAppStore.getState();
  const data: BaseNodeData | undefined = passData ?? (store.nodes.find((n) => n.id === nodeId)?.data as BaseNodeData | undefined);
  if (!data) return { success: false, message: '节点不存在' };

  const nodeType = data?.type;
  const rawPrompt = overridePrompt ?? (data?.prompt as string) ?? '';

  if (nodeType === 'ai-director') {
    if (data.directorRuntimeKind !== 'ai-threejs') {
      const message = '请切换到 AI 镜头预演后生成';
      store.showToast(message, 'error');
      return { success: false, message };
    }
    const defaults = parseProjectModelRef(store.projects.find((project) => project.id === store.currentProjectId)?.settings?.defaultModels?.text);
    const selected = parseProjectModelRef(data.model || data.directorPrevisModel);
    const model = data.model || data.directorPrevisModel || defaults?.model || '';
    const provider = data.model ? data.provider || selected?.provider : data.directorPrevisModel
      ? data.directorPrevisProvider || selected?.provider : defaults?.provider;
    const description = overridePrompt ?? data.prompt ?? data.directorPrevisPrompt ?? '';
    const validation = !description.trim() || description.length > 12000 ? '请填写场景和运镜描述（最多 12000 字符）'
      : !model || !provider ? '请先选择文本模型；引用图片时请选择视觉模型' : undefined;
    if (validation) {
      store.showToast(validation, 'error');
      return { success: false, message: validation };
    }
    try {
      const { generateDirectorPrevis } = await import('./directorPrevisService');
      const live = useAppStore.getState();
      if (live.currentProjectId !== store.currentProjectId
        || live.nodes.find((node) => node.id === nodeId)?.data !== store.nodes.find((node) => node.id === nodeId)?.data) {
        return { success: false, message: '画布或生成输入已变化，未提交预演请求' };
      }
      await generateDirectorPrevis({ nodeId, description, model, provider: provider || '' });
      useAppStore.getState().showToast('镜头预演已生成，可打开导演台查看');
      return { success: true };
    } catch (error) {
      const cancelled = error instanceof Error && error.name === 'AbortError';
      const message = cancelled ? '预演生成已取消或画布发生变化，未写回结果' : '镜头预演生成失败，请检查描述、模型配置和引用素材';
      useAppStore.getState().showToast(message, cancelled ? 'info' : 'error');
      return { success: false, message };
    }
  }

  const cloudWorkflow = isCloudWorkflow(store.workflows.find((item) => item.id === data.workflowId));
  if (!rawPrompt.trim() && !cloudWorkflow && data.provider !== 'runninghub') {
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
  const nodeProvider = data.model
    ? data.provider || parsedNodeModel?.provider
    : projectModel?.provider || data.provider;
  const workflowId = data.workflowId || (!data.model ? projectModel?.workflowId : undefined);
  if (!nodeModel || !nodeProvider) {
    store.showToast('请先在底部模型选择器中选择一个模型', 'error');
    return { success: false, message: '未选择模型' };
  }

  const submittingProjectId = store.currentProjectId;
  const runningHubTask = cloudWorkflow || data.provider === 'runninghub';
  const guardedSubmission = runningHubTask || nodeType === 'ai-video';
  let cloudGuard = guardedSubmission ? registerCanvasDerivation(store, nodeId) : null;
  const videoNode = store.nodes.find((n) => n.id === nodeId);
  const videoFingerprint = nodeType === 'ai-video' && videoNode
    ? videoInputFingerprint({ ...videoNode, data }, store) : undefined;
  const isStillCurrentSubmission = () => {
    const s = useAppStore.getState();
    return leaseValid && !lease?.signal?.aborted && s.currentProjectId === submittingProjectId && s.nodes.some((n) => n.id === nodeId)
      && (!guardedSubmission || (!!cloudGuard && isCanvasDerivationFresh(cloudGuard, s)));
  };

  store.updateNodeDataTransient(nodeId, { status: 'loading', error: undefined });
  let batchNodeIds: string[] | undefined;

  try {
    if (nodeType === 'ai-image') {
      const imageSize = (data.imageSize as string) || '2K';
      const aspectRatio = (data.aspectRatio as string) || '1:1';
      const batchCount = cloudWorkflow ? 1 : Math.min(MAX_IMAGE_BATCH_COUNT, Math.max(1, Math.floor(Number(data.batchCount) || 1)));
      if (batchCount > 1) {
        if (postProcess) throw new Error('批量生成暂不支持图片后处理，请将数量设为 1');
        batchNodeIds = prepareImageBatchNodes({
          nodeId,
          count: batchCount,
          projectId: submittingProjectId,
        }).nodeIds;
        if (cloudGuard) completeCanvasDerivation(cloudGuard);
        cloudGuard = runningHubTask ? registerCanvasDerivation(useAppStore.getState(), nodeId) : null;
        store.showToast(`正在批量生成 ${batchCount} 张图片`);
        const batch = await generateImagesBatch({
          prompt: effectivePrompt, model: nodeModel, provider: nodeProvider,
          imageSize, aspectRatio, nodeId,
          workflowId, workflowInputs: data.workflowInputs, runninghubModelParameters: data.runninghubModelParameters,
        }, batchCount);
        if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
        await applyImageBatchResults({
          nodeId,
          targetNodeIds: batchNodeIds,
          isCurrent: runningHubTask ? isStillCurrentSubmission : undefined,
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
        workflowId, workflowInputs: data.workflowInputs, runninghubModelParameters: data.runninghubModelParameters,
      });
      if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };

      const persisted = getCloudWorkflowPersistedOutput(result.workflowApiOutputs ?? result.runninghubOutputs, result.url) ?? (submittingProjectId
        ? await persistMediaUrlToProjectData(result.url, submittingProjectId, 'ai-image', data.label)
        : { mediaUrl: result.url, sourceUrl: result.url });
      if (runningHubTask && !isStillCurrentSubmission()) return { success: false, message: '画布已变化，任务已保留' };
      const mediaUrl = persisted.mediaUrl;
      store.updateNodeData(nodeId, {
        imageUrl: mediaUrl, sourceUrl: persisted.sourceUrl, filePath: persisted.filePath,
        thumbnailUrl: mediaUrl, output: persisted.sourceUrl, status: 'success',
        imageWidth: result.width, imageHeight: result.height,
      });
      if (runningHubTask) completeRunningHubNodeTask(nodeId);
      if (result.workflowApiTaskId) completeWorkflowApiNodeTask(nodeId, result.workflowApiTaskId);
      store.syncDramaAssetImageFromNode?.(nodeId, mediaUrl);
      store.recordOutputHistory(nodeId, {
        nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
        output: persisted.sourceUrl, nodeType: 'ai-image', model: nodeModel, provider: nodeProvider,
        status: 'success', mediaUrl, filePath: persisted.filePath,
        params: { imageSize, aspectRatio },
      });

      if (postProcess === 'character-8-direction-grid' && persisted.filePath) {
        const { createCharacterDirectionGrid } = await import('./onnxService');
        try {
          const gridResult = await createCharacterDirectionGrid(persisted.filePath);
          if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };

          const sourceNode = useAppStore.getState().nodes.find((item) => item.id === nodeId);
          if (sourceNode) {
            store.addNode({
              id: `node-${generateId()}`,
              type: 'ai-storyboard',
              ...derivedNodePlacement(sourceNode, 60),
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
        workflowId, workflowInputs: data.workflowInputs, runninghubModelParameters: data.runninghubModelParameters,
      });
      if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
      const persisted = submittingProjectId
        ? await persistMediaUrlToProjectData(result.url, submittingProjectId, 'ai-panorama', data.label)
        : { mediaUrl: result.url, sourceUrl: result.url };
      const mediaUrl = persisted.mediaUrl;
      store.updateNodeData(nodeId, {
        imageUrl: mediaUrl, sourceUrl: persisted.sourceUrl, filePath: persisted.filePath,
        thumbnailUrl: mediaUrl, output: persisted.sourceUrl, status: 'success',
        imageWidth: result.width, imageHeight: result.height,
      });
      store.recordOutputHistory(nodeId, {
        nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
        output: persisted.sourceUrl, nodeType: 'ai-panorama', model: nodeModel, provider: nodeProvider,
        status: 'success', mediaUrl, filePath: persisted.filePath,
        params: { imageSize, aspectRatio },
      });
      store.showToast('全景图生成完成');
    } else if (nodeType === 'ai-video') {
      // Imported/legacy outputs may not have a history record. Preserve before replacing.
      if (data.videoUrl) {
        if (lease) await assertLease();
        await store.recordOutputHistory(nodeId, {
          nodeId, nodeLabel: `${data.label} · 替换前版本`, timestamp: Date.now(), prompt: '',
          output: data.sourceUrl || data.videoUrl, nodeType: 'ai-video', model: '',
          provider: '', status: 'success', mediaUrl: data.videoUrl, filePath: data.filePath,
        }, true);
        if (!isStillCurrentSubmission()) return { success: false, message: lease ? '任务已取消' : '画布已变化，尚未提交' };
      }
      const {
        videoResolution,
        videoFps,
        videoFrames,
        seedanceResolution,
        seedanceRatio,
        seedanceDuration,
      } = resolveVideoSubmissionControls({
        provider: nodeProvider,
        workflowId,
        videoResolution: data.videoResolution as number | undefined,
        videoFps: data.videoFps as number | undefined,
        videoFrames: data.videoFrames as number | undefined,
        seedanceResolution: data.seedanceResolution as string | undefined,
        seedanceRatio: data.seedanceRatio as string | undefined,
        seedanceDuration: data.seedanceDuration as number | undefined,
      });
      const genAudio = data.generateAudio as boolean | undefined;
      const videoOptions = {
        prompt: effectivePrompt, model: nodeModel, provider: nodeProvider,
        videoResolution, videoFps, videoFrames, seedanceResolution, seedanceRatio,
        seedanceDuration, generateAudio: genAudio, nodeId,
        workflowId, workflowInputs: data.workflowInputs, runninghubModelParameters: data.runninghubModelParameters,
      };
      // 异步哈希/版本检查完成后再提交付费请求；撤销的租约不写失败历史。
      if (lease) {
        await assertLease();
        if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
      }
      const result = lease ? await generateVideo(videoOptions, lease.signal, assertLease) : await generateVideo(videoOptions);
      if (lease) await assertLease();
      if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
      const persisted = getCloudWorkflowPersistedOutput(result.workflowApiOutputs ?? result.runninghubOutputs, result.url) ?? (submittingProjectId
        ? await persistMediaUrlToProjectData(result.url, submittingProjectId, 'ai-video', data.label)
        : { mediaUrl: result.url, sourceUrl: result.url });
      if (lease) await assertLease();
      if (!isStillCurrentSubmission()) return { success: false, message: lease ? '任务已取消' : '画布已变化，任务已保留' };
      if (lease) await assertLease();
      if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
      store.updateNodeData(nodeId, {
        videoUrl: persisted.mediaUrl, sourceUrl: persisted.sourceUrl, filePath: persisted.filePath,
        thumbnailUrl: persisted.mediaUrl, output: persisted.sourceUrl, status: 'success', videoBatchFingerprint: videoFingerprint,
      });
      if (result.workflowApiTaskId) completeWorkflowApiNodeTask(nodeId, result.workflowApiTaskId);
      if (runningHubTask) completeRunningHubNodeTask(nodeId);
      if (result.workflowApiTaskId) completeWorkflowApiNodeTask(nodeId, result.workflowApiTaskId);
      await store.recordOutputHistory(nodeId, {
        nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
        output: persisted.sourceUrl, nodeType: 'ai-video', model: nodeModel, provider: nodeProvider,
        status: 'success', mediaUrl: persisted.mediaUrl, filePath: persisted.filePath,
        params: { videoResolution, videoFps, videoFrames, seedanceResolution, seedanceRatio, seedanceDuration, generateAudio: genAudio },
      }, true);
      store.showToast('视频生成完成');
    } else if (nodeType === 'ai-audio') {
      const result = await generateAudio({
        prompt: effectivePrompt,
        model: nodeModel,
        provider: nodeProvider,
        audioSpeechSettings: data.audioSpeechSettings,
        audioVoice: data.audioVoice,
        audioFormat: data.audioFormat,
        audioSpeed: data.audioSpeed,
        musicTitle: data.musicTitle,
        musicLyrics: data.musicLyrics,
        musicBpm: data.musicBpm,
        musicDuration: data.musicDuration,
        autoGenerateLyrics: data.autoGenerateLyrics,
        nodeId,
        workflowId,
        workflowInputs: data.workflowInputs, runninghubModelParameters: data.runninghubModelParameters,
      });
      if (!isStillCurrentSubmission()) {
        if (result.url.startsWith('blob:')) URL.revokeObjectURL(result.url);
        return { success: false, message: '任务已取消' };
      }
      const persisted = await persistAudioGenerationResult(result, submittingProjectId, data.label);
      if (runningHubTask && !isStillCurrentSubmission()) return { success: false, message: '画布已变化，任务已保留' };
      store.updateNodeData(nodeId, {
        audioUrl: persisted.mediaUrl, sourceUrl: persisted.sourceUrl, filePath: persisted.filePath,
        thumbnailUrl: persisted.mediaUrl, output: persisted.outputUrl,
        musicClipId: result.clipId,
        ...(result.title ? { musicTitle: result.title } : {}),
        ...(result.lyrics ? { musicLyrics: result.lyrics } : {}),
        status: 'success',
      });
      if (runningHubTask) completeRunningHubNodeTask(nodeId);
      if (result.workflowApiTaskId) completeWorkflowApiNodeTask(nodeId, result.workflowApiTaskId);
      store.recordOutputHistory(nodeId, {
        nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
        output: persisted.outputUrl, nodeType: 'ai-audio', model: nodeModel, provider: nodeProvider,
        status: 'success', mediaUrl: persisted.mediaUrl, filePath: persisted.filePath,
        params: {
          audioSpeechSettings: data.audioSpeechSettings,
          audioVoice: data.audioVoice,
          audioFormat: data.audioFormat,
          audioSpeed: data.audioSpeed,
          musicTitle: result.title || data.musicTitle,
          musicBpm: data.musicBpm,
          musicDuration: data.musicDuration,
          autoGenerateLyrics: data.autoGenerateLyrics,
        },
      });
      if (result.workflowApiTaskId) completeWorkflowApiNodeTask(nodeId, result.workflowApiTaskId);
      store.showToast('音频生成完成');
    } else if (nodeType === 'ai-shotlist') {
      await generateShotlistRows(nodeId, effectivePrompt, nodeModel, nodeProvider);
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
        if (processed.ok) {
          store.showToast(`${kindLabel}简介已提取并入库 · 「资产管理 > 短剧资产」可查看`);
        } else {
          store.showToast('已提取，但 JSON 未完全规范化，请检查输出', 'error');
        }
      }
    }
    if (runningHubTask && isStillCurrentSubmission()) completeRunningHubNodeTask(nodeId);
    return { success: true };
  } catch (err) {
    if (lease) {
      try { await assertLease(); } catch { return { success: false, message: '任务已取消' }; }
    }
    const msg = err instanceof Error ? err.message : (typeof err === 'string' && err.trim() ? err : '生成失败');
    if (msg === '任务已被取消') return { success: false, message: '任务已取消' };
    if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
    if (batchNodeIds) failImageBatchNodes(batchNodeIds, msg, submittingProjectId);
    store.updateNodeDataTransient(nodeId, { status: 'error', error: msg });
    store.recordOutputHistory(nodeId, {
      nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
      output: '', nodeType: nodeType as 'ai-text' | 'ai-image' | 'ai-video' | 'ai-audio' | 'ai-panorama',
      model: nodeModel, provider: nodeProvider, status: 'error', error: msg,
    });
    store.showToast(msg, 'error');
    return { success: false, message: msg };
  } finally {
    if (cloudGuard) completeCanvasDerivation(cloudGuard);
  }
}

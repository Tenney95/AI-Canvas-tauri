/**
 * generationService — 独立于对话框的节点生成执行器
 *
 * 供 Toolbar 快捷指令直接调用，也供 AINodeDialog 复用。
 */
import { ANIMATION_FRAME_GRIDS } from '../types';
import { buildAnimationSpritePrompt, resolveAnimationSheetAspectRatio } from './ai/animationPrompt';
import { animationProcessing, animationResultPatch } from './animationService';
import { resolveGenerationSelection } from './generationInput';
import type { AppConfig, BaseNodeData, ImagePostProcess } from '../types';
import { MAX_IMAGE_BATCH_COUNT, type MediaTaskReceipt } from '../types/aiTypes';
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
  parseProjectModelRef,
  resolveProjectGenerationPrompt,
} from './projectSettingsService';
import { postProcessDramaExtractOutput, prepareDramaExtractPrompt } from './dramaAssetExtract';
import { convertFileSrc } from '@tauri-apps/api/core';
import { resolveVideoSubmissionControls } from './ai/videoRequestResolver';
import { generateShotlistRows } from './shotlistService';
import { getCloudWorkflowPersistedOutput } from './workflowExecutionService';
import { completeWorkflowApiNodeTask } from './workflowApi/workflowApiAdapter';
import { completeRunningHubNodeTask } from './ai/providers/runninghubWorkflow';
import { registerCanvasDerivation, isCanvasDerivationFresh, completeCanvasDerivation } from './canvasDerivationGuard';
import { videoInputFingerprint } from './videoBatchPlanning';
import { beginComfyNodeDelivery, cancelNodePolling, completeComfyNodeTask, completeMediaNodeTask, pauseComfyNodeDelivery, pauseMediaNodeTask, pauseMediaTask, prepareMediaNodeGeneration, registerMediaNodeOperation, isMediaTaskPausedError } from './pollManager';
import { resolveGenerationNodeData } from '../utils/nodeGeneration';
import { applyGenerationCameraPrompt } from './shotlistPromptService';
import { resolveImageParameterCapability } from './ai/mediaModelCapabilities';
import { resolveConfiguredImageBackground, resolveConfiguredImageQuality } from './ai/modelCapabilityValidation';

export interface GenerationResult {
  success: boolean;
  message?: string;
}

/** 全片复刻等宿主任务的执行租约；不持久化到节点或项目。 */
export interface GenerationLease {
  signal?: AbortSignal;
  assertFresh: () => void | Promise<void>;
}

/** 宿主批量调度共用执行器，但由外层管理一次历史和汇总提示。 */
export interface GenerationOptions {
  comfyH3ExpectedSettings?: string;
  history?: 'transient';
  silent?: boolean;
}

/** 仅保留本进程内的提交身份，避免旧任务清理或覆盖同节点的新请求。 */
const videoSubmissionOwners = new Map<string, symbol>();

interface SequentialImageBatch {
  projectId: string | null;
  nodeIds: string[];
  remainingNodeIds: Set<string>;
  controller: AbortController;
  currentNodeId?: string;
}

const imageBatchOwners = new Map<string, SequentialImageBatch>();
const imageBatchLeases = new WeakMap<GenerationLease, SequentialImageBatch>();
const imageBatchListeners = new Set<() => void>();
const notifyImageBatches = () => imageBatchListeners.forEach((listener) => listener());

export function subscribeImageBatches(listener: () => void): () => void {
  imageBatchListeners.add(listener);
  return () => { imageBatchListeners.delete(listener); };
}

export function usesSequentialImageBatch(
  provider: string | undefined, model: string | undefined, config: AppConfig, workflowId?: string,
): boolean {
  if (provider !== 'general' || workflowId) return false;
  const capability = resolveImageParameterCapability(model, provider, config);
  return capability?.supportsBatch === false || capability?.maxBatchCount === 1;
}

function currentImageBatch(nodeId: string): SequentialImageBatch | undefined {
  const owner = imageBatchOwners.get(nodeId);
  return owner?.projectId === useAppStore.getState().currentProjectId ? owner : undefined;
}

export function isImageBatchGenerating(nodeId: string): boolean {
  return Boolean(currentImageBatch(nodeId));
}

function settleUnstartedImages(owner: SequentialImageBatch): void {
  const state = useAppStore.getState();
  if (state.currentProjectId !== owner.projectId) return;
  for (const nodeId of owner.remainingNodeIds) {
    if (state.nodes.find((node) => node.id === nodeId)?.data.status === 'loading') {
      state.updateNodeDataTransient(nodeId, { status: 'idle', error: undefined });
    }
  }
}

function imageBatchInputSignature(data: BaseNodeData): string {
  return JSON.stringify([
    data.type, data.prompt, data.provider, data.model, data.workflowId, data.workflowInputs,
    data.imageSize, data.imageQuality, data.imageBackground, data.aspectRatio,
    data.cameraSettings, data.runninghubModelParameters, data.batchCount,
  ]);
}

/** 只停止本地串行提交和当前请求；已提交的身份保留，后续节点不再提交。 */
export function cancelImageBatchGeneration(nodeId: string): boolean {
  const owner = currentImageBatch(nodeId);
  if (!owner) return false;
  if (!owner.controller.signal.aborted) {
    owner.controller.abort();
    if (owner.currentNodeId) {
      pauseMediaNodeTask(owner.currentNodeId);
      cancelNodePolling(owner.currentNodeId, true);
    }
    settleUnstartedImages(owner);
    notifyImageBatches();
  }
  return true;
}

async function runSequentialImageBatch(
  nodeId: string, count: number, data: BaseNodeData, rawPrompt: string, parentLease?: GenerationLease, options?: GenerationOptions,
): Promise<GenerationResult> {
  const state = useAppStore.getState();
  const projectId = state.currentProjectId;
  let owner: SequentialImageBatch | undefined;
  let completed = 0;
  try {
    // 与单次生成共用旧任务保护；创建新批次前不能覆盖原节点的恢复身份。
    prepareMediaNodeGeneration(nodeId);
    const nodeIds = prepareImageBatchNodes({ nodeId, count, projectId, commitHistory: options?.history !== 'transient' }).nodeIds;
    owner = { projectId, nodeIds, remainingNodeIds: new Set(nodeIds), controller: new AbortController() };
    const activeOwner = owner;
    const baselineRevision = useAppStore.getState().getCurrentRevision();
    const inputSignatures = new Map(useAppStore.getState().nodes.filter((node) => nodeIds.includes(node.id))
      .map((node) => [node.id, imageBatchInputSignature(node.data)]));
    for (const targetId of nodeIds) imageBatchOwners.set(targetId, activeOwner);
    notifyImageBatches();
    if (!options?.silent) state.showToast(`正在逐张生成 ${count} 张图片`);
    const signal = parentLease?.signal ? AbortSignal.any([parentLease.signal, activeOwner.controller.signal]) : activeOwner.controller.signal;
    for (const targetId of nodeIds) {
      const lease: GenerationLease = { signal, assertFresh: async () => {
        await parentLease?.assertFresh();
        const current = useAppStore.getState();
        const source = current.nodes.find((node) => node.id === nodeId);
        const target = current.nodes.find((node) => node.id === targetId);
        if (signal.aborted || current.currentProjectId !== projectId || current.getCurrentRevision() !== baselineRevision
          || !source || !target || imageBatchInputSignature(source.data) !== inputSignatures.get(nodeId)
          || imageBatchInputSignature(target.data) !== inputSignatures.get(targetId)) throw new Error('任务已取消');
      } };
      await lease.assertFresh();
      const target = useAppStore.getState().nodes.find((node) => node.id === targetId);
      if (!target) throw new Error('生成输入已变化，批次已停止');
      activeOwner.currentNodeId = targetId;
      activeOwner.remainingNodeIds.delete(targetId);
      imageBatchLeases.set(lease, activeOwner);
      let result: GenerationResult;
      try {
        result = await executeGeneration(targetId, rawPrompt, undefined, { ...data, label: target.data.label, batchCount: 1 }, lease, options);
      } finally { imageBatchLeases.delete(lease); }
      if (!result.success) return result;
      activeOwner.currentNodeId = undefined;
      completed += 1;
    }
    if (!options?.silent) state.showToast(`批量生成完成：共 ${completed} 张`);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : '批量生成已停止';
    if (!options?.silent && !owner?.controller.signal.aborted && !parentLease?.signal?.aborted) state.showToast(message, 'error');
    return { success: false, message };
  } finally {
    if (owner) {
      settleUnstartedImages(owner);
      const current = useAppStore.getState();
      const currentNodeId = owner.currentNodeId;
      if (currentNodeId && current.currentProjectId === owner.projectId
        && current.nodes.find((node) => node.id === currentNodeId)?.data.status === 'loading') {
        // 尚未取得可恢复身份的同步请求也必须退出转圈；不伪造远端取消成功。
        current.updateNodeDataTransient(currentNodeId, { status: 'idle' });
      }
      for (const targetId of owner.nodeIds) if (imageBatchOwners.get(targetId) === owner) imageBatchOwners.delete(targetId);
      notifyImageBatches();
    }
  }
}

export async function executeGeneration(
  nodeId: string,
  overridePrompt?: string,
  postProcess?: ImagePostProcess,
  /** 直接传入节点数据（避免读 store 的时序问题），不传则从 store 读 */
  passData?: BaseNodeData,
  lease?: GenerationLease,
  /** 批次预检捕获的 H3 策略摘要；适配器在本次执行解析策略后再次核对。 */
  batchOptions?: GenerationOptions,
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
  const beforeLoad = useAppStore.getState();
  const existingImageBatch = currentImageBatch(nodeId);
  if (existingImageBatch && (!lease || imageBatchLeases.get(lease) !== existingImageBatch)) {
    return { success: false, message: '该节点所在图片批次仍在生成，请先停止或等待完成' };
  }
  const sourceNode = beforeLoad.nodes.find((node) => node.id === nodeId);
  const inputBeforeLoad = passData ?? sourceNode?.data;
  if (`${overridePrompt ?? inputBeforeLoad?.prompt ?? ''}\n${JSON.stringify(inputBeforeLoad?.workflowInputs ?? {})}`.includes('@drama{global/')) {
    try {
      await beforeLoad.loadGlobalDramaAssets();
      await assertLease();
    } catch { return { success: false, message: '全局创作资产读取失败或任务已取消，未提交生成' }; }
    const latest = useAppStore.getState();
    if (latest.currentProjectId !== beforeLoad.currentProjectId || latest.nodes.find((node) => node.id === nodeId)?.data !== sourceNode?.data) {
      return { success: false, message: '项目或生成输入已变化，未提交生成' };
    }
  }
  const store = useAppStore.getState();
  const notify: typeof store.showToast = (...args) => { if (!batchOptions?.silent) store.showToast(...args); };
  const updateResult = batchOptions?.history === 'transient' ? store.updateNodeDataTransient : store.updateNodeData;
  const data = resolveGenerationNodeData(passData ?? store.nodes.find((n) => n.id === nodeId)?.data);
  if (!data) return { success: false, message: '节点不存在' };

  const nodeType = data?.type;
  const rawPrompt = overridePrompt ?? (data?.prompt as string) ?? '';

  if (data.model === '' && !data.workflowId) {
    notify('请先在底部模型选择器中选择一个模型', 'error');
    return { success: false, message: '未选择模型' };
  }

  if (nodeType === 'ai-director') {
    if (data.directorRuntimeKind !== 'ai-threejs') {
      const message = '请切换到 AI 镜头预演后生成';
      notify(message, 'error');
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
      notify(validation, 'error');
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
      notify('镜头预演已生成，可打开导演台查看');
      return { success: true };
    } catch (error) {
      const cancelled = error instanceof Error && error.name === 'AbortError';
      const message = cancelled ? '预演生成已取消或画布发生变化，未写回结果' : '镜头预演生成失败，请检查描述、模型配置和引用素材';
      notify(message, cancelled ? 'info' : 'error');
      return { success: false, message };
    }
  }

  const { model: nodeModel, provider: nodeProvider, workflowId, cloudWorkflow,
    settings: projectSettings, error: inputError } = resolveGenerationSelection(data, store, rawPrompt);
  if (inputError || !nodeModel || !nodeProvider) {
    notify(inputError === '提示词为空' ? '请输入提示词' : '请先在底部模型选择器中选择一个模型', 'error');
    return { success: false, message: inputError ?? '未选择模型' };
  }
  let effectivePrompt = resolveProjectGenerationPrompt({
    prompt: rawPrompt, data, settings: projectSettings, customStyles: store.customStyles,
  });
  const sequentialCount = Math.min(MAX_IMAGE_BATCH_COUNT, Math.max(1, Math.floor(Number(data.batchCount) || 1)));
  if (nodeType === 'ai-image' && sequentialCount > 1 && usesSequentialImageBatch(nodeProvider, nodeModel, store.config, workflowId)) {
    if (postProcess) {
      const message = '批量生成暂不支持图片后处理，请将数量设为 1';
      notify(message, 'error');
      return { success: false, message };
    }
    return runSequentialImageBatch(nodeId, sequentialCount, { ...data, provider: nodeProvider, model: nodeModel, workflowId }, rawPrompt, lease, batchOptions);
  }
  if (nodeType === 'ai-image' || nodeType === 'ai-video') {
    try {
      const duration = nodeType === 'ai-video' ? resolveVideoSubmissionControls({ ...data, provider: nodeProvider, workflowId }).seedanceDuration : undefined;
      effectivePrompt = applyGenerationCameraPrompt(effectivePrompt, store.nodes, data.cameraSettings, duration);
    } catch (error) {
      const message = error instanceof Error ? error.message : '镜头引用无效';
      notify(message, 'error');
      return { success: false, message };
    }
  }

  const submittingProjectId = store.currentProjectId;
  const mediaSubmission = ['ai-image', 'ai-animation', 'ai-panorama', 'ai-video', 'ai-audio'].includes(nodeType);
  if (mediaSubmission) {
    try { prepareMediaNodeGeneration(nodeId); }
    catch (error) {
      const message = error instanceof Error ? error.message : '暂时无法保留旧任务，请稍后再生成';
      notify(message, 'error');
      return { success: false, message };
    }
  }
  const runningHubTask = cloudWorkflow || nodeProvider === 'runninghub';
  const localComfyTask = !!workflowId && !cloudWorkflow;
  let comfyTaskId: string | undefined;
  const guardedSubmission = mediaSubmission || runningHubTask || localComfyTask;
  let cloudGuard = guardedSubmission ? registerCanvasDerivation(store, nodeId) : null;
  const videoNode = store.nodes.find((n) => n.id === nodeId);
  const videoFingerprint = nodeType === 'ai-video' && videoNode
    ? videoInputFingerprint({ ...videoNode, data: { ...data, prompt: rawPrompt } }, store) : undefined;
  const hasShotReference = nodeType === 'ai-video'
    && `${rawPrompt}\n${JSON.stringify(data.workflowInputs ?? {})}`.includes('/shot/');
  const hasProtectedVideoInputs = hasShotReference || (nodeType === 'ai-video'
    && (Boolean(data.comfyRefmods?.length) || ['@refmod', '@drama{global/'].some((marker) => `${effectivePrompt}\n${JSON.stringify(data.workflowInputs ?? {})}`.includes(marker))));
  const submissionKey = JSON.stringify([submittingProjectId, nodeId]);
  const videoOwner = nodeType === 'ai-video' ? Symbol(nodeId) : undefined;
  if (videoOwner) videoSubmissionOwners.set(submissionKey, videoOwner);
  const promptOverride = overridePrompt === undefined ? {} : { prompt: rawPrompt };
  const isStillCurrentSubmission = () => {
    const s = useAppStore.getState();
    const currentVideo = hasProtectedVideoInputs ? s.nodes.find((node) => node.id === nodeId) : undefined;
    return leaseValid && !lease?.signal?.aborted && s.currentProjectId === submittingProjectId && s.nodes.some((n) => n.id === nodeId)
      && (!guardedSubmission || (!!cloudGuard && isCanvasDerivationFresh(cloudGuard, s)))
      && (!videoOwner || videoSubmissionOwners.get(submissionKey) === videoOwner)
      && (!hasProtectedVideoInputs || (!!currentVideo
        && (overridePrompt === undefined || currentVideo.data.prompt === videoNode?.data.prompt)
        && videoInputFingerprint({ ...currentVideo, data: { ...currentVideo.data, ...promptOverride } }, s) === videoFingerprint));
  };

  const endOperation = mediaSubmission ? registerMediaNodeOperation(nodeId) : undefined;
  store.updateNodeDataTransient(nodeId, { status: 'loading', error: undefined, videoTaskState: undefined, mediaTaskState: undefined });
  let batchNodeIds: string[] | undefined;
  let taskReceipt: MediaTaskReceipt | undefined;
  let mediaDelivered = false;
  const confirmMediaDelivery = () => {
    if (taskReceipt) completeMediaNodeTask(taskReceipt);
    else if (runningHubTask) completeRunningHubNodeTask(nodeId);
    mediaDelivered = true;
  };

  try {
    if (nodeType === 'ai-image' || nodeType === 'ai-animation') {
      const isAnimation = nodeType === 'ai-animation';
      const imageSize = (data.imageSize as string) || '2K';
      const imageCapability = isAnimation || workflowId ? undefined : resolveImageParameterCapability(nodeModel, nodeProvider, store.config);
      const imageQuality = resolveConfiguredImageQuality(imageCapability, data.imageQuality);
      const imageBackground = resolveConfiguredImageBackground(imageCapability, data.imageBackground);
      const animationAction = data.animationAction ?? 'idle';
      const animationFrames = data.animationFrames ?? 8;
      const aspectRatio = isAnimation ? resolveAnimationSheetAspectRatio(animationFrames, nodeProvider)
        : (data.aspectRatio as string) || '1:1';
      const spriteProcessing = isAnimation ? animationProcessing({ ...data, animationSheet: undefined }) : undefined;
      if (isAnimation) effectivePrompt = buildAnimationSpritePrompt(effectivePrompt, animationAction, animationFrames, aspectRatio, spriteProcessing);
      const batchCount = cloudWorkflow || isAnimation ? 1 : Math.min(MAX_IMAGE_BATCH_COUNT, Math.max(1, Math.floor(Number(data.batchCount) || 1)));
      if (batchCount > 1) {
        if (postProcess) throw new Error('批量生成暂不支持图片后处理，请将数量设为 1');
        batchNodeIds = prepareImageBatchNodes({
          nodeId,
          count: batchCount,
          commitHistory: batchOptions?.history !== 'transient',
          projectId: submittingProjectId,
        }).nodeIds;
        if (cloudGuard) completeCanvasDerivation(cloudGuard);
        cloudGuard = guardedSubmission ? registerCanvasDerivation(useAppStore.getState(), nodeId) : null;
        notify(`正在批量生成 ${batchCount} 张图片`);
        const batch = await generateImagesBatch({
          prompt: effectivePrompt, model: nodeModel, provider: nodeProvider,
          imageSize, imageQuality, imageBackground: data.imageBackground === '' ? '' : imageBackground, aspectRatio, nodeId,
          workflowId, workflowInputs: data.workflowInputs, runninghubModelParameters: data.runninghubModelParameters,
        }, batchCount);
        taskReceipt = batch.results.find((result) => result.taskReceipt)?.taskReceipt;
        comfyTaskId = batch.results.find((result) => result.comfyTaskId)?.comfyTaskId;
        if (comfyTaskId) beginComfyNodeDelivery(nodeId, comfyTaskId);
        if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
        mediaDelivered = await applyImageBatchResults({
          nodeId,
          targetNodeIds: batchNodeIds,
          isCurrent: guardedSubmission ? isStillCurrentSubmission : undefined,
          batch,
          silent: batchOptions?.silent,
          model: nodeModel, provider: nodeProvider,
          projectId: submittingProjectId,
          prompt: effectivePrompt,
          imageSize,
          imageQuality,
          imageBackground,
          aspectRatio,
        });
        return mediaDelivered ? { success: true } : { success: false, message: taskReceipt
          ? '部分图片仍待保存或取回，原任务已保留' : '部分图片未能保存或生成，请核对已返回结果' };
      }
      const imageOptions = {
        prompt: effectivePrompt, model: nodeModel, provider: nodeProvider,
        imageSize, imageQuality, imageBackground: data.imageBackground === '' ? '' : imageBackground, aspectRatio, nodeId,
        workflowId, workflowInputs: data.workflowInputs, runninghubModelParameters: data.runninghubModelParameters,
      };
      if (lease) await assertLease();
      const result = lease ? await generateImage(imageOptions, lease.signal) : await generateImage(imageOptions);
      taskReceipt = result.taskReceipt;
      comfyTaskId = result.comfyTaskId;
      if (comfyTaskId) beginComfyNodeDelivery(nodeId, comfyTaskId);
      if (lease) await assertLease();
      if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };

      if (taskReceipt) store.updateNodeDataTransient(nodeId, { mediaTaskStage: 'saving' });
      const persisted = getCloudWorkflowPersistedOutput(result.workflowApiOutputs ?? result.runninghubOutputs, result.url) ?? (submittingProjectId
        ? await persistMediaUrlToProjectData(result.url, submittingProjectId, 'ai-image', data.label, { mediaDownloadAccess: result.mediaDownloadAccess })
        : { mediaUrl: result.url, sourceUrl: result.url });
      if (lease) await assertLease();
      if (guardedSubmission && !isStillCurrentSubmission()) return { success: false, message: '画布已变化，任务已保留' };
      const mediaUrl = persisted.mediaUrl;
      const applyImageData = lease && imageBatchLeases.has(lease) ? store.updateNodeDataTransient : updateResult;
      applyImageData(nodeId, {
        imageUrl: mediaUrl, sourceUrl: persisted.sourceUrl, filePath: persisted.filePath,
        thumbnailUrl: mediaUrl, output: persisted.sourceUrl, status: 'success',
        imageWidth: result.width, imageHeight: result.height,
        ...(isAnimation ? { aspectRatio, ...animationResultPatch(data) } : {}),
      });
      confirmMediaDelivery();
      if (result.workflowApiTaskId) completeWorkflowApiNodeTask(nodeId, result.workflowApiTaskId);
      if (result.comfyTaskId) completeComfyNodeTask(nodeId, result.comfyTaskId);
      store.syncDramaAssetImageFromNode?.(nodeId, mediaUrl);
      store.recordOutputHistory(nodeId, {
        nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
        output: persisted.sourceUrl, nodeType, model: nodeModel, provider: nodeProvider,
        status: 'success', mediaUrl, filePath: persisted.filePath,
        params: isAnimation ? { imageSize, aspectRatio, animationAction, animationFrames,
          grid: ANIMATION_FRAME_GRIDS[animationFrames], animationProcessing: spriteProcessing, animationPromptVersion: 1 }
          : { imageSize, imageQuality, imageBackground, aspectRatio },
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
          notify('角色 8 向宫格已生成');
        } catch {
          notify(`原图已生成，8 向宫格处理失败`, 'error');
        }
      } else {
        notify(isAnimation ? '帧动画生成完成' : '图片生成完成');
      }
    } else if (nodeType === 'ai-panorama') {
      const imageSize = (data.imageSize as string) || '2K';
      const aspectRatio = (data.aspectRatio as string) || '2:1';
      const result = await generateImage({
        prompt: buildPanoramaPrompt(effectivePrompt), model: nodeModel, provider: nodeProvider,
        imageSize, aspectRatio, nodeId,
        workflowId, workflowInputs: data.workflowInputs, runninghubModelParameters: data.runninghubModelParameters,
      });
      taskReceipt = result.taskReceipt;
      comfyTaskId = result.comfyTaskId;
      if (comfyTaskId) beginComfyNodeDelivery(nodeId, comfyTaskId);
      if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
      if (taskReceipt) store.updateNodeDataTransient(nodeId, { mediaTaskStage: 'saving' });
      const persisted = submittingProjectId
        ? await persistMediaUrlToProjectData(result.url, submittingProjectId, 'ai-panorama', data.label, { mediaDownloadAccess: result.mediaDownloadAccess })
        : { mediaUrl: result.url, sourceUrl: result.url };
      if (!isStillCurrentSubmission()) return { success: false, message: '画布已变化，任务已保留' };
      const mediaUrl = persisted.mediaUrl;
      updateResult(nodeId, {
        imageUrl: mediaUrl, sourceUrl: persisted.sourceUrl, filePath: persisted.filePath,
        thumbnailUrl: mediaUrl, output: persisted.sourceUrl, status: 'success',
        imageWidth: result.width, imageHeight: result.height,
      });
      confirmMediaDelivery();
      if (result.comfyTaskId) completeComfyNodeTask(nodeId, result.comfyTaskId);
      store.recordOutputHistory(nodeId, {
        nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
        output: persisted.sourceUrl, nodeType: 'ai-panorama', model: nodeModel, provider: nodeProvider,
        status: 'success', mediaUrl, filePath: persisted.filePath,
        params: { imageSize, aspectRatio },
      });
      notify('全景图生成完成');
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
        comfyRefmods: data.comfyRefmods,
        comfyH3MemoryPreset: data.comfyH3MemoryPreset,
        comfyH3ExpectedSettings: batchOptions?.comfyH3ExpectedSettings,
      };
      // 异步哈希/版本检查完成后再提交付费请求；撤销的租约不写失败历史。
      if (lease) {
        await assertLease();
        if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
      }
      const assertVideoSubmission = async () => {
        if (lease) await assertLease();
        if (!isStillCurrentSubmission()) throw new Error('镜头或生成输入已变化，请重新生成');
      };
      const result = lease || hasProtectedVideoInputs
        ? await generateVideo(videoOptions, lease?.signal, assertVideoSubmission)
        : await generateVideo(videoOptions);
      taskReceipt = result.taskReceipt;
      if (lease) await assertLease();
      if (!isStillCurrentSubmission()) {
        if (taskReceipt) pauseMediaTask(taskReceipt, undefined, 'canvas_changed');
        return { success: false, message: '任务已取消' };
      }
      if (taskReceipt) store.updateNodeDataTransient(nodeId, { mediaTaskStage: 'saving' });
      const persisted = getCloudWorkflowPersistedOutput(result.workflowApiOutputs ?? result.runninghubOutputs, result.url) ?? (submittingProjectId
        ? await persistMediaUrlToProjectData(result.url, submittingProjectId, 'ai-video', data.label, { mediaDownloadAccess: result.mediaDownloadAccess })
        : { mediaUrl: result.url, sourceUrl: result.url });
      if (lease) await assertLease();
      if (!isStillCurrentSubmission()) {
        if (taskReceipt) pauseMediaTask(taskReceipt, undefined, 'canvas_changed');
        return { success: false, message: lease ? '任务已取消' : '画布已变化，任务已保留' };
      }
      if (lease) await assertLease();
      if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
      updateResult(nodeId, {
        videoUrl: persisted.mediaUrl, sourceUrl: persisted.sourceUrl, filePath: persisted.filePath,
        thumbnailUrl: persisted.mediaUrl, output: persisted.sourceUrl, status: 'success', videoBatchFingerprint: videoFingerprint, videoTaskState: undefined,
      });
      confirmMediaDelivery();
      if (result.workflowApiTaskId) completeWorkflowApiNodeTask(nodeId, result.workflowApiTaskId);
      await store.recordOutputHistory(nodeId, {
        nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
        output: persisted.sourceUrl, nodeType: 'ai-video', model: nodeModel, provider: nodeProvider,
        status: 'success', mediaUrl: persisted.mediaUrl, filePath: persisted.filePath,
        params: { videoResolution, videoFps, videoFrames, seedanceResolution, seedanceRatio, seedanceDuration, generateAudio: genAudio, cameraSettings: data.cameraSettings },
      }, true);
      notify('视频生成完成');
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
      taskReceipt = result.taskReceipt;
      comfyTaskId = result.comfyTaskId;
      if (comfyTaskId) beginComfyNodeDelivery(nodeId, comfyTaskId);
      if (!isStillCurrentSubmission()) {
        if (result.url.startsWith('blob:')) URL.revokeObjectURL(result.url);
        return { success: false, message: '任务已取消' };
      }
      if (taskReceipt) store.updateNodeDataTransient(nodeId, { mediaTaskStage: 'saving' });
      const persisted = await persistAudioGenerationResult(result, submittingProjectId, data.label);
      if (guardedSubmission && !isStillCurrentSubmission()) return { success: false, message: '画布已变化，任务已保留' };
      if (persisted.persistence === 'failed') throw new Error('音频已生成，但保存失败；请继续保存原结果');
      updateResult(nodeId, {
        audioUrl: persisted.mediaUrl, sourceUrl: persisted.sourceUrl, filePath: persisted.filePath,
        thumbnailUrl: persisted.mediaUrl, output: persisted.outputUrl,
        musicClipId: result.clipId,
        ...(result.title ? { musicTitle: result.title } : {}),
        ...(result.lyrics ? { musicLyrics: result.lyrics } : {}),
        status: 'success',
      });
      confirmMediaDelivery();
      if (result.workflowApiTaskId) completeWorkflowApiNodeTask(nodeId, result.workflowApiTaskId);
      if (result.comfyTaskId) completeComfyNodeTask(nodeId, result.comfyTaskId);
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
      notify('音频生成完成');
    } else if (nodeType === 'ai-shotlist') {
      await generateShotlistRows(nodeId, effectivePrompt, nodeModel, nodeProvider);
    } else {
      const textSource = prepareDramaExtractPrompt(rawPrompt, data.output);
      if (textSource !== rawPrompt) effectivePrompt = resolveProjectGenerationPrompt({
        prompt: textSource, data, settings: projectSettings, customStyles: store.customStyles,
      });
      const result = await generateText({ prompt: effectivePrompt, model: nodeModel, provider: nodeProvider });
      if (!isStillCurrentSubmission()) return { success: false, message: '任务已取消' };
      const processed = postProcessDramaExtractOutput(effectivePrompt, result);
      if (!processed.ok) throw new Error(processed.error);
      updateResult(nodeId, { output: processed.output, status: 'success' });
      store.recordOutputHistory(nodeId, {
        nodeId, nodeLabel: data.label, timestamp: Date.now(), prompt: effectivePrompt,
        output: processed.output, nodeType: 'ai-text', model: nodeModel, provider: nodeProvider, status: 'success',
      });
      if (processed.kind) {
        if (processed.parsed) {
          store.mergeDramaExtract(processed.parsed, {
            sourceNodeId: nodeId,
            modelId: nodeModel,
          });
        }
        const kindLabel =
          processed.kind === 'character' ? '人物' : processed.kind === 'scene' ? '场景' : '道具';
        notify(`${kindLabel}简介已提取并入库 · 「资产管理 > 短剧资产」可查看`);
      }
    }
    return { success: true };
  } catch (err) {
    if (isMediaTaskPausedError(err)) return { success: false, message: err instanceof Error ? err.message : '任务已保留' };
    if (!mediaDelivered && taskReceipt && pauseMediaTask(taskReceipt, err, 'delivery_pending')) {
      return { success: false, message: '结果保存暂未完成，任务已保留，可继续保存原结果' };
    }
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
    notify(msg, 'error');
    return { success: false, message: msg };
  } finally {
    if (!mediaDelivered && taskReceipt) pauseMediaTask(taskReceipt, undefined, isStillCurrentSubmission() ? 'delivery_pending' : 'canvas_changed');
    if (comfyTaskId) pauseComfyNodeDelivery(nodeId, comfyTaskId, isStillCurrentSubmission);
    const current = useAppStore.getState();
    const currentVideo = hasProtectedVideoInputs ? current.nodes.find((node) => node.id === nodeId) : undefined;
    if (videoOwner && videoSubmissionOwners.get(submissionKey) === videoOwner
      && current.currentProjectId === submittingProjectId && currentVideo?.data.status === 'loading'
      && (!cloudGuard || !isCanvasDerivationFresh(cloudGuard, current)
        || videoInputFingerprint({ ...currentVideo, data: { ...currentVideo.data, ...promptOverride } }, current) !== videoFingerprint)) {
      current.updateNodeDataTransient(nodeId, { status: 'error', error: '镜头或参考素材已变化，请核对后重新生成' });
    }
    if (videoOwner && videoSubmissionOwners.get(submissionKey) === videoOwner) videoSubmissionOwners.delete(submissionKey);
    if (cloudGuard) completeCanvasDerivation(cloudGuard);
    endOperation?.();
  }
}

/**
 * AINodeDialog AI 生成弹窗 — 点击节点后弹出的浮动面板，包含 Prompt 输入、模型选择、参数配置、生成按钮
 */
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
// 生成中的流光边框：仅在生成时按需加载
const BorderBeam = lazy(() => import('border-beam').then((m) => ({ default: m.BorderBeam })));
import { convertFileSrc } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
import { generateId, useAppStore } from '../../store/useAppStore';
import { derivedNodePlacement } from '../../store/store.utils';
import type { AnimationAction, BaseNodeData, CameraGenerationSettings, ImagePostProcess, ModelOption } from '../../types';
import { ANIMATION_FRAME_GRIDS } from '../../types';
import { generateShotlistRows } from '../../services/shotlistService';
import { MAX_IMAGE_BATCH_COUNT, type AudioOutputFormat, type AudioTtsVoice, type VideoReferenceItem } from '../../types/aiTypes';
import { generateText, generateImage, generateImagesBatch, generateVideo, generateAudio, buildPanoramaPrompt } from '../../services/aiService';
import { persistAudioGenerationResult } from '../../services/ai/generateAudio';
import { persistMediaUrlToProjectData } from '../../services/fileService';
import {
  applyImageBatchResults,
  failImageBatchNodes,
  prepareImageBatchNodes,
} from '../../services/imageBatchService';
import { createCharacterDirectionGrid } from '../../services/onnxService';
import PromptPanel from './shared/PromptPanel';
import type { MentionEditorHandle } from './shared/MentionEditor';
import ConnectedNodesPreview from './shared/ConnectedNodesPreview';
import { findMediaModelOption } from './shared/defaultModels';
import {
  CANVAS_PAN_DURATION_MS,
  requestCanvasPanBy,
} from '../../services/canvasViewportService';
import {
  getImageNodeDimensionsForAspectRatio,
  resolveProjectGenerationPrompt,
} from '../../services/projectSettingsService';
import {
  buildAnimationSpritePrompt,
  resolveAnimationSheetAspectRatio,
} from '../../services/ai/animationPrompt';
import { resolveVideoSubmissionControls } from '../../services/ai/videoRequestResolver';
import { buildGenerationCameraPrompt } from './shared/image/cameraStudio';
import { cancelComfyUINodeTask } from '../../services/comfyWorkflowService';
import { getPendingTasksForProject, resumeComfyUINodeTask, resumeRunningHubNodeTask, updatePendingTask, removePendingTask } from '../../services/pollManager';
import { isCloudWorkflow, getCloudWorkflowPersistedOutput, workflowExecution } from '../../services/workflowExecutionService';
import { completeWorkflowApiNodeTask, stopWorkflowApiNodeTask } from '../../services/workflowApi/workflowApiAdapter';
import WorkflowApiTaskStatus from './shared/WorkflowApiTaskStatus';
import { cancelRunningHubNodeTask, completeRunningHubNodeTask } from '../../services/ai/providers/runninghubWorkflow';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../../services/canvasDerivationGuard';
import { useT } from '../../i18n';

const DIALOG_VIEWPORT_MARGIN = 16;

function AINodeDialog() {
  const t = useT();
  const { activeNodeId, dialogPosition, closeNodeDialog, updateNodeData, updateNodeDataTransient, commitToHistory, recordOutputHistory, showToast, workflows, currentProjectId } = useAppStore(
    useShallow((s) => ({
      activeNodeId: s.activeNodeId,
      dialogPosition: s.dialogPosition,
      closeNodeDialog: s.closeNodeDialog,
      updateNodeData: s.updateNodeData,
      updateNodeDataTransient: s.updateNodeDataTransient,
      commitToHistory: s.commitToHistory,
      recordOutputHistory: s.recordOutputHistory,
      showToast: s.showToast,
      workflows: s.workflows,
      currentProjectId: s.currentProjectId,
    })),
  );

  // 仅订阅当前激活的节点（而非整个 nodes 数组），拖拽其他节点时不会触发本弹窗重渲染
  const node = useAppStore((s) => (s.activeNodeId ? s.nodes.find((n) => n.id === s.activeNodeId) : undefined));
  const performanceMode = useAppStore((s) => s.config.performanceMode === true);
  const data: BaseNodeData | undefined = node?.data;
  const nodeType = data?.type;

  const panelRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const cancellingNodeIdsRef = useRef(new Set<string>());
  const [isExpanded, setIsExpanded] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState({ nodeId: '', taskId: '', confirmed: false });

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const preview = previewRef.current;
    if (!panel || !activeNodeId || isExpanded) return;

    let scheduledFrame = 0;
    let settleTimer = 0;
    let releaseTransitionFrame = 0;
    let adjustmentLocked = false;
    let disposed = false;
    let trackedNodeElement: HTMLElement | null = null;

    // 浮层与节点的纵向偏移：
    // - 节点无内容（空预览）时上移 20px，让浮层顶部覆盖在节点底边一点，符合"贴在节点下方"的紧凑观感；
    // - 节点已有图片/视频/音频等产物时改为下移 12px，避免浮层遮住刚生成的画面。
    const computeVerticalOffset = (nodeHasMedia: boolean) => (nodeHasMedia ? 12 : -20);

    const positionDialog = (anchor: { x: number; y: number }, nodeHasMedia: boolean) => {
      const offsetY = computeVerticalOffset(nodeHasMedia);
      panel.style.left = `${anchor.x}px`;
      panel.style.top = `${anchor.y + offsetY}px`;
      if (preview) {
        preview.style.left = `${anchor.x}px`;
        preview.style.top = `${anchor.y + offsetY - 42}px`;
      }
    };

    const readNodeHasMedia = (): boolean => {
      if (!activeNodeId) return false;
      const latestData = useAppStore.getState().nodes.find((n) => n.id === activeNodeId)?.data as BaseNodeData | undefined;
      return !!(
        latestData?.imageUrl || latestData?.thumbnailUrl ||
        latestData?.videoUrl || latestData?.audioUrl
      );
    };

    const syncDialogToNode = () => {
      if (!trackedNodeElement?.isConnected) {
        trackedNodeElement = document.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${activeNodeId}"]`,
        );
      }
      const nodeRect = trackedNodeElement?.getBoundingClientRect();
      if (!nodeRect) return null;

      const anchor = {
        x: nodeRect.left + nodeRect.width / 2,
        y: nodeRect.bottom,
      };
      positionDialog(anchor, readNodeHasMedia());
      return anchor;
    };

    const panCanvasWithDialog = (deltaX: number, deltaY: number, duration: number) => {
      cancelAnimationFrame(releaseTransitionFrame);
      panel.style.transition = 'none';
      if (preview) preview.style.transition = 'none';
      const startAnchor = syncDialogToNode();
      if (!startAnchor) {
        adjustmentLocked = false;
        panel.style.removeProperty('transition');
        preview?.style.removeProperty('transition');
        return;
      }

      // 平移过程中也要按节点当前是否有内容来决定偏移，否则空节点和有内容节点之间会跳变
      const nodeHasMediaDuringPan = readNodeHasMedia();
      requestCanvasPanBy({
        deltaX,
        deltaY,
        duration,
        onProgress: (progress) => {
          if (disposed) return;
          positionDialog({
            x: startAnchor.x + progress.deltaX,
            y: startAnchor.y + progress.deltaY,
          }, nodeHasMediaDuringPan);
        },
        onComplete: (progress) => {
          if (disposed) return;
          const finalAnchor = {
            x: startAnchor.x + progress.deltaX,
            y: startAnchor.y + progress.deltaY,
          };
          positionDialog(finalAnchor, nodeHasMediaDuringPan);
          useAppStore.getState().openNodeDialog(activeNodeId, finalAnchor);
          releaseTransitionFrame = requestAnimationFrame(() => {
            panel.style.removeProperty('transition');
            preview?.style.removeProperty('transition');
            adjustmentLocked = false;
            scheduleUpdate();
          });
        },
      });
    };

    const revealDialog = () => {
      if (adjustmentLocked) return;

      const panelRect = panel.getBoundingClientRect();
      const visualViewport = window.visualViewport;
      const appRect = panel.closest<HTMLElement>('.app-box')?.getBoundingClientRect();
      const viewportLeft = visualViewport?.offsetLeft ?? 0;
      const viewportTop = visualViewport?.offsetTop ?? 0;
      const viewportRight = viewportLeft + (visualViewport?.width ?? window.innerWidth);
      const viewportBottom = viewportTop + (visualViewport?.height ?? window.innerHeight);
      const safeLeft = Math.max(viewportLeft, appRect?.left ?? viewportLeft) + DIALOG_VIEWPORT_MARGIN;
      const safeTop = Math.max(viewportTop, appRect?.top ?? viewportTop) + DIALOG_VIEWPORT_MARGIN;
      const safeRight = Math.min(viewportRight, appRect?.right ?? viewportRight) - DIALOG_VIEWPORT_MARGIN;
      const safeBottom = Math.min(viewportBottom, appRect?.bottom ?? viewportBottom) - DIALOG_VIEWPORT_MARGIN;
      const availableWidth = safeRight - safeLeft;
      const availableHeight = safeBottom - safeTop;
      let deltaX = 0;
      let deltaY = 0;

      if (panelRect.width <= availableWidth) {
        if (panelRect.left < safeLeft) deltaX = safeLeft - panelRect.left;
        else if (panelRect.right > safeRight) deltaX = safeRight - panelRect.right;
      }
      if (panelRect.height <= availableHeight) {
        if (panelRect.top < safeTop) deltaY = safeTop - panelRect.top;
        else if (panelRect.bottom > safeBottom) deltaY = safeBottom - panelRect.bottom;
      }

      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;

      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const duration = reduceMotion ? 0 : CANVAS_PAN_DURATION_MS;
      adjustmentLocked = true;
      panCanvasWithDialog(deltaX, deltaY, duration);
    };

    const scheduleUpdate = () => {
      cancelAnimationFrame(scheduledFrame);
      scheduledFrame = requestAnimationFrame(revealDialog);
    };
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(panel);
    const appBox = panel.closest<HTMLElement>('.app-box');
    if (appBox) observer.observe(appBox);
    scheduleUpdate();
    settleTimer = window.setTimeout(scheduleUpdate, CANVAS_PAN_DURATION_MS);
    window.addEventListener('resize', scheduleUpdate);
    window.visualViewport?.addEventListener('resize', scheduleUpdate);

    return () => {
      disposed = true;
      cancelAnimationFrame(scheduledFrame);
      cancelAnimationFrame(releaseTransitionFrame);
      window.clearTimeout(settleTimer);
      panel.style.removeProperty('transition');
      preview?.style.removeProperty('transition');
      observer.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.visualViewport?.removeEventListener('resize', scheduleUpdate);
    };
  }, [activeNodeId, isExpanded]);

  // 节点尺寸变化时，重新计算浮动面板位置，使其跟随节点平滑移动
  useEffect(() => {
    if (!activeNodeId || isExpanded) return;
    const el = document.querySelector(`.react-flow__node[data-id="${activeNodeId}"]`);
    if (!el) return;

    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      useAppStore.getState().openNodeDialog(activeNodeId, { x: rect.left + rect.width / 2, y: rect.bottom });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeNodeId, isExpanded]);
  const editorApiRef = useRef<MentionEditorHandle>(null);

  const continuousEditActiveRef = useRef(false);
  const finishContinuousEdit = useCallback(() => {
    if (!continuousEditActiveRef.current) return;
    commitToHistory();
    continuousEditActiveRef.current = false;
  }, [commitToHistory]);
  const updateContinuousNodeData = useCallback((patch: Partial<BaseNodeData>) => {
    if (!activeNodeId) return;
    if (!continuousEditActiveRef.current) {
      commitToHistory();
      continuousEditActiveRef.current = true;
    }
    updateNodeDataTransient(activeNodeId, patch);
  }, [activeNodeId, commitToHistory, updateNodeDataTransient]);
  const handleCloseNodeDialog = useCallback(() => {
    finishContinuousEdit();
    closeNodeDialog();
  }, [closeNodeDialog, finishContinuousEdit]);

  useEffect(() => () => finishContinuousEdit(), [activeNodeId, finishContinuousEdit]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (isExpanded) {
          setIsExpanded(false);
        } else {
          handleCloseNodeDialog();
        }
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [handleCloseNodeDialog, isExpanded]);

  // All hooks must be called before any early return
  const onPromptChange = useCallback(
    (value: string) => {
      const current = useAppStore.getState().nodes.find((item) => item.id === activeNodeId)?.data;
      if (isCloudWorkflow(useAppStore.getState().workflows.find((item) => item.id === current?.workflowId))) {
        updateContinuousNodeData({ prompt: value }); return;
      }
      // Extract workflow IO node assignments from the prompt string
      // Format: @wf{ioNodeId|title|type}(value content)
      // ioNodeId can contain ":" (e.g. "57:27"), fields are pipe-separated to avoid ambiguity
      const workflowInputs: Record<string, string> = {};
      const wfRegex = /@wf\{([^|]+)\|([^|]+)\|([^|}]+)\}\(([\s\S]*?)\)/g;
      let match: RegExpExecArray | null;
      while ((match = wfRegex.exec(value)) !== null) {
        const ioNodeId = match[1]; // Full ID (may contain ":")
        const valueText = match[4].replace(/\n$/, '');
        workflowInputs[ioNodeId] = valueText;
      }
      updateContinuousNodeData({ prompt: value, workflowInputs: Object.keys(workflowInputs).length > 0 ? workflowInputs : undefined });
    },
    [activeNodeId, updateContinuousNodeData]
  );

  // 调用选中模型生成（文本 or 图片）
  // overridePrompt: / 指令菜单直接触发时传入的整合后模板，不走 store → 对话框不闪烁
  const onSubmit = useCallback(async (overridePrompt?: string, postProcess?: ImagePostProcess) => {
    finishContinuousEdit();
    // 实时从 store 读取全部数据 — 避免闭包 data 为 undefined
    const store = useAppStore.getState();
    const latestNode = store.nodes.find((n) => n.id === activeNodeId);
    const latestData = latestNode?.data as BaseNodeData | undefined;
    if (!latestData) {
      showToast(t('节点不存在'), 'error');
      return;
    }
    if (store.currentProjectId && getPendingTasksForProject(store.currentProjectId).some((task) => (
      task.nodeId === activeNodeId && task.taskType === 'comfyui' && task.comfyRecoveryState
    ))) {
      showToast(t('该节点还有未确认结束的 ComfyUI 任务，请先继续查询或终止任务'), 'error');
      return;
    }
    const rawPrompt = overridePrompt ?? (latestData.prompt as string) ?? '';
    const cloudWorkflow = isCloudWorkflow(store.workflows.find((item) => item.id === latestData.workflowId));
    if (!rawPrompt.trim() && !cloudWorkflow && latestData.provider !== 'runninghub') {
      showToast(t('请输入提示词'), 'error');
      return;
    }
    const projectSettings = store.projects.find(
      (project) => project.id === currentProjectId,
    )?.settings;
    const projectPrompt = resolveProjectGenerationPrompt({
      prompt: rawPrompt,
      data: latestData,
      settings: projectSettings,
      customStyles: store.customStyles,
    });
    const cameraPrompt = buildGenerationCameraPrompt(latestData.cameraSettings);
    const effectivePrompt = cameraPrompt && (nodeType === 'ai-image' || nodeType === 'ai-video')
      ? `${projectPrompt}\n\nCamera settings: ${cameraPrompt}.`
      : projectPrompt;
    const nodeModel = latestData?.model;
    const nodeProvider = latestData?.provider;
    const nodeLabel = latestData?.label ?? '';
    if (!nodeModel || !nodeProvider) {
      showToast(t('请先在底部模型选择器中选择一个模型'), 'error');
      return;
    }
    const submittingNodeId = activeNodeId!;
    const submittingProjectId = currentProjectId;
    const runningHubTask = cloudWorkflow || latestData.provider === 'runninghub';
    let cloudGuard = runningHubTask ? registerCanvasDerivation(store, submittingNodeId) : null;
    const isStillCurrentSubmission = () => {
      const state = useAppStore.getState();
      return (
        state.currentProjectId === submittingProjectId
        && state.nodes.some((n) => n.id === submittingNodeId)
        && (!runningHubTask || (!!cloudGuard && isCanvasDerivationFresh(cloudGuard, state)))
      );
    };
    updateNodeDataTransient(activeNodeId!, { status: 'loading', error: undefined });
    let batchNodeIds: string[] | undefined;
    try {
      const batchCount = cloudWorkflow ? 1 : Math.min(MAX_IMAGE_BATCH_COUNT, Math.max(1, Math.floor(Number(latestData.batchCount) || 1)));
      if (nodeType === 'ai-image' && batchCount > 1) {
        if (postProcess) throw new Error(t('批量生成暂不支持图片后处理，请将数量设为 1'));
        const imageSize = (latestData.imageSize as string) || '2K';
        const aspectRatio = (latestData.aspectRatio as string) || '1:1';
        batchNodeIds = prepareImageBatchNodes({
          nodeId: submittingNodeId,
          count: batchCount,
          projectId: submittingProjectId,
        }).nodeIds;
        if (cloudGuard) completeCanvasDerivation(cloudGuard);
        cloudGuard = runningHubTask ? registerCanvasDerivation(useAppStore.getState(), submittingNodeId) : null;
        showToast(t('正在批量生成 {count} 张图片', { count: batchCount }));
        const batch = await generateImagesBatch({
          prompt: effectivePrompt,
          model: nodeModel,
          provider: nodeProvider,
          imageSize,
          aspectRatio,
          workflowId: latestData.workflowId,
          workflowInputs: latestData.workflowInputs, runninghubModelParameters: latestData.runninghubModelParameters,
          nodeId: activeNodeId ?? undefined,
        }, batchCount);
        if (!isStillCurrentSubmission()) return;
        await applyImageBatchResults({
          nodeId: submittingNodeId,
          targetNodeIds: batchNodeIds,
          isCurrent: runningHubTask ? isStillCurrentSubmission : undefined,
          batch,
          projectId: submittingProjectId,
          prompt: effectivePrompt,
          imageSize,
          aspectRatio,
        });
        return;
      }
      if (nodeType === 'ai-image' || nodeType === 'ai-animation') {
        const isAnimation = nodeType === 'ai-animation';
        const imageSize = (latestData.imageSize as string) || '2K';
        const animationAction = latestData.animationAction ?? 'idle';
        const animationFrames = latestData.animationFrames ?? 8;
        const aspectRatio = isAnimation
          ? resolveAnimationSheetAspectRatio(animationFrames, nodeProvider)
          : (latestData.aspectRatio as string) || '1:1';
        const requestPrompt = isAnimation
          ? buildAnimationSpritePrompt(effectivePrompt, animationAction, animationFrames, aspectRatio)
          : effectivePrompt;
        const result = await generateImage({
          prompt: requestPrompt,
          model: nodeModel,
          provider: nodeProvider,
          imageSize,
          aspectRatio,
          workflowId: latestData.workflowId,
          workflowInputs: latestData.workflowInputs, runninghubModelParameters: latestData.runninghubModelParameters,
          nodeId: activeNodeId ?? undefined,
        });
        if (!isStillCurrentSubmission()) return;
        // 下载远程 URL 到本地项目目录
        const persisted = getCloudWorkflowPersistedOutput(result.workflowApiOutputs ?? result.runninghubOutputs, result.url) ?? (currentProjectId
          ? await persistMediaUrlToProjectData(result.url, currentProjectId, 'ai-image', nodeLabel)
          : { mediaUrl: result.url, sourceUrl: result.url });
        if (runningHubTask && !isStillCurrentSubmission()) return;
        const mediaUrl = persisted.mediaUrl;
        updateNodeData(activeNodeId!, {
          imageUrl: mediaUrl,
          sourceUrl: persisted.sourceUrl,
          filePath: persisted.filePath,
          thumbnailUrl: mediaUrl,
          output: persisted.sourceUrl,
          status: 'success',
          imageWidth: result.width,
          imageHeight: result.height,
          ...(isAnimation ? { aspectRatio } : {}),
        });
        if (runningHubTask) completeRunningHubNodeTask(submittingNodeId);
        if (result.workflowApiTaskId) completeWorkflowApiNodeTask(submittingNodeId, result.workflowApiTaskId);
        useAppStore.getState().syncDramaAssetImageFromNode?.(activeNodeId!, mediaUrl);
        recordOutputHistory(activeNodeId!, {
          nodeId: activeNodeId!,
          nodeLabel: nodeLabel,
          timestamp: Date.now(),
          prompt: effectivePrompt,
          output: persisted.sourceUrl,
          nodeType: isAnimation ? 'ai-animation' : 'ai-image',
          model: nodeModel,
          provider: nodeProvider,
          status: 'success',
          mediaUrl,
          filePath: persisted.filePath,
          params: isAnimation
            ? { imageSize, aspectRatio, animationAction, animationFrames, grid: ANIMATION_FRAME_GRIDS[animationFrames] }
            : { imageSize, aspectRatio, cameraSettings: latestData.cameraSettings },
        });
        if (postProcess === 'character-8-direction-grid') {
          if (!persisted.filePath) {
            showToast(t('原图已生成，但未能保存到本地，无法自动生成 8 向宫格'), 'error');
          } else {
            showToast(t('图片生成完成，正在后台切图生成 8 向宫格'));
            try {
              if (!isStillCurrentSubmission()) return;

              const gridResult = await createCharacterDirectionGrid(persisted.filePath);
              if (!isStillCurrentSubmission()) return;

              const store2 = useAppStore.getState();
              const sourceNode = store2.nodes.find((item) => item.id === submittingNodeId);
              if (!sourceNode) return;
              store2.addNode({
                id: `node-${generateId()}`,
                type: 'ai-storyboard',
                ...derivedNodePlacement(sourceNode, 60),
                data: {
                  label: `${nodeLabel} 8向宫格`,
                  type: 'ai-storyboard',
                  role: 'source',
                  status: 'success',
                  imageUrl: convertFileSrc(gridResult.grid_path),
                  filePath: gridResult.grid_path,
                  imageWidth: gridResult.grid_size,
                  imageHeight: gridResult.grid_size,
                  storyboardRows: 3,
                  storyboardCols: 3,
                  nodeWidth: 360,
                  nodeHeight: 360,
                },
              });
              showToast(t('角色 8 向宫格已生成'));
            } catch (postProcessError) {
              const message = postProcessError instanceof Error
                ? postProcessError.message
                : typeof postProcessError === 'string'
                  ? postProcessError
                  : t('未知错误');
              showToast(t('原图已生成，8 向宫格处理失败：{message}', { message }), 'error');
            }
          }
        } else {
          showToast(isAnimation ? t('Sprite Sheet 生成完成') : t('图片生成完成'));
        }
      } else if (nodeType === 'ai-panorama') {
        const imageSize = (latestData.imageSize as string) || '2K';
        const aspectRatio = (latestData.aspectRatio as string) || '2:1';
        const fullPrompt = buildPanoramaPrompt(effectivePrompt);
        const result = await generateImage({
          prompt: fullPrompt,
          model: nodeModel,
          provider: nodeProvider,
          imageSize,
          aspectRatio,
          workflowId: latestData.workflowId,
          workflowInputs: latestData.workflowInputs, runninghubModelParameters: latestData.runninghubModelParameters,
          nodeId: activeNodeId ?? undefined,
        });
        if (!isStillCurrentSubmission()) return;
        const persisted = currentProjectId
          ? await persistMediaUrlToProjectData(result.url, currentProjectId, 'ai-panorama', nodeLabel)
          : { mediaUrl: result.url, sourceUrl: result.url };
        const mediaUrl = persisted.mediaUrl;
        updateNodeData(activeNodeId!, {
          imageUrl: mediaUrl,
          sourceUrl: persisted.sourceUrl,
          filePath: persisted.filePath,
          thumbnailUrl: mediaUrl,
          output: persisted.sourceUrl,
          status: 'success',
          imageWidth: result.width,
          imageHeight: result.height,
        });
        recordOutputHistory(activeNodeId!, {
          nodeId: activeNodeId!,
          nodeLabel: nodeLabel,
          timestamp: Date.now(),
          prompt: effectivePrompt,
          output: persisted.sourceUrl,
          nodeType: 'ai-panorama',
          model: nodeModel,
          provider: nodeProvider,
          status: 'success',
          mediaUrl,
          filePath: persisted.filePath,
          params: { imageSize, aspectRatio },
        });
        showToast(t('全景图生成完成'));
      } else if (nodeType === 'ai-video') {
        const {
          videoResolution,
          videoFps,
          videoFrames,
          seedanceResolution,
          seedanceRatio,
          seedanceDuration,
        } = resolveVideoSubmissionControls({
          provider: nodeProvider,
          workflowId: latestData.workflowId,
          videoResolution: latestData.videoResolution as number | undefined,
          videoFps: latestData.videoFps as number | undefined,
          videoFrames: latestData.videoFrames as number | undefined,
          seedanceResolution: latestData.seedanceResolution as string | undefined,
          seedanceRatio: latestData.seedanceRatio as string | undefined,
          seedanceDuration: latestData.seedanceDuration as number | undefined,
        });
        const generateAudio = latestData.generateAudio as boolean | undefined;
        const result = await generateVideo({
          prompt: effectivePrompt,
          model: nodeModel,
          provider: nodeProvider,
          videoResolution,
          videoFps,
          videoFrames,
          seedanceResolution,
          seedanceRatio,
          seedanceDuration,
          generateAudio,
          workflowId: latestData.workflowId,
          workflowInputs: latestData.workflowInputs, runninghubModelParameters: latestData.runninghubModelParameters,
          nodeId: activeNodeId ?? undefined,
        });
        if (!isStillCurrentSubmission()) return;
        // 下载远程 URL 到本地项目目录
        const persisted = getCloudWorkflowPersistedOutput(result.workflowApiOutputs ?? result.runninghubOutputs, result.url) ?? (currentProjectId
          ? await persistMediaUrlToProjectData(result.url, currentProjectId, 'ai-video', nodeLabel)
          : { mediaUrl: result.url, sourceUrl: result.url });
        if (runningHubTask && !isStillCurrentSubmission()) return;
        const mediaUrl = persisted.mediaUrl;
        updateNodeData(activeNodeId!, {
          videoUrl: mediaUrl,
          sourceUrl: persisted.sourceUrl,
          filePath: persisted.filePath,
          thumbnailUrl: mediaUrl,
          output: persisted.sourceUrl,
          status: 'success',
        });
        if (result.workflowApiTaskId) completeWorkflowApiNodeTask(submittingNodeId, result.workflowApiTaskId);
        if (runningHubTask) completeRunningHubNodeTask(submittingNodeId);
        if (result.workflowApiTaskId) completeWorkflowApiNodeTask(submittingNodeId, result.workflowApiTaskId);
        recordOutputHistory(activeNodeId!, {
          nodeId: activeNodeId!,
          nodeLabel: nodeLabel,
          timestamp: Date.now(),
          prompt: effectivePrompt,
          output: persisted.sourceUrl,
          nodeType: 'ai-video',
          model: nodeModel,
          provider: nodeProvider,
          status: 'success',
          mediaUrl,
          filePath: persisted.filePath,
          params: { videoResolution, videoFps, videoFrames, seedanceResolution, seedanceRatio, seedanceDuration, generateAudio, cameraSettings: latestData.cameraSettings },
        });
        showToast(t('视频生成完成'));
      } else if (nodeType === 'ai-audio') {
        const result = await generateAudio({
          prompt: effectivePrompt,
          model: nodeModel,
          provider: nodeProvider,
          audioVoice: latestData.audioVoice,
          audioFormat: latestData.audioFormat,
          audioSpeed: latestData.audioSpeed,
          musicTitle: latestData.musicTitle,
          musicLyrics: latestData.musicLyrics,
          musicBpm: latestData.musicBpm,
          musicDuration: latestData.musicDuration,
          autoGenerateLyrics: latestData.autoGenerateLyrics,
          workflowId: latestData.workflowId,
          workflowInputs: latestData.workflowInputs, runninghubModelParameters: latestData.runninghubModelParameters,
          nodeId: activeNodeId ?? undefined,
        });
        if (!isStillCurrentSubmission()) {
          if (result.url.startsWith('blob:')) URL.revokeObjectURL(result.url);
          return;
        }
        const persisted = await persistAudioGenerationResult(result, currentProjectId, nodeLabel);
        if (runningHubTask && !isStillCurrentSubmission()) return;
        updateNodeData(activeNodeId!, {
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
        if (runningHubTask) completeRunningHubNodeTask(submittingNodeId);
        if (result.workflowApiTaskId) completeWorkflowApiNodeTask(submittingNodeId, result.workflowApiTaskId);
        recordOutputHistory(activeNodeId!, {
          nodeId: activeNodeId!,
          nodeLabel: nodeLabel,
          timestamp: Date.now(),
          prompt: effectivePrompt,
          output: persisted.outputUrl,
          nodeType: 'ai-audio',
          model: nodeModel,
          provider: nodeProvider,
          status: 'success',
          mediaUrl: persisted.mediaUrl,
          filePath: persisted.filePath,
          params: {
            audioVoice: latestData.audioVoice,
            audioFormat: latestData.audioFormat,
            audioSpeed: latestData.audioSpeed,
            musicTitle: result.title || latestData.musicTitle,
            musicBpm: latestData.musicBpm,
            musicDuration: latestData.musicDuration,
            autoGenerateLyrics: latestData.autoGenerateLyrics,
          },
        });
        showToast(t('音频生成完成'));
      } else if (nodeType === 'ai-shotlist') {
        const rows = await generateShotlistRows(submittingNodeId, effectivePrompt, nodeModel, nodeProvider);
        showToast(t('已生成 {count} 个镜头', { count: rows.length }));
      } else {
        const result = await generateText({
          prompt: effectivePrompt,
          model: nodeModel,
          provider: nodeProvider,
        });
        const { postProcessDramaExtractOutput } = await import('../../services/dramaAssetExtract');
        const processed = postProcessDramaExtractOutput(effectivePrompt, result);
        updateNodeData(activeNodeId!, { output: processed.output, status: 'success' });
        recordOutputHistory(activeNodeId!, {
          nodeId: activeNodeId!,
          nodeLabel: nodeLabel,
          timestamp: Date.now(),
          prompt: effectivePrompt,
          output: processed.output,
          nodeType: 'ai-text',
          model: nodeModel,
          provider: nodeProvider,
          status: 'success',
        });
        if (processed.kind) {
          if (processed.ok && processed.parsed) {
            useAppStore.getState().mergeDramaExtract(processed.parsed, {
              sourceNodeId: activeNodeId!,
              modelId: nodeModel,
            });
          }
          const kindLabel =
            processed.kind === 'character' ? t('人物') : processed.kind === 'scene' ? t('场景') : t('道具');
          if (processed.ok) {
            showToast(t('{kind}简介已提取并入库 · 「资产管理 > 短剧资产」可查看', { kind: kindLabel }));
          } else {
            showToast(t('已提取，但 JSON 未完全规范化，请检查输出'), 'error');
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : (typeof err === 'string' && err.trim() ? err : t('生成失败'));
      if (
        (err instanceof DOMException && err.name === 'AbortError')
        || msg === '任务已被取消'
        || msg === '请求已取消'
      ) {
        return;
      }
      if (!isStillCurrentSubmission()) return;
      if (batchNodeIds) failImageBatchNodes(batchNodeIds, msg, submittingProjectId);
      updateNodeDataTransient(activeNodeId!, { status: 'error', error: msg });
      recordOutputHistory(activeNodeId!, {
        nodeId: activeNodeId!,
        nodeLabel: nodeLabel,
        timestamp: Date.now(),
        prompt: effectivePrompt,
        output: '',
        nodeType: nodeType as 'ai-text' | 'ai-image' | 'ai-video' | 'ai-audio' | 'ai-panorama',
        model: nodeModel,
        provider: nodeProvider,
        status: 'error',
        error: msg,
      });
      showToast(msg, 'error');
    } finally {
      if (runningHubTask && isStillCurrentSubmission() && useAppStore.getState().nodes.find((item) => item.id === submittingNodeId)?.data.status === 'success') completeRunningHubNodeTask(submittingNodeId);
      if (cloudGuard) completeCanvasDerivation(cloudGuard);
    }
  }, [activeNodeId, nodeType, currentProjectId, finishContinuousEdit, updateNodeData, updateNodeDataTransient, recordOutputHistory, showToast, t]);

  const onCancelGeneration = useCallback(async () => {
    if (!activeNodeId || cancellingNodeIdsRef.current.has(activeNodeId)) return;
    const nodeId = activeNodeId;
    const projectId = currentProjectId;
    if (useAppStore.getState().nodes.find((item) => item.id === nodeId)?.data.provider === 'workflow-api') {
      stopWorkflowApiNodeTask(nodeId); return;
    }
    const cloud = ['runninghubwf', 'runninghub'].includes(useAppStore.getState().nodes.find((item) => item.id === nodeId)?.data.provider ?? '');
    const originalTaskId = projectId ? getPendingTasksForProject(projectId).find((task) => task.nodeId === nodeId)?.taskId : undefined;
    const isCurrent = () => useAppStore.getState().currentProjectId === projectId
      && useAppStore.getState().nodes.some((item) => item.id === nodeId)
      && (!projectId || !getPendingTasksForProject(projectId).some((task) => task.nodeId === nodeId && task.taskId !== originalTaskId));
    cancellingNodeIdsRef.current.add(nodeId);
    try {
      const cloudResult = cloud ? await cancelRunningHubNodeTask(nodeId) : undefined;
      if (!cloud) await cancelComfyUINodeTask(nodeId);
      if (!isCurrent()) return;
      updateNodeDataTransient(nodeId, { status: 'idle', error: undefined });
      showToast(cloud ? (cloudResult === 'local-stopped' ? '已停止本地等待；已提交的任务仍在平台运行，可继续查询' : 'RunningHub 已确认任务结束') : t('已终止 ComfyUI 任务'));
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : t('无法终止 ComfyUI 任务');
      updateNodeDataTransient(nodeId, { status: 'error', error: cloud ? message : t('ComfyUI 取消尚未确认，任务已保留，可继续查询或再次终止') });
      showToast(t('取消尚未确认，任务已保留：{message}', { message }), 'error');
    } finally {
      cancellingNodeIdsRef.current.delete(nodeId);
    }
  }, [activeNodeId, currentProjectId, showToast, t, updateNodeDataTransient]);

  /**
   * 「直接输出」只对产物就是文字的节点成立：媒体节点没有模型就没有素材，
   * 分镜表的产物是表格行，把提示词原样倒进 output 也不会出现在表里。
   */
  const supportsPassThrough = nodeType !== 'ai-image'
    && nodeType !== 'ai-animation'
    && nodeType !== 'ai-video'
    && nodeType !== 'ai-audio'
    && nodeType !== 'ai-shotlist';

  // 直接将输入内容作为节点输出（跳过模型调用）
  const onPassThrough = useCallback(() => {
    const ld = useAppStore.getState().nodes.find((n) => n.id === activeNodeId)?.data as BaseNodeData | undefined;
    if (!ld?.prompt?.trim() || !ld?.type) return;
    updateNodeData(activeNodeId!, { output: ld.prompt, status: 'success' });
    recordOutputHistory(activeNodeId!, {
      nodeId: activeNodeId!,
      nodeLabel: ld.label,
      timestamp: Date.now(),
      prompt: ld.prompt,
      output: ld.prompt,
      nodeType: ld.type,
      model: ld.model || 'passthrough',
      provider: ld.provider || 'passthrough',
      status: 'success',
    });
  }, [activeNodeId, updateNodeData, recordOutputHistory]);

  const onModelSelect = useCallback(
    (model: ModelOption) => {
      updateNodeData(activeNodeId!, {
        model: model.value,
        provider: model.provider,
        audioPurpose: model.audioPurpose,
        runninghubModelParameters: undefined, runninghubOutputs: undefined, runninghubStage: undefined, workflowId: undefined,
        ...(nodeType === 'ai-video' && model.provider === 'general' ? {
          videoResolution: undefined,
          videoFps: undefined,
          videoFrames: undefined,
          seedanceResolution: undefined,
          seedanceRatio: undefined,
          seedanceDuration: undefined,
          generateAudio: undefined,
        } : {}),
        ...(model.provider === 'dreamina' ? { batchCount: 1 } : {}),
      });
    },
    [activeNodeId, nodeType, updateNodeData]
  );

  const onWorkflowSelect = useCallback(
    (workflowId: string | undefined) => {
      const workflow = useAppStore.getState().workflows.find((item) => item.id === workflowId);
      updateNodeData(activeNodeId!, {
        workflowId,
        workflowInputs: undefined, runninghubModelParameters: undefined, runninghubOutputs: undefined, runninghubStage: undefined,
        workflowApiOutputs: undefined, workflowApiStage: undefined,
        ...(workflow ? { ...workflowExecution(workflow), batchCount: 1, audioPurpose: undefined } : {}),
      });
    },
    [activeNodeId, updateNodeData]
  );

  const onChangeImageSize = useCallback(
    (value: string) => updateNodeData(activeNodeId!, { imageSize: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeAspectRatio = useCallback(
    (value: string) => {
      const updateData: Partial<BaseNodeData> = { aspectRatio: value };
      const dimensions = getImageNodeDimensionsForAspectRatio(value);
      if (dimensions) Object.assign(updateData, dimensions);

      updateNodeData(activeNodeId!, updateData);
    },
    [activeNodeId, updateNodeData]
  );

  const onChangeBatchCount = useCallback(
    (value: number) => updateNodeData(activeNodeId!, { batchCount: value }),
    [activeNodeId, updateNodeData],
  );

  const onChangeCameraSettings = useCallback(
    (value: CameraGenerationSettings | undefined) => updateNodeData(activeNodeId!, { cameraSettings: value }),
    [activeNodeId, updateNodeData],
  );

  const onChangeVideoResolution = useCallback(
    // 自定义长边是逐字输入的，走连续编辑，别把每个键都记成一步撤销
    (value: number) => updateContinuousNodeData({ videoResolution: value }),
    [updateContinuousNodeData]
  );

  const onChangeVideoFps = useCallback(
    (value: number | undefined) => updateNodeData(activeNodeId!, { videoFps: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeSeedanceResolution = useCallback(
    (value: string | undefined) => updateNodeData(activeNodeId!, { seedanceResolution: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeSeedanceRatio = useCallback(
    (value: string | undefined) => updateNodeData(activeNodeId!, { seedanceRatio: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeSeedanceDuration = useCallback(
    (value: number | undefined) => updateContinuousNodeData({ seedanceDuration: value }),
    [updateContinuousNodeData]
  );

  const onChangeGenerateAudio = useCallback(
    (value: boolean | undefined) => updateNodeData(activeNodeId!, { generateAudio: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeVideoReferences = useCallback(
    (value: VideoReferenceItem[]) => updateNodeData(activeNodeId!, { videoReferences: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeAudioVoice = useCallback(
    (value: AudioTtsVoice) => updateNodeData(activeNodeId!, { audioVoice: value }),
    [activeNodeId, updateNodeData],
  );

  const onChangeAudioFormat = useCallback(
    (value: AudioOutputFormat) => updateNodeData(activeNodeId!, { audioFormat: value }),
    [activeNodeId, updateNodeData],
  );

  const onChangeAudioSpeed = useCallback(
    (value: number) => updateContinuousNodeData({ audioSpeed: value }),
    [updateContinuousNodeData],
  );

  const onChangeMusicTitle = useCallback(
    (value: string) => updateContinuousNodeData({ musicTitle: value }),
    [updateContinuousNodeData],
  );

  const onChangeMusicLyrics = useCallback(
    (value: string) => updateContinuousNodeData({ musicLyrics: value }),
    [updateContinuousNodeData],
  );

  const onChangeMusicBpm = useCallback(
    (value: number | undefined) => updateContinuousNodeData({ musicBpm: value }),
    [updateContinuousNodeData],
  );

  const onChangeMusicDuration = useCallback(
    (value: number) => updateContinuousNodeData({ musicDuration: value }),
    [updateContinuousNodeData],
  );

  const onChangeAutoGenerateLyrics = useCallback(
    (value: boolean) => updateNodeData(activeNodeId!, { autoGenerateLyrics: value }),
    [activeNodeId, updateNodeData],
  );

  const onStyleChange = useCallback(
    (styleId: string) => updateNodeData(activeNodeId!, { style: styleId }),
    [activeNodeId, updateNodeData]
  );

  const onAnimationActionChange = useCallback(
    (action: AnimationAction) => updateNodeData(activeNodeId!, { animationAction: action }),
    [activeNodeId, updateNodeData]
  );

  const onAnimationFramesChange = useCallback(
    (value: number) => updateNodeData(activeNodeId!, { animationFrames: value as BaseNodeData['animationFrames'] }),
    [activeNodeId, updateNodeData]
  );

  // Early return must come after ALL hooks
  if (!activeNodeId || !node || !data || !nodeType) return null;

  const recoverableComfyTask = currentProjectId && data.status !== 'loading'
    ? getPendingTasksForProject(currentProjectId).find((task) => task.nodeId === activeNodeId && task.taskType === 'comfyui' && task.comfyRecoveryState)
    : undefined;
  const cloudTask = currentProjectId ? getPendingTasksForProject(currentProjectId).find((task) => task.nodeId === activeNodeId && ['runninghub-workflow', 'runninghub-model'].includes(task.taskType)) : undefined;
  const workflowApiTask = currentProjectId ? getPendingTasksForProject(currentProjectId).find((task) => task.nodeId === activeNodeId && task.taskType === 'workflow-api') : undefined;
  const cloudOutputs = data.workflowApiOutputs ?? data.runninghubOutputs;

  const audioPurpose = data.audioPurpose
    ?? (data.model ? findMediaModelOption(data.model)?.audioPurpose : undefined);

  // 节点已有图片/视频/音频等产物时浮层下移，避免遮住画面；空节点保持原 -20px 覆盖
  const nodeHasMedia = !!(
    data.imageUrl || data.thumbnailUrl ||
    data.videoUrl || data.audioUrl
  );
  const dialogOffsetY = nodeHasMedia ? 12 : -20;

  const handleInsertMention = (mentionStr: string) => {
    // 优先在编辑器的「当前光标位置」插入引用芯片（点击 float 时编辑器焦点仍在）
    const m = mentionStr.match(/^@\{([^:]+):([^}]+)\}$/);
    if (m && editorApiRef.current) {
      editorApiRef.current.insertMentionAtCursor(m[1], m[2]);
      return;
    }
    // 兜底：编辑器未就绪或非节点引用 → 追加到末尾（读 store 实时 prompt，避免覆盖刚输入内容）
    const liveData = useAppStore.getState().nodes.find((n) => n.id === activeNodeId)?.data;
    const currentPrompt = ((liveData?.prompt ?? data.prompt) as string) || '';
    const newPrompt = currentPrompt ? `${currentPrompt} ${mentionStr}` : mentionStr;
    updateContinuousNodeData({ prompt: newPrompt });
  };

  return (
    <>
      {/* Connected nodes preview — below dialog (model-dropdown covers it) */}
      {!isExpanded && (
        <div
          ref={previewRef}
          className="ai-dialog-preview-float"
          style={dialogPosition ? {
            left: `${dialogPosition.x}px`,
            top: `${dialogPosition.y + dialogOffsetY - 42}px`,
            transform: 'translateX(-50%)',
          } : undefined}
        >
          <ConnectedNodesPreview nodeId={activeNodeId} onInsertMention={handleInsertMention} />
        </div>
      )}

      {isExpanded && (
        <button
          type="button"
          className="ai-dialog-expanded-backdrop"
          aria-label={t('还原')}
          onClick={() => setIsExpanded(false)}
        />
      )}

      <div
        ref={panelRef}
        className={`ai-dialog-float${isExpanded ? ' is-expanded' : ''}`}
        role={isExpanded ? 'dialog' : undefined}
        aria-modal={isExpanded ? true : undefined}
        aria-label={isExpanded ? t('节点生成对话框') : undefined}
        style={isExpanded ? undefined : {
          left: dialogPosition ? `${dialogPosition.x}px` : '50%',
          top: dialogPosition ? `${dialogPosition.y + dialogOffsetY}px` : '50%',
          transform: dialogPosition ? 'translateX(-50%)' : 'translate(-50%, -50%)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {data.status === 'loading' && !performanceMode && (
          <Suspense fallback={null}>
            <BorderBeam
              className="ai-dialog-beam"
              borderRadius={14}
              colorVariant="colorful"
              /* 长宽比大，角度匀速旋转在角落会加速；放慢一圈的时间让观感平顺些 */
              duration={5}
              strength={0.85}
              theme={typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'}
            >
              {null}
            </BorderBeam>
          </Suspense>
        )}
        {isExpanded && (
          <div className="ai-dialog-preview-float is-expanded">
            <ConnectedNodesPreview
              nodeId={activeNodeId}
              onInsertMention={handleInsertMention}
              hoverEmphasis="expanded"
            />
          </div>
        )}
        <button
          type="button"
          className="ai-dialog-expand-btn"
          aria-label={isExpanded ? t('还原') : t('最大化')}
          aria-pressed={isExpanded}
          data-tooltip={isExpanded ? t('还原') : t('最大化')}
          onClick={(event) => {
            event.stopPropagation();
            setIsExpanded((current) => !current);
          }}
        >
          {isExpanded ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M9 4v5H4M15 20v-5h5M4 9l5-5M20 15l-5 5" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 9V4h5M20 15v5h-5M9 4 4 9M15 20l5-5" />
            </svg>
          )}
        </button>
        {['runninghubwf', 'runninghub'].includes(data.provider ?? '') && data.runninghubStage && <p role="status" className="px-3 py-1 text-xs text-canvas-text-secondary">RunningHub · {data.runninghubStage}</p>}
        {data.provider === 'workflow-api' && data.workflowApiStage && <p role="status" className="px-3 py-1 text-xs text-canvas-text-secondary">AutoDL · {data.workflowApiStage}</p>}
        {workflowApiTask && data.status !== 'loading' && <WorkflowApiTaskStatus key={`${activeNodeId}:${workflowApiTask.workflowApi?.attemptId}`} task={workflowApiTask} />}
        {cloudTask && data.status !== 'loading' && <div className="ui-card m-2 flex flex-col gap-2 p-3 text-xs">
          <p>{cloudTask.taskId ? `任务 ${(cloudTask.taskIds?.length ? cloudTask.taskIds : [cloudTask.taskId]).join('、')} 已保留，可以继续查询。${cloudTask.runninghubSubmissionUncertain ? '另有提交状态未知，请到平台核对后再清除恢复记录。' : ''}` : '提交状态未知。请到 RunningHub 平台核对，补充任务 ID 后继续查询。'}</p>
          {!cloudTask.taskId && <input aria-label="RunningHub 任务 ID" className="ui-input w-full" value={recoveryInput.nodeId === activeNodeId ? recoveryInput.taskId : ''} inputMode="numeric" onChange={(event) => setRecoveryInput({ nodeId: activeNodeId, taskId: event.target.value, confirmed: false })} />}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-btn ui-btn--sm" onClick={() => {
              if (!cloudTask.taskId) {
                if (recoveryInput.nodeId !== activeNodeId || !/^\d{1,30}$/.test(recoveryInput.taskId.trim())) { showToast('请填写正确的任务 ID', 'error'); return; }
                updatePendingTask(activeNodeId, { taskId: recoveryInput.taskId.trim(), taskIds: [recoveryInput.taskId.trim()], submitted: true, runninghubRecoveryState: 'disconnected', runninghubSubmissionUncertain: false }, '');
              }
              void resumeRunningHubNodeTask(activeNodeId).catch((error: unknown) => showToast(error instanceof Error ? error.message : '恢复查询失败', 'error'));
            }}>继续查询 / 保存</button>
            {cloudTask.taskId && <button type="button" className="ui-btn ui-btn--sm ui-btn--danger" onClick={() => { void onCancelGeneration(); }}>请求远端取消</button>}
          </div>
          <details><summary className="cursor-pointer text-canvas-text-secondary">在平台确认任务结束后解除限制</summary>
            <label className="my-2 flex gap-2"><input type="checkbox" checked={recoveryInput.nodeId === activeNodeId && recoveryInput.confirmed} onChange={(event) => setRecoveryInput({ nodeId: activeNodeId, taskId: '', confirmed: event.target.checked })} />我已在平台确认任务未提交或已经结束</label>
            <button type="button" className="ui-btn ui-btn--sm" disabled={recoveryInput.nodeId !== activeNodeId || !recoveryInput.confirmed} onClick={() => { removePendingTask(activeNodeId, cloudTask.taskId); updateNodeDataTransient(activeNodeId, { status: 'idle', error: undefined, runninghubStage: undefined }); setRecoveryInput({ nodeId: '', taskId: '', confirmed: false }); }}>清除本地恢复记录</button>
          </details>
        </div>}
        {cloudOutputs && cloudOutputs.length > 1 && <details className="ui-card m-2 p-2 text-xs"><summary className="cursor-pointer">全部产物 · {cloudOutputs.length}</summary><div className="mt-2 flex max-h-72 flex-col gap-2 overflow-y-auto">{cloudOutputs.map((output, index) => <div key={`${output.url}:${index}`}>
          <p className="mb-1 text-canvas-text-secondary">产物 {index + 1}{output.nodeId ? ` · 节点 ${output.nodeId}` : ''}</p>
          {output.kind === 'image' ? <img className="max-h-48 max-w-full object-contain" src={output.url} alt={`产物 ${index + 1}`} /> : output.kind === 'video' ? <video className="max-h-48 w-full" src={output.url} controls preload="metadata" /> : <audio className="w-full" src={output.url} controls preload="metadata" />}
        </div>)}</div></details>}
        {recoverableComfyTask && (
          <div className="ui-alert ui-alert--warning mx-3 mb-2 flex-wrap" role="status">
            <span className="min-w-0 flex-1 text-xs">
              {recoverableComfyTask.comfyRecoveryState === 'cancel_pending'
                ? t('ComfyUI 取消尚未确认，任务已保留')
                : t('ComfyUI 查询中断，任务已保留')}
            </span>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="ui-btn ui-btn--sm" onClick={() => {
                void resumeComfyUINodeTask(activeNodeId).catch(() => showToast(t('继续查询失败，任务仍保留'), 'error'));
              }}>{t('继续查询')}</button>
              <button type="button" className="ui-btn ui-btn--sm ui-btn--danger" onClick={() => { void onCancelGeneration(); }}>{t('再次终止')}</button>
            </div>
          </div>
        )}
        <PromptPanel
          editorRef={editorApiRef}
          nodeType={nodeType}
          nodeId={activeNodeId}
          prompt={data.prompt || ''}
          placeholder={t('按 @ 引用素材；连线素材需 @ 后才会传给模型，仅连线不生效；\n描述想要生成的内容；\n/ 呼出指令；\n(Enter 生成，Shift+Enter 换行)')}
          selectedModel={data.model}
          selectedProvider={data.provider}
          selectedWorkflowId={data.workflowId}
          animationAction={data.animationAction ?? 'idle'}
          onAnimationActionChange={onAnimationActionChange}
          animationFrames={data.animationFrames ?? 8}
          onAnimationFramesChange={onAnimationFramesChange}
          canGenerate={data.status !== 'loading' && !recoverableComfyTask && !cloudTask && !workflowApiTask}
          isGenerating={data.status === 'loading'}
          onCancelGeneration={['comfyui', 'runninghubwf', 'runninghub', 'workflow-api'].includes(data.provider ?? '') ? () => { void onCancelGeneration(); } : undefined}
          onChange={onPromptChange}
          onContinuousEditEnd={finishContinuousEdit}
          onSubmit={onSubmit}
          onModelSelect={onModelSelect}
          onWorkflowSelect={onWorkflowSelect}
          runninghubModelParameters={data.runninghubModelParameters}
          onRunninghubModelParametersChange={(runninghubModelParameters) => updateNodeData(activeNodeId, { runninghubModelParameters })}
          workflowInputs={data.workflowInputs}
          onWorkflowInputsChange={(workflowInputs) => updateNodeData(activeNodeId, { workflowInputs })}
          onPassThrough={supportsPassThrough ? onPassThrough : undefined}
          imageSize={(data.imageSize as string) || '2K'}
          aspectRatio={(data.aspectRatio as string) || (nodeType === 'ai-panorama' ? '2:1' : '1:1')}
          onChangeImageSize={onChangeImageSize}
          onChangeAspectRatio={onChangeAspectRatio}
          batchCount={(data.batchCount as number) || 1}
          onChangeBatchCount={onChangeBatchCount}
          cameraSettings={data.cameraSettings}
          onChangeCameraSettings={onChangeCameraSettings}
          videoResolution={data.videoResolution as number | undefined}
          videoFps={data.videoFps as number | undefined}
          videoFrames={data.videoFrames as number | undefined}
          onChangeVideoResolution={onChangeVideoResolution}
          onChangeVideoFps={onChangeVideoFps}
          seedanceResolution={data.seedanceResolution as string | undefined}
          seedanceRatio={data.seedanceRatio as string | undefined}
          seedanceDuration={data.seedanceDuration as number | undefined}
          generateAudio={data.generateAudio as boolean | undefined}
          videoReferences={data.videoReferences}
          onChangeVideoReferences={onChangeVideoReferences}
          onChangeSeedanceResolution={onChangeSeedanceResolution}
          onChangeSeedanceRatio={onChangeSeedanceRatio}
          onChangeSeedanceDuration={onChangeSeedanceDuration}
          onChangeGenerateAudio={onChangeGenerateAudio}
          audioPurpose={audioPurpose}
          audioVoice={data.audioVoice ?? 'alloy'}
          audioFormat={data.audioFormat ?? 'wav'}
          audioSpeed={data.audioSpeed ?? 1}
          musicTitle={data.musicTitle ?? ''}
          musicLyrics={data.musicLyrics ?? ''}
          musicBpm={data.musicBpm}
          musicDuration={data.musicDuration ?? 60}
          autoGenerateLyrics={data.autoGenerateLyrics ?? false}
          onChangeAudioVoice={onChangeAudioVoice}
          onChangeAudioFormat={onChangeAudioFormat}
          onChangeAudioSpeed={onChangeAudioSpeed}
          onChangeMusicTitle={onChangeMusicTitle}
          onChangeMusicLyrics={onChangeMusicLyrics}
          onChangeMusicBpm={onChangeMusicBpm}
          onChangeMusicDuration={onChangeMusicDuration}
          onChangeAutoGenerateLyrics={onChangeAutoGenerateLyrics}
          workflows={workflows}
          selectedStyle={data.style as string | undefined}
          onStyleChange={onStyleChange}
        />
      </div>
    </>
  );
}

export default memo(AINodeDialog);

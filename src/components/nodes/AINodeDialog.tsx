/**
 * AINodeDialog AI 生成弹窗 — 点击节点后弹出的浮动面板，包含 Prompt 输入、模型选择、参数配置、生成按钮
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
import { generateId, useAppStore } from '../../store/useAppStore';
import type { AnimationAction, BaseNodeData, ImagePostProcess, ModelOption } from '../../types';
import { ANIMATION_FRAME_GRIDS } from '../../types';
import { MAX_IMAGE_BATCH_COUNT, type AudioOutputFormat, type AudioTtsVoice } from '../../types/aiTypes';
import { generateText, generateImage, generateImagesBatch, generateVideo, generateAudio, buildPanoramaPrompt } from '../../services/aiService';
import { persistAudioGenerationResult } from '../../services/ai/generateAudio';
import { downloadUrlAndSave } from '../../services/fileService';
import { applyImageBatchResults } from '../../services/imageBatchService';
import { checkModelExists, createCharacterDirectionGrid, downloadModel } from '../../services/onnxService';
import ModelDownloadDialog from '../shared/ModelDownloadDialog';
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

const DIALOG_VIEWPORT_MARGIN = 16;

function AINodeDialog() {
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
  const data: BaseNodeData | undefined = node?.data;
  const nodeType = data?.type;

  const panelRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const preview = previewRef.current;
    if (!panel || !activeNodeId) return;

    let scheduledFrame = 0;
    let settleTimer = 0;
    let releaseTransitionFrame = 0;
    let adjustmentLocked = false;
    let disposed = false;
    let trackedNodeElement: HTMLElement | null = null;

    const positionDialog = (anchor: { x: number; y: number }) => {
      panel.style.left = `${anchor.x}px`;
      panel.style.top = `${anchor.y - 20}px`;
      if (preview) {
        preview.style.left = `${anchor.x}px`;
        preview.style.top = `${anchor.y - 10 - 42}px`;
      }
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
      positionDialog(anchor);
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

      requestCanvasPanBy({
        deltaX,
        deltaY,
        duration,
        onProgress: (progress) => {
          if (disposed) return;
          positionDialog({
            x: startAnchor.x + progress.deltaX,
            y: startAnchor.y + progress.deltaY,
          });
        },
        onComplete: (progress) => {
          if (disposed) return;
          const finalAnchor = {
            x: startAnchor.x + progress.deltaX,
            y: startAnchor.y + progress.deltaY,
          };
          positionDialog(finalAnchor);
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
  }, [activeNodeId]);

  // 节点尺寸变化时，重新计算浮动面板位置，使其跟随节点平滑移动
  useEffect(() => {
    if (!activeNodeId) return;
    const el = document.querySelector(`.react-flow__node[data-id="${activeNodeId}"]`);
    if (!el) return;

    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      useAppStore.getState().openNodeDialog(activeNodeId, { x: rect.left + rect.width / 2, y: rect.bottom });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeNodeId]);
  const editorApiRef = useRef<MentionEditorHandle>(null);

  // ── 主体识别模型下载弹窗（8 向宫格后处理预检） ──
  const [mattingModelPrompt, setMattingModelPrompt] = useState(false);
  const [mattingModelDownloading, setMattingModelDownloading] = useState(false);
  // 挂起 8 向宫格后处理所需的上下文，等待模型下载完成后继续
  const pendingDirectionGridRef = useRef<{
    submittingNodeId: string;
    savedFilePath: string;
    nodeLabel: string;
  } | null>(null);

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
        handleCloseNodeDialog();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [handleCloseNodeDialog]);

  // All hooks must be called before any early return
  const onPromptChange = useCallback(
    (value: string) => {
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
    [updateContinuousNodeData]
  );

  // ── 8 向宫格后处理（模型下载完成后继续执行） ──
  const executeDirectionGridPostProcess = useCallback(async () => {
    const pending = pendingDirectionGridRef.current;
    pendingDirectionGridRef.current = null;
    if (!pending) return;

    const { submittingNodeId, savedFilePath, nodeLabel } = pending;
    const mattingModelName = 'rmbg-1.4.onnx';
    const isStillCurrent = () => {
      const state = useAppStore.getState();
      return state.nodes.some((n) => n.id === submittingNodeId);
    };

    try {
      if (!(await checkModelExists(mattingModelName))) {
        showToast('首次使用正在下载主体识别模型（约 176MB）');
        await downloadModel(mattingModelName);
      }
      if (!isStillCurrent()) return;

      const gridResult = await createCharacterDirectionGrid(
        savedFilePath, mattingModelName, `direction-grid-${submittingNodeId}-${Date.now()}`,
      );
      if (!isStillCurrent()) return;

      const store = useAppStore.getState();
      const sourceNode = store.nodes.find((item) => item.id === submittingNodeId);
      if (!sourceNode) return;
      const sourceWidth = (sourceNode.data.nodeWidth as number) || 280;
      store.addNode({
        id: `node-${generateId()}`,
        type: 'ai-storyboard',
        position: { x: sourceNode.position.x + sourceWidth + 60, y: sourceNode.position.y },
        data: {
          label: `${nodeLabel} 8向宫格`, type: 'ai-storyboard', role: 'source', status: 'success',
          imageUrl: convertFileSrc(gridResult.grid_path), filePath: gridResult.grid_path,
          imageWidth: gridResult.grid_size, imageHeight: gridResult.grid_size,
          storyboardRows: 3, storyboardCols: 3, nodeWidth: 360, nodeHeight: 360,
        },
      });
      showToast('角色 8 向宫格已生成');
    } catch (e) {
      const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '未知错误';
      showToast(`原图已生成，8 向宫格处理失败：${msg}`, 'error');
    }
  }, [showToast]);

  const handleMattingModelConfirm = useCallback(async () => {
    setMattingModelPrompt(false);
    setMattingModelDownloading(true);
    try {
      await downloadModel('rmbg-1.4.onnx');
      useAppStore.getState().showToast('模型下载完成', 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '模型下载失败';
      useAppStore.getState().showToast(msg, 'error');
      setMattingModelDownloading(false);
      pendingDirectionGridRef.current = null;
      return;
    }
    setMattingModelDownloading(false);
    // 模型下载完成，继续执行 8 向宫格后处理
    await executeDirectionGridPostProcess();
  }, [executeDirectionGridPostProcess]);

  const handleMattingModelCancel = useCallback(() => {
    setMattingModelPrompt(false);
    setMattingModelDownloading(false);
    pendingDirectionGridRef.current = null;
    showToast('图片生成完成');
  }, [showToast]);

  // 调用选中模型生成（文本 or 图片）
  // overridePrompt: / 指令菜单直接触发时传入的整合后模板，不走 store → 对话框不闪烁
  const onSubmit = useCallback(async (overridePrompt?: string, postProcess?: ImagePostProcess) => {
    finishContinuousEdit();
    // 实时从 store 读取全部数据 — 避免闭包 data 为 undefined
    const store = useAppStore.getState();
    const latestNode = store.nodes.find((n) => n.id === activeNodeId);
    const latestData = latestNode?.data as BaseNodeData | undefined;
    if (!latestData) {
      showToast('节点不存在', 'error');
      return;
    }
    const rawPrompt = overridePrompt ?? (latestData.prompt as string) ?? '';
    if (!rawPrompt.trim()) {
      showToast('请输入提示词', 'error');
      return;
    }
    const projectSettings = store.projects.find(
      (project) => project.id === currentProjectId,
    )?.settings;
    const effectivePrompt = resolveProjectGenerationPrompt({
      prompt: rawPrompt,
      data: latestData,
      settings: projectSettings,
      customStyles: store.customStyles,
    });
    const nodeModel = latestData?.model;
    const nodeProvider = latestData?.provider;
    const nodeLabel = latestData?.label ?? '';
    if (!nodeModel || !nodeProvider) {
      showToast('请先在底部模型选择器中选择一个模型', 'error');
      return;
    }
    const submittingNodeId = activeNodeId!;
    const submittingProjectId = currentProjectId;
    const isStillCurrentSubmission = () => {
      const state = useAppStore.getState();
      return (
        state.currentProjectId === submittingProjectId
        && state.nodes.some((n) => n.id === submittingNodeId)
      );
    };
    updateNodeDataTransient(activeNodeId!, { status: 'loading', error: undefined });
    try {
      const batchCount = Math.min(MAX_IMAGE_BATCH_COUNT, Math.max(1, Math.floor(Number(latestData.batchCount) || 1)));
      if (nodeType === 'ai-image' && batchCount > 1) {
        if (postProcess) throw new Error('批量生成暂不支持图片后处理，请将数量设为 1');
        const imageSize = (latestData.imageSize as string) || '2K';
        const aspectRatio = (latestData.aspectRatio as string) || '1:1';
        showToast(`正在批量生成 ${batchCount} 张图片`);
        const batch = await generateImagesBatch({
          prompt: effectivePrompt,
          model: nodeModel,
          provider: nodeProvider,
          imageSize,
          aspectRatio,
          workflowId: latestData.workflowId,
          workflowInputs: latestData.workflowInputs,
          nodeId: activeNodeId ?? undefined,
        }, batchCount);
        if (!isStillCurrentSubmission()) return;
        await applyImageBatchResults({
          nodeId: submittingNodeId,
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
          workflowInputs: latestData.workflowInputs,
          nodeId: activeNodeId ?? undefined,
        });
        if (!isStillCurrentSubmission()) return;
        // 下载远程 URL 到本地项目目录
        const saved = currentProjectId
          ? await downloadUrlAndSave(result.url, currentProjectId, 'ai-image', nodeLabel).catch(() => null)
          : null;
        const mediaUrl = saved?.assetUrl || result.url;
        updateNodeData(activeNodeId!, {
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
        useAppStore.getState().syncDramaAssetImageFromNode?.(activeNodeId!, mediaUrl);
        recordOutputHistory(activeNodeId!, {
          nodeId: activeNodeId!,
          nodeLabel: nodeLabel,
          timestamp: Date.now(),
          prompt: effectivePrompt,
          output: result.url,
          nodeType: isAnimation ? 'ai-animation' : 'ai-image',
          model: nodeModel,
          provider: nodeProvider,
          status: 'success',
          mediaUrl: result.url,
          filePath: saved?.filePath,
          params: isAnimation
            ? { imageSize, aspectRatio, animationAction, animationFrames, grid: ANIMATION_FRAME_GRIDS[animationFrames] }
            : { imageSize, aspectRatio },
        });
        if (postProcess === 'character-8-direction-grid') {
          if (!saved?.filePath) {
            showToast('原图已生成，但未能保存到本地，无法自动生成 8 向宫格', 'error');
          } else {
            // 预检主体识别 ONNX 模型是否已安装
            const mattingModelName = 'rmbg-1.4.onnx';
            const modelExists = await checkModelExists(mattingModelName);
            if (!modelExists) {
              pendingDirectionGridRef.current = {
                submittingNodeId: submittingNodeId,
                savedFilePath: saved.filePath,
                nodeLabel,
              };
              setMattingModelPrompt(true);
              return;
            }
            showToast('图片生成完成，正在后台识别主体并生成 8 向宫格');
            try {
              if (!isStillCurrentSubmission()) return;

              const gridResult = await createCharacterDirectionGrid(
                saved.filePath,
                mattingModelName,
                `direction-grid-${submittingNodeId}-${Date.now()}`,
              );
              if (!isStillCurrentSubmission()) return;

              const store2 = useAppStore.getState();
              const sourceNode = store2.nodes.find((item) => item.id === submittingNodeId);
              if (!sourceNode) return;
              const sourceWidth = (sourceNode.data.nodeWidth as number) || 280;
              store2.addNode({
                id: `node-${generateId()}`,
                type: 'ai-storyboard',
                position: {
                  x: sourceNode.position.x + sourceWidth + 60,
                  y: sourceNode.position.y,
                },
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
              showToast('角色 8 向宫格已生成');
            } catch (postProcessError) {
              const message = postProcessError instanceof Error
                ? postProcessError.message
                : typeof postProcessError === 'string'
                  ? postProcessError
                  : '未知错误';
              showToast(`原图已生成，8 向宫格处理失败：${message}`, 'error');
            }
          }
        } else {
          showToast(isAnimation ? 'Sprite Sheet 生成完成' : '图片生成完成');
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
          workflowInputs: latestData.workflowInputs,
          nodeId: activeNodeId ?? undefined,
        });
        if (!isStillCurrentSubmission()) return;
        const saved = currentProjectId
          ? await downloadUrlAndSave(result.url, currentProjectId, 'ai-panorama', nodeLabel).catch(() => null)
          : null;
        const mediaUrl = saved?.assetUrl || result.url;
        updateNodeData(activeNodeId!, {
          imageUrl: mediaUrl,
          sourceUrl: result.url,
          filePath: saved?.filePath,
          thumbnailUrl: result.url,
          output: result.url,
          status: 'success',
          imageWidth: result.width,
          imageHeight: result.height,
        });
        recordOutputHistory(activeNodeId!, {
          nodeId: activeNodeId!,
          nodeLabel: nodeLabel,
          timestamp: Date.now(),
          prompt: effectivePrompt,
          output: result.url,
          nodeType: 'ai-panorama',
          model: nodeModel,
          provider: nodeProvider,
          status: 'success',
          mediaUrl: result.url,
          filePath: saved?.filePath,
          params: { imageSize, aspectRatio },
        });
        showToast('全景图生成完成');
      } else if (nodeType === 'ai-video') {
        const videoResolution = (latestData.videoResolution as number) || 832;
        const videoFps = (latestData.videoFps as number) || 24;
        const videoFrames = (latestData.videoFrames as number) || 77;
        const seedanceResolution = (latestData.seedanceResolution as string) || '720p';
        const seedanceRatio = (latestData.seedanceRatio as string) || '16:9';
        const seedanceDuration = (latestData.seedanceDuration as number) || 5;
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
          workflowInputs: latestData.workflowInputs,
          nodeId: activeNodeId ?? undefined,
        });
        if (!isStillCurrentSubmission()) return;
        // 下载远程 URL 到本地项目目录
        const saved = currentProjectId
          ? await downloadUrlAndSave(result.url, currentProjectId, 'ai-video', nodeLabel).catch(() => null)
          : null;
        const mediaUrl = saved?.assetUrl || result.url;
        updateNodeData(activeNodeId!, {
          videoUrl: mediaUrl,
          sourceUrl: result.url,
          filePath: saved?.filePath,
          thumbnailUrl: result.url,
          output: result.url,
          status: 'success',
        });
        recordOutputHistory(activeNodeId!, {
          nodeId: activeNodeId!,
          nodeLabel: nodeLabel,
          timestamp: Date.now(),
          prompt: effectivePrompt,
          output: result.url,
          nodeType: 'ai-video',
          model: nodeModel,
          provider: nodeProvider,
          status: 'success',
          mediaUrl: result.url,
          filePath: saved?.filePath,
          params: { videoResolution, videoFps, videoFrames, seedanceResolution, seedanceRatio, seedanceDuration, generateAudio },
        });
        showToast('视频生成完成');
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
          workflowInputs: latestData.workflowInputs,
          nodeId: activeNodeId ?? undefined,
        });
        if (!isStillCurrentSubmission()) {
          if (result.url.startsWith('blob:')) URL.revokeObjectURL(result.url);
          return;
        }
        const persisted = await persistAudioGenerationResult(result, currentProjectId, nodeLabel);
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
        showToast('音频生成完成');
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
            processed.kind === 'character' ? '人物' : processed.kind === 'scene' ? '场景' : '道具';
          if (processed.ok) {
            showToast(`${kindLabel}简介已提取并入库 · 「资产管理 > 短剧资产」可查看`);
          } else {
            showToast('已提取，但 JSON 未完全规范化，请检查输出', 'error');
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : (typeof err === 'string' && err.trim() ? err : '生成失败');
      if (msg === '任务已被取消') {
        return;
      }
      if (!isStillCurrentSubmission()) return;
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
    }
  }, [activeNodeId, nodeType, currentProjectId, finishContinuousEdit, updateNodeData, updateNodeDataTransient, recordOutputHistory, showToast]);

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
        ...(model.provider === 'dreamina' ? { batchCount: 1 } : {}),
      });
    },
    [activeNodeId, updateNodeData]
  );

  const onWorkflowSelect = useCallback(
    (workflowId: string | undefined) => {
      updateNodeData(activeNodeId!, {
        workflowId,
        ...(workflowId ? { provider: 'comfyui', model: 'comfyui/workflow', batchCount: 1, audioPurpose: undefined } : {}),
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

  const onChangeVideoResolution = useCallback(
    (value: number) => updateNodeData(activeNodeId!, { videoResolution: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeVideoFps = useCallback(
    (value: number) => updateNodeData(activeNodeId!, { videoFps: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeVideoFrames = useCallback(
    (value: number) => updateNodeData(activeNodeId!, { videoFrames: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeSeedanceResolution = useCallback(
    (value: string) => updateNodeData(activeNodeId!, { seedanceResolution: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeSeedanceRatio = useCallback(
    (value: string) => updateNodeData(activeNodeId!, { seedanceRatio: value }),
    [activeNodeId, updateNodeData]
  );

  const onChangeSeedanceDuration = useCallback(
    (value: number) => updateContinuousNodeData({ seedanceDuration: value }),
    [updateContinuousNodeData]
  );

  const onChangeGenerateAudio = useCallback(
    (value: boolean) => updateNodeData(activeNodeId!, { generateAudio: value }),
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

  const audioPurpose = data.audioPurpose
    ?? (data.model ? findMediaModelOption(data.model)?.audioPurpose : undefined);

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
      <div
        ref={previewRef}
        className="ai-dialog-preview-float"
        style={dialogPosition ? {
          left: `${dialogPosition.x}px`,
          top: `${dialogPosition.y - 10 - 42}px`,
          transform: 'translateX(-50%)',
        } : undefined}
      >
        <ConnectedNodesPreview nodeId={activeNodeId} onInsertMention={handleInsertMention} />
      </div>

      <div
        ref={panelRef}
        className="ai-dialog-float"
        style={{
          left: dialogPosition ? `${dialogPosition.x}px` : '50%',
          top: dialogPosition ? `${dialogPosition.y - 20}px` : '50%',
          transform: dialogPosition ? 'translateX(-50%)' : 'translate(-50%, -50%)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <PromptPanel
          editorRef={editorApiRef}
          nodeType={nodeType}
          nodeId={activeNodeId}
          prompt={data.prompt || ''}
          placeholder={`描述任何你想要生成的内容，按 @ 引用素材，/呼出指令\n(Enter 生成，Shift+Enter 换行)`}
          selectedModel={data.model}
          selectedProvider={data.provider}
          selectedWorkflowId={data.workflowId}
          animationAction={data.animationAction ?? 'idle'}
          onAnimationActionChange={onAnimationActionChange}
          animationFrames={data.animationFrames ?? 8}
          onAnimationFramesChange={onAnimationFramesChange}
          canGenerate={data.status !== 'loading'}
          onChange={onPromptChange}
          onContinuousEditEnd={finishContinuousEdit}
          onSubmit={onSubmit}
          onModelSelect={onModelSelect}
          onWorkflowSelect={onWorkflowSelect}
          onPassThrough={(nodeType !== 'ai-image' && nodeType !== 'ai-animation' && nodeType !== 'ai-video' && nodeType !== 'ai-audio') ? onPassThrough : undefined}
          imageSize={(data.imageSize as string) || '2K'}
          aspectRatio={(data.aspectRatio as string) || (nodeType === 'ai-panorama' ? '2:1' : '1:1')}
          onChangeImageSize={onChangeImageSize}
          onChangeAspectRatio={onChangeAspectRatio}
          batchCount={(data.batchCount as number) || 1}
          onChangeBatchCount={onChangeBatchCount}
          videoResolution={(data.videoResolution as number) || 832}
          videoFps={(data.videoFps as number) || 24}
          videoFrames={(data.videoFrames as number) || 77}
          onChangeVideoResolution={onChangeVideoResolution}
          onChangeVideoFps={onChangeVideoFps}
          onChangeVideoFrames={onChangeVideoFrames}
          seedanceResolution={(data.seedanceResolution as string) || '720p'}
          seedanceRatio={(data.seedanceRatio as string) || '16:9'}
          seedanceDuration={(data.seedanceDuration as number) || 5}
          generateAudio={data.generateAudio as boolean | undefined}
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

      {/* 主体识别模型下载弹窗（8 向宫格后处理预检） */}
      {mattingModelPrompt && (
        <ModelDownloadDialog
          type="matting"
          showPrompt={mattingModelPrompt}
          showDownloading={mattingModelDownloading}
          onConfirm={handleMattingModelConfirm}
          onCancel={handleMattingModelCancel}
        />
      )}
    </>
  );
}

export default memo(AINodeDialog);

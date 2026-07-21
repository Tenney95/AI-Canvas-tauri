/**
 * AINodeDialog AI 生成弹窗 — 点击节点后弹出的浮动面板，包含 Prompt 输入、模型选择、参数配置、生成按钮
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
import { generateId, useAppStore } from '../../store/useAppStore';
import type { AnimationAction, BaseNodeData, ImagePostProcess, ModelOption } from '../../types';
import { ANIMATION_ACTION_LABELS, ANIMATION_FRAME_GRIDS } from '../../types';
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

type AnimationFrameCount = 6 | 8 | 10 | 12 | 16 | 20;

const ANIMATION_ACTION_PROMPTS: Record<AnimationAction, string> = {
  idle: '原地自然待机循环，只有轻微呼吸、重心起伏和附属物延迟摆动，双脚始终稳定着地',
  walk: '原地行走循环，左右腿交替完成触地、承重、经过和摆出；手臂与对侧腿反向摆动，脚掌沿连续弧线运动且不滑步',
  run: '原地奔跑循环，左右腿交替完成触地、压低、蹬地、腾空和回收；手臂与对侧腿反向摆动，必须出现清晰腾空相位',
  jump: '一次完整跳跃，依次为预备下蹲、蹬地、上升、最高点、下落、触地缓冲和恢复站姿',
  attack: '一次清晰攻击，依次为预备蓄力、加速出招、命中极点、惯性跟随和收势恢复，武器或拳脚轨迹连续',
  hit: '一次短促受击，依次为接触冲击、身体后仰、肢体惯性、最大位移和重心恢复，受力方向始终一致',
};

const EIGHT_FRAME_PHASE_GUIDES: Record<AnimationAction, string> = {
  idle: '第1帧中立；第2帧吸气微抬；第3帧继续上升；第4帧最高；第5帧回落；第6帧呼气微沉；第7帧最低；第8帧回到中立前一刻并自然衔接第1帧。',
  walk: '第1帧左脚前触地、右臂前摆；第2帧左腿承重且身体最低；第3帧右脚从身体下方经过；第4帧右脚向前摆、左脚蹬地；第5帧右脚前触地、左臂前摆；第6帧右腿承重且身体最低；第7帧左脚从身体下方经过；第8帧左脚向前摆、右脚蹬地并衔接第1帧。',
  run: '第1帧左脚触地、右臂前摆；第2帧左腿压低承重；第3帧左腿蹬地、右腿从身体下方经过；第4帧腾空回收并准备右脚落地；第5帧右脚触地、左臂前摆；第6帧右腿压低承重；第7帧右腿蹬地、左腿从身体下方经过；第8帧腾空回收并准备衔接第1帧。',
  jump: '第1帧站稳；第2帧预备下蹲；第3帧蹬地离地；第4帧快速上升；第5帧最高点收腿；第6帧下落伸腿；第7帧触地深蹲缓冲；第8帧起身恢复。',
  attack: '第1帧警戒；第2帧重心后移蓄力；第3帧开始加速；第4帧出招途中；第5帧命中极点；第6帧惯性跟随；第7帧收回；第8帧接近警戒姿势。',
  hit: '第1帧正常姿势；第2帧刚受冲击；第3帧快速后仰；第4帧肢体继续惯性摆动；第5帧最大后移；第6帧开始回稳；第7帧重心归位；第8帧接近正常姿势。',
};

const ANIMATION_SHEET_RATIOS: Record<AnimationFrameCount, string> = {
  6: '3:2',
  8: '2:1',
  10: '21:9',
  12: '4:3',
  16: '1:1',
  20: '5:4',
};

// 即梦只接受固定比例；选最接近宫格比例的宽幅尺寸，避免退回 1:1 后把 4×2 单元格拉成长条。
const DREAMINA_ANIMATION_SHEET_RATIOS: Partial<Record<AnimationFrameCount, string>> = {
  8: '16:9',
  20: '4:3',
};

const LOOPING_ACTIONS = new Set<AnimationAction>(['idle', 'walk', 'run']);
const DIALOG_VIEWPORT_MARGIN = 16;

function resolveAnimationSheetAspectRatio(frameCount: AnimationFrameCount, provider: string) {
  return provider === 'dreamina'
    ? DREAMINA_ANIMATION_SHEET_RATIOS[frameCount] ?? ANIMATION_SHEET_RATIOS[frameCount]
    : ANIMATION_SHEET_RATIOS[frameCount];
}

function buildAnimationSpritePrompt(
  characterPrompt: string,
  action: AnimationAction,
  frameCount: AnimationFrameCount,
  sheetAspectRatio: string,
) {
  const grid = ANIMATION_FRAME_GRIDS[frameCount];
  const playbackConstraint = LOOPING_ACTIONS.has(action)
    ? '这是循环动作：不要复制首帧作为末帧；末帧必须处在回到首帧之前的连续相位，播放时无停顿、跳变或脚底滑动。'
    : '这是一次性动作：每帧必须按时间推进，不得交换、倒序或重复关键姿势。';

  return [
    characterPrompt.trim(),
    `【任务】生成 ${ANIMATION_ACTION_LABELS[action]} 动画 Sprite Sheet。这是同一个角色的连续动画技术图，不是多个不同姿势的角色拼贴。`,
    `【动作机制】${ANIMATION_ACTION_PROMPTS[action]}。${playbackConstraint}`,
    frameCount === 8 ? `【8帧时间轴】${EIGHT_FRAME_PHASE_GUIDES[action]}` : `【时间轴】将完整动作均匀采样为 ${frameCount} 个连续且不重复的时间点。`,
    `【画布与宫格】整张图比例严格为 ${sheetAspectRatio}，共 ${frameCount} 帧，严格按从左到右、从上到下排列为 ${grid.cols} 列 × ${grid.rows} 行；铺满画布，所有单元格等宽等高，不留大面积外边距、行间距或列间距。`,
    '【尺寸锁定】每格中的角色使用完全相同的绘制比例、头身比和透视，躯干大小及四肢长度固定；角色主体约占单元格高度的 78%，脚底基线和身体中心轴保持在同一位置，仅允许动作需要的轻微上下起伏，不得逐帧放大、缩小、拉宽或压扁。',
    '【骨骼连续性】锁定左右手、左右脚及关节身份，肢体只能沿连续圆弧运动；左腿向前时右臂向前，右腿向前时左臂向前。手脚必须连接身体，不得换边、镜像、瞬移、折断、增生或消失；服装、背包、武器、尾巴等附属物必须跟随同一身体锚点连续运动。',
    '【一致性】每帧保持完全相同的角色造型、朝向、相机角度、轮廓、配色、线条、光照和背景；角色完整位于各自单元格安全区内，不得越界或被裁切。',
    '【禁止】不要文字、编号、边框、分隔线、额外角色、重复帧、镜像帧、视角变化、角色位移轨迹、运动残影或速度线。',
  ].join('\n');
}

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
    const effectivePrompt = overridePrompt ?? (() => {
      const latestNode = useAppStore.getState().nodes.find((n) => n.id === activeNodeId);
      const latestData: BaseNodeData | undefined = latestNode?.data;
      return (latestData?.prompt as string) || '';
    })();
    if (!effectivePrompt.trim()) {
      showToast('请输入提示词', 'error');
      return;
    }
    // 实时从 store 读取全部数据 — 避免闭包 data 为 undefined
    const latestNode = useAppStore.getState().nodes.find((n) => n.id === activeNodeId);
    const latestData = latestNode?.data as BaseNodeData | undefined;
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
        const generateAudio = (latestData.generateAudio as boolean) || false;
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

      if (value === '自适应') {
        updateData.nodeWidth = 280;
        updateData.nodeHeight = 280; // Adaptive default for image nodes
      } else {
        const parts = value.split(':');
        if (parts.length === 2) {
          const w = parseFloat(parts[0]);
          const h = parseFloat(parts[1]);
          if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) {
            const maxDimension = 280; // Bounding box base size
            if (w >= h) {
              updateData.nodeWidth = maxDimension;
              updateData.nodeHeight = Math.round(maxDimension * (h / w));
            } else {
              updateData.nodeHeight = maxDimension;
              updateData.nodeWidth = Math.round(maxDimension * (w / h));
            }
          }
        }
      }

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
      {/* Transparent overlay — captures clicks outside to close */}
      <div className="ai-dialog-backdrop" onMouseDown={handleCloseNodeDialog} />

      {/* Connected nodes preview — above backdrop, below dialog (model-dropdown covers it) */}
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
          generateAudio={(data.generateAudio as boolean) || false}
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

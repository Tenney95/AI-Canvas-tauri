/**
 * nodes/shared/image/useImageNodeOnnxActions — 图片节点的本地 ONNX 动作封装。
 * 把图片高清放大（Real-ESRGAN）与主体抠图（RMBG）这两个本地推理能力封装为 React hook，
 * 负责模型下载、进度回传与结果写入节点数据，推理在子进程隔离运行。
 */
import { useCallback, useState } from 'react';
import type { Node } from '@xyflow/react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { BaseNodeData } from '../../../../types';
import { generateId, useAppStore } from '../../../../store/useAppStore';
import {
  checkModelExists,
  downloadModel,
  imageUpscale,
  subjectMatting,
} from '../../../../services/onnxService';
import { computeImageNodeDimensions } from './imageUtils';
import { buildNodeFileName, resolveProjectOutputPath } from '../../../../services/fileService';

const UPSCALE_MODEL = 'realesrgan-x4.onnx';
const MATTING_MODEL = 'rmbg-1.4.onnx';

interface ImageNodeOnnxActionsOptions {
  id: string;
  data: BaseNodeData;
  nodeWidth: number;
  updateNodeDataTransient: (id: string, data: Partial<BaseNodeData>) => void;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as Record<string, unknown>).message);
  }
  return fallback;
}

export function useImageNodeOnnxActions({
  id,
  data,
  nodeWidth,
  updateNodeDataTransient,
}: ImageNodeOnnxActionsOptions) {
  const [isUpscaling, setIsUpscaling] = useState(false);
  const [upscaleProgress, setUpscaleProgress] = useState(0);
  const [downloadPrompt, setDownloadPrompt] = useState(false);
  const [isDownloadingModel, setIsDownloadingModel] = useState(false);
  const [isMattingRunning, setIsMattingRunning] = useState(false);
  const [mattingDownloadPrompt, setMattingDownloadPrompt] = useState(false);
  const [isDownloadingMattingModel, setIsDownloadingMattingModel] = useState(false);

  const createResultNode = useCallback(async (
    assetUrl: string,
    filePath: string,
    labelSuffix: string,
  ) => {
    const store = useAppStore.getState();
    const currentPosition = store.nodes.find((node) => node.id === id)?.position ?? { x: 0, y: 0 };
    const dimensions = await computeImageNodeDimensions(assetUrl);
    const node: Node<BaseNodeData> = {
      id: `node-${generateId()}`,
      type: 'ai-image',
      position: { x: currentPosition.x + nodeWidth + 40, y: currentPosition.y },
      data: {
        label: `${(data.label as string) || '图像'} ${labelSuffix}`,
        type: 'ai-image',
        role: 'source',
        imageUrl: assetUrl,
        filePath,
        status: 'success',
        imageWidth: dimensions.imageWidth,
        imageHeight: dimensions.imageHeight,
        nodeWidth: dimensions.nodeWidth,
        nodeHeight: dimensions.nodeHeight,
      } as BaseNodeData,
    };
    store.addNode(node);
    store.commitToHistory();
  }, [data.label, id, nodeWidth]);

  const doUpscale = useCallback(async (filePath: string) => {
    setIsUpscaling(true);
    setUpscaleProgress(0);
    updateNodeDataTransient(id, { status: 'loading', output: 'ONNX 超分处理中...' });

    const taskId = `upscale-${id}-${Date.now()}`;
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<{ taskId: string; percent: number }>(
      'image-upscale-progress',
      (event) => {
        if (event.payload.taskId === taskId) setUpscaleProgress(event.payload.percent);
      },
    );

    try {
      const extension = filePath.split('.').pop() || 'png';
      const projectId = useAppStore.getState().currentProjectId;
      if (!projectId || projectId === 'default') throw new Error('请先在已保存项目中使用高清超分');
      const outputPath = await resolveProjectOutputPath(
        projectId,
        buildNodeFileName(`${(data.label as string) || '图像'} 高清`, extension, 'upscaled'),
      );
      if (!outputPath) throw new Error('无法在项目目录中创建超分结果');
      const result = await imageUpscale(filePath, outputPath, UPSCALE_MODEL, taskId);
      await createResultNode(convertFileSrc(result.output_path), result.output_path, '高清');
      updateNodeDataTransient(id, { status: 'success' });
      useAppStore.getState().showToast(`超分完成 ${result.input_size} → ${result.output_size}`);
    } catch (error) {
      const message = getErrorMessage(error, 'ONNX 超分失败');
      updateNodeDataTransient(id, { status: 'error', error: message });
      useAppStore.getState().showToast(message, 'error');
    } finally {
      unlisten();
      setIsUpscaling(false);
      setUpscaleProgress(0);
    }
  }, [createResultNode, data.label, id, updateNodeDataTransient]);

  const handleUpscale = useCallback(async () => {
    const filePath = data.filePath as string | undefined;
    if (!filePath) {
      useAppStore.getState().showToast('该图片没有本地文件，无法超分', 'error');
      return;
    }
    if (!(await checkModelExists(UPSCALE_MODEL))) {
      setDownloadPrompt(true);
      return;
    }
    await doUpscale(filePath);
  }, [data.filePath, doUpscale]);

  const handleDownloadConfirm = useCallback(async () => {
    setDownloadPrompt(false);
    setIsDownloadingModel(true);
    try {
      await downloadModel(UPSCALE_MODEL);
      useAppStore.getState().showToast('模型下载完成，开始超分...', 'success');
    } catch (error) {
      useAppStore.getState().showToast(getErrorMessage(error, '模型下载失败'), 'error');
      setIsDownloadingModel(false);
      return;
    }
    setIsDownloadingModel(false);
    await doUpscale(data.filePath as string);
  }, [data.filePath, doUpscale]);

  const handleDownloadCancel = useCallback(() => {
    setDownloadPrompt(false);
    setIsDownloadingModel(false);
  }, []);

  const doSubjectMatting = useCallback(async (filePath: string) => {
    setIsMattingRunning(true);
    updateNodeDataTransient(id, { status: 'loading', output: 'AI 识别主体中...' });
    const taskId = `matting-${id}-${Date.now()}`;

    try {
      const projectId = useAppStore.getState().currentProjectId;
      if (!projectId || projectId === 'default') throw new Error('请先在已保存项目中使用主体识别');
      const outputPath = await resolveProjectOutputPath(
        projectId,
        buildNodeFileName(`${(data.label as string) || '图像'} 主体`, 'png', 'subject'),
      );
      if (!outputPath) throw new Error('无法在项目目录中创建主体识别结果');
      const result = await subjectMatting(filePath, outputPath, MATTING_MODEL, taskId);
      await createResultNode(convertFileSrc(result.subject_path), result.subject_path, '主体');
      updateNodeDataTransient(id, { status: 'success' });
      useAppStore.getState().showToast(`主体识别完成，已创建新节点 (${result.input_size})`);
    } catch (error) {
      const message = getErrorMessage(error, '主体识别失败');
      updateNodeDataTransient(id, { status: 'error', error: message });
      useAppStore.getState().showToast(message, 'error');
    } finally {
      setIsMattingRunning(false);
    }
  }, [createResultNode, data.label, id, updateNodeDataTransient]);

  const handleSubjectMatting = useCallback(async () => {
    const filePath = data.filePath as string | undefined;
    if (!filePath) {
      useAppStore.getState().showToast('该图片没有本地文件，无法识别主体', 'error');
      return;
    }
    if (!(await checkModelExists(MATTING_MODEL))) {
      setMattingDownloadPrompt(true);
      return;
    }
    await doSubjectMatting(filePath);
  }, [data.filePath, doSubjectMatting]);

  const handleMattingDownloadConfirm = useCallback(async () => {
    setMattingDownloadPrompt(false);
    setIsDownloadingMattingModel(true);
    try {
      await downloadModel(MATTING_MODEL);
      useAppStore.getState().showToast('模型下载完成，开始识别主体...', 'success');
    } catch (error) {
      useAppStore.getState().showToast(getErrorMessage(error, '模型下载失败'), 'error');
      setIsDownloadingMattingModel(false);
      return;
    }
    setIsDownloadingMattingModel(false);
    await doSubjectMatting(data.filePath as string);
  }, [data.filePath, doSubjectMatting]);

  const handleMattingDownloadCancel = useCallback(() => {
    setMattingDownloadPrompt(false);
    setIsDownloadingMattingModel(false);
  }, []);

  return {
    isUpscaling,
    upscaleProgress,
    downloadPrompt,
    isDownloadingModel,
    handleUpscale,
    handleDownloadConfirm,
    handleDownloadCancel,
    isMattingRunning,
    mattingDownloadPrompt,
    isDownloadingMattingModel,
    handleSubjectMatting,
    handleMattingDownloadConfirm,
    handleMattingDownloadCancel,
  };
}

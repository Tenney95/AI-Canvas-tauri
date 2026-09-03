/**
 * nodes/shared/audio/useAudioNodeAsr — 音频节点的本地语音转文本封装。
 *
 * 用本地 SenseVoice Small（ONNX）把音频识别成文字，不联网、不需要 API Key。
 * 模型与词表缺失时先弹下载确认，确认后下载再自动开始转写，与图片高清超分一致。
 */
import { useCallback, useState } from 'react';
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../../../../types';
import { generateId, useAppStore } from '../../../../store/useAppStore';
import {
  ASR_MODEL,
  ASR_VOCAB,
  checkModelExists,
  downloadModel,
  speechToText,
} from '../../../../services/onnxService';
import { textNodeHeight } from '../../../../utils/num';

/** 估算文本节点高度时按每行多少字折算 */
const CHARS_PER_LINE = 36;
const TRANSCRIPT_NODE_WIDTH = 280;
/** 与音频节点之间留出的水平间距 */
const TRANSCRIPT_NODE_GAP = 40;

type Translate = (text: string, vars?: Record<string, string | number>) => string;

interface AudioNodeAsrOptions {
  id: string;
  data: BaseNodeData;
  t: Translate;
  /** 把节点状态写回画布（不进历史） */
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

function estimateLines(transcript: string): number {
  return transcript.split(/\r?\n/).reduce(
    (count, line) => count + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)),
    0,
  );
}

export function useAudioNodeAsr({ id, data, t, updateNodeDataTransient }: AudioNodeAsrOptions) {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [downloadPrompt, setDownloadPrompt] = useState(false);
  const [isDownloadingModel, setIsDownloadingModel] = useState(false);

  /** 在音频节点右侧新建一个文本节点承载转写结果。 */
  const createTranscriptNode = useCallback(
    (transcript: string) => {
      const store = useAppStore.getState();
      const source = store.nodes.find((node) => node.id === id);
      if (!source) return;

      const sourceWidth = Number(source.data.nodeWidth) || TRANSCRIPT_NODE_WIDTH;
      const sourceLabel = source.data.label?.trim() || source.data.fileName?.trim() || t('音频');
      const nodeId = `node-${generateId()}`;
      const transcriptNode: Node<BaseNodeData> = {
        id: nodeId,
        type: 'ai-text',
        position: {
          x: source.position.x + sourceWidth + TRANSCRIPT_NODE_GAP,
          y: source.position.y,
        },
        data: {
          label: t('{name} 转写', { name: sourceLabel }),
          type: 'ai-text',
          role: 'source',
          output: transcript,
          status: 'success',
          nodeWidth: TRANSCRIPT_NODE_WIDTH,
          nodeHeight: textNodeHeight(estimateLines(transcript)),
        },
      };
      const edge: Edge = {
        id: generateId(),
        source: id,
        target: nodeId,
        sourceHandle: 'right',
        targetHandle: 'left',
      };
      store.addNodeWithEdge(transcriptNode, edge);
    },
    [id, t],
  );

  const doTranscribe = useCallback(async () => {
    setIsTranscribing(true);
    setProgress(0);
    updateNodeDataTransient(id, { status: 'loading' });

    const taskId = `asr-${id}-${Date.now()}`;
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<{ taskId: string; percent: number }>(
      'speech-to-text-progress',
      (event) => {
        if (event.payload.taskId === taskId) setProgress(event.payload.percent);
      },
    );

    try {
      const result = await speechToText(
        data.filePath as string,
        ASR_MODEL,
        ASR_VOCAB,
        taskId,
      );
      const text = result.text?.trim() ?? '';
      if (!text) {
        updateNodeDataTransient(id, { status: 'error', error: t('没有识别出语音内容') });
        useAppStore.getState().showToast(t('没有识别出语音内容'), 'error');
        return;
      }
      createTranscriptNode(text);
      updateNodeDataTransient(id, { status: 'success' });
      useAppStore.getState().showToast(t('语音转文本完成（{seconds}秒）', {
        seconds: Math.round(result.duration_seconds),
      }));
    } catch (error) {
      const message = getErrorMessage(error, t('语音转文本失败'));
      updateNodeDataTransient(id, { status: 'error', error: message });
      useAppStore.getState().showToast(message, 'error');
    } finally {
      unlisten();
      setIsTranscribing(false);
      setProgress(0);
    }
  }, [createTranscriptNode, data.filePath, id, t, updateNodeDataTransient]);

  const handleSpeechToText = useCallback(async () => {
    const filePath = data.filePath as string | undefined;
    if (!filePath) {
      useAppStore.getState().showToast(t('该音频没有本地文件，无法转写'), 'error');
      return;
    }
    // 权重和词表都要齐，缺任何一个都先下载
    const [hasModel, hasVocab] = await Promise.all([
      checkModelExists(ASR_MODEL),
      checkModelExists(ASR_VOCAB),
    ]);
    if (!hasModel || !hasVocab) {
      setDownloadPrompt(true);
      return;
    }
    await doTranscribe();
  }, [data.filePath, doTranscribe, t]);

  const handleDownloadConfirm = useCallback(async () => {
    setDownloadPrompt(false);
    setIsDownloadingModel(true);
    try {
      await downloadModel(ASR_MODEL);
      await downloadModel(ASR_VOCAB);
      useAppStore.getState().showToast(t('模型下载完成，开始转写...'), 'success');
    } catch (error) {
      useAppStore.getState().showToast(getErrorMessage(error, t('模型下载失败')), 'error');
      setIsDownloadingModel(false);
      return;
    }
    setIsDownloadingModel(false);
    await doTranscribe();
  }, [doTranscribe, t]);

  const handleDownloadCancel = useCallback(() => {
    setDownloadPrompt(false);
    setIsDownloadingModel(false);
  }, []);

  return {
    isTranscribing,
    progress,
    downloadPrompt,
    isDownloadingModel,
    handleSpeechToText,
    handleDownloadConfirm,
    handleDownloadCancel,
  };
}

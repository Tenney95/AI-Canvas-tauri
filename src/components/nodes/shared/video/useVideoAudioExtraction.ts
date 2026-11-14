import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../../../i18n';
import { generateId, useAppStore } from '../../../../store/useAppStore';
import { blobToDataUrl, derivedNodePlacement } from '../../../../store/store.utils';
import {
  cancelCanvasDerivation, completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation,
} from '../../../../services/canvasDerivationGuard';
import {
  buildNodeFileName, downloadUrlAndSave, isTauriEnv, saveBinaryToProjectData,
} from '../../../../services/fileService';
import { isRemoteMediaUrl } from '../../../../utils/mediaUrl';

export function useVideoAudioExtraction(nodeId: string, source: string | undefined) {
  const t = useT();
  const projectId = useAppStore((state) => state.currentProjectId);
  const [activeExtraction, setActiveExtraction] = useState<{
    nodeId: string; source: string; projectId: string; controller: AbortController;
  } | null>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [nodeId, source, projectId]);

  const handleExtractAudio = useCallback(async () => {
    if (!source || pending.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    const derivation = registerCanvasDerivation(useAppStore.getState(), nodeId, {
      onCancel: () => controller.abort(),
    });
    if (!derivation) return;
    const assertCurrent = () => {
      signal.throwIfAborted();
      const state = useAppStore.getState();
      if (!isCanvasDerivationFresh(derivation, state)
        || state.nodes.find((node) => node.id === nodeId)?.data.videoUrl !== source) {
        controller.abort();
        signal.throwIfAborted();
      }
    };
    pending.current = controller;
    setActiveExtraction({ nodeId, source, projectId: derivation.projectId, controller });
    try {
      const { extractVideoAudio } = await import('../../../../services/videoAudioExtractionService');
      assertCurrent();
      let inputUrl = source;
      // 桌面远程素材先沿用原生下载入口落盘，避免 WebView 跨域限制。
      if (isTauriEnv() && isRemoteMediaUrl(source)) {
        const savedSource = await downloadUrlAndSave(source, derivation.projectId, 'video-source', undefined, {
          signal, assertCurrent, throwOnError: true, redactErrors: true,
        });
        assertCurrent();
        if (!savedSource?.assetUrl) throw new Error(t('远程视频下载失败，无法提取音频'));
        inputUrl = savedSource.assetUrl;
      }
      const audio = await extractVideoAudio(inputUrl, signal);
      assertCurrent();
      const sourceNode = useAppStore.getState().nodes.find((node) => node.id === nodeId)!;
      const label = t('{name} 音频', { name: sourceNode.data.label?.trim() || t('视频') });
      const fileName = buildNodeFileName(label, audio.extension, `video-audio-${Date.now()}`);
      const saved = await saveBinaryToProjectData(audio.bytes, derivation.projectId, fileName, {
        assertCurrent, throwOnError: true,
      });
      assertCurrent();
      if (isTauriEnv() && !saved?.assetUrl) throw new Error(t('音频保存失败'));
      const audioUrl = saved?.assetUrl
        || await blobToDataUrl(new Blob([audio.bytes], { type: audio.mimeType }));
      assertCurrent();
      const state = useAppStore.getState();
      const currentNode = state.nodes.find((node) => node.id === nodeId)!;
      state.addNode({
        id: `node-${generateId()}`,
        type: 'ai-audio',
        ...derivedNodePlacement(currentNode),
        data: {
          label, type: 'ai-audio', role: 'source', status: 'success',
          audioUrl, fileName, filePath: saved?.filePath,
          nodeWidth: 260, nodeHeight: 140,
        },
      });
      completeCanvasDerivation(derivation);
      state.showToast(t('已提取音频并生成音频节点'), 'success');
    } catch (error) {
      if (!signal.aborted && isCanvasDerivationFresh(derivation, useAppStore.getState())) {
        const message = error instanceof Error ? error.message : t('提取音频失败');
        useAppStore.getState().showToast(t('提取音频失败：{message}', { message }), 'error');
      }
    } finally {
      cancelCanvasDerivation(derivation);
      if (pending.current === controller) {
        pending.current = null;
        setActiveExtraction(null);
      }
    }
  }, [nodeId, source, t]);

  const isExtractingAudio = activeExtraction?.nodeId === nodeId
    && activeExtraction.source === source && activeExtraction.projectId === projectId
    && !activeExtraction.controller.signal.aborted;
  return { isExtractingAudio, handleExtractAudio };
}

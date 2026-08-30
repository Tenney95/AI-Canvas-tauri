/**
 * VideoNode 视频节点 — 在画布上渲染视频内容，支持上传本地视频、播放控制、连接其他节点
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import NodeError from './shared/NodeError';
import GooeyBtn from './shared/GooeyBtn';
import ResizeHandle from './shared/ResizeHandle';
import VideoNodeControls from './shared/VideoNodeControls';
import VideoNodeToolbar, { type CaptureFramePosition } from './shared/VideoNodeToolbar';
import FullscreenOverlay from '../shared/FullscreenOverlay';
import { useNodeRename } from './shared/useNodeRename';
import { useSourceFileUpload } from './shared/useSourceFileUpload';
import { computeImageNodeDimensions, generateId, useAppStore } from '../../store/useAppStore';
import { blobToDataUrl, derivedNodePlacement } from '../../store/store.utils';
import { afterVideoFramePresented, seekVideoTo } from '../../utils/videoSeek';
import { downloadUrlAndSave, saveDataUrlToProjectData, buildNodeFileName } from '../../services/fileService';
import { copyFile as copyFileToClipboard } from '../../services/clipboardService';
import { useCompletionFlash } from '../../hooks/useCompletionFlash';
import {
  cancelCanvasDerivation,
  completeCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
} from '../../services/canvasDerivationGuard';
import { buildVideoEditorProjectId } from '../../services/indexedDbService';
import {
  postVideoEditorAiTransitionResult,
  postVideoEditorModels,
  subscribeVideoEditorWindow,
  type VideoEditorAiTransitionRequest,
  type VideoEditorExportResult,
  type VideoEditorFrameExportResult,
} from '../../services/videoEditorWindowService';
import {
  listVideoEditorVideoModels,
  runVideoEditorAiTransition,
} from '../../services/videoEditorAiTransitionService';
import { useT } from '../../i18n';

const DEFAULT_VIDEO_NODE_WIDTH = 280;
const DEFAULT_VIDEO_NODE_HEIGHT = 158;
const VIDEO_NODE_MAX_DIMENSION = 320;
const VIDEO_NODE_MIN_WIDTH = 180;
const VIDEO_NODE_MIN_HEIGHT = 110;
const VIDEO_FRAME_MAX_DIMENSION = 1280;

function fitVideoFrameDimensions(
  video: Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight'>,
  maxDimension: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
  return {
    width: Math.max(1, Math.round(video.videoWidth * scale)),
    height: Math.max(1, Math.round(video.videoHeight * scale)),
  };
}

function computeVideoNodeDimensions(videoWidth: number, videoHeight: number): { nodeWidth: number; nodeHeight: number } {
  if (videoWidth <= 0 || videoHeight <= 0) {
    return { nodeWidth: DEFAULT_VIDEO_NODE_WIDTH, nodeHeight: DEFAULT_VIDEO_NODE_HEIGHT };
  }

  const scale = Math.max(
    VIDEO_NODE_MAX_DIMENSION / Math.max(videoWidth, videoHeight),
    VIDEO_NODE_MIN_WIDTH / videoWidth,
    VIDEO_NODE_MIN_HEIGHT / videoHeight,
  );
  return {
    nodeWidth: Math.round(videoWidth * scale),
    nodeHeight: Math.round(videoHeight * scale),
  };
}

async function captureVideoFrame(
  video: HTMLVideoElement,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const { width, height } = fitVideoFrameDimensions(video, VIDEO_FRAME_MAX_DIMENSION);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法创建截帧画布');
  }

  ctx.drawImage(video, 0, 0, width, height);
  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => result ? resolve(result) : reject(new Error('无法编码视频帧')),
        'image/jpeg',
        0.9,
      );
    });
    return { dataUrl: await blobToDataUrl(blob), width, height };
  } finally {
    // 立即释放 backing store，不把 1280px RGBA 表面留给 GC 猜测回收时机。
    canvas.width = 1;
    canvas.height = 1;
  }
}

/** 节点封面只保留预览尺寸，避免把 4K 原帧常驻在组件内存。 */
function captureVideoPoster(video: HTMLVideoElement): { dataUrl: string; blank: boolean } {
  const maxDimension = 640;
  const { width, height } = fitVideoFrameDimensions(video, maxDimension);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建视频封面画布');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let visiblePixels = 0;
  const pixelCount = Math.max(1, pixels.length / 4);
  // 跳采样即可识别尚未提交的纯黑帧，避免扫描整张高分辨率画布。
  const stride = Math.max(4, Math.floor(pixelCount / 4096) * 4);
  for (let index = 0; index < pixels.length; index += stride) {
    if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 36) visiblePixels += 1;
  }
  const sampledPixels = Math.ceil(pixels.length / stride);
  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.82),
    blank: visiblePixels / Math.max(1, sampledPixels) < 0.01,
  };
}

/** 尾帧要略微退回，正好停在 duration 上多数解码器给不出画面 */
const LAST_FRAME_BACKOFF = 0.05;

const CAPTURE_FRAME_LABELS: Record<CaptureFramePosition, string> = {
  first: '首帧',
  current: '当前帧',
  last: '尾帧',
};

function resolveCaptureTime(video: HTMLVideoElement, position: CaptureFramePosition): number {
  if (position === 'current') return video.currentTime;
  if (position === 'first') return 0;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  return duration > 0 ? Math.max(0, duration - LAST_FRAME_BACKOFF) : video.currentTime;
}

/**
 * 把节点里的预览视频定位到目标时刻取一帧。
 * 不负责复位——连着取多帧时中间来回跳会让 seek 互相打架，由调用方取完一次性复位。
 */
async function captureFrameAtTime(
  video: HTMLVideoElement,
  targetTime: number,
): Promise<{ dataUrl: string; width: number; height: number }> {
  await seekVideoTo(video, targetTime);
  return await captureVideoFrame(video);
}

function isTaintedCanvasError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('Tainted canvases') || error.message.includes('may not be exported');
}

function releaseVideoElement(video: HTMLVideoElement | null): void {
  if (!video) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function captureFrameFromVideoUrl(url: string, currentTime: number): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let settled = false;
    let captureStarted = false;
    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      releaseVideoElement(video);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const done = () => {
      if (settled || captureStarted) return;
      captureStarted = true;
      void captureVideoFrame(video).then(
        (frame) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(frame);
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    };

    timer = window.setTimeout(() => fail(new Error('本地视频加载超时')), 15000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.addEventListener('error', () => fail(new Error('本地视频加载失败')), { once: true });
    video.addEventListener('loadedmetadata', () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const targetTime = duration > 0
        ? Math.min(Math.max(currentTime, 0), Math.max(duration - 0.01, 0))
        : 0;

      if (Math.abs(video.currentTime - targetTime) < 0.01) {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          done();
        } else {
          video.addEventListener('loadeddata', done, { once: true });
        }
        return;
      }

      video.addEventListener('seeked', done, { once: true });
      video.currentTime = targetTime;
    }, { once: true });
    video.src = url;
  });
}

function AIVideoNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const t = useT();
  const justCompleted = useCompletionFlash(data.status);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fullscreenVideoRef = useRef<HTMLVideoElement | null>(null);
  const fullscreenPlaybackRef = useRef({ currentTime: 0, wasPlaying: false });
  const compactPlaybackRestoreRef = useRef<{
    source: string;
    currentTime: number;
    shouldPlay: boolean;
  } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const previewAttemptedSourceRef = useRef<string | null>(null);
  const [generatedCover, setGeneratedCover] = useState<{ source: string; dataUrl: string } | null>(null);
  const [dismissedCoverSource, setDismissedCoverSource] = useState<string | null>(null);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const updateNodeDataTransient = useAppStore((s) => s.updateNodeDataTransient);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const openNodeDialog = useAppStore((s) => s.openNodeDialog);
  const isSingleSelection = useAppStore((s) => s.selectedNodeIds.length <= 1);
  const isSource = data.role === 'source';
  const fallbackDimensions = computeVideoNodeDimensions(data.videoWidth ?? 0, data.videoHeight ?? 0);
  const nodeWidth = data.nodeWidth ?? fallbackDimensions.nodeWidth;
  const nodeHeight = data.nodeHeight ?? fallbackDimensions.nodeHeight;

  const handleResize = useCallback(
    (newWidth: number, newHeight: number) => {
      updateNodeDataTransient(id, { nodeWidth: newWidth, nodeHeight: newHeight });
    },
    [id, updateNodeDataTransient],
  );

  const handleLoadedMetadata = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (videoWidth > 0 && videoHeight > 0) {
      const mediaDimensionsChanged = data.videoWidth !== videoWidth || data.videoHeight !== videoHeight;
      const nodeDimensionsMissing = data.nodeWidth == null || data.nodeHeight == null;
      if (mediaDimensionsChanged || nodeDimensionsMissing) {
        updateNodeDataTransient(id, {
          videoWidth,
          videoHeight,
          ...computeVideoNodeDimensions(videoWidth, videoHeight),
        });
      }
    }

    const source = data.videoUrl;
    const pendingRestore = compactPlaybackRestoreRef.current;
    if (source && pendingRestore?.source === source) {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = duration > 0
        ? Math.min(Math.max(pendingRestore.currentTime, 0), Math.max(duration - 0.01, 0))
        : Math.max(pendingRestore.currentTime, 0);
      compactPlaybackRestoreRef.current = null;
      previewAttemptedSourceRef.current = source;
      if (pendingRestore.shouldPlay) {
        void video.play().catch(() => {});
      }
      return;
    }
    if (!source || previewAttemptedSourceRef.current === source) return;
    previewAttemptedSourceRef.current = source;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const end = Math.max(0, duration - 0.05);
    const candidateTimes = duration > 0
      ? [...new Set([0.08, 0.25, 0.5, 0.75].map((ratio) => Math.min(end, Math.max(0.1, duration * ratio))))]
      : [0];

    const tryCandidate = (index: number) => {
      const targetTime = candidateTimes[index];
      const capturePresentedFrame = () => afterVideoFramePresented(video, () => {
        if (previewAttemptedSourceRef.current !== source) return;
        try {
          const poster = captureVideoPoster(video);
          if (poster.blank && index < candidateTimes.length - 1) {
            tryCandidate(index + 1);
            return;
          }
          if (!poster.blank) {
            setGeneratedCover({ source, dataUrl: poster.dataUrl });
            video.currentTime = 0;
          }
        } catch {
          // 远程跨域视频不能导出画布；保留已 seek 的可见帧作为降级。
        }
      });

      if (Math.abs(video.currentTime - targetTime) < 0.01
        && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        capturePresentedFrame();
        return;
      }
      video.addEventListener('seeked', capturePresentedFrame, { once: true });
      video.currentTime = targetTime;
    };

    tryCandidate(0);
  }, [
    data.nodeHeight,
    data.nodeWidth,
    data.videoHeight,
    data.videoUrl,
    data.videoWidth,
    id,
    updateNodeDataTransient,
  ]);

  const dismissInitialCover = useCallback(() => {
    if (data.videoUrl) setDismissedCoverSource(data.videoUrl);
  }, [data.videoUrl]);

  // ── Upload handler for source nodes ──
  const { isUploading, handleUpload: doUpload } = useSourceFileUpload('.mp4,.webm,.avi,.mov,.mkv');

  const handleUpload = useCallback(async () => {
    const result = await doUpload();
    if (!result) return;
    updateNodeData(id, {
      videoUrl: result.dataUrl,
      filePath: result.filePath,
      fileName: result.fileName,
      label: result.fileName,
      status: 'success',
    } as Partial<BaseNodeData>);
  }, [doUpload, id, updateNodeData]);

  /* ════════════════════════════════════════════
     Fullscreen State — 双击 / 工具栏按钮打开全屏预览
     ════════════════════════════════════════════ */
  const [isReversingPrompt, setIsReversingPrompt] = useState(false);
  const handleOpenFullscreen = useCallback(() => {
    if (!data.videoUrl && !data.thumbnailUrl) return;
    const compactVideo = videoRef.current;
    fullscreenPlaybackRef.current = {
      currentTime: compactVideo?.currentTime ?? 0,
      wasPlaying: compactVideo ? !compactVideo.paused && !compactVideo.ended : false,
    };
    compactVideo?.pause();
    setIsFullscreen(true);
  }, [data.videoUrl, data.thumbnailUrl]);
  const handleCloseFullscreen = useCallback(() => {
    const fullscreenVideo = fullscreenVideoRef.current;
    if (data.videoUrl) {
      compactPlaybackRestoreRef.current = {
        source: data.videoUrl,
        currentTime: fullscreenVideo?.currentTime ?? fullscreenPlaybackRef.current.currentTime,
        // 旧实现关闭全屏后，节点播放器会保持打开前的播放/暂停状态。
        // 全屏播放器会自动播放，不能据此把原本暂停的节点意外改成播放。
        shouldPlay: fullscreenPlaybackRef.current.wasPlaying,
      };
    }
    releaseVideoElement(fullscreenVideo);
    fullscreenVideoRef.current = null;
    setIsFullscreen(false);
  }, [data.videoUrl]);
  const setFullscreenVideoElement = useCallback((video: HTMLVideoElement | null) => {
    if (fullscreenVideoRef.current && fullscreenVideoRef.current !== video) {
      releaseVideoElement(fullscreenVideoRef.current);
    }
    fullscreenVideoRef.current = video;
  }, []);
  const handleFullscreenLoadedMetadata = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    video.currentTime = duration > 0
      ? Math.min(Math.max(fullscreenPlaybackRef.current.currentTime, 0), Math.max(duration - 0.01, 0))
      : Math.max(fullscreenPlaybackRef.current.currentTime, 0);
  }, []);

  useEffect(() => () => {
    releaseVideoElement(fullscreenVideoRef.current);
    fullscreenVideoRef.current = null;
  }, []);

  const { displayLabel, handleRename } = useNodeRename(id, data, t('粘贴视频'));
  const generatedCoverUrl = generatedCover && generatedCover.source === data.videoUrl
    ? generatedCover.dataUrl
    : null;
  const initialCoverUrl = generatedCoverUrl || (typeof data.thumbnailUrl === 'string' ? data.thumbnailUrl : null);
  const showInitialCover = !!initialCoverUrl && dismissedCoverSource !== data.videoUrl;

  // 独立编辑器窗口导出完成后，在源节点旁新建一个视频节点承载结果
  useEffect(() => {
    const projectId = useAppStore.getState().currentProjectId;
    if (!projectId) return;

    const instanceId = buildVideoEditorProjectId(projectId, id);
    return subscribeVideoEditorWindow(instanceId, (message) => {
      // 编辑器没有 Store 也没有 API Key：模型目录与转场生成都由主窗口代跑
      if (message.type === 'storyai:video-editor-models-request') {
        void postVideoEditorModels(instanceId, listVideoEditorVideoModels())
          .catch((error) => console.error('[videoEditor] 下发视频模型列表失败:', error));
        return;
      }

      if (message.type === 'storyai:video-editor-ai-transition-request') {
        const request = (message.payload ?? {}) as Partial<VideoEditorAiTransitionRequest>;
        const requestId = typeof request.requestId === 'string' ? request.requestId : '';
        if (!requestId) return;
        void (async () => {
          try {
            const outcome = await runVideoEditorAiTransition(
              request as VideoEditorAiTransitionRequest,
              projectId,
            );
            await postVideoEditorAiTransitionResult(instanceId, { requestId, ...outcome });
          } catch (error) {
            console.error('[videoEditor] AI 转场生成失败:', error);
            await postVideoEditorAiTransitionResult(instanceId, {
              requestId,
              error: error instanceof Error ? error.message : String(error),
            }).catch(() => {});
          }
        })();
        return;
      }

      if (message.type === 'storyai:video-editor-frame-exported') {
        const framePayload = (message.payload ?? {}) as Partial<VideoEditorFrameExportResult>;
        const imageUrl = typeof framePayload.imageUrl === 'string' ? framePayload.imageUrl : '';
        if (!imageUrl) return;

        const frameStore = useAppStore.getState();
        const frameDerivation = registerCanvasDerivation(frameStore, id);
        if (!frameDerivation) return;

        void (async () => {
          try {
            const dims = await computeImageNodeDimensions(imageUrl);
            // 取帧要等图片解码，期间可能已切项目或删节点，落盘前再验一次
            if (!isCanvasDerivationFresh(frameDerivation, useAppStore.getState())) {
              cancelCanvasDerivation(frameDerivation);
              return;
            }

            const liveStore = useAppStore.getState();
            const frameSource = liveStore.nodes.find((node) => node.id === id);
            const framePosition = frameSource?.position ?? { x: 0, y: 0 };
            const time = typeof framePayload.time === 'number' ? framePayload.time : 0;

            liveStore.addNode({
              id: `node-${generateId()}`,
              type: 'ai-image',
              // 放在剪辑结果节点下方，避免和"导出为新节点"的产物叠在一起
              position: {
                x: framePosition.x + nodeWidth + 40,
                y: framePosition.y + nodeHeight + 40,
              },
              data: {
                label: t('{name} {time}s 帧', { name: displayLabel, time: time.toFixed(2) }),
                type: 'ai-image',
                role: 'source',
                status: 'success',
                imageUrl,
                filePath: typeof framePayload.filePath === 'string' ? framePayload.filePath : undefined,
                fileName: typeof framePayload.fileName === 'string' ? framePayload.fileName : undefined,
                imageWidth: typeof framePayload.width === 'number' ? framePayload.width : undefined,
                imageHeight: typeof framePayload.height === 'number' ? framePayload.height : undefined,
                ...dims,
              },
            } as Parameters<typeof liveStore.addNode>[0]);

            completeCanvasDerivation(frameDerivation);
            useAppStore.getState().showToast(t('当前帧已生成图片节点'));
          } catch (error) {
            cancelCanvasDerivation(frameDerivation);
            console.error('[videoEditor] 当前帧回写失败:', error);
            useAppStore.getState().showToast(t('当前帧生成节点失败'), 'error');
          }
        })();
        return;
      }

      if (message.type !== 'storyai:video-editor-exported') return;
      const payload = (message.payload ?? {}) as Partial<VideoEditorExportResult>;
      const videoUrl = typeof payload.videoUrl === 'string' ? payload.videoUrl : '';
      if (!videoUrl) return;

      // 导出是跨窗口的异步结果：期间可能已切换项目或删掉源节点，
      // 用派生守卫挡掉过期回写，避免落到别的画布上
      const store = useAppStore.getState();
      const derivation = registerCanvasDerivation(store, id);
      if (!derivation) return;
      if (!isCanvasDerivationFresh(derivation, useAppStore.getState())) {
        cancelCanvasDerivation(derivation);
        return;
      }

      const sourceNode = store.nodes.find((node) => node.id === id);
      const position = sourceNode?.position ?? { x: 0, y: 0 };
      const outputWidth = typeof payload.width === 'number' ? payload.width : 0;
      const outputHeight = typeof payload.height === 'number' ? payload.height : 0;
      const dimensions = computeVideoNodeDimensions(outputWidth, outputHeight);

      store.addNode({
        id: `node-${generateId()}`,
        type: 'ai-video',
        position: { x: position.x + nodeWidth + 40, y: position.y },
        data: {
          label: t('{name} 剪辑', { name: displayLabel }),
          type: 'ai-video',
          role: 'source',
          status: 'success',
          videoUrl,
          filePath: typeof payload.filePath === 'string' ? payload.filePath : undefined,
          fileName: typeof payload.fileName === 'string' ? payload.fileName : undefined,
          videoDuration: typeof payload.duration === 'number' ? payload.duration : undefined,
          videoWidth: outputWidth || undefined,
          videoHeight: outputHeight || undefined,
          ...dimensions,
        },
      } as Parameters<typeof store.addNode>[0]);

      completeCanvasDerivation(derivation);
      useAppStore.getState().showToast(t('剪辑结果已生成新节点'));
    });
  }, [displayLabel, id, nodeHeight, nodeWidth, t]);

  const handleCopyFile = useCallback(async () => {
    const store = useAppStore.getState();
    const filePath = data.filePath as string | undefined;
    if (!filePath) {
      store.showToast(t('该视频没有本地文件，无法复制'), 'error');
      return;
    }
    const ok = await copyFileToClipboard(filePath);
    store.showToast(ok ? t('已复制视频到剪贴板') : t('复制失败'), ok ? undefined : 'error');
  }, [data.filePath, t]);

  const handleCaptureFrame = useCallback(async (position: CaptureFramePosition = 'current') => {
    const store = useAppStore.getState();
    const video = videoRef.current;
    const frameLabel = t(CAPTURE_FRAME_LABELS[position]);

    if (!video || !data.videoUrl) {
      store.showToast(t('没有可截取的视频'), 'error');
      return;
    }

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0 || video.videoHeight === 0) {
      store.showToast(t('视频尚未加载到可截取的帧'), 'error');
      return;
    }

    const derivation = registerCanvasDerivation(store, id);
    if (!derivation) {
      store.showToast(t('视频节点已失效，请重试'), 'error');
      return;
    }
    const captureTime = resolveCaptureTime(video, position);
    const ensureFresh = () => {
      const fresh = isCanvasDerivationFresh(derivation, useAppStore.getState());
      if (!fresh) cancelCanvasDerivation(derivation);
      return fresh;
    };

    const createFrameNode = async (frame: { dataUrl: string; width: number; height: number }): Promise<boolean> => {
      const dims = await computeImageNodeDimensions(frame.dataUrl);
      if (!ensureFresh()) return false;

      let liveStore = useAppStore.getState();
      const currentNode = liveStore.nodes.find((node) => node.id === id);
      const currentPosition = currentNode?.position ?? { x: 0, y: 0 };
      const frameFileName = buildNodeFileName(`${displayLabel} ${frameLabel}`, 'jpg', `video-frame-${Date.now()}`);
      const savedFrame = derivation.projectId !== 'default'
        ? await saveDataUrlToProjectData(frame.dataUrl, derivation.projectId, frameFileName)
        : null;
      if (!ensureFresh()) return false;

      liveStore = useAppStore.getState();
      const imageUrl = savedFrame?.assetUrl || frame.dataUrl;

      liveStore.addNode({
        id: `node-${generateId()}`,
        type: 'ai-image',
        ...derivedNodePlacement({
          position: currentPosition,
          parentId: currentNode?.parentId,
          data: currentNode?.data ?? ({ nodeWidth } as BaseNodeData),
        }),
        data: {
          label: `${displayLabel} ${frameLabel}`,
          type: 'ai-image',
          role: 'source',
          status: 'success',
          imageUrl,
          filePath: savedFrame?.filePath,
          fileName: frameFileName,
          imageWidth: frame.width,
          imageHeight: frame.height,
          ...dims,
        },
      } as Parameters<typeof liveStore.addNode>[0]);
      completeCanvasDerivation(derivation);
      return true;
    };

    const restoreTime = video.currentTime;
    try {
      const frame = await captureFrameAtTime(video, captureTime);
      video.currentTime = restoreTime;
      const created = await createFrameNode(frame);
      if (created) useAppStore.getState().showToast(t('已截取{frame}为图像节点', { frame: frameLabel }), 'success');
    } catch (error) {
      video.currentTime = restoreTime;
      if (!isTaintedCanvasError(error)) {
        cancelCanvasDerivation(derivation);
        const message = error instanceof Error ? error.message : t('截取{frame}失败', { frame: frameLabel });
        if (useAppStore.getState().currentProjectId === derivation.projectId) {
          useAppStore.getState().showToast(t('截取{frame}失败：{message}', { frame: frameLabel, message }), 'error');
        }
        return;
      }

      const remoteUrl = typeof data.sourceUrl === 'string' ? data.sourceUrl : data.videoUrl;
      if (!remoteUrl?.startsWith('http') || derivation.projectId === 'default') {
        cancelCanvasDerivation(derivation);
        useAppStore.getState().showToast(t('该视频来源禁止导出{frame}，请先上传为本地视频后再截帧', { frame: frameLabel }), 'error');
        return;
      }
      if (!ensureFresh()) return;

      useAppStore.getState().showToast(t('远程视频受跨域限制，正在转为本地资源后重试...'), 'success');
      const saved = await downloadUrlAndSave(remoteUrl, derivation.projectId, 'video-source');
      if (!ensureFresh()) return;
      if (!saved?.assetUrl) {
        cancelCanvasDerivation(derivation);
        useAppStore.getState().showToast(t('远程视频本地化失败，无法截取{frame}', { frame: frameLabel }), 'error');
        return;
      }

      try {
        useAppStore.getState().updateNodeData(id, {
          videoUrl: saved.assetUrl,
          filePath: saved.filePath,
          sourceUrl: remoteUrl,
        } as Partial<BaseNodeData>);

        const created = await createFrameNode(await captureFrameFromVideoUrl(saved.assetUrl, captureTime));
        if (created) useAppStore.getState().showToast(t('已截取{frame}为图像节点', { frame: frameLabel }), 'success');
      } catch (fallbackError) {
        cancelCanvasDerivation(derivation);
        const message = fallbackError instanceof Error ? fallbackError.message : t('本地资源截帧失败');
        if (useAppStore.getState().currentProjectId === derivation.projectId) {
          useAppStore.getState().showToast(t('截取{frame}失败：{message}', { frame: frameLabel, message }), 'error');
        }
      }
    }
  }, [data.sourceUrl, data.videoUrl, displayLabel, id, nodeWidth, t]);

  // 反推提示词：抽首/中/尾三帧当序列喂给文本模型，让它把画面和运动一起还原
  const handleShowPrompt = useCallback(() => {
    const nodeElement = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    if (nodeElement) {
      const rect = nodeElement.getBoundingClientRect();
      openNodeDialog(id, { x: rect.left + rect.width / 2, y: rect.bottom });
      return;
    }
    openNodeDialog(id);
  }, [id, openNodeDialog]);

  const handleReversePrompt = useCallback(async () => {
    const store = useAppStore.getState();
    const video = videoRef.current;
    if (!video || !data.videoUrl) {
      store.showToast(t('没有可反推的视频'), 'error');
      return;
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) {
      store.showToast(t('视频尚未加载到可读取的帧'), 'error');
      return;
    }

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const times = duration > 0
      ? [0, duration / 2, Math.max(0, duration - LAST_FRAME_BACKOFF)]
      : [video.currentTime];

    setIsReversingPrompt(true);
    const restoreTime = video.currentTime;
    try {
      const frames: string[] = [];
      for (const time of times) {
        frames.push((await captureFrameAtTime(video, time)).dataUrl);
      }
      useAppStore.getState().setReversePromptRequest({
        sourceNodeId: id,
        kind: 'video',
        imageUrls: frames,
      });
    } catch (error) {
      const message = isTaintedCanvasError(error)
        ? t('远程视频受跨域限制，请先把视频本地化后再反推')
        : error instanceof Error ? error.message : t('读取视频帧失败');
      useAppStore.getState().showToast(message, 'error');
    } finally {
      // 三帧一次性取完再复位，中间来回跳会让 seek 互相打架
      video.currentTime = restoreTime;
      setIsReversingPrompt(false);
    }
  }, [data.videoUrl, id, t]);

  return (
    <div className="node-wrapper relative" style={{ width: nodeWidth }}>
      <NodeLabel
        kind="ai-video"
        label={displayLabel}
        displayId={data.displayId as number | undefined}
        nodeId={id}
        onRename={handleRename}
      />
      {data.videoUrl && (
        <div className={`node-toolbar-shell ${selected && isSingleSelection ? 'is-visible' : ''}`}>
          <VideoNodeToolbar
            nodeId={id}
            onCaptureFrame={handleCaptureFrame}
            onFullscreen={handleOpenFullscreen}
            onCopyFile={handleCopyFile}
            onReversePrompt={handleReversePrompt}
            onShowPrompt={handleShowPrompt}
            isReversingPrompt={isReversingPrompt}
          />
        </div>
      )}
      <div
        className={`node video-node ${selected ? 'selected' : ''} ${data.status === 'loading' || isUploading ? 'loading' : ''} ${justCompleted ? 'just-completed' : ''}`}
        style={{ height: nodeHeight }}
      >
        <div className={`node-preview compact${data.videoUrl || data.thumbnailUrl ? ' has-media' : ''}`}>
          {data.videoUrl && !isFullscreen ? (
            <video
              ref={videoRef}
              src={data.videoUrl}
              className="video-preview-player compact"
              crossOrigin="anonymous"
              playsInline
              preload="metadata"
              onLoadedMetadata={handleLoadedMetadata}
              onPlay={dismissInitialCover}
              onDoubleClick={(e) => { e.stopPropagation(); handleOpenFullscreen(); }}
              data-source-url={data.sourceUrl}
            />
          ) : data.videoUrl && initialCoverUrl ? (
            <img
              src={initialCoverUrl}
              alt=""
              className="video-node-poster"
              draggable={false}
            />
          ) : data.videoUrl ? (
            <div className="node-preview-placeholder" aria-hidden="true">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" />
              </svg>
            </div>
          ) : data.thumbnailUrl ? (
            <img
              src={data.thumbnailUrl}
              alt="Video thumbnail"
              className="video-node-poster"
              onDoubleClick={(e) => { e.stopPropagation(); handleOpenFullscreen(); }}
            />
          ) : isUploading ? (
            <div className="node-preview-loading">
              <div className="spinner large" />
              <span>{t('上传中...')}</span>
            </div>
          ) : data.status === 'loading' ? (
            <div className="node-preview-loading">
              <div className="spinner large" />
              <span>{t('生成视频中...')}</span>
            </div>
          ) : (
            isSource ? (
              <button
                type="button"
                className="node-preview-placeholder nodrag nopan border-0 bg-transparent p-0 cursor-pointer transition-[color,transform] duration-100 hover:text-canvas-text-secondary active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-canvas-border"
                onClick={(event) => {
                  event.stopPropagation();
                  void handleUpload();
                }}
                data-tooltip={t('上传视频')}
                aria-label={t('上传视频')}
              >
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </button>
            ) : (
              <div className="node-preview-placeholder">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <polygon points="23 7 16 12 23 17 23 7" />
                  <rect x="1" y="5" width="15" height="14" rx="2" />
                </svg>
              </div>
            )
          )}
          {data.videoUrl && !isFullscreen && showInitialCover && (
            <img src={initialCoverUrl} alt="" className="video-node-initial-cover" draggable={false} />
          )}
          {data.videoUrl && !isFullscreen && (
            <VideoNodeControls
              videoRef={videoRef}
              source={data.videoUrl}
              onInteract={dismissInitialCover}
            />
          )}
        </div>
        {data.error && <NodeError nodeId={id} message={data.error} />}
        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-video" >
          <GooeyBtn className="gooey-btn-left" hue={217} />
        </Handle>
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-video" >
          <GooeyBtn className="gooey-btn-right" hue={217} />
        </Handle>
      </div>

      <ResizeHandle
        nodeId={id}
        currentWidth={nodeWidth}
        currentHeight={nodeHeight}
        minWidth={VIDEO_NODE_MIN_WIDTH}
        minHeight={VIDEO_NODE_MIN_HEIGHT}
        lockAspectRatio
        onResizeStart={commitToHistory}
        onResizeEnd={commitToHistory}
        onResize={handleResize}
      />

      {/* 全屏预览 */}
      <FullscreenOverlay
        isOpen={isFullscreen}
        onClose={handleCloseFullscreen}
        hidePanel
        title={(data.label as string) || t('视频预览')}
        className="fullscreen-overlay--image-preview"
      >
        {isFullscreen && (data.videoUrl ? (
          <video
            ref={setFullscreenVideoElement}
            src={data.videoUrl}
            className="fullscreen-video-view"
            controls
            autoPlay
            playsInline
            crossOrigin="anonymous"
            data-source-url={data.sourceUrl}
            onLoadedMetadata={handleFullscreenLoadedMetadata}
          />
        ) : data.thumbnailUrl ? (
          <img
            src={data.thumbnailUrl}
            alt="Video thumbnail"
            className="fullscreen-img-view"
          />
        ) : null)}
      </FullscreenOverlay>
    </div>
  );
}

export default memo(AIVideoNode);

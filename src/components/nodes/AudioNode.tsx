/**
 * AudioNode 音频节点 — 在画布上渲染音频内容，支持上传本地音频、波形可视化、连接其他节点
 */
import { memo, useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { Handle, Position, type Edge, type Node } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import NodeError from './shared/NodeError';
import GooeyBtn from './shared/GooeyBtn';
import { useNodeRename } from './shared/useNodeRename';
import { useSourceFileUpload } from './shared/useSourceFileUpload';
import AudioNodeToolbar from './shared/AudioNodeToolbar';
import NodeToolbarShell from './shared/NodeToolbarShell';
import { useAudioNodeAsr } from './shared/audio/useAudioNodeAsr';
import ModelDownloadDialog from '../shared/ModelDownloadDialog';
import { generateId, useAppStore } from '../../store/useAppStore';
import { copyFile as copyFileToClipboard } from '../../services/clipboardService';
import { useCompletionFlash } from '../../hooks/useCompletionFlash';
import { transcribeAudio } from '../../services/ai/transcribeAudio';
import { textNodeHeight } from '../../utils/num';
import { useT } from '../../i18n';
import NodeGenerationProgress from './shared/NodeGenerationProgress';
import MediaTaskStatus from './shared/MediaTaskStatus';
import FullscreenOverlay from '../shared/FullscreenOverlay';
import CanvasAudioPreview from '../shared/CanvasAudioPreview';
import { useCanvasNodeLodProtection } from '../../hooks/useCanvasNodeLod';
import { useComfyMediaSource } from '../../hooks/useComfyMediaSource';
import { useViewportMediaSource } from '../../hooks/useViewportMediaSource';
import { shouldLoadNativeComfyMedia } from '../../services/comfyMediaSource';
import { acquireAudioWaveform, WAVEFORM_COLUMNS, type WaveformData } from './shared/audio/audioWaveformCache';

/* ── Waveform drawing helpers ── */

function drawWaveform(canvas: HTMLCanvasElement, data: WaveformData) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const mid = h / 2;

  ctx.clearRect(0, 0, w, h);
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, '#f97316');
  gradient.addColorStop(0.5, '#fb923c');
  gradient.addColorStop(1, '#f97316');
  ctx.fillStyle = gradient;

  for (let i = 0; i < data.peaks.length; i++) {
    const bh = Math.max(data.peaks[i] * (h * 0.8), 0.5);
    ctx.fillRect(i, mid - bh / 2, 1, bh);
  }
}

function drawEmptyWaveform(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const mid = h / 2;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(249, 115, 22, 0.25)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();
}

/** Redraw waveform + optional progress line */
function renderCanvas(
  canvas: HTMLCanvasElement,
  data: WaveformData | null,
  progress: number, // 0..1, -1 means hide
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;

  if (!data) {
    ctx.clearRect(0, 0, w, h);
    return;
  }

  drawWaveform(canvas, data);

  if (progress >= 0) {
    const x = Math.round(progress * w);
    ctx.strokeStyle = '#e8e8ed';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 4);
    ctx.lineTo(x, h - 4);
    ctx.stroke();
  }
}

/* ── Play Icon SVG ── */
function PlayIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="8,5 19,12 8,19" />
    </svg>
  );
}

/* ── Format seconds ── */
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/* ── Main Component ── */

function AIAudioNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const t = useT();
  const nativeAudio = useMemo(() => shouldLoadNativeComfyMedia(data.audioUrl), [data.audioUrl]);
  const justCompleted = useCompletionFlash(data.status);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const updateNodeDataTransient = useAppStore((s) => s.updateNodeDataTransient);
  const isSingleSelection = useAppStore((s) => s.selectedNodeIds.length <= 1);
  const isSource = data.role === 'source';

  // ── Upload state ──
  const { isUploading, handleUpload: doUpload } = useSourceFileUpload('.mp3,.wav,.ogg,.flac,.aac,.m4a,.wma');
  const [isTranscribing, setIsTranscribing] = useState(false);

  // ── Audio playback state ──
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [requestedSource, setRequestedSource] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const resumePosition = useRef<{ source: string; time: number } | null>(null);
  const waveformRef = useRef<WaveformData | null>(null);
  const animFrameRef = useRef(0);
  const waveformPressSelectedRef = useRef<boolean | null>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const playbackAttemptRef = useRef(0);
  const [fullscreen, setFullscreen] = useState<{ projectId: string | null; time: number; playing: boolean } | null>(null);
  const visibleSource = useViewportMediaSource(data.audioUrl, canvasRef, { rootMargin: '160px 0px' });
  const playbackSource = useComfyMediaSource(nativeAudio
    ? requestedSource === data.audioUrl && visibleSource && !fullscreen ? data.audioUrl : undefined
    : data.audioUrl, () => { setRequestedSource(null); setIsPlaying(false); });
  useCanvasNodeLodProtection(id, isPlaying || !!fullscreen);
  const closeFullscreen = useCallback(() => setFullscreen(null), []);
  const openFullscreen = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(clickTimerRef.current);
    const audio = audioRef.current;
    if (!audio || !data.audioUrl) return;
    const time = audio.currentTime;
    const playing = !audio.paused;
    playbackAttemptRef.current += 1;
    audio.pause();
    setRequestedSource(null);
    cancelAnimationFrame(animFrameRef.current);
    setIsPlaying(false);
    setFullscreen({ projectId: useAppStore.getState().currentProjectId, time, playing });
  }, [data.audioUrl]);

  const { displayLabel, handleRename } = useNodeRename(id, data, t('粘贴音频'));

  const handleCopyFile = useCallback(async () => {
    const store = useAppStore.getState();
    const filePath = data.filePath as string | undefined;
    if (!filePath) {
      store.showToast(t('该音频没有本地文件，无法复制'), 'error');
      return;
    }
    const ok = await copyFileToClipboard(filePath);
    store.showToast(ok ? t('已复制音频到剪贴板') : t('复制失败'), ok ? undefined : 'error');
  }, [data.filePath, t]);

  const handleTranscribe = useCallback(async () => {
    const store = useAppStore.getState();
    const sourceNode = store.nodes.find((node) => node.id === id);
    const audioUrl = sourceNode?.data.audioUrl;
    if (!sourceNode || !audioUrl) {
      store.showToast(t('没有可转录的音频'), 'error');
      return;
    }

    const projectId = store.currentProjectId;
    setIsTranscribing(true);
    try {
      const transcript = await transcribeAudio({
        audioUrl,
        fileName: sourceNode.data.fileName,
        responseFormat: 'json',
      });

      const liveStore = useAppStore.getState();
      const liveSource = liveStore.nodes.find((node) => node.id === id);
      if (!liveSource || liveStore.currentProjectId !== projectId) return;

      const newNodeId = `node-${generateId()}`;
      const sourceWidth = Number(liveSource.data.nodeWidth) || 280;
      const estimatedLines = transcript.split(/\r?\n/).reduce(
        (count, line) => count + Math.max(1, Math.ceil(line.length / 36)),
        0,
      );
      const sourceLabel = liveSource.data.label?.trim() || liveSource.data.fileName?.trim() || t('音频');
      const transcriptNode: Node<BaseNodeData> = {
        id: newNodeId,
        type: 'ai-text',
        position: {
          x: liveSource.position.x + sourceWidth + 40,
          y: liveSource.position.y,
        },
        data: {
          label: t('{name} 转录', { name: sourceLabel }),
          type: 'ai-text',
          role: 'source',
          output: transcript,
          status: 'success',
          nodeWidth: 280,
          nodeHeight: textNodeHeight(estimatedLines),
        },
      };
      const edge: Edge = {
        id: generateId(),
        source: id,
        target: newNodeId,
        sourceHandle: 'right',
        targetHandle: 'left',
      };

      liveStore.addNodeWithEdge(transcriptNode, edge);
      liveStore.showToast(t('音频转录完成'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('音频转录失败');
      useAppStore.getState().showToast(message, 'error');
    } finally {
      setIsTranscribing(false);
    }
  }, [id, t]);

  // ── 本地语音转文本（SenseVoice ONNX）──
  const {
    isTranscribing: isAsrRunning,
    progress: asrProgress,
    downloadPrompt,
    isDownloadingModel,
    modelDownloadProgress,
    modelDownloadLabel,
    handleSpeechToText,
    handleDownloadConfirm,
    handleDownloadCancel,
  } = useAudioNodeAsr({ id, data, t, updateNodeDataTransient });

  // ── Reset when URL changes ──
  useEffect(() => {
    playbackAttemptRef.current += 1;
    clearTimeout(clickTimerRef.current);
    audioRef.current?.pause();
    cancelAnimationFrame(animFrameRef.current);
    waveformRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) drawEmptyWaveform(canvas);
    const resetFrame = requestAnimationFrame(() => {
      setRequestedSource(null);
      resumePosition.current = null;
      setIsPlaying(false);
      setCurrentTime(0);
    });
    return () => cancelAnimationFrame(resetFrame);
  }, [data.audioUrl]);

  // ── Decode visible waveforms during idle time; selected nodes load immediately ──
  useEffect(() => {
    const audioUrl = data.audioUrl;
    const canvas = canvasRef.current;
    if (!audioUrl || !canvas) return;

    let cancelled = false;
    let cancelScheduled: (() => void) | undefined;
    let waveformRequest: AbortController | undefined;

    const loadWaveform = async () => {
      if (waveformRequest && !waveformRequest.signal.aborted) return;
      const request = new AbortController();
      waveformRequest = request;
      try {
        const waveform = await acquireAudioWaveform(audioUrl, request.signal);
        if (cancelled || request.signal.aborted || document.hidden || canvasRef.current !== canvas) return;
        waveformRef.current = waveform;
        drawWaveform(canvas, waveform);
      } catch {
        if (!cancelled && !request.signal.aborted && canvasRef.current === canvas) drawEmptyWaveform(canvas);
      } finally {
        if (waveformRequest === request) waveformRequest = undefined;
      }
    };

    const scheduleWaveform = () => {
      if (cancelled || document.hidden || waveformRef.current) return;
      cancelScheduled?.();
      if (selected || typeof window.requestIdleCallback !== 'function') {
        void loadWaveform();
        cancelScheduled = undefined;
        return;
      }
      const idleId = window.requestIdleCallback(() => {
        cancelScheduled = undefined;
        void loadWaveform();
      }, { timeout: 1_000 });
      cancelScheduled = () => window.cancelIdleCallback(idleId);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        cancelScheduled?.();
        cancelScheduled = undefined;
        waveformRequest?.abort();
        const audio = audioRef.current;
        if (audio && !audio.paused) {
          audio.pause();
          setRequestedSource(null);
          cancelAnimationFrame(animFrameRef.current);
          renderCanvas(canvas, waveformRef.current, -1);
          setIsPlaying(false);
        }
        return;
      }
      scheduleWaveform();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    scheduleWaveform();
    return () => {
      cancelled = true;
      cancelScheduled?.();
      waveformRequest?.abort();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [data.audioUrl, selected]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      playbackAttemptRef.current += 1;
      clearTimeout(clickTimerRef.current);
      cancelAnimationFrame(animFrameRef.current);
      audio?.pause();
    };
  }, [data.audioUrl]);

  // ── Progress animation loop ──
  const startProgressLoop = useCallback(() => {
    const audio = audioRef.current;
    const canvas = canvasRef.current;
    if (!audio || !canvas) return;

    const loop = () => {
      setCurrentTime(Math.floor(audio.currentTime));
      if (resumePosition.current) resumePosition.current.time = audio.currentTime;
      const dur = audio.duration;
      const p = dur > 0 ? audio.currentTime / dur : -1;
      renderCanvas(canvas, waveformRef.current, p);
      animFrameRef.current = requestAnimationFrame(loop);
    };
    animFrameRef.current = requestAnimationFrame(loop);
  }, []);

  // Comfy 音频仅在用户请求播放且仍在视口时持有原生租约；暂停后记住播放位置。
  useEffect(() => {
    if (!nativeAudio || !requestedSource) return;
    if (!visibleSource || fullscreen) {
      const reset = requestAnimationFrame(() => { setRequestedSource(null); setIsPlaying(false); });
      return () => cancelAnimationFrame(reset);
    }
    const audio = audioRef.current;
    if (!audio || !playbackSource || requestedSource !== data.audioUrl) return;
    let current = true;
    const attempt = ++playbackAttemptRef.current;
    const saved = resumePosition.current;
    if (audio.getAttribute('src') !== playbackSource) { audio.src = playbackSource; audio.load(); }
    if (saved?.source === requestedSource) audio.currentTime = saved.time;
    resumePosition.current = { source: requestedSource, time: audio.currentTime };
    void audio.play().then(() => {
      if (!current || playbackAttemptRef.current !== attempt) return;
      startProgressLoop(); setIsPlaying(true);
    }, () => {
      if (!current || playbackAttemptRef.current !== attempt) return;
      setRequestedSource(null); setIsPlaying(false);
    });
    return () => {
      current = false;
      playbackAttemptRef.current += 1;
      if (audio.getAttribute('src') === playbackSource) {
        resumePosition.current = { source: requestedSource, time: audio.ended ? 0 : audio.currentTime };
      }
      audio.pause(); audio.removeAttribute('src'); audio.load();
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [nativeAudio, requestedSource, visibleSource, playbackSource, data.audioUrl, fullscreen, startProgressLoop]);

  // ── Play / Pause toggle ──
  const togglePlay = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const audio = audioRef.current;
      const canvas = canvasRef.current;
      if (!audio || !canvas || !data.audioUrl || fullscreen) return;
      if (nativeAudio) {
        if (requestedSource === data.audioUrl) {
          resumePosition.current = { source: data.audioUrl, time: audio.ended ? 0 : audio.currentTime };
          audio.pause(); cancelAnimationFrame(animFrameRef.current);
          renderCanvas(canvas, waveformRef.current, -1); setIsPlaying(false);
          setRequestedSource(null);
        } else setRequestedSource(data.audioUrl);
        return;
      }
      if (!playbackSource) return;
      const attempt = ++playbackAttemptRef.current;

      if (!audio.paused) {
        audio.pause();
        cancelAnimationFrame(animFrameRef.current);
        renderCanvas(canvas, waveformRef.current, -1);
        setIsPlaying(false);
      } else {
        audio.play().then(() => {
          if (playbackAttemptRef.current !== attempt) return;
          startProgressLoop();
          setIsPlaying(true);
        }).catch(() => {});
      }
    },
    [data.audioUrl, nativeAudio, requestedSource, playbackSource, fullscreen, startProgressLoop],
  );

  // ── Audio timeupdate (for display) ──
  const handleTimeUpdate = useCallback(() => {
    // currentTime updated in rAF loop, this is backup
  }, []);

  // ── Audio ended ──
  const handleEnded = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    const canvas = canvasRef.current;
    if (canvas) renderCanvas(canvas, waveformRef.current, -1);
    setCurrentTime(0);
    setIsPlaying(false);
    resumePosition.current = null;
    setRequestedSource(null);
  }, []);

  // ── Upload handler ──
  const handleUpload = useCallback(async () => {
    const result = await doUpload();
    if (!result) return;
    updateNodeData(id, {
      audioUrl: result.dataUrl,
      filePath: result.filePath,
      fileName: result.fileName,
      label: result.fileName,
      status: 'success',
    } as Partial<BaseNodeData>);
  }, [doUpload, id, updateNodeData]);

  // ── Render ──
  return (
    <div className="node-wrapper" style={{ width: 280 }} onContextMenu={(e) => e.preventDefault()}>
      <NodeLabel
        kind="ai-audio"
        label={displayLabel}
        displayId={data.displayId as number | undefined}
        nodeId={id}
        onRename={handleRename}
      />
      {data.audioUrl && (
        <NodeToolbarShell visible={selected && isSingleSelection}>
          <AudioNodeToolbar
            nodeId={id}
            isPlaying={isPlaying}
            isTranscribing={isTranscribing}
            isAsrRunning={isAsrRunning}
            asrProgress={asrProgress}
            onTogglePlay={togglePlay}
            onTranscribe={handleTranscribe}
            onSpeechToText={handleSpeechToText}
            onUpload={handleUpload}
            onCopyFile={handleCopyFile}
          />
        </NodeToolbarShell>
      )}
      <div
        className={`node audio-node ${selected ? 'selected' : ''} ${data.status === 'loading' || isUploading ? 'loading' : ''} ${justCompleted ? 'just-completed' : ''}`}
        style={{ minHeight: 88 }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="node-preview compact relative">
          {isSource && (
            <button
              className="node-upload-btn"
              onClick={(e) => { e.stopPropagation(); handleUpload(); }}
              data-tooltip={t('上传音频')}
              aria-label={t('上传音频')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
          )}
          {data.audioUrl ? (
            <div
              className="audio-waveform-wrapper"
              title={t('双击打开音乐播放器')}
              onDoubleClick={openFullscreen}
              onPointerDownCapture={() => { waveformPressSelectedRef.current = !!selected; }}
              onPointerCancel={() => { waveformPressSelectedRef.current = null; }}
              onClick={(e) => {
                clearTimeout(clickTimerRef.current);
                if (e.detail > 1) { e.stopPropagation(); return; }
                // 画布可能在 mousedown 时选中节点，需使用本次按下前的状态。
                const wasSelected = waveformPressSelectedRef.current ?? !!selected;
                waveformPressSelectedRef.current = null;
                if (!wasSelected || !selected) return;
                e.stopPropagation();
                clickTimerRef.current = setTimeout(() => togglePlay(e), 250);
              }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <canvas ref={canvasRef} className="audio-waveform-canvas" width={WAVEFORM_COLUMNS} height={80} />
              <audio
                ref={audioRef}
                src={playbackSource}
                data-source-url={data.sourceUrl}
                onEnded={handleEnded}
                onTimeUpdate={handleTimeUpdate}
                preload="none"
              />
              {!isPlaying && (
                <div className="audio-play-overlay">
                  <PlayIcon />
                </div>
              )}
              {isPlaying && (
                <div className="audio-progress-bar-container">
                  <div className="audio-time-label">{formatTime(currentTime)}</div>
                  <div className="audio-progress-dot" />
                </div>
              )}
            </div>
          ) : isUploading ? (
            <div className="node-preview-loading">
              <div className="spinner" />
              <span>{t('上传中...')}</span>
            </div>
          ) : data.status === 'loading' ? (
            <NodeGenerationProgress nodeId={id} fallbackLabel={t(data.mediaTaskStage === 'saving' ? '保存中' : '生成音频中...')} compactSpinner />
          ) : (
            <div className="node-preview-placeholder">
              {isSource ? (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              ) : (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              )}
              <span>{isSource ? t('上传音频文件') : t('TTS 文本转语音')}</span>
            </div>
          )}
          {data.audioUrl && data.status === 'loading' && (
            <NodeGenerationProgress nodeId={id} fallbackLabel={t(data.mediaTaskStage === 'saving' ? '保存中' : '生成音频中...')} overlay />
          )}
          {data.mediaTaskState && data.status !== 'loading' && <MediaTaskStatus nodeId={id} overlay />}
        </div>
        {data.error && <NodeError nodeId={id} message={data.error} />}
        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-audio" >
          <GooeyBtn className="gooey-btn-left" hue={30} />
        </Handle>
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-audio" >
          <GooeyBtn className="gooey-btn-right" hue={30} />
        </Handle>
      </div>
      <FullscreenOverlay isOpen={!!fullscreen} onClose={closeFullscreen} hidePanel unmountOnClose>
        {fullscreen && (
          <CanvasAudioPreview
            nodeId={id} openingProjectId={fullscreen.projectId}
            initialTime={fullscreen.time} initiallyPlaying={fullscreen.playing} onClose={closeFullscreen}
          />
        )}
      </FullscreenOverlay>
      {/* 语音识别模型下载弹窗（Portal → body，与超分一致） */}
      <ModelDownloadDialog
        type="asr"
        showPrompt={downloadPrompt}
        showDownloading={isDownloadingModel}
        progress={modelDownloadProgress}
        downloadLabel={modelDownloadLabel}
        onConfirm={handleDownloadConfirm}
        onCancel={handleDownloadCancel}
      />
    </div>
  );
}

export default memo(AIAudioNode);

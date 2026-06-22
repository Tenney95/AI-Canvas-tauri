/**
 * AudioNode 音频节点 — 在画布上渲染音频内容，支持上传本地音频、波形可视化、连接其他节点
 */
import { memo, useCallback, useState, useRef, useEffect } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import NodeError from './shared/NodeError';
import GooeyBtn from './shared/GooeyBtn';
import { useNodeRename } from './shared/useNodeRename';
import { useSourceFileUpload } from './shared/useSourceFileUpload';
import { useAppStore } from '../../store/useAppStore';
import { useCompletionFlash } from '../../hooks/useCompletionFlash';

/* ── Waveform data ── */
interface WaveformData {
  peaks: number[];       // normalised [0..1] per column
  duration: number;      // seconds
}

/* ── Waveform drawing helpers ── */

/** Decode audio → extract peaks → cache & draw */
async function decodeAndDrawWaveform(
  audioUrl: string,
  canvas: HTMLCanvasElement,
  cache: React.MutableRefObject<WaveformData | null>,
  audioCtx: AudioContext,
) {
  try {
    const response = await fetch(audioUrl);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    const w = canvas.width;
    const channelData = audioBuffer.getChannelData(0);
    const step = Math.max(1, Math.floor(channelData.length / w));

    const peaks: number[] = [];
    for (let i = 0; i < w; i++) {
      let max = 0;
      const start = i * step;
      const end = Math.min(start + step, channelData.length);
      for (let j = start; j < end; j++) {
        const abs = Math.abs(channelData[j]);
        if (abs > max) max = abs;
      }
      peaks.push(max);
    }

    const data: WaveformData = { peaks, duration: audioBuffer.duration };
    cache.current = data;
    drawWaveform(canvas, data);
  } catch {
    // fallback: draw empty / failed state
    drawEmptyWaveform(canvas);
  }
}

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
  const justCompleted = useCompletionFlash(data.status);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const isSource = data.role === 'source';

  // ── Upload state ──
  const { isUploading, handleUpload: doUpload } = useSourceFileUpload('.mp3,.wav,.ogg,.flac,.aac,.m4a,.wma');

  // ── Audio playback state ──
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const waveformRef = useRef<WaveformData | null>(null);
  const animFrameRef = useRef(0);

  const { displayLabel, handleRename } = useNodeRename(id, data, '粘贴音频');

  // ── Decode & draw real waveform when audioUrl is set ──
  useEffect(() => {
    if (!data.audioUrl) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }

    decodeAndDrawWaveform(data.audioUrl, canvas, waveformRef, audioCtxRef.current);
  }, [data.audioUrl]);

  // ── Reset when URL changes ──
  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    cancelAnimationFrame(animFrameRef.current);
    waveformRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }, [data.audioUrl]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  // ── Progress animation loop ──
  const startProgressLoop = useCallback(() => {
    const audio = audioRef.current;
    const canvas = canvasRef.current;
    const data = waveformRef.current;
    if (!audio || !canvas) return;

    const loop = () => {
      setCurrentTime(audio.currentTime);
      const dur = audio.duration;
      const p = dur > 0 ? audio.currentTime / dur : -1;
      renderCanvas(canvas, data, p);
      animFrameRef.current = requestAnimationFrame(loop);
    };
    animFrameRef.current = requestAnimationFrame(loop);
  }, []);

  // ── Play / Pause toggle ──
  const togglePlay = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const audio = audioRef.current;
      const canvas = canvasRef.current;
      if (!audio || !canvas) return;

      if (isPlaying) {
        audio.pause();
        cancelAnimationFrame(animFrameRef.current);
        renderCanvas(canvas, waveformRef.current, -1);
        setIsPlaying(false);
      } else {
        audio.play().then(() => {
          startProgressLoop();
          setIsPlaying(true);
        }).catch(() => {});
      }
    },
    [isPlaying, startProgressLoop],
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
    <div className="node-wrapper" style={{ width: 260 }} onContextMenu={(e) => e.preventDefault()}>
      <NodeLabel
        kind="ai-audio"
        label={displayLabel}
        displayId={data.displayId as number | undefined}
        isBeta={!isSource}
        nodeId={id}
        onRename={handleRename}
      />
      <div
        className={`node audio-node ${selected ? 'selected' : ''} ${data.status === 'loading' || isUploading ? 'loading' : ''} ${justCompleted ? 'just-completed' : ''}`}
        style={{ minHeight: 88 }}
      >
        <div className="node-preview compact">
          {isSource && (
            <button
              className="node-upload-btn"
              onClick={(e) => { e.stopPropagation(); handleUpload(); }}
              data-tooltip="上传音频"
              aria-label="上传音频"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
          )}
          {data.audioUrl ? (
            <div className="audio-waveform-wrapper" onClick={togglePlay}>
              <canvas ref={canvasRef} className="audio-waveform-canvas" width={220} height={80} />
              <audio
                ref={audioRef}
                src={data.audioUrl}
                data-source-url={data.sourceUrl}
                onEnded={handleEnded}
                onTimeUpdate={handleTimeUpdate}
                preload="auto"
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
              <span>上传中...</span>
            </div>
          ) : data.status === 'loading' ? (
            <div className="node-preview-loading">
              <div className="spinner" />
              <span>生成音频中...</span>
            </div>
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
              <span>{isSource ? '上传音频文件' : 'TTS 文本转语音'}</span>
            </div>
          )}
        </div>
        {data.error && <NodeError nodeId={id} message={data.error} />}
        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-audio" >
          <GooeyBtn className="gooey-btn-left" hue={30} />
        </Handle>
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-audio" >
          <GooeyBtn className="gooey-btn-right" hue={30} />
        </Handle>
      </div>
    </div>
  );
}

export default memo(AIAudioNode);

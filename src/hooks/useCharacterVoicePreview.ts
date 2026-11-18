import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { acquireComfyMediaSource, shouldLoadNativeComfyMedia } from '../services/comfyMediaSource';

interface VoicePreviewOptions {
  showPending?: boolean;
  stopOnPause?: boolean;
  onError?: () => void;
  getSource?: (id: string) => string | undefined;
}

interface VoicePreviewIdentity {
  context: string;
  id: string;
  url: string;
}

interface VoicePreviewRequest {
  voice: VoicePreviewIdentity;
  controller: AbortController;
  player?: HTMLAudioElement;
  release?: () => void;
}

/**
 * 为每个角色声音入口管理独立的播放器和媒体租约，按入口范围与当前来源释放。
 * 普通地址直接播放，ComfyUI 通过原生媒体取源。入口决定等待中的按钮状态和错误提示。
 */
export function useCharacterVoicePreview(context: string, { showPending, stopOnPause, onError, getSource }: VoicePreviewOptions = {}) {
  const requestRef = useRef<VoicePreviewRequest | null>(null);
  const [preview, setPreview] = useState<{ voice: VoicePreviewIdentity; status: 'pending' | 'playing' | 'error' } | null>(null);

  const stop = useCallback((id?: string) => {
    const request = requestRef.current;
    if (id !== undefined && request?.voice.id !== id) return;
    requestRef.current = null;
    const player = request?.player;
    if (player) {
      player.onpause = null;
      player.onended = null;
      player.onerror = null;
      player.pause();
      player.removeAttribute('src');
      player.load();
    }
    request?.controller.abort();
    request?.release?.();
    setPreview(null);
  }, []);

  useLayoutEffect(() => () => stop(), [context, stop]);

  const current = preview?.voice.context === context ? preview : null;
  const activeVoice = current?.status === 'error' ? undefined : current?.voice;
  const activeSource = activeVoice && getSource?.(activeVoice.id);
  useLayoutEffect(() => {
    if (!activeVoice || activeSource === undefined) return;
    // 只重新核对当前声音，列表中新增或编辑其他条目不会打断试听。
    return () => { if (requestRef.current?.voice === activeVoice) stop(); };
  }, [activeVoice, activeSource, stop]);

  const toggle = async (id: string, url?: string) => {
    if (!url) return;
    const wasActive = requestRef.current?.voice.id === id;
    stop();
    if (wasActive) return;

    const voice = { context, id, url };
    const request: VoicePreviewRequest = { voice, controller: new AbortController() };
    requestRef.current = request;
    const isCurrent = () => requestRef.current === request;
    const finish = () => { if (isCurrent()) stop(); };
    const fail = () => {
      if (!isCurrent()) return;
      stop();
      setPreview({ voice, status: 'error' });
      onError?.();
    };
    setPreview({ voice, status: 'pending' });

    try {
      let src = url;
      if (shouldLoadNativeComfyMedia(url)) {
        const lease = await acquireComfyMediaSource(url, request.controller.signal);
        if (!isCurrent()) { lease.release(); return; }
        request.release = lease.release;
        src = lease.src;
      }
      const player = new Audio();
      request.player = player;
      if (stopOnPause) player.onpause = () => { if (player.paused) finish(); };
      player.onended = finish;
      player.onerror = fail;
      player.src = src;
      // 普通地址直接在用户点击中调用 play，保留 WebView 的用户激活。
      await player.play();
      if (isCurrent()) setPreview({ voice, status: 'playing' });
    } catch { fail(); }
  };

  const playingId = current && (!getSource || activeSource === current.voice.url)
    && (current.status === 'playing' || (current.status === 'pending' && showPending)) ? current.voice.id : null;
  return { playingId, error: current?.status === 'error', toggle, stop };
}

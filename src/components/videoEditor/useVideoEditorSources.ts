/**
 * 按素材维度解析播放地址、探测参数并抽取缩略图。
 *
 * 多个片段可能来自同一个素材（分割后尤其常见），因此以解析后的 URL 为键做缓存，
 * 避免重复探测同一个文件。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getConvertFileSrc } from '../../services/fileService';
import {
  createVideoInput,
  probeVideoSource,
  extractThumbnails,
} from '../../services/videoEditorMediaService';
import { extractWaveform } from '../../services/videoAudioMixer';
import type { VideoEditorClip, VideoEditorSourceProbe } from '../../types/videoEditor';

// 时间轴放大时仍需保持清晰；抽帧只做一次，同源片段会复用缓存。
const THUMBNAIL_COUNT = 48;
const THUMBNAIL_HEIGHT = 96;
const WAVEFORM_BUCKETS = 240;

export interface SourceState {
  url: string;
  probe: VideoEditorSourceProbe | null;
  thumbnails: string[];
  /** 音频峰值包络，用于在音频片段上画波形 */
  waveform?: number[];
  error?: string;
}

export function pruneVideoEditorSources(
  previous: Record<string, SourceState>,
  activeUrls: readonly string[],
): Record<string, SourceState> {
  const active = new Set(activeUrls);
  const entries = Object.entries(previous).filter(([url]) => active.has(url));
  return entries.length === Object.keys(previous).length
    ? previous
    : Object.fromEntries(entries);
}

/** 片段对应的可播放地址：优先本地文件，回落到片段自带 URL */
export function resolveClipUrl(clip: VideoEditorClip): string {
  const convertFileSrc = getConvertFileSrc();
  if (clip.filePath && convertFileSrc) return convertFileSrc(clip.filePath);
  return clip.sourceUrl ?? '';
}

export function useVideoEditorSources(
  clips: VideoEditorClip[],
  /** 探测出真实时长后回调，供调用方回填片段出点 */
  onProbed?: (url: string, probe: VideoEditorSourceProbe) => void,
) {
  const [sources, setSources] = useState<Record<string, SourceState>>({});
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const [loading, setLoading] = useState(false);
  // 回调每次渲染都是新身份，用 ref 持有以免重跑整轮探测
  const onProbedRef = useRef(onProbed);
  onProbedRef.current = onProbed;

  const urls = clips.map(resolveClipUrl).filter(Boolean);
  const urlKey = urls.join('|');

  useEffect(() => {
    const pending = [...new Set(urls)];
    setSources((previous) => pruneVideoEditorSources(previous, pending));
    if (pending.length === 0) {
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);

    void (async () => {
      for (const url of pending) {
        if (!active) return;
        // 已解析过的素材直接跳过，分割产生的同源片段不重复探测
        if (Object.prototype.hasOwnProperty.call(sourcesRef.current, url)) continue;

        const clip = clips.find((candidate) => resolveClipUrl(candidate) === url);
        if (clip?.kind === 'image') {
          // 图片没有时长，缩略图就是它本身
          setSources((previous) => ({
            ...previous,
            [url]: { url, probe: null, thumbnails: [url] },
          }));
          continue;
        }

        let input: Awaited<ReturnType<typeof createVideoInput>> | null = null;
        try {
          input = await createVideoInput(url);
          const probe = await probeVideoSource(input);
          if (!active) return;
          setSources((previous) => ({
            ...previous,
            [url]: { url, probe, thumbnails: [] },
          }));
          onProbedRef.current?.(url, probe);

          const thumbnails = await extractThumbnails(input, {
            count: THUMBNAIL_COUNT,
            height: THUMBNAIL_HEIGHT,
            duration: probe.duration,
          });
          if (!active) return;
          setSources((previous) => ({
            ...previous,
            [url]: { ...previous[url], url, probe, thumbnails },
          }));

          // 波形较慢，放在缩略图之后，不阻塞时间轴出图
          const waveform = probe.audioCodec
            ? await extractWaveform(input, { buckets: WAVEFORM_BUCKETS, duration: probe.duration })
            : [];
          if (!active) return;
          setSources((previous) => ({
            ...previous,
            [url]: { ...previous[url], url, probe, thumbnails, waveform },
          }));
        } catch (reason) {
          if (!active) return;
          setSources((previous) => ({
            ...previous,
            [url]: {
              url,
              probe: null,
              thumbnails: [],
              error: reason instanceof Error ? reason.message : String(reason),
            },
          }));
        } finally {
          input?.dispose();
        }
      }
      if (active) setLoading(false);
    })();

    return () => { active = false; };
    // clips 每次编辑都会换身份，用地址集合作为真正的依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey]);

  const getSource = useCallback(
    (clip: VideoEditorClip): SourceState | undefined => sources[resolveClipUrl(clip)],
    [sources],
  );

  return { sources, getSource, loading };
}

/**
 * VideoEditorTimeline — 多轨时间轴
 *
 * 视频轨是磁吸的：片段首尾相接，拖动即换序。支持缩放/横向滚动、
 * 边界吸附、框选多选、片段右键菜单和入点/出点裁剪。
 * 片段可在轨道间拖拽：主轨 ←→ 叠加轨自由移动。
 * 音频轨与字幕轨占位，二期启用。
 */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Icon } from '@iconify/react';
import {
  getClipDuration,
  type VideoEditorClip,
  type VideoEditorTrack,
} from '../../types/videoEditor';
import {
  clampZoom,
  dropIndexAt,
  fitZoom,
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  rectsIntersect,
  snapTime,
} from './timelineOps';
import type { SourceState } from './useVideoEditorSources';
import VideoEditorRuler from './VideoEditorRuler';
import { TimelineSplitIcon, TimelineThumbnails } from '../shared/Timeline';
import VideoEditorWaveform from './VideoEditorWaveform';
import { useT } from '../../i18n';

export interface ClipContextMenuState {
  clipId: string;
  x: number;
  y: number;
}

interface VideoEditorTimelineProps {
  tracks: VideoEditorTrack[];
  duration: number;
  playhead: number;
  selectedClipIds: string[];
  getSource: (clip: VideoEditorClip) => SourceState | undefined;
  snapEnabled: boolean;
  onToggleSnap: () => void;
  onPlayheadChange: (time: number) => void;
  onSelectClips: (clipIds: string[]) => void;
  onTrimClip: (clipId: string, sourceIn: number, sourceOut: number) => void;
  onMoveClip: (clipId: string, targetIndex: number) => void;
  /** 跨轨道移动片段：position 在主轨=序号，在叠加轨=时间轴时间 */
  onMoveClipToTrack: (clipId: string, sourceTrackId: string, targetTrackId: string, position: number) => void;
  /** 叠加轨内移动：更新时间轴位置 */
  onMoveClipInOverlay: (clipId: string, trackId: string, timelineStart: number) => void;
  /** 拖到空白区域时创建新轨道并把片段放进去 */
  onCreateTrackAndMove: (clipId: string, sourceTrackId: string, timelineStart: number) => void;
  onSplit: () => void;
  onDeleteSelected: () => void;
  onDuplicateClip: (clipId: string) => void;
  /** 点击两段之间的接缝：没有转场就加一个默认转场，已有则直接跳去编辑 */
  onEditTransition: (clipId: string) => void;
  onTracksChange: (tracks: VideoEditorTrack[]) => void;
  onAddTrack: (kind: 'video' | 'audio') => void;
  onMoveTrack: (trackId: string, direction: -1 | 1) => void;
  onBeginInteraction: () => void;
  onEndInteraction: () => void;
  canSplit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

const TRANSITION_LABELS: Record<string, string> = {
  dissolve: '交叠淡入',
  fade: '黑场淡入',
  none: '硬切',
};

/** 裁剪时片段最短保留时长，避免拖成零长 */
const MIN_CLIP_DURATION = 0.1;
/** 认定为「拖动」而非「点击」的像素阈值 */
const DRAG_THRESHOLD_PX = 4;
const MEDIA_CLIP_MIME = 'application/x-video-editor-clip-id';
type TrackDensity = 'compact' | 'normal' | 'large';
const TRACK_DENSITY: Record<TrackDensity, { height: number; textHeight: number; label: string }> = {
  compact: { height: 48, textHeight: 26, label: '紧凑' },
  normal: { height: 64, textHeight: 30, label: '标准' },
  large: { height: 84, textHeight: 38, label: '宽大' },
};

const TRACK_KIND_ICON: Record<string, string> = {
  video: '🎬',
  audio: '🔊',
  caption: '💬',
};

/** 轨道颜色映射（剪映风格的轨道区分） */
const TRACK_COLORS = [
  'var(--track-color-1, #6366f1)',
  'var(--track-color-2, #22c55e)',
  'var(--track-color-3, #f59e0b)',
  'var(--track-color-4, #3b82f6)',
  'var(--track-color-5, #ec4899)',
  'var(--track-color-6, #14b8a6)',
];
function trackAccent(index: number): string {
  return TRACK_COLORS[index % TRACK_COLORS.length];
}

function isCompactTextTrack(track: VideoEditorTrack): boolean {
  return track.kind === 'video'
    && track.overlay === true
    && track.clips.length > 0
    && track.clips.every((clip) => clip.kind === 'text');
}

function VideoEditorTimeline({
  tracks,
  duration,
  playhead,
  selectedClipIds,
  getSource,
  snapEnabled,
  onToggleSnap,
  onPlayheadChange,
  onSelectClips,
  onTrimClip,
  onMoveClip,
  onMoveClipToTrack,
  onMoveClipInOverlay,
  onCreateTrackAndMove,
  onSplit,
  onDeleteSelected,
  onDuplicateClip,
  onEditTransition,
  onTracksChange,
  onAddTrack,
  onMoveTrack,
  onBeginInteraction,
  onEndInteraction,
  canSplit,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: VideoEditorTimelineProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(40);
  const [autoFit, setAutoFit] = useState(true);
  const [trackDensity, setTrackDensity] = useState<TrackDensity>('normal');
  const [snapIndicatorTime, setSnapIndicatorTime] = useState<number | null>(null);
  const [selectionBox, setSelectionBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  // 拖拽状态：记录源轨道、目标轨道和在目标轨中的位置
  const [dragging, setDragging] = useState<{
    clipId: string;
    sourceTrackId: string;
    targetTrackId: string;
    /** 在主轨中 = 插入序号；在叠加轨中 = 时间轴时间 */
    position: number;
    offsetPx: number;
    offsetY: number;
  } | null>(null);
  const [clipMenu, setClipMenu] = useState<ClipContextMenuState | null>(null);

  const selectedSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds]);
  // 视频工程按底层→顶层合成；时间轴把视觉层反向展示，音频仍放在主视频下方。
  const displayTracks = useMemo(() => [
    ...tracks.filter((track) => track.kind === 'video').reverse(),
    ...tracks.filter((track) => track.kind !== 'video'),
  ], [tracks]);
  const videoClipCount = useMemo(
    () => tracks.filter((track) => track.kind === 'video').reduce((sum, track) => sum + track.clips.length, 0),
    [tracks],
  );
  const unlockedSelected = useMemo(
    () => tracks.flatMap((track) => track.clips
      .filter((clip) => selectedSet.has(clip.id) && !track.locked)
      .map((clip) => ({ clip, track }))),
    [selectedSet, tracks],
  );
  const unlockedSelectedVideoCount = unlockedSelected
    .filter(({ track }) => track.kind === 'video').length;
  const canDeleteSelected = unlockedSelected.length > 0
    && videoClipCount - unlockedSelectedVideoCount > 0;

  // 在所有视频轨中查找片段
  const allVideoClips = useMemo(() => {
    const result: { clip: VideoEditorClip; trackId: string }[] = [];
    for (const track of tracks) {
      if (track.kind !== 'video') continue;
      for (const clip of track.clips) {
        result.push({ clip, trackId: track.id });
      }
    }
    return result;
  }, [tracks]);

  const soleSelected = useMemo(() => {
    const found = allVideoClips.find(({ clip }) => clip.id === selectedClipIds[0]);
    return found?.clip ?? null;
  }, [allVideoClips, selectedClipIds]);
  const clipMenuLocked = clipMenu
    ? tracks.some((track) => track.locked && track.clips.some((clip) => clip.id === clipMenu.clipId))
    : false;

  const laneWidth = Math.max(0, duration * pixelsPerSecond);

  // 插入指示线：主轨磁吸排序时用序号算位置，叠加轨直接按时间算
  const dropIndicatorPx = useMemo(() => {
    if (!dragging) return null;
    const targetTrack = tracks.find((t) => t.id === dragging.targetTrackId);
    if (!targetTrack || targetTrack.overlay) {
      // 叠加轨：直接按时间轴坐标
      return dragging.position * pixelsPerSecond;
    }
    // 主轨：按序号累计时长
    const targetClips = targetTrack.clips.filter((c) => c.id !== dragging.clipId);
    let seconds = 0;
    for (let i = 0; i < Math.min(dragging.position, targetClips.length); i += 1) {
      seconds += getClipDuration(targetClips[i]);
    }
    return seconds * pixelsPerSecond;
  }, [dragging, pixelsPerSecond, tracks]);

  // 首次布局与窗口尺寸变化时铺满可用宽度，用户手动缩放后不再接管
  useLayoutEffect(() => {
    if (!autoFit) return;
    const element = scrollRef.current;
    if (!element || duration <= 0) return;
    const apply = () => setPixelsPerSecond(fitZoom(duration, element.clientWidth - 24));
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, [autoFit, duration]);

  const timeFromClientX = useCallback((clientX: number): number => {
    const element = scrollRef.current;
    if (!element || pixelsPerSecond <= 0) return 0;
    const rect = element.getBoundingClientRect();
    const x = clientX - rect.left + element.scrollLeft;
    return Math.min(duration, Math.max(0, x / pixelsPerSecond));
  }, [duration, pixelsPerSecond]);

  const applySnap = useCallback((time: number, exceptClipId?: string): number => {
    if (!snapEnabled) {
      setSnapIndicatorTime(null);
      return time;
    }
    // 收集所有视频轨片段边沿作为吸附候选
    const allEdges: number[] = [0];
    for (const track of tracks) {
      if (track.kind !== 'video') continue;
      for (const clip of track.clips) {
        if (clip.id === exceptClipId) continue;
        allEdges.push(clip.timelineStart);
        allEdges.push(clip.timelineStart + getClipDuration(clip));
      }
    }
    allEdges.push(playhead);
    const snapped = snapTime(time, [...new Set(allEdges)].sort((a, b) => a - b), pixelsPerSecond);
    setSnapIndicatorTime(snapped === time ? null : snapped);
    return snapped;
  }, [pixelsPerSecond, playhead, snapEnabled, tracks]);

  // Ctrl/⌘ + 滚轮缩放，以光标处的时间为锚点
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = element.getBoundingClientRect();
        const anchorTime = (event.clientX - rect.left + element.scrollLeft) / pixelsPerSecond;
        const normalizedDelta = Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 30);
        const next = clampZoom(pixelsPerSecond * Math.exp(-normalizedDelta / 180));
        setAutoFit(false);
        setPixelsPerSecond(next);
        // 保持光标下的时间点不动
        requestAnimationFrame(() => {
          element.scrollLeft = anchorTime * next - (event.clientX - rect.left);
        });
        return;
      }
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        element.scrollLeft += Math.sign(delta) * Math.min(Math.abs(delta), 80);
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [pixelsPerSecond]);

  // 点击别处关掉片段右键菜单
  useEffect(() => {
    if (!clipMenu) return;
    const close = () => setClipMenu(null);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [clipMenu]);

  const startScrub = useCallback((event: React.PointerEvent) => {
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    onPlayheadChange(applySnap(timeFromClientX(event.clientX)));

    const onMove = (moveEvent: PointerEvent) => {
      onPlayheadChange(applySnap(timeFromClientX(moveEvent.clientX)));
    };
    const onUp = (upEvent: PointerEvent) => {
      target.releasePointerCapture(upEvent.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      setSnapIndicatorTime(null);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }, [applySnap, onPlayheadChange, timeFromClientX]);

  const startBoxSelection = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const targetElement = event.target as HTMLElement;
    if (targetElement.closest('.video-editor-clip, .ui-timeline__ruler')) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const canvasRect = canvas.getBoundingClientRect();
    const originClientX = event.clientX;
    const originClientY = event.clientY;
    const originX = originClientX - canvasRect.left;
    const originY = originClientY - canvasRect.top;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const baseSelection = additive ? selectedClipIds : [];
    let moved = false;

    const onMove = (moveEvent: PointerEvent) => {
      if (!moved
        && Math.abs(moveEvent.clientX - originClientX) < DRAG_THRESHOLD_PX
        && Math.abs(moveEvent.clientY - originClientY) < DRAG_THRESHOLD_PX) return;
      moved = true;
      const currentX = moveEvent.clientX - canvasRect.left;
      const currentY = moveEvent.clientY - canvasRect.top;
      const clientSelection = {
        left: Math.min(originClientX, moveEvent.clientX),
        top: Math.min(originClientY, moveEvent.clientY),
        right: Math.max(originClientX, moveEvent.clientX),
        bottom: Math.max(originClientY, moveEvent.clientY),
      };
      setSelectionBox({
        left: Math.min(originX, currentX),
        top: Math.min(originY, currentY),
        width: Math.abs(currentX - originX),
        height: Math.abs(currentY - originY),
      });
      const hitIds = [...canvas.querySelectorAll<HTMLElement>('[data-clip-id]')]
        .filter((element) => rectsIntersect(clientSelection, element.getBoundingClientRect()))
        .map((element) => element.dataset.clipId)
        .filter((id): id is string => !!id);
      onSelectClips([...new Set([...baseSelection, ...hitIds])]);
    };

    const finish = (upEvent: PointerEvent) => {
      if (target.hasPointerCapture(upEvent.pointerId)) target.releasePointerCapture(upEvent.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', finish);
      target.removeEventListener('pointercancel', finish);
      setSelectionBox(null);
      if (!moved) {
        onSelectClips([]);
        onPlayheadChange(applySnap(timeFromClientX(upEvent.clientX)));
        setSnapIndicatorTime(null);
      }
    };

    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', finish);
    target.addEventListener('pointercancel', finish);
  }, [applySnap, onPlayheadChange, onSelectClips, selectedClipIds, timeFromClientX]);

  const startTrim = useCallback((
    clip: VideoEditorClip,
    mode: 'in' | 'out',
    event: React.PointerEvent,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    onBeginInteraction();

    const apply = (clientX: number) => {
      const time = applySnap(timeFromClientX(clientX), clip.id);
      // 手柄位置是时间轴坐标，换算回素材坐标才能改入点/出点
      const sourceTime = clip.sourceIn + (time - clip.timelineStart);
      if (mode === 'in') {
        onTrimClip(
          clip.id,
          Math.max(0, Math.min(sourceTime, clip.sourceOut - MIN_CLIP_DURATION)),
          clip.sourceOut,
        );
      } else {
        onTrimClip(clip.id, clip.sourceIn, Math.max(sourceTime, clip.sourceIn + MIN_CLIP_DURATION));
      }
    };

    const onMove = (moveEvent: PointerEvent) => apply(moveEvent.clientX);
    const onUp = (upEvent: PointerEvent) => {
      target.releasePointerCapture(upEvent.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      setSnapIndicatorTime(null);
      onEndInteraction();
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }, [applySnap, onBeginInteraction, onEndInteraction, onTrimClip, timeFromClientX]);

  const startClipDrag = useCallback((clip: VideoEditorClip, sourceTrackId: string, event: React.PointerEvent) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);

    const originX = event.clientX;
    const originY = event.clientY;
    // 按下时鼠标相对于片段左边缘的像素偏移，松手时用它反算片段头部应落在的时间
    const clipRect = target.getBoundingClientRect();
    const grabOffsetX = originX - clipRect.left;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    let moved = false;
    let committed = false;
    const sourceTrack = tracks.find((t) => t.id === sourceTrackId);
    const isSourceOverlay = sourceTrack?.overlay ?? false;

    /** 根据鼠标 Y 坐标判断落在哪条视频轨，返回 null 表示在轨道下方空白区 */
    const resolveTargetTrack = (clientY: number): string | null => {
      const videoTracks = tracks.filter((t) => t.kind === 'video' && !t.locked);
      if (videoTracks.length === 0) return null;
      // 找最后一个轨道的底部边界
      let lastTrackBottom = 0;
      for (const vt of videoTracks) {
        const el = document.querySelector(`[data-track-id="${vt.id}"]`) as HTMLElement | null;
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom > lastTrackBottom) lastTrackBottom = rect.bottom;
        if (clientY >= rect.top && clientY <= rect.bottom) return vt.id;
      }
      // 在最后一个轨道下方 → 触发新建轨道
      if (clientY > lastTrackBottom) return null;
      // 在所有轨道上方 → 回退到源轨道
      return sourceTrackId;
    };

    /** 用片段左边缘 X 反算时间轴时间，松手时片段头部不跳 */
    const clipLeftTimeFromClientX = (clientX: number): number => {
      const element = scrollRef.current;
      if (!element || pixelsPerSecond <= 0) return 0;
      const scrollRect = element.getBoundingClientRect();
      const clipLeftX = clientX - grabOffsetX;
      const x = clipLeftX - scrollRect.left + element.scrollLeft;
      return Math.min(duration, Math.max(0, x / pixelsPerSecond));
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!moved && Math.abs(moveEvent.clientX - originX) < DRAG_THRESHOLD_PX
        && Math.abs(moveEvent.clientY - originY) < DRAG_THRESHOLD_PX) return;
      if (!moved) {
        moved = true;
        onSelectClips([clip.id]);
      }

      const targetTrackId = resolveTargetTrack(moveEvent.clientY);
      const time = clipLeftTimeFromClientX(moveEvent.clientX);

      if (targetTrackId === null) {
        // 拖到空白区域，显示为新轨道
        const snappedTime = applySnap(time, clip.id);
        setDragging({
          clipId: clip.id, sourceTrackId,
          targetTrackId: '__new__', position: snappedTime,
          offsetPx: moveEvent.clientX - originX,
          offsetY: moveEvent.clientY - originY,
        });
        return;
      }

      const targetTrack = tracks.find((t) => t.id === targetTrackId);
      const snappedTime = applySnap(time, clip.id);

      if (targetTrack?.overlay) {
        setDragging({
          clipId: clip.id, sourceTrackId,
          targetTrackId, position: snappedTime,
          offsetPx: moveEvent.clientX - originX,
          offsetY: moveEvent.clientY - originY,
        });
      } else {
        const targetClips = targetTrack?.clips ?? [];
        const index = dropIndexAt(targetClips, time, clip.id);
        setDragging({
          clipId: clip.id, sourceTrackId,
          targetTrackId, position: index,
          offsetPx: moveEvent.clientX - originX,
          offsetY: moveEvent.clientY - originY,
        });
      }
    };

    const cleanup = (pointerId: number) => {
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onCancel);
    };

    const onCancel = (cancelEvent: PointerEvent) => {
      cleanup(cancelEvent.pointerId);
      setDragging(null);
      setSnapIndicatorTime(null);
    };

    const onUp = (upEvent: PointerEvent) => {
      cleanup(upEvent.pointerId);

      if (moved) {
        const targetTrackId = resolveTargetTrack(upEvent.clientY);
        const time = clipLeftTimeFromClientX(upEvent.clientX);

        if (!committed) {
          committed = true;
          onBeginInteraction();
        }

        if (targetTrackId === null) {
          // 拖到空白区域 → 创建新轨道
          const snappedTime = applySnap(time, clip.id);
          onCreateTrackAndMove(clip.id, sourceTrackId, snappedTime);
        } else if (targetTrackId !== sourceTrackId) {
          const targetTrack = tracks.find((t) => t.id === targetTrackId);
          if (targetTrack?.overlay) {
            const snappedTime = applySnap(time, clip.id);
            onMoveClipToTrack(clip.id, sourceTrackId, targetTrackId, snappedTime);
          } else {
            const targetClips = targetTrack?.clips ?? [];
            const index = dropIndexAt(targetClips, time, clip.id);
            onMoveClipToTrack(clip.id, sourceTrackId, targetTrackId, index);
          }
        } else if (isSourceOverlay) {
          const snappedTime = applySnap(time, clip.id);
          onMoveClipInOverlay(clip.id, sourceTrackId, snappedTime);
        } else {
          const sourceClips = sourceTrack?.clips ?? [];
          const index = dropIndexAt(sourceClips, time, clip.id);
          onMoveClip(clip.id, index);
        }
        onEndInteraction();
      } else if (additive) {
        onSelectClips(
          selectedSet.has(clip.id)
            ? selectedClipIds.filter((id) => id !== clip.id)
            : [...selectedClipIds, clip.id],
        );
      } else {
        onSelectClips([clip.id]);
      }
      setDragging(null);
      setSnapIndicatorTime(null);
    };

    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onCancel);
  }, [
    applySnap, duration, onBeginInteraction, onCreateTrackAndMove, onEndInteraction, onMoveClip,
    onMoveClipInOverlay, onMoveClipToTrack, onSelectClips, pixelsPerSecond,
    selectedClipIds, selectedSet, tracks,
  ]);

  const toggleTrackFlag = useCallback((trackId: string, flag: 'muted' | 'locked' | 'hidden') => {
    onBeginInteraction();
    onTracksChange(tracks.map((track) => (
      track.id === trackId ? { ...track, [flag]: !track[flag] } : track
    )));
    onEndInteraction();
  }, [onBeginInteraction, onEndInteraction, onTracksChange, tracks]);

  const zoomBy = useCallback((factor: number) => {
    setAutoFit(false);
    setPixelsPerSecond((current) => clampZoom(current * factor));
  }, []);

  const cycleTrackDensity = useCallback(() => {
    setTrackDensity((current) => (
      current === 'compact' ? 'normal' : current === 'normal' ? 'large' : 'compact'
    ));
  }, []);

  const handleMediaDrop = useCallback((track: VideoEditorTrack, event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (track.locked || track.kind !== 'video') return;
    const clipId = event.dataTransfer.getData(MEDIA_CLIP_MIME);
    if (!clipId) return;
    const sourceTrack = tracks.find((candidate) => candidate.clips.some((clip) => clip.id === clipId));
    if (!sourceTrack || sourceTrack.locked) return;
    const scroll = scrollRef.current;
    if (!scroll || pixelsPerSecond <= 0) return;
    const rect = scroll.getBoundingClientRect();
    const rawTime = Math.max(0, Math.min(duration, (
      event.clientX - rect.left + scroll.scrollLeft
    ) / pixelsPerSecond));
    onBeginInteraction();
    if (track.overlay) {
      const targetTime = applySnap(rawTime, clipId);
      if (sourceTrack.id === track.id) onMoveClipInOverlay(clipId, track.id, targetTime);
      else onMoveClipToTrack(clipId, sourceTrack.id, track.id, targetTime);
    } else {
      const targetIndex = dropIndexAt(track.clips, rawTime, clipId);
      if (sourceTrack.id === track.id) onMoveClip(clipId, targetIndex);
      else onMoveClipToTrack(clipId, sourceTrack.id, track.id, targetIndex);
    }
    onSelectClips([clipId]);
    onEndInteraction();
    setSnapIndicatorTime(null);
  }, [
    applySnap, duration, onBeginInteraction, onEndInteraction, onMoveClip,
    onMoveClipInOverlay, onMoveClipToTrack, onSelectClips, pixelsPerSecond, tracks,
  ]);

  const density = TRACK_DENSITY[trackDensity];

  return (
    <section
      className="video-editor-timeline"
      style={{
        '--video-editor-track-h': `${density.height}px`,
        '--video-editor-text-track-h': `${density.textHeight}px`,
      } as CSSProperties}
    >
      <div className="video-editor-timeline-head">
        <div className="video-editor-timeline-actions">
          <span className="ui-timeline__title" data-tooltip={t('时间轴')} aria-label={t('时间轴')}>
            <Icon icon="lucide:panel-bottom" width={20} height={20} aria-hidden="true" />
          </span>

          <div className="video-editor-toolgroup compact" aria-label={t('历史操作')}>
            <button
              type="button" className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool video-editor-timeline-btn icon-only"
              onClick={onUndo} disabled={!canUndo} data-tooltip={t('撤销 Ctrl+Z')}
              aria-label={t('撤销')}
            >
              <Icon icon="lucide:undo-2" width={20} height={20} aria-hidden="true" />
            </button>
            <button
              type="button" className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool video-editor-timeline-btn icon-only"
              onClick={onRedo} disabled={!canRedo} data-tooltip={t('重做 Ctrl+Shift+Z')}
              aria-label={t('重做')}
            >
              <Icon icon="lucide:redo-2" width={20} height={20} aria-hidden="true" />
            </button>
          </div>

          <div className="video-editor-toolgroup" aria-label={t('片段操作')}>
            <button
              type="button" className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool video-editor-timeline-btn"
              onClick={onSplit} disabled={!canSplit} data-tooltip={t('在播放头处分割 S')}
              aria-label={t('分割')} aria-keyshortcuts="S"
            >
              <TimelineSplitIcon />
            </button>
            <button
              type="button" className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool video-editor-timeline-btn icon-only"
              onClick={() => soleSelected && onDuplicateClip(soleSelected.id)}
              disabled={!soleSelected} data-tooltip={t('复制片段 Ctrl+D')}
              aria-label={t('复制片段')}
            >
              <Icon icon="lucide:copy" width={20} height={20} aria-hidden="true" />
            </button>
            <button
              type="button" className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool video-editor-timeline-btn ui-icon-btn--danger icon-only"
              onClick={onDeleteSelected}
              disabled={!canDeleteSelected}
              data-tooltip={t('删除选中片段 Del')}
              aria-label={t('删除选中片段')}
            >
              <Icon icon="lucide:trash-2" width={20} height={20} aria-hidden="true" />
            </button>
          </div>

          <button
            type="button"
            className={`ui-icon-btn ui-icon-btn--ghost ui-timeline__tool video-editor-timeline-btn ${snapEnabled ? 'active' : ''}`}
            onClick={onToggleSnap}
            data-tooltip={t('边界吸附')}
            aria-label={t('吸附')}
            aria-pressed={snapEnabled}
          >
            <Icon icon="lucide:magnet" width={20} height={20} aria-hidden="true" />
          </button>

          <div className="video-editor-toolgroup" aria-label={t('添加轨道')}>
            <button
              type="button" className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool video-editor-timeline-btn"
              onClick={() => onAddTrack('video')} data-tooltip={t('新增叠加轨（画中画 / 贴纸）')}
              aria-label={t('叠加轨')}
            >
              <Icon icon="lucide:layers" width={20} height={20} aria-hidden="true" />
            </button>
            <button
              type="button" className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool video-editor-timeline-btn"
              onClick={() => onAddTrack('audio')} data-tooltip={t('新增音频轨')}
              aria-label={t('音频轨')}
            >
              <Icon icon="lucide:audio-lines" width={20} height={20} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="video-editor-timeline-selection" aria-live="polite">
          {soleSelected ? (
            <>
              <Icon icon="lucide:film" width={12} height={12} />
              <span className="video-editor-timeline-range">
                {soleSelected.fileName} · {getClipDuration(soleSelected).toFixed(2)}s
              </span>
            </>
          ) : selectedClipIds.length > 1 ? (
            <span className="video-editor-timeline-range">{t('已选中 {count} 个片段', { count: selectedClipIds.length })}</span>
          ) : (
            <span className="video-editor-timeline-range dim">{t('选择片段后可编辑')}</span>
          )}
        </div>

        <div className="video-editor-zoom">
          <button
            type="button"
            className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool video-editor-timeline-btn"
            onClick={cycleTrackDensity}
            data-tooltip={`${t('轨道高度：紧凑/标准/宽大')}`}
            aria-label={`${t('轨道高度：紧凑/标准/宽大')}`}
          >
            <Icon icon="lucide:rows-3" width={20} height={20} aria-hidden="true" />
          </button>
          <button
            type="button" className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool video-editor-timeline-btn"
            onClick={() => zoomBy(1 / 1.4)} data-tooltip={t('缩小')} aria-label={t('缩小')}
          >
            <Icon icon="lucide:zoom-out" width={20} height={20} aria-hidden="true" />
          </button>
          <input
            type="range"
            min={MIN_PIXELS_PER_SECOND}
            max={MAX_PIXELS_PER_SECOND}
            value={pixelsPerSecond}
            style={{
              '--range-progress': `${(
                (pixelsPerSecond - MIN_PIXELS_PER_SECOND)
                / (MAX_PIXELS_PER_SECOND - MIN_PIXELS_PER_SECOND)
              ) * 100}%`,
            } as CSSProperties}
            onChange={(event) => {
              setAutoFit(false);
              setPixelsPerSecond(Number(event.target.value));
            }}
            aria-label={t('时间轴缩放')}
            aria-valuetext={t('{value} 像素每秒', { value: Math.round(pixelsPerSecond) })}
          />
          <button
            type="button" className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool video-editor-timeline-btn"
            onClick={() => zoomBy(1.4)} data-tooltip={t('放大')} aria-label={t('放大')}
          >
            <Icon icon="lucide:zoom-in" width={20} height={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`ui-icon-btn ui-icon-btn--ghost ui-timeline__tool video-editor-timeline-btn ${autoFit ? 'active' : ''}`}
            onClick={() => setAutoFit(true)}
            data-tooltip={t('适应窗口')} aria-label={t('适应窗口')}
            aria-pressed={autoFit}
          >
            <Icon icon="lucide:move-horizontal" width={20} height={20} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className={`video-editor-timeline-body ${dragging ? 'dragging' : ''}`}>
        <div className="video-editor-track-labels">
          <div className="video-editor-ruler-spacer" />
          {displayTracks.map((track) => {
            const trackIndex = tracks.findIndex((candidate) => candidate.id === track.id);
            const compactText = isCompactTextTrack(track);
            return (
            <div
              key={track.id}
              className={[
                'video-editor-track-label',
                compactText ? 'compact-text' : '',
                track.locked ? 'is-locked' : '',
                track.hidden ? 'is-hidden' : '',
                track.muted ? 'is-muted' : '',
              ].filter(Boolean).join(' ')}
              style={{
                borderLeft: track.kind === 'video' && !track.overlay
                  ? `3px solid ${trackAccent(trackIndex)}` : undefined,
              }}
            >
              <span className="video-editor-track-icon">
                {compactText
                  ? <Icon icon="lucide:type" width={13} height={13} />
                  : TRACK_KIND_ICON[track.kind] ?? '🎞'}
              </span>
              <span className="video-editor-track-name">{t(track.name)}</span>
              <button
                type="button"
                className={`video-editor-track-flag is-mute ${track.muted ? 'active' : ''}`}
                onClick={() => toggleTrackFlag(track.id, 'muted')}
                data-tooltip={track.muted ? t('取消静音') : t('静音')}
              >M</button>
              <button
                type="button"
                className={`video-editor-track-flag is-lock ${track.locked ? 'active' : ''}`}
                onClick={() => toggleTrackFlag(track.id, 'locked')}
                data-tooltip={track.locked ? t('解锁轨道') : t('锁定轨道')}
              >
                <Icon icon={track.locked ? 'lucide:lock' : 'lucide:unlock'} width={10} height={10} />
              </button>
              <button
                type="button"
                className={`video-editor-track-flag is-visibility ${track.hidden ? 'active' : ''}`}
                onClick={() => toggleTrackFlag(track.id, 'hidden')}
                data-tooltip={track.hidden ? t('显示轨道') : t('隐藏轨道')}
              >
                <Icon icon={track.hidden ? 'lucide:eye-off' : 'lucide:eye'} width={10} height={10} />
              </button>
              {track.overlay || track.kind === 'audio' ? (
                <button
                  type="button" className="video-editor-track-flag"
                  disabled={track.locked}
                  onClick={() => onMoveTrack(track.id, 1)} data-tooltip={t('上移一层')}
                >
                  <Icon icon="lucide:chevron-up" width={10} height={10} />
                </button>
              ) : null}
            </div>
            );
          })}
        </div>

        <div className="video-editor-scroll" ref={scrollRef}>
          <div
            ref={canvasRef}
            className="video-editor-canvas"
            style={{ width: laneWidth }}
            onPointerDown={startBoxSelection}
          >
            <VideoEditorRuler
              duration={duration}
              playhead={playhead}
              pixelsPerSecond={pixelsPerSecond}
              onScrub={startScrub}
              onSeek={(time) => onPlayheadChange(applySnap(time))}
            />

            {displayTracks.map((track) => {
              const compactText = isCompactTextTrack(track);
              return (
              <div
                key={track.id}
                data-track-id={track.id}
                className={[
                  'video-editor-track-lane',
                  compactText ? 'compact-text' : '',
                  track.locked ? 'locked' : '',
                  track.hidden ? 'is-hidden' : '',
                  track.muted ? 'is-muted' : '',
                ].filter(Boolean).join(' ')}
                onDragOver={(event) => {
                  if (track.kind === 'video' && !track.locked
                    && event.dataTransfer.types.includes(MEDIA_CLIP_MIME)) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }
                }}
                onDrop={(event) => handleMediaDrop(track, event)}
              >
                {track.kind === 'video' ? track.clips.map((clip, clipIndex) => {
                  const isSelected = selectedSet.has(clip.id);
                  const isDragging = dragging?.clipId === clip.id;
                  const duration = getClipDuration(clip);
                  const transition = clip.transitionIn;
                  const hasTransition = !!transition
                    && transition.kind !== 'none'
                    && transition.duration > 0;
                  // 接缝只出现在磁吸主轨上：叠加轨可以留空，没有「前一段」可言
                  const showSeam = !track.overlay && !track.locked && clipIndex > 0 && !dragging;
                  return (
                    <Fragment key={clip.id}>
                    <div
                      data-clip-id={clip.id}
                      className={[
                        'video-editor-clip',
                        clip.kind,
                        isSelected ? 'selected' : '',
                        isDragging ? 'dragging' : '',
                      ].filter(Boolean).join(' ')}
                      style={{
                        left: clip.timelineStart * pixelsPerSecond,
                        width: Math.max(2, duration * pixelsPerSecond),
                        transform: isDragging ? `translate(${dragging.offsetPx}px, ${dragging.offsetY}px)` : undefined,
                      }}
                      onPointerDown={(event) => {
                        if (track.locked) return;
                        startClipDrag(clip, track.id, event);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!isSelected) onSelectClips([clip.id]);
                        setClipMenu({ clipId: clip.id, x: event.clientX, y: event.clientY });
                      }}
                    >
                      <TimelineThumbnails
                        thumbnails={clip.kind === 'text' ? [] : getSource(clip)?.thumbnails ?? []}
                        sourceDuration={getSource(clip)?.probe?.duration ?? 0}
                        sourceIn={clip.sourceIn}
                        duration={duration}
                        pixelsPerSecond={pixelsPerSecond}
                        still={clip.kind === 'image'}
                      />
                      {/* 转场覆盖区：从片段开头起算，宽度就是转场时长 */}
                      {hasTransition && (
                        <span
                          className={`video-editor-clip-transition ${transition.kind}`}
                          style={{ width: Math.max(4, transition.duration * pixelsPerSecond) }}
                          aria-hidden="true"
                        />
                      )}
                      {/* 片段名称叠加在缩略图上 */}
                      <span className="video-editor-clip-name">
                        {clip.kind === 'text' && <Icon icon="lucide:type" width={10} height={10} />}
                        {clip.kind === 'image' && <Icon icon="lucide:image" width={10} height={10} />}
                        {clip.fileName}
                      </span>
                      {/* hover 信息浮层：时长 */}
                      <span className="video-editor-clip-hover">
                        {duration.toFixed(1)}s
                      </span>

                      {isSelected && !track.locked && (
                        <>
                          <div
                            className="video-editor-trim-handle in"
                            onPointerDown={(event) => startTrim(clip, 'in', event)}
                            role="slider" aria-label={t('入点')}
                            aria-valuenow={clip.sourceIn} aria-valuemin={0} aria-valuemax={duration}
                            tabIndex={0}
                          />
                          <div
                            className="video-editor-trim-handle out"
                            onPointerDown={(event) => startTrim(clip, 'out', event)}
                            role="slider" aria-label={t('出点')}
                            aria-valuenow={clip.sourceOut} aria-valuemin={0} aria-valuemax={duration}
                            tabIndex={0}
                          />
                        </>
                      )}
                    </div>

                    {showSeam && (
                      <button
                        type="button"
                        className={`video-editor-seam ${hasTransition ? 'has-transition' : ''}`}
                        style={{ left: clip.timelineStart * pixelsPerSecond }}
                        aria-label={hasTransition ? t('编辑转场：{name}', { name: clip.fileName }) : t('在这里添加转场：{name}', { name: clip.fileName })}
                        data-tooltip={hasTransition
                          ? `${t(TRANSITION_LABELS[transition.kind])} ${transition.duration.toFixed(1)}s`
                          : t('添加转场')}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          onEditTransition(clip.id);
                        }}
                      >
                        <Icon
                          icon={hasTransition ? 'lucide:blend' : 'lucide:plus'}
                          width={11}
                          height={11}
                        />
                      </button>
                    )}
                    </Fragment>
                  );
                }) : track.kind === 'audio' ? track.clips.map((clip) => (
                  <div
                    key={clip.id}
                    data-clip-id={clip.id}
                    className={`video-editor-clip audio ${selectedSet.has(clip.id) ? 'selected' : ''}`}
                    style={{
                      left: clip.timelineStart * pixelsPerSecond,
                      width: Math.max(2, getClipDuration(clip) * pixelsPerSecond),
                    }}
                    onPointerDown={(event) => {
                      if (track.locked) return;
                      event.stopPropagation();
                      onSelectClips([clip.id]);
                    }}
                  >
                    <VideoEditorWaveform peaks={getSource(clip)?.waveform ?? []} />
                    <span className="video-editor-clip-name">{clip.fileName}</span>
                  </div>
                )) : (
                  <div className="video-editor-track-placeholder">{t('字幕轨二期开放')}</div>
                )}

                {track.kind === 'video' && dropIndicatorPx !== null && dragging?.targetTrackId === track.id && (
                  <div className="video-editor-drop-indicator" style={{ left: dropIndicatorPx }} />
                )}
              </div>
              );
            })}

            <div
              className="video-editor-playhead"
              style={{ left: playhead * pixelsPerSecond }}
            />
            {snapIndicatorTime !== null && (
              <div
                className="video-editor-timeline-snap-indicator"
                style={{ left: snapIndicatorTime * pixelsPerSecond }}
              />
            )}
            {selectionBox && (
              <div className="video-editor-timeline-selection-box" style={selectionBox} />
            )}
          </div>
        </div>
      </div>

      {clipMenu && (
        <div
          className="video-editor-clip-menu"
          style={{ left: clipMenu.x, top: clipMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => { onSplit(); setClipMenu(null); }} disabled={!canSplit}>
            {t('在播放头分割 · S')}
          </button>
          <button
            type="button"
            onClick={() => { onDuplicateClip(clipMenu.clipId); setClipMenu(null); }}
            disabled={clipMenuLocked}
          >
            {t('复制片段 · Ctrl D')}
          </button>
          <button
            type="button" className="danger"
            onClick={() => { onDeleteSelected(); setClipMenu(null); }}
            disabled={!canDeleteSelected}
          >
            {t('删除 · Del')}
          </button>
        </div>
      )}
    </section>
  );
}

export default memo(VideoEditorTimeline);

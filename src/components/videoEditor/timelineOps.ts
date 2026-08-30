/**
 * 时间轴片段操作 —— 纯函数，与渲染分离便于单测。
 *
 * 视频轨是「磁吸」的：片段之间不留空隙，任何增删移动后都重新压实。
 * 这与剪映主轨的行为一致，也正好匹配无损拼接导出的前提。
 */
import {
  evaluateTransitionAlpha,
  getActiveClips,
  getClipEnd,
  getClipDuration,
  relayoutSequential,
  type VideoEditorClip,
  type VideoEditorTrack,
} from '../../types/videoEditor';

/**
 * 只收集某一帧真正会访问的素材；dissolve 还需要首尾相接的前一段作底图。
 */
export function collectFrameSourceClips(
  tracks: VideoEditorTrack[],
  time: number,
): VideoEditorClip[] {
  const result: VideoEditorClip[] = [];
  const seen = new Set<string>();
  const append = (clip: VideoEditorClip) => {
    if (seen.has(clip.id)) return;
    seen.add(clip.id);
    result.push(clip);
  };

  for (const track of tracks) {
    if (track.hidden || track.kind !== 'video') continue;
    for (const clip of getActiveClips(track, time)) {
      const timeInClip = time - clip.timelineStart;
      const alpha = evaluateTransitionAlpha(clip, timeInClip);
      if (alpha < 1 && clip.transitionIn?.kind === 'dissolve') {
        const index = track.clips.indexOf(clip);
        const previous = index > 0 ? track.clips[index - 1] : undefined;
        if (previous && Math.abs(getClipEnd(previous) - clip.timelineStart) < 0.001) append(previous);
      }
      append(clip);
    }
  }
  return result;
}

/** 缩放范围：每秒对应的像素数 */
export const MIN_PIXELS_PER_SECOND = 2;
export const MAX_PIXELS_PER_SECOND = 400;

/** 吸附判定的像素容差 */
export const SNAP_TOLERANCE_PX = 6;

export interface SelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 框选矩形与片段矩形是否相交；边缘接触也视为选中。 */
export function rectsIntersect(a: SelectionRect, b: SelectionRect): boolean {
  return a.left <= b.right
    && a.right >= b.left
    && a.top <= b.bottom
    && a.bottom >= b.top;
}

/** 轨道是否锁定；未知轨道按未锁定处理。 */
export function isTrackLocked(tracks: VideoEditorTrack[], trackId: string): boolean {
  return tracks.find((track) => track.id === trackId)?.locked === true;
}

/** 片段所属轨道是否锁定；未知片段按未锁定处理。 */
export function isClipLocked(tracks: VideoEditorTrack[], clipId: string): boolean {
  return tracks.find((track) => track.clips.some((clip) => clip.id === clipId))?.locked === true;
}

/** 把片段移动到目标序号（磁吸重排） */
export function moveClipTo(
  clips: VideoEditorClip[],
  clipId: string,
  targetIndex: number,
): VideoEditorClip[] {
  const from = clips.findIndex((clip) => clip.id === clipId);
  if (from < 0) return clips;
  const bounded = Math.max(0, Math.min(clips.length - 1, targetIndex));
  if (bounded === from) return clips;

  const next = [...clips];
  const [moved] = next.splice(from, 1);
  next.splice(bounded, 0, moved);
  return relayoutSequential(next);
}

/** 复制片段并插在原片段之后 */
export function duplicateClip(
  clips: VideoEditorClip[],
  clipId: string,
): VideoEditorClip[] {
  const index = clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) return clips;

  const source = clips[index];
  const copy: VideoEditorClip = {
    ...source,
    id: `${source.id}-copy${Date.now().toString(36)}`,
  };
  const next = [...clips];
  next.splice(index + 1, 0, copy);
  return relayoutSequential(next);
}

/**
 * 按片段 ID 更新其所属轨道。
 * 主视频轨保持磁吸顺排；叠加轨和音频轨保留自由时间位置。
 */
export function updateClipInTracks(
  tracks: VideoEditorTrack[],
  clipId: string,
  update: (clip: VideoEditorClip) => VideoEditorClip,
): VideoEditorTrack[] {
  const trackIndex = tracks.findIndex((track) => track.clips.some((clip) => clip.id === clipId));
  if (trackIndex < 0) return tracks;

  const track = tracks[trackIndex];
  const nextClips = track.clips.map((clip) => (clip.id === clipId ? update(clip) : clip));
  const nextTrack = {
    ...track,
    clips: track.kind === 'video' && !track.overlay
      ? relayoutSequential(nextClips)
      : nextClips,
  };
  const next = [...tracks];
  next[trackIndex] = nextTrack;
  return next;
}

/** 在片段所属轨道复制；自由轨把副本放在源片段结束处。 */
export function duplicateClipInTracks(
  tracks: VideoEditorTrack[],
  clipId: string,
): VideoEditorTrack[] {
  const trackIndex = tracks.findIndex((track) => track.clips.some((clip) => clip.id === clipId));
  if (trackIndex < 0) return tracks;

  const track = tracks[trackIndex];
  const clipIndex = track.clips.findIndex((clip) => clip.id === clipId);
  if (clipIndex < 0) return tracks;

  if (track.kind === 'video' && !track.overlay) {
    const next = [...tracks];
    next[trackIndex] = { ...track, clips: duplicateClip(track.clips, clipId) };
    return next;
  }

  const source = track.clips[clipIndex];
  const copy: VideoEditorClip = {
    ...source,
    id: `${source.id}-copy${Date.now().toString(36)}`,
    timelineStart: source.timelineStart + getClipDuration(source),
  };
  const nextClips = [...track.clips];
  nextClips.splice(clipIndex + 1, 0, copy);
  const next = [...tracks];
  next[trackIndex] = { ...track, clips: nextClips };
  return next;
}

/** 删除若干片段并压实；至少保留一个片段 */
export function removeClips(
  clips: VideoEditorClip[],
  clipIds: Set<string> | string[],
): VideoEditorClip[] {
  const ids = clipIds instanceof Set ? clipIds : new Set(clipIds);
  const kept = clips.filter((clip) => !ids.has(clip.id));
  if (kept.length === 0) return clips;
  return relayoutSequential(kept);
}

/**
 * 跨轨删除选中片段。工程必须至少保留一个视频/图片片段；
 * 主轨删除后压实，叠加轨和音频轨保持剩余片段的时间位置。
 */
export function removeClipsFromTracks(
  tracks: VideoEditorTrack[],
  clipIds: Set<string> | string[],
): VideoEditorTrack[] {
  const ids = clipIds instanceof Set ? clipIds : new Set(clipIds);
  const remainingVideoClips = tracks
    .filter((track) => track.kind === 'video')
    .flatMap((track) => track.clips)
    .filter((clip) => !ids.has(clip.id));
  if (remainingVideoClips.length === 0) return tracks;

  let changed = false;
  const next = tracks.map((track) => {
    const kept = track.clips.filter((clip) => !ids.has(clip.id));
    if (kept.length === track.clips.length) return track;
    changed = true;
    return {
      ...track,
      clips: track.kind === 'video' && !track.overlay ? relayoutSequential(kept) : kept,
    };
  });
  return changed ? next : tracks;
}

/** 片段的所有边界时刻，用作吸附候选 */
export function clipEdges(clips: VideoEditorClip[]): number[] {
  const edges = [0];
  for (const clip of clips) {
    edges.push(clip.timelineStart);
    edges.push(clip.timelineStart + getClipDuration(clip));
  }
  return [...new Set(edges)].sort((a, b) => a - b);
}

/**
 * 把时间吸附到最近的候选点。
 * 容差以像素给出，换算成秒后比较，保证缩放变化时手感一致。
 */
export function snapTime(
  time: number,
  candidates: number[],
  pixelsPerSecond: number,
  tolerancePx = SNAP_TOLERANCE_PX,
): number {
  if (pixelsPerSecond <= 0) return time;
  const tolerance = tolerancePx / pixelsPerSecond;

  let best = time;
  let bestDistance = tolerance;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - time);
    if (distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** 把缩放夹在允许区间内 */
export function clampZoom(pixelsPerSecond: number): number {
  return Math.min(
    MAX_PIXELS_PER_SECOND,
    Math.max(MIN_PIXELS_PER_SECOND, pixelsPerSecond),
  );
}

/** 让整条时间轴恰好铺满可用宽度的缩放值 */
export function fitZoom(duration: number, availableWidth: number): number {
  if (duration <= 0 || availableWidth <= 0) return 40;
  return clampZoom(availableWidth / duration);
}

/** 拖动落点对应的插入序号：按各片段中点判断落在谁前谁后 */
export function dropIndexAt(
  clips: VideoEditorClip[],
  time: number,
  draggedClipId: string,
): number {
  const others = clips.filter((clip) => clip.id !== draggedClipId);
  let index = 0;
  for (const clip of others) {
    const middle = clip.timelineStart + getClipDuration(clip) / 2;
    if (time < middle) break;
    index += 1;
  }
  return index;
}

/** 新建一条轨道。叠加轨允许留空与自由摆放，音频轨只参与混音 */
export function createTrack(
  kind: 'video' | 'audio',
  existing: VideoEditorTrack[],
): VideoEditorTrack {
  const sameKind = existing.filter((track) => track.kind === kind);
  return {
    id: `${kind}-${Date.now().toString(36)}`,
    kind,
    name: kind === 'video' ? `叠加轨 ${sameKind.length}` : `音频轨 ${sameKind.length + 1}`,
    // 第一条视频轨是磁吸主轨，之后的都是叠加轨
    overlay: kind === 'video' && sameKind.length > 0,
    clips: [],
  };
}

/** 删除轨道；主视频轨不允许删除 */
export function removeTrack(
  tracks: VideoEditorTrack[],
  trackId: string,
): VideoEditorTrack[] {
  const mainVideo = tracks.find((track) => track.kind === 'video');
  if (mainVideo?.id === trackId) return tracks;
  return tracks.filter((track) => track.id !== trackId);
}

/**
 * 调整轨道叠加顺序。数组顺序即自下而上的图层顺序，
 * 主视频轨固定在最底层，不参与换序。
 */
export function moveTrack(
  tracks: VideoEditorTrack[],
  trackId: string,
  direction: -1 | 1,
): VideoEditorTrack[] {
  const from = tracks.findIndex((track) => track.id === trackId);
  if (from < 0) return tracks;
  const mainVideoIndex = tracks.findIndex((track) => track.kind === 'video');
  const to = from + direction;
  if (to <= mainVideoIndex || to >= tracks.length) return tracks;

  const next = [...tracks];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** 把片段放到叠加轨的指定时间点（叠加轨允许留空，不做磁吸压实） */
export function placeClipAt(
  clips: VideoEditorClip[],
  clipId: string,
  timelineStart: number,
): VideoEditorClip[] {
  return clips.map((clip) => (
    clip.id === clipId ? { ...clip, timelineStart: Math.max(0, timelineStart) } : clip
  ));
}

/** 在音量包络上增删控制点，按时间排序保持可插值 */
export function setVolumePoint(
  clip: VideoEditorClip,
  t: number,
  gain: number,
): VideoEditorClip {
  const points = [...(clip.volumePoints ?? [])];
  const existing = points.findIndex((point) => Math.abs(point.t - t) < 1e-3);
  if (existing >= 0) points[existing] = { t, gain };
  else points.push({ t, gain });
  points.sort((a, b) => a.t - b.t);
  return { ...clip, volumePoints: points };
}

export function removeVolumePoint(clip: VideoEditorClip, t: number): VideoEditorClip {
  const points = (clip.volumePoints ?? []).filter((point) => Math.abs(point.t - t) >= 1e-3);
  return { ...clip, volumePoints: points.length > 0 ? points : undefined };
}

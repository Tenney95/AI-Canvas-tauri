/**
 * 视频剪辑工程类型 — 独立窗口的时间轴工程数据结构
 *
 * 一期只使用单条视频轨 + 单个片段（裁剪），但轨道/片段结构按多轨设计，
 * 二期加入多视频轨、音频轨和字幕轨时不需要迁移已存工程。
 */

/** 工程数据结构版本；读取到更高版本时拒绝加载而不是静默降级 */
export const VIDEO_EDITOR_SCHEMA_VERSION = 1;

export type VideoEditorTrackKind = 'video' | 'audio' | 'caption';

/** 片段素材类型：图片与文字按显式停留时长参与排布 */
export type VideoEditorClipKind = 'video' | 'image' | 'text';

/** 图片片段的默认停留时长（秒） */
export const DEFAULT_IMAGE_CLIP_DURATION = 3;

export type VideoEditorTextAlign = 'left' | 'center' | 'right';

export interface VideoEditorTextStyle {
  content: string;
  /** CSS font-family；本机字体使用带引号的真实 family 名称。 */
  fontFamily: string;
  fontSize: number;
  color: string;
  fontWeight: 400 | 600 | 700;
  align: VideoEditorTextAlign;
}

export const DEFAULT_TEXT_STYLE: VideoEditorTextStyle = {
  content: '输入文字',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 64,
  color: '#ffffff',
  fontWeight: 600,
  align: 'center',
};

/** 独立剪辑窗口可选择的当前项目图片节点快照。 */
export interface VideoEditorProjectImageSource {
  nodeId: string;
  label: string;
  sourceUrl: string;
  filePath?: string;
  assetId?: string;
}

/** 转场类型；`none` 表示硬切 */
export type VideoEditorTransitionKind = 'none' | 'dissolve' | 'fade';

export interface VideoEditorTransition {
  kind: VideoEditorTransitionKind;
  /** 转场时长（秒），与前一个片段重叠的部分 */
  duration: number;
}

/**
 * 画中画 / 贴纸层的变换。
 * x/y 是画布归一化坐标（0–1，指片段中心的位置），scale 是相对「铺满画布」的倍率。
 */
export interface VideoEditorTransform {
  x: number;
  y: number;
  scale: number;
  /** 顺时针角度 */
  rotation: number;
  opacity: number;
}

export const DEFAULT_TRANSFORM: VideoEditorTransform = {
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
  opacity: 1,
};

/** 音量包络上的一个控制点；t 是片段内的相对时间（秒） */
export interface VideoEditorVolumePoint {
  t: number;
  gain: number;
}

/** 时间轴上的一个片段。所有时间单位均为秒。 */
export interface VideoEditorClip {
  id: string;
  kind: VideoEditorClipKind;
  /** 叠加层的位置与不透明度；底层主轨通常不需要 */
  transform?: VideoEditorTransform;
  /** 与前一个片段之间的转场 */
  transitionIn?: VideoEditorTransition;
  /** 片段整体音量增益，1 为原始音量 */
  volume?: number;
  /** 音量包络；为空则用 volume 恒定增益 */
  volumePoints?: VideoEditorVolumePoint[];
  /** 文字片段内容与排版；仅 kind=text 时使用 */
  textStyle?: VideoEditorTextStyle;
  /** 素材在项目 data 目录下的路径；离开本机后用 assetId 重新定位 */
  filePath?: string;
  /** 稳定资产身份，filePath 仅表示当前位置 */
  assetId?: string;
  /** 无本地文件时的回退播放地址（例如尚未落盘的远端结果） */
  sourceUrl?: string;
  fileName: string;
  /** 来源画布节点，便于回溯 */
  nodeId?: string;
  /** 片段在时间轴上的起点 */
  timelineStart: number;
  /** 取用素材的入点 / 出点 */
  sourceIn: number;
  sourceOut: number;
}

/** 片段在时间轴上占用的时长 */
export function getClipDuration(clip: VideoEditorClip): number {
  return Math.max(0, clip.sourceOut - clip.sourceIn);
}

export interface VideoEditorTrack {
  id: string;
  kind: VideoEditorTrackKind;
  name: string;
  muted?: boolean;
  locked?: boolean;
  /** 隐藏轨道：不参与合成，也不参与导出 */
  hidden?: boolean;
  /**
   * 叠加轨：片段可自由摆放、允许留空，且按数组顺序自下而上叠加。
   * 主轨（第一条视频轨）是磁吸的，片段首尾相接。
   */
  overlay?: boolean;
  /** 轨道整体音量增益 */
  volume?: number;
  clips: VideoEditorClip[];
}

/** 合成输出的画布尺寸 */
export interface VideoEditorCanvasSize {
  width: number;
  height: number;
}

/** 源素材的探测结果，打开工程时由 mediabunny 填充，不进持久化 */
export interface VideoEditorSourceProbe {
  duration: number;
  width: number;
  height: number;
  /** 是否存在可解码的视频轨；false 时编辑器只能做直通导出 */
  decodable: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
}

/** IndexedDB `videoEditorProjects` 表的记录 */
export interface VideoEditorProjectRecord {
  id: string;
  schemaVersion: number;
  /** 所属画布项目 ID */
  projectId: string;
  /** 锚点节点 ID：工程归属于它，导出结果也回写到它 */
  nodeId: string;
  /** 参与本工程的全部来源节点（多选打开时有多个） */
  nodeIds?: string[];
  name: string;
  tracks: VideoEditorTrack[];
  /** 自动化写入版本；人工作业必须保留，仓储拒绝过期窗口覆盖。 */
  automationRevision?: number;
  /** 自动化导出的默认设置；旧工程缺省时使用 1920×1080、30fps。 */
  output?: VideoEditorCanvasSize & { frameRate: number };
  createdAt: number;
  updatedAt: number;
}

/** 计算时间轴总时长（末尾片段的结束位置） */
export function computeTimelineDuration(tracks: VideoEditorTrack[]): number {
  let end = 0;
  for (const track of tracks) {
    for (const clip of track.clips) {
      const clipEnd = clip.timelineStart + Math.max(0, clip.sourceOut - clip.sourceIn);
      if (clipEnd > end) end = clipEnd;
    }
  }
  return end;
}

/** 取出主视频片段（第一条视频轨的第一个片段） */
export function getPrimaryClip(tracks: VideoEditorTrack[]): VideoEditorClip | null {
  return getVideoTrack(tracks)?.clips[0] ?? null;
}

/** 取出承载片段的视频轨 */
export function getVideoTrack(tracks: VideoEditorTrack[]): VideoEditorTrack | null {
  return tracks.find((track) => track.kind === 'video') ?? null;
}

/**
 * 把片段首尾相接地重排。
 * 一期不支持片段之间留空，任何增删/裁剪后都用它把时间轴压实。
 */
export function relayoutSequential(clips: VideoEditorClip[]): VideoEditorClip[] {
  let cursor = 0;
  return clips.map((clip) => {
    const positioned = { ...clip, timelineStart: cursor };
    cursor += getClipDuration(clip);
    return positioned;
  });
}

/** 定位时间轴某个时刻所处的片段 */
export function findClipAtTime(
  clips: VideoEditorClip[],
  time: number,
): { clip: VideoEditorClip; index: number } | null {
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const end = clip.timelineStart + getClipDuration(clip);
    // 末片段用闭区间，播放头停在结尾时仍归属它
    const withinEnd = index === clips.length - 1 ? time <= end : time < end;
    if (time >= clip.timelineStart && withinEnd) return { clip, index };
  }
  return null;
}

/** 主视频轨之外的叠加轨与音频轨 */
export function getOverlayTracks(tracks: VideoEditorTrack[]): VideoEditorTrack[] {
  const main = getVideoTrack(tracks);
  return tracks.filter((track) => track !== main && track.kind !== 'caption');
}

/** 片段在时间轴上的结束位置 */
export function getClipEnd(clip: VideoEditorClip): number {
  return clip.timelineStart + getClipDuration(clip);
}

/** 某时刻该轨道上正在显示/发声的片段 */
export function getActiveClips(
  track: VideoEditorTrack,
  time: number,
): VideoEditorClip[] {
  return track.clips.filter((clip) => time >= clip.timelineStart && time < getClipEnd(clip));
}

/**
 * 求音量包络在片段内某时刻的增益。
 *
 * 控制点之间线性插值；无控制点时退回片段的恒定 volume。
 */
export function evaluateVolume(clip: VideoEditorClip, timeInClip: number): number {
  const base = clip.volume ?? 1;
  const points = clip.volumePoints;
  if (!points || points.length === 0) return base;

  const sorted = [...points].sort((a, b) => a.t - b.t);
  if (timeInClip <= sorted[0].t) return sorted[0].gain * base;
  const last = sorted[sorted.length - 1];
  if (timeInClip >= last.t) return last.gain * base;

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const from = sorted[index];
    const to = sorted[index + 1];
    if (timeInClip >= from.t && timeInClip <= to.t) {
      const span = to.t - from.t;
      const ratio = span <= 0 ? 0 : (timeInClip - from.t) / span;
      return (from.gain + (to.gain - from.gain) * ratio) * base;
    }
  }
  return base;
}

/**
 * 求转场造成的不透明度。
 *
 * 返回 0–1；`dissolve` 与前一段交叠淡入，`fade` 从黑场淡入。
 */
export function evaluateTransitionAlpha(clip: VideoEditorClip, timeInClip: number): number {
  const transition = clip.transitionIn;
  if (!transition || transition.kind === 'none' || transition.duration <= 0) return 1;
  if (timeInClip >= transition.duration) return 1;
  return Math.max(0, Math.min(1, timeInClip / transition.duration));
}

/** 片段素材的关键参数，用于判断能否直通拼接 */
export interface ClipSourceProfile {
  codec: string | null;
  width: number;
  height: number;
}

/**
 * 素材是否异构。
 *
 * 直通拼接要求所有片段共用同一套解码参数，编码或分辨率不一致就必须走合成
 * 归一到同一张画布。传入的 profile 为空（尚未探测完）时不作数。
 */
export function hasMixedSources(profiles: (ClipSourceProfile | null | undefined)[]): boolean {
  const known = profiles.filter((profile): profile is ClipSourceProfile => (
    !!profile && profile.width > 0 && profile.height > 0
  ));
  if (known.length < 2) return false;

  const [first] = known;
  return known.some((profile) => (
    profile.codec !== first.codec
    || profile.width !== first.width
    || profile.height !== first.height
  ));
}

/** 时间轴是否需要走合成渲染（而非无损直通） */
export function needsCompositing(tracks: VideoEditorTrack[]): boolean {
  const visible = tracks.filter((track) => !track.hidden);
  const videoTracks = visible.filter((track) => track.kind === 'video');
  if (videoTracks.length > 1) return true;
  // 独立音轨需要混入输出，不能只直通主视频而丢失配音。
  if (visible.some((track) => track.kind === 'audio' && !track.muted && track.clips.length > 0)) return true;

  return visible.some((track) => track.clips.some((clip) => (
    clip.kind === 'image'
    || clip.kind === 'text'
    || (!!clip.transitionIn && clip.transitionIn.kind !== 'none' && clip.transitionIn.duration > 0)
    || (!!clip.transform && (
      clip.transform.x !== DEFAULT_TRANSFORM.x
      || clip.transform.y !== DEFAULT_TRANSFORM.y
      || clip.transform.scale !== DEFAULT_TRANSFORM.scale
      || clip.transform.rotation !== DEFAULT_TRANSFORM.rotation
      || clip.transform.opacity !== DEFAULT_TRANSFORM.opacity
    ))
  )));
}

/** 分割点距片段两端的最小间隔，防止切出零长片段 */
const MIN_SPLIT_MARGIN = 0.05;

/**
 * 在时间轴的某个时刻把片段一分为二。
 * 返回 null 表示该位置不可分割（不在任何片段内，或太靠近片段边界）。
 */
export function splitClipsAt(
  clips: VideoEditorClip[],
  time: number,
): VideoEditorClip[] | null {
  const hit = findClipAtTime(clips, time);
  if (!hit) return null;

  const { clip, index } = hit;
  const offsetInClip = time - clip.timelineStart;
  const duration = getClipDuration(clip);
  if (offsetInClip < MIN_SPLIT_MARGIN || duration - offsetInClip < MIN_SPLIT_MARGIN) {
    return null;
  }

  const splitSourceTime = clip.sourceIn + offsetInClip;
  const head: VideoEditorClip = { ...clip, sourceOut: splitSourceTime };
  const tail: VideoEditorClip = {
    ...clip,
    id: `${clip.id}-b${Date.now().toString(36)}`,
    sourceIn: splitSourceTime,
  };

  const next = [...clips];
  next.splice(index, 1, head, tail);
  return relayoutSequential(next);
}

import { VideoEditorControlError } from "../types/videoEditorControl";
/** 当前项目的剪辑控制：共享工程模型、来源绑定、原子版本比较；不打开窗口。 */
import { useAppStore } from '../store/useAppStore';
import { generateId } from '../store/store.utils';
import {
  buildVideoEditorProjectId, compareAndSaveVideoEditorProject,
  getVideoEditorProject, listVideoEditorProjectsByProject,
} from './indexedDb/videoEditorRepository';
import { listAppWindows } from './mcp/mcpUiRuntimeService';
import { buildClip, buildDialogueTrack, buildShotClip, isEditableMediaNode, resolveShotlistTimelineRows } from './videoEditorService';
import { isShotRowBlank } from '../types/shotlist';
import {
  computeTimelineDuration, DEFAULT_TEXT_STYLE, relayoutSequential, VIDEO_EDITOR_SCHEMA_VERSION,
  type VideoEditorClip, type VideoEditorProjectRecord, type VideoEditorTrack,
} from '../types/videoEditor';
import type { VideoEditorControlContext, VideoEditorCreateInput, VideoEditorTrackInput, VideoEditorUpdateInput } from '../types/videoEditorControl';

export const DEFAULT_VIDEO_EDITOR_OUTPUT = { width: 1920, height: 1080, frameRate: 30 };
export const MAX_VIDEO_EDITOR_SECONDS = 300;

export function assertVideoEditorContext(context: VideoEditorControlContext): void {
  if (context.signal.aborted) throw new VideoEditorControlError('剪辑操作已取消');
  const store = useAppStore.getState();
  if (store.currentProjectId !== context.projectId
    || (context.baseRevision !== undefined && context.baseRevision !== store.getCurrentRevision())) {
    throw new VideoEditorControlError('项目或画布已变化，请重新读取后操作');
  }
}

async function assertEditorWindowClosed(): Promise<void> {
  if (typeof window === 'undefined') return;
  if ((await listAppWindows()).some((item) => item.label === 'video-editor')) {
    throw new VideoEditorControlError('视频剪辑窗口正在打开，请先保存并关闭该窗口，再通过 MCP 编辑或导出');
  }
}

export async function videoEditorVersion(record: VideoEditorProjectRecord): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function readControlledEditor(context: VideoEditorControlContext, editorId: string) {
  assertVideoEditorContext(context);
  const record = await getVideoEditorProject(editorId);
  assertVideoEditorContext(context);
  if (!record || record.projectId !== context.projectId) throw new VideoEditorControlError('当前项目中没有该剪辑工程');
  if (record.tracks.length > 8 || record.tracks.reduce((count, track) => count + track.clips.length, 0) > 120) {
    throw new VideoEditorControlError('该工程超过 MCP 的 8 轨 / 120 片段上限，请在剪辑窗口分拆');
  }
  return record;
}

/** 明确列举字段，媒体位置仅留在宿主，不返回 MCP 或审计。 */
export async function describeControlledEditor(record: VideoEditorProjectRecord) {
  return {
    editorId: record.id, name: record.name, anchorNodeId: record.nodeId,
    version: await videoEditorVersion(record), output: record.output ?? DEFAULT_VIDEO_EDITOR_OUTPUT,
    duration: computeTimelineDuration(record.tracks),
    tracks: record.tracks.map((track) => ({
      id: track.id, kind: track.kind, name: track.name, muted: track.muted, hidden: track.hidden,
      locked: track.locked, overlay: track.overlay, volume: track.volume,
      clips: track.clips.map((clip) => ({
        id: clip.id, kind: clip.kind, nodeId: clip.nodeId, timelineStart: clip.timelineStart,
        sourceIn: clip.sourceIn, sourceOut: clip.sourceOut, transform: clip.transform,
        transitionIn: clip.transitionIn, volume: clip.volume, volumePoints: clip.volumePoints,
        textStyle: clip.textStyle,
      })),
    })),
  };
}

export async function listControlledEditors(context: VideoEditorControlContext) {
  assertVideoEditorContext(context);
  const records = await listVideoEditorProjectsByProject(context.projectId);
  assertVideoEditorContext(context);
  const editors = await Promise.all(records.slice(0, 50).map(async (record) => ({
    editorId: record.id, name: record.name, version: await videoEditorVersion(record),
    duration: computeTimelineDuration(record.tracks), anchorNodeId: record.nodeId,
  })));
  return { editors, total: records.length, truncated: records.length > editors.length };
}

export function bindVideoEditorMedia(nodeId: string, kind: VideoEditorClip['kind'], audio = false) {
  const node = useAppStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  const expected = audio ? ['ai-audio', 'source-audio']
    : kind === 'image' ? ['ai-image', 'source-image'] : ['ai-video', 'source-video'];
  if (!node || !expected.includes(node.type ?? '')) throw new VideoEditorControlError('素材节点不存在或类型与轨道不符');
  const sourceUrl = audio ? node.data.audioUrl : kind === 'image' ? node.data.imageUrl : node.data.videoUrl;
  if (!node.data.filePath && !sourceUrl) throw new VideoEditorControlError('素材节点还没有生成结果');
  return { nodeId, filePath: node.data.filePath, assetId: node.data.assetId, sourceUrl, fileName: node.data.label || '素材' };
}

function finite(value: number, min: number, max: number, label: string) {
  if (!Number.isFinite(value) || value < min || value > max) throw new VideoEditorControlError(`${label}超出允许范围`);
}

export function validateVideoEditorOutput(output: NonNullable<VideoEditorProjectRecord['output']>) {
  if (![output.width, output.height, output.frameRate].every(Number.isInteger)
    || output.width % 2 || output.height % 2) throw new VideoEditorControlError('输出宽高须为偶数，帧率须为整数');
  finite(output.width, 64, 1920, '输出宽度');
  finite(output.height, 64, 1920, '输出高度');
  if (output.width * output.height > 1920 * 1080) throw new VideoEditorControlError('输出画幅上限为 1920×1080 或同像素数竖屏');
  finite(output.frameRate, 1, 60, '输出帧率');
}

export function bindVideoEditorTracks(tracks: VideoEditorTrackInput[]): VideoEditorTrack[] {
  if (!tracks.length || tracks.length > 8 || tracks[0].kind !== 'video' || tracks[0].overlay) {
    throw new VideoEditorControlError('需要 1 至 8 条轨道，首轨必须是主视频轨');
  }
  const ids = new Set<string>();
  let count = 0;
  const claim = (id: string) => {
    if (!id.trim() || ids.has(id)) throw new VideoEditorControlError('轨道和片段 ID 必须非空且全局唯一');
    ids.add(id);
  };
  const bound = tracks.map((track, trackIndex): VideoEditorTrack => {
    claim(track.id);
    if (!['video', 'audio'].includes(track.kind)) throw new VideoEditorControlError('字幕使用 video 叠加轨与 text 片段');
    if (track.volume !== undefined) finite(track.volume, 0, 4, '轨道音量');
    const clips = track.clips.map((clip): VideoEditorClip => {
      claim(clip.id);
      if (++count > 120) throw new VideoEditorControlError('单工程最多 120 个片段');
      finite(clip.sourceIn, 0, MAX_VIDEO_EDITOR_SECONDS * 24, '素材入点');
      finite(clip.sourceOut, clip.sourceIn + 0.001, clip.sourceIn + MAX_VIDEO_EDITOR_SECONDS, '素材出点');
      finite(clip.timelineStart, 0, MAX_VIDEO_EDITOR_SECONDS, '时间轴起点');
      const duration = clip.sourceOut - clip.sourceIn;
      if (clip.volume !== undefined) finite(clip.volume, 0, 4, '片段音量');
      if (clip.volumePoints) {
        if (clip.volumePoints.length > 40) throw new VideoEditorControlError('音量包络最多 40 个控制点');
        let previous = -1;
        for (const point of clip.volumePoints) {
          finite(point.t, 0, duration, '包络时间'); finite(point.gain, 0, 4, '包络增益');
          if (point.t <= previous) throw new VideoEditorControlError('音量包络时间须严格递增');
          previous = point.t;
        }
      }
      if (clip.transitionIn) {
        if (!['none', 'fade', 'dissolve'].includes(clip.transitionIn.kind)) throw new VideoEditorControlError('转场类型不受支持');
        finite(clip.transitionIn.duration, 0, Math.min(5, duration), '转场时长');
      }
      if (clip.transform) {
        finite(clip.transform.x, -2, 3, '横向位置'); finite(clip.transform.y, -2, 3, '纵向位置');
        finite(clip.transform.scale, 0.01, 5, '缩放'); finite(clip.transform.rotation, -360, 360, '旋转');
        finite(clip.transform.opacity, 0, 1, '不透明度');
      }
      if (clip.kind === 'text') {
        if (track.kind !== 'video' || clip.nodeId) throw new VideoEditorControlError('文字只允许放在视频轨且不绑定媒体节点');
        if (!clip.textStyle?.content.trim() || clip.textStyle.content.length > 2000) throw new VideoEditorControlError('文字内容须为 1 至 2000 字');
        const style = { ...DEFAULT_TEXT_STYLE, ...clip.textStyle };
        finite(style.fontSize, 8, 240, '字号');
        if (!/^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(style.color)) throw new VideoEditorControlError('文字颜色须为十六进制颜色');
        return { ...clip, fileName: '文字', textStyle: style };
      }
      if (!clip.nodeId || (track.kind === 'audio' && clip.kind !== 'video')) throw new VideoEditorControlError('媒体片段必须绑定当前画布节点；音频轨使用 video 片段合同');
      return { ...clip, ...bindVideoEditorMedia(clip.nodeId, clip.kind, track.kind === 'audio') };
    });
    return { ...track, overlay: trackIndex > 0, clips: trackIndex === 0 ? relayoutSequential(clips) : clips };
  });
  if (computeTimelineDuration(bound) > MAX_VIDEO_EDITOR_SECONDS) throw new VideoEditorControlError('时间轴总时长不能超过 300 秒');
  return bound;
}

export async function createControlledEditor(context: VideoEditorControlContext, input: VideoEditorCreateInput) {
  assertVideoEditorContext(context);
  await assertEditorWindowClosed();
  assertVideoEditorContext(context);
  const store = useAppStore.getState();
  if (!!input.nodeIds === !!input.shotlistNodeId) throw new VideoEditorControlError('nodeIds 与 shotlistNodeId 必须且只能提供一个');
  let tracks: VideoEditorTrack[];
  let anchorId: string;
  if (input.shotlistNodeId) {
    const node = store.nodes.find((candidate) => candidate.id === input.shotlistNodeId);
    if (node?.type !== 'ai-shotlist') throw new VideoEditorControlError('请选择当前项目的镜头表节点');
    anchorId = node.id;
    const rows = resolveShotlistTimelineRows(node.data.shotlistRows ?? [], store.nodes).filter((row) => !isShotRowBlank(row));
    if (!rows.length) throw new VideoEditorControlError('镜头表没有可用镜头');
    const clips = relayoutSequential(rows.map(buildShotClip));
    const captions = input.includeDialogueCaptions ? buildDialogueTrack(rows, clips) : null;
    tracks = [{ id: 'video-1', kind: 'video', name: '主视频轨', clips }, ...(captions ? [captions] : [])];
  } else {
    if (!input.nodeIds?.length || input.nodeIds.length > 64 || new Set(input.nodeIds).size !== input.nodeIds.length) {
      throw new VideoEditorControlError('请提供 1 至 64 个不重复的素材节点');
    }
    const nodes = input.nodeIds.map((id) => store.nodes.find((node) => node.id === id));
    if (nodes.some((node) => !isEditableMediaNode(node))) throw new VideoEditorControlError('所有来源必须是已有结果的视频或图片节点');
    anchorId = input.nodeIds[0];
    const clips = nodes.map((node, index) => buildClip(node!, index));
    // 视频的真实时长在异步媒体探测时确定，不能把未知的 0 秒当作有效剪辑。
    const { probeControlledNode } = await import('./videoEditorInspectionService');
    for (const clip of clips) {
      if (clip.kind === 'video') clip.sourceOut = (await probeControlledNode(context, clip.nodeId!)).duration;
    }
    tracks = [{ id: 'video-1', kind: 'video', name: '主视频轨', clips: relayoutSequential(clips) }];
  }
  // 使用独立锚点后缀，创建操作不覆盖节点已有的人工作业工程。
  const id = buildVideoEditorProjectId(context.projectId, `mcp-${generateId()}`);
  const now = Date.now();
  const record: VideoEditorProjectRecord = {
    id, projectId: context.projectId, nodeId: anchorId, schemaVersion: VIDEO_EDITOR_SCHEMA_VERSION,
    name: input.name?.trim() || 'MCP 剪辑', tracks: bindVideoEditorTracks(tracks),
    nodeIds: [...new Set(tracks.flatMap((track) => track.clips.flatMap((clip) => clip.nodeId ? [clip.nodeId] : [])))],
    createdAt: now, updatedAt: now, automationRevision: 1, output: { ...DEFAULT_VIDEO_EDITOR_OUTPUT },
  };
  assertVideoEditorContext(context);
  await compareAndSaveVideoEditorProject(record, null);
  return describeControlledEditor(record);
}

export async function updateControlledEditor(context: VideoEditorControlContext, input: VideoEditorUpdateInput) {
  await assertEditorWindowClosed();
  const current = await readControlledEditor(context, input.editorId);
  if (await videoEditorVersion(current) !== input.expectedVersion) throw new VideoEditorControlError('剪辑工程版本已变化，请重新读取后提交');
  if (input.output) validateVideoEditorOutput(input.output);
  const tracks = input.tracks ? bindVideoEditorTracks(input.tracks) : current.tracks;
  const next: VideoEditorProjectRecord = {
    ...current, name: input.name?.trim() || current.name, tracks,
    output: input.output ? { ...input.output } : current.output,
    nodeIds: [...new Set(tracks.flatMap((track) => track.clips.flatMap((clip) => clip.nodeId ? [clip.nodeId] : [])))],
    automationRevision: (current.automationRevision ?? 0) + 1, updatedAt: Math.max(Date.now(), current.updatedAt + 1),
  };
  assertVideoEditorContext(context);
  await compareAndSaveVideoEditorProject(next, current);
  return describeControlledEditor(next);
}

export { assertEditorWindowClosed };

/**
 * 剪辑编排 — 主窗口侧：从视频/图片节点建立或复用剪辑工程并打开独立窗口
 *
 * 工程先落 IndexedDB 再开窗，编辑器按工程 ID 自行取回；
 * 两个窗口同源共享同一个库，因此不需要额外的素材交接通道。
 */
import type { BaseNodeData, NodeType, ShotRow } from '../types';
import {
  SHOTLIST_TRANSITION_DURATION,
  buildShotPlaceholderText,
  isShotRowBlank,
  resolveShotDuration,
  resolveShotTransitionKind,
} from '../types/shotlist';
import {
  DEFAULT_IMAGE_CLIP_DURATION,
  DEFAULT_TEXT_STYLE,
  DEFAULT_TRANSFORM,
  VIDEO_EDITOR_SCHEMA_VERSION,
  relayoutSequential,
  type VideoEditorClip,
  type VideoEditorProjectRecord,
  type VideoEditorTrack,
} from '../types/videoEditor';
import {
  buildVideoEditorProjectId,
  getVideoEditorProject,
  saveVideoEditorProject,
} from './indexedDbService';
import { openVideoEditorWindow } from './videoEditorWindowService';

/** 可进入剪辑时间轴的节点类型 */
const VIDEO_NODE_TYPES: NodeType[] = ['ai-video', 'source-video'];
const IMAGE_NODE_TYPES: NodeType[] = ['ai-image', 'source-image'];

export interface EditableMediaNode {
  id: string;
  type?: string;
  data: BaseNodeData;
}

/** 判断节点是否具备可编辑的视频素材 */
export function canEditNodeVideo(data: BaseNodeData | undefined): boolean {
  if (!data) return false;
  return !!(data.filePath || data.videoUrl);
}

/** 判断节点能否作为剪辑素材（视频必需，图片可选参与） */
export function isEditableMediaNode(node: EditableMediaNode | undefined): boolean {
  if (!node?.data) return false;
  const type = node.type as NodeType | undefined;
  if (type && VIDEO_NODE_TYPES.includes(type)) {
    return !!(node.data.filePath || node.data.videoUrl);
  }
  if (type && IMAGE_NODE_TYPES.includes(type)) {
    return !!(node.data.filePath || node.data.imageUrl);
  }
  return false;
}

/** 至少要有一个视频素材，纯图片序列一期不支持导出 */
export function hasVideoSource(nodes: EditableMediaNode[]): boolean {
  return nodes.some((node) => {
    const type = node.type as NodeType | undefined;
    return !!type && VIDEO_NODE_TYPES.includes(type);
  });
}

function buildClip(node: EditableMediaNode, index: number): VideoEditorClip {
  const type = node.type as NodeType | undefined;
  const isImage = !!type && IMAGE_NODE_TYPES.includes(type);
  const data = node.data;
  const fallbackName = (typeof data.label === 'string' && data.label) || '素材';

  return {
    id: `clip-${index + 1}-${node.id}`,
    kind: isImage ? 'image' : 'video',
    filePath: data.filePath,
    assetId: data.assetId,
    sourceUrl: isImage ? data.imageUrl : data.videoUrl,
    fileName: (typeof data.fileName === 'string' && data.fileName) || fallbackName,
    nodeId: node.id,
    timelineStart: 0,
    sourceIn: 0,
    // 图片按固定停留时长；视频时长未知时置 0，由编辑器探测后回填
    sourceOut: isImage
      ? DEFAULT_IMAGE_CLIP_DURATION
      : (typeof data.videoDuration === 'number' && data.videoDuration > 0
        ? data.videoDuration
        : 0),
  };
}

/**
 * 打开一批素材节点对应的剪辑工程。
 *
 * 工程锚定在第一个节点上：ID 由它决定，导出结果也回写到它。
 * 已有工程则直接复用（保留上次的裁剪与分割结果），不会被重新打开覆盖。
 */
export async function openVideoEditorForNodes(params: {
  projectId: string;
  nodes: EditableMediaNode[];
  theme?: 'dark' | 'light';
}): Promise<void> {
  const { projectId, nodes, theme } = params;
  if (!projectId) throw new Error('请先打开一个项目再编辑视频');

  const usable = nodes.filter(isEditableMediaNode);
  if (usable.length === 0) throw new Error('选中的节点没有可编辑的素材');
  if (!hasVideoSource(usable)) throw new Error('至少需要选中一个视频节点');

  const anchor = usable[0];
  const id = buildVideoEditorProjectId(projectId, anchor.id);
  const existing = await getVideoEditorProject(id);

  if (existing) {
    // 锚点节点可能已有旧工程（例如之前单独打开过）。这次选择里多出来的素材
    // 要追加进时间轴，否则用户多选了却只看到旧的那一个片段；
    // 追加而非重建，是为了保住已有的裁剪与分割结果。
    const known = new Set(existing.nodeIds ?? [existing.nodeId]);
    const missing = usable.filter((node) => !known.has(node.id));

    if (missing.length > 0) {
      const videoTrack = existing.tracks.find((track) => track.kind === 'video');
      const offset = videoTrack?.clips.length ?? 0;
      const appended = [
        ...(videoTrack?.clips ?? []),
        ...missing.map((node, index) => buildClip(node, offset + index)),
      ];
      await saveVideoEditorProject({
        ...existing,
        nodeIds: [...(existing.nodeIds ?? [existing.nodeId]), ...missing.map((node) => node.id)],
        tracks: existing.tracks.map((track) => (
          track.kind === 'video' ? { ...track, clips: relayoutSequential(appended) } : track
        )),
        updatedAt: Date.now(),
      });
    }
  } else {
    const now = Date.now();
    const anchorName = (typeof anchor.data.label === 'string' && anchor.data.label)
      || (typeof anchor.data.fileName === 'string' && anchor.data.fileName)
      || '未命名剪辑';
    const name = usable.length > 1 ? `${anchorName} 等 ${usable.length} 个素材` : anchorName;

    const record: VideoEditorProjectRecord = {
      id,
      schemaVersion: VIDEO_EDITOR_SCHEMA_VERSION,
      projectId,
      nodeId: anchor.id,
      nodeIds: usable.map((node) => node.id),
      name,
      tracks: [{
        id: 'video-1',
        kind: 'video',
        name: '视频轨 1',
        clips: relayoutSequential(usable.map(buildClip)),
      }],
      createdAt: now,
      updatedAt: now,
    };
    await saveVideoEditorProject(record);
  }

  await openVideoEditorWindow({ instanceId: id, projectId, nodeId: anchor.id, theme });
}

// ── 分镜表 → 时间轴 ──

/** 未填画面的行在时间轴上显示成占位文字，字号比默认标题小一档 */
const SHOT_PLACEHOLDER_FONT_SIZE = 40;

/** 推送读取实时媒体；只有来源节点已删除时才使用绑定快照。 */
export function resolveShotlistTimelineRows(rows: ShotRow[], nodes: EditableMediaNode[]): ShotRow[] {
  return rows.map((row) => {
    if (!row.frame) return row;
    const source = nodes.find((node) => node.id === row.frame!.nodeId);
    if (!source) return row;
    if (!isEditableMediaNode(source)) return { ...row, frame: null };
    const kind = VIDEO_NODE_TYPES.includes(source.type as NodeType) ? 'video' : 'image';
    return { ...row, frame: {
      nodeId: source.id, kind,
      url: kind === 'video' ? source.data.videoUrl : source.data.imageUrl,
      filePath: source.data.filePath, assetId: source.data.assetId,
      sourceDuration: kind === 'video' && typeof source.data.videoDuration === 'number'
        && Number.isFinite(source.data.videoDuration) && source.data.videoDuration > 0 ? source.data.videoDuration : undefined,
    } };
  });
}

/** 对白沿用已排好的镜头起止；保留无对白镜头的空档，不再次压紧字幕。 */
function buildDialogueTrack(rows: ShotRow[], clips: VideoEditorClip[]): VideoEditorTrack | null {
  const captions = rows.flatMap<VideoEditorClip>((row, index) => {
    const content = row.dialogue?.trim();
    if (!content) return [];
    return [{
      id: `dialogue-${row.id}`, kind: 'text', fileName: `对白 ${row.shotNo || index + 1}`,
      timelineStart: clips[index].timelineStart, sourceIn: 0, sourceOut: clips[index].sourceOut,
      textStyle: { ...DEFAULT_TEXT_STYLE, content, fontSize: SHOT_PLACEHOLDER_FONT_SIZE },
      transform: { ...DEFAULT_TRANSFORM, y: 0.88 },
    }];
  });
  // 编辑器的文字叠加轨参与预览和导出；预留的 caption 类型目前不参与合成。
  return captions.length ? { id: 'shotlist-dialogue', kind: 'video', name: '对白字幕', overlay: true, clips: captions } : null;
}

/** 只取明确关联到这张表的音频来源；供异步推送比较成果是否变化。 */
export function resolveShotlistVoiceoverNodes(nodeId: string, nodes: EditableMediaNode[]): EditableMediaNode[] {
  return nodes.filter((node) => ['ai-audio', 'source-audio'].includes(node.type ?? '')
    && node.data.shotlistProductionSource?.nodeId === nodeId && node.data.shotlistProductionSource.kind === 'voiceover')
    .map((node) => ({ id: node.id, type: node.type, data: {
      type: node.data.type, label: node.data.label, audioUrl: node.data.audioUrl, filePath: node.data.filePath,
      assetId: node.data.assetId, shotlistProductionSource: node.data.shotlistProductionSource,
    } }));
}

function buildVoiceoverTrack(rows: ShotRow[], clips: VideoEditorClip[], nodeId: string, nodes: EditableMediaNode[]): VideoEditorTrack | null {
  const sources = resolveShotlistVoiceoverNodes(nodeId, nodes);
  const audioClips = rows.flatMap<VideoEditorClip>((row, index) => {
    const matches = sources.filter((node) => node.data.shotlistProductionSource?.rowId === row.id);
    if (matches.length > 1) throw new Error('同一镜头有多个配音节点，请先核对来源');
    const source = matches[0];
    if (!source || (!source.data.audioUrl && !source.data.filePath)) return [];
    return [{ id: `voiceover-${row.id}`, kind: 'video', fileName: `配音 ${row.shotNo || index + 1}`,
      nodeId: source.id, filePath: source.data.filePath, assetId: source.data.assetId, sourceUrl: source.data.audioUrl,
      timelineStart: clips[index].timelineStart, sourceIn: 0, sourceOut: clips[index].sourceOut,
    }];
  });
  return audioClips.length ? { id: 'shotlist-voiceover', kind: 'audio', name: '镜头配音', overlay: true, clips: audioClips } : null;
}

/**
 * 按分镜表的一行构造时间轴片段。
 *
 * 与 buildClip 的区别有两处，也正是分镜表必须走独立入口的原因：
 * 时长取自表里的「时长」栏而非图片固定停留时长，且没绑画面的行也要出片段。
 */
function buildShotClip(row: ShotRow, index: number): VideoEditorClip {
  const duration = resolveShotDuration(row);
  const transitionKind = resolveShotTransitionKind(row.transition);
  // 首个片段之前没有可叠的画面，转场无从谈起
  const transitionIn = index > 0 && transitionKind !== 'none'
    ? { kind: transitionKind, duration: Math.min(SHOTLIST_TRANSITION_DURATION, duration) }
    : undefined;
  const base = {
    id: `clip-${index + 1}-${row.id}`,
    transitionIn,
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: duration,
  };
  const frame = row.frame;

  if (!frame) {
    return {
      ...base,
      kind: 'text',
      fileName: `镜 ${row.shotNo || index + 1}`,
      textStyle: {
        ...DEFAULT_TEXT_STYLE,
        content: buildShotPlaceholderText(row),
        fontSize: SHOT_PLACEHOLDER_FONT_SIZE,
      },
    };
  }

  return {
    ...base,
    kind: frame.kind,
    filePath: frame.filePath,
    assetId: frame.assetId,
    sourceUrl: frame.url,
    fileName: `镜 ${row.shotNo || index + 1}`,
    nodeId: frame.nodeId,
  };
}

/** 分镜表节点是否已经推送过时间轴；调用方据此在覆盖前征求确认 */
export async function hasShotlistTimeline(projectId: string, nodeId: string): Promise<boolean> {
  if (!projectId) return false;
  return !!(await getVideoEditorProject(buildVideoEditorProjectId(projectId, nodeId)));
}

/**
 * 把整张分镜表推送成时间轴并打开剪辑窗口。
 *
 * 语义上分镜表是时间轴的源：每次推送都按当前表重建轨道，
 * 而不像 openVideoEditorForNodes 那样增量追加——表改了却只追加会两边对不上。
 * 因此覆盖既有工程前必须由调用方确认。
 */
export async function openVideoEditorForShotlist(params: {
  projectId: string;
  nodeId: string;
  label: string;
  rows: ShotRow[];
  includeDialogueCaptions?: boolean;
  /** 省略表示不附带配音；只使用带明确镜头来源的已就绪音频。 */
  voiceoverNodes?: EditableMediaNode[];
  /** 调用方的项目/来源校验，在异步读取后、开窗前复核。 */
  assertCurrent?: () => void;
  theme?: 'dark' | 'light';
}): Promise<void> {
  const { projectId, nodeId, label, rows, theme, assertCurrent } = params;
  if (!projectId) throw new Error('请先打开一个项目再推送分镜表');
  assertCurrent?.();

  // 全空的行既没画面也没文字，推过去只会是一段空白，直接跳过
  const usable = rows.filter((row) => !isShotRowBlank(row));
  if (usable.length === 0) throw new Error('分镜表还没有可推送的镜头');

  const id = buildVideoEditorProjectId(projectId, nodeId);
  const existing = await getVideoEditorProject(id);
  assertCurrent?.();
  const now = Date.now();
  const clips = relayoutSequential(usable.map(buildShotClip));
  const dialogueTrack = params.includeDialogueCaptions ? buildDialogueTrack(usable, clips) : null;
  const voiceoverTrack = params.voiceoverNodes ? buildVoiceoverTrack(usable, clips, nodeId, params.voiceoverNodes) : null;
  if (params.voiceoverNodes && !voiceoverTrack) throw new Error('没有可用配音，请先完成语音生成或取消附带配音');
  const sourceNodeIds = [...new Set([...usable
    .map((row) => row.frame?.nodeId)
    .filter((value): value is string => !!value), ...(voiceoverTrack?.clips.map((clip) => clip.nodeId!) ?? [])])];

  await saveVideoEditorProject({
    id,
    schemaVersion: VIDEO_EDITOR_SCHEMA_VERSION,
    projectId,
    nodeId,
    nodeIds: sourceNodeIds,
    name: label || '分镜表',
    tracks: [{ id: 'video-1', kind: 'video', name: '视频轨 1', clips }, ...(dialogueTrack ? [dialogueTrack] : []), ...(voiceoverTrack ? [voiceoverTrack] : [])],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  } satisfies VideoEditorProjectRecord);

  assertCurrent?.();
  await openVideoEditorWindow({ instanceId: id, projectId, nodeId, theme });
}

/**
 * 圆环快捷入口：不带素材直接开剪辑窗口。
 * 编辑器只按 ID 取工程，没有记录会报「未找到剪辑工程」，所以这里先补一条空轨道；
 * 已存在就直接复用，避免把上次的剪辑清空。
 */
export async function openVideoEditorBlank(params: {
  projectId: string;
  theme?: 'dark' | 'light';
}): Promise<void> {
  const { projectId, theme } = params;
  if (!projectId) throw new Error('请先打开一个项目再进入视频编辑器');

  const nodeId = 'canvas-quick';
  const id = buildVideoEditorProjectId(projectId, nodeId);
  if (!(await getVideoEditorProject(id))) {
    const now = Date.now();
    await saveVideoEditorProject({
      id,
      schemaVersion: VIDEO_EDITOR_SCHEMA_VERSION,
      projectId,
      nodeId,
      nodeIds: [],
      name: '快速剪辑',
      tracks: [{ id: 'video-1', kind: 'video', name: '视频轨 1', clips: [] }],
      createdAt: now,
      updatedAt: now,
    } satisfies VideoEditorProjectRecord);
  }

  await openVideoEditorWindow({ instanceId: id, projectId, nodeId, theme });
}

/** 单节点入口，保留给只右键一个视频节点的场景 */
export async function openVideoEditorForNode(params: {
  projectId: string;
  nodeId: string;
  data: BaseNodeData;
  type?: string;
  theme?: 'dark' | 'light';
}): Promise<void> {
  if (!canEditNodeVideo(params.data)) throw new Error('该节点没有可编辑的视频素材');
  await openVideoEditorForNodes({
    projectId: params.projectId,
    nodes: [{ id: params.nodeId, type: params.type ?? 'ai-video', data: params.data }],
    theme: params.theme,
  });
}

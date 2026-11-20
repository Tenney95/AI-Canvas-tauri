/**
 * 分镜表（ai-shotlist）类型 — 一行一个镜头，逐行描述景别、运镜、内容、台词与时长
 *
 * 与「宫格分镜」（ai-storyboard）无关：那个是把一张图切成宫格再拖出裁片，
 * 这里是前期分镜稿本身：「画面」引用制作参考，「生成视频」独立引用成片。
 * 时间轴只读取生成视频列；未就绪的行跳过，不用参考画面或文字占位。
 */
import type { VideoEditorTransitionKind } from './videoEditor';
import type { VideoFrameAnalysisData } from './index';
import type { CameraGenerationSettings } from './index';
import type { CinematographySettings } from './cinematography';
import { buildGenerationCameraPrompt, resolveCinematography } from '../utils/cinematography';

/** 分镜最初使用的本集正文快照；引用节点，避免再次复制正文。 */
export interface ShotlistScriptSource {
  episodeId: string;
  nodeId: string;
}

/** 制作节点到镜头的稳定来源；不持有原文或媒体路径。 */
export type ShotlistProductionKind = 'voiceover' | 'video' | 'director';
export interface ShotlistProductionSource {
  nodeId: string;
  rowId: string;
  kind: ShotlistProductionKind;
  /** 自动跟随分镜；在视频节点单独修改时长后切换为 manual。 */
  durationSync?: 'auto' | 'manual';
}

/** 生成素材使用完整整数秒，保留原分镜的小数剪辑时长。 */
export function resolveShotVideoDuration(duration: number | undefined): number | undefined {
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && duration <= 3600
    ? Math.ceil(duration) : undefined;
}

/** 分镜表的全部列 */
export type ShotlistColumnKey =
  | 'shotNo'
  | 'frame'
  | 'video'
  | 'shotSize'
  | 'camera'
  | 'cinematography'
  | 'content'
  | 'dialogue'
  | 'audio'
  | 'transition'
  | 'duration'
  | 'note';

/** 常驻列：不可隐藏，隐藏后表就不成其为分镜表了 */
export const SHOTLIST_PINNED_COLUMNS: ShotlistColumnKey[] = [
  'shotNo', 'frame', 'video', 'shotSize', 'content', 'duration',
];

/** 可选列：由节点头部的「列」菜单勾选显隐 */
export const SHOTLIST_OPTIONAL_COLUMNS: ShotlistColumnKey[] = [
  'camera', 'cinematography', 'dialogue', 'audio', 'transition', 'note',
];

/** 列的固定排布顺序，与传统分镜表从左到右一致 */
export const SHOTLIST_COLUMN_ORDER: ShotlistColumnKey[] = [
  'shotNo', 'frame', 'video', 'shotSize', 'camera', 'cinematography', 'content',
  'dialogue', 'audio', 'transition', 'duration', 'note',
];

export const SHOTLIST_COLUMN_LABELS: Record<ShotlistColumnKey, string> = {
  shotNo: '镜号',
  frame: '画面',
  video: '生成视频',
  shotSize: '景别',
  camera: '运镜',
  cinematography: '摄影',
  content: '内容',
  dialogue: '台词',
  audio: '音效/音乐',
  transition: '转场',
  duration: '时长',
  note: '备注',
};

/** 新建分镜表时默认展开的可选列 */
export const SHOTLIST_DEFAULT_COLUMNS: ShotlistColumnKey[] = [
  ...SHOTLIST_PINNED_COLUMNS, 'camera', 'cinematography', 'dialogue',
];

/** 景别候选值；下拉给建议，仍允许自由输入 */
export const SHOT_SIZE_OPTIONS = ['远景', '全景', '中景', '近景', '特写', '大特写'] as const;

/** 运镜候选值；实拍里「手持跟拍+轻微晃动」这类描述靠自由输入补 */
export const SHOT_CAMERA_OPTIONS = [
  '固定', '推', '拉', '摇', '移', '跟', '升', '降', '手持', '环绕',
] as const;

/**
 * 转场候选值 → 视频编辑器转场类型。
 * 编辑器目前只实现了硬切/叠化/淡入淡出，其余写法一律按硬切推送，
 * 但原文照样留在表里，不因为编辑器不支持就被抹掉。
 */
export const SHOT_TRANSITION_OPTIONS: { label: string; kind: VideoEditorTransitionKind }[] = [
  { label: '切', kind: 'none' },
  { label: '叠化', kind: 'dissolve' },
  { label: '淡入淡出', kind: 'fade' },
];

/** 推送到时间线时，转场与前一片段的重叠时长（秒） */
export const SHOTLIST_TRANSITION_DURATION = 0.5;

/** 未填时长的镜头按此秒数推送 */
export const DEFAULT_SHOT_DURATION = 3;

/**
 * 「画面」格绑定的画布节点。
 *
 * url / filePath / assetId 只是绑定当时的快照：画面渲染以画布上那个节点的
 * 实时数据为准，源节点重新生成后画面自动跟着变，不需要任何回写同步。
 * 快照只在源节点已经不在画布上时兜底，让表里的画面不至于凭空消失。
 */
export interface ShotFrameBinding {
  nodeId: string;
  kind: 'image' | 'video';
  url?: string;
  filePath?: string;
  assetId?: string;
  /** 项目保存时保留的相对路径，加载后同时补回运行期 filePath。 */
  relativePath?: string;
  /** 视频源时长，供「时长」栏对齐真实片长 */
  sourceDuration?: number;
}

/** 生成视频列独立于参考画面；源节点为权威，快照仅在来源删除后兜底。 */
export type ShotVideoBinding = Omit<ShotFrameBinding, 'kind'> & { kind: 'video' };

/** 分镜表的一行 = 一个镜头 */
export interface ShotRow {
  id: string;
  /** 拉片来源与修订信息，随分镜行持久化。 */
  frameAnalysis?: VideoFrameAnalysisData;
  /** 镜号，允许 3a / 3b 这类插入镜，所以是字符串 */
  shotNo: string;
  frame?: ShotFrameBinding | null;
  /** undefined 允许首次自动回填；null 表示用户已明确解绑。 */
  video?: ShotVideoBinding | null;
  shotSize?: string;
  camera?: string;
  cinematography?: CinematographySettings;
  content?: string;
  dialogue?: string;
  audio?: string;
  transition?: string;
  /** 时长（秒） */
  duration?: number;
  note?: string;
}

/** 助手可编辑的镜头字段；媒体绑定只接受真实来源节点。 */
export type ShotRowEdit = Partial<Pick<ShotRow,
  'id' | 'shotNo' | 'shotSize' | 'camera' | 'content' | 'dialogue' | 'audio' | 'transition' | 'duration' | 'note'
>>;

/** 可以放进画面格的节点类型 */
export const SHOTLIST_FRAME_SOURCE_TYPES = ['ai-image', 'source-image', 'ai-video', 'source-video'];

/** 画面格能读到的最小节点形状（避免 types 层依赖 react-flow） */
interface FrameSourceNodeLike {
  id: string;
  type?: string;
  data: Record<string, unknown>;
}

/** 一个可选画面：本表的输入素材或由本表派生的视频；未完成时显示占位。 */
export interface ShotFrameCandidate {
  nodeId: string;
  label: string;
  kind: 'image' | 'video';
  url?: string;
}

/** 节点当前可用作画面的素材；视频优先取封面帧 */
export function readShotFrameSource(node: FrameSourceNodeLike): { kind: 'image' | 'video'; url?: string } {
  const isVideo = node.type === 'ai-video' || node.type === 'source-video';
  const url = (isVideo
    ? (node.data.thumbnailUrl || node.data.videoUrl)
    : (node.data.imageUrl || node.data.thumbnailUrl)) as string | undefined;
  return { kind: isVideo ? 'video' : 'image', url };
}

/**
 * 本表的输入素材和按镜头来源关联的视频，供画面格直接挑选。
 * 还没出图的节点也列出来（url 为空显示占位），否则用户会以为连线没生效。
 */
export function collectShotFrameCandidates(
  nodes: FrameSourceNodeLike[],
  edges: { source: string; target: string }[],
  shotlistId: string,
): ShotFrameCandidate[] {
  const sourceIds = new Set(edges.filter((edge) => edge.target === shotlistId).map((edge) => edge.source));
  return nodes
    .filter((node) => {
      const production = node.data.shotlistProductionSource as ShotlistProductionSource | undefined;
      return SHOTLIST_FRAME_SOURCE_TYPES.includes(node.type ?? '')
        && (sourceIds.has(node.id) || (production?.kind === 'video' && production.nodeId === shotlistId));
    })
    .map((node) => ({
      nodeId: node.id,
      label: (node.data.label as string) || (node.data.fileName as string) || node.id,
      ...readShotFrameSource(node),
    }));
}

/** 这一行默认拿去生成画面的提示词：景别/运镜当修饰，内容当主体 */
export function buildShotFramePrompt(row: ShotRow, defaults?: CinematographySettings): string {
  const content = [row.shotSize?.trim(), row.camera?.trim(), row.content?.trim()]
    .filter(Boolean)
    .join('，');
  if (!content) return '';
  const camera = buildGenerationCameraPrompt(undefined, resolveCinematography(defaults, row.cinematography));
  return camera ? `${content}\n摄影设定：${camera}` : content;
}

/** 精确镜头引用以稳定行 ID 定位，镜号只用于显示。 */
export function buildShotlistRowMentionId(nodeId: string, rowId: string): string {
  return `${nodeId}/shot/${encodeURIComponent(rowId)}`;
}

export function parseShotlistRowMentionId(referenceId: string): { nodeId: string; rowId: string } | null {
  const match = /^([^{}:]+)\/shot\/([^/{}:]+)$/.exec(referenceId);
  if (!match) return null;
  try {
    const rowId = decodeURIComponent(match[2]);
    return rowId ? { nodeId: match[1], rowId } : null;
  } catch { return null; }
}

/** 单镜视频描述保留字段语义和对白原文，交给各模型的既有编译入口。 */
export function formatShotVideoPrompt(row: ShotRow, defaults?: CinematographySettings, overrides?: CameraGenerationSettings): string {
  const camera = buildGenerationCameraPrompt(overrides, resolveCinematography(defaults, row.cinematography));
  return [
    row.shotNo?.trim() ? `镜头：${row.shotNo.trim()}` : '',
    row.shotSize?.trim() ? `景别：${row.shotSize.trim()}` : '',
    row.camera?.trim() ? `运镜：${row.camera.trim()}` : '',
    camera ? `摄影设定：${camera}` : '',
    row.content?.trim() ? `画面与动作：\n${row.content.trim()}` : '',
    row.dialogue?.trim() ? `角色对白（按说话人顺序演绎，保留原文，与画面动作配合）：\n${row.dialogue.trim()}` : '',
    row.audio?.trim() ? `音效/音乐：${row.audio.trim()}` : '',
    typeof row.duration === 'number' && Number.isFinite(row.duration) && row.duration > 0
      ? `镜头时长：${row.duration}秒` : '',
    row.note?.trim() ? `补充要求：${row.note.trim()}` : '',
  ].filter(Boolean).join('\n');
}

/** 该行是否既无创作文字，也无参考画面或生成视频。 */
export function isShotRowBlank(row: ShotRow): boolean {
  if (row.frame || row.video) return false;
  const texts = [row.shotSize, row.camera, row.content, row.dialogue, row.audio, row.transition, row.note];
  return texts.every((text) => !text?.trim());
}

/** 该行只有文字、没有媒体引用；保留供既有展示调用，时间轴不生成文字占位。 */
export function isShotRowTextOnly(row: ShotRow): boolean {
  return !row.frame && !row.video && !isShotRowBlank(row);
}

/**
 * 兼容既有调用的镜头占位文案，拼成「1 · 全景 · 警察松动警戒线」。
 * 当前时间轴只读取生成视频，不再用这段文字创建占位片段。
 */
export function buildShotPlaceholderText(row: ShotRow): string {
  const head = [row.shotNo?.trim(), row.shotSize?.trim(), row.camera?.trim()].filter(Boolean).join(' · ');
  const body = row.content?.trim() || row.dialogue?.trim() || '';
  if (head && body) return `${head}\n${body}`;
  return head || body || '未命名镜头';
}

/**
 * 单行拼成一句话：`镜号 · 景别 · 运镜 · 内容 / 台词 · N″`。
 * @ 引用整张表时逐行拼给模型，空字段直接略过，不留下「· ·」这种空档。
 */
export function formatShotRowBrief(row: ShotRow, defaults?: CinematographySettings, overrides?: CameraGenerationSettings): string {
  const body = [row.content?.trim(), row.dialogue?.trim()].filter(Boolean).join(' / ');
  const head = [row.shotNo?.trim(), row.shotSize?.trim(), row.camera?.trim(), body].filter(Boolean).join(' · ');
  const duration = Number(resolveShotDuration(row).toFixed(1));
  const camera = buildGenerationCameraPrompt(overrides, resolveCinematography(defaults, row.cinematography));
  return `${head ? `${head} · ${duration}″` : `${duration}″`}${camera ? ` · 摄影设定：${camera}` : ''}`;
}

/** 转场文案 → 编辑器转场类型；无法识别的写法按硬切处理 */
export function resolveShotTransitionKind(transition: string | undefined): VideoEditorTransitionKind {
  const text = transition?.trim();
  if (!text) return 'none';
  return SHOT_TRANSITION_OPTIONS.find((option) => option.label === text)?.kind ?? 'none';
}

/** 单行推送时占用的时长；未填时长的视频行回退到探测到的源时长 */
export function resolveShotDuration(row: ShotRow): number {
  if (typeof row.duration === 'number' && row.duration > 0) return row.duration;
  if ((row.video?.sourceDuration ?? 0) > 0) return row.video!.sourceDuration!;
  return DEFAULT_SHOT_DURATION;
}

/** 全表总时长（秒），表头用它显示「共 N 镜 · 总时长 M″」 */
export function computeShotlistDuration(rows: ShotRow[]): number {
  return rows.reduce((sum, row) => (isShotRowBlank(row) ? sum : sum + resolveShotDuration(row)), 0);
}

/** 建一行空镜头；镜号按序号给，用户可改 */
export function createShotRow(id: string, shotNo: string | number): ShotRow {
  return {
    id,
    shotNo: String(shotNo),
    frame: null,
    shotSize: '',
    camera: '',
    content: '',
    dialogue: '',
    audio: '',
    transition: '',
    duration: DEFAULT_SHOT_DURATION,
    note: '',
  };
}

/**
 * 当前该显示哪些列：常驻列恒在其中，存量数据没存过配置就回落到默认列。
 * 表头、单元格与 AI 出题共用这一份，免得三处各算各的。
 */
export function resolveShotlistColumns(columns: ShotlistColumnKey[] | undefined): ShotlistColumnKey[] {
  const enabled = new Set<ShotlistColumnKey>([
    ...SHOTLIST_PINNED_COLUMNS,
    ...(columns ?? SHOTLIST_DEFAULT_COLUMNS),
  ]);
  return SHOTLIST_COLUMN_ORDER.filter((key) => enabled.has(key));
}

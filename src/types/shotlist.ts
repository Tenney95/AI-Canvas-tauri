/**
 * 分镜表（ai-shotlist）类型 — 一行一个镜头，逐行描述景别、运镜、内容、台词与时长
 *
 * 与「宫格分镜」（ai-storyboard）无关：那个是把一张图切成宫格再拖出裁片，
 * 这里是前期分镜稿本身，每行的「画面」绑定画布上一个图像/视频节点，
 * 整表可以按行推送成视频编辑器的时间轴片段。
 */
import type { VideoEditorTransitionKind } from './videoEditor';

/** 分镜表的全部列 */
export type ShotlistColumnKey =
  | 'shotNo'
  | 'frame'
  | 'shotSize'
  | 'camera'
  | 'content'
  | 'dialogue'
  | 'audio'
  | 'transition'
  | 'duration'
  | 'note';

/** 常驻列：不可隐藏，隐藏后表就不成其为分镜表了 */
export const SHOTLIST_PINNED_COLUMNS: ShotlistColumnKey[] = [
  'shotNo', 'frame', 'shotSize', 'content', 'duration',
];

/** 可选列：由节点头部的「列」菜单勾选显隐 */
export const SHOTLIST_OPTIONAL_COLUMNS: ShotlistColumnKey[] = [
  'camera', 'dialogue', 'audio', 'transition', 'note',
];

/** 列的固定排布顺序，与传统分镜表从左到右一致 */
export const SHOTLIST_COLUMN_ORDER: ShotlistColumnKey[] = [
  'shotNo', 'frame', 'shotSize', 'camera', 'content',
  'dialogue', 'audio', 'transition', 'duration', 'note',
];

export const SHOTLIST_COLUMN_LABELS: Record<ShotlistColumnKey, string> = {
  shotNo: '镜号',
  frame: '画面',
  shotSize: '景别',
  camera: '运镜',
  content: '内容',
  dialogue: '台词',
  audio: '音效/音乐',
  transition: '转场',
  duration: '时长',
  note: '备注',
};

/** 新建分镜表时默认展开的可选列 */
export const SHOTLIST_DEFAULT_COLUMNS: ShotlistColumnKey[] = [
  ...SHOTLIST_PINNED_COLUMNS, 'camera', 'dialogue',
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
 * url / filePath / assetId 只是绑定当时的快照：渲染和推送一律以画布上那个节点的
 * 实时数据为准，源节点重新生成后画面自动跟着变，不需要任何回写同步。
 * 快照只在源节点已经不在画布上时兜底，让表里的画面不至于凭空消失。
 */
export interface ShotFrameBinding {
  nodeId: string;
  kind: 'image' | 'video';
  url?: string;
  filePath?: string;
  assetId?: string;
  /** 视频源时长，供「时长」栏对齐真实片长 */
  sourceDuration?: number;
}

/** 分镜表的一行 = 一个镜头 */
export interface ShotRow {
  id: string;
  /** 镜号，允许 3a / 3b 这类插入镜，所以是字符串 */
  shotNo: string;
  frame?: ShotFrameBinding | null;
  shotSize?: string;
  camera?: string;
  content?: string;
  dialogue?: string;
  audio?: string;
  transition?: string;
  /** 时长（秒） */
  duration?: number;
  note?: string;
}

/** 可以放进画面格的节点类型 */
export const SHOTLIST_FRAME_SOURCE_TYPES = ['ai-image', 'source-image', 'ai-video', 'source-video'];

/** 画面格能读到的最小节点形状（避免 types 层依赖 react-flow） */
interface FrameSourceNodeLike {
  id: string;
  type?: string;
  data: Record<string, unknown>;
}

/** 一个可选画面：连到这张表、且已经出图/出片的节点 */
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
 * 连线进这张表的图像/视频节点，供画面格直接挑选。
 * 还没出图的节点也列出来（url 为空显示占位），否则用户会以为连线没生效。
 */
export function collectShotFrameCandidates(
  nodes: FrameSourceNodeLike[],
  edges: { source: string; target: string }[],
  shotlistId: string,
): ShotFrameCandidate[] {
  const sourceIds = new Set(edges.filter((edge) => edge.target === shotlistId).map((edge) => edge.source));
  return nodes
    .filter((node) => sourceIds.has(node.id) && SHOTLIST_FRAME_SOURCE_TYPES.includes(node.type ?? ''))
    .map((node) => ({
      nodeId: node.id,
      label: (node.data.label as string) || (node.data.fileName as string) || node.id,
      ...readShotFrameSource(node),
    }));
}

/** 这一行默认拿去生成画面的提示词：景别/运镜当修饰，内容当主体 */
export function buildShotFramePrompt(row: ShotRow): string {
  return [row.shotSize?.trim(), row.camera?.trim(), row.content?.trim()]
    .filter(Boolean)
    .join('，');
}

/** 该行是否连一个字都没有 —— 推时间线时整行跳过 */
export function isShotRowBlank(row: ShotRow): boolean {
  if (row.frame) return false;
  const texts = [row.shotSize, row.camera, row.content, row.dialogue, row.audio, row.transition, row.note];
  return texts.every((text) => !text?.trim());
}

/** 该行有文字但没画面 —— 推时间线时生成文字占位片段 */
export function isShotRowTextOnly(row: ShotRow): boolean {
  return !row.frame && !isShotRowBlank(row);
}

/**
 * 无画面行推到时间线时显示的文字。
 * 拼成「1 · 全景 · 警察松动警戒线」，让导演在预览里看得出这儿缺哪个镜头。
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
export function formatShotRowBrief(row: ShotRow): string {
  const body = [row.content?.trim(), row.dialogue?.trim()].filter(Boolean).join(' / ');
  const head = [row.shotNo?.trim(), row.shotSize?.trim(), row.camera?.trim(), body].filter(Boolean).join(' · ');
  const duration = Number(resolveShotDuration(row).toFixed(1));
  return head ? `${head} · ${duration}″` : `${duration}″`;
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
  if (row.frame?.kind === 'video' && (row.frame.sourceDuration ?? 0) > 0) return row.frame.sourceDuration!;
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

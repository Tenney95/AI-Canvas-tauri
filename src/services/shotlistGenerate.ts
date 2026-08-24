/**
 * 分镜表 AI 生成 —— 按表上当前显示的列向模型出题，再把回答解析回表格行。
 *
 * 只问开着的列：模型不该去填用户已经隐藏的栏目，回来的字段也就永远对得上表头。
 * 「画面」列存的是画布节点引用，文本模型给不了，一律排除在外——画面仍由
 * 表里每格的「选择画面 / AI 生成」自己补。
 */
import { generateId } from '../store/store.utils';
import { extractJsonObject } from './dramaAssetExtract';
import type { ShotlistColumnKey, ShotRow } from '../types/shotlist';
import {
  DEFAULT_SHOT_DURATION,
  SHOT_CAMERA_OPTIONS,
  SHOT_SIZE_OPTIONS,
  SHOT_TRANSITION_OPTIONS,
  SHOTLIST_COLUMN_LABELS,
  createShotRow,
} from '../types/shotlist';

/** 除画面外的列 = 模型能填的字段 */
type ShotTextColumn = Exclude<ShotlistColumnKey, 'frame'>;

/** 每列告诉模型该填什么。键名直接用列 key，返回的 JSON 就能对号入座 */
const COLUMN_SPECS: Record<ShotTextColumn, string> = {
  shotNo: '字符串，从 "1" 起按顺序编号，插入镜可写 "3a"',
  shotSize: `从 ${SHOT_SIZE_OPTIONS.join(' / ')} 中选一个`,
  camera: `从 ${SHOT_CAMERA_OPTIONS.join(' / ')} 中选一个，可再补一句细节，如「手持，轻微晃动」`,
  content: '一句话说清这一镜拍到什么：主体、动作、环境、光线',
  dialogue: '本镜的台词或字幕原文，没有就给空字符串',
  audio: '音效或配乐，没有就给空字符串',
  transition: `与下一镜的转场，从 ${SHOT_TRANSITION_OPTIONS.map((option) => option.label).join(' / ')} 中选一个`,
  duration: `数字，单位秒；拿不准就给 ${DEFAULT_SHOT_DURATION}`,
  note: '拍摄提示或情绪注记，没有就给空字符串',
};

/**
 * 把用户的需求包成「按列出题」的指令。
 * 提示词原文整段带进去（其中的 @ 记号仍由 promptResolver 解析成剧本、角色和参考图）。
 */
export function buildShotlistGenerationPrompt(request: string, columns: ShotlistColumnKey[]): string {
  const fields = columns
    .filter((key): key is ShotTextColumn => key !== 'frame')
    .map((key) => `- ${key}（${SHOTLIST_COLUMN_LABELS[key]}）：${COLUMN_SPECS[key]}`);
  return [
    '你是分镜师。按下面的需求拆出一份逐镜清单。',
    '',
    '需求：',
    request.trim(),
    '',
    '每个镜头是一个 JSON 对象，字段只有这些（多写的字段会被丢弃）：',
    ...fields,
    '',
    '只输出下面结构的 JSON，不要解释、不要前后缀：',
    '{"shots": [{ ... }, { ... }]}',
  ].join('\n');
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function toShotRow(raw: Record<string, unknown>, index: number): ShotRow {
  const duration = Number(raw.duration);
  return {
    ...createShotRow(`shot-${generateId()}`, asText(raw.shotNo) || index + 1),
    shotSize: asText(raw.shotSize),
    camera: asText(raw.camera),
    content: asText(raw.content),
    dialogue: asText(raw.dialogue),
    audio: asText(raw.audio),
    // 编辑器认不出的转场写法照样留在表里，推送时按硬切处理
    transition: asText(raw.transition),
    note: asText(raw.note),
    duration: Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_SHOT_DURATION,
  };
}

/** 解析模型回答；拿不到 shots 数组就抛，交给调用方提示重试 */
export function parseShotlistRows(text: string): ShotRow[] {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(text);
  } catch {
    throw new Error('模型没有返回 JSON，分镜没能解析出来');
  }
  const shots = (parsed as { shots?: unknown } | null)?.shots;
  if (!Array.isArray(shots)) throw new Error('模型返回的 JSON 里没有 shots 数组');
  const rows = shots
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(toShotRow);
  if (rows.length === 0) throw new Error('模型没有返回任何镜头');
  return rows;
}

/**
 * 重生成时按镜号把已绑定的画面接回去。
 * 一句「再来一版」不该把配好的图全丢了；镜号对不上的行才真的从零开始。
 */
export function carryOverShotFrames(previous: ShotRow[], generated: ShotRow[]): ShotRow[] {
  const frames = new Map(
    previous.filter((row) => row.frame).map((row) => [row.shotNo.trim(), row.frame!]),
  );
  if (frames.size === 0) return generated;
  return generated.map((row) => {
    const frame = frames.get(row.shotNo.trim());
    return frame ? { ...row, frame } : row;
  });
}

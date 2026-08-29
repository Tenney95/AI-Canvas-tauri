/**
 * 吉祥物的动画片段与播放器。
 *
 * 原实现是「业务状态 → 一个表情」的直接映射，表达不出「先睁大再回正」这种
 * 有过程的状态。片段（clip）把一段动作描述成若干关键帧：每个关键帧只是
 * 声明「到这个时刻想要哪个表情」，中间怎么过去由弹簧决定 —— 这既保留了
 * Grok 那种弹性过渡，又让片段定义保持成一张静态表。
 *
 * 播放器本身是无副作用的纯函数集合：状态放进调用方持有的对象里，
 * 推进与采样分开，方便单独验证优先级和时序规则。
 */
import {
  EXPRESSIONS,
  flattenExpression,
  type ExpressionId,
  type MascotExpression,
} from './mascotExpressions';

export type MascotClipId =
  // 生命周期
  | 'sleep' | 'wake' | 'rest' | 'remind'
  // 反应
  | 'excited' | 'surprised' | 'suspicious' | 'angry' | 'sleepy';

export interface ClipKeyframe {
  /** 相对片段开始的时刻（秒）。 */
  at: number;
  /** 该时刻想要的表情。 */
  expression: ExpressionId;
}

export interface MascotClip {
  id: MascotClipId;
  /**
   * 片段总时长（秒）。Infinity 表示常驻，直到被更高优先级的片段打断。
   */
  duration: number;
  /**
   * 优先级。数值越大越容易打断别人。
   * 常驻的睡眠 / 休息 / 困倦给低优先级，一次性反应给高优先级。
   */
  priority: number;
  keyframes: readonly ClipKeyframe[];
}

/**
 * 片段库。时长参考原版登录页约 1.2 秒一次状态轮换的节奏，
 * 一次性反应控制在 1~1.6 秒，读起来是一个完整的「反应—回落」。
 */
export const MASCOT_CLIPS: Record<MascotClipId, MascotClip> = {
  /* ── 生命周期 ── */

  // 睡眠：常驻，直到被醒来或提醒打断
  sleep: {
    id: 'sleep',
    duration: Number.POSITIVE_INFINITY,
    priority: 60,
    keyframes: [{ at: 0, expression: 'sleep' }],
  },

  // 醒来：先睁到最大，再落回常态
  wake: {
    id: 'wake',
    duration: 1.1,
    priority: 70,
    keyframes: [
      { at: 0, expression: 'wake' },
      { at: 0.45, expression: 'neutral' },
    ],
  },

  // 休息：常驻的放松半闭眼
  rest: {
    id: 'rest',
    duration: Number.POSITIVE_INFINITY,
    priority: 40,
    keyframes: [{ at: 0, expression: 'rest' }],
  },

  // 提醒：睁大并上抬吸引注意，然后回正
  remind: {
    id: 'remind',
    duration: 1.4,
    priority: 80,
    keyframes: [
      { at: 0, expression: 'remind' },
      { at: 0.7, expression: 'neutral' },
    ],
  },

  /* ── 反应 ── */

  excited: {
    id: 'excited',
    duration: 1.2,
    priority: 90,
    keyframes: [
      { at: 0, expression: 'excited' },
      { at: 0.6, expression: 'neutral' },
    ],
  },

  surprised: {
    id: 'surprised',
    duration: 1.0,
    priority: 85,
    keyframes: [
      { at: 0, expression: 'surprised' },
      { at: 0.55, expression: 'neutral' },
    ],
  },

  // 怀疑维持得久一些：太快收回去就读不出「打量」的意味
  suspicious: {
    id: 'suspicious',
    duration: 1.6,
    priority: 75,
    keyframes: [
      { at: 0, expression: 'suspicious' },
      { at: 1.0, expression: 'neutral' },
    ],
  },

  angry: {
    id: 'angry',
    duration: 1.5,
    priority: 88,
    keyframes: [
      { at: 0, expression: 'angry' },
      { at: 0.9, expression: 'neutral' },
    ],
  },

  // 困倦：常驻，比休息更重，是「快要睡着」的中间态
  sleepy: {
    id: 'sleepy',
    duration: Number.POSITIVE_INFINITY,
    priority: 45,
    keyframes: [{ at: 0, expression: 'sleepy' }],
  },
};

/** 播放器的运行时状态。由调用方持有，函数原地修改。 */
export interface ClipPlaybackState {
  clipId: MascotClipId | null;
  /** 已经播放的秒数。 */
  elapsed: number;
  priority: number;
}

export function createClipState(): ClipPlaybackState {
  return { clipId: null, elapsed: 0, priority: 0 };
}

/** 片段是否已经播完。常驻片段永远不会播完。 */
export function isClipFinished(state: ClipPlaybackState): boolean {
  if (!state.clipId) return true;
  return state.elapsed >= MASCOT_CLIPS[state.clipId].duration;
}

/**
 * 是否允许播放该片段。
 *
 * 规则：没有正在播放的片段时一定允许；否则只有优先级严格更高才能打断。
 * 严格更高而不是大于等于，是为了避免同优先级的片段互相顶掉造成抖动。
 */
export function canPlayClip(state: ClipPlaybackState, clipId: MascotClipId): boolean {
  const next = MASCOT_CLIPS[clipId];
  if (!state.clipId || isClipFinished(state)) return true;
  return next.priority > state.priority;
}

/** 开始播放片段。已经播完的旧片段会被无条件顶掉。 */
export function startClip(state: ClipPlaybackState, clipId: MascotClipId): void {
  state.clipId = clipId;
  state.elapsed = 0;
  state.priority = MASCOT_CLIPS[clipId].priority;
}

/** 请求播放。返回是否真的播了，便于调用方决定是否要额外反馈。 */
export function requestClip(state: ClipPlaybackState, clipId: MascotClipId): boolean {
  if (!canPlayClip(state, clipId)) return false;
  startClip(state, clipId);
  return true;
}

export function stopClip(state: ClipPlaybackState): void {
  state.clipId = null;
  state.elapsed = 0;
  state.priority = 0;
}

/** 推进播放进度。片段播完后清空，让调用方回落到基础表情。 */
export function advanceClip(state: ClipPlaybackState, dt: number): void {
  if (!state.clipId) return;
  state.elapsed += dt;
  if (state.elapsed >= MASCOT_CLIPS[state.clipId].duration) stopClip(state);
}

/**
 * 取当前时刻的目标表情。
 *
 * 关键帧之间是阶梯切换而非插值：平滑由弹簧负责，这里只负责「现在想要什么」。
 * 片段已结束时回落到 fallback（通常是业务状态对应的表情）。
 */
export function sampleClipExpression(
  state: ClipPlaybackState,
  fallback: ExpressionId,
): MascotExpression {
  if (!state.clipId) return EXPRESSIONS[fallback];
  const clip = MASCOT_CLIPS[state.clipId];

  let active = clip.keyframes[0];
  for (const keyframe of clip.keyframes) {
    if (keyframe.at <= state.elapsed) active = keyframe;
  }
  return EXPRESSIONS[active.expression];
}

/** 把当前目标表情展平进参数向量，供弹簧推进使用。 */
export function sampleClipVector(
  state: ClipPlaybackState,
  fallback: ExpressionId,
  target: Float32Array,
): Float32Array {
  return flattenExpression(target, sampleClipExpression(state, fallback));
}

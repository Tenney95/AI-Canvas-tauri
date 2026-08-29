/**
 * 吉祥物的表情参数表。
 *
 * 复刻 Grok 那套表情库的关键障碍是：原实现把眼睛压成 scale/rotate 三个数字，
 * 表达不出弯月眼、横线眼这类形状。现在眼型由 SDF 的五个连续参数决定，
 * 每个表情就是一组参数，表情之间可以直接逐参数插值。
 *
 * 为了配合弹簧推进，表情被展平成一个定长的参数向量：
 * 每只眼睛 7 个分量（SDF 五参数 + 整体旋转 + 纵向位移），两只眼共 14 个，
 * 末尾 3 个是身体姿态。这样「推进表情」退化成推进一个 Float32Array，
 * 不需要为每种新增表情改动渲染循环。
 */
import type { EyeShapeParams } from './mascotEyeShader';

/** 单只眼睛的完整姿态：SDF 形状 + 在球面上的摆放。 */
export interface EyeExpression extends EyeShapeParams {
  /** 整体旋转（弧度）。正值逆时针。 */
  rotationZ: number;
  /** 纵向位移，正值向上。 */
  offsetY: number;
}

/** 身体姿态。这些是持续量，会与呼吸、蹦跳等叠加。 */
export interface BodyPose {
  /** 纵向缩放，1 为基准。压扁靠它，横向由渲染层按等体积换算。 */
  squashY: number;
  /** 竖直位移，正值向上。 */
  lift: number;
  /** 头部侧倾（弧度），正值向右歪。 */
  tilt: number;
}

export interface MascotExpression {
  /** 索引 0 为画面左眼，1 为右眼。左右分开才能做出 < ○ > 这类异形眼。 */
  eyes: readonly [EyeExpression, EyeExpression];
  body: BodyPose;
}

/** 单只眼睛占的参数个数：open/curve/slant/width/height/rotationZ/offsetY。 */
export const EYE_STRIDE = 7;
/** 身体参数在向量中的起始下标。 */
export const BODY_OFFSET = EYE_STRIDE * 2;
/** 表情向量的总长度。 */
export const EXPRESSION_LENGTH = BODY_OFFSET + 3;

export type ExpressionId =
  // 由业务状态直接驱动的常驻表情
  | 'neutral' | 'thinking' | 'success' | 'error'
  // 生命周期
  | 'sleepy' | 'sleep' | 'wake' | 'rest' | 'remind'
  // 反应
  | 'excited' | 'surprised' | 'suspicious' | 'angry';

/** 展平表情，便于弹簧逐分量推进。写入调用方提供的数组，避免每帧分配。 */
export function flattenExpression(
  target: Float32Array,
  expression: MascotExpression,
): Float32Array {
  for (let eye = 0; eye < 2; eye += 1) {
    const base = eye * EYE_STRIDE;
    const source = expression.eyes[eye];
    target[base] = source.open;
    target[base + 1] = source.curve;
    target[base + 2] = source.slant;
    target[base + 3] = source.width;
    target[base + 4] = source.height;
    target[base + 5] = source.rotationZ;
    target[base + 6] = source.offsetY;
  }
  target[BODY_OFFSET] = expression.body.squashY;
  target[BODY_OFFSET + 1] = expression.body.lift;
  target[BODY_OFFSET + 2] = expression.body.tilt;
  return target;
}

/** 从参数向量读出单只眼睛的姿态。 */
export function readEyeExpression(
  source: Float32Array,
  eyeIndex: number,
  target: EyeExpression,
): EyeExpression {
  const base = eyeIndex * EYE_STRIDE;
  target.open = source[base];
  target.curve = source[base + 1];
  target.slant = source[base + 2];
  target.width = source[base + 3];
  target.height = source[base + 4];
  target.rotationZ = source[base + 5];
  target.offsetY = source[base + 6];
  return target;
}

/** 从参数向量读出身体姿态。 */
export function readBodyPose(source: Float32Array, target: BodyPose): BodyPose {
  target.squashY = source[BODY_OFFSET];
  target.lift = source[BODY_OFFSET + 1];
  target.tilt = source[BODY_OFFSET + 2];
  return target;
}

export function createExpressionVector(): Float32Array {
  return new Float32Array(EXPRESSION_LENGTH);
}

const DEFAULT_EYE: EyeExpression = {
  open: 1, curve: 0, slant: 0, width: 1, height: 1, rotationZ: 0, offsetY: 0,
};
const DEFAULT_BODY: BodyPose = { squashY: 1, lift: 0, tilt: 0 };

/** 用「与默认值的差异」定义表情，省掉大量重复的 1 和 0。 */
function expression(
  left: Partial<EyeExpression>,
  right: Partial<EyeExpression>,
  body: Partial<BodyPose> = {},
): MascotExpression {
  return {
    eyes: [
      { ...DEFAULT_EYE, ...left },
      { ...DEFAULT_EYE, ...right },
    ],
    body: { ...DEFAULT_BODY, ...body },
  };
}

/** 左右眼同形的快捷写法。 */
function symmetric(eye: Partial<EyeExpression>, body: Partial<BodyPose> = {}): MascotExpression {
  return expression(eye, eye, body);
}

/**
 * 表情库。
 *
 * 参数语义速查：
 * - open：0 完全闭眼（只剩一条眼睑线），1 基准睁眼，> 1 瞪大。
 * - curve：正值眼睑中线上凸成 ^ ^，负值下凹成 v v。
 * - slant：正值左低右高（/ 方向），负值左高右低（\ 方向）。
 * - rotationZ：整只眼睛绕自身旋转，配合 slant 可以做出尖角的凌厉感。
 */
export const EXPRESSIONS: Record<ExpressionId, MascotExpression> = {
  /* ── 由业务状态驱动的常驻表情 ── */

  // 待机：原实现的 scaleY=1 / 无旋转，这里完全等价于基准眼型
  neutral: symmetric({}),

  // 思考：略微眯起并轻微不对称，比原实现少了旋转、多了点弧度，读起来像在斟酌
  thinking: expression(
    { open: 0.72, curve: 0.05, rotationZ: -0.04 },
    { open: 0.62, curve: 0.05, rotationZ: 0.04, offsetY: 0.02 },
    { tilt: 0.05 },
  ),

  // 成功：原实现靠压扁 + 反向旋转凑出眯眼笑，这里直接用上凸弯月 ^ ^ 表达
  success: symmetric({ open: 0.3, curve: 0.55, width: 1.05, height: 0.9, offsetY: 0.025 }),

  // 失败：半闭 + 内低外高的斜势，配合旋转读起来像皱眉
  error: expression(
    { open: 0.58, slant: -0.3, rotationZ: 0.48, offsetY: -0.025 },
    { open: 0.58, slant: 0.3, rotationZ: -0.48, offsetY: -0.025 },
  ),

  /* ── 生命周期 ── */

  // 困倦：半闭且下凹，眼皮往下坠
  sleepy: symmetric({ open: 0.22, curve: -0.18, width: 1.1, height: 0.85 }, {
    squashY: 0.97, lift: -0.02, tilt: 0.08,
  }),

  // 睡眠：完全闭合，眼睑线略微下弯，整体放松下沉
  sleep: symmetric({ open: 0, curve: -0.12, width: 1.05 }, {
    squashY: 0.94, lift: -0.04, tilt: 0.06,
  }),

  // 醒来：睁到比基准更大，是「刚睁开」的那一瞬，随后由片段回落
  wake: symmetric({ open: 1.2, curve: 0.08, width: 1.08, height: 1.1 }, { lift: 0.04 }),

  // 休息：放松的半闭眼，比困倦精神一些
  rest: symmetric({ open: 0.45, curve: -0.05, width: 1.02 }, {
    squashY: 0.98, lift: -0.01, tilt: 0.04,
  }),

  // 提醒：眼睛睁大并轻微上抬，像被叫到名字
  remind: symmetric({ open: 1.05, width: 1.08, height: 1.05, offsetY: 0.03 }, {
    squashY: 1.02, lift: 0.02, tilt: -0.03,
  }),

  /* ── 反应 ── */

  // 兴奋：瞪大且上凸，配合身体拉伸
  excited: symmetric({ open: 1.15, curve: 0.3, width: 1.1, height: 1.15 }, {
    squashY: 1.06, lift: 0.05,
  }),

  // 惊讶：瞪到最大最圆，curve 归零以免和「开心」混淆
  surprised: symmetric({ open: 1.25, width: 1.25, height: 1.2 }, {
    squashY: 1.08, lift: 0.03,
  }),

  // 怀疑：一只眯一只睁，即 < ○ > 的异形眼
  suspicious: expression(
    { open: 0.85, slant: -0.35, width: 0.95, height: 0.9, rotationZ: -0.15 },
    { open: 1.05, width: 1.02, height: 1.02 },
    { tilt: -0.07 },
  ),

  // 生气：半闭成尖角，内低外高配合旋转形成 > <
  angry: expression(
    { open: 0.6, slant: -0.45, rotationZ: 0.3, width: 0.95 },
    { open: 0.6, slant: 0.45, rotationZ: -0.3, width: 0.95 },
    { squashY: 0.96, lift: -0.02 },
  ),
};

/**
 * 吉祥物的动作曲线与调度取值。
 *
 * 这些是纯函数，与 Three.js 渲染循环解耦：渲染循环只负责按帧把结果写进
 * 场景对象，曲线本身可以单独验证，不需要 WebGL 环境。
 */
import type { MascotStatus } from './Mascot';
import { MASCOT_CLIPS, type MascotClipId } from './mascotClips';
import type { BodyPose } from './mascotExpressions';

/** 状态转场时的一次性肢体反应。 */
export type MascotReactionKind = 'hop' | 'shake';

/** 各反应的时长（秒）。 */
export const REACTION_DURATIONS: Record<MascotReactionKind, number> = {
  hop: 0.82,
  shake: 0.65,
};

const HOP_HEIGHT = 0.18;
const HOP_SQUASH = 0.16;
/** 起跳前的下蹲与落地压扁各占的进度比例。 */
const HOP_CROUCH_END = 0.18;
const HOP_LAND_START = 0.82;
const SHAKE_ANGLE = 0.2;
const SHAKE_CYCLES = 2.5;
const SHAKE_DIP = 0.05;

export interface MascotReactionPose {
  /** 竖直位移，正值向上。 */
  lift: number;
  /** 叠加到头部偏航上的角度（弧度）。 */
  yaw: number;
  /** 纵向缩放系数，1 为原始高度；横向由调用方按等体积换算。 */
  squashY: number;
}

const NEUTRAL_POSE: MascotReactionPose = { lift: 0, yaw: 0, squashY: 1 };

/** 蹦跳的挤压拉伸：起跳前下蹲、空中拉长、落地再压一下。 */
function getHopSquash(progress: number): number {
  if (progress < HOP_CROUCH_END) {
    return 1 - HOP_SQUASH * Math.sin((progress / HOP_CROUCH_END) * Math.PI);
  }
  if (progress > HOP_LAND_START) {
    return 1 - HOP_SQUASH * Math.sin(((progress - HOP_LAND_START) / (1 - HOP_LAND_START)) * Math.PI);
  }
  const airProgress = (progress - HOP_CROUCH_END) / (HOP_LAND_START - HOP_CROUCH_END);
  return 1 + HOP_SQUASH * 0.28 * Math.sin(airProgress * Math.PI);
}

/**
 * 按反应进度取当前姿态。progress 会被夹到 [0,1]，两端都回到中立姿态，
 * 这样反应结束时不会在场景里留下残余位移或旋转。
 */
export function getReactionPose(kind: MascotReactionKind, progress: number): MascotReactionPose {
  const clamped = Math.min(Math.max(progress, 0), 1);
  if (clamped >= 1) return NEUTRAL_POSE;

  if (kind === 'hop') {
    const squashY = getHopSquash(clamped);
    const airProgress = Math.min(Math.max(
      (clamped - HOP_CROUCH_END) / (HOP_LAND_START - HOP_CROUCH_END),
      0,
    ), 1);
    return {
      // 蓄力和落地时让底部留在原处，只有腾空段抬升；否则下蹲看起来也在上飘。
      lift: 4 * airProgress * (1 - airProgress) * HOP_HEIGHT + Math.min(squashY - 1, 0),
      yaw: 0,
      squashY,
    };
  }
  // 摇头：左右摆动并随进度衰减，同时轻微下沉，读起来像“不行”。
  return {
    lift: -Math.sin(Math.PI * clamped) * SHAKE_DIP,
    yaw: Math.sin(clamped * Math.PI * 2 * SHAKE_CYCLES) * SHAKE_ANGLE * (1 - clamped),
    squashY: 1,
  };
}

const smoothStep = (value: number): number => {
  const t = Math.min(Math.max(value, 0), 1);
  return t * t * (3 - 2 * t);
};

export const BLINK_DURATION = 0.24;

/** 快闭、短暂停留、慢开。闭合保持跨过至少一帧，避免低帧率下只读到半眨眼。 */
export function getBlinkOpenness(elapsed: number): number {
  if (elapsed < 0 || elapsed >= BLINK_DURATION) return 1;
  if (elapsed < 0.065) return 1 - smoothStep(elapsed / 0.065);
  return smoothStep((elapsed - 0.105) / (BLINK_DURATION - 0.105));
}

/** 以角色尺寸为参照映射视线；近处灵敏、远处收敛，斜向也不会超出圆形转动范围。 */
export function getPointerGaze(offsetX: number, offsetY: number, size: number): { x: number; y: number } {
  const distance = Math.hypot(offsetX, offsetY);
  if (distance === 0) return { x: 0, y: 0 };
  const reach = 1 - Math.exp(-distance / Math.max(size * 1.4, 1));
  return { x: offsetX / distance * reach, y: offsetY / distance * reach };
}

/** 片段的次级动作与眼睑包络，叠加在已有表情上，不改变片段优先级或业务状态。 */
export interface MascotPerformancePose extends BodyPose {
  x: number;
  yaw: number;
  pitch: number;
  eyeOpen: number;
}

/** 写入复用缓冲。身体的蓄力、注视、回落各有节奏，持续状态保留轻微呼吸。 */
export function samplePerformancePose(
  status: MascotStatus,
  clipId: MascotClipId | null,
  elapsed: number,
  time: number,
  target: MascotPerformancePose,
): MascotPerformancePose {
  const relaxed = clipId === 'sleep' || clipId === 'sleepy' || clipId === 'rest';
  const breath = Math.sin(time * (relaxed ? 0.65 : 1.05));
  target.x = Math.sin(time * 0.43) * (relaxed ? 0.004 : 0.012);
  target.lift = breath * (relaxed ? 0.012 : 0.025);
  target.squashY = 1 + breath * (relaxed ? 0.012 : 0.009);
  target.tilt = Math.sin(time * 0.57) * (relaxed ? 0.009 : 0.022);
  target.yaw = 0;
  target.pitch = 0;
  target.eyeOpen = 1;

  if (!clipId) {
    if (status === 'thinking') {
      target.x += Math.sin(time * 0.7) * 0.035;
      target.tilt += -0.07 + Math.sin(time * 0.85) * 0.045;
      target.pitch = -0.025;
    }
    return target;
  }

  const duration = MASCOT_CLIPS[clipId].duration;
  const envelope = Number.isFinite(duration)
    ? smoothStep(elapsed / 0.1) * (1 - smoothStep((elapsed - duration * 0.58) / (duration * 0.42)))
    : 1;

  switch (clipId) {
    case 'excited': {
      const hop = getReactionPose('hop', elapsed / REACTION_DURATIONS.hop);
      target.lift += hop.lift;
      target.squashY *= hop.squashY;
      target.tilt += Math.sin(elapsed * 12) * 0.09 * envelope;
      break;
    }
    case 'surprised':
      target.x -= 0.07 * envelope;
      target.pitch = -0.12 * envelope;
      target.lift += 0.08 * envelope;
      break;
    case 'suspicious':
      target.x -= 0.065 * envelope;
      target.yaw = -0.12 * envelope;
      target.tilt -= 0.09 * envelope;
      break;
    case 'angry':
      target.yaw = Math.sin(elapsed * 27) * 0.085 * envelope;
      target.pitch = 0.055 * envelope;
      target.squashY -= 0.025 * envelope;
      break;
    case 'remind':
      target.pitch = Math.sin(elapsed * 12) * 0.085 * envelope;
      target.lift += Math.abs(Math.sin(elapsed * 6)) * 0.06 * envelope;
      target.tilt -= 0.04 * envelope;
      break;
    case 'wake': {
      // 先挤一下眼睛、抬头伸展，再落回当前表情，避免一收到 focus 就直接瞪眼。
      const stretch = smoothStep(elapsed / 0.18) * envelope;
      target.eyeOpen = smoothStep(elapsed / 0.16);
      target.pitch = -0.08 * stretch;
      target.squashY += 0.045 * stretch;
      target.lift += 0.045 * stretch;
      break;
    }
    case 'sleepy': {
      // 缓慢点头打盹后轻轻惊醒，避免常驻片段只剩一张静态半闭眼。
      const phase = elapsed % 5.6;
      const nod = smoothStep((phase - 1.6) / 1.5) * (1 - smoothStep((phase - 3.1) / 0.5));
      target.pitch = nod * 0.14;
      target.lift -= nod * 0.06;
      target.eyeOpen = 1 - nod * 0.9;
      break;
    }
    case 'sleep':
      target.pitch = 0.045;
      break;
    case 'rest':
      target.pitch = 0.025;
      break;
  }
  return target;
}

/** 等体积换算：纵向压扁多少，横向就相应变宽。 */
export function getSquashWidth(squashY: number): number {
  return 1 / Math.sqrt(Math.max(squashY, 0.05));
}

/** 取下一个张望落点，保证与当前落点不同，避免连续两次看向同一处。 */
export function pickNextGazeIndex(
  currentIndex: number,
  pointCount: number,
  random: number,
): number {
  if (pointCount <= 1) return 0;
  const candidate = Math.min(Math.floor(random * pointCount), pointCount - 1);
  return candidate === currentIndex ? (candidate + 1) % pointCount : candidate;
}

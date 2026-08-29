/**
 * 吉祥物姿态的弹簧插值内核。
 *
 * Grok 那套动效的「活物感」来自弹簧而不是线性插值：切换目标时允许过冲再回弹，
 * 中途改目标也能保留当前速度，不会像固定时长的时间曲线那样从头开始。
 *
 * 这里只做数值计算，与 Three.js / WebGL 完全解耦，可以直接单测。
 * 积分用半隐式欧拉（先更新速度、再用新速度更新位置），在高刚度下比显式欧拉稳定，
 * 又比 RK4 便宜，适合每帧十几个自由度同时推进。
 */

/** 单个自由度的弹簧配置。 */
export interface SpringConfig {
  /** 刚度：越大回中越快、过冲越明显。 */
  stiffness: number;
  /** 阻尼：越大越快静止，过小会持续振荡。 */
  damping: number;
  /** 质量：越大越「重」，起停都更迟钝。 */
  mass: number;
  /** 位移小于此值且速度小于 restSpeed 时判定静止。 */
  restDelta?: number;
  /** 静止判定的速度阈值。 */
  restSpeed?: number;
}

/** 单个自由度的弹簧状态。按引用原地更新，避免每帧分配对象。 */
export interface SpringState {
  value: number;
  velocity: number;
}

const DEFAULT_REST_DELTA = 0.0005;
const DEFAULT_REST_SPEED = 0.005;

/** 子步长上限。大帧间隔下直接积分会发散，拆成固定小步可做到与帧率无关且稳定。 */
const MAX_SUBSTEP_SECONDS = 1 / 120;
/**
 * 单帧最多推进多久。超出部分直接丢弃：长卡顿后慢动作回中比一次追赶更好看，
 * 也顺带保证子步数恒不超过 MAX_SUBSTEP_COUNT，不会出现大步长积分发散。
 */
const MAX_FRAME_SECONDS = 1 / 15;
/** 单次推进最多拆多少子步，避免长卡顿后一帧补太多步把主线程压死。 */
const MAX_SUBSTEP_COUNT = 8;

/**
 * 用「固有频率 + 阻尼比」构造弹簧，比直接填 stiffness/damping 直观得多。
 * 频率单位 Hz，1.5~3.5 是这类角色动效的常用区间；阻尼比 < 1 会过冲：
 * 0.5 回弹明显，0.72 只微微过冲，>= 1 不过冲。
 */
export function createSpringConfig(
  frequencyHz: number,
  dampingRatio: number,
  mass = 1,
): SpringConfig {
  const angular = 2 * Math.PI * Math.max(frequencyHz, 0.01);
  return {
    stiffness: angular * angular * mass,
    damping: 2 * Math.max(dampingRatio, 0) * angular * mass,
    mass,
  };
}

/** 惯用的刚度阻尼组合，按用途区分手感。 */
export const SPRING_PRESETS = {
  /** 眼型变化：轻快、几乎不过冲，避免眯眼时抖。 */
  eye: createSpringConfig(3.2, 0.72),
  /** 身体位移与挤压：明显回弹，蹦跳落地靠它。 */
  body: createSpringConfig(2.2, 0.5),
  /** 头部转动：柔和迟钝，接近真实颈部的跟随。 */
  head: createSpringConfig(1.6, 0.85),
} as const;

export function createSpringState(value = 0): SpringState {
  return { value, velocity: 0 };
}

/** 把弹簧硬拉到某个值并清零速度，用于状态切换时丢弃残留动量。 */
export function resetSpring(state: SpringState, value: number): void {
  state.value = value;
  state.velocity = 0;
}

function restDeltaOf(config: SpringConfig): number {
  return config.restDelta ?? DEFAULT_REST_DELTA;
}

function restSpeedOf(config: SpringConfig): number {
  return config.restSpeed ?? DEFAULT_REST_SPEED;
}

export function isSpringAtRest(
  state: SpringState,
  target: number,
  config: SpringConfig,
): boolean {
  return Math.abs(target - state.value) < restDeltaOf(config)
    && Math.abs(state.velocity) < restSpeedOf(config);
}

/**
 * 推进一个自由度。原地修改 state，返回是否已经静止。
 * dt 单位为秒。返回 true 时 state 已被吸附到 target 且速度清零。
 */
export function stepSpring(
  state: SpringState,
  target: number,
  config: SpringConfig,
  dt: number,
): boolean {
  if (!(dt > 0)) return isSpringAtRest(state, target, config);

  const { stiffness, damping, mass } = config;
  const invMass = mass > 0 ? 1 / mass : 1;
  const frame = Math.min(dt, MAX_FRAME_SECONDS);
  const steps = Math.min(Math.ceil(frame / MAX_SUBSTEP_SECONDS), MAX_SUBSTEP_COUNT);
  const h = frame / steps;

  for (let index = 0; index < steps; index += 1) {
    // 半隐式欧拉：加速度用旧位置，位移用新速度 —— 这个先后顺序就是稳定性的来源。
    const accel = (-stiffness * (state.value - target) - damping * state.velocity) * invMass;
    state.velocity += accel * h;
    state.value += state.velocity * h;
  }

  if (isSpringAtRest(state, target, config)) {
    state.value = target;
    state.velocity = 0;
    return true;
  }
  return false;
}

/**
 * 与帧率无关的指数逼近，用来替换原来帧率相关的 `MathUtils.lerp(a, b, 0.12)`。
 * rate 是每秒的收敛速率，越大越快。
 */
export function exponentialApproach(
  current: number,
  target: number,
  rate: number,
  dt: number,
): number {
  if (!(dt > 0)) return current;
  return target + (current - target) * Math.exp(-Math.max(rate, 0) * dt);
}

/** 把 60fps 下的 lerp 系数换算成指数逼近速率，便于沿用已有手感参数。 */
export function rateFromLerp(lerpFactor: number, fps = 60): number {
  const clamped = Math.min(Math.max(lerpFactor, 0), 0.999);
  return -Math.log(1 - clamped) * fps;
}

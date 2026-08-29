import { describe, expect, it } from 'vitest';
import {
  SPRING_PRESETS,
  createSpringConfig,
  createSpringState,
  exponentialApproach,
  isSpringAtRest,
  rateFromLerp,
  resetSpring,
  stepSpring,
} from '../../src/components/shared/mascot/mascotSpring';

/** 按固定帧率推进若干秒，返回采样到的轨迹。 */
function run(
  from: number,
  to: number,
  config: ReturnType<typeof createSpringConfig>,
  fps: number,
  seconds: number,
): { values: number[]; state: { value: number; velocity: number } } {
  const state = createSpringState(from);
  const dt = 1 / fps;
  const values: number[] = [];
  for (let frame = 0; frame < Math.round(fps * seconds); frame += 1) {
    stepSpring(state, to, config, dt);
    values.push(state.value);
  }
  return { values, state };
}

describe('mascotSpring', () => {
  it('settles on the target instead of oscillating forever', () => {
    const { state } = run(0, 1, SPRING_PRESETS.body, 60, 4);
    expect(state.value).toBeCloseTo(1, 6);
    expect(state.velocity).toBeCloseTo(0, 6);
    // 静止判定为真，调用方可以据此跳过后续计算
    expect(isSpringAtRest(state, 1, SPRING_PRESETS.body)).toBe(true);
  });

  it('overshoots when underdamped and does not when critically damped', () => {
    const bouncy = run(0, 1, createSpringConfig(2.2, 0.5), 60, 2);
    expect(Math.max(...bouncy.values)).toBeGreaterThan(1.1);

    const critical = run(0, 1, createSpringConfig(2.2, 1), 60, 2);
    expect(Math.max(...critical.values)).toBeLessThanOrEqual(1.0001);
  });

  it('gives the same trajectory at 30fps and 60fps', () => {
    // 子步长固定为 1/120，两种帧率走完同一段时间经过的子步数相同，
    // 结果应当几乎完全一致 —— 这正是替换掉帧率相关 lerp 的目的。
    const at60 = run(0, 1, SPRING_PRESETS.body, 60, 1.5).state;
    const at30 = run(0, 1, SPRING_PRESETS.body, 30, 1.5).state;
    expect(at30.value).toBeCloseTo(at60.value, 9);
    expect(at30.velocity).toBeCloseTo(at60.velocity, 9);
  });

  it('stays finite even after a very long frame', () => {
    // 长卡顿、标签页切回前台等场景会给出巨大的 dt，不能让它把弹簧算发散
    for (const dt of [0.5, 2, 10, 100]) {
      for (const config of Object.values(SPRING_PRESETS)) {
        const state = createSpringState(0);
        stepSpring(state, 1, config, dt);
        expect(Number.isFinite(state.value)).toBe(true);
        expect(Number.isFinite(state.velocity)).toBe(true);
        // 丢弃超出上限的时间，所以最坏情况也只是还没走到目标，不会甩飞
        expect(state.value).toBeGreaterThanOrEqual(-1);
        expect(state.value).toBeLessThanOrEqual(2);
      }
    }
  });

  it('ignores non-positive time steps', () => {
    const state = createSpringState(0.3);
    for (const dt of [0, -1]) {
      stepSpring(state, 1, SPRING_PRESETS.body, dt);
    }
    // 时间没有推进，值也不该动
    expect(state.value).toBe(0.3);
  });

  it('drops accumulated momentum when reset', () => {
    const state = createSpringState(0);
    stepSpring(state, 1, SPRING_PRESETS.body, 1 / 60);
    expect(state.velocity).not.toBe(0);

    resetSpring(state, 0.42);
    expect(state.value).toBe(0.42);
    expect(state.velocity).toBe(0);
  });

  it('converges from either direction', () => {
    expect(run(1, 0, SPRING_PRESETS.eye, 60, 4).state.value).toBeCloseTo(0, 6);
    expect(run(-2, 2, SPRING_PRESETS.head, 60, 6).state.value).toBeCloseTo(2, 6);
  });
});

describe('exponentialApproach', () => {
  it('converges at the same rate regardless of frame rate', () => {
    // 一秒内逼近的比例必须与拆成多少帧无关，否则 30fps 和 120fps 手感不同
    const rate = 7.7;
    let coarse = 0;
    for (let i = 0; i < 30; i += 1) coarse = exponentialApproach(coarse, 1, rate, 1 / 30);
    let fine = 0;
    for (let i = 0; i < 120; i += 1) fine = exponentialApproach(fine, 1, rate, 1 / 120);
    expect(coarse).toBeCloseTo(fine, 6);
  });

  it('never overshoots and never goes backwards', () => {
    let value = 0;
    for (let i = 0; i < 200; i += 1) {
      const next = exponentialApproach(value, 1, 7.7, 1 / 60);
      expect(next).toBeGreaterThanOrEqual(value);
      expect(next).toBeLessThanOrEqual(1);
      value = next;
    }
  });

  it('round-trips the legacy lerp factors', () => {
    // 沿用旧手感：60fps 下的 lerp 系数换算回速率后，第一帧的位移应当一致
    const legacy = 0.12;
    const rate = rateFromLerp(legacy, 60);
    const afterOneFrame = exponentialApproach(0, 1, rate, 1 / 60);
    expect(afterOneFrame).toBeCloseTo(legacy, 6);
  });
});

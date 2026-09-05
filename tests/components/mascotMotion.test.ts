import { describe, expect, it } from 'vitest';
import {
  BLINK_DURATION,
  REACTION_DURATIONS,
  getBlinkOpenness,
  getPointerGaze,
  getReactionPose,
  getSquashWidth,
  pickNextGazeIndex,
  samplePerformancePose,
  type MascotPerformancePose,
} from '../../src/components/shared/mascot/mascotMotion';
import { MASCOT_CLIPS, type MascotClipId } from '../../src/components/shared/mascot/mascotClips';

const createPerformancePose = (): MascotPerformancePose => ({
  x: 0, lift: 0, tilt: 0, pitch: 0, yaw: 0, squashY: 1, eyeOpen: 1,
});

describe('mascotMotion', () => {
  it('starts and ends every reaction at the neutral pose', () => {
    for (const kind of ['hop', 'shake'] as const) {
      for (const progress of [0, 1, 1.5]) {
        const pose = getReactionPose(kind, progress);
        // 反应两端必须回到中立姿态，否则结束后场景里会留下残余位移或旋转
        expect(pose.lift).toBeCloseTo(0, 6);
        expect(pose.yaw).toBeCloseTo(0, 6);
        expect(pose.squashY).toBeCloseTo(1, 6);
      }
    }
  });

  it('lifts the body and stretches it mid-air during a hop', () => {
    const peak = getReactionPose('hop', 0.5);
    expect(peak.lift).toBeGreaterThan(0.1);
    expect(peak.squashY).toBeGreaterThan(1);
    expect(peak.yaw).toBe(0);

    // 起跳前下蹲、落地压扁：两端都比原始高度矮
    expect(getReactionPose('hop', 0.09).squashY).toBeLessThan(1);
    expect(getReactionPose('hop', 0.91).squashY).toBeLessThan(1);
  });

  it('keeps the lower body planted during anticipation and landing', () => {
    for (const progress of [0.04, 0.09, 0.14, 0.86, 0.91, 0.96]) {
      const pose = getReactionPose('hop', progress);
      expect(pose.lift).toBeLessThan(0);
      // 半径为 1，压缩时球心下降量必须等于半径变化，不能一边下蹲一边上浮。
      expect(pose.lift - pose.squashY).toBeCloseTo(-1, 6);
    }
  });

  it.each([30, 60, 120])('fully closes a blink at %i fps, then reopens without overshoot', (fps) => {
    const frames = Array.from({ length: Math.ceil(BLINK_DURATION * fps) + 1 }, (_, i) => getBlinkOpenness(i / fps));
    expect(Math.min(...frames)).toBe(0);
    expect(Math.max(...frames)).toBe(1);
    expect(frames.at(-1)).toBe(1);
    expect(getBlinkOpenness(-1)).toBe(1);
  });

  it('responds to a nearby pointer without exceeding the diagonal gaze range', () => {
    expect(getPointerGaze(0, 0, 100)).toEqual({ x: 0, y: 0 });
    expect(getPointerGaze(50, 0, 100).x).toBeGreaterThan(0.25);
    const diagonal = getPointerGaze(1000, -1000, 100);
    expect(diagonal.x).toBeGreaterThan(0);
    expect(diagonal.y).toBeLessThan(0);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeLessThanOrEqual(1);
    expect(getPointerGaze(100, 0, 200).x).toBeCloseTo(getPointerGaze(50, 0, 100).x, 6);
  });

  it('returns transient performances to ambient motion at the end of the clip', () => {
    for (const clip of Object.values(MASCOT_CLIPS)) {
      if (!Number.isFinite(clip.duration)) continue;
      const ambient = samplePerformancePose('idle', null, 0, 2, createPerformancePose());
      const final = samplePerformancePose('idle', clip.id, clip.duration, 2, createPerformancePose());
      for (const key of Object.keys(ambient) as (keyof MascotPerformancePose)[]) {
        expect(final[key], `${clip.id}.${key}`).toBeCloseTo(ambient[key], 6);
      }
    }
  });

  it('gives reaction clips distinct body gestures and lets a sleepy nod recover', () => {
    const sample = (id: MascotClipId, elapsed: number) => samplePerformancePose('idle', id, elapsed, 0, createPerformancePose());
    expect(sample('excited', 0.4).lift).toBeGreaterThan(0.1);
    expect(sample('surprised', 0.2).pitch).toBeLessThan(-0.05);
    expect(sample('suspicious', 0.4).yaw).toBeLessThan(-0.05);
    expect(sample('sleepy', 3.1).eyeOpen).toBeLessThan(0.2);
    expect(sample('sleepy', 4).eyeOpen).toBe(1);
    expect(sample('sleepy', 4).pitch).toBe(0);
  });

  it('keeps every performance bounded through several cycles', () => {
    const buffer = createPerformancePose();
    for (const clip of Object.values(MASCOT_CLIPS)) {
      for (let frame = 0; frame <= 600; frame += 1) {
        samplePerformancePose('idle', clip.id, frame / 30, frame / 30, buffer);
        for (const value of Object.values(buffer)) expect(Number.isFinite(value)).toBe(true);
        expect(buffer.squashY).toBeGreaterThan(0.8);
        expect(buffer.squashY).toBeLessThan(1.15);
        expect(Math.abs(buffer.lift)).toBeLessThan(0.3);
        expect(buffer.eyeOpen).toBeGreaterThanOrEqual(0);
        expect(buffer.eyeOpen).toBeLessThanOrEqual(1);
      }
    }
  });

  it('swings the head both ways and decays over a shake', () => {
    const samples = Array.from({ length: 40 }, (_, index) => getReactionPose('shake', index / 40).yaw);
    expect(Math.max(...samples)).toBeGreaterThan(0.05);
    expect(Math.min(...samples)).toBeLessThan(-0.05);

    // 摆幅随进度衰减：后段的最大绝对值必须小于前段
    const earlyPeak = Math.max(...samples.slice(0, 10).map(Math.abs));
    const latePeak = Math.max(...samples.slice(30).map(Math.abs));
    expect(latePeak).toBeLessThan(earlyPeak);

    // 摇头不该把身体抬起来
    expect(getReactionPose('shake', 0.5).lift).toBeLessThan(0);
  });

  it('keeps the reaction durations positive and short enough to read as one beat', () => {
    expect(REACTION_DURATIONS.hop).toBeGreaterThan(0);
    expect(REACTION_DURATIONS.shake).toBeGreaterThan(0);
    expect(REACTION_DURATIONS.hop).toBeLessThan(1.2);
    expect(REACTION_DURATIONS.shake).toBeLessThan(1.2);
  });

  it('widens the body when it is squashed and narrows it when stretched', () => {
    expect(getSquashWidth(1)).toBeCloseTo(1, 6);
    expect(getSquashWidth(0.86)).toBeGreaterThan(1);
    expect(getSquashWidth(1.09)).toBeLessThan(1);
    // 极端值不能算出无穷或负数缩放
    expect(Number.isFinite(getSquashWidth(0))).toBe(true);
    expect(getSquashWidth(0)).toBeGreaterThan(0);
  });

  it('never picks the gaze point it is already looking at', () => {
    for (let current = 0; current < 5; current += 1) {
      for (const random of [0, 0.19, 0.4, 0.61, 0.83, 0.999]) {
        const next = pickNextGazeIndex(current, 5, random);
        expect(next).not.toBe(current);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThan(5);
      }
    }
  });

  it('stays in range when random returns exactly 1 or there is a single point', () => {
    expect(pickNextGazeIndex(-1, 6, 1)).toBe(5);
    expect(pickNextGazeIndex(0, 1, 0.5)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  BODY_OFFSET,
  EXPRESSIONS,
  EYE_STRIDE,
  EXPRESSION_LENGTH,
  createExpressionVector,
  flattenExpression,
  readBodyPose,
  readEyeExpression,
  type BodyPose,
  type EyeExpression,
  type ExpressionId,
} from '../../src/components/shared/mascot/mascotExpressions';
import { EYE_PARAM_LIMITS } from '../../src/components/shared/mascot/mascotEyeShader';

const IDS = Object.keys(EXPRESSIONS) as ExpressionId[];

function blankEye(): EyeExpression {
  return { open: 0, curve: 0, slant: 0, width: 0, height: 0, rotationZ: 0, offsetY: 0 };
}

function blankBody(): BodyPose {
  return { squashY: 0, lift: 0, tilt: 0 };
}

describe('mascotExpressions', () => {
  it('round-trips every expression through the flat vector', () => {
    const vector = createExpressionVector();
    for (const id of IDS) {
      flattenExpression(vector, EXPRESSIONS[id]);
      for (const eyeIndex of [0, 1]) {
        const eye = readEyeExpression(vector, eyeIndex, blankEye());
        const expected = EXPRESSIONS[id].eyes[eyeIndex];
        // 向量是 Float32Array，只能按单精度精度比对
        for (const key of Object.keys(expected) as (keyof EyeExpression)[]) {
          expect(eye[key]).toBeCloseTo(expected[key], 5);
        }
      }
      const body = readBodyPose(vector, blankBody());
      for (const key of Object.keys(EXPRESSIONS[id].body) as (keyof BodyPose)[]) {
        expect(body[key]).toBeCloseTo(EXPRESSIONS[id].body[key], 5);
      }
    }
  });

  it('keeps the vector layout consistent with its own constants', () => {
    expect(EXPRESSION_LENGTH).toBe(EYE_STRIDE * 2 + 3);
    expect(BODY_OFFSET).toBe(EYE_STRIDE * 2);
    expect(createExpressionVector()).toHaveLength(EXPRESSION_LENGTH);
  });

  it('treats neutral as the baseline the other expressions deviate from', () => {
    for (const eye of EXPRESSIONS.neutral.eyes) {
      expect(eye.open).toBe(1);
      expect(eye.curve).toBe(0);
      expect(eye.slant).toBe(0);
      expect(eye.width).toBe(1);
      expect(eye.height).toBe(1);
      expect(eye.rotationZ).toBe(0);
      expect(eye.offsetY).toBe(0);
    }
    expect(EXPRESSIONS.neutral.body).toEqual({ squashY: 1, lift: 0, tilt: 0 });
  });

  it('closes the eyes for sleep and widens them for surprise', () => {
    for (const eye of EXPRESSIONS.sleep.eyes) expect(eye.open).toBe(0);
    for (const eye of EXPRESSIONS.surprised.eyes) {
      expect(eye.open).toBeGreaterThan(EXPRESSIONS.neutral.eyes[0].open);
      expect(eye.width).toBeGreaterThan(1);
      expect(eye.height).toBeGreaterThan(1);
    }
  });

  it('arches up when happy and down when sleepy', () => {
    expect(EXPRESSIONS.success.eyes[0].curve).toBeGreaterThan(0.3);
    expect(EXPRESSIONS.sleepy.eyes[0].curve).toBeLessThan(0);
    expect(EXPRESSIONS.sleep.eyes[0].curve).toBeLessThan(0);
  });

  it('gives suspicious two different eyes so it reads as one raised brow', () => {
    const [left, right] = EXPRESSIONS.suspicious.eyes;
    expect(left.open).not.toBeCloseTo(right.open, 3);
    expect(left.rotationZ).not.toBeCloseTo(right.rotationZ, 3);
  });

  it('mirrors the slant for angry so both eyes point inward', () => {
    const [left, right] = EXPRESSIONS.angry.eyes;
    expect(Math.sign(left.slant)).toBe(-Math.sign(right.slant));
    expect(left.slant).not.toBe(0);
    expect(Math.sign(left.rotationZ)).toBe(-Math.sign(right.rotationZ));
  });

  it('stays inside the parameter limits the eye plane was sized for', () => {
    // 直接对照上界，避免表情表与画布尺寸各写一份数字而悄悄失配
    for (const id of IDS) {
      for (const eye of EXPRESSIONS[id].eyes) {
        for (const key of ['open', 'curve', 'slant', 'width', 'height'] as const) {
          const { min, max } = EYE_PARAM_LIMITS[key];
          expect(eye[key]).toBeGreaterThanOrEqual(min);
          expect(eye[key]).toBeLessThanOrEqual(max);
        }
      }
    }
  });

  it('keeps body squash positive so the equal-volume widen stays finite', () => {
    for (const id of IDS) {
      expect(EXPRESSIONS[id].body.squashY).toBeGreaterThan(0.5);
      expect(EXPRESSIONS[id].body.squashY).toBeLessThan(1.5);
    }
  });

  it('can be interpolated component by component between any two expressions', () => {
    // 弹簧是逐分量推进的，所以任意两个表情之间都必须能线性混合而不产生非法值
    const from = createExpressionVector();
    const to = createExpressionVector();
    flattenExpression(from, EXPRESSIONS.sleep);
    flattenExpression(to, EXPRESSIONS.surprised);

    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      for (let index = 0; index < EXPRESSION_LENGTH; index += 1) {
        const mixed = from[index] + (to[index] - from[index]) * t;
        expect(Number.isFinite(mixed)).toBe(true);
      }
      // 逐分量插值后，眼型参数必须仍在合法区间内
      const eye = readEyeExpression(
        Float32Array.from(from, (value, index) => value + (to[index] - value) * t),
        0,
        blankEye(),
      );
      expect(eye.open).toBeGreaterThanOrEqual(0);
      expect(eye.width).toBeGreaterThan(0);
      expect(eye.height).toBeGreaterThan(0);
    }
  });
});

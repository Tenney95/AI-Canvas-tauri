import { describe, expect, it } from 'vitest';
import {
  EYE_LID_HALF_THICKNESS,
  EYE_PARAM_LIMITS,
  EYE_PLANE_HEIGHT,
  EYE_PLANE_WIDTH,
  eyeDistanceAt,
  isInsideEye,
  type EyeShapeParams,
} from '../../src/components/shared/mascot/mascotEyeShader';

const OPEN: EyeShapeParams = { open: 1, curve: 0, slant: 0, width: 1, height: 1 };

/** 在给定横坐标上找距离场最小的纵坐标，即该处眼睑中心线的位置。 */
function centerAt(x: number, shape: EyeShapeParams): number {
  let bestY = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= 2000; index += 1) {
    const y = -1 + (2 * index) / 2000;
    const distance = eyeDistanceAt(x, y, shape);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestY = y;
    }
  }
  return bestY;
}

/** 在给定横坐标上量出眼睛内部的纵向跨度。 */
function heightAt(x: number, shape: EyeShapeParams): number {
  let top = 0;
  let bottom = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= 2000; index += 1) {
    const y = -1 + (2 * index) / 2000;
    if (eyeDistanceAt(x, y, shape) < 0) {
      top = y;
      bottom = Math.min(bottom, y);
    }
  }
  return top - (bottom === Number.POSITIVE_INFINITY ? 0 : bottom);
}

describe('eyeDistanceAt', () => {
  it('draws an open eye that is inside at the centre and outside far away', () => {
    expect(isInsideEye(0, 0, OPEN)).toBe(true);
    expect(isInsideEye(0, 0.15, OPEN)).toBe(true);
    // 基准半高 0.18，总高约 0.40；0.5 已经在胶囊轮廓之外
    expect(isInsideEye(0, 0.5, OPEN)).toBe(false);
    // 基准半宽 0.09，横向超出后也不该有内容
    expect(isInsideEye(0.15, 0, OPEN)).toBe(false);
  });

  it('leaves only a thin lid line when fully closed', () => {
    const closed: EyeShapeParams = { ...OPEN, open: 0 };
    expect(isInsideEye(0, 0, closed)).toBe(true);
    // 闭上之后不能还是一整个椭圆，否则「闭眼」和「睁眼」看起来一样
    expect(isInsideEye(0, 0.1, closed)).toBe(false);
    expect(heightAt(0, closed)).toBeLessThan(0.1);
    expect(heightAt(0, closed)).toBeGreaterThanOrEqual(EYE_LID_HALF_THICKNESS);
  });

  it('stays visible when closed so sleep reads as closed eyes', () => {
    // 基准眼高 0.36，眼睑线再细就会在睡眠这类持续表情下看不见
    const closed: EyeShapeParams = { ...OPEN, open: 0 };
    expect(heightAt(0, closed)).toBeGreaterThan(0.02);
  });

  it('arches the lid upward with positive curve and downward with negative', () => {
    // ^ ^ 弯月眼：上凸使上方内部区域更大，下方更小
    const up: EyeShapeParams = { ...OPEN, curve: 0.6 };
    expect(isInsideEye(0, 0.30, up)).toBe(true);
    expect(isInsideEye(0, -0.15, up)).toBe(false);
    // v v 困倦：下凹使下方内部区域更大，上方更小
    const down: EyeShapeParams = { ...OPEN, curve: -0.6 };
    expect(isInsideEye(0, -0.30, down)).toBe(true);
    expect(isInsideEye(0, 0.15, down)).toBe(false);
    // 无弯曲时上下对称
    expect(isInsideEye(0, 0.25, OPEN)).toBe(isInsideEye(0, -0.25, OPEN));
  });

  it('slants the lid so left and right differ, giving > < when mirrored', () => {
    const slanting: EyeShapeParams = { ...OPEN, slant: 0.5 };
    expect(centerAt(0.1, slanting)).toBeGreaterThan(centerAt(-0.1, slanting));
    // 取反后左右互换，两只眼用相反符号即可凑出对称的斜眼
    const mirrored: EyeShapeParams = { ...OPEN, slant: -0.5 };
    expect(centerAt(0.1, mirrored)).toBeLessThan(centerAt(-0.1, mirrored));
  });

  it('is symmetric about the vertical axis when curve and slant are zero', () => {
    for (const y of [0, 0.1, 0.25]) {
      expect(eyeDistanceAt(0.1, y, OPEN)).toBeCloseTo(eyeDistanceAt(-0.1, y, OPEN), 10);
      expect(eyeDistanceAt(0, y, OPEN)).toBeCloseTo(eyeDistanceAt(0, -y, OPEN), 10);
    }
  });

  it('scales the eye with width and height', () => {
    const wide: EyeShapeParams = { ...OPEN, width: 1.3 };
    expect(isInsideEye(0.10, 0, wide)).toBe(true);
    expect(isInsideEye(0.10, 0, OPEN)).toBe(false);

    const tall: EyeShapeParams = { ...OPEN, height: 1.3 };
    expect(heightAt(0, tall)).toBeGreaterThan(heightAt(0, OPEN));
  });

  it('keeps rounded corners like the original capsule shape', () => {
    // 正常状态是原实现的圆角竖胶囊，两端不是尖的
    const fullHeight = heightAt(0, OPEN);
    expect(fullHeight).toBeGreaterThan(0.3);
    expect(heightAt(0.06, OPEN)).toBeGreaterThan(fullHeight * 0.4);
    // 最边缘已经跑出形状
    expect(isInsideEye(0.12, 0, OPEN)).toBe(false);
  });

  it('never produces a non-finite distance', () => {
    const shapes: EyeShapeParams[] = [
      OPEN,
      { ...OPEN, open: 0, curve: 0, slant: 0, width: 0.001, height: 0.001 },
      { open: 1.5, curve: -1, slant: 1, width: 2, height: 2 },
    ];
    for (const shape of shapes) {
      for (const x of [-1, -0.2, 0, 0.2, 1]) {
        for (const y of [-1, 0, 1]) {
          expect(Number.isFinite(eyeDistanceAt(x, y, shape))).toBe(true);
        }
      }
    }
  });
});

describe('eye plane size', () => {
  it('fits every shape the parameter limits allow', () => {
    // 弹簧过冲会让参数短暂冲到上界，所以这里直接遍历所有上界角点组合，
    // 任何一个组合被画布切掉都说明 EYE_PLANE_* 定小了
    const { open, curve, slant, width, height } = EYE_PARAM_LIMITS;
    const extremes: EyeShapeParams[] = [];
    for (const o of [open.min, open.max]) {
      for (const c of [curve.min, curve.max]) {
        for (const s of [slant.min, slant.max]) {
          for (const w of [width.min, width.max]) {
            for (const h of [height.min, height.max]) {
              extremes.push({ open: o, curve: c, slant: s, width: w, height: h });
            }
          }
        }
      }
    }

    const halfW = EYE_PLANE_WIDTH / 2;
    const halfH = EYE_PLANE_HEIGHT / 2;
    const samples = 300;
    for (const shape of extremes) {
      for (let index = 0; index <= samples; index += 1) {
        const along = -1 + (2 * index) / samples;
        // 只需沿四条边检查：边缘上还有内容就说明形状被画布切掉了
        expect(isInsideEye(along * halfW, halfH, shape)).toBe(false);
        expect(isInsideEye(along * halfW, -halfH, shape)).toBe(false);
        expect(isInsideEye(halfW, along * halfH, shape)).toBe(false);
        expect(isInsideEye(-halfW, along * halfH, shape)).toBe(false);
      }
    }
  });
});

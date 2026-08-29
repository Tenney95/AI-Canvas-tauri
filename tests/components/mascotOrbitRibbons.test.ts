import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { Mesh } from 'three';
import { createOrbitRibbons } from '../../src/components/shared/mascot/mascotOrbitRibbons';

/** 与 Mascot.tsx 中的相机设置保持一致，改相机参数时必须同步这里。 */
const CAMERA_FOV = 35;
const CAMERA_DISTANCE = 5;
/** 球体半径，彩带轨道必须完全在它之外，否则会与球体穿模。 */
const SPHERE_RADIUS = 1;

const CAMERA_POSITION = new Vector3(0, 0, CAMERA_DISTANCE);

/** 推进足够长时间让拖尾完全长出来。 */
function warmUp(ribbons: ReturnType<typeof createOrbitRibbons>, seconds = 3) {
  ribbons.setIntensity(1);
  const dt = 1 / 60;
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
    ribbons.update(dt, CAMERA_POSITION);
  }
}

function vertices(ribbons: ReturnType<typeof createOrbitRibbons>): number[][] {
  const out: number[][] = [];
  for (const child of ribbons.group.children) {
    const mesh = child as Mesh;
    const position = mesh.geometry.getAttribute('position');
    const used = mesh.geometry.drawRange.count;
    if (used === 0) continue;
    // drawRange 是索引数，6 个索引一个四边形，每个四边形用到前一索引对
    const vertexCount = (used / 6 + 1) * 2;
    for (let i = 0; i < Math.min(vertexCount, position.count); i += 1) {
      out.push([position.getX(i), position.getY(i), position.getZ(i)]);
    }
  }
  return out;
}

/** 取第一条带子每对顶点的中点，即拖尾的中心线。 */
function centerline(ribbons: ReturnType<typeof createOrbitRibbons>): number[][] {
  const mesh = ribbons.group.children[0] as Mesh;
  const position = mesh.geometry.getAttribute('position');
  const usedVertices = ((mesh.geometry.drawRange.count / 6) + 1) * 2;
  const points: number[][] = [];
  for (let i = 0; i + 1 < usedVertices; i += 2) {
    points.push([
      (position.getX(i) + position.getX(i + 1)) / 2,
      (position.getY(i) + position.getY(i + 1)) / 2,
      (position.getZ(i) + position.getZ(i + 1)) / 2,
    ]);
  }
  return points;
}

describe('mascotOrbitRibbons', () => {
  it('creates one mesh per ribbon belt', () => {
    const ribbons = createOrbitRibbons();
    expect(ribbons.group.children.length).toBeGreaterThan(0);
    ribbons.dispose();
  });

  it('starts hidden with zero intensity', () => {
    const ribbons = createOrbitRibbons();
    expect(ribbons.group.visible).toBe(false);
    for (const child of ribbons.group.children) {
      expect((child as Mesh).material).toMatchObject({ opacity: 0 });
    }
    ribbons.dispose();
  });

  it('grows a trail once it starts moving', () => {
    const ribbons = createOrbitRibbons();
    expect(vertices(ribbons)).toHaveLength(0);
    warmUp(ribbons);
    expect(vertices(ribbons).length).toBeGreaterThan(0);
    ribbons.dispose();
  });

  it('stays inside the camera frustum so no ribbon gets clipped', () => {
    // 相机是透视投影，可视半高由 FOV 与距离决定；超出的部分会被画布切掉
    const halfHeight = CAMERA_DISTANCE * Math.tan((CAMERA_FOV / 2) * (Math.PI / 180));
    const ribbons = createOrbitRibbons();
    warmUp(ribbons);
    const points = vertices(ribbons);
    expect(points.length).toBeGreaterThan(0);
    for (const [x, y] of points) {
      expect(Math.abs(y)).toBeLessThan(halfHeight);
      expect(Math.abs(x)).toBeLessThan(halfHeight);
    }
    ribbons.dispose();
  });

  it('orbits outside the sphere so ribbons never intersect it', () => {
    const ribbons = createOrbitRibbons();
    warmUp(ribbons);
    const points = vertices(ribbons);
    expect(points.length).toBeGreaterThan(0);
    for (const [x, y, z] of points) {
      // 轨道半径大于球体半径，带子的宽度向内也不会吃到球里
      expect(Math.hypot(x, y, z)).toBeGreaterThan(SPHERE_RADIUS);
    }
    ribbons.dispose();
  });

  it('wraps behind the sphere, not just around its front', () => {
    // 环绕的关键：轨道是三维圆，深度要同时出现正（球前）和负（球后）
    const ribbons = createOrbitRibbons();
    warmUp(ribbons);
    const depths = vertices(ribbons).map(([, , z]) => z);
    expect(Math.max(...depths)).toBeGreaterThan(0);
    expect(Math.min(...depths)).toBeLessThan(0);
    ribbons.dispose();
  });

  it('draws a curved trail rather than a straight line', () => {
    // 回归防护：曾经因为采样时把头部点的角度一并推进，导致再也不产生新采样点，
    // 拖尾退化成连接起点与当前位置的一条直线。这里用弧长/弦长的比值卡住它。
    const ribbons = createOrbitRibbons();
    warmUp(ribbons);
    const points = centerline(ribbons);
    expect(points.length).toBeGreaterThan(4);

    let pathLength = 0;
    for (let i = 1; i < points.length; i += 1) {
      pathLength += Math.hypot(
        points[i][0] - points[i - 1][0],
        points[i][1] - points[i - 1][1],
        points[i][2] - points[i - 1][2],
      );
    }
    const chord = Math.hypot(
      points[points.length - 1][0] - points[0][0],
      points[points.length - 1][1] - points[0][1],
      points[points.length - 1][2] - points[0][2],
    );
    // 圆弧的弧长明显大于弦长；退化成直线时两者相等
    expect(pathLength / chord).toBeGreaterThan(1.1);
    ribbons.dispose();
  });

  it('drives material opacity from setIntensity', () => {
    const ribbons = createOrbitRibbons();
    ribbons.setIntensity(0.42);
    for (const child of ribbons.group.children) {
      expect((child as Mesh).material).toMatchObject({ opacity: 0.42 });
    }
    ribbons.dispose();
  });

  it('scales ribbon width with intensity', () => {
    // 强度同时控制宽度，淡入时带子应当由细到饱满
    const widthAt = (intensity: number) => {
      const ribbons = createOrbitRibbons();
      ribbons.setIntensity(intensity);
      for (let i = 0; i < 180; i += 1) ribbons.update(1 / 60, CAMERA_POSITION);
      const mesh = ribbons.group.children[0] as Mesh;
      const position = mesh.geometry.getAttribute('position');
      // 只统计 drawRange 覆盖到的顶点，缓冲区尾部的空闲槽位全是 0
      const usedVertices = ((mesh.geometry.drawRange.count / 6) + 1) * 2;
      // 取头部（最后一对）顶点的间距，那里是带子最宽的位置
      const index = Math.max(0, usedVertices - 2);
      const dx = position.getX(index) - position.getX(index + 1);
      const dy = position.getY(index) - position.getY(index + 1);
      const dz = position.getZ(index) - position.getZ(index + 1);
      ribbons.dispose();
      return Math.hypot(dx, dy, dz);
    };
    expect(widthAt(1)).toBeGreaterThan(widthAt(0.25));
  });

  it('keeps producing a trail when a frame is long', () => {
    // 卡帧后一帧跨过的角度很大，必须补点，否则带子会退化成一条直线
    const ribbons = createOrbitRibbons();
    ribbons.setIntensity(1);
    ribbons.update(0.5, CAMERA_POSITION);
    ribbons.update(0.5, CAMERA_POSITION);
    const points = vertices(ribbons);
    expect(points.length).toBeGreaterThan(2);
    ribbons.dispose();
  });

  it('disposes without throwing', () => {
    const ribbons = createOrbitRibbons();
    warmUp(ribbons);
    expect(() => ribbons.dispose()).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { Mesh } from 'three';
import { createOrbitRibbons } from '../../src/components/shared/mascot/mascotOrbitRibbons';

/** 与 Mascot.tsx 中的相机设置保持一致，改相机参数时必须同步这里。 */
const CAMERA_FOV = 35;
const CAMERA_DISTANCE = 5.35;
/** 内核半径 1 + 绒毛长度 0.22，彩带也要为绒毛留出间隙。 */
const FUR_RADIUS = 1.22;

const CAMERA_POSITION = new Vector3(0, 0, CAMERA_DISTANCE);

/** 推进足够长时间让拖尾完全长出来。 */
function warmUp(ribbons: ReturnType<typeof createOrbitRibbons>, seconds = 3, fps = 60) {
  ribbons.setIntensity(1);
  const frames = Math.round(seconds * fps);
  for (let frame = 0; frame < frames; frame += 1) {
    ribbons.update(seconds / frames, CAMERA_POSITION);
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
function centerline(ribbons: ReturnType<typeof createOrbitRibbons>, belt = 0): number[][] {
  const mesh = ribbons.group.children[belt] as Mesh;
  if (mesh.geometry.drawRange.count === 0) return [];
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

function pathLength(points: number[][]): number {
  return points.slice(1).reduce((length, point, index) => length + Math.hypot(
    point[0] - points[index][0],
    point[1] - points[index][1],
    point[2] - points[index][2],
  ), 0);
}

function ribbonWidths(mesh: Mesh): number[] {
  const position = mesh.geometry.getAttribute('position');
  if (mesh.geometry.drawRange.count === 0) return [];
  const pairCount = mesh.geometry.drawRange.count / 6 + 1;
  return Array.from({ length: pairCount }, (_, pair) => {
    const index = pair * 2;
    return Math.hypot(
      position.getX(index) - position.getX(index + 1),
      position.getY(index) - position.getY(index + 1),
      position.getZ(index) - position.getZ(index + 1),
    );
  });
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
    const ribbons = createOrbitRibbons();
    warmUp(ribbons);
    for (let frame = 0; frame < 360; frame += 1) {
      ribbons.update(1 / 30, CAMERA_POSITION);
      const points = vertices(ribbons);
      expect(points.length).toBeGreaterThan(0);
      // 前景比后景的可视范围小，必须把每个顶点的深度带入透视投影。
      const overflow = points.some(([x, y, z]) => {
        const halfHeight = (CAMERA_DISTANCE - z) * Math.tan(CAMERA_FOV * Math.PI / 360);
        return Math.abs(x) >= halfHeight || Math.abs(y) >= halfHeight;
      });
      expect(overflow).toBe(false);
    }
    ribbons.dispose();
  });

  it('orbits outside the fur so ribbons keep a gap at the silhouette', () => {
    const ribbons = createOrbitRibbons();
    warmUp(ribbons);
    const points = vertices(ribbons);
    expect(points.length).toBeGreaterThan(0);
    for (const [x, y, z] of points) {
      // 包含彩带宽度和圆头的最内侧顶点也必须落在绒毛之外。
      expect(Math.hypot(x, y, z)).toBeGreaterThan(FUR_RADIUS);
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
      const width = Math.max(...ribbonWidths(mesh));
      ribbons.dispose();
      return width;
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

  it('keeps the same trail length and pose at 30, 60 and 144 fps', () => {
    const versions = [30, 60, 144].map((fps) => {
      const ribbons = createOrbitRibbons();
      warmUp(ribbons, 3, fps);
      return ribbons;
    });
    const baseline = vertices(versions[0]);
    for (const ribbons of versions.slice(1)) {
      const points = vertices(ribbons);
      expect(points.length).toBe(baseline.length);
      const maxError = Math.max(...points.flatMap((point, index) => point.map(
        (coordinate, axis) => Math.abs(coordinate - baseline[index][axis]),
      )));
      expect(maxError).toBeLessThan(0.00001);
    }
    for (const ribbons of versions) ribbons.dispose();
  });

  it('rounds both ends instead of leaving a flat cut', () => {
    const ribbons = createOrbitRibbons();
    warmUp(ribbons);
    for (const child of ribbons.group.children) {
      const widths = ribbonWidths(child as Mesh);
      expect(widths[0]).toBeCloseTo(0, 6);
      expect(widths[widths.length - 1]).toBeCloseTo(0, 6);
      expect(widths[2]).toBeGreaterThan(widths[1]);
      expect(widths[widths.length - 3]).toBeGreaterThan(widths[widths.length - 2]);
      expect(Math.max(...widths)).toBeGreaterThan(0.05);
    }
    ribbons.dispose();
  });

  it('retracts the tail toward the head while fading out', () => {
    const ribbons = createOrbitRibbons();
    warmUp(ribbons);
    const fullLength = pathLength(centerline(ribbons));
    ribbons.setIntensity(0.35);
    ribbons.update(0, CAMERA_POSITION);
    const reducedLength = pathLength(centerline(ribbons));
    expect(reducedLength).toBeGreaterThan(0);
    expect(reducedLength).toBeLessThan(fullLength * 0.5);
    ribbons.dispose();
  });

  it('clears a hidden trail and grows a fresh one on the next request', () => {
    const ribbons = createOrbitRibbons();
    warmUp(ribbons);
    const fullLength = pathLength(centerline(ribbons));
    ribbons.setIntensity(0);
    expect(vertices(ribbons)).toHaveLength(0);
    ribbons.setIntensity(1);
    ribbons.update(1 / 60, CAMERA_POSITION);
    expect(pathLength(centerline(ribbons))).toBeLessThan(fullLength * 0.1);
    ribbons.dispose();
  });

  it('moves the gradient over time while retaining a gradient along the trail', () => {
    const ribbons = createOrbitRibbons();
    warmUp(ribbons);
    const mesh = ribbons.group.children[0] as Mesh;
    const colors = mesh.geometry.getAttribute('color');
    const initialTail = Array.from(colors.array.slice(0, 3));
    ribbons.update(0.5, CAMERA_POSITION);
    expect(Array.from(colors.array.slice(0, 3))).not.toEqual(initialTail);
    const headIndex = (mesh.geometry.drawRange.count / 6) * 6;
    expect(Array.from(colors.array.slice(headIndex, headIndex + 3)))
      .not.toEqual(Array.from(colors.array.slice(0, 3)));
    ribbons.dispose();
  });

  it('disposes without throwing', () => {
    const ribbons = createOrbitRibbons();
    warmUp(ribbons);
    expect(() => ribbons.dispose()).not.toThrow();
  });
});

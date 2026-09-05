/**
 * 生成时的彩带环绕动画。
 *
 * 参考 blessonism/grok-icon-study 的 loading / particle ribbon 动效节奏：
 * 相近轨道上的彩带同向追随，启动时加速再回落，圆头拖尾沿长度和时间渐变。
 * 网格按弧长采样，不按渲染帧存历史，避免高刷新率下拖尾变短。
 *
 * 轨道方程与参考实现逐项对应（replica/src/fx.js 的 project / depth）：
 *   X = rad * sin(lam)
 *   Y = -rad * cos(lam) * sin(tilt)
 *   Z =  rad * cos(lam) * cos(tilt)      // 深度：>0 在球前，<0 在球后
 * 再绕 Z 轴按 roll 旋转。可以验证 X²+Y²+Z² = rad²，即轨道是半径 rad 的三维圆。
 *
 * 参考实现是 2D SVG，必须手动按深度把带子切成 front / back 两段分别绘制；
 * 这里是 3D 场景，球体会写深度，后半段自然被遮挡，不需要分段。
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';

const MAX_SEGMENTS = 64;
const SAMPLE_STEP = 0.05;
const CAP_SEGMENTS = 6;
const MAX_PAIRS = MAX_SEGMENTS + 1 + CAP_SEGMENTS * 2;
const HIDDEN_INTENSITY = 0.002;

interface BeltConfig {
  /** 轨道半径。 */
  radius: number;
  /** 0 为侧对观察者的窄椭圆，PI/2 为正对观察者的圆。 */
  tilt: number;
  /** 绕视线轴的旋转（弧度），决定椭圆长轴的朝向。 */
  roll: number;
  /** 跟随公共旋转的比例，以及独立的小幅角速度。 */
  follow: number;
  drift: number;
  phase: number;
  delay: number;
  /** 拖尾弧长（弧度）。 */
  arc: number;
  /** 起始色相（度）。 */
  hue: number;
  /** 拖尾上的色相跨度（度），正负决定渐变方向。 */
  hueSpan: number;
  hueVelocity: number;
  /** 带子最大宽度。 */
  width: number;
}

/**
 * loading 使用同一主轨道、相近倾角和错开的起点，形成有层次的追随。
 * 半径从绒毛外缘向外留出间隙；最外圈也留在 35° / 5.35 的相机视野内。
 */
const BELT_CONFIGS: readonly BeltConfig[] = [
  { radius: 1.29, tilt: 0.32, roll: 0.28, follow: 0.86, drift: 0.64, phase: 0.3, delay: 0, arc: 2.65, hue: 145, hueSpan: 62, hueVelocity: 22, width: 0.145 },
  { radius: 1.36, tilt: 0.38, roll: 0.34, follow: 0.9, drift: 0.56, phase: 1.9, delay: 0.09, arc: 2.45, hue: 265, hueSpan: -78, hueVelocity: -18, width: 0.13 },
  { radius: 1.43, tilt: 0.35, roll: 0.23, follow: 0.82, drift: 0.72, phase: 3.5, delay: 0.18, arc: 2.8, hue: 25, hueSpan: 84, hueVelocity: 26, width: 0.14 },
  { radius: 1.5, tilt: 0.42, roll: 0.31, follow: 0.88, drift: 0.6, phase: 5.1, delay: 0.27, arc: 2.55, hue: 190, hueSpan: -54, hueVelocity: -24, width: 0.125 },
];

interface Belt extends BeltConfig {
  geometry: BufferGeometry;
  material: MeshBasicMaterial;
  positions: Float32Array;
  colors: Float32Array;
}

/** 轨道上角度 lam 处的三维坐标，与参考实现的 project 逐项对应。 */
function orbitPoint(belt: BeltConfig, lam: number, target: Vector3): Vector3 {
  const sin = Math.sin(lam);
  const cos = Math.cos(lam);
  const x = belt.radius * sin;
  const y = -belt.radius * cos * Math.sin(belt.tilt);
  const z = belt.radius * cos * Math.cos(belt.tilt);
  const c = Math.cos(belt.roll);
  const s = Math.sin(belt.roll);
  return target.set(x * c - y * s, x * s + y * c, z);
}

// 复用的临时向量，避免每帧给每个点都分配对象
const scratchPoint = new Vector3();
const scratchTangent = new Vector3();
const scratchView = new Vector3();
const scratchBinormal = new Vector3();
const scratchForward = new Vector3();
const scratchColor = new Color();

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

/** 平滑加速曲线的积分，让相同时间的轨道位置与帧率无关。 */
function spinAngle(time: number): number {
  const ramp = 0.45;
  const settle = 0.85;
  const peak = 6.8;
  const cruise = 3;
  const integral = (t: number) => t * t * t * (1 - t / 2);
  if (time <= ramp) return peak * ramp * integral(time / ramp);
  const afterRamp = Math.min(time - ramp, settle);
  const angle = peak * ramp / 2 + peak * afterRamp
    + (cruise - peak) * settle * integral(afterRamp / settle);
  const steadyTime = Math.max(0, time - ramp - settle);
  return angle + cruise * steadyTime + 0.4 * (1 - Math.cos(steadyTime * 0.6));
}

export interface OrbitRibbons {
  group: Group;
  /** 推进运动并重建带子网格，dt 单位为秒。 */
  update: (dt: number, cameraPosition: Vector3) => void;
  /**
   * 整体强度（0~1）。控制弧长、宽度与不透明度，归零时清空本轮轨迹。
   */
  setIntensity: (intensity: number) => void;
  dispose: () => void;
}

export function createOrbitRibbons(): OrbitRibbons {
  const group = new Group();
  const belts: Belt[] = [];

  // 中线采样点和两端圆帽都用顶点对，索引与缓冲区仅分配一次。
  const indices: number[] = [];
  for (let i = 0; i < MAX_PAIRS - 1; i += 1) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = i * 2 + 2;
    const d = i * 2 + 3;
    indices.push(a, b, c, b, d, c);
  }

  for (const config of BELT_CONFIGS) {
    const positions = new Float32Array(MAX_PAIRS * 2 * 3);
    const colors = new Float32Array(MAX_PAIRS * 2 * 3);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage));
    geometry.setAttribute('color', new BufferAttribute(colors, 3).setUsage(DynamicDrawUsage));
    geometry.setIndex(indices);
    geometry.setDrawRange(0, 0);

    const material = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      toneMapped: false,
      // 不写深度：带子之间不会互相切出硬边；球体写了深度，所以后面的段依然会被球挡住
      depthWrite: false,
      side: DoubleSide,
    });

    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false; // 顶点每帧变动，包围盒不可靠
    mesh.renderOrder = 3;
    group.add(mesh);

    belts.push({
      ...config,
      geometry,
      material,
      positions,
      colors,
    });
  }

  group.visible = false;

  function rebuild(belt: Belt, cameraPosition: Vector3, intensity: number): void {
    const age = Math.max(0, elapsed - belt.delay);
    const travel = spinAngle(age) * belt.follow + belt.drift * age;
    const head = belt.phase + travel;
    const arc = Math.min(belt.arc, travel) * smoothstep(intensity);
    if (arc < 0.005) {
      belt.geometry.setDrawRange(0, 0);
      return;
    }

    const segments = Math.min(MAX_SEGMENTS, Math.max(2, Math.ceil(arc / SAMPLE_STEP)));
    const growth = smoothstep(age / 0.34);
    const width = Math.min(belt.width, belt.radius * arc * 0.34) * growth * intensity;
    const { positions, colors } = belt;
    let pairs = 0;
    const writePair = (lam: number, progress: number, capOffset = 0, capWidth = 1) => {
      const point = orbitPoint(belt, lam, scratchPoint);
      // 圆轨道的导数等于相位前移 PI/2 的向量，避免首尾使用单边差分产生折角。
      orbitPoint(belt, lam + Math.PI / 2, scratchTangent).normalize();

      // 彩带和圆帽处在面向相机的局部平面上，转到侧面也不会突然变成薄片。
      scratchView.subVectors(cameraPosition, point).normalize();
      scratchBinormal.crossVectors(scratchTangent, scratchView);
      if (scratchBinormal.lengthSq() < 1e-12) scratchBinormal.set(0, 1, 0);
      scratchBinormal.normalize();
      scratchForward.crossVectors(scratchView, scratchBinormal).normalize();

      const depthScale = 0.72 + 0.28 * Math.max(0, point.z / belt.radius);
      const radius = width * (0.5 + 0.5 * progress) * depthScale / 2;
      point.addScaledVector(scratchForward, radius * capOffset);
      const halfWidth = radius * capWidth;

      const base = pairs * 6;
      positions[base] = point.x + scratchBinormal.x * halfWidth;
      positions[base + 1] = point.y + scratchBinormal.y * halfWidth;
      positions[base + 2] = point.z + scratchBinormal.z * halfWidth;
      positions[base + 3] = point.x - scratchBinormal.x * halfWidth;
      positions[base + 4] = point.y - scratchBinormal.y * halfWidth;
      positions[base + 5] = point.z - scratchBinormal.z * halfWidth;

      // CSS 的 HSL 是 sRGB；显式转换到线性顶点色，避免输出时二次提亮而发白。
      const hue = ((belt.hue + age * belt.hueVelocity + progress * belt.hueSpan) % 360 + 360) % 360;
      scratchColor.setHSL(hue / 360, 0.56, 0.56 + 0.11 * progress, SRGBColorSpace);
      colors[base] = scratchColor.r;
      colors[base + 1] = scratchColor.g;
      colors[base + 2] = scratchColor.b;
      colors[base + 3] = scratchColor.r;
      colors[base + 4] = scratchColor.g;
      colors[base + 5] = scratchColor.b;
      pairs += 1;
    };

    // 用半圆截面封口，头尾没有原先的平切断面。
    for (let i = 0; i < CAP_SEGMENTS; i += 1) {
      const angle = (i / CAP_SEGMENTS - 1) * Math.PI / 2;
      writePair(head - arc, 0, Math.sin(angle), Math.cos(angle));
    }
    for (let i = 0; i <= segments; i += 1) {
      const progress = i / segments;
      writePair(head - arc + arc * progress, progress);
    }
    for (let i = 1; i <= CAP_SEGMENTS; i += 1) {
      const angle = i / CAP_SEGMENTS * Math.PI / 2;
      writePair(head, 1, Math.sin(angle), Math.cos(angle));
    }

    belt.geometry.setDrawRange(0, (pairs - 1) * 6);
    (belt.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (belt.geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }

  let intensity = 0;
  let elapsed = 0;

  return {
    group,
    update(dt: number, cameraPosition: Vector3) {
      if (intensity === 0) return;
      if (Number.isFinite(dt)) elapsed += Math.max(0, dt);
      for (const belt of belts) {
        rebuild(belt, cameraPosition, intensity);
      }
    },
    setIntensity(next: number) {
      intensity = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : 0;
      if (intensity <= HIDDEN_INTENSITY) {
        intensity = 0;
        elapsed = 0;
        for (const belt of belts) belt.geometry.setDrawRange(0, 0);
      }
      for (const belt of belts) belt.material.opacity = intensity;
    },
    dispose() {
      for (const belt of belts) {
        belt.geometry.dispose();
        belt.material.dispose();
      }
      group.clear();
    },
  };
}

/**
 * 生成时的彩带环绕动画。
 *
 * 对照 blessonism/grok-icon-study 的 fx.js 里 particle ribbon 部分复刻：
 * 几条彩带各自沿一个倾斜的 3D 圆轨道运动，身后拖出一段带状轨迹，
 * 带子从头到尾由细变粗、色相渐变，绕到球体背面的部分被球挡住。
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
  Group,
  Mesh,
  MeshBasicMaterial,
  Vector3,
} from 'three';

/**
 * 单条彩带保留的历史点上限。参考实现是 48，但它的角速度只有 0.5~1.1 rad/s；
 * 这里提速后单帧转过的角度更大，48 个点铺不满设定的 arc 会把拖尾截短，
 * 因此按最快的一条带子（2.3 rad/s、60fps、arc 2.4）取 72。
 */
const MAX_HISTORY = 72;
/** 相邻历史点的最大角间距（弧度）。角速度大时一帧要补多个点，否则带子会变成折线。 */
const SAMPLE_STEP = 0.09;
/** 一次最多补的点数，防止卡帧后一帧补出一整圈。 */
const MAX_SAMPLE_PER_FRAME = 24;

interface BeltConfig {
  /** 轨道半径。 */
  radius: number;
  /** 轨道平面倾角（弧度）：0 为正对观察者，越大越扁。 */
  tilt: number;
  /** 绕视线轴的旋转（弧度），决定椭圆长轴的朝向。 */
  roll: number;
  /** 沿轨道的角速度（弧度/秒），正负决定绕行方向。 */
  lamVel: number;
  /** 拖尾弧长（弧度）。 */
  arc: number;
  /** 起始色相（度）。 */
  hue: number;
  /** 拖尾上的色相跨度（度），正负决定渐变方向。 */
  hueSpan: number;
  /** 带子最大宽度。 */
  width: number;
}

/**
 * 四条彩带。半径都在球体（半径 1）之外且在相机视野内
 * （FOV 35°、距离 5 时可视半高约 1.58），绕行方向正负交替。
 */
const BELT_CONFIGS: readonly BeltConfig[] = [
  { radius: 1.17, tilt: 0.22, roll: 0.15, lamVel: 1.6, arc: 2.6, hue: 145, hueSpan: 62, width: 0.2 },
  { radius: 1.24, tilt: 0.38, roll: 1.02, lamVel: -1.95, arc: 3.0, hue: 265, hueSpan: -78, width: 0.18 },
  { radius: 1.31, tilt: 0.3, roll: 1.94, lamVel: 2.3, arc: 2.4, hue: 25, hueSpan: 84, width: 0.19 },
  { radius: 1.38, tilt: 0.46, roll: 2.78, lamVel: -1.5, arc: 3.2, hue: 190, hueSpan: -54, width: 0.17 },
];

interface HistoryPoint {
  position: Vector3;
  lam: number;
}

interface Belt extends BeltConfig {
  /** 当前沿轨道的角度。 */
  lam: number;
  history: HistoryPoint[];
  mesh: Mesh;
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
const scratchPrev = new Vector3();
const scratchNext = new Vector3();
const scratchTangent = new Vector3();
const scratchView = new Vector3();
const scratchBinormal = new Vector3();
const scratchColor = new Color();

export interface OrbitRibbons {
  group: Group;
  /** 推进运动并重建带子网格，dt 单位为秒。 */
  update: (dt: number, cameraPosition: Vector3) => void;
  /**
   * 整体强度（0~1）。同时影响宽度与不透明度，
   * 这样淡入时带子是由细长到饱满，而不是整体突然变亮。
   */
  setIntensity: (intensity: number) => void;
  dispose: () => void;
}

export function createOrbitRibbons(): OrbitRibbons {
  const group = new Group();
  const belts: Belt[] = [];

  // 顶点按「每个历史点两个」排布，索引固定预生成，靠 drawRange 控制实际绘制长度
  const indices: number[] = [];
  for (let i = 0; i < MAX_HISTORY - 1; i += 1) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = i * 2 + 2;
    const d = i * 2 + 3;
    indices.push(a, b, c, b, d, c);
  }

  for (const config of BELT_CONFIGS) {
    const positions = new Float32Array(MAX_HISTORY * 2 * 3);
    const colors = new Float32Array(MAX_HISTORY * 2 * 3);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.setDrawRange(0, 0);

    const material = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
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
      lam: 0,
      history: [],
      mesh,
      geometry,
      material,
      positions,
      colors,
    });
  }

  group.visible = false;

  /**
   * 推进历史点，与参考实现（fx.js step 中 orbit 分支）逐行对应。
   *
   * 每帧都会补点，点间距就是这一帧走过的角度 —— 这样头部点始终落在粒子
   * 当前位置上，带子才是连续曲线。卡帧时按 SAMPLE_STEP 为上限补中间点，
   * 避免一帧跨过太大角度把带子拉成折线。
   */
  function sample(belt: Belt): void {
    const history = belt.history;
    const lastLam = history.length ? history[history.length - 1].lam : belt.lam;
    const delta = belt.lam - lastLam;
    const steps = Math.min(Math.ceil(Math.abs(delta) / SAMPLE_STEP), MAX_SAMPLE_PER_FRAME);
    for (let s = 1; s <= steps; s += 1) {
      const lam = lastLam + (delta * s) / steps;
      history.push({ position: orbitPoint(belt, lam, new Vector3()), lam });
    }
    // delta 为 0 时上面一个点都不会补，保证至少有一个起点
    if (!history.length) {
      history.push({ position: orbitPoint(belt, belt.lam, new Vector3()), lam: belt.lam });
    }
    // 尾部只保留 arc 弧度长的一段
    while (history.length > 2 && Math.abs(belt.lam - history[0].lam) > belt.arc) {
      history.shift();
    }
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  }

  function rebuild(belt: Belt, cameraPosition: Vector3, intensity: number): void {
    const history = belt.history;
    const count = history.length;
    if (count < 2) {
      belt.geometry.setDrawRange(0, 0);
      return;
    }

    const { positions, colors } = belt;
    for (let i = 0; i < count; i += 1) {
      const point = history[i].position;
      scratchPrev.copy(history[Math.max(i - 1, 0)].position);
      scratchNext.copy(history[Math.min(i + 1, count - 1)].position);
      scratchTangent.subVectors(scratchNext, scratchPrev);
      if (scratchTangent.lengthSq() < 1e-12) scratchTangent.set(1, 0, 0);
      scratchTangent.normalize();

      // 宽度方向取「切线 × 视线」，带子始终正对相机，视觉宽度不随轨道角度变化
      scratchView.subVectors(cameraPosition, point).normalize();
      scratchBinormal.crossVectors(scratchTangent, scratchView);
      if (scratchBinormal.lengthSq() < 1e-12) scratchBinormal.set(0, 1, 0);
      scratchBinormal.normalize();

      // 尾部细、头部粗：t=0 是最早的点（尾），t=1 是粒子当前位置（头）
      const t = count > 1 ? i / (count - 1) : 1;
      const halfWidth = (belt.width * (0.5 + 0.5 * t) * intensity) / 2;

      const base = i * 6;
      positions[base] = point.x + scratchBinormal.x * halfWidth;
      positions[base + 1] = point.y + scratchBinormal.y * halfWidth;
      positions[base + 2] = point.z + scratchBinormal.z * halfWidth;
      positions[base + 3] = point.x - scratchBinormal.x * halfWidth;
      positions[base + 4] = point.y - scratchBinormal.y * halfWidth;
      positions[base + 5] = point.z - scratchBinormal.z * halfWidth;

      // 色相沿拖尾渐变，亮度也略微提升，与参考实现的 hsl 渐变一致
      const hue = (((belt.hue + t * belt.hueSpan) % 360) + 360) % 360;
      scratchColor.setHSL(hue / 360, 0.56, 0.56 + 0.11 * t);
      colors[base] = scratchColor.r;
      colors[base + 1] = scratchColor.g;
      colors[base + 2] = scratchColor.b;
      colors[base + 3] = scratchColor.r;
      colors[base + 4] = scratchColor.g;
      colors[base + 5] = scratchColor.b;
    }

    belt.geometry.setDrawRange(0, (count - 1) * 6);
    (belt.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (belt.geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }

  let intensity = 0;

  return {
    group,
    update(dt: number, cameraPosition: Vector3) {
      for (const belt of belts) {
        belt.lam += belt.lamVel * dt;
        sample(belt);
        rebuild(belt, cameraPosition, intensity);
      }
    },
    setIntensity(next: number) {
      intensity = next;
      for (const belt of belts) belt.material.opacity = next;
    },
    dispose() {
      for (const belt of belts) {
        belt.geometry.dispose();
        belt.material.dispose();
        belt.history.length = 0;
      }
    },
  };
}

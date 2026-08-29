/**
 * Mascot — Three.js 吉祥物
 *
 * 一个带短绒毛的柔和圆球，会自然眨眼，眼睛跟随鼠标方向，
 * 鼠标悬浮在球体上时整体高亮。
 *
 * 待机时有小动作：光标静止一会儿后自主张望、偶尔歪头、偶尔二连眨或眨单眼，
 * 呼吸浮动上叠了一层轻微的挤压拉伸。
 * 状态切换时给一次肢体反应：成功蹦一下，失败摇头，思考时轻微歪头。
 *
 * 请求模型时（loading=true）球体本体逐面炸裂、飞散成粒子云；
 * 完成后再平滑还原为圆球。
 *
 * 用法：放进任意有尺寸的容器即可（组件会铺满父级）。
 *   <div style={{ width: 480, height: 480 }}>
 *     <Mascot loading={isLoading} />
 *   </div>
 */
import { useEffect, useRef, type RefObject } from 'react';
import { gsap } from 'gsap';
import { createOrbitRibbons, type OrbitRibbons } from './mascotOrbitRibbons';
import {
  REACTION_DURATIONS,
  getReactionPose,
  getSquashWidth,
  pickNextGazeIndex,
  type MascotReactionKind,
} from './mascotMotion';
import {
  SPRING_PRESETS,
  createSpringState,
  exponentialApproach,
  rateFromLerp,
  resetSpring,
  stepSpring,
  type SpringState,
} from './mascotSpring';
import {
  EYE_FRAGMENT_SHADER,
  EYE_PLANE_HEIGHT,
  EYE_PLANE_WIDTH,
  EYE_VERTEX_SHADER,
  applyEyeShape,
  createEyeUniforms,
  type EyeUniforms,
} from './mascotEyeShader';
import {
  EXPRESSIONS,
  EXPRESSION_LENGTH,
  EYE_STRIDE,
  createExpressionVector,
  flattenExpression,
  readBodyPose,
  readEyeExpression,
  type BodyPose,
  type EyeExpression,
  type ExpressionId,
} from './mascotExpressions';
import {
  advanceClip,
  createClipState,
  isGazeLocked,
  requestClip,
  sampleClipVector,
  type MascotClipId,
} from './mascotClips';
import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  HemisphereLight,
  DirectionalLight,
  AmbientLight,
  Group,
  MeshPhysicalMaterial,
  ShaderMaterial,
  Color,
  Mesh,
  InstancedMesh,
  SphereGeometry,
  PlaneGeometry,
  MeshBasicMaterial,
  ShapeGeometry,
  Shape,
  Vector2,
  Raycaster,
  MathUtils,
  Matrix4,
  DataTexture,
  RGBAFormat,
  UnsignedByteType,
  RepeatWrapping,
  LinearFilter,
  Timer,
} from 'three';

/* ── 可调参数 ── */
const SPHERE_RADIUS = 1;
const EYE_MAX_ANGLE = 0.42; // 眼睛跟随鼠标的最大偏转（弧度）
/** 眼睛在球面上的基准高度，表情里的 offsetY 叠加在它之上。 */
const EYE_BASE_Y = 0.04;
const HEAD_MAX_ANGLE = 0.12; // 头部跟随鼠标的轻微转动
const FOLLOW_LERP = 0.12; // 跟随平滑系数（沿用旧手感，换算成帧率无关的速率后使用）
const FOLLOW_RATE = rateFromLerp(FOLLOW_LERP);
const BLINK_MIN = 2.2; // 两次眨眼最小间隔（秒）
const BLINK_MAX = 5.5; // 两次眨眼最大间隔（秒）
const BLINK_DURATION = 0.13; // 单次眨眼时长（秒）
// 限帧：Tauri 透明窗口下 rAF 不受垂直同步限制（实测 ~1700Hz），必须自行限频，
// 否则渲染循环以每秒上千次全速跑满主线程
const IDLE_FPS = 30;
const ACTIVE_FPS = 60;
const POINTER_ACTIVITY_MS = 250;
const STATUS_TRANSITION_ACTIVE_MS = 320;
const THINKING_POINTER_PRIORITY_MS = 900;
const THINKING_GAZE_LERP = 0.2;
const THINKING_GAZE_RATE = rateFromLerp(THINKING_GAZE_LERP);
const THINKING_GAZE_MIN_INTERVAL = 0.8;
const THINKING_GAZE_MAX_INTERVAL = 1.4;
const FUR_SHELL_COUNT = 48;
const FUR_LENGTH = 0.22;
const FUR_NOISE_SIZE = 128;
const FUR_NOISE_SCALE = 1.5;
const FUR_DRAG_BEND = 0.72;
const FUR_DRAG_SPRING = 90;
const FUR_DRAG_DAMPING = 11;
const FUR_DRAG_REST_THRESHOLD = 0.002;

const THINKING_GAZE_POINTS = [
  [-0.34, 0.2],
  [0.28, 0.3],
  [0.16, -0.04],
  [-0.16, 0.34],
  [0.04, 0.1],
] as const;

/* ── 待机小动作 ── */
// 光标静止这么久之后，视线从「跟随」切成「自主张望」。比思考态放得更宽，
// 免得用户只是停下来看画布就被吉祥物移开视线。
const IDLE_GAZE_DELAY_MS = 2600;
const IDLE_GAZE_MIN_INTERVAL = 1.8;
const IDLE_GAZE_MAX_INTERVAL = 3.4;
const IDLE_GAZE_LERP = 0.06;
const IDLE_GAZE_RATE = rateFromLerp(IDLE_GAZE_LERP);
// 待机张望比思考时看得更远，视线幅度也更大
const IDLE_GAZE_POINTS = [
  [-0.62, 0.12],
  [0.58, 0.2],
  [0.3, -0.3],
  [-0.4, -0.22],
  [0.1, 0.42],
  [-0.12, -0.36],
] as const;
const IDLE_TILT_MIN_INTERVAL = 6;
const IDLE_TILT_MAX_INTERVAL = 11;
const IDLE_TILT_HOLD = 1.3; // 单次歪头保持时长（秒）
const IDLE_TILT_ANGLE = 0.09;
const HEAD_ROLL_LERP = 0.05;
const HEAD_ROLL_RATE = rateFromLerp(HEAD_ROLL_LERP);
const BREATH_SQUASH = 0.012;
const DOUBLE_BLINK_CHANCE = 0.18;
const DOUBLE_BLINK_GAP = 0.22; // 二连眨的两下之间的间隔（秒）
const WINK_CHANCE = 0.12;

type MascotTheme = 'dark' | 'light';
export type MascotStatus = 'idle' | 'thinking' | 'success' | 'error';

/**
 * 业务状态对应的常驻表情。
 *
 * 这是「没有片段播放时」的表情，也是片段播完后的回落目标。
 * 原来的 EYE_POSES 把眼型压成 scale/rotate 三个数字，已被 EXPRESSIONS 取代。
 */
const STATUS_EXPRESSIONS: Record<MascotStatus, ExpressionId> = {
  idle: 'neutral',
  thinking: 'thinking',
  success: 'success',
  error: 'error',
};

const STATUS_COLORS: Record<Exclude<MascotStatus, 'idle'>, number> = {
  thinking: 0x7ea6ff,
  success: 0x57c7a2,
  error: 0xd98282,
};

const DEFAULT_RIM_COLOR = 0xa8b3ff;

const MASCOT_PALETTE: Record<MascotTheme, {
  body: number;
  eyes: number;
  emissive: number;
  roughness: number;
  metalness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  opacity: number;
  rimLightIntensity: number;
  hoverEmissiveIntensity: number;
  hoverKeyLightIntensity: number;
  shadow: number;
  shadowOpacity: number;
  statusEmissiveIntensity: number;
  statusRimBoost: number;
}> = {
  dark: {
    body: 0xe9eaee,
    eyes: 0x1a1a1f,
    emissive: 0x8a93ff,
    roughness: 0.62,
    metalness: 0,
    clearcoat: 0,
    clearcoatRoughness: 0.5,
    opacity: 1,
    rimLightIntensity: 0,
    hoverEmissiveIntensity: 0.32,
    hoverKeyLightIntensity: 1.9,
    shadow: 0x000000,
    shadowOpacity: 0.08,
    statusEmissiveIntensity: 0.12,
    statusRimBoost: 0.16,
  },
  light: {
    body: 0x858c98,
    eyes: 0xf7f9fc,
    emissive: 0xaab4c6,
    roughness: 0.55,
    metalness: 0.12,
    clearcoat: 0.08,
    clearcoatRoughness: 0.62,
    opacity: 1,
    rimLightIntensity: 0.35,
    hoverEmissiveIntensity: 0.06,
    hoverKeyLightIntensity: 1.6,
    shadow: 0x596271,
    shadowOpacity: 0.12,
    statusEmissiveIntensity: 0.09,
    statusRimBoost: 0.1,
  },
};

function createFurNoiseTexture() {
  const data = new Uint8Array(FUR_NOISE_SIZE * FUR_NOISE_SIZE * 4);
  const randomAt = (x: number, y: number, seed: number) => {
    let value = Math.imul(x + 1, 374761393)
      ^ Math.imul(y + 1, 668265263)
      ^ seed;
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff;
  };

  for (let y = 0; y < FUR_NOISE_SIZE; y += 1) {
    for (let x = 0; x < FUR_NOISE_SIZE; x += 1) {
      const offset = (y * FUR_NOISE_SIZE + x) * 4;
      const strandSeed = randomAt(x, y, 0x51f15e);
      const strandLength = strandSeed > 0.52
        ? 0.72 + Math.pow(randomAt(x, y, 0x7f4a7c), 0.65) * 0.28
        : 0;
      const colorVariation = randomAt(x, y, 0x9e3779);
      data[offset] = Math.round(strandLength * 255);
      data[offset + 1] = Math.round(colorVariation * 255);
      data[offset + 2] = 255;
      data[offset + 3] = 255;
    }
  }

  const texture = new DataTexture(
    data,
    FUR_NOISE_SIZE,
    FUR_NOISE_SIZE,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

const FUR_VERTEX_SHADER = `
uniform float uFurLength;
uniform vec2 uDragForce;

varying vec2 vFurUv;
varying vec3 vFurNormal;
varying float vFurLayer;

void main() {
  float shellScale = 1.0;
  vec4 shellPosition = vec4(position, 1.0);

  #ifdef USE_INSTANCING
    shellScale = length(instanceMatrix[0].xyz);
  #endif

  vFurLayer = clamp((shellScale - 1.0) / uFurLength, 0.0, 1.0);
  vec3 furDirection = normalize(normal + vec3(0.08, -0.2, 0.0));
  float strandHeight = length(position) * uFurLength * vFurLayer;
  vec3 dragDirection = vec3(-uDragForce.x, uDragForce.y, 0.0);
  vec3 dragBend = dragDirection * strandHeight * vFurLayer * ${FUR_DRAG_BEND.toFixed(2)};
  shellPosition = vec4(position + furDirection * strandHeight + dragBend, 1.0);
  vFurUv = uv;
  vFurNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * shellPosition;
}
`;

const FUR_FRAGMENT_SHADER = `
uniform sampler2D uFurNoise;
uniform vec3 uFurColor;
uniform vec3 uGlowColor;
uniform float uNoiseScale;
uniform float uSmoothness;
uniform float uOpacity;
uniform float uGlow;

varying vec2 vFurUv;
varying vec3 vFurNormal;
varying float vFurLayer;

void main() {
  vec4 noiseSample = texture2D(uFurNoise, vFurUv * uNoiseScale);
  float strandLength = max(noiseSample.r, 0.02);
  float strandPosition = vFurLayer / strandLength;
  if (strandPosition >= 1.0) discard;

  float alpha = pow(1.0 - strandPosition, uSmoothness) * uOpacity;
  if (alpha < 0.02) discard;

  vec3 normal = normalize(vFurNormal);
  vec3 lightDirection = normalize(vec3(-0.48, 0.72, 1.0));
  float diffuse = max(dot(normal, lightDirection), 0.0);
  float rim = pow(1.0 - abs(normal.z), 2.2);
  float variation = mix(0.94, 1.02, noiseSample.g);
  float rootShade = mix(0.72, 1.0, strandPosition * strandPosition);
  vec3 color = uFurColor * (0.72 + 0.25 * diffuse + 0.08 * rim) * variation * rootShade;
  color += uGlowColor * uGlow * (0.18 + 0.34 * rim);

  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** 通过 ref 暴露的命令式接口，用来触发一次性动画片段。 */
export interface MascotHandle {
  /** 请求播放片段。返回是否真的播放 —— 优先级不够时会被当前片段挡下。 */
  playClip: (id: MascotClipId) => boolean;
}

interface MascotProps {
  /** 请求模型中 → 球体炸裂成粒子云 */
  loading?: boolean;
  /** 当前助手状态，用于眼神与低强度状态色反馈 */
  status?: MascotStatus;
  /** 根据界面主题切换球体明暗，保证背景对比度 */
  theme?: MascotTheme;
  /** 遵循系统减弱动态偏好，保留状态反馈但移除空间运动 */
  reduceMotion?: boolean;
  /** 读取拖拽速度形成的受力，不触发 React 逐帧重渲染 */
  getDragForce?: () => { x: number; y: number; active: boolean };
  /** 拿到播放句柄以触发动画片段，例如窗口重新聚焦时播放「醒来」 */
  handleRef?: RefObject<MascotHandle | null>;
}

export default function Mascot({
  loading = false,
  status = 'idle',
  theme = 'dark',
  reduceMotion = false,
  getDragForce,
  handleRef,
}: MascotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 句柄本身保持稳定，playClip 在场景建好后填进去，避免父组件拿到半成品
  const handle = useRef<MascotHandle>({ playClip: () => false });
  // 把最新 loading 放进 ref，供常驻渲染循环读取（避免重建场景）
  const loadingRef = useRef(loading);
  const statusRef = useRef(status);
  const statusChangedAtRef = useRef(0);
  const themeRef = useRef(theme);
  const reduceMotionRef = useRef(reduceMotion);
  const getDragForceRef = useRef(getDragForce);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);
  useEffect(() => {
    if (statusRef.current !== status) {
      statusRef.current = status;
      statusChangedAtRef.current = performance.now();
    }
  }, [status]);
  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);
  useEffect(() => {
    reduceMotionRef.current = reduceMotion;
  }, [reduceMotion]);
  useEffect(() => {
    getDragForceRef.current = getDragForce;
  }, [getDragForce]);

  useEffect(() => {
    if (!handleRef) return undefined;
    const api = handle.current;
    handleRef.current = api;
    return () => {
      // 只在仍然指向自己设置的对象时才清空，避免覆盖调用方后来的赋值
      if (handleRef.current === api) handleRef.current = null;
    };
  }, [handleRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;

    /* ── 场景 / 相机 / 渲染器 ── */
    const scene = new Scene();

    const camera = new PerspectiveCamera(35, width / height, 0.1, 100);
    camera.position.set(0, 0, 5);

    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    let appliedTheme = themeRef.current;
    const initialPalette = MASCOT_PALETTE[appliedTheme];

    /* ── 灯光：半球光给出柔和的上亮下暗过渡，方向光给出高光 ── */
    const hemiLight = new HemisphereLight(0xffffff, 0x202028, 1.05);
    scene.add(hemiLight);

    const keyLight = new DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(-1.4, 2.2, 2.5);
    scene.add(keyLight);

    // 浅色主题用冷色侧光勾出珍珠烟灰轮廓；暗色主题下强度为 0。
    const rimLight = new DirectionalLight(DEFAULT_RIM_COLOR, initialPalette.rimLightIntensity);
    rimLight.position.set(2.4, 0.8, 3);
    scene.add(rimLight);

    const ambient = new AmbientLight(0xffffff, 0.18);
    scene.add(ambient);

    /* ── 头部组（整体可轻微转动）── */
    const head = new Group();
    scene.add(head);

    /* ── 球体内核：负责实体明暗、射线命中和加载形态 ── */
    const sphereMat = new MeshPhysicalMaterial({
      color: initialPalette.body,
      roughness: initialPalette.roughness,
      metalness: initialPalette.metalness,
      clearcoat: initialPalette.clearcoat,
      clearcoatRoughness: initialPalette.clearcoatRoughness,
      specularIntensity: 0.62,
      emissive: new Color(initialPalette.emissive),
      emissiveIntensity: 0, // 悬浮时提升
      // 不透明且写深度：生成态不再淡出球体，这样绕到球背面的彩带才会被正确遮挡。
      // 之前为了做粒子云过渡设的 transparent + depthWrite:false 会让彩带整个画在球前面。
      transparent: false,
      depthWrite: true,
    });
    const sphere = new Mesh(
      new SphereGeometry(SPHERE_RADIUS, 64, 64),
      sphereMat,
    );
    sphere.renderOrder = 1;
    head.add(sphere);

    /* ── 短绒：参考 shells 技术，以实例缩放把多层球面合并为一次绘制 ── */
    const furNoise = createFurNoiseTexture();
    const furGeometry = new SphereGeometry(SPHERE_RADIUS, 48, 32);
    const furUniforms = {
      uFurNoise: { value: furNoise },
      uFurColor: { value: new Color(initialPalette.body) },
      uGlowColor: { value: new Color(initialPalette.emissive) },
      uFurLength: { value: FUR_LENGTH },
      uDragForce: { value: new Vector2(0, 0) },
      uNoiseScale: { value: FUR_NOISE_SCALE },
      uSmoothness: { value: 0.9 },
      uOpacity: { value: 1 },
      uGlow: { value: 0 },
    };
    const furMat = new ShaderMaterial({
      uniforms: furUniforms,
      vertexShader: FUR_VERTEX_SHADER,
      fragmentShader: FUR_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
    });
    const fur = new InstancedMesh(furGeometry, furMat, FUR_SHELL_COUNT);
    const furMatrix = new Matrix4();
    for (let index = 0; index < FUR_SHELL_COUNT; index += 1) {
      const layer = (index + 1) / FUR_SHELL_COUNT;
      const scale = 1 + FUR_LENGTH * layer;
      furMatrix.makeScale(scale, scale, scale);
      fur.setMatrixAt(index, furMatrix);
    }
    fur.instanceMatrix.needsUpdate = true;
    fur.computeBoundingSphere();
    fur.renderOrder = 2;
    head.add(fur);

    const shadowShape = new Shape();
    shadowShape.absellipse(0, 0, 0.58, 0.11, 0, Math.PI * 2, false, 0);
    const shadowGeo = new ShapeGeometry(shadowShape, 32);
    const shadowMat = new MeshBasicMaterial({
      color: initialPalette.shadow,
      transparent: true,
      opacity: initialPalette.shadowOpacity,
      depthWrite: false,
    });
    const groundShadow = new Mesh(shadowGeo, shadowMat);
    groundShadow.position.set(0, -1.08, -0.4);
    groundShadow.renderOrder = -1;
    scene.add(groundShadow);

    /* ── 眼睛组：绕球心转动 → 眼睛在球面上滑动 = 看向鼠标 ── */
    const eyeGroup = new Group();
    head.add(eyeGroup);

    // 眼睛是 SDF 平面：形状由 uniform 决定，因此每只眼要独立一份材质，
    // 才能做出 < ○ > 这种左右不同形的表情。两眼共用同一个 Color 实例，
    // 主题切换时改一次就够。
    const eyeColor = new Color(initialPalette.eyes);
    const eyeGeo = new PlaneGeometry(EYE_PLANE_WIDTH, EYE_PLANE_HEIGHT);
    const eyeUniformsList: EyeUniforms[] = [];
    const eyeMaterials: ShaderMaterial[] = [];
    const eyes: Mesh[] = [];
    for (const sign of [-1, 1]) {
      const uniforms = createEyeUniforms(eyeColor);
      const eyeMat = new ShaderMaterial({
        uniforms,
        vertexShader: EYE_VERTEX_SHADER,
        fragmentShader: EYE_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
      });
      const eye = new Mesh(eyeGeo, eyeMat);
      eye.position.set(sign * 0.22, EYE_BASE_Y, SPHERE_RADIUS * 1.01);
      eye.renderOrder = 4;
      eyeGroup.add(eye);
      eyes.push(eye);
      eyeUniformsList.push(uniforms);
      eyeMaterials.push(eyeMat);
    }

    /* ── 鼠标 / 悬浮状态 ──
     * 默认监听整个窗口跟随光标；思考态在光标静止后切换为自主微扫视。
     * look 为相对吉祥物中心的方向 [-1,1]，以半个窗口尺寸为参考归一化。 */
    const look = new Vector2(0, 0); // 全局视线方向（目标）
    const localPointer = new Vector2(0, 0); // 画布内 NDC，仅用于悬浮检测
    // 自主张望：思考态与待机态共用一套落点调度，只是落点集合与节奏不同
    const wanderLook = new Vector2(0, 0);
    const wanderLookTarget = new Vector2(0, 0);
    let hovering = false;
    let lastPointerMoveAt = 0;
    let nextWanderAt = 0;
    let wanderIndex = -1;
    let wanderEngaged = false;
    let previousVisualStatus = statusRef.current;

    const raycaster = new Raycaster();
    const finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');

    const handlePointerMove = (e: PointerEvent) => {
      if (!finePointerQuery.matches || reduceMotionRef.current) {
        look.set(0, 0);
        hovering = false;
        return;
      }

      lastPointerMoveAt = performance.now();
      const rect = renderer.domElement.getBoundingClientRect();

      // 先做矩形命中，只有进入 100px 画布后才执行 Three.js 射线检测。
      const insideCanvas = e.clientX >= rect.left
        && e.clientX <= rect.right
        && e.clientY >= rect.top
        && e.clientY <= rect.bottom;
      if (insideCanvas) {
        localPointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        localPointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(localPointer, camera);
        hovering = raycaster.intersectObject(sphere, false).length > 0;
      } else {
        hovering = false;
      }

      // 全局视线：相对吉祥物中心的方向，归一化并夹紧
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const refX = Math.max(window.innerWidth * 0.5, 1);
      const refY = Math.max(window.innerHeight * 0.5, 1);
      look.x = MathUtils.clamp((e.clientX - cx) / refX, -1, 1);
      look.y = MathUtils.clamp(-(e.clientY - cy) / refY, -1, 1);
    };
    const handleWindowLeave = () => {
      look.set(0, 0); // 光标离开窗口 → 视线回正
      hovering = false;
    };
    window.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerleave', handleWindowLeave);
    window.addEventListener('blur', handleWindowLeave);

    /* ── 表情：片段给出目标，弹簧负责过去 ──
     * 目标向量每帧由片段采样，当前向量由弹簧逐分量追赶。
     * 眼型分量用偏硬的弹簧（跟手、不抖），身体分量用偏软的（保留回弹）。 */
    const clipState = createClipState();
    const expressionTarget = createExpressionVector();
    const expressionCurrent = createExpressionVector();
    flattenExpression(expressionCurrent, EXPRESSIONS.neutral);
    const expressionSprings: SpringState[] = Array.from(
      { length: EXPRESSION_LENGTH },
      (_, index) => createSpringState(expressionCurrent[index]),
    );
    const springConfigFor = (index: number) => (
      index < EYE_STRIDE * 2 ? SPRING_PRESETS.eye : SPRING_PRESETS.body
    );
    // 复用的读取缓冲，避免每帧给两个眼睛各分配一个对象
    const scratchEye: EyeExpression = {
      open: 1, curve: 0, slant: 0, width: 1, height: 1, rotationZ: 0, offsetY: 0,
    };
    const scratchBody: BodyPose = { squashY: 1, lift: 0, tilt: 0 };
    // 把命令对象捕获进局部变量，避免 cleanup 中直接读 handle.current 触发 eslint 警告
    const api = handle.current;
    api.playClip = (id) => requestClip(clipState, id);

    /* ── 眨眼调度 ── */
    let blink = 1; // 1 = 睁开, 0 = 闭合
    let nextBlinkAt = BLINK_MIN;
    let blinkStart = -1;
    let blinkEye = -1; // -1 = 双眼，0/1 = 只眨这一只（眨单眼）
    let pendingBlinks = 0; // 待补的连眨次数
    let blinkIsFollowUp = false;

    const startBlink = (now: number) => {
      blinkStart = now;
      // 连眨的第二下必须双眼，单眨眼连着来会显得抽搐
      blinkEye = !blinkIsFollowUp && Math.random() < WINK_CHANCE
        ? (Math.random() < 0.5 ? 0 : 1)
        : -1;
    };

    const scheduleBlink = (now: number) => {
      if (pendingBlinks > 0) {
        pendingBlinks -= 1;
        blinkIsFollowUp = true;
        nextBlinkAt = now + DOUBLE_BLINK_GAP;
        return;
      }
      blinkIsFollowUp = false;
      pendingBlinks = Math.random() < DOUBLE_BLINK_CHANCE ? 1 : 0;
      nextBlinkAt = now + BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
    };

    /* ── 歪头与状态转场反应 ── */
    let headRoll = 0;
    let idleTiltTarget = 0;
    let idleTiltUntil = 0;
    let nextIdleTiltAt = MathUtils.randFloat(IDLE_TILT_MIN_INTERVAL, IDLE_TILT_MAX_INTERVAL);
    let reactionKind: MascotReactionKind | null = null;
    let reactionStart = 0;

    /* ── LOADING 形态状态 ── */
    let orbitRibbons: OrbitRibbons | null = null;
    let creatingRibbons = false;
    const loadObj = { val: 0 }; // 0 = 圆球, 1 = 彩带环绕，gsap 驱动缓动过渡
    let loadTween: gsap.core.Tween | null = null;
    let prevLoadTarget = 0;
    let hoverScale = 1;
    // 头部偏航的「跟随鼠标」分量：过渡自转在 loadAmount 算出后再叠加，避免被自身 lerp 吃掉
    let headYaw = 0;
    const targetEmissiveColor = new Color(initialPalette.emissive);
    const targetRimColor = new Color(DEFAULT_RIM_COLOR);
    const dragForce = new Vector2(0, 0);
    const dragForceVelocity = new Vector2(0, 0);

    /* ── 渲染循环（限帧 + 后台暂停，同 NebulaBackground）── */
    const clock = new Timer();
    let raf = 0;
    let lastTime = 0;

    const render = (now: number) => {
      raf = requestAnimationFrame(render);
      if (document.hidden) return; // 窗口不可见时不渲染
      // React Flow 交互期间冻结装饰性 WebGL，优先保证节点拖拽与画布缩放帧率。
      if (document.documentElement.classList.contains('canvas-interacting')) return;
      const motionEnabled = !reduceMotionRef.current;
      const visualStatus = statusRef.current;
      const isHovering = motionEnabled && finePointerQuery.matches && hovering;
      const reportedDragForce = getDragForceRef.current?.();
      const dragMotionActive = motionEnabled && Boolean(
        reportedDragForce?.active
        || dragForce.lengthSq() > FUR_DRAG_REST_THRESHOLD * FUR_DRAG_REST_THRESHOLD
        || dragForceVelocity.lengthSq() > FUR_DRAG_REST_THRESHOLD * FUR_DRAG_REST_THRESHOLD,
      );
      const isActive = motionEnabled && (
        loadingRef.current
        || isHovering
        || dragMotionActive
        || blinkStart >= 0
        // 蹦跳/摇头比状态转场的 320ms 活跃窗口更长，不补这条后半段会掉回 30fps
        || reactionKind !== null
        || loadObj.val > 0.002
        || now - lastPointerMoveAt < POINTER_ACTIVITY_MS
        || now - statusChangedAtRef.current < STATUS_TRANSITION_ACTIVE_MS
      );
      const frameInterval = 1000 / (isActive ? ACTIVE_FPS : IDLE_FPS);
      const elapsed = now - lastTime;
      if (elapsed < frameInterval) return;
      lastTime = now - (elapsed % frameInterval);
      clock.update(); // Timer 必须每帧 update，否则 getElapsed 恒为 0
      const t = clock.getElapsed();

      // 帧间隔统一换算成秒：拖拽积分、片段推进和表情弹簧都要用同一个值
      const deltaSeconds = Math.min(elapsed / 1000, 1 / 30);
      // 片段进度要在视线逻辑之前推进：睡眠这类片段需要立刻锁住视线，不能晚一帧
      advanceClip(clipState, deltaSeconds);
      if (!motionEnabled) {
        dragForce.set(0, 0);
        dragForceVelocity.set(0, 0);
        // 减弱动态中途开启时，正在进行的蹦跳/摇头要立即收掉，否则位移和旋转会卡住不回正
        reactionKind = null;
      } else {
        const targetX = reportedDragForce?.active ? reportedDragForce.x : 0;
        const targetY = reportedDragForce?.active ? reportedDragForce.y : 0;
        dragForceVelocity.x += (
          (targetX - dragForce.x) * FUR_DRAG_SPRING
          - dragForceVelocity.x * FUR_DRAG_DAMPING
        ) * deltaSeconds;
        dragForceVelocity.y += (
          (targetY - dragForce.y) * FUR_DRAG_SPRING
          - dragForceVelocity.y * FUR_DRAG_DAMPING
        ) * deltaSeconds;
        dragForce.x += dragForceVelocity.x * deltaSeconds;
        dragForce.y += dragForceVelocity.y * deltaSeconds;

        if (!reportedDragForce?.active
          && dragForce.lengthSq() <= FUR_DRAG_REST_THRESHOLD * FUR_DRAG_REST_THRESHOLD
          && dragForceVelocity.lengthSq()
            <= FUR_DRAG_REST_THRESHOLD * FUR_DRAG_REST_THRESHOLD) {
          dragForce.set(0, 0);
          dragForceVelocity.set(0, 0);
        }
      }
      furUniforms.uDragForce.value.copy(dragForce);

      if (visualStatus !== previousVisualStatus) {
        wanderLook.set(0, 0);
        wanderLookTarget.set(0, 0);
        wanderIndex = -1;
        nextWanderAt = t;
        // 光靠眼型和颜色读不出成败，给一次一次性的肢体反应。
        if (motionEnabled && visualStatus === 'success') {
          reactionKind = 'hop';
          reactionStart = t;
        } else if (motionEnabled && visualStatus === 'error') {
          reactionKind = 'shake';
          reactionStart = t;
        }
        previousVisualStatus = visualStatus;
      }

      // 思考态与待机态都会在光标静止后自主张望，待机态等得更久、看得更远、节奏更慢。
      const isThinking = visualStatus === 'thinking';
      // 睡眠 / 打盹 / 放松期间角色不关注外界：视线回正，既不跟随鼠标也不自主张望
      const gazeLocked = isGazeLocked(clipState);
      const canWander = motionEnabled && (visualStatus === 'idle' || isThinking) && !gazeLocked;
      const wanderDelay = isThinking ? THINKING_POINTER_PRIORITY_MS : IDLE_GAZE_DELAY_MS;
      const wanderActive = canWander && now - lastPointerMoveAt >= wanderDelay;
      if (wanderActive && !wanderEngaged) nextWanderAt = t; // 刚接管视线就换个新落点
      wanderEngaged = wanderActive;
      if (wanderActive) {
        const gazePoints = isThinking ? THINKING_GAZE_POINTS : IDLE_GAZE_POINTS;
        if (t >= nextWanderAt) {
          wanderIndex = pickNextGazeIndex(wanderIndex, gazePoints.length, Math.random());
          const [gazeX, gazeY] = gazePoints[wanderIndex];
          wanderLookTarget.set(gazeX, gazeY);
          nextWanderAt = t + (isThinking
            ? MathUtils.randFloat(THINKING_GAZE_MIN_INTERVAL, THINKING_GAZE_MAX_INTERVAL)
            : MathUtils.randFloat(IDLE_GAZE_MIN_INTERVAL, IDLE_GAZE_MAX_INTERVAL));
        }
        const gazeRate = isThinking ? THINKING_GAZE_RATE : IDLE_GAZE_RATE;
        wanderLook.x = exponentialApproach(wanderLook.x, wanderLookTarget.x, gazeRate, deltaSeconds);
        wanderLook.y = exponentialApproach(wanderLook.y, wanderLookTarget.y, gazeRate, deltaSeconds);
      }

      const reactionPose = reactionKind
        ? getReactionPose(reactionKind, (t - reactionStart) / REACTION_DURATIONS[reactionKind])
        : null;
      if (reactionKind && t - reactionStart >= REACTION_DURATIONS[reactionKind]) reactionKind = null;

      const nextTheme = themeRef.current;
      if (nextTheme !== appliedTheme) {
        appliedTheme = nextTheme;
        const palette = MASCOT_PALETTE[appliedTheme];
        sphereMat.color.setHex(palette.body);
        sphereMat.emissive.setHex(palette.emissive);
        sphereMat.roughness = palette.roughness;
        sphereMat.metalness = palette.metalness;
        sphereMat.clearcoat = palette.clearcoat;
        sphereMat.clearcoatRoughness = palette.clearcoatRoughness;
        sphereMat.needsUpdate = true;
        furUniforms.uFurColor.value.setHex(palette.body);
        eyeColor.setHex(palette.eyes); // 两只眼共用这一个 Color 实例
        shadowMat.color.setHex(palette.shadow);
        // 阴影透明度只随主题变化（不再被生成态淡出改写），所以在这里同步
        shadowMat.opacity = palette.shadowOpacity;
        rimLight.intensity = palette.rimLightIntensity;
      }

      // 鼠标刚移动时仍优先跟随用户，静止够久才交给自主张望。
      const allowGaze = (visualStatus === 'idle' || isThinking) && !gazeLocked;
      const gazeTarget = wanderActive ? wanderLook : look;
      const px = motionEnabled && allowGaze ? gazeTarget.x : 0;
      const py = motionEnabled && allowGaze ? gazeTarget.y : 0;
      // 头部跟随也要一起停，否则头转了眼睛不转，看着很别扭
      const headPx = motionEnabled && visualStatus === 'idle' && !gazeLocked ? look.x : 0;
      const headPy = motionEnabled && visualStatus === 'idle' && !gazeLocked ? look.y : 0;

      if (motionEnabled) {
        // 用帧率无关的指数逼近：渲染循环会在 30/60fps 之间切换，
        // 直接 lerp 会让两种帧率下的跟随快慢不一致
        eyeGroup.rotation.y = exponentialApproach(
          eyeGroup.rotation.y,
          px * EYE_MAX_ANGLE,
          FOLLOW_RATE,
          deltaSeconds,
        );
        eyeGroup.rotation.x = exponentialApproach(
          eyeGroup.rotation.x,
          -py * EYE_MAX_ANGLE,
          FOLLOW_RATE,
          deltaSeconds,
        );
        // 偏航只更新「跟随分量」，过渡自转在 loadAmount 算出后再叠加到 head.rotation.y
        headYaw = exponentialApproach(headYaw, headPx * HEAD_MAX_ANGLE, FOLLOW_RATE, deltaSeconds);
        head.rotation.x = exponentialApproach(
          head.rotation.x,
          -headPy * HEAD_MAX_ANGLE,
          FOLLOW_RATE,
          deltaSeconds,
        );
      } else {
        eyeGroup.rotation.set(0, 0, 0);
        headYaw = 0;
        head.rotation.x = 0;
      }

      // 歪头：待机时每隔几秒歪一下再回正。
      // 思考态的歪头交给 thinking 表情自带的 tilt，避免两处叠加把头歪过头。
      let headRollTarget = 0;
      if (motionEnabled && visualStatus === 'idle') {
        if (t >= nextIdleTiltAt) {
          idleTiltTarget = (Math.random() < 0.5 ? -1 : 1)
            * MathUtils.randFloat(IDLE_TILT_ANGLE * 0.5, IDLE_TILT_ANGLE);
          idleTiltUntil = t + IDLE_TILT_HOLD;
          nextIdleTiltAt = idleTiltUntil
            + MathUtils.randFloat(IDLE_TILT_MIN_INTERVAL, IDLE_TILT_MAX_INTERVAL);
        }
        headRollTarget = t < idleTiltUntil ? idleTiltTarget : 0;
      }
      headRoll = motionEnabled
        ? exponentialApproach(headRoll, headRollTarget, HEAD_ROLL_RATE, deltaSeconds)
        : 0;
      // head.rotation.z 与 head.position.y 在表情求出之后统一赋值，
      // 因为要把表情自带的 tilt / lift 叠上去 —— 见下方「写入身体姿态」。

      // 状态表情期间暂停随机眨眼，避免与眼神姿态互相覆盖。
      // 片段播放期间同样不眨：睡眠本来就是闭眼，反应片段又太短，插一次眨眼反而乱。
      const canBlink = motionEnabled && visualStatus === 'idle' && clipState.clipId === null;
      if (!canBlink) {
        blink = 1;
        blinkStart = -1;
        nextBlinkAt = t + BLINK_MIN;
      } else if (blinkStart < 0 && t >= nextBlinkAt) {
        startBlink(t);
      }
      if (canBlink && blinkStart >= 0) {
        const k = (t - blinkStart) / BLINK_DURATION; // 0→1→2
        blink = k < 1 ? 1 - k : Math.min(k - 1, 1); // 下闭上睁，三角波
        if (k >= 2) {
          blink = 1;
          blinkStart = -1;
          scheduleBlink(t);
        }
      }
      // 取当前片段的目标表情；眨眼乘在 open 上 —— 闭眼就是眼睑合拢，
      // 比原来压扁整个几何体更接近真实的眨眼
      sampleClipVector(clipState, STATUS_EXPRESSIONS[visualStatus], expressionTarget);
      for (let index = 0; index < eyes.length; index += 1) {
        // 眨单眼时另一只保持睁开
        const eyeBlink = blinkEye < 0 || blinkEye === index ? blink : 1;
        expressionTarget[index * EYE_STRIDE] *= eyeBlink;
      }
      for (let index = 0; index < EXPRESSION_LENGTH; index += 1) {
        const target = expressionTarget[index];
        if (motionEnabled) {
          stepSpring(expressionSprings[index], target, springConfigFor(index), deltaSeconds);
        } else {
          // 减弱动态：不做过渡，但表情本身要立刻呈现，状态反馈不能丢
          resetSpring(expressionSprings[index], target);
        }
        expressionCurrent[index] = expressionSprings[index].value;
      }
      for (let index = 0; index < eyes.length; index += 1) {
        const eye = eyes[index];
        readEyeExpression(expressionCurrent, index, scratchEye);
        applyEyeShape(eyeUniformsList[index], scratchEye);
        eye.rotation.z = scratchEye.rotationZ;
        eye.position.y = EYE_BASE_Y + scratchEye.offsetY;
      }
      readBodyPose(expressionCurrent, scratchBody);

      // 写入身体姿态：表情自带的侧倾与起伏，叠在待机歪头、呼吸和状态反应之上
      head.rotation.z = headRoll + scratchBody.tilt;
      head.position.y = motionEnabled
        ? Math.sin(t * 1.1) * 0.04 + (reactionPose?.lift ?? 0) + scratchBody.lift
        : 0;

      // 状态色只进入低强度自发光和侧缘光，悬浮反馈仍保持更高优先级。
      const activePalette = MASCOT_PALETTE[appliedTheme];
      const wantLoad = loadingRef.current;
      const hasStatusColor = visualStatus !== 'idle';
      const statusColor = visualStatus === 'idle'
        ? activePalette.emissive
        : STATUS_COLORS[visualStatus];
      targetEmissiveColor.setHex(statusColor);
      targetRimColor.setHex(hasStatusColor ? statusColor : DEFAULT_RIM_COLOR);
      sphereMat.emissive.lerp(targetEmissiveColor, 0.14);
      rimLight.color.lerp(targetRimColor, 0.14);
      const targetEmissive = isHovering
        ? activePalette.hoverEmissiveIntensity
        : hasStatusColor ? activePalette.statusEmissiveIntensity : 0;
      sphereMat.emissiveIntensity = MathUtils.lerp(
        sphereMat.emissiveIntensity,
        targetEmissive,
        0.1,
      );
      furUniforms.uGlowColor.value.copy(sphereMat.emissive);
      furUniforms.uGlow.value = sphereMat.emissiveIntensity;
      rimLight.intensity = MathUtils.lerp(
        rimLight.intensity,
        activePalette.rimLightIntensity + (hasStatusColor ? activePalette.statusRimBoost : 0),
        0.1,
      );
      keyLight.intensity = MathUtils.lerp(
        keyLight.intensity,
        isHovering ? activePalette.hoverKeyLightIntensity : 1.4,
        0.1,
      );
      hoverScale = motionEnabled
        ? MathUtils.lerp(hoverScale, isHovering ? 1.015 : 1, 0.1)
        : 1;

      /* ── LOADING 形态：彩带环绕，球体与绒毛保持原样 ── */
      if (wantLoad && !orbitRibbons && !creatingRibbons) {
        creatingRibbons = true;
        orbitRibbons = createOrbitRibbons();
        orbitRibbons.group.visible = false;
        // 挂在场景上而不是头部：头部会随呼吸起伏、随反应位移缩放，
        // 彩带应该稳定地绕着球心转，不该跟着一起晃
        scene.add(orbitRibbons.group);
        creatingRibbons = false;
      }
      // gsap 驱动彩带强度：0 = 收起，1 = 完全展开
      if (!motionEnabled && loadObj.val !== 0) {
        loadTween?.kill();
        loadObj.val = 0;
        prevLoadTarget = 0;
      }
      const loadTarget = motionEnabled && wantLoad && orbitRibbons ? 1 : 0;
      if (loadTarget !== prevLoadTarget) {
        prevLoadTarget = loadTarget;
        loadTween?.kill();
        loadTween = gsap.to(loadObj, {
          val: loadTarget,
          duration: 1.1,
          ease: 'power2.inOut',
        });
      }
      const ribbonIntensity = loadObj.val;

      // 头部：跟随偏航 + 摇头。生成时球体不再自转，让彩带成为唯一的运动焦点
      head.rotation.y = headYaw + (reactionPose?.yaw ?? 0);
      // 呼吸的挤压拉伸叠上蹦跳的挤压，横向按等体积换算，免得看起来像整体缩放。
      const breathSquash = motionEnabled ? 1 + Math.sin(t * 1.1) * BREATH_SQUASH : 1;
      // 三层挤压叠乘：呼吸、状态反应（蹦跳落地）、表情自带的胖瘦
      const squashY = breathSquash * (reactionPose?.squashY ?? 1) * scratchBody.squashY;
      const squashWidth = getSquashWidth(squashY);
      head.scale.set(hoverScale * squashWidth, hoverScale * squashY, hoverScale * squashWidth);

      // 彩带绕到球体背面的部分由深度测试自动遮挡，不需要像 2D 那样手动分前后段
      if (orbitRibbons) {
        const show = ribbonIntensity > 0.002;
        orbitRibbons.group.visible = show;
        orbitRibbons.setIntensity(ribbonIntensity);
        if (show && motionEnabled) orbitRibbons.update(deltaSeconds, camera.position);
      }

      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(render);

    /* ── 尺寸响应 ── */
    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    /* ── 清理 ── */
    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      window.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerleave', handleWindowLeave);
      window.removeEventListener('blur', handleWindowLeave);
      sphere.geometry.dispose();
      sphereMat.dispose();
      furGeometry.dispose();
      furMat.dispose();
      furNoise.dispose();
      shadowGeo.dispose();
      shadowMat.dispose();
      eyeGeo.dispose();
      for (const material of eyeMaterials) material.dispose();
      // 场景销毁后不能再接受播放请求，否则会写进已经失效的状态
      api.playClip = () => false;
      loadTween?.kill();
      if (orbitRibbons) {
        scene.remove(orbitRibbons.group);
        orbitRibbons.dispose();
        orbitRibbons = null;
      }
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full cursor-pointer"
    />
  );
}

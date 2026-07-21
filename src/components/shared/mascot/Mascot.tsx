/**
 * Mascot — Three.js 吉祥物
 *
 * 一个柔和明暗过渡的圆球，会自然眨眼，眼睛跟随鼠标方向，
 * 鼠标悬浮在球体上时整体高亮。
 *
 * 请求模型时（loading=true）球体本体逐面炸裂、飞散成粒子云；
 * 完成后再平滑还原为圆球。
 *
 * 用法：放进任意有尺寸的容器即可（组件会铺满父级）。
 *   <div style={{ width: 480, height: 480 }}>
 *     <Mascot loading={isLoading} />
 *   </div>
 */
import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { createLoadingText, type LoadingText } from './loadingText';
import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  HemisphereLight,
  DirectionalLight,
  AmbientLight,
  Group,
  MeshPhysicalMaterial,
  Color,
  Mesh,
  SphereGeometry,
  MeshBasicMaterial,
  DoubleSide,
  ShapeGeometry,
  Shape,
  Vector2,
  Raycaster,
  MathUtils,
  Timer,
} from 'three';

/* ── 可调参数 ── */
const SPHERE_RADIUS = 1;
const EYE_MAX_ANGLE = 0.42; // 眼睛跟随鼠标的最大偏转（弧度）
const HEAD_MAX_ANGLE = 0.12; // 头部跟随鼠标的轻微转动
const FOLLOW_LERP = 0.12; // 跟随平滑系数
const BLINK_MIN = 2.2; // 两次眨眼最小间隔（秒）
const BLINK_MAX = 5.5; // 两次眨眼最大间隔（秒）
const BLINK_DURATION = 0.13; // 单次眨眼时长（秒）
// 过渡自转（靠眼睛扫过体现可见旋转 → 必须转头部，而非均匀粒子球）
const SPIN_TURNS = Math.PI * 2; // 过渡时绕 Y 轴转过的总角度（一整圈，结束时眼睛回到正面）
const SPIN_END = 1;   // 自转在过渡进度的前半段完成（此时球体仍完全可见 → 看得到旋转）
const FADE_START = 0.45; // 自转接近完成后才开始淡出/炸裂（回程则先聚拢、球体重现后再转回正面）
// 限帧：Tauri 透明窗口下 rAF 不受垂直同步限制（实测 ~1700Hz），必须自行限频，
// 否则渲染循环以每秒上千次全速跑满主线程
const IDLE_FPS = 30;
const ACTIVE_FPS = 60;
const POINTER_ACTIVITY_MS = 250;
const STATUS_TRANSITION_ACTIVE_MS = 320;

type MascotTheme = 'dark' | 'light';
export type MascotStatus = 'idle' | 'thinking' | 'success' | 'error';

interface EyePose {
  scaleY: readonly [number, number];
  rotationZ: readonly [number, number];
  offsetY: readonly [number, number];
}

const EYE_POSES: Record<MascotStatus, EyePose> = {
  idle: {
    scaleY: [1, 1],
    rotationZ: [0, 0],
    offsetY: [0, 0],
  },
  thinking: {
    scaleY: [0.72, 0.48],
    rotationZ: [-0.08, 0.08],
    offsetY: [0, 0.045],
  },
  success: {
    scaleY: [0.34, 0.34],
    rotationZ: [-0.65, 0.65],
    offsetY: [0.025, 0.025],
  },
  error: {
    scaleY: [0.58, 0.58],
    rotationZ: [0.48, -0.48],
    offsetY: [-0.025, -0.025],
  },
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

/** 生成竖直胶囊（圆角矩形）形状，用作眼睛 */
function makeEyeShape(width: number, height: number): Shape {
  const w = width / 2;
  const h = height / 2;
  const r = Math.min(w, h * 0.6);
  const shape = new Shape();
  shape.moveTo(-w, -h + r);
  shape.lineTo(-w, h - r);
  shape.quadraticCurveTo(-w, h, -w + r, h);
  shape.lineTo(w - r, h);
  shape.quadraticCurveTo(w, h, w, h - r);
  shape.lineTo(w, -h + r);
  shape.quadraticCurveTo(w, -h, w - r, -h);
  shape.lineTo(-w + r, -h);
  shape.quadraticCurveTo(-w, -h, -w, -h + r);
  return shape;
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
}

export default function Mascot({
  loading = false,
  status = 'idle',
  theme = 'dark',
  reduceMotion = false,
}: MascotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 把最新 loading 放进 ref，供常驻渲染循环读取（避免重建场景）
  const loadingRef = useRef(loading);
  const statusRef = useRef(status);
  const statusChangedAtRef = useRef(0);
  const themeRef = useRef(theme);
  const reduceMotionRef = useRef(reduceMotion);
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

    /* ── 球体：暗色主题为哑光陶瓷，浅色主题为珍珠烟灰缎面 ── */
    const sphereMat = new MeshPhysicalMaterial({
      color: initialPalette.body,
      roughness: initialPalette.roughness,
      metalness: initialPalette.metalness,
      clearcoat: initialPalette.clearcoat,
      clearcoatRoughness: initialPalette.clearcoatRoughness,
      specularIntensity: 0.62,
      emissive: new Color(initialPalette.emissive),
      emissiveIntensity: 0, // 悬浮时提升
      transparent: true, // 切换 LOADING 时淡出
      depthWrite: false,
      opacity: initialPalette.opacity,
    });
    const sphere = new Mesh(
      new SphereGeometry(SPHERE_RADIUS, 64, 64),
      sphereMat,
    );
    sphere.renderOrder = 1;
    head.add(sphere);

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

    const eyeMat = new MeshBasicMaterial({
      color: initialPalette.eyes,
      side: DoubleSide,
      transparent: true,
      // transparent + DoubleSide 默认走双 pass 渲染，每 pass 强制 material.needsUpdate，
      // 导致每帧重算着色器程序参数（getParameters/getProgramCacheKey 常驻热点）。
      // 眼睛是无自交叠的平面，单 pass 双面渲染视觉无差异。
      forceSinglePass: true,
    });
    const eyeGeo = new ShapeGeometry(makeEyeShape(0.16, 0.34));

    const eyes: Mesh[] = [];
    for (const sign of [-1, 1]) {
      const eye = new Mesh(eyeGeo, eyeMat);
      eye.position.set(sign * 0.22, 0.04, SPHERE_RADIUS * 1.01);
      eye.renderOrder = 4;
      eyeGroup.add(eye);
      eyes.push(eye);
    }

    /* ── 鼠标 / 悬浮状态 ──
     * 监听整个窗口：眼睛始终看向光标。look 为相对吉祥物中心的方向 [-1,1]，
     * 以半个窗口尺寸为参考归一化，光标越靠近屏幕边缘越接近最大眼动幅度。 */
    const look = new Vector2(0, 0); // 全局视线方向（目标）
    const localPointer = new Vector2(0, 0); // 画布内 NDC，仅用于悬浮检测
    let hovering = false;
    let lastPointerMoveAt = 0;

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

    /* ── 眨眼调度 ── */
    let blink = 1; // 1 = 睁开, 0 = 闭合
    let nextBlinkAt = BLINK_MIN;
    let blinkStart = -1;

    const scheduleBlink = (now: number) => {
      nextBlinkAt = now + BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
    };

    /* ── LOADING 形态状态 ── */
    let loadText: LoadingText | null = null;
    let creatingLoad = false;
    const loadObj = { val: 0 }; // 0 = 圆球, 1 = LOADING 碎裂，gsap 驱动缓动过渡
    let loadTween: gsap.core.Tween | null = null;
    let prevLoadTarget = 0;
    let hoverScale = 1;
    // gsap 时间线（与参考一致：4s easeInOut yoyo，progress 0→0.6，rotation 0→2π）
    let tl: gsap.core.Timeline | null = null;
    const anim = { progress: 0 };
    // 头部偏航的「跟随鼠标」分量：过渡自转在 loadAmount 算出后再叠加，避免被自身 lerp 吃掉
    let headYaw = 0;
    const targetEmissiveColor = new Color(initialPalette.emissive);
    const targetRimColor = new Color(DEFAULT_RIM_COLOR);

    /* ── 渲染循环（限帧 + 后台暂停，同 NebulaBackground）── */
    const clock = new Timer();
    let raf = 0;
    let lastTime = 0;

    const render = (now: number) => {
      raf = requestAnimationFrame(render);
      if (document.hidden) return; // 窗口不可见时不渲染
      const motionEnabled = !reduceMotionRef.current;
      const visualStatus = statusRef.current;
      const isHovering = motionEnabled && finePointerQuery.matches && hovering;
      const isActive = motionEnabled && (
        loadingRef.current
        || isHovering
        || blinkStart >= 0
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
        eyeMat.color.setHex(palette.eyes);
        shadowMat.color.setHex(palette.shadow);
        rimLight.intensity = palette.rimLightIntensity;
      }

      // 成功和失败表情保持正视，避免状态眼神被鼠标偏转破坏。
      const allowGaze = visualStatus === 'idle' || visualStatus === 'thinking';
      const px = motionEnabled && allowGaze ? look.x : 0;
      const py = motionEnabled && allowGaze ? look.y : 0;

      if (motionEnabled) {
        eyeGroup.rotation.y = MathUtils.lerp(
          eyeGroup.rotation.y,
          px * EYE_MAX_ANGLE,
          FOLLOW_LERP,
        );
        eyeGroup.rotation.x = MathUtils.lerp(
          eyeGroup.rotation.x,
          -py * EYE_MAX_ANGLE,
          FOLLOW_LERP,
        );
        // 偏航只更新「跟随分量」，过渡自转在 loadAmount 算出后再叠加到 head.rotation.y
        headYaw = MathUtils.lerp(headYaw, px * HEAD_MAX_ANGLE, FOLLOW_LERP);
        head.rotation.x = MathUtils.lerp(
          head.rotation.x,
          -py * HEAD_MAX_ANGLE,
          FOLLOW_LERP,
        );
      } else {
        eyeGroup.rotation.set(0, 0, 0);
        headYaw = 0;
        head.rotation.x = 0;
      }

      // 轻微呼吸浮动
      head.position.y = motionEnabled ? Math.sin(t * 1.1) * 0.04 : 0;

      // 状态表情期间暂停随机眨眼，避免与眼神姿态互相覆盖。
      const canBlink = motionEnabled && visualStatus === 'idle';
      if (!canBlink) {
        blink = 1;
        blinkStart = -1;
        nextBlinkAt = t + BLINK_MIN;
      } else if (blinkStart < 0 && t >= nextBlinkAt) {
        blinkStart = t;
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
      const eyePose = EYE_POSES[visualStatus];
      const poseLerp = motionEnabled ? 0.18 : 1;
      for (let index = 0; index < eyes.length; index += 1) {
        const eye = eyes[index];
        const targetScaleY = Math.max(blink * eyePose.scaleY[index], 0.06);
        eye.scale.y = MathUtils.lerp(eye.scale.y, targetScaleY, poseLerp);
        eye.rotation.z = MathUtils.lerp(eye.rotation.z, eyePose.rotationZ[index], poseLerp);
        eye.position.y = MathUtils.lerp(eye.position.y, 0.04 + eyePose.offsetY[index], poseLerp);
      }

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

      /* ── LOADING 形态：圆球 ⇄ 文字碎裂 平滑过渡 ── */
      if (motionEnabled && wantLoad && !loadText && !creatingLoad) {
        creatingLoad = true;
        createLoadingText()
          .then((lt) => {
            loadText = lt;
            lt.mesh.visible = false;
            scene.add(lt.mesh);
            // 炸裂进度时间线：progress 0→0.6，4s easeInOut，yoyo 无限循环（旋转由头部的过渡自转体现）
            tl = gsap.timeline({ repeat: -1, repeatDelay: 0.5, yoyo: true });
            tl.fromTo(anim, { progress: 0 }, { progress: 0.6, duration: 4, ease: 'power1.inOut' }, 0);
            creatingLoad = false;
          })
          .catch(() => { creatingLoad = false; });
      }
      // gsap 驱动过渡进度 p（0=圆球, 1=粒子）：1.4s 缓动，给前半段自转留出可见时间
      if (!motionEnabled && loadObj.val !== 0) {
        loadTween?.kill();
        loadObj.val = 0;
        prevLoadTarget = 0;
      }
      const loadTarget = motionEnabled && wantLoad && loadText ? 1 : 0;
      if (loadTarget !== prevLoadTarget) {
        prevLoadTarget = loadTarget;
        loadTween?.kill();
        loadTween = gsap.to(loadObj, {
          val: loadTarget,
          // 放慢整个过渡：前半段自转需要足够时间才看得清，之后才淡出/炸裂
          duration: 1.4,
          ease: 'power2.inOut',
        });
      }
      const p = loadObj.val;

      // 过渡分两段：① 前半段（到 SPIN_END）先把球体「转」起来——眼睛随头部扫过 = 肉眼可见的旋转，
      // 此时还没淡出；② 自转接近完成后（FADE_START 之后）再淡出 + 炸裂成粒子。
      // 回程 p:1→0 自动反过来：粒子先聚拢淡回球体，球体重现后再转回正面。
      const spinAngle = MathUtils.smoothstep(p, 0, SPIN_END) * SPIN_TURNS;
      const fade = MathUtils.smoothstep(p, FADE_START, 1);

      // 头部：跟随偏航 + 过渡自转（自转靠眼睛体现，故转的是头部而非粒子球）
      head.rotation.y = headYaw + spinAngle;
      sphereMat.opacity = activePalette.opacity * (1 - fade);
      eyeMat.opacity = 1 - fade;
      shadowMat.opacity = activePalette.shadowOpacity * (1 - fade);
      head.visible = fade < 0.995;
      head.scale.setScalar(hoverScale * (1 - fade * 0.5));

      // 粒子网格：随 fade（自转完成后才登场）淡入，由时间线驱动炸裂进度
      if (loadText) {
        const lt = loadText;
        const show = fade > 0.002;
        lt.mesh.visible = show;
        lt.material.opacity = fade;
        if (show) {
          tl?.play();
          lt.setUTime(lt.animationDuration * anim.progress);
          // 与头部保持同一旋转角，交叉淡入淡出时衔接自然
          lt.mesh.rotation.y = spinAngle;
        } else {
          tl?.pause();
        }
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
      shadowGeo.dispose();
      shadowMat.dispose();
      eyeGeo.dispose();
      eyeMat.dispose();
      tl?.kill();
      loadTween?.kill();
      if (loadText) {
        scene.remove(loadText.mesh);
        loadText.dispose();
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

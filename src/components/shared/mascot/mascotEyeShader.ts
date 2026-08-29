/**
 * 眼睛的 SDF 着色器。
 *
 * 原实现用固定的圆角胶囊 ShapeGeometry，只能靠 scale/rotate 变形，
 * 因此最多表达「睁 / 眯 / 斜」，做不出弯月眼 ^ ^、横线眼 - -、尖角眼 > <。
 *
 * 改成在平面上用有向距离场画形状后，眼型由五个连续参数决定，
 * 参数之间可以直接插值 —— 这正是复刻 Grok 那套多边形眼睛库的前提。
 *
 * 形状构造：眼睛被看成「一条会弯曲的眼睑中心线 + 沿线的椭圆开口」。
 * 中心线给出弧度与倾斜，开口的 sqrt(1 - t²) 让两端自然收成尖角。
 */
import { Color } from 'three';

/** 眼型的五个连续参数，全部可以在表情之间插值。 */
export interface EyeShapeParams {
  /** 睁开程度：0 完全闭眼（只留一条眼睑线），1 完全睁开。 */
  open: number;
  /** 弯曲：正值上凸成弯月 ^ ^，负值下凹成 v v。 */
  curve: number;
  /** 倾斜：正值左低右高。左右眼取相反符号即得 > <。 */
  slant: number;
  /** 宽度缩放，1 为基准。 */
  width: number;
  /** 高度缩放，1 为基准。 */
  height: number;
}

/**
 * 与原胶囊眼睛对齐的基准半宽 / 半高。
 * 原 makeEyeShape(0.16, 0.34) 的总尺寸是 0.16 × 0.34，半尺寸就是这里的值。
 * 取 0.09 × 0.18 是为了在原来基础上「大一点点」，同时保持眼间距自然。
 */
const BASE_HALF_WIDTH = 0.09;
const BASE_HALF_HEIGHT = 0.18;
/**
 * 完全闭合时残留的眼睑线半厚，保证闭眼仍然看得见。
 * 按基准眼高 0.68 折算约 6%，再细就会在睡眠这类持续表情下细到几乎不可见。
 * GLSL 与 JS 参考实现共用这一个值，避免两边各写一份导致测试失真。
 */
export const EYE_LID_HALF_THICKNESS = 0.02;

/**
 * 眼型参数的取值上界。
 *
 * 弹簧会过冲，表情切换途中参数可能短暂超出两端的值，所以上界比表情表里的
 * 实际极值再宽出一部分。同时也是画布尺寸的依据 —— 没有上界的话，
 * 过冲可能把眼睛甩出画布造成边缘被切。
 */
export const EYE_PARAM_LIMITS = {
  open: { min: 0, max: 1.28 },
  curve: { min: -0.62, max: 0.62 },
  slant: { min: -0.6, max: 0.6 },
  width: { min: 0.6, max: 1.3 },
  height: { min: 0.6, max: 1.22 },
} as const;

/**
 * 绘制区域尺寸。取决定于 EYE_PARAM_LIMITS 内所有极端组合都放得下：
 * 横向最坏 0.09 × 1.3 = 0.117；纵向最坏约 0.53（弯曲、放大与倾斜叠加后的峰值）。
 * 透明部分会被 discard，画布留大一些只是多几个被丢弃的片元，不影响观感。
 */
export const EYE_PLANE_WIDTH = 0.52;
export const EYE_PLANE_HEIGHT = 1.62;

export const EYE_VERTEX_SHADER = /* glsl */ `
varying vec2 vLocal;

void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const EYE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uOpacity;
uniform float uOpen;
uniform float uCurve;
uniform float uSlant;
uniform float uWidth;
uniform float uHeight;

varying vec2 vLocal;

const float BASE_HALF_WIDTH = ${BASE_HALF_WIDTH};
const float BASE_HALF_HEIGHT = ${BASE_HALF_HEIGHT};
const float LID_THICKNESS = ${EYE_LID_HALF_THICKNESS};

/** 眼睛的距离场：负为内部，正为外部。 */
float eyeDistance(vec2 p) {
  float halfW = BASE_HALF_WIDTH * max(uWidth, 0.001);
  float t = clamp(p.x / halfW, -1.0, 1.0);
  // 眼睑中心线：curve 给眉眼弧度，slant 给 > < 的斜势
  float arch = max(1.0 - t * t, 0.0);
  float center = (uCurve * arch + uSlant * t) * BASE_HALF_HEIGHT;
  float halfH = uOpen * uHeight * BASE_HALF_HEIGHT + LID_THICKNESS;
  // 圆角半径参考原胶囊：r = min(w, h * 0.6)，这样睁眼时两端是圆的，
  // 闭眼时因为 halfH 很小半径也变得很小，变成一条可见的细线
  float radius = min(halfW, halfH * 0.6);
  vec2 q = vec2(abs(p.x), abs(p.y - center)) - vec2(halfW, halfH) + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

void main() {
  float d = eyeDistance(vLocal);
  // 用屏幕空间导数做抗锯齿，缩放时边缘始终平滑
  float aa = max(fwidth(d), 1e-4);
  float alpha = (1.0 - smoothstep(-aa, aa, d)) * uOpacity;
  // 透明像素直接丢弃：眼睛是贴在球面上的平面，
  // 不丢弃会与球体、绒毛争抢透明排序并产生边缘脏边
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`;

/**
 * 眼睛材质需要的 uniform 集合。左右眼各持一份，才能做出 < ○ > 这类异形眼。
 *
 * 用 type 而不是 interface：类型别名的对象类型才有隐式索引签名，
 * 可以原样交给 ShaderMaterial 的 uniforms，不需要再 cast 一次。
 */
export type EyeUniforms = {
  uColor: { value: Color };
  uOpacity: { value: number };
  uOpen: { value: number };
  uCurve: { value: number };
  uSlant: { value: number };
  uWidth: { value: number };
  uHeight: { value: number };
};

export function createEyeUniforms(color: Color): EyeUniforms {
  return {
    uColor: { value: color },
    uOpacity: { value: 1 },
    uOpen: { value: 1 },
    uCurve: { value: 0 },
    uSlant: { value: 0 },
    uWidth: { value: 1 },
    uHeight: { value: 1 },
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 把插值后的眼型夹回上界并写进 uniform。每帧调用，不分配对象。 */
export function applyEyeShape(uniforms: EyeUniforms, shape: EyeShapeParams): void {
  uniforms.uOpen.value = clamp(shape.open, EYE_PARAM_LIMITS.open.min, EYE_PARAM_LIMITS.open.max);
  uniforms.uCurve.value = clamp(shape.curve, EYE_PARAM_LIMITS.curve.min, EYE_PARAM_LIMITS.curve.max);
  uniforms.uSlant.value = clamp(shape.slant, EYE_PARAM_LIMITS.slant.min, EYE_PARAM_LIMITS.slant.max);
  uniforms.uWidth.value = clamp(shape.width, EYE_PARAM_LIMITS.width.min, EYE_PARAM_LIMITS.width.max);
  uniforms.uHeight.value = clamp(shape.height, EYE_PARAM_LIMITS.height.min, EYE_PARAM_LIMITS.height.max);
}

/**
 * 距离场的 JS 参考实现，与 GLSL 中的 eyeDistance 逐行对应。
 *
 * 存在的意义是让眼型语义能在 Node 下单测 —— WebGL 里画得对不对没法断言，
 * 但「open=0 时只剩一条线」「curve>0 时中线上凸」这类几何性质可以。
 * 修改 GLSL 时必须同步改这里，否则测试会失去意义。
 */
export function eyeDistanceAt(x: number, y: number, shape: EyeShapeParams): number {
  const halfW = BASE_HALF_WIDTH * Math.max(shape.width, 0.001);
  const t = Math.min(Math.max(x / halfW, -1), 1);
  const arch = Math.max(1 - t * t, 0);
  const center = (shape.curve * arch + shape.slant * t) * BASE_HALF_HEIGHT;
  const halfH = shape.open * shape.height * BASE_HALF_HEIGHT + EYE_LID_HALF_THICKNESS;
  const radius = Math.min(halfW, halfH * 0.6);
  const qx = Math.abs(x) - halfW + radius;
  const qy = Math.abs(y - center) - halfH + radius;
  const inside = Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2;
  const outside = Math.min(Math.max(qx, qy), 0);
  return Math.sqrt(inside) + outside - radius;
}

/** 判断某点是否落在眼睛内部，供测试与调试使用。 */
export function isInsideEye(x: number, y: number, shape: EyeShapeParams): boolean {
  return eyeDistanceAt(x, y, shape) < 0;
}

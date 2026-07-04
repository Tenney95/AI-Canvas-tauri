/**
 * loadingText — 吉祥物「炸裂成粒子」加载动画（GPU 顶点着色器驱动）
 *
 * 加载态时，由吉祥物本体（球体）逐面炸裂、旋转、飞散到一个更大的球壳上形成粒子云，
 * 而不再由「LOADING」文字转换 —— 这样「圆球 → 粒子」的过渡能自然衔接。
 * 逐面动画（delay/duration/lengthFactor/stretch/axis-angle/配色）沿用参考做法，
 * 放到顶点着色器（等价原 THREE.BAS）；源几何体改为与吉祥物同尺寸的 SphereGeometry。
 * 最后对整个 Mesh 做一次「显示缩放」以适配吉祥物的小视口（这不是动画参数）。
 */
import * as THREE from 'three';

export interface LoadingText {
  mesh: THREE.Mesh;
  material: THREE.MeshPhongMaterial;
  /** 动画总时长（maxDuration + maxDelay + stretch + lengthFactor*maxLength）*/
  animationDuration: number;
  /** 设置着色器时间（uTime = animationDuration * animationProgress）*/
  setUTime: (uTime: number) => void;
  dispose: () => void;
}

// 参考参数
const LENGTH_FACTOR = 0.001;
const STRETCH = 0.05;
const DURATION = 1.0;
// 源球体半径：经 displayScale(0.028) 缩放后 ≈ 1，与吉祥物球体世界半径一致，
// 使粒子炸裂的「起点」正好覆盖原本的圆球，过渡无缝。
const SRC_RADIUS = 36;
// 炸裂目标球壳半径：大于源半径 → 粒子整体向外爆开成略大的粒子球。
const SPHERE_RADIUS = 52;
// 源球体细分：决定粒子（=三角面）数量与密度
const SRC_WIDTH_SEG = 56;
const SRC_HEIGHT_SEG = 36;

const G = Math.PI * (3 - Math.sqrt(5));
function fibSpherePoint(i: number, n: number, radius: number, out: THREE.Vector3) {
  const step = 2 / n;
  out.y = i * step - 1 + step * 0.5;
  const r = Math.sqrt(Math.max(0, 1 - out.y * out.y));
  const phi = i * G;
  out.x = Math.cos(phi) * r;
  out.z = Math.sin(phi) * r;
  return out.multiplyScalar(radius);
}

export async function createLoadingText(displayScale = 0.028): Promise<LoadingText> {
  // 源几何体：吉祥物球体本身（而非 LOADING 文字）。球体已是均匀三角网格，
  // 直接以每个三角面作为一颗粒子，无需再做 tessellate。
  let geo: THREE.BufferGeometry = new THREE.SphereGeometry(
    SRC_RADIUS,
    SRC_WIDTH_SEG,
    SRC_HEIGHT_SEG,
  );

  // separateFaces 等价：每个三角面独立顶点（球体本就以原点为中心，无需再居中）
  geo = geo.toNonIndexed();
  geo.computeBoundingBox();
  geo.computeVertexNormals();

  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  const vertCount = posAttr.count;
  const faceCount = vertCount / 3;
  const maxLength = geo.boundingBox!.max.length();
  const animationDuration = DURATION + STRETCH + LENGTH_FACTOR * maxLength;

  // 逐面属性（同一面的 3 个顶点共享）
  const aAnimation = new Float32Array(vertCount * 2);
  const aEndPosition = new Float32Array(vertCount * 3);
  const aAxisAngle = new Float32Array(vertCount * 4);

  const base = posAttr.array as Float32Array;
  const centroid = new THREE.Vector3();
  const cn = new THREE.Vector3();
  const end = new THREE.Vector3();

  for (let f = 0; f < faceCount; f++) {
    const o = f * 9;
    centroid.set(
      (base[o] + base[o + 3] + base[o + 6]) / 3,
      (base[o + 1] + base[o + 4] + base[o + 7]) / 3,
      (base[o + 2] + base[o + 5] + base[o + 8]) / 3,
    );

    const delay = (maxLength - centroid.length()) * LENGTH_FACTOR + STRETCH * Math.random();

    fibSpherePoint(f, faceCount, SPHERE_RADIUS, end);

    cn.copy(centroid).normalize();
    const ax = new THREE.Vector3(cn.x, -cn.y, -cn.z).normalize();
    const angle = Math.PI * THREE.MathUtils.randFloat(0.5, 2.0);

    for (let k = 0; k < 3; k++) {
      const vi = f * 3 + k;
      const vo = f * 9 + k * 3;
      aAnimation[vi * 2] = delay;
      aAnimation[vi * 2 + 1] = DURATION;
      // 终点 = 球面点 + 顶点相对质心的偏移 → 整个三角面刚性平移（保持原尺寸，不塌缩成点）
      // 与参考一致：每面塌缩为粒子点。保留极小偏移（0.6）确保 GPU 可光栅化
      aEndPosition[vi * 3] = end.x + (base[vo] - centroid.x) * 0.6;
      aEndPosition[vi * 3 + 1] = end.y + (base[vo + 1] - centroid.y) * 0.6;
      aEndPosition[vi * 3 + 2] = end.z + (base[vo + 2] - centroid.z) * 0.6;
      aAxisAngle[vi * 4] = ax.x;
      aAxisAngle[vi * 4 + 1] = ax.y;
      aAxisAngle[vi * 4 + 2] = ax.z;
      aAxisAngle[vi * 4 + 3] = angle;
    }
  }

  geo.setAttribute('aAnimation', new THREE.BufferAttribute(aAnimation, 2));
  geo.setAttribute('aEndPosition', new THREE.BufferAttribute(aEndPosition, 3));
  geo.setAttribute('aAxisAngle', new THREE.BufferAttribute(aAxisAngle, 4));

  // 配色与参考一致：深灰漫反射 + 亮高光（Phong）
  const material = new THREE.MeshPhongMaterial({
    color: 0x444444,
    specular: 0xcccccc,
    shininess: 4,
    flatShading: true,
    transparent: true,
    side: THREE.DoubleSide,
    // transparent + DoubleSide 默认双 pass 渲染，每 pass 强制 needsUpdate → 每帧重算着色器参数。
    // 粒子翻转需要双面，但无需背/正面分开渲染，单 pass 即可。
    forceSinglePass: true,
  });

  const uTime = { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        attribute vec2 aAnimation;
        attribute vec3 aEndPosition;
        attribute vec4 aAxisAngle;
        vec3 rotateVector(vec4 q, vec3 v) {
          return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
        }
        vec4 quatFromAxisAngle(vec3 axis, float angle) {
          float h = angle * 0.5;
          return vec4(axis * sin(h), cos(h));
        }`,
      )
      .replace(
        '#include <begin_vertex>',
        `float tDelay = aAnimation.x;
        float tDuration = aAnimation.y;
        float tTime = clamp(uTime - tDelay, 0.0, tDuration);
        float tProgress = 1.0 - pow(1.0 - tTime / max(tDuration, 0.0001), 3.0); // ease-out-cubic
        vec3 transformed = mix(position, aEndPosition, tProgress);
        vec4 tQuat = quatFromAxisAngle(aAxisAngle.xyz, aAxisAngle.w * tProgress);
        transformed = rotateVector(tQuat, transformed);`,
      );
  };

  const mesh = new THREE.Mesh(geo, material);
  mesh.scale.setScalar(displayScale); // 仅显示缩放，适配小视口
  mesh.frustumCulled = false;

  return {
    mesh,
    material,
    animationDuration,
    setUTime: (t: number) => { uTime.value = t; },
    dispose: () => { geo.dispose(); material.dispose(); },
  };
}

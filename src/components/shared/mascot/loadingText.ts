/**
 * loadingText — "LOADING" 文字碎裂动画（现代 Three.js 复刻，GPU 顶点着色器驱动）
 *
 * 忠实保留参考代码的全部参数（size 40 / curveSegments 24 / bevel 2,2 /
 * tessellateRepeat(1.0, 2) / 球面半径 200 / lengthFactor 0.001 / stretch 0.05 /
 * duration 1.0 / angle = π·rand(0.5,2) / axis (x,-y,-z) / 配色 0x444444,0xcccccc,4）。
 * 由于密度高，逐面动画放到顶点着色器（等价原 THREE.BAS 做法），仅在最后对整个
 * Mesh 做一次「显示缩放」以适配吉祥物的小视口（这不是动画参数）。
 */
import * as THREE from 'three';
import type { FontData } from 'three/examples/jsm/loaders/FontLoader.js';

export interface LoadingText {
  mesh: THREE.Mesh;
  material: THREE.MeshPhongMaterial;
  /** 动画总时长（参考：maxDuration + maxDelay + stretch + lengthFactor*maxLength）*/
  animationDuration: number;
  /** 设置着色器时间（uTime = animationDuration * animationProgress）*/
  setUTime: (uTime: number) => void;
  dispose: () => void;
}

// 参考参数
const LENGTH_FACTOR = 0.001;
const STRETCH = 0.05;
const DURATION = 1.0;
// 球面半径：参考为 200（全屏视口）。吉祥物仅 100px，需缩小到粒子≥1px 才看得见。
// 取值略大于文字半宽 → 文字向外炸开成略大的粒子球。
const SPHERE_RADIUS = 36;

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
  const [{ FontLoader }, { TextGeometry }, { TessellateModifier }, fontMod] = await Promise.all([
    import('three/examples/jsm/loaders/FontLoader.js'),
    import('three/examples/jsm/geometries/TextGeometry.js'),
    import('three/examples/jsm/modifiers/TessellateModifier.js'),
    import('three/examples/fonts/helvetiker_bold.typeface.json'),
  ]);

  const font = new FontLoader().parse((fontMod as { default: FontData }).default);

  // 形状参数沿用参考比例（curveSegments 24 / bevel）；绝对尺寸缩小以适配 100px 视口，
  // 使文字与粒子球都能放进小窗口（size:radius 与参考一致量级）。
  let geo: THREE.BufferGeometry = new TextGeometry('LOADING', {
    font,
    size: 16,
    depth: 5,
    curveSegments: 24,
    bevelEnabled: true,
    bevelThickness: 0.8,
    bevelSize: 0.8,
    bevelSegments: 3,
  });

  // 居中（anchor 0.5,0.5,0）
  geo.computeBoundingBox();
  {
    const bb = geo.boundingBox!;
    geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
  }

  // tessellateRepeat(geo, 1.0, 2) 等价
  geo = new TessellateModifier(1.0, 2).modify(geo);
  // separateFaces 等价：每个三角面独立顶点
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

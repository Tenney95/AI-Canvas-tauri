import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { DirectorPrevisScene, DirectorPrevisView, PrevisCameraKeyframe, PrevisObject, PrevisObjectKeyframe, PrevisVector } from '../types/directorPrevis';
import { normalizeDirectorPrevisScene } from './directorPrevisSchema';

export function previsAspectRatio(scene: DirectorPrevisScene): number {
  return scene.aspectRatio === '9:16' ? 9 / 16 : scene.aspectRatio === '2.39:1' ? 2.39 : 16 / 9;
}

function segment<T extends { time: number }>(frames: T[], time: number, smooth: boolean): { a: T; b: T; t: number } {
  if (time <= frames[0].time) return { a: frames[0], b: frames[0], t: 0 };
  for (let i = 1; i < frames.length; i++) {
    if (time <= frames[i].time) {
      const t = (time - frames[i - 1].time) / (frames[i].time - frames[i - 1].time);
      return { a: frames[i - 1], b: frames[i], t: smooth ? t * t * (3 - 2 * t) : t };
    }
  }
  return { a: frames.at(-1)!, b: frames.at(-1)!, t: 0 };
}
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function vectorLerp(a: PrevisVector, b: PrevisVector, t: number): PrevisVector {
  return a.map((value, i) => lerp(value, b[i], t)) as PrevisVector;
}

export function samplePrevisCamera(scene: DirectorPrevisScene, time: number): PrevisCameraKeyframe {
  const { a, b, t } = segment(scene.camera.keyframes, time, scene.easing === 'smooth');
  return { time: Math.max(0, Math.min(scene.duration, time)), position: vectorLerp(a.position, b.position, t),
    target: vectorLerp(a.target, b.target, t), focalLength: lerp(a.focalLength, b.focalLength, t), roll: lerp(a.roll, b.roll, t) };
}

export function samplePrevisObject(object: PrevisObject, time: number, smooth: boolean): PrevisObjectKeyframe {
  if (!object.keyframes.length) return { time, position: object.position, rotation: object.rotation };
  const { a, b, t } = segment(object.keyframes, time, smooth);
  return { time, position: vectorLerp(a.position, b.position, t), rotation: vectorLerp(a.rotation, b.rotation, t) };
}

/** Fit once to the full motion envelope, so camera playback never moves the shadow texel grid. */
export function configurePrevisShadow(light: THREE.DirectionalLight, objectBounds: THREE.Box3, maxTextureSize: number): void {
  const bounds = objectBounds.isEmpty()
    ? new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1)) : objectBounds.clone();
  const direction = new THREE.Vector3(0.3, 0.8, 0.4).normalize();
  const corners = (box: THREE.Box3) => [box.min.x, box.max.x].flatMap((x) =>
    [box.min.y, box.max.y].flatMap((y) => [box.min.z, box.max.z].map((z) => new THREE.Vector3(x, y, z))));
  // Include the ground receiving the cast shadows, without fitting the 2000m ground mesh.
  for (const point of corners(bounds)) {
    if (point.y >= -0.01) bounds.expandByPoint(point.clone().addScaledVector(direction, -(point.y + 0.01) / direction.y));
  }
  const center = bounds.getCenter(new THREE.Vector3());
  light.position.copy(center).addScaledVector(direction, bounds.getSize(new THREE.Vector3()).length() + 1);
  light.target.position.copy(center);
  light.updateMatrixWorld(true);
  light.target.updateMatrixWorld(true);
  light.shadow.updateMatrices(light);
  const camera = light.shadow.camera;
  const lightBounds = new THREE.Box3().setFromPoints(corners(bounds).map((point) => point.applyMatrix4(camera.matrixWorldInverse)));
  const resolution = 2 ** Math.floor(Math.log2(Math.max(1, Math.min(2048, maxTextureSize))));
  const extent = lightBounds.getSize(new THREE.Vector3());
  const padding = Math.max(0.1, Math.max(extent.x, extent.y) / resolution * 4);
  Object.assign(camera, {
    left: lightBounds.min.x - padding, right: lightBounds.max.x + padding,
    bottom: lightBounds.min.y - padding, top: lightBounds.max.y + padding,
    near: Math.max(0.1, -lightBounds.max.z - padding), far: -lightBounds.min.z + padding,
  });
  camera.updateProjectionMatrix();
  light.shadow.mapSize.set(resolution, resolution);
  light.shadow.bias = -0.0001;
  const texelSize = Math.max(camera.right - camera.left, camera.top - camera.bottom) / resolution;
  // World-space normal offset removes self-shadow stripes; cap it to preserve contact shadows.
  light.shadow.normalBias = THREE.MathUtils.clamp(texelSize * 1.5, 0.001, 0.03);
  light.shadow.needsUpdate = true;
}

export interface DirectorPrevisRenderer {
  render: (time: number, view: DirectorPrevisView) => void;
  capture: (time: number) => string;
  exportVideo: (signal: AbortSignal, progress: (value: number) => void) => Promise<string>;
  dispose: () => void;
}

/** Only trusted geometry constructors are used; model data cannot load URLs, shaders or code. */
export function createDirectorPrevisRenderer(mount: HTMLElement, input: DirectorPrevisScene): DirectorPrevisRenderer {
  const data = normalizeDirectorPrevisScene(input);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(data.background);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = 'block max-h-full max-w-full';
  renderer.domElement.setAttribute('aria-label', '三维镜头预演画面');
  mount.appendChild(renderer.domElement);

  const material = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
  const solid = (geometry: THREE.BufferGeometry, mat: THREE.Material, position?: PrevisVector) => {
    const mesh = new THREE.Mesh(geometry, mat);
    if (position) mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  const objects = new Map<string, THREE.Object3D>();
  for (const obj of data.objects) {
    const [w, h, d] = obj.size;
    const mat = material(obj.color);
    let object: THREE.Object3D;
    if (obj.primitive === 'character') {
      object = new THREE.Group();
      const radius = Math.min(w * 0.24, h * 0.09);
      object.add(solid(new THREE.SphereGeometry(radius, 16, 12), mat, [0, h - radius, 0]));
      object.add(solid(new THREE.CylinderGeometry(radius * 0.5, radius * 0.5, h * 0.12, 12), mat, [0, h * 0.82, 0]));
      object.add(solid(new THREE.SphereGeometry(radius * 0.25, 8, 6), mat, [0, h - radius, radius * 0.95]));
      object.add(solid(new THREE.BoxGeometry(w * 0.65, h * 0.37, d * 0.8), mat, [0, h * 0.62, 0]));
      for (const sign of [-1, 1]) {
        object.add(solid(new THREE.BoxGeometry(w * 0.2, h * 0.4, d * 0.5), mat, [sign * w * 0.43, h * 0.59, 0]));
        object.add(solid(new THREE.BoxGeometry(w * 0.25, h * 0.44, d * 0.65), mat, [sign * w * 0.2, h * 0.22, 0]));
      }
    } else {
      const geometry = obj.primitive === 'sphere' ? new THREE.SphereGeometry(0.5, 24, 16)
        : obj.primitive === 'cylinder' ? new THREE.CylinderGeometry(0.5, 0.5, 1, 24)
          : obj.primitive === 'cone' ? new THREE.ConeGeometry(0.5, 1, 24)
            : obj.primitive === 'plane' ? new THREE.BoxGeometry(1, 0.01 / h, 1)
              : new THREE.BoxGeometry(1, 1, 1);
      object = solid(geometry, mat);
      object.scale.set(w, h, d);
    }
    object.position.set(...obj.position);
    object.rotation.set(...obj.rotation.map(THREE.MathUtils.degToRad) as PrevisVector);
    scene.add(object);
    objects.set(obj.id, object);
  }

  // Frame the whole blocking area, including motion, rather than only the first frame.
  const bounds = new THREE.Box3();
  for (const obj of data.objects) {
    const object = objects.get(obj.id)!;
    const poses = [{ position: obj.position, rotation: obj.rotation }, ...obj.keyframes];
    if (obj.keyframes.some((pose) => pose.rotation.some((angle, i) => angle !== obj.rotation[i]))) {
      object.position.set(0, 0, 0);
      object.rotation.set(0, 0, 0);
      const localBounds = new THREE.Box3().setFromObject(object);
      const radius = new THREE.Vector3(...[0, 1, 2].map((i) =>
        Math.max(Math.abs(localBounds.min.getComponent(i)), Math.abs(localBounds.max.getComponent(i))))).length();
      const diameter = new THREE.Vector3().setScalar(radius * 2);
      for (const pose of poses) bounds.union(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...pose.position), diameter));
    }
    for (const pose of poses) {
      object.position.set(...pose.position);
      object.rotation.set(...pose.rotation.map(THREE.MathUtils.degToRad) as PrevisVector);
      bounds.expandByObject(object);
    }
  }
  const shadowBounds = bounds.clone();
  for (const frame of data.camera.keyframes) bounds.expandByPoint(new THREE.Vector3(...frame.position));
  const center = bounds.getCenter(new THREE.Vector3());
  const span = Math.max(8, bounds.getSize(new THREE.Vector3()).length());
  const ground = solid(new THREE.PlaneGeometry(2000, 2000), material(data.groundColor));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.castShadow = false;
  scene.add(ground);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x586171, 2));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.castShadow = true;
  configurePrevisShadow(light, shadowBounds, renderer.capabilities.maxTextureSize);
  light.shadow.autoUpdate = data.objects.some((object) => object.keyframes.length > 0);
  scene.add(light, light.target);

  const aspect = previsAspectRatio(data);
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.01, 3000);
  camera.filmGauge = 36;
  const spaceCamera = new THREE.PerspectiveCamera(45, aspect, 0.01, 3000);
  spaceCamera.position.copy(center).add(new THREE.Vector3(span * 0.6, span * 0.5, span * 0.75));
  const controls = new OrbitControls(spaceCamera, renderer.domElement);
  controls.target.copy(center);
  controls.maxDistance = 2500;
  controls.update();
  const topCamera = new THREE.OrthographicCamera(-span * aspect / 2, span * aspect / 2, span / 2, -span / 2, 0.01, 3000);
  topCamera.up.set(0, 0, -1);
  topCamera.position.copy(center).add(new THREE.Vector3(0, span * 1.5, 0));
  topCamera.lookAt(center);

  const helpers = new THREE.Group();
  const uiStyle = getComputedStyle(mount);
  const pathColor = uiStyle.getPropertyValue('--node-director').trim() || uiStyle.getPropertyValue('--theme-text').trim();
  const gridColor = uiStyle.getPropertyValue('--theme-text-muted').trim();
  helpers.add(new THREE.GridHelper(Math.ceil(span * 2), 40, new THREE.Color(gridColor), new THREE.Color(gridColor)));
  const pathPoints = Array.from({ length: 161 }, (_, i) => new THREE.Vector3(...samplePrevisCamera(data, data.duration * i / 160).position));
  helpers.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pathPoints), new THREE.LineBasicMaterial({ color: pathColor })));
  const marker = new THREE.Group();
  marker.add(solid(new THREE.BoxGeometry(0.35, 0.25, 0.4), new THREE.MeshBasicMaterial({ color: pathColor })));
  marker.add(solid(new THREE.ConeGeometry(0.18, 0.35, 4), new THREE.MeshBasicMaterial({ color: pathColor }), [0, 0, -0.28]));
  marker.children[1].rotation.x = -Math.PI / 2;
  helpers.add(marker);
  helpers.traverse((object) => { object.castShadow = false; object.receiveShadow = false; });
  scene.add(helpers);
  let disposed = false;
  let exporting = false;
  let lastTime = 0;
  let lastView: DirectorPrevisView = 'camera';

  function renderAt(time: number, view: DirectorPrevisView): void {
    if (disposed) throw new Error('预演画面已关闭');
    for (const obj of data.objects) {
      const pose = samplePrevisObject(obj, time, data.easing === 'smooth');
      const object = objects.get(obj.id)!;
      object.position.set(...pose.position);
      object.rotation.set(...pose.rotation.map(THREE.MathUtils.degToRad) as PrevisVector);
    }
    const frame = samplePrevisCamera(data, time);
    camera.position.set(...frame.position);
    const target = new THREE.Vector3(...frame.target);
    // Interpolated targets can coincide even when every keyframe is valid.
    if (camera.position.distanceTo(target) < 0.01) target.copy(camera.position).add(new THREE.Vector3(0, 0, -1));
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    camera.rotateZ(THREE.MathUtils.degToRad(frame.roll));
    camera.setFocalLength(frame.focalLength);
    helpers.visible = view !== 'camera';
    marker.position.copy(camera.position);
    marker.quaternion.copy(camera.quaternion);
    controls.enabled = view === 'space' && !exporting;
    renderer.render(scene, view === 'space' ? spaceCamera : view === 'top' ? topCamera : camera);
  }
  function resize(): void {
    if (disposed || exporting) return;
    const width = Math.max(1, Math.min(mount.clientWidth, mount.clientHeight * aspect));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, width / aspect);
    renderAt(lastTime, lastView);
  }
  const onControls = () => { if (!exporting && lastView === 'space') renderAt(lastTime, lastView); };
  controls.addEventListener('change', onControls);
  const observer = new ResizeObserver(resize);
  observer.observe(mount);
  resize();

  return {
    render(time, view) { lastTime = time; lastView = view; if (!exporting) renderAt(time, view); },
    capture(time) {
      if (exporting) throw new Error('正在导出参考视频');
      renderer.setPixelRatio(1);
      const width = aspect < 1 ? 1080 : 1920;
      renderer.setSize(width, Math.round(width / aspect), false);
      try { renderAt(time, 'camera'); return renderer.domElement.toDataURL('image/png'); }
      finally { resize(); }
    },
    async exportVideo(signal, progress) {
      if (exporting || disposed) throw new Error('预演画面不可导出');
      signal.throwIfAborted();
      const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, Quality } = await import('mediabunny');
      signal.throwIfAborted();
      if (exporting || disposed) throw new Error('预演画面不可导出');
      const target = new BufferTarget();
      const output = new Output({ format: new Mp4OutputFormat(), target });
      const surface = document.createElement('canvas');
      surface.width = aspect < 1 ? 720 : 1280;
      surface.height = Math.round(surface.width / aspect / 2) * 2;
      const context = surface.getContext('2d', { alpha: false });
      // WebKit 会直接拒绝 quantizer 模式；改用高画质预设按分辨率估算的码率。
      const source = new CanvasSource(surface, { codec: 'avc', quality: new Quality({ quality: 'high', preferBitrate: true }) });
      let finalized = false;
      exporting = true;
      controls.enabled = false;
      try {
        if (!context) throw new Error('无法创建视频画布');
        renderer.setPixelRatio(1);
        renderer.setSize(surface.width, surface.height, false);
        output.addVideoTrack(source, { frameRate: 24 });
        await output.start();
        const count = Math.ceil(data.duration * 24);
        for (let frame = 0; frame < count; frame++) {
          signal.throwIfAborted();
          if (disposed) throw new DOMException('预演画面已关闭', 'AbortError');
          renderAt(frame / 24, 'camera');
          context.drawImage(renderer.domElement, 0, 0, surface.width, surface.height);
          await source.add(frame / 24, Math.min(1 / 24, data.duration - frame / 24));
          progress((frame + 1) / count);
          if (frame % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        source.close();
        await output.finalize();
        finalized = true;
        signal.throwIfAborted();
        if (!target.buffer) throw new Error('未生成参考视频');
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('参考视频读取失败'));
          reader.readAsDataURL(new Blob([target.buffer!], { type: 'video/mp4' }));
        });
      } finally {
        source.close();
        if (!finalized) await output.cancel().catch(() => undefined);
        surface.width = surface.height = 1;
        exporting = false;
        resize();
      }
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      controls.removeEventListener('change', onControls);
      controls.dispose();
      const materials = new Set<THREE.Material>();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
          object.geometry.dispose();
          (Array.isArray(object.material) ? object.material : [object.material]).forEach((mat) => materials.add(mat));
        }
      });
      materials.forEach((mat) => mat.dispose());
      light.shadow.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

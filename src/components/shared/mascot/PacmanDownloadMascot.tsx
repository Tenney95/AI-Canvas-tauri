import { useEffect, useRef } from 'react';
import {
  AmbientLight,
  Color,
  CylinderGeometry,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  Scene,
  Shape,
  SphereGeometry,
  Timer,
  WebGLRenderer,
} from 'three';

export type PacmanDownloadState = 'downloading' | 'complete';

export interface PacmanDownloadMascotProps {
  progress?: number;
  state?: PacmanDownloadState;
}

const TARGET_FPS = 60;
const FRAME_INTERVAL = 1000 / TARGET_FPS;
const PACMAN_RADIUS = 0.48;
const PACMAN_DEPTH = 0.35;
const PACMAN_X = -0.55;
const DOT_START_X = 0.12;
const DOT_SPACING = 0.18;
const DOT_COUNT = 8;

function buildBodyGeometry(mouthAngle: number): ExtrudeGeometry {
  const shape = new Shape();
  shape.moveTo(0, 0);
  shape.absarc(0, 0, PACMAN_RADIUS, mouthAngle, Math.PI * 2 - mouthAngle, false);
  shape.lineTo(0, 0);

  const geo = new ExtrudeGeometry(shape, {
    depth: PACMAN_DEPTH,
    bevelEnabled: false,
  });
  geo.translate(0, 0, -PACMAN_DEPTH / 2);
  return geo;
}

export default function PacmanDownloadMascot({
  progress,
  state = 'downloading',
}: PacmanDownloadMascotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef({ progress, state });

  useEffect(() => {
    runtimeRef.current = { progress, state };
  }, [progress, state]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    const aspect = width / height;
    const scene = new Scene();

    const camera = new PerspectiveCamera(38, aspect, 0.1, 20);
    camera.position.set(0.2, 0.05, 2.35);
    camera.lookAt(PACMAN_X, 0, 0);

    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    scene.add(new AmbientLight(0xfff3a8, 0.42));
    const keyLight = new DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(-1.5, 2.3, 4);
    scene.add(keyLight);
    const warmLight = new PointLight(0xffd21f, 2.2, 4.5);
    warmLight.position.set(-0.3, 0.4, 1.8);
    scene.add(warmLight);
    const rimLight = new PointLight(0xffc090, 0.6, 6);
    rimLight.position.set(1.4, 0.7, 2.2);
    scene.add(rimLight);

    const pacman = new Group();
    pacman.position.set(PACMAN_X, 0, 0);
    pacman.rotation.y = 0.38;
    scene.add(pacman);

    const yellowMat = new MeshStandardMaterial({
      color: 0xffd21f,
      roughness: 0.22,
      metalness: 0.18,
      emissive: new Color(0xffb000),
      emissiveIntensity: 0.12,
    });

    // Body: extruded Pacman silhouette
    const body = new Mesh(buildBodyGeometry(0.45), yellowMat);
    pacman.add(body);

    // Eye
    const eyeGeo = new SphereGeometry(0.06, 24, 16);
    const eyeMat = new MeshBasicMaterial({ color: 0x09090c });
    const eye = new Mesh(eyeGeo, eyeMat);
    eye.position.set(0, 0.19, PACMAN_DEPTH / 2 + 0.03);
    pacman.add(eye);

    // Eye glint
    const glintGeo = new SphereGeometry(0.015, 12, 8);
    const glint = new Mesh(glintGeo, new MeshBasicMaterial({ color: 0xffffff }));
    glint.position.set(-0.005, 0.21, PACMAN_DEPTH / 2 + 0.07);
    pacman.add(glint);

    // Track
    const trackMat = new MeshStandardMaterial({
      color: 0x1f2230,
      transparent: true,
      opacity: 0.88,
      roughness: 0.5,
      metalness: 0.25,
    });
    const track = new Mesh(new CylinderGeometry(0.012, 0.012, 1.9, 16), trackMat);
    track.rotation.z = Math.PI / 2;
    track.position.set(0.35, -0.01, -0.04);
    scene.add(track);

    // Dots
    const dotMat = new MeshStandardMaterial({
      color: 0xfff1a6,
      roughness: 0.35,
      emissive: new Color(0xffc84a),
      emissiveIntensity: 0.2,
    });
    const dotGeo = new SphereGeometry(0.055, 24, 16);
    const dots: Mesh[] = [];
    for (let i = 0; i < DOT_COUNT; i += 1) {
      const dot = new Mesh(dotGeo, dotMat);
      scene.add(dot);
      dots.push(dot);
    }

    const clock = new Timer();
    let raf = 0;
    let lastTime = 0;

    const render = (now: number) => {
      raf = requestAnimationFrame(render);
      if (document.hidden) return;
      const elapsed = now - lastTime;
      if (elapsed < FRAME_INTERVAL) return;
      lastTime = now - (elapsed % FRAME_INTERVAL);
      clock.update();
      const t = clock.getElapsed();

      const { progress: rawProgress, state: currentState } = runtimeRef.current;
      const clampedProgress =
        typeof rawProgress === 'number' ? MathUtils.clamp(rawProgress, 0, 1) : undefined;
      const complete = currentState === 'complete' || clampedProgress === 1;

      // Mouth angle: 0 = closed, ~1.0 = wide open
      const chew = complete ? 0 : (Math.sin(t * 10) + 1) / 2; // 0..1
      const mouthAngle = complete ? 0.05 : 0.2 + chew * 0.7; // 0.05 (closed) .. 0.2..0.9 (chomping)

      const oldBodyGeo = body.geometry;
      body.geometry = buildBodyGeometry(mouthAngle);
      oldBodyGeo.dispose();

      const bodyScale = complete ? 1 + Math.sin(t * 5) * 0.02 : 1;
      pacman.scale.setScalar(bodyScale);
      pacman.rotation.z = Math.sin(t * 2.4) * (complete ? 0.015 : 0.03);
      pacman.rotation.y = 0.38 + Math.sin(t * 1.7) * 0.06;
      warmLight.intensity = complete ? 1.4 : 1.8 + chew * 0.65;

      const phase = typeof clampedProgress === 'number' ? clampedProgress : (t * 0.34) % 1;
      const eatenCount =
        typeof clampedProgress === 'number' ? Math.floor(clampedProgress * DOT_COUNT) : 0;

      dots.forEach((dot, index) => {
        const loopX =
          typeof clampedProgress === 'number'
            ? DOT_START_X + index * DOT_SPACING
            : DOT_START_X + ((index * DOT_SPACING - phase * DOT_SPACING * DOT_COUNT) % (DOT_SPACING * DOT_COUNT));
        const x = loopX < DOT_START_X - DOT_SPACING ? loopX + DOT_SPACING * DOT_COUNT : loopX;
        const isEaten = complete || (typeof clampedProgress === 'number' && index < eatenCount);
        const nearMouth = x < DOT_START_X + DOT_SPACING * 0.6;
        dot.visible = !isEaten && (!nearMouth || typeof clampedProgress !== 'number');
        dot.position.set(x, Math.sin(t * 2.6 + index) * 0.018, 0.08 + Math.sin(t * 3 + index) * 0.025);
        const pulse = 1 + Math.sin(t * 5 + index) * 0.08;
        dot.scale.setScalar(nearMouth && typeof clampedProgress === 'number'
          ? Math.max(0.2, (x - DOT_START_X) / DOT_SPACING + 0.2)
          : pulse);
      });

      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(render);

    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      body.geometry.dispose();
      yellowMat.dispose();
      eyeGeo.dispose();
      eyeMat.dispose();
      glintGeo.dispose();
      (glint.material as MeshBasicMaterial).dispose();
      track.geometry.dispose();
      trackMat.dispose();
      dotGeo.dispose();
      dotMat.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  );
}

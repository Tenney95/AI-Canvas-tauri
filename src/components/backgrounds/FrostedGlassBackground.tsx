import { useEffect, useRef } from 'react';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  BlendFunction,
  BloomEffect,
  EffectComposer,
  EffectPass,
  KernelSize,
  RenderPass,
} from 'postprocessing';

const WORLD_HEIGHT = 12;
const POINTER_LERP = 0.11;

export default function FrostedGlassBackground() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new Scene();
    scene.background = new Color(0xd2d3d1);

    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    camera.position.set(0, 0, 14);
    camera.lookAt(0, 0, 0);
    camera.layers.enable(1);

    const renderer = new WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.domElement.setAttribute('aria-hidden', 'true');
    container.appendChild(renderer.domElement);

    const pmremGenerator = new PMREMGenerator(renderer);
    const roomEnvironment = new RoomEnvironment();
    const environmentTexture = pmremGenerator.fromScene(roomEnvironment, 0.04).texture;
    scene.environment = environmentTexture;
    roomEnvironment.dispose();
    pmremGenerator.dispose();

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomEffect = new BloomEffect({
      blendFunction: BlendFunction.SCREEN,
      kernelSize: KernelSize.LARGE,
      luminanceThreshold: 0.62,
      luminanceSmoothing: 0.52,
    });
    bloomEffect.blendMode.opacity.value = 0.18;
    const bloomPass = new EffectPass(camera, bloomEffect);
    bloomPass.renderToScreen = true;
    composer.addPass(bloomPass);

    scene.add(new AmbientLight(0xffffff, 0.012));
    const directionalLight = new DirectionalLight(0xffffff, 0.035);
    directionalLight.position.set(-4, 6, 10);
    scene.add(directionalLight);

    const sphereKeyLight = new DirectionalLight(0xfff0a8, 3.3);
    sphereKeyLight.position.set(6, 7, 3);
    sphereKeyLight.layers.set(1);
    scene.add(sphereKeyLight);
    const sphereFillLight = new HemisphereLight(0xffca65, 0x2b0700, 0.12);
    sphereFillLight.layers.set(1);
    scene.add(sphereFillLight);

    const tileGroup = new Group();
    scene.add(tileGroup);
    const glassUniforms = {
      glowCenter: { value: new Vector3() },
      glowRadius: { value: 4 },
    };
    const tileMaterial = new MeshPhysicalMaterial({
      color: 0xd6d8d5,
      roughness: 0.64,
      metalness: 0,
      transmission: 0.985,
      thickness: 0.52,
      ior: 1.36,
      dispersion: 0.025,
      attenuationColor: new Color(0xe3e2dc),
      attenuationDistance: 9,
      clearcoat: 0.07,
      clearcoatRoughness: 0.5,
      envMapIntensity: 0.045,
      transparent: true,
      depthWrite: false,
    });
    tileMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.glowCenter = glassUniforms.glowCenter;
      shader.uniforms.glowRadius = glassUniforms.glowRadius;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vFrostedWorldPosition;',
        )
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvFrostedWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform vec3 glowCenter;\nuniform float glowRadius;\nvarying vec3 vFrostedWorldPosition;',
        )
        .replace(
          '#include <opaque_fragment>',
          `#include <opaque_fragment>
          float frostedDistance = distance(vFrostedWorldPosition.xy, glowCenter.xy);
          float frostedReveal = 1.0 - smoothstep(glowRadius * 0.34, glowRadius, frostedDistance);
          gl_FragColor.a *= mix(0.015, 1.0, frostedReveal);`,
        );
    };

    const sphereMaterial = new MeshStandardMaterial({
      color: 0xffaa00,
      emissive: 0x3a1000,
      emissiveIntensity: 0,
      roughness: 0.96,
      metalness: 0,
      envMapIntensity: 0.02,
    });
    let sphereGeometry = new SphereGeometry(1, 64, 48);
    const sphere = new Mesh(sphereGeometry, sphereMaterial);
    sphere.position.z = -2.2;
    sphere.layers.set(1);
    scene.add(sphere);

    let tileGeometry: RoundedBoxGeometry | null = null;
    let worldWidth = WORLD_HEIGHT;
    let currentX = 0;
    let currentY = 0.7;
    let targetX = currentX;
    let targetY = currentY;
    let animationFrame = 0;
    let hasPointerPosition = false;

    const renderScene = () => composer.render();

    const animate = () => {
      animationFrame = 0;
      currentX += (targetX - currentX) * POINTER_LERP;
      currentY += (targetY - currentY) * POINTER_LERP;
      sphere.position.x = currentX;
      sphere.position.y = currentY;
      glassUniforms.glowCenter.value.set(currentX, currentY, 0);
      renderScene();

      if (Math.abs(targetX - currentX) > 0.002 || Math.abs(targetY - currentY) > 0.002) {
        animationFrame = requestAnimationFrame(animate);
      }
    };

    const scheduleRender = () => {
      if (!animationFrame) animationFrame = requestAnimationFrame(animate);
    };

    const rebuildTiles = (width: number, height: number) => {
      worldWidth = WORLD_HEIGHT * (width / height);
      camera.left = -worldWidth / 2;
      camera.right = worldWidth / 2;
      camera.top = WORLD_HEIGHT / 2;
      camera.bottom = -WORLD_HEIGHT / 2;
      camera.updateProjectionMatrix();

      const horizontalLimit = worldWidth / 2;
      const verticalLimit = WORLD_HEIGHT / 2;
      currentX = Math.min(horizontalLimit, Math.max(-horizontalLimit, currentX));
      targetX = Math.min(horizontalLimit, Math.max(-horizontalLimit, targetX));
      currentY = Math.min(verticalLimit, Math.max(-verticalLimit, currentY));
      targetY = Math.min(verticalLimit, Math.max(-verticalLimit, targetY));

      const shortestSide = Math.min(width, height);
      const gapPixels = Math.min(5, Math.max(3, shortestSide * 0.003));
      const tilePixels = Math.min(220, Math.max(128, shortestSide * 0.175));
      const columns = Math.max(1, Math.ceil((width + gapPixels) / (tilePixels + gapPixels)));
      const rows = Math.max(1, Math.ceil((height + gapPixels) / (tilePixels + gapPixels)));
      const worldPerPixel = WORLD_HEIGHT / height;
      const tileSize = tilePixels * worldPerPixel;
      const gapSize = gapPixels * worldPerPixel;

      tileGroup.clear();
      tileGeometry?.dispose();
      const tileDepth = tileSize * 0.72;
      tileGeometry = new RoundedBoxGeometry(
        tileSize,
        tileSize,
        tileDepth,
        3,
        tileSize * (23 / 412.86),
      );
      tileMaterial.thickness = tileDepth;
      tileMaterial.attenuationDistance = tileSize * 3;

      const tileStride = tileSize + gapSize;
      const startX = -((columns - 1) * tileStride) / 2;
      const startY = ((rows - 1) * tileStride) / 2;
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const tile = new Mesh(tileGeometry, tileMaterial);
          tile.position.set(
            startX + column * tileStride,
            startY - row * tileStride,
            0,
          );
          tileGroup.add(tile);
        }
      }

      sphereGeometry.dispose();
      const sphereRadiusPixels = Math.min(180, Math.max(108, shortestSide * 0.137));
      const sphereRadius = sphereRadiusPixels * worldPerPixel;
      sphereGeometry = new SphereGeometry(sphereRadius, 64, 48);
      sphere.geometry = sphereGeometry;
      const glowRadiusPixels = Math.min(340, Math.max(270, shortestSide * 0.33));
      glassUniforms.glowRadius.value = glowRadiusPixels * worldPerPixel;

      if (!hasPointerPosition) {
        currentX = worldWidth * 0.08;
        currentY = WORLD_HEIGHT * 0.08;
        targetX = currentX;
        targetY = currentY;
      }
      sphere.position.set(currentX, currentY, -2.2);
      glassUniforms.glowCenter.value.set(currentX, currentY, 0);
    };

    const resizeObserver = new ResizeObserver(() => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.setSize(width, height, false);
      composer.setSize(width, height);
      rebuildTiles(width, height);
      renderScene();
    });

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const coarsePointer = window.matchMedia('(pointer: coarse)');
    const handlePointerMove = (event: PointerEvent) => {
      if (reducedMotion.matches || coarsePointer.matches) return;
      const bounds = container.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      hasPointerPosition = true;
      targetX = ((event.clientX - bounds.left) / bounds.width - 0.5) * worldWidth;
      targetY = (0.5 - (event.clientY - bounds.top) / bounds.height) * WORLD_HEIGHT;
      scheduleRender();
    };

    const handleMotionPreference = () => {
      if (!reducedMotion.matches && !coarsePointer.matches) return;
      targetX = worldWidth * 0.08;
      targetY = WORLD_HEIGHT * 0.08;
      scheduleRender();
    };

    const handleVisibility = () => {
      if (!document.hidden) scheduleRender();
    };

    resizeObserver.observe(container);
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('visibilitychange', handleVisibility);
    reducedMotion.addEventListener('change', handleMotionPreference);
    coarsePointer.addEventListener('change', handleMotionPreference);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('visibilitychange', handleVisibility);
      reducedMotion.removeEventListener('change', handleMotionPreference);
      coarsePointer.removeEventListener('change', handleMotionPreference);
      if (animationFrame) cancelAnimationFrame(animationFrame);

      tileGroup.clear();
      tileGeometry?.dispose();
      tileMaterial.dispose();
      sphereGeometry.dispose();
      sphereMaterial.dispose();
      environmentTexture.dispose();
      composer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
      renderer.forceContextLoss();
    };
  }, []);

  return (
    <div ref={containerRef} className="canvas-bg-frosted-three" aria-hidden="true">
      <div className="canvas-bg-frosted__grain" />
    </div>
  );
}

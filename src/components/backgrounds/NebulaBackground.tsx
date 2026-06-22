/**
 * NebulaBackground — 星云主题画布背景（Three.js + post-processing）
 *
 * 效果：深邃宇宙底色 + 雾效 + 浮动星云粒子 + Bloom 后处理 + 星空纹理叠加
 */
import { useEffect, useRef, useCallback } from 'react';
import {
  Scene,
  FogExp2,
  PerspectiveCamera,
  WebGLRenderer,
  AmbientLight,
  DirectionalLight,
  PointLight,
  Mesh,
  TextureLoader,
  PlaneGeometry,
  MeshLambertMaterial,
} from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  TextureEffect,
  BlendFunction,
  KernelSize,
} from 'postprocessing';

import Nebula from '../../assets/images/bg/Nebula.png';
import NeaBackgroundLanding from '../../assets/images/bg/NeaBackgroundLanding.jpg';

const NEBULA_TEX_URL = Nebula;
const STARS_BG_URL = NeaBackgroundLanding;

const CLOUD_COUNT = 50;
const CLOUD_ROTATION_SPEED = 0.001;
const FOG_COLOR = 0x0a0514;
const FOG_DENSITY = 0.0000091;
const RENDER_DELTA = 20.1;

export default function NebulaBackground() {
  const containerRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  const init = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    /* ── 场景 ── */
    const scene = new Scene();
    scene.fog = new FogExp2(FOG_COLOR, FOG_DENSITY);

    /* ── 相机 ── */
    const camera = new PerspectiveCamera(
      40,
      container.clientWidth / container.clientHeight,
      1,
      1000,
    );
    camera.position.z = 1;
    camera.rotation.x = 1.16;
    camera.rotation.y = -0.12;
    camera.rotation.z = 0.27;

    /* ── 渲染器 ── */
    const renderer = new WebGLRenderer();
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(scene.fog.color);
    container.appendChild(renderer.domElement);

    /* ── 后处理 Composer ── */
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    /* ── 灯光 ── */
    scene.add(new AmbientLight(0x000000));

    const directionalLight = new DirectionalLight(FOG_COLOR);
    directionalLight.position.set(0, 1, 1);
    scene.add(directionalLight);

    const orangeLight = new PointLight(FOG_COLOR, 150, 50, 0.2);
    orangeLight.position.set(50, 400, 50);
    scene.add(orangeLight);

    const redLight = new PointLight(0x1e0c30, 150, 50, 0.7);
    redLight.position.set(100, 400, 100);
    scene.add(redLight);

    const blueLight = new PointLight(FOG_COLOR, 150, 350, 0.7);
    blueLight.position.set(400, 400, 200);
    scene.add(blueLight);

    /* ── 星云粒子 ── */
    const cloudParticles: Mesh[] = [];

    const loader = new TextureLoader();

    loader.load(NEBULA_TEX_URL, (texture) => {
      const cloudGeo = new PlaneGeometry(700, 700);
      const cloudMaterial = new MeshLambertMaterial({
        map: texture,
        transparent: true,
      });

      for (let p = 0; p < CLOUD_COUNT; p++) {
        const cloud = new Mesh(cloudGeo, cloudMaterial);
        cloud.position.set(
          Math.random() * 800 - 400,
          500,
          Math.random() * 500 - 500,
        );
        cloud.rotation.x = 1.16;
        cloud.rotation.y = -0.12;
        cloud.rotation.z = Math.random() * 2 * Math.PI;
        cloud.material.opacity = 0.25;
        cloudParticles.push(cloud);
        scene.add(cloud);
      }
    });

    loader.load(STARS_BG_URL, (texture) => {
      const textureEffect = new TextureEffect({
        blendFunction: BlendFunction.COLOR_DODGE,
        texture,
      });

      // 底图透明度
      textureEffect.blendMode.opacity.value = 0.8;

      const bloomEffect = new BloomEffect({
        blendFunction: BlendFunction.COLOR_DODGE,
        kernelSize: KernelSize.SMALL,
        luminanceThreshold: 0.0005,
        luminanceSmoothing: 10.5,
      });
      bloomEffect.blendMode.opacity.value = 1.5;

      const effectPass = new EffectPass(camera, bloomEffect, textureEffect);
      effectPass.renderToScreen = true;
      composer.addPass(effectPass);
    });

    /* ── 渲染循环 ── */
    const render = () => {
      animFrameRef.current = requestAnimationFrame(render);
      composer.render(RENDER_DELTA);

      for (let i = 0; i < cloudParticles.length; i++) {
        cloudParticles[i].rotation.z -= CLOUD_ROTATION_SPEED;
      }
    };

    render();

    /* ── 窗口大小响应 ── */
    const handleResize = () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };

    window.addEventListener('resize', handleResize);

    /* ── 清理函数 ── */
    cleanupRef.current = () => {
      cancelAnimationFrame(animFrameRef.current);
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj instanceof Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  useEffect(() => {
    init();
    return () => {
      cleanupRef.current?.();
    };
  }, [init]);

  return <div ref={containerRef} className="nebula-bg" />;
}

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import * as THREE from 'three';
import FullscreenOverlay from '../../../shared/FullscreenOverlay';
import {
  CAMERA_PRESETS,
  DEFAULT_CAMERA_STATE,
  DEFAULT_LIGHT_STATE,
  LIGHT_PRESETS,
  buildStudioPrompt,
  normalizeCameraYaw,
  type CameraDistance,
  type CameraLens,
  type CameraStudioCameraState,
  type CameraStudioLightState,
  type CameraStudioMode,
  type CameraStudioResult,
  type LightTemperature,
} from './cameraStudio';
import '../../../../styles/camera-studio.css';

interface CameraStudioPanelProps {
  isOpen: boolean;
  imageUrl?: string;
  onClose: () => void;
  onGenerate: (result: CameraStudioResult) => void;
}

interface StudioViewportProps {
  imageUrl?: string;
  mode: CameraStudioMode;
  activeControl: 'camera' | 'lighting';
  cameraState: CameraStudioCameraState;
  lightState: CameraStudioLightState;
  onCameraChange: (patch: Partial<CameraStudioCameraState>) => void;
  onLightChange: (patch: Partial<CameraStudioLightState>) => void;
}

const DISTANCE_OPTIONS: Array<{ value: CameraDistance; label: string }> = [
  { value: 'far', label: '远景' },
  { value: 'full', label: '全身' },
  { value: 'medium', label: '中景' },
  { value: 'close', label: '近景' },
  { value: 'extreme-close', label: '特写' },
];

const LENS_OPTIONS: CameraLens[] = ['15mm', '24mm', '35mm', '50mm', '85mm', '200mm', 'fisheye'];
const TEMPERATURE_OPTIONS: Array<{ value: LightTemperature; label: string }> = [
  { value: 'cool', label: '冷光' },
  { value: 'neutral', label: '中性' },
  { value: 'warm', label: '暖光' },
];

function sphericalPosition(yaw: number, pitch: number, radius: number): THREE.Vector3 {
  const yawRad = THREE.MathUtils.degToRad(yaw);
  const pitchRad = THREE.MathUtils.degToRad(pitch);
  return new THREE.Vector3(
    Math.sin(yawRad) * Math.cos(pitchRad) * radius,
    Math.sin(pitchRad) * radius,
    Math.cos(yawRad) * Math.cos(pitchRad) * radius,
  );
}

function StudioViewport({
  imageUrl,
  mode,
  activeControl,
  cameraState,
  lightState,
  onCameraChange,
  onLightChange,
}: StudioViewportProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const cameraMarkerRef = useRef<THREE.Group | null>(null);
  const lightMarkerRef = useRef<THREE.Group | null>(null);
  const lightRef = useRef<THREE.PointLight | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; yaw: number; pitch: number } | null>(null);
  const cameraStateRef = useRef(cameraState);
  const lightStateRef = useRef(lightState);
  const modeRef = useRef(mode);

  useEffect(() => {
    cameraStateRef.current = cameraState;
    lightStateRef.current = lightState;
    modeRef.current = mode;
  }, [cameraState, lightState, mode]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const styles = getComputedStyle(mount);
    const initialCamera = cameraStateRef.current;
    const initialLight = lightStateRef.current;
    const initialMode = modeRef.current;
    const accent = new THREE.Color(styles.getPropertyValue('--node-panorama-light').trim());
    const lightAccent = new THREE.Color(styles.getPropertyValue('--warning-light').trim());
    const grid = new THREE.Color(styles.getPropertyValue('--theme-text-muted').trim());
    const scene = new THREE.Scene();
    const renderCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    renderCamera.position.set(0, 0.25, 6.1);
    renderCamera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'camera-studio-canvas';
    mount.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 1.4);
    scene.add(ambient);

    const sphereGeometry = new THREE.SphereGeometry(1.72, 28, 18);
    const sphereMaterial = new THREE.MeshBasicMaterial({ color: grid, wireframe: true, transparent: true, opacity: 0.38 });
    scene.add(new THREE.Mesh(sphereGeometry, sphereMaterial));

    const ringGeometry = new THREE.TorusGeometry(1.73, 0.008, 8, 96);
    const ringMaterial = new THREE.MeshBasicMaterial({ color: grid, transparent: true, opacity: 0.7 });
    const horizontalRing = new THREE.Mesh(ringGeometry, ringMaterial);
    horizontalRing.rotation.x = Math.PI / 2;
    scene.add(horizontalRing);
    const verticalRing = new THREE.Mesh(ringGeometry, ringMaterial.clone());
    scene.add(verticalRing);

    const subjectGroup = new THREE.Group();
    const subjectBack = new THREE.Mesh(
      new THREE.CircleGeometry(0.83, 48),
      new THREE.MeshBasicMaterial({ color: grid, transparent: true, opacity: 0.24 }),
    );
    subjectGroup.add(subjectBack);
    scene.add(subjectGroup);

    let subjectTexture: THREE.Texture | undefined;
    let disposed = false;
    if (imageUrl) {
      new THREE.TextureLoader().load(
        imageUrl,
        (texture) => {
          if (disposed) {
            texture.dispose();
            return;
          }
          subjectTexture = texture;
          texture.colorSpace = THREE.SRGBColorSpace;
          const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide });
          const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 1.45), material);
          plane.position.z = 0.02;
          subjectGroup.add(plane);
        },
        undefined,
        () => undefined,
      );
    }

    const cameraMarker = new THREE.Group();
    const cameraBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.23, 0.2),
      new THREE.MeshStandardMaterial({ color: accent, roughness: 0.35, metalness: 0.25 }),
    );
    const cameraLens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.13, 0.2, 20),
      new THREE.MeshStandardMaterial({ color: accent, roughness: 0.25, metalness: 0.5 }),
    );
    cameraLens.rotation.x = Math.PI / 2;
    cameraLens.position.z = -0.18;
    cameraMarker.add(cameraBody, cameraLens);
    cameraMarker.visible = initialMode !== 'lighting';
    cameraMarker.position.copy(sphericalPosition(initialCamera.yaw, initialCamera.pitch, 2.35));
    cameraMarker.lookAt(0, 0, 0);
    cameraMarker.rotateZ(THREE.MathUtils.degToRad(initialCamera.roll));
    scene.add(cameraMarker);
    cameraMarkerRef.current = cameraMarker;

    const lightMarker = new THREE.Group();
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.15, 24, 16),
      new THREE.MeshBasicMaterial({ color: lightAccent }),
    );
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(0.22, 0.27, 32),
      new THREE.MeshBasicMaterial({ color: lightAccent, transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
    );
    lightMarker.add(bulb, halo);
    lightMarker.visible = initialMode !== 'camera';
    const initialLightPosition = sphericalPosition(initialLight.yaw, initialLight.pitch, 2.25);
    lightMarker.position.copy(initialLightPosition);
    lightMarker.lookAt(0, 0, 0);
    scene.add(lightMarker);
    lightMarkerRef.current = lightMarker;

    const keyLight = new THREE.PointLight(lightAccent, 2.5, 12);
    keyLight.position.copy(initialLightPosition);
    keyLight.intensity = initialLight.intensity / 24;
    scene.add(keyLight);
    lightRef.current = keyLight;

    const resize = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      renderer.setSize(width, height, false);
      renderCamera.aspect = width / height;
      renderCamera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    let animationFrame = 0;
    const render = () => {
      horizontalRing.rotation.z += 0.0008;
      renderer.render(scene, renderCamera);
      animationFrame = requestAnimationFrame(render);
    };
    render();

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      cameraMarkerRef.current = null;
      lightMarkerRef.current = null;
      lightRef.current = null;
      subjectTexture?.dispose();
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [imageUrl]);

  useEffect(() => {
    const marker = cameraMarkerRef.current;
    if (!marker) return;
    marker.visible = mode !== 'lighting';
    marker.position.copy(sphericalPosition(cameraState.yaw, cameraState.pitch, 2.35));
    marker.lookAt(0, 0, 0);
    marker.rotateZ(THREE.MathUtils.degToRad(cameraState.roll));
  }, [cameraState.pitch, cameraState.roll, cameraState.yaw, mode]);

  useEffect(() => {
    const marker = lightMarkerRef.current;
    const keyLight = lightRef.current;
    if (!marker || !keyLight) return;
    marker.visible = mode !== 'camera';
    const position = sphericalPosition(lightState.yaw, lightState.pitch, 2.25);
    marker.position.copy(position);
    marker.lookAt(0, 0, 0);
    keyLight.position.copy(position);
    keyLight.intensity = lightState.intensity / 24;
  }, [lightState.intensity, lightState.pitch, lightState.yaw, mode]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const target = mode === 'dual' ? activeControl : mode;
    const state = target === 'lighting' ? lightState : cameraState;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, yaw: state.yaw, pitch: state.pitch };
  }, [activeControl, cameraState, lightState, mode]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const yaw = normalizeCameraYaw(drag.yaw + (event.clientX - drag.x) * 0.45);
    const pitch = Math.max(-80, Math.min(80, drag.pitch - (event.clientY - drag.y) * 0.35));
    const target = mode === 'dual' ? activeControl : mode;
    if (target === 'lighting') onLightChange({ yaw, pitch });
    else onCameraChange({ yaw, pitch });
  }, [activeControl, mode, onCameraChange, onLightChange]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  return (
    <div
      ref={mountRef}
      className="camera-studio-viewport"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div className="camera-studio-axis camera-studio-axis--yaw">YAW</div>
      <div className="camera-studio-axis camera-studio-axis--pitch">PITCH</div>
      <div className="camera-studio-readout">
        <span>{mode === 'lighting' || (mode === 'dual' && activeControl === 'lighting') ? 'LIGHT' : 'CAM'}</span>
        <strong>{Math.round(mode === 'lighting' || (mode === 'dual' && activeControl === 'lighting') ? lightState.yaw : cameraState.yaw)} deg</strong>
      </div>
    </div>
  );
}

interface RangeControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}

function RangeControl({ label, value, min, max, step = 1, suffix = '', onChange }: RangeControlProps) {
  return (
    <label className="camera-studio-range">
      <span>{label}</span>
      <output>{Math.round(value * 10) / 10}{suffix}</output>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function CameraStudioPanel({ isOpen, imageUrl, onClose, onGenerate }: CameraStudioPanelProps) {
  const [mode, setMode] = useState<CameraStudioMode>('camera');
  const [activeControl, setActiveControl] = useState<'camera' | 'lighting'>('camera');
  const [cameraState, setCameraState] = useState<CameraStudioCameraState>(() => ({ ...DEFAULT_CAMERA_STATE }));
  const [lightState, setLightState] = useState<CameraStudioLightState>(() => ({ ...DEFAULT_LIGHT_STATE }));
  const [copied, setCopied] = useState(false);

  const prompt = useMemo(() => buildStudioPrompt(mode, cameraState, lightState), [cameraState, lightState, mode]);
  const updateCamera = useCallback((patch: Partial<CameraStudioCameraState>) => {
    setCameraState((current) => ({ ...current, ...patch }));
  }, []);
  const updateLight = useCallback((patch: Partial<CameraStudioLightState>) => {
    setLightState((current) => ({ ...current, ...patch }));
  }, []);

  const handleModeChange = useCallback((nextMode: CameraStudioMode) => {
    setMode(nextMode);
    if (nextMode !== 'dual') setActiveControl(nextMode);
  }, []);

  const handleReset = useCallback(() => {
    setCameraState({ ...DEFAULT_CAMERA_STATE });
    setLightState({ ...DEFAULT_LIGHT_STATE });
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, [prompt]);

  const handleGenerate = useCallback(() => {
    onGenerate({ mode, camera: cameraState, light: lightState, prompt });
  }, [cameraState, lightState, mode, onGenerate, prompt]);

  const showCamera = mode === 'camera' || (mode === 'dual' && activeControl === 'camera');

  return (
    <FullscreenOverlay
      isOpen={isOpen}
      onClose={onClose}
      title="小逻摄影棚"
      panelWidth="min(96vw, 1180px)"
      className="camera-studio-overlay"
      bodyClassName="camera-studio-body"
      headerContent={(
        <div className="camera-studio-mode" role="tablist" aria-label="摄影棚模式">
          <button type="button" className={mode === 'camera' ? 'is-active' : ''} onClick={() => handleModeChange('camera')}>
            <Icon icon="mdi:camera-outline" width={14} />摄影机
          </button>
          <button type="button" className={mode === 'lighting' ? 'is-active is-light' : ''} onClick={() => handleModeChange('lighting')}>
            <Icon icon="mdi:lightbulb-on-outline" width={14} />打光
          </button>
          <button type="button" className={mode === 'dual' ? 'is-active' : ''} onClick={() => handleModeChange('dual')}>
            <Icon icon="mdi:vector-combine" width={14} />联动
          </button>
        </div>
      )}
    >
      <div className="camera-studio-shell">
        <section className="camera-studio-stage">
          {mode === 'dual' ? (
            <div className="camera-studio-focus-switch" aria-label="联动控制对象">
              <button type="button" className={activeControl === 'camera' ? 'is-active' : ''} onClick={() => setActiveControl('camera')}>摄影机</button>
              <button type="button" className={activeControl === 'lighting' ? 'is-active is-light' : ''} onClick={() => setActiveControl('lighting')}>主光源</button>
            </div>
          ) : null}
          <StudioViewport
            imageUrl={imageUrl}
            mode={mode}
            activeControl={activeControl}
            cameraState={cameraState}
            lightState={lightState}
            onCameraChange={updateCamera}
            onLightChange={updateLight}
          />
          <div className="camera-studio-prompt">
            <div>
              <Icon icon="mdi:console-line" width={14} />
              <span>STUDIO PROMPT</span>
              <b>{mode.toUpperCase()}</b>
            </div>
            <button type="button" onClick={handleCopy} data-tooltip={copied ? '已复制' : '复制提示词'} aria-label="复制提示词">
              <Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} width={15} />
            </button>
            <p>{prompt}</p>
          </div>
        </section>

        <aside className="camera-studio-controls">
          {showCamera ? (
            <>
              <div className="camera-studio-section-title"><Icon icon="mdi:camera-control" width={16} /><span>摄影机参数</span></div>
              <div className="camera-studio-presets">
                {CAMERA_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => updateCamera({ yaw: preset.yaw, pitch: preset.pitch, roll: preset.roll ?? 0, ...(preset.lens ? { lens: preset.lens } : {}) })}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="camera-studio-range-grid">
                <RangeControl label="水平角度" value={cameraState.yaw} min={-180} max={180} suffix="°" onChange={(yaw) => updateCamera({ yaw })} />
                <RangeControl label="垂直角度" value={cameraState.pitch} min={-80} max={80} suffix="°" onChange={(pitch) => updateCamera({ pitch })} />
                <RangeControl label="画面倾斜" value={cameraState.roll} min={-45} max={45} suffix="°" onChange={(roll) => updateCamera({ roll })} />
              </div>
              <div className="camera-studio-select-grid">
                <label><span>景别</span><select value={cameraState.distance} onChange={(event) => updateCamera({ distance: event.target.value as CameraDistance })}>{DISTANCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label><span>镜头</span><select value={cameraState.lens} onChange={(event) => updateCamera({ lens: event.target.value as CameraLens })}>{LENS_OPTIONS.map((lens) => <option key={lens} value={lens}>{lens}</option>)}</select></label>
              </div>
              <label className="camera-studio-toggle"><input type="checkbox" checked={cameraState.promptEnhance} onChange={(event) => updateCamera({ promptEnhance: event.target.checked })} /><span>电影感增强</span></label>
            </>
          ) : (
            <>
              <div className="camera-studio-section-title is-light"><Icon icon="mdi:lightbulb-on-outline" width={16} /><span>主光源参数</span></div>
              <div className="camera-studio-presets is-light">
                {LIGHT_PRESETS.map((preset) => (
                  <button key={preset.id} type="button" onClick={() => updateLight({ yaw: preset.yaw, pitch: preset.pitch })}>{preset.label}</button>
                ))}
              </div>
              <div className="camera-studio-range-grid">
                <RangeControl label="水平角度" value={lightState.yaw} min={-180} max={180} suffix="°" onChange={(yaw) => updateLight({ yaw })} />
                <RangeControl label="垂直角度" value={lightState.pitch} min={-80} max={80} suffix="°" onChange={(pitch) => updateLight({ pitch })} />
                <RangeControl label="光照强度" value={lightState.intensity} min={10} max={100} suffix="%" onChange={(intensity) => updateLight({ intensity })} />
              </div>
              <div className="camera-studio-temperature" aria-label="色温">
                {TEMPERATURE_OPTIONS.map((option) => <button key={option.value} type="button" className={lightState.temperature === option.value ? 'is-active' : ''} onClick={() => updateLight({ temperature: option.value })}>{option.label}</button>)}
              </div>
              <div className="camera-studio-toggle-row">
                <label className="camera-studio-toggle"><input type="checkbox" checked={lightState.fillLight} onChange={(event) => updateLight({ fillLight: event.target.checked })} /><span>柔和补光</span></label>
                <label className="camera-studio-toggle"><input type="checkbox" checked={lightState.rimLight} onChange={(event) => updateLight({ rimLight: event.target.checked })} /><span>轮廓光</span></label>
              </div>
            </>
          )}

          <div className="camera-studio-actions">
            <button type="button" className="camera-studio-reset" onClick={handleReset} data-tooltip="重置参数" aria-label="重置参数"><Icon icon="mdi:restore" width={17} /></button>
            <button type="button" className="camera-studio-generate" onClick={handleGenerate}><Icon icon="mdi:creation" width={17} />生成图片</button>
          </div>
        </aside>
      </div>
    </FullscreenOverlay>
  );
}

export default memo(CameraStudioPanel);

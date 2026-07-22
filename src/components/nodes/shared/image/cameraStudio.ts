export type CameraStudioMode = 'camera' | 'lighting' | 'dual';
export type CameraDistance = 'far' | 'full' | 'medium' | 'close' | 'extreme-close';
export type CameraLens = '15mm' | '24mm' | '35mm' | '50mm' | '85mm' | '200mm' | 'fisheye';
export type LightTemperature = 'cool' | 'neutral' | 'warm';

export interface CameraStudioCameraState {
  yaw: number;
  pitch: number;
  roll: number;
  distance: CameraDistance;
  lens: CameraLens;
  promptEnhance: boolean;
}

export interface CameraStudioLightState {
  yaw: number;
  pitch: number;
  intensity: number;
  temperature: LightTemperature;
  rimLight: boolean;
  fillLight: boolean;
}

export interface CameraStudioResult {
  mode: CameraStudioMode;
  camera: CameraStudioCameraState;
  light: CameraStudioLightState;
  prompt: string;
}

export interface CameraPreset {
  id: string;
  label: string;
  yaw: number;
  pitch: number;
  roll?: number;
  lens?: CameraLens;
}

export interface LightPreset {
  id: string;
  label: string;
  yaw: number;
  pitch: number;
}

export const DEFAULT_CAMERA_STATE: CameraStudioCameraState = {
  yaw: 0,
  pitch: 0,
  roll: 0,
  distance: 'medium',
  lens: '35mm',
  promptEnhance: true,
};

export const DEFAULT_LIGHT_STATE: CameraStudioLightState = {
  yaw: 45,
  pitch: 30,
  intensity: 65,
  temperature: 'neutral',
  rimLight: false,
  fillLight: true,
};

export const CAMERA_PRESETS: CameraPreset[] = [
  { id: 'front', label: '正面', yaw: 0, pitch: 0 },
  { id: 'three-quarter', label: '右前 3/4', yaw: 45, pitch: 0 },
  { id: 'profile', label: '侧面', yaw: 90, pitch: 0 },
  { id: 'back', label: '背面', yaw: 180, pitch: 0 },
  { id: 'high', label: '高机位', yaw: 20, pitch: 38, lens: '50mm' },
  { id: 'low', label: '低机位', yaw: -20, pitch: -24, lens: '24mm' },
  { id: 'overhead', label: '俯拍', yaw: 0, pitch: 76, lens: '35mm' },
  { id: 'dutch', label: '荷兰角', yaw: 25, pitch: 4, roll: 18, lens: '35mm' },
];

export const LIGHT_PRESETS: LightPreset[] = [
  { id: 'front', label: '正面光', yaw: 0, pitch: 18 },
  { id: 'left', label: '左侧光', yaw: -90, pitch: 25 },
  { id: 'right', label: '右侧光', yaw: 90, pitch: 25 },
  { id: 'top', label: '顶光', yaw: 0, pitch: 72 },
  { id: 'back', label: '逆光', yaw: 180, pitch: 25 },
  { id: 'bottom', label: '底光', yaw: 0, pitch: -45 },
];

export function normalizeCameraYaw(value: number): number {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function describeCameraYaw(yaw: number): string {
  const angle = normalizeCameraYaw(yaw);
  if (angle >= -22.5 && angle < 22.5) return 'front camera view';
  if (angle >= 22.5 && angle < 67.5) return 'front-right three-quarter view';
  if (angle >= 67.5 && angle < 112.5) return 'right profile camera view';
  if (angle >= 112.5 && angle < 157.5) return 'rear-right three-quarter view';
  if (angle >= 157.5 || angle < -157.5) return 'rear camera view';
  if (angle >= -157.5 && angle < -112.5) return 'rear-left three-quarter view';
  if (angle >= -112.5 && angle < -67.5) return 'left profile camera view';
  return 'front-left three-quarter view';
}

function describeCameraPitch(pitch: number): string {
  if (pitch >= 65) return 'overhead top-down shot';
  if (pitch > 15) return 'high-angle shot';
  if (pitch < -12) return 'low-angle shot';
  return 'eye-level shot';
}

const DISTANCE_PROMPTS: Record<CameraDistance, string> = {
  far: 'wide establishing framing',
  full: 'full-body framing',
  medium: 'medium-shot framing',
  close: 'close-up framing',
  'extreme-close': 'extreme close-up framing',
};

const LENS_PROMPTS: Record<CameraLens, string> = {
  '15mm': '15mm ultra-wide lens',
  '24mm': '24mm wide-angle lens',
  '35mm': '35mm cinematic lens',
  '50mm': '50mm natural perspective lens',
  '85mm': '85mm portrait lens',
  '200mm': '200mm telephoto lens compression',
  fisheye: 'fisheye lens distortion',
};

function describeLightDirection(light: CameraStudioLightState): string {
  const yaw = normalizeCameraYaw(light.yaw);
  let direction = 'front';
  if (yaw >= 45 && yaw < 135) direction = 'right-side';
  else if (yaw <= -45 && yaw > -135) direction = 'left-side';
  else if (yaw >= 135 || yaw <= -135) direction = 'back';

  let elevation = '';
  if (light.pitch > 20) elevation = ' elevated';
  else if (light.pitch < -15) elevation = ' low';
  return `${direction}${elevation} key light`;
}

const TEMPERATURE_PROMPTS: Record<LightTemperature, string> = {
  cool: 'cool daylight color temperature',
  neutral: 'neutral studio color temperature',
  warm: 'warm tungsten color temperature',
};

export function buildCameraPrompt(camera: CameraStudioCameraState): string {
  const terms = [
    describeCameraYaw(camera.yaw),
    describeCameraPitch(camera.pitch),
    DISTANCE_PROMPTS[camera.distance],
    LENS_PROMPTS[camera.lens],
  ];
  if (Math.abs(camera.roll) >= 1) terms.push(`${Math.round(camera.roll)} degree dutch angle`);
  if (camera.promptEnhance) terms.push('cinematic composition, coherent subject identity, high detail');
  return terms.join(', ');
}

export function buildLightingPrompt(light: CameraStudioLightState): string {
  const terms = [
    describeLightDirection(light),
    `${Math.round(light.intensity)}% intensity`,
    TEMPERATURE_PROMPTS[light.temperature],
  ];
  if (light.rimLight) terms.push('subtle rim light');
  if (light.fillLight) terms.push('soft fill light');
  return terms.join(', ');
}

export function buildStudioPrompt(
  mode: CameraStudioMode,
  camera: CameraStudioCameraState,
  light: CameraStudioLightState,
): string {
  if (mode === 'camera') return buildCameraPrompt(camera);
  if (mode === 'lighting') return buildLightingPrompt(light);
  return `${buildCameraPrompt(camera)}, ${buildLightingPrompt(light)}`;
}

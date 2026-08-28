/**
 * 3D 导演节点的固定运行时路由表。
 *
 * 本模块不提供动态注册入口。lightweight-web 复用现有导演台服务；Blender 在接入
 * 固定脚本与场景协议前只返回 unavailable，不能回退或触发网页运行时。
 */
import type { DirectorRuntimeKind } from '../types';
import type { DirectorDeskProtocolMessage } from './directorDeskWindowService';

export const DEFAULT_DIRECTOR_RUNTIME_KIND: DirectorRuntimeKind = 'lightweight-web';
export const BLENDER_RUNTIME_UNAVAILABLE_REASON = 'Blender 导演运行时尚未接入';
const INVALID_RUNTIME_REASON = '未知 3D 导演运行时，已拒绝自动回退';

export interface DirectorRuntimeCapabilities {
  open: boolean;
  exportFrame: boolean;
  exportVideo: boolean;
}

export interface DirectorRuntimeDescriptor {
  kind: DirectorRuntimeKind;
  label: string;
  selectable: boolean;
  capabilities: DirectorRuntimeCapabilities;
  unavailableReason?: string;
}

export type DirectorRuntimeAvailability =
  | { state: 'ready' }
  | { state: 'setup-required' }
  | { state: 'unavailable'; reason: string };

export interface DirectorRuntimeCapture {
  dataUrl: string;
  fileName: string;
}

export type DirectorRuntimeEvent =
  | { type: 'ready' }
  | { type: 'closed' }
  | { type: 'captures'; captures: DirectorRuntimeCapture[] };

export type DirectorRuntimeResolution =
  | {
      supported: true;
      kind: DirectorRuntimeKind;
      descriptor: DirectorRuntimeDescriptor;
    }
  | {
      supported: false;
      rawKind: string;
      reason: string;
    };

export interface DirectorRuntimeOpenRequest {
  instanceId: string;
  theme: 'dark' | 'light';
}

export interface DirectorRuntimeFrameExportOptions {
  position: 'current';
  quality: '1080p';
  fileName: string;
}

export interface DirectorRuntimeVideoExportOptions {
  quality: '720p';
  fps: number;
  fileName: string;
}

export interface DirectorRuntimeVideoResult {
  mediaUrl: string;
  fileName?: string;
}

const LIGHTWEIGHT_WEB_DESCRIPTOR: DirectorRuntimeDescriptor = {
  kind: 'lightweight-web',
  label: '轻量导演台',
  selectable: true,
  capabilities: {
    open: true,
    exportFrame: true,
    exportVideo: true,
  },
};

const BLENDER_DESCRIPTOR: DirectorRuntimeDescriptor = {
  kind: 'blender',
  label: 'Blender（即将开放）',
  selectable: false,
  capabilities: {
    open: false,
    exportFrame: false,
    exportVideo: false,
  },
  unavailableReason: BLENDER_RUNTIME_UNAVAILABLE_REASON,
};

const DIRECTOR_RUNTIME_DESCRIPTORS = {
  'lightweight-web': LIGHTWEIGHT_WEB_DESCRIPTOR,
  blender: BLENDER_DESCRIPTOR,
} satisfies Record<DirectorRuntimeKind, DirectorRuntimeDescriptor>;

export const DIRECTOR_RUNTIME_OPTIONS: readonly DirectorRuntimeDescriptor[] = [
  LIGHTWEIGHT_WEB_DESCRIPTOR,
  BLENDER_DESCRIPTOR,
];

export function resolveDirectorRuntime(value: unknown): DirectorRuntimeResolution {
  if (
    value === undefined
    || value === null
    || (typeof value === 'string' && value.trim() === '')
  ) {
    return {
      supported: true,
      kind: DEFAULT_DIRECTOR_RUNTIME_KIND,
      descriptor: DIRECTOR_RUNTIME_DESCRIPTORS[DEFAULT_DIRECTOR_RUNTIME_KIND],
    };
  }

  if (value === 'lightweight-web' || value === 'blender') {
    return {
      supported: true,
      kind: value,
      descriptor: DIRECTOR_RUNTIME_DESCRIPTORS[value],
    };
  }

  return {
    supported: false,
    rawKind: typeof value === 'string' ? value.slice(0, 64) : '<invalid>',
    reason: INVALID_RUNTIME_REASON,
  };
}

export async function getDirectorRuntimeAvailability(
  value: unknown,
): Promise<DirectorRuntimeAvailability> {
  const resolution = resolveDirectorRuntime(value);
  if (!resolution.supported) {
    return { state: 'unavailable', reason: resolution.reason };
  }
  if (resolution.kind === 'blender') {
    return {
      state: 'unavailable',
      reason: resolution.descriptor.unavailableReason ?? BLENDER_RUNTIME_UNAVAILABLE_REASON,
    };
  }

  const runtimeService = await import('./directorDeskRuntimeService');
  if (!runtimeService.isDirectorDeskRuntimeAvailable()) {
    return { state: 'unavailable', reason: '3D 导演台独立窗口仅支持 Tauri 桌面端' };
  }
  const status = await runtimeService.getDirectorDeskRuntimeStatus();
  return status.installed ? { state: 'ready' } : { state: 'setup-required' };
}

function assertLightweightWebRuntime(value: unknown): void {
  const resolution = resolveDirectorRuntime(value);
  if (!resolution.supported) throw new Error(resolution.reason);
  if (resolution.kind !== 'lightweight-web') {
    throw new Error(
      resolution.descriptor.unavailableReason ?? BLENDER_RUNTIME_UNAVAILABLE_REASON,
    );
  }
}

export async function openDirectorRuntime(
  value: unknown,
  request: DirectorRuntimeOpenRequest,
): Promise<void> {
  assertLightweightWebRuntime(value);
  const { openDirectorDeskWindow } = await import('./directorDeskWindowService');
  await openDirectorDeskWindow(request);
}

function mapLightweightWebEvent(
  message: DirectorDeskProtocolMessage,
): DirectorRuntimeEvent | null {
  if (message.type === 'storyai:director-desk-ready') return { type: 'ready' };
  if (message.type === 'storyai:director-desk-close') return { type: 'closed' };
  if (message.type !== 'storyai:director-desk-captures-sent') return null;

  const captures = Array.isArray(message.payload?.captures)
    ? message.payload.captures
      .map((capture) => {
        if (!capture || typeof capture !== 'object') return null;
        const item = capture as Record<string, unknown>;
        const dataUrl = typeof item.dataUrl === 'string' ? item.dataUrl.trim() : '';
        if (!dataUrl.startsWith('data:image/')) return null;
        return {
          dataUrl,
          fileName: typeof item.fileName === 'string' && item.fileName.trim()
            ? item.fileName.trim()
            : 'director-capture.png',
        } satisfies DirectorRuntimeCapture;
      })
      .filter((capture): capture is DirectorRuntimeCapture => capture !== null)
    : [];
  return { type: 'captures', captures };
}

export function subscribeDirectorRuntime(
  value: unknown,
  instanceId: string,
  listener: (event: DirectorRuntimeEvent) => void,
): () => void {
  const resolution = resolveDirectorRuntime(value);
  if (!resolution.supported || resolution.kind !== 'lightweight-web') return () => {};

  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  void import('./directorDeskWindowService')
    .then(({ subscribeDirectorDeskWindow }) => {
      if (disposed) return;
      unsubscribe = subscribeDirectorDeskWindow(instanceId, (message) => {
        const event = mapLightweightWebEvent(message);
        if (event) listener(event);
      });
    })
    .catch((error) => {
      console.error('[directorRuntimeRegistry] 初始化轻量导演台订阅失败:', error);
    });

  return () => {
    disposed = true;
    unsubscribe?.();
  };
}

export async function exportDirectorRuntimeFrame(
  value: unknown,
  instanceId: string,
  options: DirectorRuntimeFrameExportOptions,
): Promise<DirectorRuntimeCapture> {
  assertLightweightWebRuntime(value);
  const { requestDirectorWindowAction } = await import('./directorDeskWindowService');
  const result = (await requestDirectorWindowAction(
    instanceId,
    'export.frame',
    { ...options },
  )) as { dataUrl?: unknown; fileName?: unknown } | undefined;
  const dataUrl = typeof result?.dataUrl === 'string' ? result.dataUrl.trim() : '';
  if (!dataUrl.startsWith('data:image/')) {
    throw new Error('导演台未返回有效帧图');
  }
  return {
    dataUrl,
    fileName: typeof result?.fileName === 'string' && result.fileName.trim()
      ? result.fileName.trim()
      : 'director-frame.png',
  };
}

export async function exportDirectorRuntimeVideo(
  value: unknown,
  instanceId: string,
  options: DirectorRuntimeVideoExportOptions,
): Promise<DirectorRuntimeVideoResult> {
  assertLightweightWebRuntime(value);
  const { requestDirectorWindowAction } = await import('./directorDeskWindowService');
  const result = (await requestDirectorWindowAction(
    instanceId,
    'export.video',
    { ...options },
    90_000,
  )) as { dataUrl?: unknown; blobUrl?: unknown; fileName?: unknown } | undefined;
  const mediaUrl = typeof result?.dataUrl === 'string' && result.dataUrl
    ? result.dataUrl
    : typeof result?.blobUrl === 'string'
      ? result.blobUrl
      : '';
  if (!mediaUrl) {
    throw new Error('导演台未返回参考视频（需先录制运镜轨迹）');
  }
  return {
    mediaUrl,
    ...(typeof result?.fileName === 'string' && result.fileName.trim()
      ? { fileName: result.fileName.trim() }
      : {}),
  };
}

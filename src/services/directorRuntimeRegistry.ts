/**
 * 3D 导演节点的固定运行时路由表。
 *
 * 本模块不提供动态注册入口。lightweight-web 复用现有导演台服务；Blender 在接入
 * 固定脚本与场景协议前只返回 unavailable，不能回退或触发网页运行时。
 */
import type {
  DirectorResultManifestReference,
  DirectorRuntimeKind,
  DirectorSceneReference,
} from '../types';
import type { DirectorBlenderJobStatus } from './directorBlenderRuntimeService';
import type { DirectorDeskProtocolMessage } from './directorDeskWindowService';

export const DEFAULT_DIRECTOR_RUNTIME_KIND: DirectorRuntimeKind = 'lightweight-web';
export const BLENDER_RUNTIME_UNAVAILABLE_REASON = 'Blender 导演运行时仅支持 Tauri 桌面端';
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
  dataUrl?: string;
  mediaUrl?: string;
  filePath?: string;
  fileName: string;
  manifestReference?: DirectorResultManifestReference;
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
  blender?: DirectorRuntimeBlenderContext;
}

export interface DirectorRuntimeBlenderContext {
  projectId: string;
  sceneReference: DirectorSceneReference;
  previousManifestReference?: DirectorResultManifestReference;
  signal?: AbortSignal;
  onStatus?: (status: DirectorBlenderJobStatus) => void;
}

export interface DirectorRuntimeOpenResult {
  manifestReference?: DirectorResultManifestReference;
  blendFilePath?: string;
}

export interface DirectorRuntimeFrameExportOptions {
  position: 'current';
  quality: '1080p';
  fileName: string;
  targetFrame?: number;
  blender?: DirectorRuntimeBlenderContext;
}

export interface DirectorRuntimeVideoExportOptions {
  quality: '720p';
  fps: number;
  fileName: string;
  blender?: DirectorRuntimeBlenderContext;
}

export interface DirectorRuntimeVideoResult {
  mediaUrl: string;
  fileName?: string;
  filePath?: string;
  manifestReference?: DirectorResultManifestReference;
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
  label: 'Blender',
  selectable: true,
  capabilities: {
    open: true,
    exportFrame: true,
    exportVideo: true,
  },
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
    const { getDirectorBlenderAvailability } = await import('./directorBlenderRuntimeService');
    return getDirectorBlenderAvailability();
  }

  const runtimeService = await import('./directorDeskRuntimeService');
  if (!runtimeService.isDirectorDeskRuntimeAvailable()) {
    return { state: 'unavailable', reason: '3D 导演台独立窗口仅支持 Tauri 桌面端' };
  }
  const status = await runtimeService.getDirectorDeskRuntimeStatus();
  return status.installed ? { state: 'ready' } : { state: 'setup-required' };
}

function requireSupportedRuntime(value: unknown): DirectorRuntimeKind {
  const resolution = resolveDirectorRuntime(value);
  if (!resolution.supported) throw new Error(resolution.reason);
  return resolution.kind;
}

function requireBlenderContext(
  context: DirectorRuntimeBlenderContext | undefined,
): DirectorRuntimeBlenderContext {
  if (!context) throw new Error('Blender 导演操作缺少项目与场景绑定');
  return context;
}

export async function prepareDirectorRuntime(value: unknown): Promise<void> {
  const kind = requireSupportedRuntime(value);
  if (kind !== 'blender') return;
  const { prepareDirectorBlenderInstallation } = await import('./directorBlenderRuntimeService');
  await prepareDirectorBlenderInstallation();
}

export async function openDirectorRuntime(
  value: unknown,
  request: DirectorRuntimeOpenRequest,
): Promise<DirectorRuntimeOpenResult | void> {
  const kind = requireSupportedRuntime(value);
  if (kind === 'lightweight-web') {
    const { openDirectorDeskWindow } = await import('./directorDeskWindowService');
    await openDirectorDeskWindow({ instanceId: request.instanceId, theme: request.theme });
    return;
  }

  const context = requireBlenderContext(request.blender);
  const { runDirectorBlenderOperation } = await import('./directorBlenderRuntimeService');
  const result = await runDirectorBlenderOperation({
    operation: 'open-editor',
    projectId: context.projectId,
    directorInstanceId: request.instanceId,
    sceneReference: context.sceneReference,
    previousManifestReference: context.previousManifestReference,
  }, {
    signal: context.signal,
    onStatus: context.onStatus,
  });
  return {
    manifestReference: result.manifestReference,
    blendFilePath: result.blend?.filePath,
  };
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
      .filter((capture): capture is { dataUrl: string; fileName: string } => capture !== null)
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
  const kind = requireSupportedRuntime(value);
  if (kind === 'blender') {
    const context = requireBlenderContext(options.blender);
    if (!Number.isSafeInteger(options.targetFrame) || (options.targetFrame as number) <= 0) {
      throw new Error('Blender 当前帧缺少有效目标帧');
    }
    const { runDirectorBlenderOperation } = await import('./directorBlenderRuntimeService');
    const result = await runDirectorBlenderOperation({
      operation: 'render-frame',
      projectId: context.projectId,
      directorInstanceId: instanceId,
      sceneReference: context.sceneReference,
      previousManifestReference: context.previousManifestReference,
      targetFrame: options.targetFrame,
    }, {
      signal: context.signal,
      onStatus: context.onStatus,
    });
    if (!result.frame) throw new Error('Blender Job 未返回当前帧');
    return {
      mediaUrl: result.frame.mediaUrl,
      filePath: result.frame.filePath,
      fileName: result.frame.fileName,
      manifestReference: result.manifestReference,
    };
  }

  const { requestDirectorWindowAction } = await import('./directorDeskWindowService');
  const result = (await requestDirectorWindowAction(
    instanceId,
    'export.frame',
    {
      position: options.position,
      quality: options.quality,
      fileName: options.fileName,
    },
  )) as { dataUrl?: unknown; fileName?: unknown } | undefined;
  const dataUrl = typeof result?.dataUrl === 'string' ? result.dataUrl.trim() : '';
  if (!dataUrl.startsWith('data:image/')) throw new Error('导演台未返回有效帧图');
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
  const kind = requireSupportedRuntime(value);
  if (kind === 'blender') {
    const context = requireBlenderContext(options.blender);
    const { runDirectorBlenderOperation } = await import('./directorBlenderRuntimeService');
    const result = await runDirectorBlenderOperation({
      operation: 'render-video',
      projectId: context.projectId,
      directorInstanceId: instanceId,
      sceneReference: context.sceneReference,
      previousManifestReference: context.previousManifestReference,
    }, {
      signal: context.signal,
      onStatus: context.onStatus,
    });
    if (!result.video) throw new Error('Blender Job 未返回参考视频');
    return {
      mediaUrl: result.video.mediaUrl,
      fileName: result.video.fileName,
      filePath: result.video.filePath,
      manifestReference: result.manifestReference,
    };
  }

  const { requestDirectorWindowAction } = await import('./directorDeskWindowService');
  const result = (await requestDirectorWindowAction(
    instanceId,
    'export.video',
    {
      quality: options.quality,
      fps: options.fps,
      fileName: options.fileName,
    },
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

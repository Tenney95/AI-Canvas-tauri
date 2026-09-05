import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { DirectorSceneSource } from '../types/directorOperation';
import type {
  DirectorBlendProjectArtifact,
  DirectorFrameImageArtifact,
  DirectorReferenceVideoArtifact,
  DirectorResultManifest,
  DirectorResultManifestReference,
  DirectorScene,
  DirectorSceneReference,
} from '../types/directorScene';
import {
  assertDirectorManifestMatchesScene,
  normalizeDirectorResultManifest,
  normalizeDirectorResultManifestReference,
  normalizeDirectorScene,
  normalizeDirectorSceneReference,
} from './directorSceneSchema';
import {
  ensureProjectDataDir,
  getConvertFileSrc,
  isTauriEnv,
  joinPath,
} from './fs/core';

export type DirectorBlenderOperation = 'open-editor' | 'render-frame' | 'render-video';

export type DirectorBlenderJobState =
  | 'starting'
  | 'running'
  | 'awaiting-collection'
  | 'collecting'
  | 'succeeded'
  | 'cancelling'
  | 'cancelled'
  | 'failed';

export type DirectorBlenderProgressPhase =
  | 'preparing'
  | 'loading-scene'
  | 'rendering'
  | 'saving'
  | 'finalizing';

export interface DirectorBlenderInstallationCandidate {
  installationId: string;
  displayName: string;
  source: string;
  versionHint?: string | null;
  versionHintIsVerified: boolean;
}

export interface DirectorBlenderJobStatus {
  jobId: string;
  operation: DirectorBlenderOperation;
  state: DirectorBlenderJobState;
  sceneId: string;
  sceneRevision: number;
  progress?: {
    phase: DirectorBlenderProgressPhase;
    completed: number;
    total: number;
  } | null;
  failure?: {
    code: string;
    message: string;
  } | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DirectorBlenderRunInput {
  operation: DirectorBlenderOperation;
  projectId: string;
  directorInstanceId: string;
  sceneReference: DirectorSceneReference;
  previousManifestReference?: DirectorResultManifestReference;
  targetFrame?: number;
  sceneSource?: DirectorSceneSource;
}

export interface DirectorBlenderArtifactProjection {
  mediaUrl: string;
  filePath: string;
  fileName: string;
}

export interface DirectorBlenderRunResult {
  manifest: DirectorResultManifest;
  manifestReference: DirectorResultManifestReference;
  frame?: DirectorBlenderArtifactProjection & { artifact: DirectorFrameImageArtifact };
  video?: DirectorBlenderArtifactProjection & { artifact: DirectorReferenceVideoArtifact };
  blend?: DirectorBlenderArtifactProjection & { artifact: DirectorBlendProjectArtifact };
}

export interface DirectorBlenderRunOptions {
  signal?: AbortSignal;
  onStatus?: (status: DirectorBlenderJobStatus) => void;
}

export type DirectorBlenderAvailability =
  | { state: 'ready'; supportsSavedScene?: boolean }
  | { state: 'setup-required'; supportsSavedScene?: boolean }
  | { state: 'unavailable'; reason: string };

interface CollectedBlenderResult {
  manifest: unknown;
  manifestReference: unknown;
}

const JOB_POLL_INTERVAL_MS = 300;
const BLENDER_DESKTOP_ONLY_REASON = 'Blender 导演运行时仅支持 Tauri 桌面端';
const BLENDER_NATIVE_CALL_FAILED = 'Blender 原生运行时调用失败';

let selectedInstallation: DirectorBlenderInstallationCandidate | null = null;
let supportsSavedScene: boolean | null = null;

export function __resetDirectorBlenderRuntimeServiceForTests(): void {
  selectedInstallation = null;
  supportsSavedScene = null;
}

function abortError(): Error {
  const error = new Error('Blender 任务已取消');
  error.name = 'AbortError';
  return error;
}

function assertDesktopRuntime(): void {
  if (!isTauriEnv()) throw new Error(BLENDER_DESKTOP_ONLY_REASON);
}

function normalizeBlenderRuntimeError(
  error: unknown,
  fallback = BLENDER_NATIVE_CALL_FAILED,
): Error {
  if (error instanceof Error) return error;
  const message = typeof error === 'string'
    ? error.trim()
    : typeof error === 'object'
      && error !== null
      && typeof (error as Record<string, unknown>).message === 'string'
      ? ((error as Record<string, unknown>).message as string).trim()
      : '';
  return new Error(message || fallback);
}

async function invokeBlender<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return args === undefined
      ? await invoke<T>(command)
      : await invoke<T>(command, args);
  } catch (error) {
    throw normalizeBlenderRuntimeError(error);
  }
}

function normalizeInstallationCandidate(value: unknown): DirectorBlenderInstallationCandidate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Blender 安装候选格式无效');
  }

  const candidate = value as Record<string, unknown>;
  const { installationId, displayName, source, versionHint, versionHintIsVerified } = candidate;
  if (
    typeof installationId !== 'string'
    || !installationId.trim()
    || typeof displayName !== 'string'
    || !displayName.trim()
    || typeof source !== 'string'
    || !source.trim()
    || (versionHint !== undefined && versionHint !== null && typeof versionHint !== 'string')
    || typeof versionHintIsVerified !== 'boolean'
  ) {
    throw new Error('Blender 安装候选格式无效');
  }

  return {
    installationId,
    displayName,
    source,
    ...(versionHint === undefined ? {} : { versionHint }),
    versionHintIsVerified,
  };
}

function cloneInstallationCandidate(
  candidate: DirectorBlenderInstallationCandidate,
): DirectorBlenderInstallationCandidate {
  return normalizeInstallationCandidate(candidate);
}

function reportStatus(
  listener: DirectorBlenderRunOptions['onStatus'],
  status: DirectorBlenderJobStatus,
): void {
  try {
    listener?.(status);
  } catch (error) {
    console.error('[directorBlenderRuntimeService] Job 状态回调失败:', error);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}

async function discoverInstallations(): Promise<DirectorBlenderInstallationCandidate[]> {
  assertDesktopRuntime();
  const result = await invokeBlender<unknown>('discover_blender_installations');
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('Blender 安装发现结果格式无效');
  }
  const candidates = (result as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates)) throw new Error('Blender 安装发现结果格式无效');
  const normalized = candidates.map(normalizeInstallationCandidate);
  // 旧后端没有能力字段，不能仅凭前端版本启用新增 IPC 参数。
  supportsSavedScene = (result as Record<string, unknown>).supportsSavedScene === true;
  return normalized;
}

function selectOnlyCandidate(
  candidates: DirectorBlenderInstallationCandidate[],
): DirectorBlenderInstallationCandidate | null {
  if (selectedInstallation) return cloneInstallationCandidate(selectedInstallation);
  const persistedSelection = candidates.find((candidate) => candidate.source === 'user-selected');
  if (!persistedSelection && candidates.length !== 1) return null;
  selectedInstallation = cloneInstallationCandidate(persistedSelection ?? candidates[0]);
  return cloneInstallationCandidate(selectedInstallation);
}

export function getSelectedDirectorBlenderInstallation(): DirectorBlenderInstallationCandidate | null {
  return selectedInstallation ? cloneInstallationCandidate(selectedInstallation) : null;
}

/** 自动发现唯一候选；不会打开选择器，也不会向 UI 暴露 executable path。 */
export async function detectDirectorBlenderInstallation(): Promise<DirectorBlenderInstallationCandidate | null> {
  assertDesktopRuntime();
  if (selectedInstallation) return cloneInstallationCandidate(selectedInstallation);
  return selectOnlyCandidate(await discoverInstallations());
}

/** 用户主动选择或更换 Blender；每次调用都打开系统文件选择器。 */
export async function chooseDirectorBlenderInstallation(): Promise<DirectorBlenderInstallationCandidate> {
  assertDesktopRuntime();
  let selection: Awaited<ReturnType<typeof open>>;
  try {
    selection = await open({
      title: '选择 Blender 的 blender.exe',
      multiple: false,
      directory: false,
      filters: [{ name: 'Blender', extensions: ['exe'] }],
    });
  } catch (error) {
    throw normalizeBlenderRuntimeError(error, '无法打开 Blender 文件选择器');
  }
  if (typeof selection !== 'string' || !selection.trim()) throw abortError();

  const registered = await invokeBlender<unknown>(
    'register_blender_installation',
    { request: { executablePath: selection } },
  );
  selectedInstallation = normalizeInstallationCandidate(registered);
  return cloneInstallationCandidate(selectedInstallation);
}

export async function getDirectorBlenderAvailability(): Promise<DirectorBlenderAvailability> {
  if (!isTauriEnv()) return { state: 'unavailable', reason: BLENDER_DESKTOP_ONLY_REASON };

  try {
    const installation = await detectDirectorBlenderInstallation();
    if (supportsSavedScene === null) await discoverInstallations();
    return {
      state: installation ? 'ready' : 'setup-required',
      ...(supportsSavedScene ? { supportsSavedScene: true } : {}),
    };
  } catch (error) {
    return {
      state: 'unavailable',
      reason: error instanceof Error ? error.message : 'Blender 安装发现失败',
    };
  }
}

/**
 * 选择并登记 blender.exe。绝对路径只从 Tauri 文件对话框流向用途单一的 Rust command，
 * 不返回给节点，也不写入 IndexedDB。
 */
export async function prepareDirectorBlenderInstallation(): Promise<DirectorBlenderInstallationCandidate> {
  assertDesktopRuntime();
  const discovered = await detectDirectorBlenderInstallation();
  if (discovered) return discovered;
  return chooseDirectorBlenderInstallation();
}

function normalizeRunInput(input: DirectorBlenderRunInput): {
  sceneReference: DirectorSceneReference;
  previousManifestReference?: DirectorResultManifestReference;
  sceneSource: DirectorSceneSource;
} {
  const sceneSource = input.sceneSource ?? 'director-scene';
  if (!['director-scene', 'saved-blender'].includes(sceneSource)) throw new Error('Blender 场景来源无效');
  const sceneReference = normalizeDirectorSceneReference(input.sceneReference);
  const previousManifestReference = input.previousManifestReference === undefined
    ? undefined
    : normalizeDirectorResultManifestReference(input.previousManifestReference);

  if (previousManifestReference && (
    previousManifestReference.sceneId !== sceneReference.sceneId
    || previousManifestReference.sceneRevision !== sceneReference.revision
    || previousManifestReference.sceneSha256 !== sceneReference.sha256
  )) {
    throw new Error('上一份 Blender 结果清单与当前场景不匹配');
  }

  if (input.operation === 'render-frame') {
    if (!(sceneSource === 'saved-blender' && input.targetFrame === undefined)
      && (!Number.isSafeInteger(input.targetFrame) || (input.targetFrame as number) < 0 || (input.targetFrame as number) > 10_000_000)) {
      throw new Error('Blender 当前帧必须是范围内的非负安全整数');
    }
  } else if (input.targetFrame !== undefined) {
    throw new Error('只有 Blender 单帧渲染可以指定目标帧');
  }

  if (sceneSource === 'saved-blender' && !previousManifestReference) {
    throw new Error('Blender 保存工程模式需要上一份已验证成果');
  }
  return { sceneReference, previousManifestReference, sceneSource };
}

function projectArtifact(
  projectRoot: string,
  artifact: DirectorFrameImageArtifact | DirectorReferenceVideoArtifact | DirectorBlendProjectArtifact,
): DirectorBlenderArtifactProjection {
  const convertFileSrc = getConvertFileSrc();
  if (!convertFileSrc) throw new Error(BLENDER_DESKTOP_ONLY_REASON);
  const filePath = joinPath(projectRoot, artifact.relativePath);
  return {
    mediaUrl: convertFileSrc(filePath),
    filePath,
    fileName: artifact.relativePath.split('/').at(-1) ?? artifact.artifactId,
  };
}

function lastArtifact<T extends DirectorFrameImageArtifact | DirectorReferenceVideoArtifact | DirectorBlendProjectArtifact>(
  artifacts: DirectorResultManifest['artifacts'],
  kind: T['kind'],
): T | undefined {
  return [...artifacts].reverse().find((artifact) => artifact.kind === kind) as T | undefined;
}

function normalizeCollectedResult(
  value: CollectedBlenderResult,
  projectRoot: string,
  sceneReference: DirectorSceneReference,
  previousManifestReference?: DirectorResultManifestReference,
): DirectorBlenderRunResult {
  const manifest = normalizeDirectorResultManifest(value.manifest);
  const manifestReference = normalizeDirectorResultManifestReference(value.manifestReference);
  assertDirectorManifestMatchesScene(manifest, sceneReference);

  if (manifest.producer.runtime !== 'blender') {
    throw new Error('Blender Job 返回了错误的结果生产者');
  }
  if (
    manifestReference.sceneId !== manifest.sceneId
    || manifestReference.sceneRevision !== manifest.sceneRevision
    || manifestReference.sceneSha256 !== manifest.sceneSha256
    || manifestReference.manifestRevision !== manifest.manifestRevision
  ) {
    throw new Error('Blender 结果清单引用与清单身份不匹配');
  }
  const expectedManifestRevision = previousManifestReference
    ? previousManifestReference.manifestRevision + 1
    : 1;
  if (manifest.manifestRevision !== expectedManifestRevision) {
    throw new Error('Blender 结果清单 revision 与启动绑定不匹配');
  }

  const frameArtifact = lastArtifact<DirectorFrameImageArtifact>(manifest.artifacts, 'frame-image');
  const videoArtifact = lastArtifact<DirectorReferenceVideoArtifact>(
    manifest.artifacts,
    'reference-video',
  );
  const blendArtifact = lastArtifact<DirectorBlendProjectArtifact>(
    manifest.artifacts,
    'blend-project',
  );

  return {
    manifest,
    manifestReference,
    ...(frameArtifact
      ? { frame: { ...projectArtifact(projectRoot, frameArtifact), artifact: frameArtifact } }
      : {}),
    ...(videoArtifact
      ? { video: { ...projectArtifact(projectRoot, videoArtifact), artifact: videoArtifact } }
      : {}),
    ...(blendArtifact
      ? { blend: { ...projectArtifact(projectRoot, blendArtifact), artifact: blendArtifact } }
      : {}),
  };
}

export async function runDirectorBlenderOperation(
  input: DirectorBlenderRunInput,
  options: DirectorBlenderRunOptions = {},
): Promise<DirectorBlenderRunResult> {
  assertDesktopRuntime();
  const { sceneReference, previousManifestReference, sceneSource } = normalizeRunInput(input);
  if (options.signal?.aborted) throw abortError();

  const installation = await prepareDirectorBlenderInstallation();
  if (sceneSource === 'saved-blender') {
    if (supportsSavedScene === null) await discoverInstallations();
    if (!supportsSavedScene) throw new Error('保存 Blender 工程模式需要更新并重启桌面软件');
  }
  const projectRoot = await ensureProjectDataDir(input.projectId);
  if (!projectRoot) throw new Error('无法准备 Blender 项目目录');

  let projectGrantId: string | null = null;
  let jobId: string | null = null;
  let cancelPromise: Promise<void> | null = null;
  let operationResult: DirectorBlenderRunResult | null = null;
  let operationFailure: unknown = null;
  let operationFailed = false;
  let cleanupFailure: unknown = null;

  const cancelActiveJob = (): Promise<void> => {
    if (!jobId) return Promise.resolve();
    if (!cancelPromise) {
      cancelPromise = invokeBlender('cancel_blender_job', { request: { jobId } })
        .then(() => undefined);
    }
    return cancelPromise;
  };
  const onAbort = () => {
    void cancelActiveJob().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (options.signal?.aborted) throw abortError();
    const grant = await invokeBlender<{ projectGrantId: string }>('create_blender_project_grant', {
      request: { projectId: input.projectId, projectRoot },
    });
    projectGrantId = grant.projectGrantId;

    if (options.signal?.aborted) throw abortError();
    let status = await invokeBlender<DirectorBlenderJobStatus>('start_blender_job', {
      request: {
        installationId: installation.installationId,
        operation: input.operation,
        // 旧桌面后端拒绝未知字段；默认模式沿用原有 IPC 形状。
        ...(sceneSource === 'saved-blender' ? { sceneSource } : {}),
        projectGrantId,
        projectId: input.projectId,
        directorInstanceId: input.directorInstanceId,
        sceneId: sceneReference.sceneId,
        sceneRevision: sceneReference.revision,
        sceneSha256: sceneReference.sha256,
        previousManifestRevision: previousManifestReference?.manifestRevision ?? null,
        previousManifestSha256: previousManifestReference?.sha256 ?? null,
        targetFrame: input.operation === 'render-frame' ? input.targetFrame ?? null : null,
      },
    });
    jobId = status.jobId;
    reportStatus(options.onStatus, status);

    for (;;) {
      if (options.signal?.aborted) {
        await cancelActiveJob().catch(() => undefined);
        throw abortError();
      }

      if (status.state === 'awaiting-collection' || status.state === 'succeeded') {
        const collected = await invokeBlender<CollectedBlenderResult>('collect_blender_job_result', {
          request: { jobId },
        });
        operationResult = normalizeCollectedResult(
          collected,
          projectRoot,
          sceneReference,
          previousManifestReference,
        );
        break;
      }
      if (status.state === 'failed') {
        throw new Error(status.failure?.message || 'Blender Job 执行失败');
      }
      if (status.state === 'cancelled') {
        throw options.signal?.aborted ? abortError() : new Error('Blender 任务已取消');
      }

      await sleep(JOB_POLL_INTERVAL_MS);
      status = await invokeBlender<DirectorBlenderJobStatus>('get_blender_job_status', {
        request: { jobId },
      });
      reportStatus(options.onStatus, status);
    }
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    if (options.signal?.aborted) await cancelActiveJob().catch(() => undefined);
    if (projectGrantId) {
      try {
        await invokeBlender('revoke_blender_project_grant', {
          request: { projectGrantId },
        });
      } catch (error) {
        cleanupFailure = normalizeBlenderRuntimeError(error);
      }
    }
  }

  if (operationFailed) throw operationFailure;
  if (cleanupFailure) throw cleanupFailure;
  if (!operationResult) throw new Error('Blender Job 未返回结果');
  return operationResult;
}

function stableSceneId(directorInstanceId: string): string {
  const normalized = directorInstanceId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 100)
    .replace(/[^a-z0-9]+$/g, '');
  return `scene-${normalized || 'director'}`;
}

/** 创建首个可直接被固定 Blender 适配器读取的最小 Scene。 */
export function createDefaultDirectorScene(directorInstanceId: string): DirectorScene {
  return normalizeDirectorScene({
    schemaVersion: 1,
    sceneId: stableSceneId(directorInstanceId),
    revision: 1,
    parent: null,
    coordinateSystem: {
      handedness: 'right',
      upAxis: 'Z',
      forwardAxis: '-Y',
      lengthUnit: 'meter',
      angleUnit: 'degree',
      rotationOrder: 'XYZ',
    },
    timeline: { fps: 24, startFrame: 1, endFrame: 120 },
    environment: { worldColor: { r: 0.035, g: 0.035, b: 0.05 } },
    entities: [],
    cameras: [{
      cameraId: 'camera-main',
      name: '主镜头',
      transform: {
        position: { x: 0, y: -6, z: 2.2 },
        rotationEuler: { x: 70, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      focalLengthMm: 50,
      sensorWidthMm: 36,
      apertureFStop: 2.8,
      focusDistanceM: 6.4,
      keyframes: [],
    }],
    shots: [{
      shotId: 'shot-main',
      name: '主镜头段落',
      startFrame: 1,
      endFrame: 120,
      cameraId: 'camera-main',
    }],
  });
}

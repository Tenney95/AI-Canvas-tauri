import type {
  DirectorCamera,
  DirectorCameraKeyframe,
  DirectorEnvironment,
  DirectorProjectFileReference,
  DirectorResultArtifact,
  DirectorResultManifest,
  DirectorResultManifestReference,
  DirectorRuntimeKind,
  DirectorScene,
  DirectorSceneEntity,
  DirectorSceneReference,
  DirectorShot,
  DirectorTransform,
  DirectorVector3,
} from '../types/directorScene';

export const DIRECTOR_SCENE_SCHEMA_VERSION = 1 as const;
export const DIRECTOR_SCENE_MAX_BYTES = 2 * 1024 * 1024;
export const DIRECTOR_RESULT_MANIFEST_MAX_BYTES = 512 * 1024;
export const DIRECTOR_RENDERER_VERIFY_MAX_BYTES = 64 * 1024 * 1024;

const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 200;
const MAX_PATH_LENGTH = 512;
const MAX_PATH_SEGMENT_LENGTH = 240;
const MAX_PATH_DEPTH = 32;
const MAX_ENTITIES = 256;
const MAX_CAMERAS = 64;
const MAX_SHOTS = 256;
const MAX_KEYFRAMES = 8_192;
const MAX_ARTIFACTS = 256;
const MAX_FRAME = 10_000_000;
const MAX_FPS = 240;

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const FORBIDDEN_PATH_CHARACTER_PATTERN = /[<>"|?*]/;

const SCENE_KEYS = new Set([
  'schemaVersion',
  'sceneId',
  'revision',
  'parent',
  'coordinateSystem',
  'timeline',
  'environment',
  'entities',
  'cameras',
  'shots',
]);
const PARENT_KEYS = new Set(['revision', 'sha256']);
const COORDINATE_SYSTEM_KEYS = new Set([
  'handedness',
  'upAxis',
  'forwardAxis',
  'lengthUnit',
  'angleUnit',
  'rotationOrder',
]);
const TIMELINE_KEYS = new Set(['fps', 'startFrame', 'endFrame']);
const ENVIRONMENT_KEYS = new Set(['worldColor', 'asset']);
const WORLD_COLOR_KEYS = new Set(['r', 'g', 'b']);
const PROJECT_FILE_REFERENCE_KEYS = new Set(['kind', 'relativePath', 'sha256', 'bytes']);
const ENTITY_KEYS = new Set(['entityId', 'kind', 'name', 'asset', 'transform', 'visible']);
const TRANSFORM_KEYS = new Set(['position', 'rotationEuler', 'scale']);
const VECTOR_KEYS = new Set(['x', 'y', 'z']);
const CAMERA_KEYS = new Set([
  'cameraId',
  'name',
  'transform',
  'focalLengthMm',
  'sensorWidthMm',
  'apertureFStop',
  'focusDistanceM',
  'keyframes',
]);
const CAMERA_KEYFRAME_KEYS = new Set([
  'frame',
  'interpolation',
  'transform',
  'focalLengthMm',
  'apertureFStop',
  'focusDistanceM',
]);
const SHOT_KEYS = new Set(['shotId', 'name', 'startFrame', 'endFrame', 'cameraId']);
const MANIFEST_KEYS = new Set([
  'schemaVersion',
  'sceneId',
  'sceneRevision',
  'sceneSha256',
  'manifestRevision',
  'producer',
  'artifacts',
]);
const PRODUCER_KEYS = new Set(['runtime', 'adapterVersion', 'blenderVersion']);
const SCENE_REFERENCE_KEYS = new Set([
  'schemaVersion',
  'sceneId',
  'revision',
  'relativePath',
  'sha256',
  'bytes',
]);
const MANIFEST_REFERENCE_KEYS = new Set([
  'schemaVersion',
  'sceneId',
  'sceneRevision',
  'sceneSha256',
  'manifestRevision',
  'relativePath',
  'sha256',
  'bytes',
]);
const FRAME_ARTIFACT_KEYS = new Set([
  'artifactId',
  'kind',
  'mimeType',
  'relativePath',
  'sha256',
  'bytes',
  'frame',
]);
const VIDEO_ARTIFACT_KEYS = new Set([
  'artifactId',
  'kind',
  'mimeType',
  'relativePath',
  'sha256',
  'bytes',
  'startFrame',
  'endFrame',
  'fps',
]);
const BLEND_ARTIFACT_KEYS = new Set([
  'artifactId',
  'kind',
  'mimeType',
  'relativePath',
  'sha256',
  'bytes',
]);

export type DirectorSceneSchemaErrorCode =
  | 'invalid-json'
  | 'unsupported-schema'
  | 'unknown-field'
  | 'invalid-value'
  | 'limit-exceeded'
  | 'reference-mismatch';

export class DirectorSceneSchemaError extends Error {
  readonly name = 'DirectorSceneSchemaError';
  readonly code: DirectorSceneSchemaErrorCode;

  constructor(code: DirectorSceneSchemaErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function fail(code: DirectorSceneSchemaErrorCode, message: string): never {
  throw new DirectorSceneSchemaError(code, message);
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid-value', `${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail('unknown-field', `${label} 包含不支持的字段: ${unknown}`);
}

function schemaVersion(value: unknown, label: string): 1 {
  if (!Number.isSafeInteger(value)) fail('invalid-value', `${label} 必须是安全整数`);
  if (value !== DIRECTOR_SCENE_SCHEMA_VERSION) {
    if ((value as number) > DIRECTOR_SCENE_SCHEMA_VERSION) {
      fail('unsupported-schema', `${label}=${String(value)} 需要升级应用`);
    }
    fail('invalid-value', `${label} 必须为 ${DIRECTOR_SCENE_SCHEMA_VERSION}`);
  }
  return DIRECTOR_SCENE_SCHEMA_VERSION;
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') fail('invalid-value', `${label} 必须是字符串`);
  if (value.length > maxLength) fail('limit-exceeded', `${label} 超过长度上限`);
  if (containsControlCharacter(value)) fail('invalid-value', `${label} 包含控制字符`);
  const trimmed = value.trim();
  if (!trimmed) fail('invalid-value', `${label} 不能为空`);
  if (trimmed !== value) fail('invalid-value', `${label} 不允许首尾空白`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const normalized = requiredString(value, label, MAX_ID_LENGTH);
  if (!ID_PATTERN.test(normalized)) {
    fail('invalid-value', `${label} 只能包含小写字母、数字、点、下划线和短横线`);
  }
  return normalized;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('invalid-value', `${label} 必须是小写 SHA-256`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail('invalid-value', `${label} 必须是正安全整数`);
  }
  if ((value as number) > max) fail('limit-exceeded', `${label} 超过上限`);
  return value as number;
}

function frameNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('invalid-value', `${label} 必须是非负安全整数`);
  }
  if ((value as number) > MAX_FRAME) fail('limit-exceeded', `${label} 超过帧号上限`);
  return value as number;
}

function finiteNumber(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid-value', `${label} 必须是有限数字`);
  }
  if (options.min !== undefined && value < options.min) {
    fail('invalid-value', `${label} 不能小于 ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    fail('limit-exceeded', `${label} 不能大于 ${options.max}`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail('invalid-value', `${label} 必须是布尔值`);
  return value;
}

function exactLiteral<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) fail('invalid-value', `${label} 必须为 ${expected}`);
  return expected;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail('invalid-value', `${label} 是不支持的值`);
  }
  return value as T;
}

function arrayValue(value: unknown, label: string, maxItems: number): unknown[] {
  if (!Array.isArray(value)) fail('invalid-value', `${label} 必须是数组`);
  if (value.length > maxItems) fail('limit-exceeded', `${label} 超过数量上限`);
  return value;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    fail('invalid-value', `${label} 不能包含重复项`);
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertJsonByteLimit(value: string, maxBytes: number, label: string): void {
  if (utf8ByteLength(value) > maxBytes) {
    fail('limit-exceeded', `${label} 超过 ${maxBytes} 字节上限`);
  }
}

/** Strict cross-platform project-relative path. Input is never trimmed or rewritten. */
export function normalizeDirectorProjectRelativePath(value: unknown, label = '项目相对路径'): string {
  if (typeof value !== 'string' || !value) fail('invalid-value', `${label} 必须是非空字符串`);
  if (value.length > MAX_PATH_LENGTH) fail('limit-exceeded', `${label} 超过长度上限`);
  if (
    containsControlCharacter(value)
    || FORBIDDEN_PATH_CHARACTER_PATTERN.test(value)
    || value.includes('\\')
    || value.includes(':')
    || value.startsWith('/')
    || value.startsWith('~')
  ) {
    fail('invalid-value', `${label} 必须是安全的项目相对路径`);
  }

  const segments = value.split('/');
  if (segments.length > MAX_PATH_DEPTH) fail('limit-exceeded', `${label} 目录层级过深`);
  for (const segment of segments) {
    if (
      !segment
      || segment === '.'
      || segment === '..'
      || segment.toLowerCase() === '.trash'
      || segment.endsWith('.')
      || segment.endsWith(' ')
      || WINDOWS_RESERVED_NAME_PATTERN.test(segment)
    ) {
      fail('invalid-value', `${label} 包含不安全的路径段`);
    }
    if (segment.length > MAX_PATH_SEGMENT_LENGTH) {
      fail('limit-exceeded', `${label} 的路径段过长`);
    }
  }
  return value;
}

function normalizeVector(
  value: unknown,
  label: string,
  options: { min: number; max: number },
): DirectorVector3 {
  const raw = objectValue(value, label);
  assertKnownKeys(raw, VECTOR_KEYS, label);
  return {
    x: finiteNumber(raw.x, `${label}.x`, options),
    y: finiteNumber(raw.y, `${label}.y`, options),
    z: finiteNumber(raw.z, `${label}.z`, options),
  };
}

function normalizeTransform(value: unknown, label: string): DirectorTransform {
  const raw = objectValue(value, label);
  assertKnownKeys(raw, TRANSFORM_KEYS, label);
  const scale = normalizeVector(raw.scale, `${label}.scale`, { min: 0, max: 10_000 });
  if (scale.x <= 0 || scale.y <= 0 || scale.z <= 0) {
    fail('invalid-value', `${label}.scale 必须大于 0`);
  }
  return {
    position: normalizeVector(raw.position, `${label}.position`, { min: -1_000_000, max: 1_000_000 }),
    rotationEuler: normalizeVector(raw.rotationEuler, `${label}.rotationEuler`, { min: -1_000_000, max: 1_000_000 }),
    scale,
  };
}

export function normalizeDirectorProjectFileReference(
  value: unknown,
  label = '项目文件引用',
): DirectorProjectFileReference {
  const raw = objectValue(value, label);
  assertKnownKeys(raw, PROJECT_FILE_REFERENCE_KEYS, label);
  return {
    kind: exactLiteral(raw.kind, 'project-file', `${label}.kind`),
    relativePath: normalizeDirectorProjectRelativePath(raw.relativePath, `${label}.relativePath`),
    sha256: sha256(raw.sha256, `${label}.sha256`),
    bytes: positiveInteger(raw.bytes, `${label}.bytes`),
  };
}

function normalizeEnvironment(value: unknown): DirectorEnvironment {
  const raw = objectValue(value, 'environment');
  assertKnownKeys(raw, ENVIRONMENT_KEYS, 'environment');
  const color = objectValue(raw.worldColor, 'environment.worldColor');
  assertKnownKeys(color, WORLD_COLOR_KEYS, 'environment.worldColor');
  const worldColor = {
    r: finiteNumber(color.r, 'environment.worldColor.r', { min: 0, max: 1 }),
    g: finiteNumber(color.g, 'environment.worldColor.g', { min: 0, max: 1 }),
    b: finiteNumber(color.b, 'environment.worldColor.b', { min: 0, max: 1 }),
  };
  return raw.asset === undefined
    ? { worldColor }
    : {
        worldColor,
        asset: normalizeDirectorProjectFileReference(raw.asset, 'environment.asset'),
      };
}

function normalizeEntity(value: unknown, index: number): DirectorSceneEntity {
  const label = `entities[${index}]`;
  const raw = objectValue(value, label);
  assertKnownKeys(raw, ENTITY_KEYS, label);
  return {
    entityId: identifier(raw.entityId, `${label}.entityId`),
    kind: enumValue(raw.kind, ['character', 'prop'], `${label}.kind`),
    name: requiredString(raw.name, `${label}.name`, MAX_NAME_LENGTH),
    asset: normalizeDirectorProjectFileReference(raw.asset, `${label}.asset`),
    transform: normalizeTransform(raw.transform, `${label}.transform`),
    visible: booleanValue(raw.visible, `${label}.visible`),
  };
}

function optionalFiniteNumber(
  value: unknown,
  label: string,
  options: { min?: number; max?: number },
): number | undefined {
  return value === undefined ? undefined : finiteNumber(value, label, options);
}

function normalizeCameraKeyframe(value: unknown, cameraIndex: number, index: number): DirectorCameraKeyframe {
  const label = `cameras[${cameraIndex}].keyframes[${index}]`;
  const raw = objectValue(value, label);
  assertKnownKeys(raw, CAMERA_KEYFRAME_KEYS, label);
  const focalLengthMm = optionalFiniteNumber(raw.focalLengthMm, `${label}.focalLengthMm`, { min: 0.1, max: 2_000 });
  const apertureFStop = optionalFiniteNumber(raw.apertureFStop, `${label}.apertureFStop`, { min: 0.1, max: 128 });
  const focusDistanceM = optionalFiniteNumber(raw.focusDistanceM, `${label}.focusDistanceM`, { min: 0, max: 1_000_000_000 });
  return {
    frame: frameNumber(raw.frame, `${label}.frame`),
    interpolation: enumValue(raw.interpolation, ['constant', 'linear', 'bezier'], `${label}.interpolation`),
    transform: normalizeTransform(raw.transform, `${label}.transform`),
    ...(focalLengthMm === undefined ? {} : { focalLengthMm }),
    ...(apertureFStop === undefined ? {} : { apertureFStop }),
    ...(focusDistanceM === undefined ? {} : { focusDistanceM }),
  };
}

function normalizeCamera(value: unknown, index: number): DirectorCamera {
  const label = `cameras[${index}]`;
  const raw = objectValue(value, label);
  assertKnownKeys(raw, CAMERA_KEYS, label);
  const keyframes = arrayValue(raw.keyframes, `${label}.keyframes`, MAX_KEYFRAMES)
    .map((item, keyframeIndex) => normalizeCameraKeyframe(item, index, keyframeIndex));
  for (let keyframeIndex = 1; keyframeIndex < keyframes.length; keyframeIndex += 1) {
    if (keyframes[keyframeIndex].frame <= keyframes[keyframeIndex - 1].frame) {
      fail('invalid-value', `${label}.keyframes 必须按 frame 严格递增`);
    }
  }
  return {
    cameraId: identifier(raw.cameraId, `${label}.cameraId`),
    name: requiredString(raw.name, `${label}.name`, MAX_NAME_LENGTH),
    transform: normalizeTransform(raw.transform, `${label}.transform`),
    focalLengthMm: finiteNumber(raw.focalLengthMm, `${label}.focalLengthMm`, { min: 0.1, max: 2_000 }),
    sensorWidthMm: finiteNumber(raw.sensorWidthMm, `${label}.sensorWidthMm`, { min: 0.1, max: 1_000 }),
    apertureFStop: finiteNumber(raw.apertureFStop, `${label}.apertureFStop`, { min: 0.1, max: 128 }),
    focusDistanceM: finiteNumber(raw.focusDistanceM, `${label}.focusDistanceM`, { min: 0, max: 1_000_000_000 }),
    keyframes,
  };
}

function normalizeShot(value: unknown, index: number): DirectorShot {
  const label = `shots[${index}]`;
  const raw = objectValue(value, label);
  assertKnownKeys(raw, SHOT_KEYS, label);
  const startFrame = frameNumber(raw.startFrame, `${label}.startFrame`);
  const endFrame = frameNumber(raw.endFrame, `${label}.endFrame`);
  if (endFrame < startFrame) fail('invalid-value', `${label}.endFrame 不能早于 startFrame`);
  return {
    shotId: identifier(raw.shotId, `${label}.shotId`),
    name: requiredString(raw.name, `${label}.name`, MAX_NAME_LENGTH),
    startFrame,
    endFrame,
    cameraId: identifier(raw.cameraId, `${label}.cameraId`),
  };
}

export function normalizeDirectorScene(value: unknown): DirectorScene {
  const raw = objectValue(value, 'Director Scene');
  assertKnownKeys(raw, SCENE_KEYS, 'Director Scene');
  const normalizedSchemaVersion = schemaVersion(raw.schemaVersion, 'schemaVersion');
  const revision = positiveInteger(raw.revision, 'revision');

  let parent: DirectorScene['parent'];
  if (raw.parent === null) {
    parent = null;
  } else {
    const parentRaw = objectValue(raw.parent, 'parent');
    assertKnownKeys(parentRaw, PARENT_KEYS, 'parent');
    parent = {
      revision: positiveInteger(parentRaw.revision, 'parent.revision'),
      sha256: sha256(parentRaw.sha256, 'parent.sha256'),
    };
  }
  if (revision === 1 && parent !== null) fail('invalid-value', 'revision=1 时 parent 必须为 null');
  if (revision > 1 && (parent === null || parent.revision !== revision - 1)) {
    fail('reference-mismatch', 'parent 必须绑定上一 Scene revision');
  }

  const coordinateRaw = objectValue(raw.coordinateSystem, 'coordinateSystem');
  assertKnownKeys(coordinateRaw, COORDINATE_SYSTEM_KEYS, 'coordinateSystem');
  const coordinateSystem = {
    handedness: exactLiteral(coordinateRaw.handedness, 'right', 'coordinateSystem.handedness'),
    upAxis: exactLiteral(coordinateRaw.upAxis, 'Z', 'coordinateSystem.upAxis'),
    forwardAxis: exactLiteral(coordinateRaw.forwardAxis, '-Y', 'coordinateSystem.forwardAxis'),
    lengthUnit: exactLiteral(coordinateRaw.lengthUnit, 'meter', 'coordinateSystem.lengthUnit'),
    angleUnit: exactLiteral(coordinateRaw.angleUnit, 'degree', 'coordinateSystem.angleUnit'),
    rotationOrder: exactLiteral(coordinateRaw.rotationOrder, 'XYZ', 'coordinateSystem.rotationOrder'),
  };

  const timelineRaw = objectValue(raw.timeline, 'timeline');
  assertKnownKeys(timelineRaw, TIMELINE_KEYS, 'timeline');
  const timeline = {
    fps: finiteNumber(timelineRaw.fps, 'timeline.fps', { min: 1, max: MAX_FPS }),
    startFrame: frameNumber(timelineRaw.startFrame, 'timeline.startFrame'),
    endFrame: frameNumber(timelineRaw.endFrame, 'timeline.endFrame'),
  };
  if (timeline.endFrame < timeline.startFrame) {
    fail('invalid-value', 'timeline.endFrame 不能早于 startFrame');
  }

  const entities = arrayValue(raw.entities, 'entities', MAX_ENTITIES)
    .map((item, index) => normalizeEntity(item, index));
  const cameras: DirectorCamera[] = [];
  let keyframeCount = 0;
  const cameraValues = arrayValue(raw.cameras, 'cameras', MAX_CAMERAS);
  cameraValues.forEach((item, index) => {
    const cameraRaw = objectValue(item, `cameras[${index}]`);
    const rawKeyframes = arrayValue(
      cameraRaw.keyframes,
      `cameras[${index}].keyframes`,
      MAX_KEYFRAMES,
    );
    keyframeCount += rawKeyframes.length;
    if (keyframeCount > MAX_KEYFRAMES) {
      fail('limit-exceeded', 'camera keyframes 总数超过上限');
    }
  });
  cameraValues.forEach((item, index) => cameras.push(normalizeCamera(item, index)));
  const shots = arrayValue(raw.shots, 'shots', MAX_SHOTS)
    .map((item, index) => normalizeShot(item, index));

  assertUnique(entities.map((entity) => entity.entityId), 'entityId');
  assertUnique(cameras.map((camera) => camera.cameraId), 'cameraId');
  assertUnique(shots.map((shot) => shot.shotId), 'shotId');
  const cameraIds = new Set(cameras.map((camera) => camera.cameraId));
  for (const camera of cameras) {
    if (camera.keyframes.some((keyframe) => (
      keyframe.frame < timeline.startFrame || keyframe.frame > timeline.endFrame
    ))) {
      fail('reference-mismatch', `camera ${camera.cameraId} 的关键帧超出 timeline`);
    }
  }
  for (const shot of shots) {
    if (!cameraIds.has(shot.cameraId)) {
      fail('reference-mismatch', `shot ${shot.shotId} 引用了不存在的 camera`);
    }
    if (shot.startFrame < timeline.startFrame || shot.endFrame > timeline.endFrame) {
      fail('reference-mismatch', `shot ${shot.shotId} 超出 timeline`);
    }
  }

  return {
    schemaVersion: normalizedSchemaVersion,
    sceneId: identifier(raw.sceneId, 'sceneId'),
    revision,
    parent,
    coordinateSystem,
    timeline,
    environment: normalizeEnvironment(raw.environment),
    entities,
    cameras,
    shots,
  };
}

function parseJson(text: string, label: string, maxBytes: number): unknown {
  if (typeof text !== 'string') fail('invalid-json', `${label} 必须是 JSON 字符串`);
  assertJsonByteLimit(text, maxBytes, label);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail('invalid-json', `${label} 不是有效 JSON`);
  }
}

export function parseDirectorSceneJson(text: string): DirectorScene {
  return normalizeDirectorScene(parseJson(text, 'Director Scene JSON', DIRECTOR_SCENE_MAX_BYTES));
}

export function serializeDirectorSceneJson(value: unknown): string {
  const serialized = `${JSON.stringify(normalizeDirectorScene(value), null, 2)}\n`;
  assertJsonByteLimit(serialized, DIRECTOR_SCENE_MAX_BYTES, 'Director Scene JSON');
  return serialized;
}

export function buildDirectorSceneRelativePath(
  sceneIdValue: unknown,
  revisionValue: unknown,
  sha256Value: unknown,
): string {
  const sceneId = identifier(sceneIdValue, 'sceneId');
  const revision = positiveInteger(revisionValue, 'revision');
  const hash = sha256(sha256Value, 'sha256');
  return `director/scenes/${sceneId}/scene-r${revision}-${hash}.json`;
}

export function buildDirectorResultManifestRelativePath(
  sceneIdValue: unknown,
  manifestRevisionValue: unknown,
  sha256Value: unknown,
): string {
  const sceneId = identifier(sceneIdValue, 'sceneId');
  const manifestRevision = positiveInteger(manifestRevisionValue, 'manifestRevision');
  const hash = sha256(sha256Value, 'sha256');
  return `director/scenes/${sceneId}/results/manifest-r${manifestRevision}-${hash}.json`;
}

export function buildDirectorArtifactRelativePath(
  sceneIdValue: unknown,
  artifactIdValue: unknown,
  sha256Value: unknown,
  kindValue: unknown,
): string {
  const sceneId = identifier(sceneIdValue, 'sceneId');
  const artifactId = identifier(artifactIdValue, 'artifactId');
  const hash = sha256(sha256Value, 'sha256');
  const kind = enumValue(kindValue, ['frame-image', 'reference-video', 'blend-project'], 'artifact.kind');
  const extension = {
    'frame-image': 'png',
    'reference-video': 'mp4',
    'blend-project': 'blend',
  }[kind];
  return `director/scenes/${sceneId}/results/${artifactId}-${hash}.${extension}`;
}

export function normalizeDirectorSceneReference(value: unknown): DirectorSceneReference {
  const raw = objectValue(value, 'Director Scene reference');
  assertKnownKeys(raw, SCENE_REFERENCE_KEYS, 'Director Scene reference');
  const reference: DirectorSceneReference = {
    schemaVersion: schemaVersion(raw.schemaVersion, 'reference.schemaVersion'),
    sceneId: identifier(raw.sceneId, 'reference.sceneId'),
    revision: positiveInteger(raw.revision, 'reference.revision'),
    relativePath: normalizeDirectorProjectRelativePath(raw.relativePath, 'reference.relativePath'),
    sha256: sha256(raw.sha256, 'reference.sha256'),
    bytes: positiveInteger(raw.bytes, 'reference.bytes', DIRECTOR_SCENE_MAX_BYTES),
  };
  const expectedPath = buildDirectorSceneRelativePath(reference.sceneId, reference.revision, reference.sha256);
  if (reference.relativePath !== expectedPath) {
    fail('reference-mismatch', 'Director Scene reference 路径与内容标识不匹配');
  }
  return reference;
}

function normalizeArtifact(value: unknown, sceneId: string, index: number): DirectorResultArtifact {
  const label = `artifacts[${index}]`;
  const raw = objectValue(value, label);
  const kind = enumValue(raw.kind, ['frame-image', 'reference-video', 'blend-project'], `${label}.kind`);
  assertKnownKeys(
    raw,
    kind === 'frame-image'
      ? FRAME_ARTIFACT_KEYS
      : kind === 'reference-video'
        ? VIDEO_ARTIFACT_KEYS
        : BLEND_ARTIFACT_KEYS,
    label,
  );
  const artifactId = identifier(raw.artifactId, `${label}.artifactId`);
  const hash = sha256(raw.sha256, `${label}.sha256`);
  const relativePath = normalizeDirectorProjectRelativePath(raw.relativePath, `${label}.relativePath`);
  const bytes = positiveInteger(raw.bytes, `${label}.bytes`);
  const expectedPath = buildDirectorArtifactRelativePath(sceneId, artifactId, hash, kind);
  if (relativePath !== expectedPath) {
    fail('reference-mismatch', `${label}.relativePath 与 artifact 标识不匹配`);
  }

  if (kind === 'frame-image') {
    return {
      artifactId,
      kind,
      mimeType: exactLiteral(raw.mimeType, 'image/png', `${label}.mimeType`),
      relativePath,
      sha256: hash,
      bytes,
      frame: frameNumber(raw.frame, `${label}.frame`),
    };
  }
  if (kind === 'reference-video') {
    const startFrame = frameNumber(raw.startFrame, `${label}.startFrame`);
    const endFrame = frameNumber(raw.endFrame, `${label}.endFrame`);
    if (endFrame < startFrame) fail('invalid-value', `${label}.endFrame 不能早于 startFrame`);
    return {
      artifactId,
      kind,
      mimeType: exactLiteral(raw.mimeType, 'video/mp4', `${label}.mimeType`),
      relativePath,
      sha256: hash,
      bytes,
      startFrame,
      endFrame,
      fps: finiteNumber(raw.fps, `${label}.fps`, { min: 1, max: MAX_FPS }),
    };
  }
  return {
    artifactId,
    kind,
    mimeType: exactLiteral(raw.mimeType, 'application/x-blender', `${label}.mimeType`),
    relativePath,
    sha256: hash,
    bytes,
  };
}

export function normalizeDirectorResultManifest(value: unknown): DirectorResultManifest {
  const raw = objectValue(value, 'Director Result Manifest');
  assertKnownKeys(raw, MANIFEST_KEYS, 'Director Result Manifest');
  const normalizedSchemaVersion = schemaVersion(raw.schemaVersion, 'schemaVersion');
  const sceneId = identifier(raw.sceneId, 'sceneId');
  const producerRaw = objectValue(raw.producer, 'producer');
  assertKnownKeys(producerRaw, PRODUCER_KEYS, 'producer');
  const runtime = enumValue<DirectorRuntimeKind>(
    producerRaw.runtime,
    ['lightweight-web', 'blender'],
    'producer.runtime',
  );
  const adapterVersion = requiredString(producerRaw.adapterVersion, 'producer.adapterVersion', 64);
  let producer: DirectorResultManifest['producer'];
  if (runtime === 'lightweight-web') {
    if (producerRaw.blenderVersion !== undefined) {
      fail('invalid-value', 'lightweight-web producer 不能声明 blenderVersion');
    }
    producer = { runtime, adapterVersion };
  } else {
    producer = {
      runtime,
      adapterVersion,
      blenderVersion: requiredString(producerRaw.blenderVersion, 'producer.blenderVersion', 64),
    };
  }
  const artifacts = arrayValue(raw.artifacts, 'artifacts', MAX_ARTIFACTS)
    .map((item, index) => normalizeArtifact(item, sceneId, index));
  assertUnique(artifacts.map((artifact) => artifact.artifactId), 'artifactId');
  assertUnique(artifacts.map((artifact) => artifact.relativePath), 'artifact relativePath');
  if (runtime === 'lightweight-web' && artifacts.some((artifact) => artifact.kind === 'blend-project')) {
    fail('invalid-value', 'lightweight-web producer 不能声明 blend-project artifact');
  }

  return {
    schemaVersion: normalizedSchemaVersion,
    sceneId,
    sceneRevision: positiveInteger(raw.sceneRevision, 'sceneRevision'),
    sceneSha256: sha256(raw.sceneSha256, 'sceneSha256'),
    manifestRevision: positiveInteger(raw.manifestRevision, 'manifestRevision'),
    producer,
    artifacts,
  };
}

export function parseDirectorResultManifestJson(text: string): DirectorResultManifest {
  return normalizeDirectorResultManifest(
    parseJson(text, 'Director Result Manifest JSON', DIRECTOR_RESULT_MANIFEST_MAX_BYTES),
  );
}

export function serializeDirectorResultManifestJson(value: unknown): string {
  const serialized = `${JSON.stringify(normalizeDirectorResultManifest(value), null, 2)}\n`;
  assertJsonByteLimit(serialized, DIRECTOR_RESULT_MANIFEST_MAX_BYTES, 'Director Result Manifest JSON');
  return serialized;
}

export function normalizeDirectorResultManifestReference(
  value: unknown,
): DirectorResultManifestReference {
  const raw = objectValue(value, 'Director Result Manifest reference');
  assertKnownKeys(raw, MANIFEST_REFERENCE_KEYS, 'Director Result Manifest reference');
  const reference: DirectorResultManifestReference = {
    schemaVersion: schemaVersion(raw.schemaVersion, 'reference.schemaVersion'),
    sceneId: identifier(raw.sceneId, 'reference.sceneId'),
    sceneRevision: positiveInteger(raw.sceneRevision, 'reference.sceneRevision'),
    sceneSha256: sha256(raw.sceneSha256, 'reference.sceneSha256'),
    manifestRevision: positiveInteger(raw.manifestRevision, 'reference.manifestRevision'),
    relativePath: normalizeDirectorProjectRelativePath(raw.relativePath, 'reference.relativePath'),
    sha256: sha256(raw.sha256, 'reference.sha256'),
    bytes: positiveInteger(raw.bytes, 'reference.bytes', DIRECTOR_RESULT_MANIFEST_MAX_BYTES),
  };
  const expectedPath = buildDirectorResultManifestRelativePath(
    reference.sceneId,
    reference.manifestRevision,
    reference.sha256,
  );
  if (reference.relativePath !== expectedPath) {
    fail('reference-mismatch', 'Director Result Manifest reference 路径与内容标识不匹配');
  }
  return reference;
}

export function assertDirectorManifestMatchesScene(
  manifestValue: unknown,
  sceneReferenceValue: unknown,
): void {
  const manifest = normalizeDirectorResultManifest(manifestValue);
  const sceneReference = normalizeDirectorSceneReference(sceneReferenceValue);
  if (
    manifest.sceneId !== sceneReference.sceneId
    || manifest.sceneRevision !== sceneReference.revision
    || manifest.sceneSha256 !== sceneReference.sha256
  ) {
    fail('reference-mismatch', 'Result Manifest 与 Director Scene reference 不匹配');
  }
}

/**
 * directorSceneService — 读写导演场景及其不可变项目文件。
 */
import type {
  DirectorProjectFileReference,
  DirectorScene,
  DirectorSceneReference,
} from '../types/directorScene';
import {
  DIRECTOR_RENDERER_VERIFY_MAX_BYTES,
  DIRECTOR_SCENE_MAX_BYTES,
  buildDirectorSceneRelativePath,
  normalizeDirectorScene,
  normalizeDirectorSceneReference,
  parseDirectorSceneJson,
  serializeDirectorSceneJson,
} from './directorSceneSchema';
import {
  bytesEqual,
  readVerifiedProjectFile,
  readVerifiedProjectFileByHash,
  sha256Hex,
  writeImmutableProjectFile,
  type ProjectFileReference,
} from './fs/projectFiles';

export class DirectorSceneServiceError extends Error {
  readonly name = 'DirectorSceneServiceError';
  readonly code = 'DIRECTOR_SCENE_SERVICE_INVALID';
}

export interface SaveDirectorSceneOptions {
  previousReference?: unknown;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function fail(message: string): never {
  throw new DirectorSceneServiceError(message);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return textDecoder.decode(bytes);
  } catch {
    fail(`${label} 不是有效的 UTF-8`);
  }
}

function toProjectFileReference(reference: {
  relativePath: string;
  sha256: string;
  bytes: number;
}): ProjectFileReference {
  return {
    relativePath: reference.relativePath,
    sha256: reference.sha256,
    bytes: reference.bytes,
  };
}

function collectSceneAssetReferences(scene: DirectorScene): DirectorProjectFileReference[] {
  return [
    ...(scene.environment.asset ? [scene.environment.asset] : []),
    ...scene.entities.map((entity) => entity.asset),
  ];
}

function uniqueVerifiedReferences(
  references: ProjectFileReference[],
  label: string,
): ProjectFileReference[] {
  const byPath = new Map<string, ProjectFileReference>();
  let totalBytes = 0;
  for (const reference of references) {
    const previous = byPath.get(reference.relativePath);
    if (previous) {
      if (previous.sha256 !== reference.sha256 || previous.bytes !== reference.bytes) {
        fail(`${label} 对同一路径声明了不同内容`);
      }
      continue;
    }
    totalBytes += reference.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > DIRECTOR_RENDERER_VERIFY_MAX_BYTES) {
      fail(`${label} 超过 Phase 1-A 的 64 MiB renderer 验证上限`);
    }
    byPath.set(reference.relativePath, reference);
  }
  return [...byPath.values()];
}

async function verifyProjectReferences(
  projectId: string,
  references: ProjectFileReference[],
  label: string,
): Promise<void> {
  for (const reference of uniqueVerifiedReferences(references, label)) {
    await readVerifiedProjectFile({
      projectId,
      reference,
      maxBytes: DIRECTOR_RENDERER_VERIFY_MAX_BYTES,
    });
  }
}

function assertSceneIdentity(scene: DirectorScene, reference: DirectorSceneReference): void {
  if (
    scene.schemaVersion !== reference.schemaVersion
    || scene.sceneId !== reference.sceneId
    || scene.revision !== reference.revision
  ) {
    fail('Director Scene 内容与引用身份不匹配');
  }
}

function parseCanonicalSceneBytes(bytes: Uint8Array, reference: DirectorSceneReference): DirectorScene {
  const scene = parseDirectorSceneJson(decodeUtf8(bytes, 'Director Scene'));
  assertSceneIdentity(scene, reference);
  const canonicalBytes = textEncoder.encode(serializeDirectorSceneJson(scene));
  if (!bytesEqual(bytes, canonicalBytes)) fail('Director Scene 不是规范序列化格式');
  return scene;
}

async function verifyImmediateSceneParent(projectId: string, scene: DirectorScene): Promise<void> {
  if (!scene.parent) return;
  const relativePath = buildDirectorSceneRelativePath(
    scene.sceneId,
    scene.parent.revision,
    scene.parent.sha256,
  );
  const { data, reference } = await readVerifiedProjectFileByHash({
    projectId,
    relativePath,
    sha256: scene.parent.sha256,
    maxBytes: DIRECTOR_SCENE_MAX_BYTES,
  });
  parseCanonicalSceneBytes(data, {
    schemaVersion: 1,
    sceneId: scene.sceneId,
    revision: scene.parent.revision,
    ...reference,
  });
}

export async function saveDirectorScene(
  projectId: string,
  sceneValue: unknown,
  options: SaveDirectorSceneOptions = {},
): Promise<{ scene: DirectorScene; reference: DirectorSceneReference }> {
  const scene = normalizeDirectorScene(sceneValue);
  if (scene.revision === 1) {
    if (options.previousReference !== undefined) fail('首个 Director Scene revision 不应提供父引用');
  } else {
    if (options.previousReference === undefined) fail('新的 Director Scene revision 缺少父引用');
    const previousReference = normalizeDirectorSceneReference(options.previousReference);
    if (
      previousReference.sceneId !== scene.sceneId
      || previousReference.revision !== scene.parent?.revision
      || previousReference.sha256 !== scene.parent?.sha256
    ) {
      fail('新的 Director Scene revision 与父引用不匹配');
    }
    await loadDirectorScene(projectId, previousReference);
  }

  await verifyProjectReferences(
    projectId,
    collectSceneAssetReferences(scene).map(toProjectFileReference),
    'Director Scene 资产',
  );

  const data = textEncoder.encode(serializeDirectorSceneJson(scene));
  const hash = await sha256Hex(data);
  const reference: DirectorSceneReference = {
    schemaVersion: 1,
    sceneId: scene.sceneId,
    revision: scene.revision,
    relativePath: buildDirectorSceneRelativePath(scene.sceneId, scene.revision, hash),
    sha256: hash,
    bytes: data.byteLength,
  };
  await writeImmutableProjectFile({
    projectId,
    reference: toProjectFileReference(reference),
    data,
    maxBytes: DIRECTOR_SCENE_MAX_BYTES,
  });
  return { scene, reference };
}

export async function loadDirectorScene(
  projectId: string,
  referenceValue: unknown,
): Promise<DirectorScene> {
  const reference = normalizeDirectorSceneReference(referenceValue);
  const data = await readVerifiedProjectFile({
    projectId,
    reference: toProjectFileReference(reference),
    maxBytes: DIRECTOR_SCENE_MAX_BYTES,
  });
  const scene = parseCanonicalSceneBytes(data, reference);
  await verifyImmediateSceneParent(projectId, scene);
  await verifyProjectReferences(
    projectId,
    collectSceneAssetReferences(scene).map(toProjectFileReference),
    'Director Scene 资产',
  );
  return scene;
}

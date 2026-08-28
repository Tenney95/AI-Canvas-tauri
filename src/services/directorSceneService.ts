import type {
  DirectorProjectFileReference,
  DirectorResultArtifact,
  DirectorResultManifest,
  DirectorResultManifestReference,
  DirectorScene,
  DirectorSceneReference,
} from '../types/directorScene';
import {
  DIRECTOR_RENDERER_VERIFY_MAX_BYTES,
  DIRECTOR_RESULT_MANIFEST_MAX_BYTES,
  DIRECTOR_SCENE_MAX_BYTES,
  assertDirectorManifestMatchesScene,
  buildDirectorResultManifestRelativePath,
  buildDirectorSceneRelativePath,
  normalizeDirectorResultManifest,
  normalizeDirectorResultManifestReference,
  normalizeDirectorScene,
  normalizeDirectorSceneReference,
  parseDirectorResultManifestJson,
  parseDirectorSceneJson,
  serializeDirectorResultManifestJson,
  serializeDirectorSceneJson,
} from './directorSceneSchema';
import {
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

export interface DirectorManifestSceneBinding {
  sceneReference: unknown;
  previousManifestReference?: unknown;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function fail(message: string): never {
  throw new DirectorSceneServiceError(message);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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

function collectArtifactReferences(artifacts: DirectorResultArtifact[]): ProjectFileReference[] {
  return artifacts.map(toProjectFileReference);
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

function assertManifestIdentity(
  manifest: DirectorResultManifest,
  reference: DirectorResultManifestReference,
): void {
  if (
    manifest.schemaVersion !== reference.schemaVersion
    || manifest.sceneId !== reference.sceneId
    || manifest.sceneRevision !== reference.sceneRevision
    || manifest.sceneSha256 !== reference.sceneSha256
    || manifest.manifestRevision !== reference.manifestRevision
  ) {
    fail('Director Result Manifest 内容与引用身份不匹配');
  }
}

function parseCanonicalSceneBytes(bytes: Uint8Array, reference: DirectorSceneReference): DirectorScene {
  const scene = parseDirectorSceneJson(decodeUtf8(bytes, 'Director Scene'));
  assertSceneIdentity(scene, reference);
  const canonicalBytes = textEncoder.encode(serializeDirectorSceneJson(scene));
  if (!bytesEqual(bytes, canonicalBytes)) fail('Director Scene 不是规范序列化格式');
  return scene;
}

function parseCanonicalManifestBytes(
  bytes: Uint8Array,
  reference: DirectorResultManifestReference,
): DirectorResultManifest {
  const manifest = parseDirectorResultManifestJson(decodeUtf8(bytes, 'Director Result Manifest'));
  assertManifestIdentity(manifest, reference);
  const canonicalBytes = textEncoder.encode(serializeDirectorResultManifestJson(manifest));
  if (!bytesEqual(bytes, canonicalBytes)) fail('Director Result Manifest 不是规范序列化格式');
  return manifest;
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

function assertArtifactsWithinScene(
  manifest: DirectorResultManifest,
  scene: DirectorScene,
): void {
  for (const artifact of manifest.artifacts) {
    if (artifact.kind === 'frame-image') {
      if (artifact.frame < scene.timeline.startFrame || artifact.frame > scene.timeline.endFrame) {
        fail(`artifact ${artifact.artifactId} 的帧号超出 Scene timeline`);
      }
    }
    if (artifact.kind === 'reference-video') {
      if (
        artifact.startFrame < scene.timeline.startFrame
        || artifact.endFrame > scene.timeline.endFrame
      ) {
        fail(`artifact ${artifact.artifactId} 的帧范围超出 Scene timeline`);
      }
    }
  }
}

function assertManifestExtendsPrevious(
  manifest: DirectorResultManifest,
  previous: DirectorResultManifest,
): void {
  const currentArtifacts = new Map(
    manifest.artifacts.map((artifact) => [artifact.artifactId, artifact]),
  );
  for (const previousArtifact of previous.artifacts) {
    const currentArtifact = currentArtifacts.get(previousArtifact.artifactId);
    if (!currentArtifact) {
      fail('新的 Director Result Manifest 必须保留上一清单的 artifact');
    }
    if (JSON.stringify(currentArtifact) !== JSON.stringify(previousArtifact)) {
      fail(`artifact ${previousArtifact.artifactId} 不得在同一 Scene bundle 内改写`);
    }
  }
  if (manifest.artifacts.length <= previous.artifacts.length) {
    fail('新的 Director Result Manifest 必须追加至少一个新 artifact');
  }
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

export async function saveDirectorResultManifest(
  projectId: string,
  manifestValue: unknown,
  binding: DirectorManifestSceneBinding,
): Promise<{ manifest: DirectorResultManifest; reference: DirectorResultManifestReference }> {
  const manifest = normalizeDirectorResultManifest(manifestValue);
  const sceneReference = normalizeDirectorSceneReference(binding.sceneReference);
  const scene = await loadDirectorScene(projectId, sceneReference);
  assertDirectorManifestMatchesScene(manifest, sceneReference);
  assertArtifactsWithinScene(manifest, scene);

  if (manifest.manifestRevision === 1) {
    if (binding.previousManifestReference !== undefined) {
      fail('首个 Director Result Manifest 不应提供上一清单引用');
    }
  } else {
    if (binding.previousManifestReference === undefined) {
      fail('新的 Director Result Manifest 缺少上一清单引用');
    }
    const previousReference = normalizeDirectorResultManifestReference(binding.previousManifestReference);
    if (
      previousReference.sceneId !== manifest.sceneId
      || previousReference.sceneRevision !== manifest.sceneRevision
      || previousReference.sceneSha256 !== manifest.sceneSha256
      || previousReference.manifestRevision !== manifest.manifestRevision - 1
    ) {
      fail('新的 Director Result Manifest 与上一清单引用不匹配');
    }
    const previousManifest = await loadDirectorResultManifest(
      projectId,
      previousReference,
      { sceneReference },
    );
    assertManifestExtendsPrevious(manifest, previousManifest);
  }

  await verifyProjectReferences(
    projectId,
    collectArtifactReferences(manifest.artifacts),
    'Director Result artifact',
  );

  const data = textEncoder.encode(serializeDirectorResultManifestJson(manifest));
  const hash = await sha256Hex(data);
  const reference: DirectorResultManifestReference = {
    schemaVersion: 1,
    sceneId: manifest.sceneId,
    sceneRevision: manifest.sceneRevision,
    sceneSha256: manifest.sceneSha256,
    manifestRevision: manifest.manifestRevision,
    relativePath: buildDirectorResultManifestRelativePath(
      manifest.sceneId,
      manifest.manifestRevision,
      hash,
    ),
    sha256: hash,
    bytes: data.byteLength,
  };
  await writeImmutableProjectFile({
    projectId,
    reference: toProjectFileReference(reference),
    data,
    maxBytes: DIRECTOR_RESULT_MANIFEST_MAX_BYTES,
  });
  return { manifest, reference };
}

export async function loadDirectorResultManifest(
  projectId: string,
  referenceValue: unknown,
  binding: { sceneReference: unknown },
): Promise<DirectorResultManifest> {
  const reference = normalizeDirectorResultManifestReference(referenceValue);
  const sceneReference = normalizeDirectorSceneReference(binding.sceneReference);
  if (
    reference.sceneId !== sceneReference.sceneId
    || reference.sceneRevision !== sceneReference.revision
    || reference.sceneSha256 !== sceneReference.sha256
  ) {
    fail('Director Result Manifest reference 与 Scene reference 不匹配');
  }
  const scene = await loadDirectorScene(projectId, sceneReference);
  const data = await readVerifiedProjectFile({
    projectId,
    reference: toProjectFileReference(reference),
    maxBytes: DIRECTOR_RESULT_MANIFEST_MAX_BYTES,
  });
  const manifest = parseCanonicalManifestBytes(data, reference);
  assertDirectorManifestMatchesScene(manifest, sceneReference);
  assertArtifactsWithinScene(manifest, scene);
  await verifyProjectReferences(
    projectId,
    collectArtifactReferences(manifest.artifacts),
    'Director Result artifact',
  );
  return manifest;
}

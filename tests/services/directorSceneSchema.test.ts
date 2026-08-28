import { describe, expect, it } from 'vitest';
import {
  DIRECTOR_SCENE_MAX_BYTES,
  DirectorSceneSchemaError,
  buildDirectorArtifactRelativePath,
  buildDirectorResultManifestRelativePath,
  buildDirectorSceneRelativePath,
  normalizeDirectorProjectRelativePath,
  normalizeDirectorResultManifest,
  normalizeDirectorResultManifestReference,
  normalizeDirectorScene,
  normalizeDirectorSceneReference,
  parseDirectorResultManifestJson,
  parseDirectorSceneJson,
  serializeDirectorResultManifestJson,
  serializeDirectorSceneJson,
} from '../../src/services/directorSceneSchema';

const SCENE_HASH = 'a'.repeat(64);
const ASSET_HASH = 'b'.repeat(64);
const ARTIFACT_HASH = 'c'.repeat(64);
const MANIFEST_HASH = 'd'.repeat(64);

function transform() {
  return {
    position: { x: 0, y: 1, z: 2 },
    rotationEuler: { x: 0, y: 0, z: 90 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

function projectFile(relativePath = 'assets/character.glb') {
  return {
    kind: 'project-file' as const,
    relativePath,
    sha256: ASSET_HASH,
    bytes: 128,
  };
}

function validScene() {
  return {
    schemaVersion: 1,
    sceneId: 'scene-main',
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
    environment: { worldColor: { r: 0.1, g: 0.2, b: 0.3 } },
    entities: [
      {
        entityId: 'hero',
        kind: 'character',
        name: '主角',
        asset: projectFile(),
        transform: transform(),
        visible: true,
      },
    ],
    cameras: [
      {
        cameraId: 'camera-a',
        name: '主机位',
        transform: transform(),
        focalLengthMm: 50,
        sensorWidthMm: 36,
        apertureFStop: 2.8,
        focusDistanceM: 4,
        keyframes: [
          { frame: 1, interpolation: 'linear', transform: transform() },
          { frame: 120, interpolation: 'bezier', transform: transform(), focalLengthMm: 85 },
        ],
      },
    ],
    shots: [
      { shotId: 'shot-a', name: '开场', startFrame: 1, endFrame: 120, cameraId: 'camera-a' },
    ],
  };
}

function validManifest() {
  return {
    schemaVersion: 1,
    sceneId: 'scene-main',
    sceneRevision: 1,
    sceneSha256: SCENE_HASH,
    manifestRevision: 1,
    producer: { runtime: 'lightweight-web', adapterVersion: '1.0.0' },
    artifacts: [
      {
        artifactId: 'frame-a',
        kind: 'frame-image',
        mimeType: 'image/png',
        relativePath: buildDirectorArtifactRelativePath(
          'scene-main',
          'frame-a',
          ARTIFACT_HASH,
          'frame-image',
        ),
        sha256: ARTIFACT_HASH,
        bytes: 256,
        frame: 24,
      },
    ],
  };
}

describe('directorSceneSchema', () => {
  it('normalizes, deterministically serializes and round-trips a Scene', () => {
    const scene = validScene();
    const reordered = {
      shots: scene.shots,
      cameras: scene.cameras,
      entities: scene.entities,
      environment: scene.environment,
      timeline: scene.timeline,
      coordinateSystem: scene.coordinateSystem,
      parent: scene.parent,
      revision: scene.revision,
      sceneId: scene.sceneId,
      schemaVersion: scene.schemaVersion,
    };

    const serialized = serializeDirectorSceneJson(scene);
    expect(serialized).toBe(serializeDirectorSceneJson(reordered));
    expect(serialized.endsWith('\n')).toBe(true);
    expect(parseDirectorSceneJson(serialized)).toEqual(normalizeDirectorScene(scene));
  });

  it('rejects unknown fields at the root and in nested objects', () => {
    expect(() => normalizeDirectorScene({ ...validScene(), extensions: {} })).toThrow(DirectorSceneSchemaError);
    const scene = validScene();
    expect(() => normalizeDirectorScene({
      ...scene,
      timeline: { ...scene.timeline, hidden: true },
    })).toThrow(/不支持的字段/);
    expect(() => normalizeDirectorScene({
      ...scene,
      entities: [{
        ...scene.entities[0],
        transform: {
          ...scene.entities[0].transform,
          position: { ...scene.entities[0].transform.position, hidden: 1 },
        },
      }],
    })).toThrow(/不支持的字段/);
  });

  it('rejects trimmed-away characters and unsafe transform magnitudes', () => {
    const scene = validScene();
    expect(() => normalizeDirectorScene({
      ...scene,
      entities: [{ ...scene.entities[0], name: '主角\n' }],
    })).toThrow(/控制字符/);
    expect(() => normalizeDirectorScene({
      ...scene,
      entities: [{ ...scene.entities[0], name: ' 主角' }],
    })).toThrow(/首尾空白/);
    expect(() => normalizeDirectorScene({
      ...scene,
      entities: [{
        ...scene.entities[0],
        transform: {
          ...scene.entities[0].transform,
          position: { ...scene.entities[0].transform.position, x: 1e308 },
        },
      }],
    })).toThrow(/不能大于/);
    expect(() => normalizeDirectorScene({
      ...scene,
      entities: [{
        ...scene.entities[0],
        transform: {
          ...scene.entities[0].transform,
          scale: { ...scene.entities[0].transform.scale, x: 0 },
        },
      }],
    })).toThrow(/必须大于 0/);
  });

  it('rejects newer schemas, non-finite numbers and oversized UTF-8 JSON', () => {
    expect(() => normalizeDirectorScene({ ...validScene(), schemaVersion: 2 })).toThrow(/升级应用/);
    const scene = validScene();
    expect(() => normalizeDirectorScene({
      ...scene,
      cameras: [{ ...scene.cameras[0], focalLengthMm: Number.NaN }],
    })).toThrow(/有限数字/);
    expect(() => normalizeDirectorScene({
      ...scene,
      timeline: { ...scene.timeline, fps: Number.POSITIVE_INFINITY },
    })).toThrow(/有限数字/);
    const oversized = `{"padding":"${'界'.repeat(DIRECTOR_SCENE_MAX_BYTES)}"}`;
    expect(() => parseDirectorSceneJson(oversized)).toThrow(/字节上限/);
  });

  it.each([
    'C:/scene.json',
    '../scene.json',
    '/scene.json',
    'director//scene.json',
    'director\\scene.json',
    'https://example.com/scene.json',
    'director/.trash/scene.json',
    'director/scene. ',
    'director/CON.json',
    'director/control\u0000.json',
  ])('rejects unsafe project paths: %s', (relativePath) => {
    expect(() => normalizeDirectorProjectRelativePath(relativePath)).toThrow(DirectorSceneSchemaError);
  });

  it('rejects duplicate IDs, unordered keyframes and missing camera references', () => {
    const scene = validScene();
    expect(() => normalizeDirectorScene({
      ...scene,
      entities: [scene.entities[0], { ...scene.entities[0] }],
    })).toThrow(/重复/);
    expect(() => normalizeDirectorScene({
      ...scene,
      cameras: [{
        ...scene.cameras[0],
        keyframes: [scene.cameras[0].keyframes[1], scene.cameras[0].keyframes[0]],
      }],
    })).toThrow(/严格递增/);
    expect(() => normalizeDirectorScene({
      ...scene,
      shots: [{ ...scene.shots[0], cameraId: 'missing-camera' }],
    })).toThrow(/不存在的 camera/);
  });

  it('rejects total keyframes before deeply normalizing more than the global limit', () => {
    const scene = validScene();
    expect(() => normalizeDirectorScene({
      ...scene,
      cameras: [
        { ...scene.cameras[0], keyframes: Array(8_192).fill(scene.cameras[0].keyframes[0]) },
        { ...scene.cameras[0], cameraId: 'camera-b', keyframes: [scene.cameras[0].keyframes[0]] },
      ],
    })).toThrow(/keyframes 总数超过上限/);
  });

  it('requires an exact previous revision parent and complete project-file references', () => {
    expect(() => normalizeDirectorScene({
      ...validScene(),
      revision: 2,
      parent: { revision: 1, sha256: SCENE_HASH },
    })).not.toThrow();
    expect(() => normalizeDirectorScene({
      ...validScene(),
      revision: 3,
      parent: { revision: 1, sha256: SCENE_HASH },
    })).toThrow(/上一 Scene revision/);
    const scene = validScene();
    const assetWithoutBytes = { ...scene.entities[0].asset } as Record<string, unknown>;
    delete assetWithoutBytes.bytes;
    expect(() => normalizeDirectorScene({
      ...scene,
      entities: [{ ...scene.entities[0], asset: assetWithoutBytes }],
    })).toThrow(/正安全整数/);
  });

  it('builds and validates canonical Scene and Manifest references', () => {
    const sceneReference = {
      schemaVersion: 1,
      sceneId: 'scene-main',
      revision: 1,
      relativePath: buildDirectorSceneRelativePath('scene-main', 1, SCENE_HASH),
      sha256: SCENE_HASH,
      bytes: 512,
    };
    expect(normalizeDirectorSceneReference(sceneReference)).toEqual(sceneReference);
    expect(() => normalizeDirectorSceneReference({
      ...sceneReference,
      relativePath: 'director/scenes/scene-main/scene.json',
    })).toThrow(/不匹配/);

    const manifestReference = {
      schemaVersion: 1,
      sceneId: 'scene-main',
      sceneRevision: 1,
      sceneSha256: SCENE_HASH,
      manifestRevision: 1,
      relativePath: buildDirectorResultManifestRelativePath('scene-main', 1, MANIFEST_HASH),
      sha256: MANIFEST_HASH,
      bytes: 256,
    };
    expect(normalizeDirectorResultManifestReference(manifestReference)).toEqual(manifestReference);
    expect(() => normalizeDirectorResultManifestReference({
      ...manifestReference,
      relativePath: buildDirectorResultManifestRelativePath('scene-main', 2, MANIFEST_HASH),
    })).toThrow(/不匹配/);
  });

  it('normalizes, serializes and round-trips fixed Result artifact kinds', () => {
    const manifest = validManifest();
    const serialized = serializeDirectorResultManifestJson(manifest);
    expect(parseDirectorResultManifestJson(serialized)).toEqual(normalizeDirectorResultManifest(manifest));
    expect(serialized.endsWith('\n')).toBe(true);

    const blenderManifest = {
      ...manifest,
      producer: { runtime: 'blender', adapterVersion: '1.0.0', blenderVersion: '5.2.0' },
      artifacts: [
        manifest.artifacts[0],
        {
          artifactId: 'video-a',
          kind: 'reference-video',
          mimeType: 'video/mp4',
          relativePath: buildDirectorArtifactRelativePath(
            'scene-main',
            'video-a',
            MANIFEST_HASH,
            'reference-video',
          ),
          sha256: MANIFEST_HASH,
          bytes: 512,
          startFrame: 1,
          endFrame: 120,
          fps: 24,
        },
        {
          artifactId: 'blend-a',
          kind: 'blend-project',
          mimeType: 'application/x-blender',
          relativePath: buildDirectorArtifactRelativePath(
            'scene-main',
            'blend-a',
            ASSET_HASH,
            'blend-project',
          ),
          sha256: ASSET_HASH,
          bytes: 1024,
        },
      ],
    };
    expect(parseDirectorResultManifestJson(
      serializeDirectorResultManifestJson(blenderManifest),
    )).toEqual(normalizeDirectorResultManifest(blenderManifest));
  });

  it('enforces runtime-specific producer and blend artifact fields', () => {
    const manifest = validManifest();
    expect(() => normalizeDirectorResultManifest({
      ...manifest,
      producer: { ...manifest.producer, blenderVersion: '5.2.0' },
    })).toThrow(/不能声明 blenderVersion/);
    expect(() => normalizeDirectorResultManifest({
      ...manifest,
      producer: { runtime: 'blender', adapterVersion: '1.0.0' },
    })).toThrow(/blenderVersion/);
    expect(() => normalizeDirectorResultManifest({
      ...manifest,
      artifacts: [{
        artifactId: 'blend-a',
        kind: 'blend-project',
        mimeType: 'application/x-blender',
        relativePath: buildDirectorArtifactRelativePath(
          'scene-main',
          'blend-a',
          ASSET_HASH,
          'blend-project',
        ),
        sha256: ASSET_HASH,
        bytes: 1024,
      }],
    })).toThrow(/不能声明 blend-project/);
  });

  it('rejects artifact MIME/path mismatches and duplicate artifact identities', () => {
    const manifest = validManifest();
    expect(() => normalizeDirectorResultManifest({
      ...manifest,
      artifacts: [{ ...manifest.artifacts[0], mimeType: 'image/jpeg' }],
    })).toThrow(/image\/png/);
    expect(() => normalizeDirectorResultManifest({
      ...manifest,
      artifacts: [{ ...manifest.artifacts[0], relativePath: 'director/result.png' }],
    })).toThrow(/不匹配/);
    expect(() => normalizeDirectorResultManifest({
      ...manifest,
      artifacts: [manifest.artifacts[0], { ...manifest.artifacts[0] }],
    })).toThrow(/重复/);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  directories: new Set<string>(),
  symlinks: new Set<string>(),
  writeCalls: [] as Array<{ path: string; options: unknown }>,
  exists: vi.fn(),
  writeFile: vi.fn(),
  isTauriEnv: vi.fn(() => true),
  ensureProjectDataDir: vi.fn(async () => '/project'),
  getProjectDataDir: vi.fn(async () => '/project'),
  notifyProjectDiskChanged: vi.fn(),
}));

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

function parentPath(value: string): string {
  const normalized = normalizePath(value);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mocks.exists,
  lstat: vi.fn(async (path: string) => {
    const normalized = normalizePath(path);
    if (mocks.symlinks.has(normalized)) {
      return { isFile: false, isDirectory: false, isSymlink: true, size: 0 };
    }
    if (mocks.directories.has(normalized)) {
      return { isFile: false, isDirectory: true, isSymlink: false, size: 0 };
    }
    const file = mocks.files.get(normalized);
    if (file) return { isFile: true, isDirectory: false, isSymlink: false, size: file.byteLength };
    throw new Error(`missing: ${normalized}`);
  }),
  mkdir: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
    const normalized = normalizePath(path);
    if (!options?.recursive && !mocks.directories.has(parentPath(normalized))) {
      throw new Error('parent missing');
    }
    mocks.directories.add(normalized);
  }),
  readFile: vi.fn(async (path: string) => {
    const normalized = normalizePath(path);
    const file = mocks.files.get(normalized);
    if (!file) throw new Error(`missing: ${normalized}`);
    return Uint8Array.from(file);
  }),
  writeFile: mocks.writeFile,
}));

vi.mock('../../src/services/fs/core', () => ({
  isTauriEnv: mocks.isTauriEnv,
  ensureProjectDataDir: mocks.ensureProjectDataDir,
  getProjectDataDir: mocks.getProjectDataDir,
  notifyProjectDiskChanged: mocks.notifyProjectDiskChanged,
  joinPath: (...parts: string[]) => normalizePath(parts.join('/')),
}));

import {
  loadDirectorResultManifest,
  loadDirectorScene,
  saveDirectorResultManifest,
  saveDirectorScene,
} from '../../src/services/directorSceneService';
import {
  DIRECTOR_RENDERER_VERIFY_MAX_BYTES,
  buildDirectorArtifactRelativePath,
} from '../../src/services/directorSceneSchema';
import {
  readVerifiedProjectFile,
  sha256Hex,
  writeImmutableProjectFile,
} from '../../src/services/fs/projectFiles';

function addDirectoryTree(relativePath: string): void {
  let current = '/project';
  for (const segment of relativePath.split('/').slice(0, -1)) {
    current = `${current}/${segment}`;
    mocks.directories.add(current);
  }
}

async function putProjectFile(relativePath: string, data: Uint8Array) {
  addDirectoryTree(relativePath);
  mocks.files.set(`/project/${relativePath}`, Uint8Array.from(data));
  return {
    kind: 'project-file' as const,
    relativePath,
    sha256: await sha256Hex(data),
    bytes: data.byteLength,
  };
}

function transform() {
  return {
    position: { x: 0, y: 0, z: 1 },
    rotationEuler: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

function sceneFixture(
  asset: Awaited<ReturnType<typeof putProjectFile>>,
  revision = 1,
  parent: { revision: number; sha256: string } | null = null,
) {
  return {
    schemaVersion: 1,
    sceneId: 'scene-main',
    revision,
    parent,
    coordinateSystem: {
      handedness: 'right',
      upAxis: 'Z',
      forwardAxis: '-Y',
      lengthUnit: 'meter',
      angleUnit: 'degree',
      rotationOrder: 'XYZ',
    },
    timeline: { fps: 24, startFrame: 1, endFrame: 120 },
    environment: { worldColor: { r: 0.1, g: 0.1, b: 0.1 } },
    entities: [{
      entityId: 'hero',
      kind: 'character',
      name: '主角',
      asset,
      transform: transform(),
      visible: true,
    }],
    cameras: [{
      cameraId: 'camera-a',
      name: '主机位',
      transform: transform(),
      focalLengthMm: 50,
      sensorWidthMm: 36,
      apertureFStop: 2.8,
      focusDistanceM: 4,
      keyframes: [{ frame: 1, interpolation: 'linear', transform: transform() }],
    }],
    shots: [{ shotId: 'shot-a', name: '镜头', startFrame: 1, endFrame: 120, cameraId: 'camera-a' }],
  };
}

describe('directorSceneService', () => {
  beforeEach(() => {
    mocks.files.clear();
    mocks.directories.clear();
    mocks.symlinks.clear();
    mocks.writeCalls.length = 0;
    mocks.directories.add('/project');
    mocks.isTauriEnv.mockReset();
    mocks.isTauriEnv.mockReturnValue(true);
    mocks.exists.mockReset();
    mocks.exists.mockImplementation(async (path: string) => {
      const normalized = normalizePath(path);
      return mocks.files.has(normalized)
        || mocks.directories.has(normalized)
        || mocks.symlinks.has(normalized);
    });
    mocks.writeFile.mockReset();
    mocks.writeFile.mockImplementation(
      async (path: string, data: Uint8Array, options?: { createNew?: boolean }) => {
        const normalized = normalizePath(path);
        mocks.writeCalls.push({ path: normalized, options });
        if (
          options?.createNew
          && (mocks.files.has(normalized)
            || mocks.directories.has(normalized)
            || mocks.symlinks.has(normalized))
        ) {
          throw new Error('already exists');
        }
        mocks.files.set(normalized, Uint8Array.from(data));
      },
    );
    mocks.ensureProjectDataDir.mockClear();
    mocks.getProjectDataDir.mockClear();
    mocks.notifyProjectDiskChanged.mockClear();
  });

  it('saves and loads a canonical immutable Scene reference', async () => {
    const asset = await putProjectFile('assets/hero.glb', new Uint8Array([1, 2, 3, 4]));
    const saved = await saveDirectorScene('project-a', sceneFixture(asset));

    expect(saved.reference.relativePath).toMatch(
      /^director\/scenes\/scene-main\/scene-r1-[a-f0-9]{64}\.json$/,
    );
    expect(saved.reference.relativePath).not.toContain('/project');
    expect(mocks.writeCalls.at(-1)?.options).toEqual({ createNew: true });
    expect(await loadDirectorScene('project-a', saved.reference)).toEqual(saved.scene);
  });

  it('creates revision 2 only from the exact verified parent and keeps revision 1 immutable', async () => {
    const asset = await putProjectFile('assets/hero.glb', new Uint8Array([4, 3, 2, 1]));
    const first = await saveDirectorScene('project-a', sceneFixture(asset));
    const firstBytes = Uint8Array.from(mocks.files.get(`/project/${first.reference.relativePath}`)!);
    const secondScene = sceneFixture(asset, 2, { revision: 1, sha256: first.reference.sha256 });
    const second = await saveDirectorScene('project-a', secondScene, { previousReference: first.reference });

    expect(second.reference.revision).toBe(2);
    expect(second.reference.relativePath).not.toBe(first.reference.relativePath);
    expect(mocks.files.get(`/project/${first.reference.relativePath}`)).toEqual(firstBytes);
    expect(await loadDirectorScene('project-a', second.reference)).toEqual(second.scene);

    await expect(saveDirectorScene('project-a', {
      ...secondScene,
      parent: { revision: 1, sha256: 'f'.repeat(64) },
    }, { previousReference: first.reference })).rejects.toThrow(/父引用不匹配/);
  });

  it('rejects a tampered Scene and a tampered direct parent', async () => {
    const asset = await putProjectFile('assets/hero.glb', new Uint8Array([5, 6, 7]));
    const first = await saveDirectorScene('project-a', sceneFixture(asset));
    const second = await saveDirectorScene(
      'project-a',
      sceneFixture(asset, 2, { revision: 1, sha256: first.reference.sha256 }),
      { previousReference: first.reference },
    );

    const firstPath = `/project/${first.reference.relativePath}`;
    const tampered = Uint8Array.from(mocks.files.get(firstPath)!);
    tampered[0] ^= 0xff;
    mocks.files.set(firstPath, tampered);
    await expect(loadDirectorScene('project-a', second.reference)).rejects.toThrow(/SHA-256 不匹配/);
  });

  it('uses createNew, is idempotent for equal bytes and never overwrites conflicts', async () => {
    const original = new Uint8Array([9, 8, 7, 6]);
    const hash = await sha256Hex(original);
    const reference = { relativePath: `director/fixtures/file-${hash}.bin`, sha256: hash, bytes: original.byteLength };

    const firstPromise = writeImmutableProjectFile({
      projectId: 'project-a',
      reference,
      data: original,
      maxBytes: 1024,
    });
    original.fill(0);
    const first = await firstPromise;
    const second = await writeImmutableProjectFile({
      projectId: 'project-a',
      reference,
      data: new Uint8Array([9, 8, 7, 6]),
      maxBytes: 1024,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(mocks.writeCalls).toHaveLength(1);
    expect(mocks.files.get(`/project/${reference.relativePath}`)).toEqual(new Uint8Array([9, 8, 7, 6]));

    mocks.files.set(`/project/${reference.relativePath}`, new Uint8Array([1, 1, 1, 1]));
    await expect(writeImmutableProjectFile({
      projectId: 'project-a',
      reference,
      data: new Uint8Array([9, 8, 7, 6]),
      maxBytes: 1024,
    })).rejects.toThrow(/SHA-256 不匹配/);
    expect(mocks.files.get(`/project/${reference.relativePath}`)).toEqual(new Uint8Array([1, 1, 1, 1]));
  });

  it('handles a cross-window createNew race without overwriting competing content', async () => {
    const data = new Uint8Array([7, 7, 7]);
    const hash = await sha256Hex(data);
    const reference = { relativePath: `race/equal-${hash}.bin`, sha256: hash, bytes: data.byteLength };
    mocks.writeFile.mockImplementationOnce(
      async (path: string, competingData: Uint8Array, options?: { createNew?: boolean }) => {
        const normalized = normalizePath(path);
        mocks.writeCalls.push({ path: normalized, options });
        mocks.files.set(normalized, Uint8Array.from(competingData));
        throw new Error('another window won');
      },
    );
    await expect(writeImmutableProjectFile({
      projectId: 'project-a',
      reference,
      data,
      maxBytes: 1024,
    })).resolves.toMatchObject({ created: false });

    const otherData = new Uint8Array([6, 6, 6]);
    const otherHash = await sha256Hex(otherData);
    const otherReference = {
      relativePath: `race/conflict-${otherHash}.bin`,
      sha256: otherHash,
      bytes: otherData.byteLength,
    };
    mocks.writeFile.mockImplementationOnce(
      async (path: string, _data: Uint8Array, options?: { createNew?: boolean }) => {
        const normalized = normalizePath(path);
        mocks.writeCalls.push({ path: normalized, options });
        mocks.files.set(normalized, new Uint8Array([0, 0, 0]));
        throw new Error('another window won');
      },
    );
    await expect(writeImmutableProjectFile({
      projectId: 'project-a',
      reference: otherReference,
      data: otherData,
      maxBytes: 1024,
    })).rejects.toThrow(/SHA-256 不匹配/);
    expect(mocks.files.get(`/project/${otherReference.relativePath}`)).toEqual(new Uint8Array([0, 0, 0]));
  });

  it('serializes concurrent equal writes and rejects parent/final symlinks', async () => {
    const data = new Uint8Array([1, 3, 3, 7]);
    const hash = await sha256Hex(data);
    const reference = { relativePath: `safe/path/file-${hash}.bin`, sha256: hash, bytes: data.byteLength };
    const results = await Promise.all([
      writeImmutableProjectFile({ projectId: 'project-a', reference, data, maxBytes: 1024 }),
      writeImmutableProjectFile({ projectId: 'project-a', reference, data, maxBytes: 1024 }),
    ]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(mocks.writeCalls).toHaveLength(1);

    mocks.files.clear();
    mocks.directories.clear();
    mocks.directories.add('/project');
    mocks.symlinks.add('/project/safe');
    await expect(writeImmutableProjectFile({
      projectId: 'project-a',
      reference,
      data,
      maxBytes: 1024,
    })).rejects.toThrow(/符号链接/);

    mocks.symlinks.clear();
    mocks.directories.add('/project/safe');
    mocks.directories.add('/project/safe/path');
    mocks.symlinks.add(`/project/${reference.relativePath}`);
    await expect(writeImmutableProjectFile({
      projectId: 'project-a',
      reference,
      data,
      maxBytes: 1024,
    })).rejects.toThrow(/符号链接/);
  });

  it('fails closed in Web mode without leaking the absolute project path', async () => {
    mocks.isTauriEnv.mockReturnValue(false);
    const reference = { relativePath: 'director/test.bin', sha256: 'a'.repeat(64), bytes: 1 };
    let message = '';
    try {
      await readVerifiedProjectFile({ projectId: 'project-a', reference, maxBytes: 10 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('仅在桌面版可用');
    expect(message).not.toContain('/project');
  });

  it('redacts absolute paths from native existence errors', async () => {
    mocks.exists.mockRejectedValueOnce(new Error('forbidden path: /project/private'));
    const reference = { relativePath: 'director/test.bin', sha256: 'a'.repeat(64), bytes: 1 };
    let message = '';
    try {
      await readVerifiedProjectFile({ projectId: 'project-a', reference, maxBytes: 10 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('无法访问');
    expect(message).not.toContain('/project');
    expect(message).not.toContain('forbidden path');
  });

  it('writes and loads a Manifest only after verifying its bound Scene and artifacts', async () => {
    const asset = await putProjectFile('assets/hero.glb', new Uint8Array([2, 4, 6, 8]));
    const scene = await saveDirectorScene('project-a', sceneFixture(asset));
    const artifactBytes = new Uint8Array([137, 80, 78, 71]);
    const artifactHash = await sha256Hex(artifactBytes);
    const artifactPath = buildDirectorArtifactRelativePath(
      'scene-main',
      'frame-a',
      artifactHash,
      'frame-image',
    );
    await putProjectFile(artifactPath, artifactBytes);
    const manifest = {
      schemaVersion: 1,
      sceneId: 'scene-main',
      sceneRevision: 1,
      sceneSha256: scene.reference.sha256,
      manifestRevision: 1,
      producer: { runtime: 'lightweight-web', adapterVersion: '1.0.0' },
      artifacts: [{
        artifactId: 'frame-a',
        kind: 'frame-image',
        mimeType: 'image/png',
        relativePath: artifactPath,
        sha256: artifactHash,
        bytes: artifactBytes.byteLength,
        frame: 24,
      }],
    };

    const saved = await saveDirectorResultManifest('project-a', manifest, {
      sceneReference: scene.reference,
    });
    expect(saved.reference.relativePath).toMatch(/\/results\/manifest-r1-[a-f0-9]{64}\.json$/);
    expect(await loadDirectorResultManifest('project-a', saved.reference, {
      sceneReference: scene.reference,
    })).toEqual(saved.manifest);

    const nextArtifactBytes = new Uint8Array([137, 80, 78, 72]);
    const nextArtifactHash = await sha256Hex(nextArtifactBytes);
    const nextArtifactPath = buildDirectorArtifactRelativePath(
      'scene-main',
      'frame-b',
      nextArtifactHash,
      'frame-image',
    );
    await putProjectFile(nextArtifactPath, nextArtifactBytes);
    const second = await saveDirectorResultManifest('project-a', {
      ...saved.manifest,
      manifestRevision: 2,
      artifacts: [
        ...saved.manifest.artifacts,
        {
          artifactId: 'frame-b',
          kind: 'frame-image',
          mimeType: 'image/png',
          relativePath: nextArtifactPath,
          sha256: nextArtifactHash,
          bytes: nextArtifactBytes.byteLength,
          frame: 48,
        },
      ],
    }, {
      sceneReference: scene.reference,
      previousManifestReference: saved.reference,
    });
    expect(second.reference.manifestRevision).toBe(2);

    const thirdHash = 'e'.repeat(64);
    await expect(saveDirectorResultManifest('project-a', {
      ...second.manifest,
      manifestRevision: 3,
      artifacts: [
        ...second.manifest.artifacts,
        {
          artifactId: 'frame-c',
          kind: 'frame-image',
          mimeType: 'image/png',
          relativePath: buildDirectorArtifactRelativePath(
            'scene-main',
            'frame-c',
            thirdHash,
            'frame-image',
          ),
          sha256: thirdHash,
          bytes: 4,
          frame: 72,
        },
      ],
    }, {
      sceneReference: scene.reference,
      previousManifestReference: saved.reference,
    })).rejects.toThrow(/上一清单引用不匹配/);

    const replacementHash = 'f'.repeat(64);
    await expect(saveDirectorResultManifest('project-a', {
      ...saved.manifest,
      manifestRevision: 2,
      artifacts: [
        {
          ...saved.manifest.artifacts[0],
          relativePath: buildDirectorArtifactRelativePath(
            'scene-main',
            'frame-a',
            replacementHash,
            'frame-image',
          ),
          sha256: replacementHash,
        },
        second.manifest.artifacts[1],
      ],
    }, {
      sceneReference: scene.reference,
      previousManifestReference: saved.reference,
    })).rejects.toThrow(/不得在同一 Scene bundle 内改写/);

    mocks.files.set(`/project/${artifactPath}`, new Uint8Array([0, 0, 0, 0]));
    await expect(loadDirectorResultManifest('project-a', second.reference, {
      sceneReference: scene.reference,
    })).rejects.toThrow(/SHA-256 不匹配/);
  });

  it('rejects missing artifacts and renderer verification above 64 MiB', async () => {
    const asset = await putProjectFile('assets/hero.glb', new Uint8Array([8, 6, 4, 2]));
    const scene = await saveDirectorScene('project-a', sceneFixture(asset));
    const artifactHash = 'e'.repeat(64);
    const artifactPath = buildDirectorArtifactRelativePath(
      'scene-main',
      'video-a',
      artifactHash,
      'reference-video',
    );
    const manifest = {
      schemaVersion: 1,
      sceneId: 'scene-main',
      sceneRevision: 1,
      sceneSha256: scene.reference.sha256,
      manifestRevision: 1,
      producer: { runtime: 'lightweight-web', adapterVersion: '1.0.0' },
      artifacts: [{
        artifactId: 'video-a',
        kind: 'reference-video',
        mimeType: 'video/mp4',
        relativePath: artifactPath,
        sha256: artifactHash,
        bytes: 4,
        startFrame: 1,
        endFrame: 120,
        fps: 24,
      }],
    };
    const writeCount = mocks.writeCalls.length;
    await expect(saveDirectorResultManifest('project-a', manifest, {
      sceneReference: scene.reference,
    })).rejects.toThrow(/不存在/);
    expect(mocks.writeCalls).toHaveLength(writeCount);

    await expect(saveDirectorResultManifest('project-a', {
      ...manifest,
      artifacts: [{ ...manifest.artifacts[0], bytes: DIRECTOR_RENDERER_VERIFY_MAX_BYTES + 1 }],
    }, { sceneReference: scene.reference })).rejects.toThrow(/64 MiB/);
  });
});

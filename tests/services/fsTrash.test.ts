import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  exists: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  writeFile: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  notifyProjectDiskChanged: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => fsMocks);
vi.mock('@tauri-apps/api/core', () => ({ invoke: coreMocks.invoke }));
const projectDirMock = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../src/services/fs/core', () => ({
  getProjectDataDir: projectDirMock.get,
  isTauriEnv: () => true,
  joinPath: (...parts: string[]) => parts.join('/'),
  notifyProjectDiskChanged: coreMocks.notifyProjectDiskChanged,
}));

import {
  collectNodeFileReferences,
  deleteNodeFile,
  isPathInsideDir,
  isProjectOwnedFile,
  moveToUndoTrash,
  resolveNodeUndoTrashPaths,
  restoreFromUndoTrash,
  waitForPendingNodeFileDeletions,
} from '../../src/services/fs/trash';

function directorSceneReference(sceneId = 'scene-main') {
  return {
    schemaVersion: 1 as const,
    sceneId,
    revision: 1,
    relativePath: `director/scenes/${sceneId}/scene-r1-${'a'.repeat(64)}.json`,
    sha256: 'a'.repeat(64),
    bytes: 128,
  };
}

describe('undo trash media moves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.rename.mockResolvedValue(undefined);
    coreMocks.invoke.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('renames media into undo trash and back without reading file contents', async () => {
    const originalPath = 'D:/project/media/generated-video.mp4';

    await moveToUndoTrash(originalPath);

    expect(fsMocks.mkdir).toHaveBeenCalledWith('D:/project/media/.trash', { recursive: true });
    expect(fsMocks.rename).toHaveBeenCalledTimes(1);
    const trashPath = fsMocks.rename.mock.calls[0]?.[1] as string;
    expect(trashPath).toMatch(/^D:\/project\/media\/\.trash\/\d+-generated-video\.mp4$/);
    expect(fsMocks.readFile).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(fsMocks.remove).not.toHaveBeenCalled();
    expect(coreMocks.notifyProjectDiskChanged).toHaveBeenCalledOnce();

    await expect(restoreFromUndoTrash(originalPath)).resolves.toBe(true);

    expect(fsMocks.rename).toHaveBeenNthCalledWith(2, trashPath, originalPath);
    expect(fsMocks.readFile).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(coreMocks.notifyProjectDiskChanged).toHaveBeenCalledTimes(2);
  });

  it('暂存失败时把文件留在原地，不退回撤销不回来的系统回收站', async () => {
    const originalPath = 'D:/project/media/locked-video.mp4';
    fsMocks.rename.mockRejectedValueOnce(new Error('file is locked'));

    await moveToUndoTrash(originalPath);

    expect(coreMocks.invoke).not.toHaveBeenCalled();
    expect(fsMocks.remove).not.toHaveBeenCalled();
    expect(fsMocks.readFile).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    await expect(restoreFromUndoTrash(originalPath)).resolves.toBe(false);
  });

  it('等待接口能挡住"还原跑在暂存前面"的竞争', async () => {
    const originalPath = 'D:/project/media/slow-video.mp4';
    let finishRename: (() => void) | null = null;
    fsMocks.rename.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishRename = () => resolve();
    }));

    // 删除是即发即忘的：调用方不 await，撤销靠 waitForPendingNodeFileDeletions 兜底
    void deleteNodeFile({ filePath: 'D:/project/media/slow-video.mp4' });
    await vi.waitFor(() => expect(finishRename).not.toBeNull());
    finishRename!();
    await waitForPendingNodeFileDeletions();

    // 暂存已经落定，此时的还原才能真正把文件搬回来
    await expect(restoreFromUndoTrash(originalPath)).resolves.toBe(true);
  });
});

describe('删除节点文件的项目归属校验', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.rename.mockResolvedValue(undefined);
    projectDirMock.get.mockResolvedValue('D:/data/project-b');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('路径归属判定兼容反斜杠、大小写与同前缀目录', () => {
    expect(isPathInsideDir('D:\\data\\project-b\\a.png', 'D:/data/project-b')).toBe(true);
    expect(isPathInsideDir('D:/DATA/Project-B/a.png', 'D:/data/project-b')).toBe(true);
    expect(isPathInsideDir('D:/data/project-b2/a.png', 'D:/data/project-b')).toBe(false);
    expect(isPathInsideDir('D:/data/project-a/a.png', 'D:/data/project-b')).toBe(false);
    // 目录本身不算「目录内的文件」
    expect(isPathInsideDir('D:/data/project-b', 'D:/data/project-b')).toBe(false);
  });

  it('跨项目复制来的文件不会被删除', async () => {
    // 当前项目是 B，但节点的 filePath 仍指向源项目 A
    await deleteNodeFile({ filePath: 'D:/data/project-a/original.png' }, undefined, 'project-b');

    expect(fsMocks.rename).not.toHaveBeenCalled();
    expect(coreMocks.invoke).not.toHaveBeenCalled();
  });

  it('本项目内的文件正常移入 .trash', async () => {
    await deleteNodeFile({ filePath: 'D:/data/project-b/own.png' }, undefined, 'project-b');

    expect(fsMocks.rename).toHaveBeenCalledTimes(1);
  });

  it('Blender 导演节点按 scene bundle 目录整体暂存，不重复移动目录内 artifact', async () => {
    await deleteNodeFile({
      filePath: 'D:/data/project-b/director/scenes/scene-main/results/frame.png',
      directorCaptureFilePaths: [
        'D:/data/project-b/director/scenes/scene-main/results/frame.png',
        'D:/data/project-b/director/scenes/scene-main/results/project.blend',
      ],
      directorScene: directorSceneReference(),
    }, undefined, 'project-b');

    expect(fsMocks.rename).toHaveBeenCalledTimes(1);
    expect(fsMocks.rename.mock.calls[0]?.[0]).toBe(
      'D:/data/project-b/director/scenes/scene-main',
    );
    expect(fsMocks.rename.mock.calls[0]?.[1]).toMatch(
      /^D:\/data\/project-b\/director\/scenes\/\.trash\/\d+-scene-main$/,
    );
  });

  it('幸存导演节点共享同一 sceneId 时保留整个 Blender bundle', async () => {
    const data = { directorScene: directorSceneReference() };
    const keep = collectNodeFileReferences(data);

    await deleteNodeFile(data, keep, 'project-b');

    expect(fsMocks.rename).not.toHaveBeenCalled();
  });

  it('普通节点仍引用 scene bundle 内截图时也保留整个目录', async () => {
    const keep = new Set([
      'D:/data/project-b/director/scenes/scene-main/results/shared-frame.png',
    ]);

    await deleteNodeFile({
      directorScene: directorSceneReference(),
    }, keep, 'project-b');

    expect(fsMocks.rename).not.toHaveBeenCalled();
  });

  it('目录引用冲突时失败关闭，只解析项目内普通文件', async () => {
    const paths = await resolveNodeUndoTrashPaths({
      filePath: 'D:/data/project-b/own.png',
      directorScene: directorSceneReference('scene-a'),
      directorResultManifest: {
        schemaVersion: 1,
        sceneId: 'scene-b',
        sceneRevision: 1,
        sceneSha256: 'b'.repeat(64),
        manifestRevision: 1,
        relativePath: `director/scenes/scene-b/results/manifest-r1-${'c'.repeat(64)}.json`,
        sha256: 'c'.repeat(64),
        bytes: 96,
      },
    }, 'project-b');

    expect(paths).toEqual(['D:/data/project-b/own.png']);
  });

  it('仍被其他存活节点引用的文件跳过删除', async () => {
    const keep = new Set(['D:/data/project-b/own.png']);
    await deleteNodeFile({ filePath: 'D:/data/project-b/own.png' }, keep, 'project-b');

    expect(fsMocks.rename).not.toHaveBeenCalled();
  });

  it('没有当前项目时判定为不归属，不删任何文件', async () => {
    expect(await isProjectOwnedFile('D:/data/project-b/own.png', null)).toBe(false);
    await deleteNodeFile({ filePath: 'D:/data/project-b/own.png' }, undefined, null);

    expect(fsMocks.rename).not.toHaveBeenCalled();
  });

  it('不传 projectId 时保持旧行为（调用方尚未接入校验）', async () => {
    await deleteNodeFile({ filePath: 'D:/data/project-a/original.png' });

    expect(fsMocks.rename).toHaveBeenCalledTimes(1);
  });
});

/**
 * fsTrash — 回归测试：显式资产删除的回收站结果。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  exists: vi.fn(),
  lstat: vi.fn(async () => ({ isSymlink: false })),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  writeFile: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  notifyProjectDiskChanged: vi.fn(),
  isTauriEnv: vi.fn(() => true),
  isSharedProjectDataDir: vi.fn(() => false),
  getNativeProjectOwner: vi.fn<() => string | undefined>(() => undefined),
}));

const nativeTrash = vi.hoisted(() => ({
  guard: vi.fn(), isCurrent: vi.fn(async () => true), isCopySource: vi.fn(() => false),
}));
vi.mock('../../src/services/fs/nativeNodeTrash', () => ({ createNativeNodeTrashGuard: nativeTrash.guard }));
vi.mock('../../src/services/nodeMediaCopy', () => ({ isNodeMediaCopySource: nativeTrash.isCopySource }));

vi.mock('@tauri-apps/plugin-fs', () => fsMocks);
vi.mock('@tauri-apps/api/core', () => ({ invoke: coreMocks.invoke }));
const projectDirMock = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../src/services/fs/core', () => ({
  getProjectDataDir: projectDirMock.get,
  sanitizeFolderName: (name: string) => name.replace(/[<>:"|?*/\\]/g, "_"),
  isTauriEnv: coreMocks.isTauriEnv,
  isSharedProjectDataDir: coreMocks.isSharedProjectDataDir,
  getNativeProjectOwner: coreMocks.getNativeProjectOwner,
  joinPath: (...parts: string[]) => parts.join('/'),
  notifyProjectDiskChanged: coreMocks.notifyProjectDiskChanged,
}));

import {
  collectNodeFileReferences,
  deleteNodeFile,
  deleteNodeFiles,
  deleteProjectDataDir,
  resolveGroupUndoTrashPaths,
  isPathInsideDir,
  isProjectOwnedFile,
  moveToUndoTrash,
  moveToTrash,
  recoverUndoTrashReferences,
  resolveNodeUndoTrashPaths,
  restoreFromUndoTrash,
  waitForPendingNodeFileDeletions,
} from '../../src/services/fs/trash';
import { readUndoTrashEntries } from '../../src/services/fs/undoTrashJournal';

describe('显式资产删除的回收站结果', () => {
  beforeEach(() => {
    coreMocks.invoke.mockReset(); coreMocks.isTauriEnv.mockReturnValue(true); coreMocks.notifyProjectDiskChanged.mockClear();
  });
  it('等待原生回收站操作成功后才完成', async () => {
    let finish!: () => void;
    coreMocks.invoke.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    let completed = false;
    const deletion = moveToTrash('/assets/image.png', { throwOnError: true }).then(() => { completed = true; });
    await Promise.resolve(); expect(completed).toBe(false);
    expect(coreMocks.notifyProjectDiskChanged).not.toHaveBeenCalled();
    expect(coreMocks.invoke).toHaveBeenCalledWith('move_to_trash', { path: '/assets/image.png' });
    finish(); await deletion; expect(completed).toBe(true);
    expect(coreMocks.notifyProjectDiskChanged).toHaveBeenCalledOnce();
  });
  it('原生失败向资产库抛出，兼容调用仍忽略失败', async () => {
    const failure = new Error('locked'); coreMocks.invoke.mockRejectedValue(failure);
    await expect(moveToTrash('/assets/image.png', { throwOnError: true })).rejects.toBe(failure);
    expect(coreMocks.notifyProjectDiskChanged).not.toHaveBeenCalled();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(moveToTrash('/assets/image.png')).resolves.toBeUndefined();
    warning.mockRestore();
  });
  it('Web 环境显式删除失败，不报告虚假的成功', async () => {
    coreMocks.isTauriEnv.mockReturnValue(false);
    try {
      await expect(moveToTrash('/assets/image.png', { throwOnError: true })).rejects.toThrow('桌面应用');
      await expect(moveToTrash('/assets/image.png')).resolves.toBeUndefined();
      expect(coreMocks.invoke).not.toHaveBeenCalled();
    } finally { coreMocks.isTauriEnv.mockReturnValue(true); }
  });
});

describe('项目暂存目录的严格清理', () => {
  beforeEach(() => {
    vi.restoreAllMocks(); coreMocks.invoke.mockReset(); coreMocks.isTauriEnv.mockReturnValue(true);
    projectDirMock.get.mockResolvedValue('/projects/staging'); fsMocks.exists.mockResolvedValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  it('原生删除失败真正拒绝，下一次调用可再次尝试', async () => {
    const failure = new Error('暂存目录被占用');
    coreMocks.invoke.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    await expect(deleteProjectDataDir('staging', { throwOnError: true })).rejects.toBe(failure);
    await expect(deleteProjectDataDir('staging', { throwOnError: true })).resolves.toBeUndefined();
    expect(coreMocks.invoke).toHaveBeenCalledTimes(2);
    expect(coreMocks.invoke).toHaveBeenLastCalledWith('move_to_trash', { path: '/projects/staging' });
  });
  it('默认旧调用仍忽略原生错误', async () => {
    coreMocks.invoke.mockRejectedValueOnce(new Error('暂存目录被占用'));
    await expect(deleteProjectDataDir('staging')).resolves.toBeUndefined();
    expect(coreMocks.invoke).toHaveBeenCalledOnce();
  });
  it('严格清理已不存在的目录不再次调用原生删除', async () => {
    fsMocks.exists.mockResolvedValueOnce(false);
    await expect(deleteProjectDataDir('staging', { throwOnError: true })).resolves.toBeUndefined();
    expect(coreMocks.invoke).not.toHaveBeenCalled();
  });
  it('严格清理缺少运行时、目录定位或查询权限时拒绝', async () => {
    coreMocks.isTauriEnv.mockReturnValueOnce(false);
    await expect(deleteProjectDataDir('staging', { throwOnError: true })).rejects.toThrow('桌面应用');
    projectDirMock.get.mockResolvedValueOnce(null);
    await expect(deleteProjectDataDir('staging', { throwOnError: true })).rejects.toThrow('无法定位');
    fsMocks.exists.mockRejectedValueOnce(new Error('访问被拒绝'));
    await expect(deleteProjectDataDir('staging', { throwOnError: true })).rejects.toThrow('访问被拒绝');
    expect(coreMocks.invoke).not.toHaveBeenCalled();
  });
});

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
    fsMocks.exists.mockImplementation(async (path: string) => !path.includes('/.trash/'));
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
    expect(trashPath).toMatch(/^D:\/project\/media\/\.trash\/[^/]+-generated-video\.mp4$/);
    expect(fsMocks.readFile).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(fsMocks.remove).not.toHaveBeenCalled();
    expect(coreMocks.notifyProjectDiskChanged).toHaveBeenCalledOnce();

    fsMocks.exists.mockImplementation(async (path: string) => path === trashPath || !path.includes('/.trash/') && path !== originalPath);
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
    const staged = fsMocks.rename.mock.calls[0][1];
    fsMocks.exists.mockImplementation(async (path: string) => path === staged || !path.includes('/.trash/') && path !== originalPath);
    await expect(restoreFromUndoTrash(originalPath)).resolves.toBe(true);
  });
});

describe('删除节点文件的项目归属校验', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coreMocks.isSharedProjectDataDir.mockReturnValue(false);
    fsMocks.exists.mockImplementation(async (path: string) => !path.includes('/.trash/'));
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.rename.mockResolvedValue(undefined);
    projectDirMock.get.mockResolvedValue('D:/data/project-b');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('删除分集节点或分组仅移除引用，不回收全剧共享素材', async () => {
    coreMocks.isSharedProjectDataDir.mockReturnValue(true);
    const filePath = 'D:/data/project-b/分组/角色.png';
    expect(await resolveNodeUndoTrashPaths({ filePath }, 'episode-2')).toEqual([]);
    expect(await resolveGroupUndoTrashPaths(['分组'], 'episode-2')).toEqual([]);
    await deleteNodeFiles([{ filePath }], undefined, 'episode-2', ['分组']);
    expect(fsMocks.rename).not.toHaveBeenCalled();
    expect(coreMocks.invoke).not.toHaveBeenCalled();
    expect(coreMocks.notifyProjectDiskChanged).not.toHaveBeenCalled();
  });

  it('路径归属判定兼容反斜杠、大小写与同前缀目录', () => {
    expect(isPathInsideDir('D:\\data\\project-b\\a.png', 'D:/data/project-b')).toBe(true);
    expect(isPathInsideDir('D:/DATA/Project-B/a.png', 'D:/data/project-b')).toBe(true);
    expect(isPathInsideDir('D:/data/project-b2/a.png', 'D:/data/project-b')).toBe(false);
    expect(isPathInsideDir('D:/data/project-a/a.png', 'D:/data/project-b')).toBe(false);
    // 目录本身不算「目录内的文件」
    expect(isPathInsideDir('D:/data/project-b', 'D:/data/project-b')).toBe(false);
    expect(isPathInsideDir('/data/Project/a.png', '/data/project')).toBe(false);
    expect(isPathInsideDir('/data/project/a.png', '/data/project')).toBe(true);
  });

  it('分镜仍持有参考画面或成片快照时，删除来源节点保留共用文件', async () => {
    const imagePath = 'D:/data/project-b/reference.png';
    const videoPath = 'D:/data/project-b/final.mp4';
    const keep = collectNodeFileReferences({ shotlistRows: [{
      frame: { filePath: imagePath },
      video: { url: `asset://localhost/${videoPath}` },
    }] });
    expect(keep).toEqual(new Set([imagePath, videoPath]));

    await deleteNodeFiles([{ filePath: imagePath }, { filePath: videoPath }], keep, 'project-b');

    expect(fsMocks.rename).not.toHaveBeenCalled();
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

  it('原项目保存前中断时，按已提交的暂存记录恢复仍引用的原件', async () => {
    const root = 'D:/data/recovery-fixture';
    projectDirMock.get.mockResolvedValue(root);
    const original = `${root}/分组/keep.png`, unused = `${root}/分组/removed.png`;
    const files = new Set([original, unused]);
    fsMocks.exists.mockImplementation(async (path: string) => files.has(path));
    fsMocks.rename.mockImplementation(async (from: string, to: string) => {
      if (from === original || from === unused) {
        const persisted = await readUndoTrashEntries(`${root}/.trash`);
        expect(persisted).toContainEqual(expect.objectContaining({ originalPath: from, stagedPath: to }));
      }
      files.delete(from);
      files.add(to);
    });

    await deleteNodeFiles([{ filePath: original }, { filePath: unused }], undefined, 'project-b');
    await recoverUndoTrashReferences(root, new Set([original]), ['分组']);

    expect(files.has(original)).toBe(true);
    expect(files.has(unused)).toBe(false);
    expect(await readUndoTrashEntries(`${root}/.trash`)).toEqual([expect.objectContaining({ originalPath: unused })]);
  });

  it('整组删除只移动目录到项目根回收站，包含旧的组内回收站', async () => {
    await deleteNodeFiles([
      { filePath: 'D:/data/project-b/分组/a.png' },
      { filePath: 'D:/data/project-b/分组/b.png' },
    ], new Set(), 'project-b', ['分组']);
    expect(fsMocks.rename).toHaveBeenCalledTimes(1);
    expect(fsMocks.rename.mock.calls[0][0]).toBe('D:/data/project-b/分组');
    expect(fsMocks.rename.mock.calls[0][1]).toMatch(/^D:\/data\/project-b\/\.trash\/[^/]+-分组$/);
    expect(fsMocks.mkdir).toHaveBeenCalledWith('D:/data/project-b/.trash', { recursive: true });
    expect(fsMocks.mkdir).not.toHaveBeenCalledWith('D:/data/project-b/分组/.trash', expect.anything());
    const staged = fsMocks.rename.mock.calls[0][1];
    fsMocks.exists.mockImplementation(async (path: string) => path !== 'D:/data/project-b/分组');
    await expect(restoreFromUndoTrash('D:/data/project-b/分组', 'project-b')).resolves.toBe(true);
    expect(fsMocks.rename).toHaveBeenLastCalledWith(staged, 'D:/data/project-b/分组');
  });

  it('单独删除组内文件也使用项目根回收站', async () => {
    await deleteNodeFile({ filePath: 'D:/data/project-b/分组/only.png' }, new Set(), 'project-b');
    expect(fsMocks.rename.mock.calls[0]).toEqual([
      'D:/data/project-b/分组/only.png', expect.stringMatching(/^D:\/data\/project-b\/\.trash\/[^/]+-only.png$/),
    ]);
  });

  it('同毫秒删除不同分组里的同名文件不会共用回收目标', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123);
    await deleteNodeFiles([{ filePath: 'D:/data/project-b/one/a.png' }, { filePath: 'D:/data/project-b/two/a.png' }], undefined, 'project-b');
    expect(fsMocks.rename.mock.calls[0][1]).not.toBe(fsMocks.rename.mock.calls[1][1]);
  });

  it('组外仍有引用时保留目录与共享文件，只回收独占文件', async () => {
    await deleteNodeFiles([
      { filePath: 'D:/data/project-b/shared/a.png' }, { filePath: 'D:/data/project-b/shared/b.png' },
    ], new Set(['D:/data/project-b/shared/a.png']), 'project-b', ['shared']);
    expect(fsMocks.rename).toHaveBeenCalledTimes(1);
    expect(fsMocks.rename.mock.calls[0][0]).toBe('D:/data/project-b/shared/b.png');
  });

  it('空分组也整体回收，恢复时不覆盖新建的同名目录', async () => {
    await deleteNodeFiles([], undefined, 'project-b', ['空组']);
    expect(fsMocks.rename).toHaveBeenCalledTimes(1);
    fsMocks.exists.mockResolvedValue(true);
    await expect(restoreFromUndoTrash('D:/data/project-b/空组', 'project-b')).resolves.toBe(false);
    expect(fsMocks.rename).toHaveBeenCalledTimes(1);
  });

  it('拒绝特殊目录及目录穿越，不扩大整组回收范围', async () => {
    expect(await resolveGroupUndoTrashPaths(['..', '../other', '.trash', '.thumbnail', 'AppData', 'director'], 'project-b')).toEqual([]);
    await moveToUndoTrash('D:/data/project-b/../private.png', 'project-b');
    expect(fsMocks.rename).not.toHaveBeenCalled();
  });

  it('分组目录是符号链接时不移动其中指向的项目外文件', async () => {
    fsMocks.lstat.mockResolvedValueOnce({ isSymlink: true });
    await deleteNodeFile({ filePath: 'D:/data/project-b/linked/image.png' }, undefined, 'project-b');
    expect(fsMocks.rename).not.toHaveBeenCalled();
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
      /^D:\/data\/project-b\/\.trash\/[^/]+-scene-main$/,
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

describe('新结构节点逐文件回收', () => {
  const projectId = 'native-canvas';
  const root = 'D:/data/new-project';
  const filePath = `${root}/分组/视频.mp4`;
  const context = () => ({ deletedNodeIds: ['video-node'], getLiveKeepPaths: vi.fn<() => ReadonlySet<string> | null>(() => new Set<string>()) });
  afterEach(() => {
    coreMocks.getNativeProjectOwner.mockReturnValue(undefined);
    coreMocks.isSharedProjectDataDir.mockReturnValue(false);
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    coreMocks.isTauriEnv.mockReturnValue(true);
    coreMocks.getNativeProjectOwner.mockReturnValue('native-owner');
    coreMocks.isSharedProjectDataDir.mockReturnValue(true);
    projectDirMock.get.mockResolvedValue(root);
    fsMocks.exists.mockImplementation(async (path: string) => !path.includes('/.trash/'));
    fsMocks.lstat.mockResolvedValue({ isSymlink: false });
    fsMocks.rename.mockResolvedValue(undefined);
    nativeTrash.isCurrent.mockResolvedValue(true);
    nativeTrash.isCopySource.mockReturnValue(false);
    nativeTrash.guard.mockResolvedValue({ references: new Set(), isCurrent: nativeTrash.isCurrent });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('共用作品根中的独占文件进入主根 .trash，撤销恢复且不整体搬走同名分组', async () => {
    await deleteNodeFiles([{ filePath }], new Set(), projectId, ['分组'], context());
    expect(nativeTrash.guard).toHaveBeenCalledWith(projectId, ['video-node']);
    expect(fsMocks.rename).toHaveBeenCalledTimes(1);
    const trashPath = fsMocks.rename.mock.calls[0][1] as string;
    expect(trashPath).toMatch(/^D:\/data\/new-project\/\.trash\/[^/]+-视频\.mp4$/);
    expect(fsMocks.rename).toHaveBeenCalledWith(filePath, trashPath);
    expect(fsMocks.readFile).not.toHaveBeenCalled();
    expect(coreMocks.invoke).not.toHaveBeenCalled();
    expect(await resolveNodeUndoTrashPaths({ filePath }, projectId)).toEqual([filePath]);
    fsMocks.exists.mockImplementation(async (path: string) => path !== filePath);
    await expect(restoreFromUndoTrash(filePath, projectId)).resolves.toBe(true);
    expect(fsMocks.rename).toHaveBeenLastCalledWith(trashPath, filePath);
  });

  it('其他画布仍引用的相同文件按 Windows 路径身份保留', async () => {
    nativeTrash.guard.mockResolvedValue({ references: new Set([filePath.toUpperCase()]), isCurrent: nativeTrash.isCurrent });
    await deleteNodeFiles([{ filePath }], new Set(), projectId, [], context());
    expect(fsMocks.rename).not.toHaveBeenCalled();
  });

  it.each(['changed', 'switched', 'new-reference', 'copying'] as const)('回收前状态改变时保留文件：%s', async (condition) => {
    const current = context();
    if (condition === 'changed') nativeTrash.isCurrent.mockResolvedValue(false);
    if (condition === 'switched') current.getLiveKeepPaths.mockReturnValue(null);
    if (condition === 'new-reference') current.getLiveKeepPaths.mockReturnValue(new Set([filePath]));
    if (condition === 'copying') nativeTrash.isCopySource.mockReturnValue(true);
    await deleteNodeFiles([{ filePath }], new Set(), projectId, [], current);
    expect(fsMocks.rename).not.toHaveBeenCalled();
  });

  it('没有明确删除范围、引用读取失败或隐藏元数据时不移动文件，也不阻止节点删除完成', async () => {
    await deleteNodeFiles([{ filePath }], new Set(), projectId);
    expect(nativeTrash.guard).not.toHaveBeenCalled();
    nativeTrash.guard.mockRejectedValueOnce(new Error('unavailable'));
    await expect(deleteNodeFiles([{ filePath }], new Set(), projectId, [], context())).resolves.toBeUndefined();
    await deleteNodeFiles([{ filePath: `${root}/.ai-canvas-native-project.json` }], new Set(), projectId, [], context());
    expect(fsMocks.rename).not.toHaveBeenCalled();
  });
});

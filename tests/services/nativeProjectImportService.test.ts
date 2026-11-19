import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeProjectImportJournal } from '../../src/services/indexedDb/nativeProjectRepository';

const io = vi.hoisted(() => ({
  invoke: vi.fn(), getBaseDir: vi.fn(), readProject: vi.fn(), readImport: vi.fn(), advanceImport: vi.fn(), verifyHistory: vi.fn(), verifyMedia: vi.fn(),
  exists: vi.fn(), lstat: vi.fn(), readDir: vi.fn(), remove: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: io.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ copyFile: vi.fn(), mkdir: vi.fn(), exists: io.exists, lstat: io.lstat,
  readDir: io.readDir, remove: io.remove }));
vi.mock('../../src/services/fileService', () => ({ getBaseDir: io.getBaseDir, joinPath: (...parts: string[]) => parts.join('/'), isTauriEnv: () => true }));
vi.mock('../../src/services/nativeArchiveHistoryCommit', () => ({ assertNativeArchiveHistoryCommitted: io.verifyHistory, commitNativeArchiveHistory: vi.fn() }));
vi.mock('../../src/services/projectModelArchiveNativePort', () => ({ createBoundProjectModelArchiveImportPort: () => ({ verifyMediaPublication: io.verifyMedia }) }));
vi.mock('../../src/services/indexedDb/nativeProjectRepository', () => ({
  advanceNativeProjectImport: io.advanceImport, commitNativeProjectImport: vi.fn(), prepareNativeProjectImport: vi.fn(),
  readNativeProjectContent: io.readProject, readNativeProjectImport: io.readImport,
}));
vi.mock('../../src/services/projectImportService', () => ({ withPreparedProjectImportRead: vi.fn() }));

import { cleanupFinalizedNativeProjectImportSources, resumeNativeProjectImport } from '../../src/services/nativeProjectImportService';

const operationId = '11111111-1111-4111-8111-111111111111';
const projectId = 'p2-22222222-2222-4222-8222-222222222222';
const base = '/data', root = '/data/已导入作品';
const sourceRef = `native-import-${operationId}`, stage = `${base}/${sourceRef}`;
const sha256 = 'a'.repeat(64);
const sourceFile = { path: 'images/frame.png', bytes: 12, sha256 };

function importJournal(phase: NativeProjectImportJournal['phase'] = 'finalized'): NativeProjectImportJournal {
  return { id: operationId, operationId, projectId, targetProjectId: projectId, mode: 'import-new', phase,
    kind: 'project-model-import', schemaVersion: 1, sessionId: 'native-project', generation: 1,
    expected: null, next: { project: { id: projectId, name: '已导入作品' } },
    sequence: 4, committedToken: operationId, mediaPublicationRef: `media_v1_${operationId}`,
    media: [sourceFile], history: [], sourceRef,
    sourceFiles: [{ archivePath: `assets/${sourceFile.path}`, bytes: sourceFile.bytes, sha256 }],
  } as unknown as NativeProjectImportJournal;
}

const entry = (name: string, kind: 'folder' | 'file' | 'link') => ({ name, isDirectory: kind === 'folder', isFile: kind === 'file',
  isSymlink: kind === 'link', size: kind === 'file' ? sourceFile.bytes : 0 });
let stageEntries: Map<string, ReturnType<typeof entry>>;

beforeEach(() => {
  vi.resetAllMocks();
  stageEntries = new Map([[base, entry('data', 'folder')], [root, entry('已导入作品', 'folder')],
    [stage, entry(sourceRef, 'folder')], [`${stage}/images`, entry('images', 'folder')], [`${stage}/${sourceFile.path}`, entry('frame.png', 'file')],
    [`${root}/正式素材.png`, entry('正式素材.png', 'file')]]);
  io.getBaseDir.mockResolvedValue(base);
  io.exists.mockImplementation(async (path: string) => stageEntries.has(path));
  io.lstat.mockImplementation(async (path: string) => {
    const found = stageEntries.get(path);
    if (!found) throw new Error('路径不存在');
    return found;
  });
  io.readDir.mockImplementation(async (path: string) => [...stageEntries.entries()]
    .filter(([candidate]) => candidate.slice(0, candidate.lastIndexOf('/')) === path).map(([, found]) => found));
  io.remove.mockImplementation(async (path: string) => {
    if ([...stageEntries.keys()].some((candidate) => candidate.startsWith(`${path}/`))) throw new Error('目录非空');
    stageEntries.delete(path);
  });
  io.invoke.mockImplementation(async (command: string) => command === 'resolve_native_project_media_root' ? root : [sourceFile]);
  io.readProject.mockResolvedValue({ project: { id: projectId } });
  io.readImport.mockResolvedValue(importJournal());
  io.advanceImport.mockResolvedValue(importJournal());
});

describe('新项目导入暂存清理', () => {
  it('提交并完成收尾后只删除自己的文件和空目录，重试结果一致', async () => {
    io.readImport.mockResolvedValueOnce(importJournal('db_committed'));
    await expect(resumeNativeProjectImport(operationId)).resolves.toMatchObject({ projectId });
    expect(io.advanceImport).toHaveBeenCalledWith(operationId, 4, 'finalized');
    await cleanupFinalizedNativeProjectImportSources();
    await cleanupFinalizedNativeProjectImportSources();

    expect(io.verifyHistory).toHaveBeenCalledTimes(1);
    expect(io.verifyMedia).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ phase: 'finalized' }), `media_v1_${operationId}`);
    expect(io.remove.mock.calls).toEqual([[`${stage}/${sourceFile.path}`], [`${stage}/images`], [stage]]);
    expect(stageEntries.has(`${root}/正式素材.png`)).toBe(true);
  });

  it.each(['未最终完成', '找不到操作', '暂存与操作不符', '正式项目缺失', '正式素材缺失', '历史回执缺失', '暂存文件已变化', '有未知文件', '包含链接'])(
    '保留不具备清理证据的暂存（%s）', async (problem) => {
      if (problem === '未最终完成') io.readImport.mockResolvedValue(importJournal('media_ready'));
      if (problem === '找不到操作') io.readImport.mockResolvedValue(null);
      if (problem === '暂存与操作不符') io.readImport.mockResolvedValue({ ...importJournal(), sourceRef: `native-import-${projectId.slice(3)}` });
      if (problem === '正式项目缺失') io.readProject.mockResolvedValue(null);
      if (problem === '正式素材缺失') io.verifyMedia.mockRejectedValue(new Error('无法核对'));
      if (problem === '历史回执缺失') io.verifyHistory.mockRejectedValue(new Error('无法核对'));
      if (problem === '暂存文件已变化') io.invoke.mockImplementation(async (command: string) => command === 'resolve_native_project_media_root'
        ? root : [{ ...sourceFile, sha256: 'b'.repeat(64) }]);
      if (problem === '有未知文件') stageEntries.set(`${stage}/未登记.png`, entry('未登记.png', 'file'));
      if (problem === '包含链接') stageEntries.set(`${stage}/images`, entry('images', 'link'));
      await cleanupFinalizedNativeProjectImportSources();
      expect(io.remove).not.toHaveBeenCalled();
      expect(stageEntries.has(`${stage}/${sourceFile.path}`)).toBe(true);
    });

  it('空项目核对正式项目后清理无素材暂存', async () => {
    io.readImport.mockResolvedValue({ ...importJournal(), media: [], sourceFiles: [] });
    stageEntries.delete(`${stage}/${sourceFile.path}`);
    stageEntries.delete(`${stage}/images`);
    await cleanupFinalizedNativeProjectImportSources();
    expect(io.readProject).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(io.invoke).toHaveBeenCalledExactlyOnceWith('resolve_native_project_media_root', { projectId });
    expect(io.remove).toHaveBeenCalledExactlyOnceWith(stage);
  });

  it('摘要核对后更换父目录时仍保留文件', async () => {
    io.invoke.mockImplementation(async (command: string) => {
      if (command === 'resolve_native_project_media_root') return root;
      stageEntries.set(`${stage}/images`, entry('images', 'link'));
      return [sourceFile];
    });
    await cleanupFinalizedNativeProjectImportSources();
    expect(io.remove).not.toHaveBeenCalled();
  });

  it('清理中断后允许补删已核对的空目录', async () => {
    io.remove.mockImplementationOnce(async (path: string) => { stageEntries.delete(path); })
      .mockRejectedValueOnce(new Error('目录被占用'));
    await cleanupFinalizedNativeProjectImportSources();
    expect(stageEntries.has(`${stage}/images`)).toBe(true);
    expect(stageEntries.has(`${stage}/${sourceFile.path}`)).toBe(false);

    await cleanupFinalizedNativeProjectImportSources();
    expect(io.remove.mock.calls.slice(2)).toEqual([[`${stage}/images`], [stage]]);
    expect(stageEntries.has(stage)).toBe(false);
  });
});

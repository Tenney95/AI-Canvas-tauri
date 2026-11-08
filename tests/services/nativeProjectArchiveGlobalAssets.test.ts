import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectModelTransferCapture } from '../../src/types/projectModelTransfer';
import type { NativeMediaTaskRecord } from '../../src/services/indexedDb/nativeMediaTaskRepository';

const io = vi.hoisted(() => ({ invoke: vi.fn(), index: vi.fn(), exists: vi.fn(), published: [] as Array<{ path: string; bytes: number; sha256: string }> }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: io.invoke }));
vi.mock('@tauri-apps/plugin-fs', async (original) => ({ ...await original<typeof import('@tauri-apps/plugin-fs')>(), exists: io.exists }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('../../src/services/indexedDbService', async (original) => ({
  ...await original<typeof import('../../src/services/indexedDbService')>(), getAssetIndexById: io.index,
}));
vi.mock('../../src/services/fs/assetLibrary', () => ({ getGlobalFilesDir: vi.fn(async () => 'C:/global') }));
vi.mock('../../src/services/fs/assetIndex', () => ({ getRelativeAssetPath: (path: string, root: string) => path.startsWith(root + '/') ? path.slice(root.length + 1) : undefined }));
vi.mock('../../src/services/projectModelArchiveNativePort', () => ({ createBoundProjectModelArchiveExportPort: vi.fn() }));
vi.mock('../../src/services/indexedDb/nativeProjectRepository', () => ({ advanceNativeProjectExport: vi.fn(), prepareNativeProjectExport: vi.fn(),
  readNativeProjectCapture: vi.fn(), readNativeProjectExport: vi.fn(), listNativeRetiredCanvasIds: vi.fn() }));

import { materializeNativeArchiveGlobalAssets, nativeMediaResultsForArchive } from '../../src/services/nativeProjectArchiveService';

const hash = 'a'.repeat(64);
const source = () => ({ aggregate: { project: { id: 'p2-11111111-1111-4111-8111-111111111111' },
  content: { dramaAssets: { scenes: [{ imageAssetId: 'global-1', imageRelativePath: 'scene.png',
    referenceImages: [{ id: 'ref', assetSource: 'global', assetId: 'global-1', relativePath: 'scene.png' }] }] } }, canvases: [] } }) as unknown as ProjectModelTransferCapture;

beforeEach(() => {
  vi.clearAllMocks();
  io.published = []; io.exists.mockImplementation(async () => io.published.length > 0);
  vi.stubGlobal('crypto', webcrypto);
  io.index.mockResolvedValue({ assetId: 'global-1', source: 'global', status: 'online', path: 'C:/global/scene.png' });
  io.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'resolve_native_project_media_root') return 'C:/project';
    if (command === 'publish_project_import_assets') { io.published = (args.assets as Array<{ destinationPath: string; bytes: number; sha256: string }>).map((asset) => ({ path: asset.destinationPath, bytes: asset.bytes, sha256: asset.sha256 })); return undefined; }
    if (command === 'inspect_project_archive_assets') return args.selectedPaths
      ? (args.selectedPaths as string[]).map((path) => ({ path, bytes: 3, sha256: hash })) : io.published;
    throw new Error(`unexpected ${command}`);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('新项目包全局素材', () => {
  it('通用已保留媒体集合按每项类型和稳定ordinal纳入闭包，不导出查询上下文', () => {
    const record = { operationId: 'multi', canvasId: 'active', category: 'audio', providerConfigId: 'workflow', createdAt: 1,
      status: 'reviewed', localResults: [
        { category: 'audio', relativePath: `media/${'a'.repeat(64)}.mp3`, bytes: 10, sha256: 'a'.repeat(64) },
        { category: 'image', relativePath: `media/${'b'.repeat(64)}.png`, bytes: 11, sha256: 'b'.repeat(64) },
      ], pollContext: { submit: { task: 'original' } }, recovery: { kind: 'workflow', workflowId: 'private-id' } } as unknown as NativeMediaTaskRecord;
    const closure = nativeMediaResultsForArchive([record], new Set(['active']));
    expect(closure.map((file) => [file.ordinal, file.category])).toEqual([[0, 'audio'], [1, 'image']]);
    expect(closure.every((file) => !Object.hasOwn(file, 'pollContext') && !Object.hasOwn(file, 'recovery'))).toBe(true);
  });
  it('归档保留待本机交付和已结束跟踪的同步产物，不导出任务执行身份', () => {
    const sha256 = 'd'.repeat(64), path = `media/${sha256}.png`;
    const base = { canvasId: 'active-canvas', category: 'image', providerConfigId: 'provider', createdAt: 1,
      submissionKind: 'sync', localResult: { relativePath: path, bytes: 10, sha256 }, resultRelativePath: path,
      lease: 'runtime-only', remoteTaskId: undefined, providerBase: 'https://example.test' };
    const records = [{ ...base, operationId: 'pending-local', status: 'submitted' },
      { ...base, canvasId: 'retired-canvas', operationId: 'reviewed-local', status: 'reviewed' },
      { ...base, operationId: 'unknown-no-file', status: 'outcome-unknown', localResult: undefined, resultRelativePath: undefined },
      { ...base, operationId: 'unrelated-owner', canvasId: 'other-canvas', status: 'submitted' }] as unknown as NativeMediaTaskRecord[];
    const closure = nativeMediaResultsForArchive(records, new Set(['active-canvas', 'retired-canvas']));
    expect(closure.map((row) => row.operationId)).toEqual(['pending-local', 'reviewed-local']);
    expect(closure.every((row) => row.relativePath === path)).toBe(true);
    expect(closure.some((row) => Object.hasOwn(row, 'lease') || Object.hasOwn(row, 'remoteTaskId') || Object.hasOwn(row, 'providerBase'))).toBe(false);
  });
  it('尚未交付的批次也归档已保存的全部候选，ordinal稳定且不携带原task执行权', () => {
    const results = ['a', 'b', 'c'].map((letter) => ({ relativePath: `media/${letter.repeat(64)}.png`, bytes: 3, sha256: letter.repeat(64) }));
    const record = { operationId: 'batch', canvasId: 'active-canvas', category: 'image', providerConfigId: 'apimart', createdAt: 1,
      status: 'submitted', remoteTaskId: 'remote-a', providerBase: 'https://private.example', lease: 'never-export',
      apimartImageBatch: { version: 1, requestedCount: 1,
        submissions: [{ id: '11111111-1111-4111-8111-111111111111', state: 'submitted', taskIds: ['remote-a', 'remote-b'] }],
        tasks: [{ taskId: 'remote-a', state: 'completed', results: results.slice(0, 2) }, { taskId: 'remote-b', state: 'completed', results: results.slice(2) }] },
    } as unknown as NativeMediaTaskRecord;
    const closure = nativeMediaResultsForArchive([record], new Set(['active-canvas']));
    expect(closure.map((row) => [row.operationId, row.ordinal, row.relativePath])).toEqual(results.map((file, ordinal) => ['batch', ordinal, file.relativePath]));
    expect(closure.every((row) => !Object.hasOwn(row, 'remoteTaskId') && !Object.hasOwn(row, 'lease') && !Object.hasOwn(row, 'providerBase'))).toBe(true);
  });
  it('复制并核验全局引用，包快照改成本地路径而原项目不变', async () => {
    const original = source(), converted = await materializeNativeArchiveGlobalAssets(original, 'op-123');
    const scenes = (converted.aggregate.content.dramaAssets as unknown as { scenes: Array<Record<string, unknown>> }).scenes;
    const scene = scenes[0], reference = (scene.referenceImages as Array<Record<string, unknown>>)[0];
    expect(scene.relativePath).toMatch(/^imports\/global-op-123\/global-[a-f0-9]{64}\.png$/);
    expect(reference.relativePath).toBe(scene.relativePath);
    expect(scene.imageAssetId).toBeUndefined(); expect(reference.assetSource).toBeUndefined();
    expect((original.aggregate.content.dramaAssets as unknown as { scenes: Array<{ imageAssetId: string }> }).scenes[0].imageAssetId).toBe('global-1');
    expect(io.invoke).toHaveBeenCalledWith('publish_project_import_assets', expect.objectContaining({ operationId: 'global-op-123' }));
  });

  it('索引或字节缺失时拒绝导出且不发布文件', async () => {
    io.index.mockResolvedValue(undefined);
    await expect(materializeNativeArchiveGlobalAssets(source(), 'op-123')).rejects.toThrow('索引缺失');
    expect(io.invoke).not.toHaveBeenCalled();
  });

  it('角色厂商绑定的 imageAssetId 不是全局文件身份', async () => {
    const original = source();
    original.aggregate.content.dramaAssets = { version: 2, scenes: [], props: [], characters: [
      { id: 'character', name: '角色', volcengineBinding: { imageAssetId: 'provider-image-id' } },
    ] } as never;
    const converted = await materializeNativeArchiveGlobalAssets(original, 'op-123');
    expect(converted.aggregate.content.dramaAssets?.characters[0]).toMatchObject({ volcengineBinding: { imageAssetId: 'provider-image-id' } });
    expect(io.index).not.toHaveBeenCalled();
    expect(io.invoke).not.toHaveBeenCalled();
  });
  it('同操作重复物化只核验原发布集合，不能覆盖已发布的全局副本', async () => {
    const original = source();
    const first = await materializeNativeArchiveGlobalAssets(original, 'op-123');
    const second = await materializeNativeArchiveGlobalAssets(original, 'op-123');
    expect(second).toEqual(first);
    expect(io.invoke.mock.calls.filter(([command]) => command === 'publish_project_import_assets')).toHaveLength(1);
    io.published.push({ path: 'unexpected.png', bytes: 1, sha256: 'b'.repeat(64) });
    await expect(materializeNativeArchiveGlobalAssets(original, 'op-123')).rejects.toThrow('冻结清单');
    expect(io.invoke.mock.calls.filter(([command]) => command === 'publish_project_import_assets')).toHaveLength(1);
  });
});

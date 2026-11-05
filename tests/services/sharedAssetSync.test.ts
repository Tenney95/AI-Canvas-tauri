/**
 * sharedAssetSync — 回归测试：手动项目资产同步协调。
 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetIndexRecord } from '../../src/services/indexedDbService';
import type { DramaAssetLibrary, DramaCharacter } from '../../src/types/dramaAssets';
import type { SharedAssetSyncLocalState, SharedSyncDownloadInput, SharedSyncPrepareInput, SharedSyncRemoteAsset,
  SharedSyncHead, SharedSyncAssetDeletePreviewInput, SharedSyncAssetDeleteApplyInput } from '../../src/types/assetSync';
import type { SharedAssetSyncCommitInput } from '../../src/services/indexedDb/sharedAssetSyncRepository';
import type { AssetImageRecord } from '../../src/types/assetImage';
import { getAssetUrlFromPath } from '../../src/services/fs/core';
import { localMediaUrlToPath } from '../../src/utils/mediaUrl';

const mocks = vi.hoisted(() => ({
  repo: { mappings: [], outbox: [], conflicts: [] } as SharedAssetSyncLocalState,
  indexes: new Map<string, AssetIndexRecord>(), cloud: [] as SharedSyncRemoteAsset[],
  roots: new Map<string, string>(),
  deleted: [] as SharedSyncHead[],
  imageRecords: [] as AssetImageRecord[],
  changedPaths: new Set<string>(),
  prepare: vi.fn(), publish: vi.fn(), recover: vi.fn(), download: vi.fn(), acknowledge: vi.fn(),
  previewDelete: vi.fn(), applyDelete: vi.fn(),
  scan: vi.fn(), list: vi.fn(), listHeads: vi.fn(), copy: vi.fn(), image: vi.fn(), prepareImage: vi.fn(), putPlan: vi.fn(), patch: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async () => true), mkdir: vi.fn(async () => undefined), remove: vi.fn(async () => undefined),
  lstat: vi.fn(async (path: string) => ({ isFile: /\.(?:png|wav|mp4)$/.test(path),
    isDirectory: !/\.(?:png|wav|mp4)$/.test(path), isSymlink: false, size: 10, mtime: new Date(mocks.changedPaths.has(path) ? 20 : 10) })),
}));
vi.mock('../../src/services/fs/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fs/core')>(),
  getProjectDataDir: vi.fn(async (projectId: string) => mocks.roots.get(projectId)),
  joinPath: (...parts: string[]) => parts.join('/'), stripVerbatimPrefix: (value: string) => value,
  getFileCategory: (name: string) => name.endsWith('.wav') ? 'audio' : name.endsWith('.mp4') ? 'video' : 'image',
}));
vi.mock('../../src/services/fs/assetIndex', () => ({
  getRelativeAssetPath: (path: string, root: string) => path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined,
}));
vi.mock('../../src/services/fileService', () => ({ listProjectFiles: mocks.list, copyAssetFileToFolder: mocks.copy }));
vi.mock('../../src/services/fs/assetLibrary', () => ({ scanDirectoryFiles: mocks.scan }));
vi.mock('../../src/services/fs/assetImageMetadata', () => ({ readSharedAssetImageMetadata: mocks.image,
  prepareSharedAssetImageMetadata: mocks.prepareImage }));
vi.mock('../../src/services/indexedDbService', () => ({
  getAllProjects: vi.fn(async () => [{ id: 'owner' }, { id: 'episode', parentId: 'owner' }]),
  getAssetIndexById: vi.fn(async (id: string) => mocks.indexes.get(id)),
  getAllAssetMeta: vi.fn(async () => []), getAssetMetaById: vi.fn(async () => undefined),
  getAssetImageRecords: vi.fn(async () => structuredClone(mocks.imageRecords)),
}));
vi.mock('../../src/services/indexedDb/sharedAssetSyncRepository', () => ({
  loadSharedAssetSyncState: vi.fn(async () => structuredClone(mocks.repo)),
  putSharedAssetSyncPlan: mocks.putPlan, patchSharedAssetSyncOperation: mocks.patch,
}));
vi.mock('../../src/services/fs/sharedAssetStorage', () => ({
  listSharedAssetHeads: mocks.listHeads,
  prepareSharedAssetPublish: mocks.prepare, publishSharedAssetRevision: mocks.publish,
  recoverSharedAssetOperation: mocks.recover, downloadSharedAssetRevision: mocks.download,
  acknowledgeSharedAssetApply: mocks.acknowledge,
  previewSharedAssetDelete: mocks.previewDelete, applySharedAssetDelete: mocks.applyDelete,
}));

import { buildSharedAssetSyncPreview, executeSharedAssetSync, projectSharedFileView, sharedAssetSyncContentDigest,
  sharedAssetSyncExcludedPaths, projectAssetSyncService, type SharedAssetSyncContext } from '../../src/services/fs/sharedAssetSync';
import type { SharedAssetSyncExecution } from '../../src/services/fs/sharedAssetSync';

function character(): DramaCharacter {
  return { id: 'local-character', kind: 'character', name: '角色', key: '角色', identity: '身份', summary: '', visualNotes: '',
    importance: 'main', source: 'manual', confirmed: true, createdAt: 1, updatedAt: 2 };
}
function context(library?: DramaAssetLibrary): SharedAssetSyncContext {
  return { binding: { ownerId: 'owner', ownerName: '项目', connectionId: 'connection', connectionRevision: '1',
    libraryId: 'library', sharedProjectId: 'shared-project', projectPrefix: 'prefix', updatedAt: 1,
    capabilities: { checks: [], checkedAt: 1, cleanupPending: false, multiplayerWritable: true } },
    originProjectId: 'owner', projects: [{ id: 'owner' }], library: library ?? { version: 2, characters: [character()], scenes: [], props: [] },
    nodes: [], assertCurrent: vi.fn(), onStatus: vi.fn(), onTask: vi.fn() };
}
const prepared = new Map<string, { revision: SharedSyncRemoteAsset['revision']; revisionDigest: string }>();
const leaseToken = () => `${Date.now() + 120_000}.${'1'.repeat(64)}`;
function remoteFile(): SharedSyncRemoteAsset {
  return { etag: 'remote-etag', head: { sharedAssetId: 'remote-file', kind: 'file', revisionId: 'remote-revision',
    revisionDigest: 'd'.repeat(64), operationId: 'publisher-operation', updatedAt: 1 }, revision: {
    format: 'ai-canvas-shared-asset', version: 1, libraryId: 'library', sharedProjectId: 'shared-project', sharedAssetId: 'remote-file',
    revisionId: 'remote-revision', operationId: 'publisher-operation', createdAt: 1,
    payload: { kind: 'file', name: '共享.png', displayRelativePath: 'Library/共享.png', mediaId: 'image', tags: [] },
    media: [{ id: 'image', kind: 'image', extension: 'png', bytes: 10, sha256: 'a'.repeat(64) }] } };
}
function commitExecution(onLibrary?: (library: DramaAssetLibrary) => void) {
  return { applyDownload: vi.fn<SharedAssetSyncExecution['applyDownload']>(async ({ commit, nextLibrary }) => {
    for (const mapping of commit.mappings) mocks.repo.mappings = [...mocks.repo.mappings.filter((row) => row.id !== mapping.id), structuredClone(mapping)];
    const operation = { ...structuredClone(commit.operation), phase: commit.operation.direction === 'download' ? 'applied' as const : 'completed' as const };
    mocks.repo.outbox = [...mocks.repo.outbox.filter((row) => row.id !== operation.id), operation];
    for (const index of commit.indexes ?? []) mocks.indexes.set(index.assetId, index);
    if (nextLibrary) onLibrary?.(structuredClone(nextLibrary));
    return { alreadyApplied: false };
  }) };
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  // 只隔离 Tauri 原生委派；core.getAssetUrlFromPath 与 api.convertFileSrc 保持真实调用。
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { convertFileSrc: (path: string) => `asset://localhost${path}` } });
  vi.clearAllMocks(); prepared.clear(); mocks.repo = { mappings: [], outbox: [], conflicts: [] }; mocks.indexes.clear(); mocks.cloud = []; mocks.deleted = [];
  mocks.roots = new Map([['owner', '/project/owner'], ['episode', '/project/episode']]);
  mocks.imageRecords = [];
  mocks.changedPaths.clear();
  mocks.list.mockResolvedValue([]);
  mocks.listHeads.mockImplementation(async () => ({ assets: structuredClone(mocks.cloud), deletedAssets: structuredClone(mocks.deleted), complete: true }));
  mocks.previewDelete.mockImplementation(async (input: SharedSyncAssetDeletePreviewInput) => ({ sharedAssetId: input.sharedAssetId,
    revisionId: input.expectedRevisionId, operationId: input.operationId, previewToken: 'delete-preview' }));
  mocks.applyDelete.mockImplementation(async (input: SharedSyncAssetDeleteApplyInput) => {
    const asset = mocks.cloud.find((asset) => asset.head.sharedAssetId === input.sharedAssetId)!;
    mocks.cloud = mocks.cloud.filter((row) => row !== asset);
    mocks.deleted.push({ ...asset.head, deleted: true });
    return { status: 'deleted', sharedAssetId: input.sharedAssetId, operationId: input.operationId };
  });
  mocks.image.mockResolvedValue(null); mocks.acknowledge.mockResolvedValue(undefined);
  mocks.scan.mockResolvedValue({ files: [], folders: [], complete: true, truncated: false, failedDirectories: 0, failedFiles: 0 });
  mocks.copy.mockImplementation(async (source: string, directory: string) => ({ path: `${directory}/${source.split('/').at(-1)}`, totalBytes: 10, digest: 'a'.repeat(64) }));
  mocks.putPlan.mockImplementation(async (input: { mappings: SharedAssetSyncLocalState['mappings']; outbox: SharedAssetSyncLocalState['outbox']; conflicts?: SharedAssetSyncLocalState['conflicts'] }) => {
    for (const mapping of input.mappings) mocks.repo.mappings = [...mocks.repo.mappings.filter((row) => row.id !== mapping.id), structuredClone(mapping)];
    for (const operation of input.outbox) if (!mocks.repo.outbox.some((row) => row.id === operation.id)) mocks.repo.outbox.push(structuredClone(operation));
    for (const conflict of input.conflicts ?? []) mocks.repo.conflicts = [...mocks.repo.conflicts.filter((row) => row.id !== conflict.id), structuredClone(conflict)];
  });
  mocks.patch.mockImplementation(async (operationId: string, patch: object) => {
    const operation = mocks.repo.outbox.find((row) => row.operationId === operationId);
    if (!operation) throw new Error('未找到同步操作'); Object.assign(operation, patch); return structuredClone(operation);
  });
  mocks.prepare.mockImplementation(async (input: SharedSyncPrepareInput) => {
    // 真正副作用前必须已有固定操作；此断言可捕获先写文件再记录待办的倒序。
    expect(mocks.repo.outbox.some((row) => row.operationId === input.draft.operationId && row.draft)).toBe(true);
    const result = { revision: { ...structuredClone(input.draft), media: input.draft.media.map((entry) => ({ ...entry, sha256: 'a'.repeat(64), bytes: 10 })) },
      revisionDigest: 'd'.repeat(64) };
    prepared.set(input.draft.operationId, result); return result;
  });
  mocks.recover.mockImplementation(async (input: { operationId: string; sharedAssetId: string; revisionId: string }) => {
    const published = mocks.cloud.find((asset) => asset.head.sharedAssetId === input.sharedAssetId && asset.head.revisionId === input.revisionId);
    if (published) return { status: 'published', asset: structuredClone(published), applyToken: leaseToken() };
    return { status: 'retryable', prepared: prepared.get(input.operationId) };
  });
  mocks.publish.mockImplementation(async (input: { operationId: string }) => {
    const result = prepared.get(input.operationId)!;
    const asset: SharedSyncRemoteAsset = { revision: result.revision, etag: 'etag', head: {
      sharedAssetId: result.revision.sharedAssetId, revisionId: result.revision.revisionId,
      operationId: result.revision.operationId, revisionDigest: result.revisionDigest, kind: result.revision.payload.kind, updatedAt: 3 } };
    mocks.cloud = [...mocks.cloud.filter((entry) => entry.head.sharedAssetId !== asset.head.sharedAssetId), asset];
    return { status: 'published', asset, applyToken: leaseToken() };
  });
  mocks.download.mockImplementation(async (input: SharedSyncDownloadInput) => {
    const asset = mocks.cloud.find((entry) => entry.head.sharedAssetId === input.sharedAssetId && entry.head.revisionId === input.revisionId)!;
    return { status: 'ready', operationId: input.operationId, revision: asset.revision, revisionDigest: asset.head.revisionDigest,
      applyToken: leaseToken(), media: asset.revision.media.map((media) => ({ mediaId: media.id,
        relativePath: `.shared-sync/files/${input.sharedAssetId}/${input.revisionId}/${media.id}.${media.extension}`, bytes: media.bytes, sha256: media.sha256 })) };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

type AssetPlatform = 'windows' | 'unix';
const platformAssetUrl = (platform: AssetPlatform, path: string) => platform === 'windows'
  ? `http://asset.localhost/${encodeURIComponent(path)}` : `asset://localhost${path}`;

async function publishCardsThroughNativeBridge(platform: AssetPlatform) {
  const storage = await vi.importActual<typeof import('../../src/services/fs/sharedAssetStorage')>('../../src/services/fs/sharedAssetStorage');
  const native = { list: mocks.listHeads.getMockImplementation()!, prepare: mocks.prepare.getMockImplementation()!,
    recover: mocks.recover.getMockImplementation()!, publish: mocks.publish.getMockImplementation()!,
    download: mocks.download.getMockImplementation()!, acknowledge: mocks.acknowledge.getMockImplementation()! };
  const convert = vi.fn((path: string, _protocol: string) => platformAssetUrl(platform, path));
  const invoke = vi.fn(async (command: string, args: { input: unknown }) => {
    // 原生返回的是发件端实际 draft 填入摘要后的固定 revision，接收端不可手写另一份 payload。
    switch (command) {
      case 'project_asset_storage_list_heads': return native.list(args.input);
      case 'project_asset_storage_prepare_publish': return native.prepare(args.input);
      case 'project_asset_storage_recover_operation': return native.recover(args.input);
      case 'project_asset_storage_publish_revision': return native.publish(args.input);
      case 'project_asset_storage_download_revision': return native.download(args.input);
      case 'project_asset_storage_acknowledge_apply': return native.acknowledge(args.input);
      default: throw new Error(`未隔离的原生调用：${command}`);
    }
  });
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { convertFileSrc: convert, invoke } });
  mocks.listHeads.mockImplementation(storage.listSharedAssetHeads);
  mocks.prepare.mockImplementation(storage.prepareSharedAssetPublish);
  mocks.recover.mockImplementation(storage.recoverSharedAssetOperation);
  mocks.publish.mockImplementation(storage.publishSharedAssetRevision);
  mocks.download.mockImplementation(storage.downloadSharedAssetRevision);
  mocks.acknowledge.mockImplementation(storage.acknowledgeSharedAssetApply);
  const sourceRoot = platform === 'windows' ? 'D:/桥接素材/发件项目' : '/projects/发件项目';
  mocks.roots.set('owner', sourceRoot);
  const files = ['image.png', 'voice.wav', 'action.mp4'].map((name) => {
    const path = `${sourceRoot}/${name}`;
    const assetId = `source-${name}`;
    const index: AssetIndexRecord = { assetId, path, relativePath: name, rootPath: sourceRoot, projectId: 'owner',
      source: 'project', fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 };
    mocks.indexes.set(assetId, index);
    return { assetId, name, path, relativePath: name, category: name.endsWith('.wav') ? 'audio' as const
      : name.endsWith('.mp4') ? 'video' as const : 'image' as const, source: 'project' as const, size: 10 };
  });
  mocks.scan.mockResolvedValue({ files, complete: true });
  const imageUrl = await getAssetUrlFromPath(files[0].path);
  const audioUrl = await getAssetUrlFromPath(files[1].path);
  const videoUrl = await getAssetUrlFromPath(files[2].path);
  const library: DramaAssetLibrary = { version: 2, characters: [{ ...character(), assetId: files[0].assetId, imageUrl,
    imageNodeId: 'publisher-node', referenceImages: [{ id: 'reference', kind: 'primary', imageUrl, assetId: files[0].assetId,
      sourceNodeId: 'publisher-node', prompt: '主图提示词', createdAt: 1, updatedAt: 2 }], primaryReferenceImageId: 'reference',
    avatarReferenceImageId: 'reference', voiceClips: [{ id: 'voice', kind: 'timbre', audioUrl, assetId: files[1].assetId,
      transcript: '声音文本', createdAt: 1, updatedAt: 2 }], primaryVoiceClipId: 'voice',
    actions: [{ id: 'walking', category: 'walking', name: '行走', prompt: '动作提示词', createdAt: 1, updatedAt: 2,
      media: [{ id: 'walking-image', kind: 'gif', name: '姿势', url: imageUrl, assetId: files[0].assetId, createdAt: 1, updatedAt: 2 },
        { id: 'walking-video', kind: 'video', name: '动作', url: videoUrl, assetId: files[2].assetId, createdAt: 1, updatedAt: 2 }] }] }],
    scenes: [{ id: 'source-scene', kind: 'scene', name: '场景', key: '场景', summary: '', visualNotes: '',
      importance: 'supporting', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 2, imageUrl, assetId: files[0].assetId,
      referenceImages: [{ id: 'scene-reference', label: '场景图', imageUrl, assetId: files[0].assetId, prompt: '', createdAt: 1, updatedAt: 2 }],
      primaryReferenceImageId: 'scene-reference' }],
    props: [{ id: 'source-prop', kind: 'prop', name: '道具', key: '道具', summary: '', visualNotes: '',
      importance: 'supporting', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 2, imageUrl, assetId: files[0].assetId,
      referenceImages: [{ id: 'prop-reference', label: '道具图', imageUrl, assetId: files[0].assetId, prompt: '', createdAt: 1, updatedAt: 2 }],
      primaryReferenceImageId: 'prop-reference' }] };
  const outgoing = await buildSharedAssetSyncPreview(context(library));
  expect(outgoing.items.some((item) => item.direction === 'blocked')).toBe(false);
  await executeSharedAssetSync(outgoing, commitExecution());
  const cloudCards = structuredClone(mocks.cloud.filter((asset) => asset.head.kind !== 'file'));
  expect(cloudCards.map((asset) => asset.head.kind).sort()).toEqual(['character', 'prop', 'scene']);
  expect(JSON.stringify(cloudCards)).not.toMatch(/sourceNodeId|imageNodeId|relativePath|assetId|asset\.localhost|asset:\/\//);
  mocks.repo = { mappings: [], outbox: [], conflicts: [] }; mocks.indexes.clear(); mocks.cloud = cloudCards;
  mocks.scan.mockResolvedValue({ files: [], complete: true });
  mocks.roots.set('owner', platform === 'windows' ? 'D:/桥接素材/收件项目' : '/projects/收件项目');
  mocks.prepare.mockClear(); mocks.publish.mockClear(); mocks.download.mockClear(); mocks.acknowledge.mockClear();
  return { convert, invoke };
}

async function blockedWeaponCandidate() {
  const value = context({ version: 2, characters: [{ ...character(), weaponIds: ['weapon'] }], scenes: [], props: [{ id: 'weapon',
    kind: 'prop', propType: 'weapon', name: '长剑', key: '长剑', summary: '', visualNotes: '', importance: 'main', confirmed: true,
    source: 'manual', createdAt: 1, updatedAt: 2, assetId: 'missing-weapon-media', imageUrl: 'asset://localhost/project/missing.png' }] });
  const initial = await buildSharedAssetSyncPreview(value);
  expect(initial.operations).toHaveLength(0);
  const old = structuredClone(mocks.repo.outbox.find((row) => row.kind === 'character')!);
  expect(old).toMatchObject({ phase: 'paused', errorCode: 'dependency_missing' });
  value.library.characters[0].weaponIds = [];
  mocks.prepare.mockClear(); mocks.acknowledge.mockClear();
  return { value, old };
}

describe('手动项目资产同步协调', () => {
  it('逐项上传只执行所选固定操作，其余待办身份、内容和阶段保持不变', async () => {
    const value = context({ version: 2, characters: [character(), { ...character(), id: 'second', name: '第二人' }], scenes: [], props: [] });
    const session = await buildSharedAssetSyncPreview(value);
    const [selected, untouched] = session.operations;
    const before = structuredClone(mocks.repo.outbox.find((row) => row.operationId === untouched.operation.operationId));
    await executeSharedAssetSync(session, commitExecution(), { itemId: selected.mapping.id, direction: 'upload' });
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: selected.operation.operationId }));
    expect(mocks.repo.outbox.find((row) => row.operationId === untouched.operation.operationId)).toEqual(before);
    expect(value.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'preview', completed: 1, total: 2 }));
    const reopened = await buildSharedAssetSyncPreview(value);
    expect(reopened.operations.find((item) => item.mapping.id === untouched.mapping.id)?.operation).toMatchObject({
      operationId: before!.operationId, revisionId: before!.revisionId, phase: before!.phase });
  });

  it('逐项操作不反转方向，也不绕过冲突或未纳入状态', async () => {
    const session = await buildSharedAssetSyncPreview(context());
    const target = session.operations[0]; const before = structuredClone(mocks.repo);
    await expect(executeSharedAssetSync(session, commitExecution(), { itemId: target.mapping.id, direction: 'download' })).rejects.toThrow('所选方向');
    for (const direction of ['conflict', 'blocked'] as const) {
      session.items[0].direction = direction;
      await expect(executeSharedAssetSync(session, commitExecution(), { itemId: target.mapping.id, direction: 'upload' })).rejects.toThrow('所选方向');
    }
    expect(mocks.repo).toEqual(before); expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });

  it.each(['upload', 'download'] as const)('单项%s先要求跨卡依赖完成，角色内部媒体闭包不拆分', async (direction) => {
    const source = character(); source.summary = '同伴 @drama{second:第二人}';
    const value = context({ version: 2, characters: [source, { ...character(), id: 'second', name: '第二人' }], scenes: [], props: [] });
    let session = await buildSharedAssetSyncPreview(value);
    if (direction === 'download') {
      await executeSharedAssetSync(session, commitExecution());
      mocks.repo = { mappings: [], outbox: [], conflicts: [] }; mocks.indexes.clear();
      session = await buildSharedAssetSyncPreview(context({ version: 2, characters: [], scenes: [], props: [] }));
      mocks.publish.mockClear();
    }
    const dependent = session.operations.find((item) => item.operation.revision?.payload.kind === 'character'
      && item.operation.revision.payload.data.name === '角色')!;
    const dependency = session.operations.find((item) => item !== dependent)!;
    await expect(executeSharedAssetSync(session, commitExecution(), { itemId: dependent.mapping.id, direction })).rejects.toThrow('先同步依赖');
    expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
    await executeSharedAssetSync(session, commitExecution(), { itemId: dependency.mapping.id, direction });
    await executeSharedAssetSync(session, commitExecution(), { itemId: dependent.mapping.id, direction });
    expect(direction === 'upload' ? mocks.publish : mocks.download).toHaveBeenCalledTimes(2);
  });

  it.each((['upload', 'download'] as const).flatMap((direction) => (['success', 'failure', 'cancel'] as const)
    .map((outcome) => ({ direction, outcome }))))('整批$direction按真实目标依赖排序，$outcome时不先提交悬空引用', async ({ direction, outcome }) => {
    const controller = new AbortController();
    const source = character(); source.summary = '依赖 @drama{second:依赖角色}';
    const value = { ...context({ version: 2, characters: [source, { ...character(), id: 'second', name: '依赖角色' }], scenes: [], props: [] }), signal: controller.signal };
    let session = await buildSharedAssetSyncPreview(value);
    if (direction === 'download') {
      await executeSharedAssetSync(session, commitExecution());
      mocks.repo = { mappings: [], outbox: [], conflicts: [] }; mocks.indexes.clear();
      session = await buildSharedAssetSyncPreview({ ...context({ version: 2, characters: [], scenes: [], props: [] }), signal: controller.signal });
      session.operations.reverse(); mocks.publish.mockClear();
    }
    expect(session.operations[0].operation.revision?.payload).toMatchObject({ kind: 'character', data: { name: '角色' } });
    const order: string[] = []; const publish = mocks.publish.getMockImplementation()!;
    const execution = commitExecution(); const commit = execution.applyDownload.getMockImplementation()!;
    const beforeSideEffect = (name: string) => {
      order.push(name);
      if (name === '依赖角色' && outcome !== 'success') {
        if (outcome === 'cancel') controller.abort();
        throw new Error('共享依赖同步中断');
      }
    };
    if (direction === 'upload') mocks.publish.mockImplementation(async (input: { operationId: string }) => {
      const payload = prepared.get(input.operationId)!.revision.payload;
      beforeSideEffect(payload.kind === 'file' ? payload.name : payload.data.name);
      return publish(input);
    });
    else execution.applyDownload.mockImplementation(async (input: Parameters<SharedAssetSyncExecution['applyDownload']>[0]) => {
      const payload = input.commit.operation.revision!.payload;
      beforeSideEffect(payload.kind === 'file' ? payload.name : payload.data.name);
      return commit(input);
    });
    if (outcome === 'success') {
      await executeSharedAssetSync(session, execution); expect(order).toEqual(['依赖角色', '角色']);
    } else {
      await expect(executeSharedAssetSync(session, execution)).rejects.toThrow(); expect(order).toEqual(['依赖角色']);
      const dependent = mocks.repo.outbox.find((row) => row.revision?.payload.kind === 'character' && row.revision.payload.data.name === '角色')!;
      expect(dependent.phase).toBe(direction === 'upload' ? 'prepared' : 'planned');
      expect(dependent.errorCode).toBeUndefined();
    }
  });

  it('整批遇到互相依赖且目标端均不存在时保留原候选，不先发布任何一项', async () => {
    const value = context({ version: 2, characters: [{ ...character(), summary: '依赖 @drama{second:第二人}' },
      { ...character(), id: 'second', name: '第二人', summary: '依赖 @drama{local-character:角色}' }], scenes: [], props: [] });
    const session = await buildSharedAssetSyncPreview(value); const ids = session.operations.map((item) => item.operation.operationId);
    await executeSharedAssetSync(session, commitExecution());
    expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.repo.outbox.map((row) => row.operationId)).toEqual(ids);
    expect(mocks.repo.outbox.every((row) => row.phase === 'paused' && row.errorCode === 'dependency_missing')).toBe(true);
    expect(value.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'paused', completed: 0, total: 2 }));
  });

  it('目标卡片已存在但新参考图未上传时，整批先发布其新子项再发布引用方', async () => {
    const image: AssetIndexRecord = { assetId: 'image', path: '/project/owner/image.png', relativePath: 'image.png', rootPath: '/project/owner',
      projectId: 'owner', source: 'project', fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 };
    mocks.indexes.set(image.assetId, image); mocks.scan.mockResolvedValue({ files: [{ assetId: image.assetId, name: 'image.png', path: image.path,
      relativePath: image.relativePath, category: 'image', source: 'project', size: 10 }], complete: true });
    const dependency = { ...character(), id: 'second', name: '依赖角色' };
    const value = context({ version: 2, characters: [character(), dependency], scenes: [], props: [] });
    await executeSharedAssetSync(await buildSharedAssetSyncPreview(value), commitExecution());
    dependency.referenceImages = [{ id: 'new-reference', kind: 'primary', prompt: '', createdAt: 1, updatedAt: 2,
      assetId: image.assetId, imageUrl: 'asset://localhost/project/owner/image.png' }];
    value.library.characters[0].summary = '参考 @drama{second#new-reference:新参考图}';
    const session = await buildSharedAssetSyncPreview(value);
    const dependent = session.operations.find((item) => item.mapping.localEntityId === 'local-character')!;
    await expect(executeSharedAssetSync(session, commitExecution(), { itemId: dependent.mapping.id, direction: 'upload' })).rejects.toThrow('先同步依赖');
    const order: string[] = []; const publish = mocks.publish.getMockImplementation()!;
    mocks.publish.mockImplementation(async (input: { operationId: string }) => {
      const payload = prepared.get(input.operationId)!.revision.payload; if (payload.kind !== 'file') order.push(payload.data.name);
      return publish(input);
    });
    await executeSharedAssetSync(session, commitExecution()); expect(order).toEqual(['依赖角色', '角色']);
  });

  it.each(['paused', 'applied', 'completed'] as const)('删除标记阻止%s旧待办重新上传或恢复，已应用结果不倒退', async (phase) => {
    const initial = await buildSharedAssetSyncPreview(context());
    const operation = mocks.repo.outbox[0]; operation.phase = phase;
    if (phase !== 'paused') operation.errorCode = 'ack_pending';
    mocks.deleted = [{ sharedAssetId: operation.sharedAssetId, kind: 'character', revisionId: 'delete-revision',
      revisionDigest: 'e'.repeat(64), operationId: 'delete-operation', updatedAt: 10, deleted: true }];
    const untouchedLibrary = structuredClone(initial.expectedLibrary);
    mocks.prepare.mockClear(); mocks.recover.mockClear();
    const preview = await buildSharedAssetSyncPreview(context());
    expect(preview.operations).toHaveLength(0);
    expect(preview.items).toMatchObject([{ direction: 'conflict', message: expect.stringContaining('云端资产已删除') }]);
    expect(mocks.repo.outbox[0]).toMatchObject({ operationId: operation.operationId,
      phase: phase === 'paused' ? 'conflict' : 'completed', errorCode: 'remote_deleted' });
    expect(mocks.repo.conflicts).toMatchObject([{ reason: 'remoteDeleted', remoteRevisionId: 'delete-revision' }]);
    await buildSharedAssetSyncPreview(context());
    expect(mocks.repo.conflicts).toHaveLength(1);
    expect(preview.expectedLibrary).toEqual(untouchedLibrary);
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.recover).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('已应用资产被云端删除后，用保留原token释放租约；双ACK失败保持待确认，后续不重放', async () => {
    const session = await buildSharedAssetSyncPreview(context()); const publish = mocks.publish.getMockImplementation()!;
    let activeToken: string | undefined, issuedToken = ''; let failures = 4;
    mocks.publish.mockImplementation(async (...args: unknown[]) => {
      const result = await publish(...args); activeToken = result.applyToken; issuedToken = result.applyToken; return result;
    });
    mocks.acknowledge.mockImplementation(async (input: { applyToken?: string }) => {
      expect(input.applyToken).toBe(activeToken);
      if (failures-- > 0) throw new Error('共享回执响应丢失');
      activeToken = undefined;
    });
    await expect(executeSharedAssetSync(session, commitExecution())).rejects.toThrow();
    const original = structuredClone(mocks.repo.outbox[0]); expect(original.errorCode).toBe('ack_pending');
    mocks.deleted = [{ ...mocks.cloud[0].head, deleted: true }]; mocks.cloud = []; mocks.recover.mockClear();
    const stillPending = await buildSharedAssetSyncPreview(context());
    expect(mocks.repo.outbox[0]).toEqual(original); expect(activeToken).toBe(issuedToken);
    expect(stillPending.items[0].message).toContain('回执尚未释放');
    const released = await buildSharedAssetSyncPreview(context());
    expect(activeToken).toBeUndefined(); expect(mocks.repo.outbox[0]).toMatchObject({ phase: 'completed', errorCode: 'remote_deleted' });
    expect(released.items[0].message).toContain('旧同步不会重新上传');
    expect(mocks.publish).toHaveBeenCalledTimes(1); expect(mocks.recover).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.repo)).not.toContain(issuedToken);
  });

  it('无变更行仍可按本轮head预览并CAS删除云端，本机卡片与索引不删除', async () => {
    const value = context(); await executeSharedAssetSync(await buildSharedAssetSyncPreview(value), commitExecution());
    const session = await buildSharedAssetSyncPreview(value);
    expect(session.items).toMatchObject([{ direction: 'unchanged', canDelete: true }]);
    const head = session.remoteAssets[0]; const local = structuredClone(value.library);
    await projectAssetSyncService.deleteAsset(session, session.items[0].id);
    expect(mocks.previewDelete).toHaveBeenCalledWith(expect.objectContaining({ sharedAssetId: head.head.sharedAssetId,
      expectedRevisionId: head.head.revisionId, expectedETag: head.etag }));
    expect(mocks.applyDelete).toHaveBeenCalledWith(expect.objectContaining({ sharedAssetId: head.head.sharedAssetId, previewToken: 'delete-preview' }));
    expect(value.library).toEqual(local); expect(mocks.cloud).toEqual([]); expect(mocks.deleted).toHaveLength(1);
    expect(session.invalidated).toBe(true);
  });

  it('删除预览等待中head变化或会话取消时，不提交旧令牌', async () => {
    await executeSharedAssetSync(await buildSharedAssetSyncPreview(context()), commitExecution());
    for (const cancelled of [false, true]) {
      const controller = new AbortController();
      const session = await buildSharedAssetSyncPreview({ ...context(), signal: controller.signal });
      mocks.previewDelete.mockImplementationOnce(async (input: SharedSyncAssetDeletePreviewInput) => {
        if (cancelled) controller.abort(); else session.remoteAssets[0].etag = 'new-etag';
        return { sharedAssetId: input.sharedAssetId, revisionId: input.expectedRevisionId, operationId: input.operationId, previewToken: 'old-preview' };
      });
      await expect(projectAssetSyncService.deleteAsset(session, session.items[0].id)).rejects.toThrow();
    }
    expect(mocks.applyDelete).not.toHaveBeenCalled(); expect(mocks.cloud).toHaveLength(1);
  });

  it('删除武器后只阻塞引用它的角色，其他云端行仍可预览处理', async () => {
    const role = { ...character(), weaponIds: ['weapon'] };
    const value = context({ version: 2, characters: [role], scenes: [], props: [{ id: 'weapon', kind: 'prop', propType: 'weapon',
      name: '长剑', key: '长剑', summary: '', visualNotes: '', importance: 'main', confirmed: true, source: 'manual', createdAt: 1, updatedAt: 2 }] });
    await executeSharedAssetSync(await buildSharedAssetSyncPreview(value), commitExecution());
    const before = await buildSharedAssetSyncPreview(value);
    await projectAssetSyncService.deleteAsset(before, before.items.find((item) => item.kind === 'prop')!.id);
    const after = await buildSharedAssetSyncPreview(value);
    expect(after.operations).toHaveLength(0);
    expect(after.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'character', direction: 'blocked', canDelete: true, message: expect.stringContaining('武器依赖缺失') }),
      expect.objectContaining({ kind: 'prop', direction: 'conflict', message: expect.stringContaining('云端资产已删除') }),
    ]));
    expect(value.library.characters[0].weaponIds).toEqual(['weapon']); expect(value.library.props).toHaveLength(1);
    value.library.characters[0].weaponIds = [];
    const repaired = await buildSharedAssetSyncPreview(value);
    const row = repaired.items.find((item) => item.kind === 'character')!;
    expect(row.direction).toBe('upload');
    const execution = commitExecution();
    await executeSharedAssetSync(repaired, execution, { itemId: row.id, direction: 'upload' });
    const published = mocks.cloud.find((asset) => asset.head.kind === 'character')!.revision.payload;
    expect(published).toMatchObject({ kind: 'character', data: { weaponIds: [] } });
    expect(mocks.deleted).toHaveLength(1); expect(value.library.props).toHaveLength(1);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it.each(['remoteOnly', 'unchangedLocal', 'bothChanged'] as const)('远端缺失武器依赖时%s仍不采用不完整云版本或自动覆盖双方变更', async (mode) => {
    const value = context({ version: 2, characters: [{ ...character(), weaponIds: ['weapon'] }], scenes: [], props: [{ id: 'weapon',
      kind: 'prop', propType: 'weapon', name: '长剑', key: '长剑', summary: '', visualNotes: '', importance: 'main', confirmed: true,
      source: 'manual', createdAt: 1, updatedAt: 2 }] });
    await executeSharedAssetSync(await buildSharedAssetSyncPreview(value), commitExecution());
    const before = await buildSharedAssetSyncPreview(value);
    await projectAssetSyncService.deleteAsset(before, before.items.find((item) => item.kind === 'prop')!.id);
    const remote = mocks.cloud.find((asset) => asset.head.kind === 'character')!;
    remote.revision.revisionId = 'changed-remote'; remote.head.revisionId = 'changed-remote'; remote.etag = 'changed-etag';
    if (remote.revision.payload.kind === 'character') remote.revision.payload.data.summary = '云端新简介';
    if (mode === 'bothChanged') value.library.characters[0].weaponIds = [];
    if (mode === 'remoteOnly') mocks.repo = { mappings: [], outbox: [], conflicts: [] };
    mocks.publish.mockClear(); mocks.download.mockClear();
    const preview = await buildSharedAssetSyncPreview(mode === 'remoteOnly' ? context({ version: 2, characters: [], scenes: [], props: [] }) : value);
    expect(preview.items.find((item) => item.kind === 'character')).toMatchObject({ direction: mode === 'bothChanged' ? 'conflict' : 'blocked' });
    expect(preview.operations.some((item) => item.mapping.kind === 'character')).toBe(false);
    expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
    if (mode === 'bothChanged') expect(mocks.repo.conflicts.some((row) => row.reason === 'bothChanged')).toBe(true);
  });

  it('修复本机依赖时仅在原生确认旧准备候选未发出后退役，再创建当前候选', async () => {
    const { value, old } = await blockedWeaponCandidate();
    const preview = await buildSharedAssetSyncPreview(value);
    expect(mocks.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ operationId: old.operationId, applied: false }));
    expect(mocks.acknowledge.mock.calls[0][0]).not.toHaveProperty('applyToken');
    expect(mocks.repo.outbox.find((row) => row.operationId === old.operationId)?.phase).toBe('completed');
    const replacement = preview.operations.find((item) => item.mapping.kind === 'character')!;
    expect(replacement.operation.operationId).not.toBe(old.operationId); expect(replacement.operation.revisionId).not.toBe(old.revisionId);
    expect(replacement.operation.revision?.payload).toMatchObject({ kind: 'character', data: { weaponIds: [] } });
    await executeSharedAssetSync(preview, commitExecution(), { itemId: replacement.mapping.id, direction: 'upload' });
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ operationId: replacement.operation.operationId }));
  });

  it.each(['conflict', 'operation_not_found'] as const)('原生以%s拒绝退役时保留原候选，不用重试状态推断未写云端', async (code) => {
    const { value, old } = await blockedWeaponCandidate();
    mocks.acknowledge.mockRejectedValueOnce(new Error('共享旧候选尚不能安全清理，请恢复核对', { cause: { code } }));
    const preview = await buildSharedAssetSyncPreview(value);
    expect(mocks.repo.outbox.find((row) => row.operationId === old.operationId)).toEqual(old);
    expect(preview.operations).toHaveLength(0); expect(preview.items.find((item) => item.kind === 'character')?.direction).toBe('blocked');
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.recover).not.toHaveBeenCalled();
  });

  it('依赖缺失不覆盖未知提交标记，也不退役可能已写云端的候选', async () => {
    const { value, old } = await blockedWeaponCandidate();
    const operation = mocks.repo.outbox.find((row) => row.operationId === old.operationId)!;
    operation.phase = 'checkingCommit'; operation.errorCode = 'unknown_commit';
    const expected = structuredClone(operation);
    const preview = await buildSharedAssetSyncPreview(value);
    expect(mocks.repo.outbox.find((row) => row.operationId === old.operationId)).toEqual(expected);
    expect(preview.operations).toHaveLength(0);
    expect(preview.items.find((item) => item.kind === 'character')).toMatchObject({ direction: 'blocked', message: expect.stringContaining('提交结果尚未确认') });
    expect(mocks.acknowledge).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('执行失败不回显不安全显示名或原始异常URL，但保留白名单诊断阶段', async () => {
    const session = await buildSharedAssetSyncPreview(context()); session.items[0].name = 'D:/private/project.png';
    mocks.recover.mockRejectedValueOnce(new Error('https://secret.example.com/private-token', { cause: { code: 'network', stage: 'headRead', unsafe: 'private-token' } }));
    const failure = await executeSharedAssetSync(session, commitExecution()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: '上传「项目资产」失败：共享资产操作未完成，请重新预览或恢复', cause: { code: 'network', stage: 'headRead' } });
    expect(JSON.stringify(failure)).not.toContain('private-token'); expect(String(failure)).not.toContain('D:/private');
  });

  it.each(['windows', 'unix'] as const)('真实 URL 桥接在 %s 完成图声动作、场景与道具的发件到接收', async (platform) => {
    const bridge = await publishCardsThroughNativeBridge(platform);
    const receiver = context({ version: 2, characters: [], scenes: [], props: [] });
    const session = await buildSharedAssetSyncPreview(receiver);
    expect(session.items).toHaveLength(3);
    expect(session.items.every((item) => item.direction === 'download')).toBe(true);
    let persistedLibrary = receiver.library;
    const execution = commitExecution((library) => { persistedLibrary = library; });
    await executeSharedAssetSync(session, execution);
    const role = persistedLibrary.characters[0];
    expect(role).toMatchObject({ name: '角色', referenceImages: [{ prompt: '主图提示词' }], voiceClips: [{ transcript: '声音文本' }],
      actions: [{ name: '行走', prompt: '动作提示词', media: [{ kind: 'gif' }, { kind: 'video' }] }] });
    expect(role.primaryReferenceImageId).toBe(role.referenceImages![0].id);
    expect(role.avatarReferenceImageId).toBe(role.referenceImages![0].id);
    expect(role.primaryVoiceClipId).toBe(role.voiceClips![0].id);
    expect(role.imageNodeId).toBeUndefined(); expect(role.referenceImages![0].sourceNodeId).toBeUndefined();
    expect(persistedLibrary.scenes).toMatchObject([{ name: '场景', referenceImages: [{ label: '场景图' }] }]);
    expect(persistedLibrary.props).toMatchObject([{ name: '道具', referenceImages: [{ label: '道具图' }] }]);
    const bound = [{ assetId: role.assetId, relativePath: role.relativePath, url: role.imageUrl },
      ...role.referenceImages!.map((item) => ({ ...item, url: item.imageUrl })),
      ...role.voiceClips!.map((item) => ({ ...item, url: item.audioUrl })), ...role.actions![0].media!,
      ...[...persistedLibrary.scenes, ...persistedLibrary.props].flatMap((item) => [{ ...item, url: item.imageUrl },
        ...item.referenceImages!.map((reference) => ({ ...reference, url: reference.imageUrl }))])];
    for (const media of bound) {
      const index = mocks.indexes.get(media.assetId!)!;
      expect(index).toBeDefined(); expect(index.projectId).toBe('owner');
      expect(media.relativePath).toBe(index.relativePath);
      expect(media.url).toBe(platformAssetUrl(platform, index.path));
      expect(localMediaUrlToPath(media.url)).toBe(index.path);
      expect(bridge.convert).toHaveBeenCalledWith(index.path, 'asset');
    }
    expect(mocks.download).toHaveBeenCalledTimes(3); expect(execution.applyDownload).toHaveBeenCalledTimes(3);
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
    expect(receiver.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'completed', completed: 3, total: 3 }));
    await executeSharedAssetSync(session, execution);
    expect(mocks.download).toHaveBeenCalledTimes(3);
  });

  it.each(['rawPath', 'remoteUrl'] as const)('原生 URL 桥接错误返回 %s 时拒绝恢复，不提交本机卡片或索引', async (output) => {
    const bridge = await publishCardsThroughNativeBridge('windows');
    mocks.cloud = mocks.cloud.filter((asset) => asset.head.kind === 'character');
    bridge.convert.mockImplementation((path) => output === 'rawPath' ? path : 'https://example.com/shared.png');
    const receiver = context({ version: 2, characters: [], scenes: [], props: [] });
    const session = await buildSharedAssetSyncPreview(receiver); const execution = commitExecution();
    const failure = await executeSharedAssetSync(session, execution).then(() => { throw new Error('预期拒绝无效地址'); }, (error: unknown) => error);
    expect(failure).toMatchObject({ message: expect.stringContaining('下载「角色」失败：项目共享资产格式无效'),
      cause: { reason: 'invalidLocalMediaUrl', fieldPath: 'payload.data.imageUrl', stage: 'restoreMedia' } });
    expect(String(failure)).not.toContain('https://example.com');
    expect(execution.applyDownload).not.toHaveBeenCalled(); expect(mocks.indexes.size).toBe(0);
    expect(session.expectedLibrary).toBe(receiver.library); expect(receiver.library.characters).toEqual([]);
    expect(mocks.repo.mappings[0].acceptedRevisionId).toBeUndefined();
    expect(mocks.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ applied: false }));
  });

  it('恢复预览仅读取原版本并释放本机令牌，不自动执行', async () => {
    const initial = await buildSharedAssetSyncPreview(context());
    await executeSharedAssetSync(initial, commitExecution());
    const operation = mocks.repo.outbox[0];
    operation.phase = 'paused'; operation.revision = undefined; operation.revisionDigest = undefined;
    mocks.acknowledge.mockClear(); mocks.publish.mockClear();
    const resumed = await buildSharedAssetSyncPreview(context());
    expect(resumed.operations.map((item) => item.operation.operationId)).toEqual([operation.operationId]);
    expect(mocks.acknowledge).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: operation.operationId, applied: false }));
    expect(mocks.acknowledge.mock.calls[0][0]).not.toHaveProperty('releaseProjectLock');
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('预览持久化固定操作再准备原字节，用户执行前不上传，空数据可完成', async () => {
    const session = await buildSharedAssetSyncPreview(context());
    expect(session.items).toMatchObject([{ kind: 'character', direction: 'upload' }]);
    expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(mocks.publish).not.toHaveBeenCalled();
    expect(session.operations[0].operation.revisionId).toBe(mocks.repo.outbox[0].revisionId);
    const empty = context({ version: 2, characters: [], scenes: [], props: [] });
    mocks.repo = { mappings: [], outbox: [], conflicts: [] };
    await buildSharedAssetSyncPreview(empty);
    expect(empty.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'completed', total: 0 }));
  });

  it('完整扫描失败不把部分项目文件当完整同步成功', async () => {
    mocks.scan.mockResolvedValue({ files: [], complete: false, truncated: true, failedDirectories: 0, failedFiles: 0 });
    await expect(buildSharedAssetSyncPreview(context())).rejects.toThrow('读取不完整');
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('Windows 接收端可应用人物本地素材地址，完成后不重复下载或上传', async () => {
    const asset = remoteFile();
    asset.head.kind = 'character';
    asset.revision.payload = { kind: 'character', data: { ...character(), id: asset.head.sharedAssetId,
      imageUrl: 'aicsync-media:image' } };
    mocks.cloud = [asset];
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}` } });
    const receiver = context({ version: 2, characters: [], scenes: [], props: [] });
    const session = await buildSharedAssetSyncPreview(receiver);
    expect(session.items).toMatchObject([{ kind: 'character', direction: 'download' }]);
    const execution = commitExecution();
    await executeSharedAssetSync(session, execution);
    const input = execution.applyDownload.mock.calls[0][0] as Parameters<SharedAssetSyncExecution['applyDownload']>[0];
    expect(input.nextLibrary?.characters).toMatchObject([{ id: session.mappings[0].localEntityId,
      imageUrl: `http://asset.localhost/${encodeURIComponent('/project/owner/.shared-sync/files/remote-file/remote-revision/image.png')}` }]);
    expect(input.commit.indexes).toHaveLength(1);
    expect(receiver.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'completed', completed: 1, total: 1 }));
    await executeSharedAssetSync(session, execution);
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(execution.applyDownload).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('缺失或全局媒体只阻塞对应资产，不按名字或URL补造依赖', async () => {
    const value = context(); value.library.characters[0].imageUrl = 'https://private.example.com/image.png';
    const session = await buildSharedAssetSyncPreview(value);
    expect(session.items).toMatchObject([{ direction: 'blocked' }]); expect(session.operations).toHaveLength(0);
    expect(session).toMatchObject({ completed: 0, total: 0 });
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
    expect(value.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'paused' }));
  });

  it('项目人物参考图/动作和文件专属提示词中的合法节点统一转共享库引用，不扩大媒体闭包', async () => {
    const index: AssetIndexRecord = { assetId: 'project-image', path: '/project/owner/image.png', relativePath: 'image.png',
      rootPath: '/project/owner', projectId: 'owner', source: 'project', fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 };
    mocks.indexes.set(index.assetId, index);
    mocks.scan.mockResolvedValue({ files: [{ assetId: index.assetId, name: 'image.png', path: index.path, relativePath: index.relativePath,
      category: 'image', source: 'project', size: 10 }], complete: true });
    const value = context(); const source = value.library.characters[0]; const imageUrl = `asset://localhost${index.path}`;
    source.assetId = index.assetId; source.imageUrl = imageUrl;
    source.referenceImages = [{ id: 'reference', kind: 'primary', assetId: index.assetId, imageUrl, sourceNodeId: 'project-node',
      prompt: '参考 @{project-node:项目图片}，保持原造型', createdAt: 1, updatedAt: 1 }];
    source.primaryReferenceImageId = 'reference';
    source.actions = [{ id: 'walk', category: 'walking', name: '行走', prompt: '让 @{project-node:项目图片} 向前走', media: [], createdAt: 1, updatedAt: 1 }];
    value.nodes = [{ id: 'project-node', type: 'source-image', position: { x: 0, y: 0 }, data: {
      label: '项目图片', type: 'source-image', status: 'success', prompt: '', role: 'source', imageUrl, filePath: index.path, assetId: index.assetId,
    } }];
    const record: AssetImageRecord = { id: 'asset-image:project-image:digest', assetId: index.assetId, contentDigest: 'a'.repeat(64),
      fileName: 'image.png', prompt: '以 @{project-node:项目图片} 为参考', references: [], revision: 1, updatedAt: 1 };
    mocks.imageRecords = [record]; mocks.image.mockResolvedValue({ record, references: [] });
    const session = await projectAssetSyncService.preview(value);
    expect(session.items.some((item) => item.direction === 'blocked')).toBe(false);
    const mapping = session.mappings.find((entry) => entry.kind === 'character')!;
    const referenceId = mapping.members.find((entry) => entry.kind === 'referenceImage' && entry.localId === 'reference')!.sharedId;
    const wireMention = `@drama{${mapping.sharedAssetId}#${referenceId}:角色}`;
    const preparedInputs = mocks.prepare.mock.calls.map(([input]) => input as SharedSyncPrepareInput);
    const card = preparedInputs.find((input) => input.draft.payload.kind === 'character')!.draft.payload;
    const file = preparedInputs.find((input) => input.draft.payload.kind === 'file')!.draft.payload;
    if (card.kind === 'file' || card.data.kind !== 'character' || file.kind !== 'file') throw new Error('缺少项目共享预览');
    expect(card.data.referenceImages![0].prompt).toBe(`参考 ${wireMention}，保持原造型`);
    expect(card.data.actions![0].prompt).toBe(`让 ${wireMention} 向前走`);
    expect(file.imageMetadata?.prompt).toBe(`以 ${wireMention} 为参考`);
    expect(preparedInputs.every((input) => input.sources.length === 1 && input.sources[0].filePath === index.path)).toBe(true);
    expect(source.referenceImages[0].prompt).toBe('参考 @{project-node:项目图片}，保持原造型');
    expect(record.prompt).toBe('以 @{project-node:项目图片} 为参考');
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('规范业务摘要忽略封套、属性顺序及创建/修改时间，保留媒体内容与参考顺序', async () => {
    const session = await buildSharedAssetSyncPreview(context()); const first = session.operations[0].operation.revision!;
    const second = structuredClone(first); second.createdAt = 999; second.operationId = 'other-operation';
    second.revisionId = 'other-revision';
    if (second.payload.kind !== 'file') second.payload.data.updatedAt = 999;
    expect(await sharedAssetSyncContentDigest(first)).toBe(await sharedAssetSyncContentDigest(second));
    if (second.payload.kind !== 'file') second.payload.data.summary = '实际修改';
    expect(await sharedAssetSyncContentDigest(first)).not.toBe(await sharedAssetSyncContentDigest(second));
  });

  it('未修改版本清理prepared暂存，不新增远端版本，全部未变显示完成', async () => {
    await executeSharedAssetSync(await buildSharedAssetSyncPreview(context()), commitExecution());
    const next = context(); const session = await buildSharedAssetSyncPreview(next);
    expect(session.items).toMatchObject([{ direction: 'unchanged' }]); expect(session.operations).toHaveLength(0);
    expect(session).toMatchObject({ completed: 1, total: 1 });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ applied: false }));
    expect(next.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'completed', completed: 1, total: 1 }));
  });

  it('重启后保留四张已核对图片的4/5进度，只发布原未完成版本并累计到5/5', async () => {
    const files = Array.from({ length: 5 }, (_, offset) => {
      const name = `image-${offset + 1}.png`;
      const index: AssetIndexRecord = { assetId: `file-${offset + 1}`, path: `/project/owner/${name}`,
        rootPath: '/project/owner', relativePath: name, projectId: 'owner', source: 'project',
        fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 };
      mocks.indexes.set(index.assetId, index);
      return { assetId: index.assetId, path: index.path, name, relativePath: name,
        size: 10, category: 'image' as const, source: 'project' as const };
    });
    mocks.scan.mockResolvedValue({ files, folders: [], complete: true, truncated: false, failedDirectories: 0, failedFiles: 0 });
    const emptyLibrary = (): DramaAssetLibrary => ({ version: 2, characters: [], scenes: [], props: [] });
    const initial = await buildSharedAssetSyncPreview(context(emptyLibrary()));
    expect(initial.operations).toHaveLength(5);
    const unfinished = initial.operations[4].operation;
    const recover = mocks.recover.getMockImplementation()!;
    mocks.recover.mockImplementation(async (request: { operationId: string; sharedAssetId: string; revisionId: string }) => {
      if (request.operationId === unfinished.operationId) throw new Error('模拟应用退出前中断');
      return recover(request);
    });
    await expect(executeSharedAssetSync(initial, commitExecution())).rejects.toThrow('上传「image-5.png」失败');
    expect(initial).toMatchObject({ completed: 4, total: 5 });
    expect(mocks.cloud).toHaveLength(4);
    expect(mocks.repo.outbox.filter((entry) => entry.phase === 'completed' && !entry.errorCode)).toHaveLength(4);
    expect(mocks.repo.outbox.find((entry) => entry.operationId === unfinished.operationId)).toMatchObject({
      revisionId: unfinished.revisionId, phase: 'paused',
    });

    // Recreate the JS session from persisted records; the native prepared journal remains available.
    mocks.repo = structuredClone(mocks.repo);
    mocks.recover.mockImplementation(recover);
    mocks.recover.mockClear(); mocks.prepare.mockClear(); mocks.publish.mockClear();
    const next = context(emptyLibrary());
    const resumed = await buildSharedAssetSyncPreview(next);
    const scanning = vi.mocked(next.onStatus).mock.calls[0][0];
    expect(scanning).toMatchObject({ stage: 'scanning' });
    expect(scanning).not.toHaveProperty('completed');
    expect(scanning).not.toHaveProperty('total');
    expect(resumed).toMatchObject({ completed: 4, total: 5 });
    expect(resumed.items.filter((entry) => entry.direction === 'unchanged')).toHaveLength(4);
    expect(resumed.operations).toHaveLength(1);
    expect(resumed.operations[0].operation).toMatchObject({ operationId: unfinished.operationId, revisionId: unfinished.revisionId });
    const identities = (mappings: SharedAssetSyncLocalState['mappings']) => mappings
      .map(({ localEntityId, sharedAssetId }) => ({ localEntityId, sharedAssetId }))
      .sort((a, b) => a.localEntityId.localeCompare(b.localEntityId));
    expect(identities(resumed.mappings)).toEqual(identities(initial.mappings));
    expect(mocks.prepare).toHaveBeenCalledTimes(4); // Unchanged files are still prepared and content-verified.
    expect(mocks.prepare.mock.calls.every(([input]) => (input as SharedSyncPrepareInput).draft.operationId !== unfinished.operationId)).toBe(true);
    expect(next.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'preview', completed: 4, total: 5 }));
    expect(mocks.publish).not.toHaveBeenCalled();

    await executeSharedAssetSync(resumed, commitExecution());
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: unfinished.operationId, revisionId: unfinished.revisionId }));
    expect(mocks.cloud).toHaveLength(5);
    expect(next.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'paused', completed: 5, total: 5 }));
    const verified = context(emptyLibrary());
    const final = await buildSharedAssetSyncPreview(verified);
    expect(final.operations).toHaveLength(0);
    expect(final).toMatchObject({ completed: 5, total: 5 });
    expect(verified.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'completed', completed: 5, total: 5 }));
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it('本地和远端同时修改保留候选并报告冲突，不自动覆盖', async () => {
    await executeSharedAssetSync(await buildSharedAssetSyncPreview(context()), commitExecution());
    const remote = structuredClone(mocks.cloud[0]);
    remote.head.revisionId = 'remote-new'; remote.revision.revisionId = 'remote-new';
    if (remote.revision.payload.kind !== 'file') remote.revision.payload.data.summary = '云端修改';
    mocks.cloud = [remote]; const next = context(); next.library.characters[0].summary = '本地修改';
    const session = await buildSharedAssetSyncPreview(next);
    expect(session.items).toMatchObject([{ direction: 'conflict' }]); expect(session.operations).toHaveLength(0);
    expect(session).toMatchObject({ completed: 0, total: 0 });
    expect(mocks.repo.conflicts).toMatchObject([{ reason: 'bothChanged' }]);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it('提交后上传ack失败只恢复ack，不重新发布或重复接受基线', async () => {
    const session = await buildSharedAssetSyncPreview(context()); const execution = commitExecution(); let fail = true;
    mocks.acknowledge.mockImplementation(async (input: { applied: boolean }) => { if (input.applied && fail) { fail = false; throw new Error('网络失败'); } });
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('上传「角色」失败');
    expect(mocks.repo.outbox[0]).toMatchObject({ phase: 'completed', errorCode: 'ack_pending' });
    const firstAck = mocks.acknowledge.mock.calls[0][0] as { operationId: string; applyToken: string };
    expect(mocks.acknowledge).toHaveBeenNthCalledWith(2, expect.objectContaining({ applied: false,
      operationId: firstAck.operationId, applyToken: firstAck.applyToken }));
    expect(mocks.acknowledge.mock.calls[1][0]).not.toHaveProperty('releaseProjectLock');
    await executeSharedAssetSync(session, execution);
    expect(mocks.publish).toHaveBeenCalledTimes(1); expect(execution.applyDownload).toHaveBeenCalledTimes(1);
    expect(mocks.repo.outbox[0].errorCode).toBeUndefined();
  });

  it('本地提交和仅回执恢复连续失败均释放同一租约，两次恢复不重复publish或commit', async () => {
    const session = await buildSharedAssetSyncPreview(context()); const execution = commitExecution();
    const operationId = session.operations[0].operation.operationId; const revisionId = session.operations[0].operation.revisionId;
    const publish = mocks.publish.getMockImplementation()!; const recover = mocks.recover.getMockImplementation()!;
    let activeToken: string | undefined; let failures = 2;
    mocks.publish.mockImplementation(async (...args: unknown[]) => {
      const result = await publish(...args); activeToken = result.applyToken; return result;
    });
    mocks.recover.mockImplementation(async (...args: unknown[]) => {
      if (activeToken) throw new Error('该项目仍有未释放的应用租约');
      const result = await recover(...args); activeToken = result.applyToken; return result;
    });
    mocks.acknowledge.mockImplementation(async (input: { applied: boolean; applyToken?: string }) => {
      if (!activeToken || input.applyToken !== activeToken) throw new Error('应用租约不匹配');
      if (input.applied && failures-- > 0) throw new Error('回执响应丢失');
      activeToken = undefined;
    });
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('上传「角色」失败');
    expect(activeToken).toBeUndefined();
    const firstRecovery = await buildSharedAssetSyncPreview(context());
    await expect(executeSharedAssetSync(firstRecovery, execution)).rejects.toThrow('上传「角色」失败');
    expect(activeToken).toBeUndefined();
    const secondRecovery = await buildSharedAssetSyncPreview(context());
    await executeSharedAssetSync(secondRecovery, execution);
    expect(mocks.repo.outbox).toHaveLength(1);
    expect(mocks.repo.outbox[0]).toMatchObject({ operationId, revisionId, phase: 'completed' });
    expect(mocks.repo.outbox[0].errorCode).toBeUndefined();
    expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(execution.applyDownload).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledge.mock.calls.filter(([input]) => input.applied === false)).toHaveLength(2);
  });

  it('ack已在原生成功但响应丢失时，释放失败不覆盖原错误或清掉回执待确认状态', async () => {
    const session = await buildSharedAssetSyncPreview(context()); const execution = commitExecution(); let lostResponse = true;
    mocks.acknowledge.mockImplementation(async (input: { applied: boolean }) => {
      if (!input.applied) throw new Error('原生已清除此租约');
      if (lostResponse) { lostResponse = false; throw new Error('回执响应丢失'); }
    });
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('上传「角色」失败');
    expect(mocks.repo.outbox[0]).toMatchObject({ phase: 'completed', errorCode: 'ack_pending' });
    const resumed = await buildSharedAssetSyncPreview(context()); await executeSharedAssetSync(resumed, execution);
    expect(execution.applyDownload).toHaveBeenCalledTimes(1); expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.repo.outbox[0].errorCode).toBeUndefined();
  });

  it('publish结果不确定后，两轮恢复只核对原operation和revision，不创建新版本或盲重投', async () => {
    const session = await buildSharedAssetSyncPreview(context()); const execution = commitExecution();
    const operationId = session.operations[0].operation.operationId; const revisionId = session.operations[0].operation.revisionId;
    mocks.publish.mockResolvedValue({ status: 'uncertain' });
    mocks.recover.mockImplementation(async (input: { operationId: string }) => ({
      status: mocks.publish.mock.calls.length ? 'uncertain' : 'retryable', prepared: prepared.get(input.operationId),
    }));
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('版本提交结果尚未确认');
    for (let round = 0; round < 2; round++) {
      const value = context(); value.library.characters[0].summary = `后续本地编辑${round}`;
      const resumed = await buildSharedAssetSyncPreview(value);
      expect(resumed.operations[0].operation).toMatchObject({ operationId, revisionId, phase: 'checkingCommit', errorCode: 'unknown_commit' });
      await expect(executeSharedAssetSync(resumed, execution)).rejects.toThrow('版本提交结果尚未确认');
    }
    expect(mocks.repo.outbox).toHaveLength(1);
    expect(mocks.repo.outbox[0]).toMatchObject({ operationId, revisionId, phase: 'checkingCommit', errorCode: 'unknown_commit' });
    expect(mocks.repo.conflicts).toHaveLength(0); expect(execution.applyDownload).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.recover.mock.calls.every(([input]) => input.operationId === operationId && input.revisionId === revisionId)).toBe(true);
  });

  it('恢复返回uncertain与prepared时不把prepared当作可发布，旧unknownCommit冲突只恢复原身份', async () => {
    const initial = await buildSharedAssetSyncPreview(context());
    const operation = mocks.repo.outbox[0];
    mocks.repo.conflicts = [{ ...operation, id: 'legacy-conflict', reason: 'unknownCommit', createdAt: 1 }];
    operation.phase = 'conflict'; delete operation.revision; delete operation.revisionDigest;
    mocks.recover.mockImplementation(async (input: { operationId: string }) => ({ status: 'uncertain', prepared: prepared.get(input.operationId) }));
    const resumed = await buildSharedAssetSyncPreview(context());
    expect(resumed.operations[0].operation).toMatchObject({ operationId: operation.operationId, revisionId: operation.revisionId,
      phase: 'checkingCommit', errorCode: 'unknown_commit' });
    await expect(executeSharedAssetSync(resumed, commitExecution())).rejects.toThrow('版本提交结果尚未确认');
    expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.repo.outbox).toHaveLength(1);
    expect(mocks.repo.outbox[0].operationId).toBe(initial.operations[0].operation.operationId);
  });

  it('真正的原生conflict仍记录冲突，不能误当作未知提交重投', async () => {
    const session = await buildSharedAssetSyncPreview(context());
    mocks.recover.mockResolvedValue({ status: 'conflict', lockRetained: false }); const execution = commitExecution();
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('并发修改');
    expect(mocks.repo.outbox[0].phase).toBe('conflict'); expect(mocks.repo.conflicts[0].reason).toBe('headChanged');
    expect(mocks.publish).not.toHaveBeenCalled(); expect(execution.applyDownload).not.toHaveBeenCalled();
  });

  it('原生准备成功但JS阶段未写回时恢复同一operation与revision，不另造候选', async () => {
    const initial = await buildSharedAssetSyncPreview(context());
    const operationId = initial.operations[0].operation.operationId;
    const revisionId = initial.operations[0].operation.revisionId;
    delete mocks.repo.outbox[0].revision; delete mocks.repo.outbox[0].revisionDigest; mocks.repo.outbox[0].phase = 'preparing';
    const resumed = await buildSharedAssetSyncPreview(context());
    expect(resumed.operations[0].operation).toMatchObject({ operationId, revisionId, phase: 'prepared' });
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    await executeSharedAssetSync(resumed, commitExecution());
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ operationId, revisionId }));
  });

  it('已下载卡片媒体仅供闭包重新同步，不重新创建普通文件资产', async () => {
    const initial = await buildSharedAssetSyncPreview(context()); const mapping = structuredClone(initial.mappings[0]);
    const index: AssetIndexRecord = { assetId: 'downloaded-image', path: '/project/owner/.shared-sync/files/card/revision/image.png',
      relativePath: '.shared-sync/files/card/revision/image.png', projectId: 'owner', source: 'project', status: 'online',
      rootPath: '/project/owner', fingerprint: '10:10', size: 10, mtimeMs: 10, updatedAt: 1 };
    mapping.media = [{ sharedMediaId: 'stable-media', localAssetId: index.assetId, projectId: 'owner',
      relativePath: index.relativePath!, bytes: 10, sha256: 'a'.repeat(64) }];
    mocks.repo = { mappings: [mapping], outbox: [], conflicts: [] }; mocks.indexes.set(index.assetId, index);
    const next = context(); next.library.characters[0].assetId = index.assetId;
    next.library.characters[0].imageUrl = `asset://localhost${index.path}`;
    const resumed = await buildSharedAssetSyncPreview(next);
    expect(resumed.mappings.filter((entry) => entry.kind === 'file')).toHaveLength(0);
    const preparedInput = mocks.prepare.mock.calls.at(-1)![0] as SharedSyncPrepareInput;
    expect(preparedInput.sources).toEqual([{ mediaId: 'stable-media', filePath: index.path }]);
    expect(preparedInput.draft.media).toMatchObject([{ id: 'stable-media', kind: 'image' }]);
  });

  it('分集媒体先复制到owner固定输入目录，nativeprepare不接收分集或辅助目录路径', async () => {
    const value = context(); value.projects = [{ id: 'owner' }, { id: 'episode', parentId: 'owner' }];
    value.library.characters[0].imageUrl = 'asset://localhost/project/episode/image.png'; value.library.characters[0].assetId = 'image';
    const index: AssetIndexRecord = { assetId: 'image', path: '/project/episode/image.png', relativePath: 'image.png',
      rootPath: '/project/episode', projectId: 'episode', source: 'project', status: 'online', size: 10, mtimeMs: 10, fingerprint: '10:10', updatedAt: 1 };
    mocks.indexes.set(index.assetId, index);
    mocks.scan.mockImplementation(async (_directory: string, options: { projectId: string }) => ({ files: options.projectId === 'episode' ? [{ assetId: 'image', path: index.path,
      name: 'image.png', relativePath: 'image.png', category: 'image', source: 'project', size: 10 }] : [],
      folders: [], complete: true, truncated: false, failedDirectories: 0, failedFiles: 0 }));
    await buildSharedAssetSyncPreview(value);
    expect(mocks.copy).toHaveBeenCalledWith(index.path, expect.stringContaining('/project/owner/.shared-sync/inputs/'), expect.anything());
    for (const [input] of mocks.prepare.mock.calls as [SharedSyncPrepareInput][]) {
      expect(input.sources.every((source) => source.filePath.startsWith('/project/owner/'))).toBe(true);
    }
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('下载已应用但ack失败保留新文件身份；恢复仅ack，不再次下载或写库', async () => {
    const asset: SharedSyncRemoteAsset = { etag: 'remote-etag', head: { sharedAssetId: 'remote-file', kind: 'file', revisionId: 'remote-revision',
      revisionDigest: 'd'.repeat(64), operationId: 'publisher-operation', updatedAt: 1 }, revision: {
      format: 'ai-canvas-shared-asset', version: 1, libraryId: 'library', sharedProjectId: 'shared-project', sharedAssetId: 'remote-file',
      revisionId: 'remote-revision', operationId: 'publisher-operation', createdAt: 1,
      payload: { kind: 'file', name: '共享.png', displayRelativePath: 'Library/共享.png', mediaId: 'image', tags: [] },
      media: [{ id: 'image', kind: 'image', extension: 'png', bytes: 10, sha256: 'a'.repeat(64) }] } };
    mocks.cloud = [asset]; mocks.download.mockImplementation(async (input: { operationId: string }) => ({ status: 'ready', operationId: input.operationId,
      revision: asset.revision, revisionDigest: asset.head.revisionDigest, applyToken: leaseToken(),
      media: [{ mediaId: 'image', relativePath: '.shared-sync/files/remote-file/remote-revision/image.png', bytes: 10, sha256: 'a'.repeat(64) }] }));
    const session = await buildSharedAssetSyncPreview(context({ version: 2, characters: [], scenes: [], props: [] }));
    const execution = commitExecution(); let fail = true;
    mocks.acknowledge.mockImplementation(async (input: { applied: boolean }) => { if (input.applied && fail) { fail = false; throw new Error('网络失败'); } });
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('下载「共享.png」失败');
    const currentId = mocks.repo.mappings[0].currentFileAssetId;
    expect(mocks.repo.outbox[0].phase).toBe('applied');
    const failedAck = mocks.acknowledge.mock.calls[0][0] as { operationId: string; applyToken: string };
    expect(mocks.acknowledge).toHaveBeenNthCalledWith(2, expect.objectContaining({ applied: false,
      operationId: failedAck.operationId, applyToken: failedAck.applyToken }));
    const resumed = await buildSharedAssetSyncPreview(context({ version: 2, characters: [], scenes: [], props: [] }));
    await executeSharedAssetSync(resumed, execution);
    expect(mocks.download).toHaveBeenCalledTimes(1); expect(execution.applyDownload).toHaveBeenCalledTimes(1);
    expect(mocks.repo.mappings[0].currentFileAssetId).toBe(currentId);
    expect(mocks.repo.outbox[0].phase).toBe('completed');
    expect(resumed.context.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'paused', error: expect.stringContaining('重新预览') }));
    const unchanged = await buildSharedAssetSyncPreview(context({ version: 2, characters: [], scenes: [], props: [] }));
    expect(unchanged.items).toMatchObject([{ name: '共享.png', direction: 'unchanged' }]);
    expect(unchanged.operations).toHaveLength(0);
  });

  it('切换代次保留旧文件并重新预览，旧待办与共享身份不被复用', async () => {
    mocks.cloud = [remoteFile()];
    const empty = { version: 2 as const, characters: [], scenes: [], props: [] };
    const previous = await buildSharedAssetSyncPreview(context(empty));
    await executeSharedAssetSync(previous, commitExecution());
    const oldMapping = structuredClone(mocks.repo.mappings[0]);
    const oldOperation = structuredClone(mocks.repo.outbox[0]);
    mocks.repo.outbox.push({ ...oldOperation, id: 'old-pending', operationId: 'old-pending', phase: 'paused' });
    mocks.cloud = [];
    mocks.recover.mockClear();
    const next = context(empty); next.binding.generation = 'new-generation';
    const session = await buildSharedAssetSyncPreview(next);
    expect(session.items).toMatchObject([{ name: '共享.png', direction: 'upload' }]);
    expect(session.mappings[0]).toMatchObject({ generation: 'new-generation', currentFileAssetId: oldMapping.currentFileAssetId });
    expect(session.mappings[0].sharedAssetId).not.toBe(oldMapping.sharedAssetId);
    expect(session.operations[0].operation.operationId).not.toBe('old-pending');
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.repo.outbox.find((entry) => entry.operationId === 'old-pending')?.phase).toBe('paused');
    expect(mocks.repo.mappings.find((entry) => entry.id === oldMapping.id)).toEqual(oldMapping);
  });

  it('新代人物可引用旧代已下载的本地媒体，但使用新共享身份', async () => {
    const index = { assetId: 'old-image', path: '/project/owner/.shared-sync/files/old-character/old-revision/image.png',
      relativePath: '.shared-sync/files/old-character/old-revision/image.png', rootPath: '/project/owner', projectId: 'owner',
      source: 'project', fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 } satisfies AssetIndexRecord;
    mocks.indexes.set(index.assetId, index);
    mocks.repo.mappings = [{ ownerId: 'owner', connectionId: 'connection', connectionRevision: '1', libraryId: 'library',
      sharedProjectId: 'shared-project', generation: 'legacy', id: 'old-mapping', kind: 'character', localEntityId: 'local-character',
      sharedAssetId: 'old-character', members: [], media: [{ sharedMediaId: 'image', localAssetId: index.assetId, projectId: 'owner',
        relativePath: index.relativePath, sha256: 'a'.repeat(64), bytes: 10 }], updatedAt: 1 }];
    const value = context(); value.binding.generation = 'new-generation';
    value.library.characters[0].assetId = index.assetId;
    value.library.characters[0].imageUrl = `asset://localhost${index.path}`;
    const session = await buildSharedAssetSyncPreview(value);
    expect(session.items).toMatchObject([{ kind: 'character', direction: 'upload' }]);
    expect(session.mappings[0]).toMatchObject({ generation: 'new-generation', localEntityId: 'local-character' });
    expect(session.mappings[0].sharedAssetId).not.toBe('old-character');
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ generation: 'new-generation',
      sources: [expect.objectContaining({ filePath: index.path })] }));
  });

  it('新代人物可继续引用旧代声音和动作媒体', async () => {
    const makeIndex = (assetId: string, suffix: string): AssetIndexRecord & { relativePath: string } => ({ assetId,
      path: `/project/owner/.shared-sync/files/old-character/old-revision/${suffix}`,
      relativePath: `.shared-sync/files/old-character/old-revision/${suffix}`, rootPath: '/project/owner', projectId: 'owner',
      source: 'project', fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 });
    const audio = makeIndex('old-audio', 'voice.wav'); const video = makeIndex('old-video', 'action.mp4');
    mocks.indexes.set(audio.assetId, audio); mocks.indexes.set(video.assetId, video);
    mocks.repo.mappings = [{ ownerId: 'owner', connectionId: 'connection', connectionRevision: '1', libraryId: 'library',
      sharedProjectId: 'shared-project', generation: 'legacy', id: 'old-mapping', kind: 'character', localEntityId: 'local-character',
      sharedAssetId: 'old-character', members: [], media: [audio, video].map((entry) => ({ sharedMediaId: entry.assetId,
        localAssetId: entry.assetId, projectId: 'owner', relativePath: entry.relativePath, sha256: 'a'.repeat(64), bytes: 10 })), updatedAt: 1 }];
    const value = context(); value.binding.generation = 'new-generation';
    value.library.characters[0].voiceClips = [{ id: 'voice', kind: 'timbre', assetId: audio.assetId, audioUrl: `asset://localhost${audio.path}`,
      transcript: '', createdAt: 1, updatedAt: 1 }];
    value.library.characters[0].actions = [{ id: 'action', category: 'walking', name: '走路', prompt: '', createdAt: 1, updatedAt: 1,
      media: [{ id: 'action-media', kind: 'video', name: '动作', assetId: video.assetId, url: `asset://localhost${video.path}`, createdAt: 1, updatedAt: 1 }] }];
    const session = await buildSharedAssetSyncPreview(value);
    expect(session.items).toMatchObject([{ kind: 'character', direction: 'upload' }]);
    const sources = (mocks.prepare.mock.calls[0][0] as SharedSyncPrepareInput).sources;
    expect(sources.map((source) => source.filePath)).toEqual(expect.arrayContaining([audio.path, video.path]));
  });

  it('列表适配保持流式onFiles，并在身份识别前注入同owner范围及历史路径', async () => {
    const old: AssetIndexRecord = { assetId: 'old', path: '/project/owner/old.png', relativePath: 'old.png',
      projectId: 'owner', source: 'project', fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 };
    mocks.indexes.set('old', old);
    mocks.repo.mappings = [{ ownerId: 'owner', connectionId: 'connection', connectionRevision: '1', libraryId: 'library', sharedProjectId: 'shared-project',
      id: 'mapping', kind: 'file', localEntityId: 'logical-file', sharedAssetId: 'shared-file', members: [], media: [], previousFileAssetIds: ['old'], updatedAt: 1 }];
    const current = { name: 'current.png', path: '/project/owner/current.png', category: 'image' as const, size: 10 };
    mocks.list.mockImplementation(async (_projectId: string, options: { onFiles?: (files: object[]) => void }) => {
      options.onFiles?.([{ name: 'old.png', path: old.path, category: 'image', size: 10 }, current]);
      return [current];
    });
    const onFiles = vi.fn();
    expect(await projectAssetSyncService.readProjectFiles('episode', { onFiles })).toEqual([current]);
    // 共用受管根的分集必须排除owner退休文件，包括没有assetId的旧节点投影。
    mocks.roots.set('episode', '/project/owner');
    await projectAssetSyncService.readProjectFiles('episode', { onFiles });
    expect(mocks.list).toHaveBeenLastCalledWith('episode', expect.objectContaining({ excludedFilePaths: [old.path],
      projectIdentityScope: expect.arrayContaining(['owner', 'episode']) }));
    expect(onFiles).toHaveBeenLastCalledWith([current]);
  });

  it('上传提交携带旧图片记录的完整空集合，守卫缺省到新增的竞态', async () => {
    const index: AssetIndexRecord = { assetId: 'image', path: '/project/owner/image.png', relativePath: 'image.png', rootPath: '/project/owner',
      projectId: 'owner', source: 'project', fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 };
    mocks.indexes.set(index.assetId, index);
    mocks.scan.mockResolvedValue({ files: [{ assetId: index.assetId, name: 'image.png', path: index.path, relativePath: 'image.png',
      category: 'image', source: 'project', size: 10 }], complete: true });
    const session = await buildSharedAssetSyncPreview(context({ version: 2, characters: [], scenes: [], props: [] }));
    const execution = commitExecution(); await executeSharedAssetSync(session, execution);
    expect(execution.applyDownload).toHaveBeenCalledWith(expect.objectContaining({ commit: expect.objectContaining({
      expectedImageRecords: [{ assetId: index.assetId, records: [] }], expectedIndexes: [index],
    }) }));
  });

  it('卡片下载覆盖前复核本轮源媒体，即使卡片字段没变也阻止同URL文件替换', async () => {
    const index: AssetIndexRecord = { assetId: 'image', path: '/project/owner/image.png', relativePath: 'image.png', rootPath: '/project/owner',
      projectId: 'owner', source: 'project', fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 };
    mocks.indexes.set(index.assetId, index);
    mocks.scan.mockResolvedValue({ files: [{ assetId: index.assetId, name: 'image.png', path: index.path, relativePath: 'image.png',
      category: 'image', source: 'project', size: 10 }], complete: true });
    const value = context(); value.library.characters[0].assetId = index.assetId; value.library.characters[0].imageUrl = `asset://localhost${index.path}`;
    await executeSharedAssetSync(await buildSharedAssetSyncPreview(value), commitExecution());
    const remote = mocks.cloud.find((asset) => asset.head.kind === 'character')!;
    remote.revision.parentRevisionId = remote.revision.revisionId;
    remote.revision.revisionId = 'changed-revision'; remote.head.revisionId = 'changed-revision';
    remote.revision.operationId = 'other-operation'; remote.head.operationId = 'other-operation';
    if (remote.revision.payload.kind !== 'file') remote.revision.payload.data.summary = '云端新设定';
    const session = await buildSharedAssetSyncPreview(value); const execution = commitExecution();
    expect(session.items.find((item) => item.kind === 'character')?.direction).toBe('download');
    mocks.changedPaths.add(index.path);
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('项目文件或标签已变化');
    expect(execution.applyDownload).not.toHaveBeenCalled(); expect(value.library.characters[0].summary).toBe('');
    expect(mocks.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ applied: false }));
  });

  it('租约期限前五秒中止慢事务，并将独立signal和同步期限断言传入提交', async () => {
    vi.useFakeTimers();
    const session = await buildSharedAssetSyncPreview(context());
    const applyDownload = vi.fn(async ({ commit }: { commit: SharedAssetSyncCommitInput }) => {
      expect(commit.signal).toBeDefined(); expect(commit.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(115_000);
      expect(commit.signal?.aborted).toBe(true); expect(() => commit.assertCurrent?.()).toThrow('已过期');
      throw commit.signal?.reason;
    });
    await expect(executeSharedAssetSync(session, { applyDownload })).rejects.toThrow('已过期');
    expect(mocks.repo.mappings[0].acceptedRevisionId).toBeUndefined();
    expect(mocks.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ applied: false }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('慢事务在令牌过期后才结束时，仍以同一令牌确认中止且不释放云端锁', async () => {
    vi.useFakeTimers();
    const session = await buildSharedAssetSyncPreview(context());
    const applyDownload = vi.fn(async ({ commit }: { commit: SharedAssetSyncCommitInput }) => {
      await vi.advanceTimersByTimeAsync(121_000);
      expect(commit.signal?.aborted).toBe(true);
      throw commit.signal?.reason;
    });
    await expect(executeSharedAssetSync(session, { applyDownload })).rejects.toThrow('已过期');
    const ack = mocks.acknowledge.mock.calls.at(-1)?.[0] as { applied: boolean; applyToken: string; releaseProjectLock?: boolean };
    expect(ack.applied).toBe(false);
    expect(Number(ack.applyToken.split('.')[0])).toBeLessThan(Date.now());
    expect(ack).not.toHaveProperty('releaseProjectLock');
  });

  it('图片准备期间时钟越过margin时保留旧库，不进入本地事务', async () => {
    vi.useFakeTimers(); const asset = remoteFile();
    if (asset.revision.payload.kind === 'file') asset.revision.payload.imageMetadata = { prompt: '新提示词', references: [] };
    mocks.cloud = [asset];
    mocks.prepareImage.mockImplementation(async (file: { assetId: string; name: string }) => {
      vi.setSystemTime(Date.now() + 116_000);
      return { id: `asset-image:${file.assetId}:digest`, assetId: file.assetId, fileName: file.name, contentDigest: 'a'.repeat(64),
        prompt: '新提示词', references: [], revision: 1, updatedAt: Date.now() };
    });
    const value = context({ version: 2, characters: [], scenes: [], props: [] });
    const session = await buildSharedAssetSyncPreview(value); const execution = commitExecution();
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('已过期');
    expect(execution.applyDownload).not.toHaveBeenCalled(); expect(session.expectedLibrary).toBe(value.library);
    expect(mocks.repo.mappings[0].currentFileAssetId).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it('其他实例已应用同operation时停止，不认领本轮重新分配但未落库的ID', async () => {
    mocks.cloud = [remoteFile()]; const value = context({ version: 2, characters: [], scenes: [], props: [] });
    const session = await buildSharedAssetSyncPreview(value);
    const applyDownload = vi.fn(async ({ commit }: { commit: SharedAssetSyncCommitInput }) => {
      mocks.repo.outbox = [{ ...commit.operation, phase: 'applied' }];
      mocks.repo.mappings = [{ ...commit.mappings[0], currentFileAssetId: 'accepted-by-other-instance' }];
      return { alreadyApplied: true };
    });
    await expect(executeSharedAssetSync(session, { applyDownload })).rejects.toThrow('重新打开项目');
    expect(session.invalidated).toBe(true); expect(session.expectedLibrary).toBe(value.library);
    expect(session.mappings[0].currentFileAssetId).toBeUndefined();
    expect(mocks.repo.mappings[0].currentFileAssetId).toBe('accepted-by-other-instance');
    await expect(executeSharedAssetSync(session, { applyDownload })).rejects.toThrow('重新打开项目');
    expect(mocks.download).toHaveBeenCalledTimes(1); expect(applyDownload).toHaveBeenCalledTimes(1);
  });

  it('仅映射的当前版本进入文件列表，历史路径可在identify前排除', async () => {
    const oldIndex: AssetIndexRecord = { assetId: 'old', path: '/project/owner/old.png', projectId: 'owner', source: 'project',
      relativePath: 'old.png', size: 10, mtimeMs: 10, fingerprint: '10:10', status: 'online', updatedAt: 1 };
    const nextIndex = { ...oldIndex, assetId: 'current', path: '/project/owner/.shared-sync/files/card/revision/image.png',
      relativePath: '.shared-sync/files/card/revision/image.png' };
    mocks.indexes.set('old', oldIndex); mocks.indexes.set('current', nextIndex);
    const session = await buildSharedAssetSyncPreview(context()); const mapping = session.mappings[0];
    mocks.repo.mappings = [{ ...mapping, kind: 'file', sharedAssetId: 'card', acceptedRevisionId: 'revision',
      localEntityId: 'logical-file', currentFileAssetId: 'current', media: [{ sharedMediaId: 'image', localAssetId: 'current',
        projectId: 'owner', relativePath: nextIndex.relativePath, sha256: 'a'.repeat(64), bytes: 10 }],
      previousFileAssetIds: ['old'], displayRelativePath: 'Library/当前.png' }];
    expect(await sharedAssetSyncExcludedPaths('owner')).toEqual([oldIndex.path]);
    const view = await projectSharedFileView('owner', [{ assetId: 'old', name: 'old.png', path: oldIndex.path, category: 'image', size: 10 }]);
    expect(view).toMatchObject([{ assetId: 'current', name: '当前.png', path: nextIndex.path }]);
    mocks.repo.mappings[0].acceptedRevisionId = 'newer-metadata-revision';
    expect(await projectSharedFileView('owner', [])).toMatchObject([{ name: '当前.png', relativePath: 'Library/当前.png' }]);
    expect(await projectSharedFileView('episode', [])).toEqual([]);
    mocks.roots.set('episode', '/project/owner');
    expect(await sharedAssetSyncExcludedPaths('episode')).toEqual([oldIndex.path]);
    expect(await projectSharedFileView('episode', [{ name: 'old.png', path: oldIndex.path, category: 'image', size: 10 }])).toEqual([]);
    mocks.indexes.set('current', { ...nextIndex, path: '/project/owner/改名.png', relativePath: '改名.png' });
    expect(await projectSharedFileView('owner', [])).toMatchObject([{ assetId: 'current', name: '改名.png', relativePath: '改名.png' }]);
  });
});

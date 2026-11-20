/**
 * mediaRelocations — 回归测试：repairs exact encoded asset tokens without changing prose, malformed tokens or ordinary move prompts。
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, it, vi } from 'vitest';
import type { MediaRelocation } from '../../src/services/indexedDb/mediaRelocations';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
});

const move = { projectId: 'p', oldPath: 'D:/p/a.png', newPath: 'D:/p/group/a-new.png',
  oldAssetUrl: 'asset://old', assetUrl: 'asset://new', relativePath: 'group/a-new.png' };

it('发布前保留移动目标，中断重试复用原名，引用提交后才释放目标', async () => {
  const journal = await import('../../src/services/indexedDb/mediaRelocations');
  const directory = 'D:/library/图片';
  const original = { path: directory + '/a.png', totalBytes: 4, digest: 'a'.repeat(64) };
  const next = { ...original, path: directory + '/a (1).png' };
  await expect(journal.prepareAssetMoveCopy('asset-a', move.oldPath, directory, original)).resolves.toEqual({ copy: original, resume: false });
  await expect(journal.prepareAssetMoveCopy('asset-b', '/other/a.png', directory, original)).rejects.toThrow('占用');
  await expect(journal.prepareAssetMoveCopy('asset-a', move.oldPath, directory, next)).resolves.toEqual({ copy: original, resume: true });
  expect(await journal.pendingAssetMoveTargets()).toEqual(new Set([journal.mediaFileAllocationKey(original.path)]));
  await expect(journal.prepareAssetMoveCopy('asset-a', move.oldPath, directory, next, original)).resolves.toEqual({ copy: next, resume: false });
  await journal.releaseAssetMoveCopy('asset-a', move.oldPath, directory, original);
  expect(await journal.pendingAssetMoveTargets()).toEqual(new Set([journal.mediaFileAllocationKey(next.path)]));
  await journal.persistMediaRelocation({ ...move, projectId: 'global-assets', newPath: next.path, relativePath: '图片/a (1).png',
    assetMove: { assetId: 'asset-a', rootPath: 'D:/library', source: 'folder', digest: next.digest, totalBytes: 4, mtimeMs: 0 } });
  expect(await journal.pendingAssetMoveTargets()).toEqual(new Set());
});

it('repairs exact encoded asset tokens without changing prose, malformed tokens or ordinary move prompts', async () => {
  const relocation = await import('../../src/services/indexedDb/mediaRelocations');
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  const repair: MediaRelocation = { ...move, assetMove: { assetId: 'stable', source: 'project', projectId: 'p',
    rootPath: 'D:/p', totalBytes: 4, mtimeMs: 20, digest: 'a'.repeat(64), repair: true } };
  const prompt = `正文 ${move.oldPath} @asset{${encodeURIComponent(move.oldPath)}} @asset{%ZZ}`;
  expect(relocation.relocateMediaReferences(prompt, [move])).toBe(prompt);
  const expected = `正文 ${move.oldPath} @asset{${encodeURIComponent(move.newPath)}} @asset{%ZZ}`;
  expect(relocation.relocateMediaReferences(prompt, [repair])).toBe(expected);
  expect(await replayJournal(db, { prompt }, [{ ...move, oldPath: 'D:/other.png' }, repair])).toEqual({ prompt: expected });
});

it('atomically repairs stable identities, missing global image snapshots and metadata prompt tokens', async () => {
  const relocation = await import('../../src/services/indexedDb/mediaRelocations');
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  const before = { assetId: 'stable', path: move.oldPath, fingerprint: '4:1', size: 4, mtimeMs: 1 };
  await put(db, 'assetIndex', before);
  await put(db, 'globalDramaAssets', { id: 'scene', kind: 'scene', imageAssetId: 'stable' });
  await put(db, 'metadata', { id: 'asset-image:fixture', assetId: 'stable', prompt: `@asset{${encodeURIComponent(move.oldPath)}}` });
  const repair: MediaRelocation = { ...move, assetMove: { assetId: 'stable', source: 'global', rootPath: 'D:/p',
    totalBytes: 4, mtimeMs: 20, digest: 'a'.repeat(64), repair: true } };
  await relocation.persistAssetRepairBatch([repair], [before]);
  expect(await read(db, 'assetIndex', 'stable')).toMatchObject({ path: move.newPath, contentDigest: 'a'.repeat(64), status: 'online' });
  expect(await read(db, 'globalDramaAssets', 'scene')).toMatchObject({ imageAssetId: 'stable', imageUrl: move.assetUrl, imageRelativePath: move.relativePath });
  expect(await read(db, 'metadata', 'asset-image:fixture')).toMatchObject({ prompt: `@asset{${encodeURIComponent(move.newPath)}}` });
  expect((await read(db, 'metadata', 'media-relocations'))?.moves).toEqual([repair]);
});

it('rejects changed or duplicate repair identities before any persisted reference is changed', async () => {
  const relocation = await import('../../src/services/indexedDb/mediaRelocations');
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  const before = { assetId: 'stable', path: move.oldPath, fingerprint: '4:1' };
  await put(db, 'assetIndex', { ...before, fingerprint: '9:2' });
  await put(db, 'history', { id: 'history', filePath: move.oldPath });
  const repair: MediaRelocation = { ...move, assetMove: { assetId: 'stable', source: 'global', rootPath: 'D:/p',
    totalBytes: 4, mtimeMs: 20, digest: 'a'.repeat(64), repair: true } };
  await expect(relocation.persistAssetRepairBatch([repair], [before])).rejects.toThrow('已变化');
  await expect(relocation.persistAssetRepairBatch([repair, { ...repair, assetMove: { ...repair.assetMove!, assetId: 'other' } }],
    [before, { ...before, assetId: 'other' }])).rejects.toThrow('批次无效');
  expect(await read(db, 'history', 'history')).toMatchObject({ filePath: move.oldPath });
  expect(await read(db, 'metadata', 'media-relocations')).toBeUndefined();
});

it('迁移全局场景道具主图身份及相对路径，迟到保存不能恢复旧地址', async () => {
  const service = await import('../../src/services/indexedDbService');
  const relocation = await import('../../src/services/indexedDb/mediaRelocations');
  const scene = { id: 'global-scene', kind: 'scene' as const, name: '客厅', key: '客厅', summary: '', visualNotes: '',
    source: 'manual' as const, importance: 'main' as const, confirmed: true, createdAt: 1, updatedAt: 1,
    imageAssetId: 'stable-image', imageRelativePath: 'a.png', imageUrl: move.oldAssetUrl };
  await service.putGlobalDramaAsset(scene);
  await relocation.persistMediaRelocation(move);
  expect((await service.getAllGlobalDramaAssets())[0]).toMatchObject({
    imageAssetId: 'stable-image', imageRelativePath: move.relativePath, imageUrl: move.assetUrl,
  });
  await service.putGlobalDramaAsset({ ...scene, name: '迟到编辑' });
  expect((await service.getAllGlobalDramaAssets())[0]).toMatchObject({
    name: '迟到编辑', imageRelativePath: move.relativePath, imageUrl: move.assetUrl,
  });
});

it('global asset moves preserve identity, tags and prompt records while repairing project-relative references', async () => {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const relocation = await import('../../src/services/indexedDb/mediaRelocations');
  const db = await openDB();
  const globalMove = { ...move, projectId: 'global-assets', newPath: 'D:/library/角色/a.png', relativePath: '角色/a.png',
    assetMove: { assetId: 'stable', rootPath: 'D:/library', source: 'folder' as const, digest: 'a'.repeat(64), totalBytes: 4, mtimeMs: 20 } };
  await put(db, 'projects', { id: 'p', nodes: [{ data: { assetId: 'stable', filePath: move.oldPath, relativePath: 'a.png', imageUrl: move.oldAssetUrl } }] });
  await put(db, 'assetIndex', { assetId: 'stable', path: move.oldPath, rootPath: 'D:/p', relativePath: 'a.png', projectId: 'p', fingerprint: '4:1', source: 'global' });
  await put(db, 'assetMetaV2', { assetId: 'stable', path: move.oldPath, tags: ['人物'] });
  await put(db, 'metadata', { id: 'prompt-fixture', assetId: 'stable', digest: 'a'.repeat(64), prompt: '用户编辑', references: ['asset-image-references/ref.png'] });
  await put(db, 'metadata', { id: 'recent-fixture', assetIds: ['stable'] });
  await relocation.persistMediaRelocation(globalMove);
  expect((await read(db, 'projects', 'p'))?.nodes).toEqual([{ data: { assetId: 'stable', filePath: globalMove.newPath, imageUrl: globalMove.assetUrl } }]);
  expect(await read(db, 'assetIndex', 'stable')).toMatchObject({ assetId: 'stable', path: globalMove.newPath, rootPath: 'D:/library', source: 'folder', relativePath: '角色/a.png', fingerprint: '4:20', size: 4 });
  expect(await read(db, 'assetIndex', 'stable')).not.toHaveProperty('projectId');
  expect(await read(db, 'assetMetaV2', 'stable')).toMatchObject({ path: globalMove.newPath, tags: ['人物'] });
  expect(await read(db, 'metadata', 'prompt-fixture')).toMatchObject({ prompt: '用户编辑', references: ['asset-image-references/ref.png'] });
  expect(await read(db, 'metadata', 'recent-fixture')).toMatchObject({ assetIds: ['stable'] });
  const service = await import('../../src/services/indexedDbService');
  await service.putHistoryEntry({ id: 'late', projectId: 'p', nodeId: 'n', nodeLabel: 'n', timestamp: 1,
    prompt: 'keep', output: '', nodeType: 'ai-image', model: 'm', provider: 'p', status: 'success', filePath: move.oldPath, ...{ relativePath: 'a.png' } });
  expect((await service.getNodeHistoryEntries('p', 'n'))[0]).not.toHaveProperty('relativePath');
  await service.putAssetIndex({ assetId: 'new-file', path: move.oldPath, rootPath: 'D:/p', source: 'global', fingerprint: '9:50', size: 9, mtimeMs: 50, status: 'online', updatedAt: 50 });
  await service.putAssetMeta({ assetId: 'new-file', path: move.oldPath, tags: ['新图'], updatedAt: 50 });
  expect(await read(db, 'assetIndex', 'new-file')).toMatchObject({ path: move.oldPath });
  expect(await read(db, 'assetMetaV2', 'new-file')).toMatchObject({ path: move.oldPath, tags: ['新图'] });
});

async function put(db: IDBDatabase, store: string, value: unknown) {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
async function read(db: IDBDatabase, store: string, key: string) {
  return new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function replayJournal<T>(db: IDBDatabase, value: T, moves: MediaRelocation[]): Promise<T> {
  const { withRelocatedMedia } = await import('../../src/services/indexedDb/mediaRelocations');
  await put(db, 'metadata', { id: 'media-relocations', moves });
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction('metadata');
    let result: T;
    withRelocatedMedia(tx, value, (next) => { result = next; });
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error);
  });
}

async function legacyReplay<T>(value: T, moves: MediaRelocation[]): Promise<T> {
  const { relocateMediaReferences, relocateOwnedMediaReferences } = await import('../../src/services/indexedDb/mediaRelocations');
  return moves.reduce((current, entry) => entry.ownerId
    ? relocateOwnedMediaReferences(current, entry, entry.ownerId)
    : relocateMediaReferences(current, [entry]), value);
}

it('atomically migrates persisted references and keeps pending cleanup until completed', async () => {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const service = await import('../../src/services/indexedDb/mediaRelocations');
  const db = await openDB();
  await put(db, 'projects', { id: 'p', nodes: [{ id: 'n', data: { filePath: move.oldPath, imageUrl: move.oldAssetUrl } }] });
  for (const store of ['history', 'chatMessages']) await put(db, store, { id: 'h', filePath: move.oldPath, mediaUrl: move.oldAssetUrl });
  await put(db, 'assetIndex', { assetId: 'a', filePath: move.oldPath, relativePath: 'a.png' });
  await put(db, 'assetMeta', { path: move.oldPath, description: 'keep' });
  await service.persistMediaRelocation(move);
  expect((await read(db, 'projects', 'p'))?.nodes).toEqual([{ id: 'n', data: {
    filePath: move.newPath, imageUrl: move.assetUrl, relativePath: move.relativePath,
  } }]);
  expect(await read(db, 'history', 'h')).toMatchObject({ filePath: move.newPath, mediaUrl: move.assetUrl });
  expect(await read(db, 'chatMessages', 'h')).toMatchObject({ filePath: move.newPath });
  expect(await read(db, 'assetIndex', 'a')).toMatchObject({ assetId: 'a', relativePath: move.relativePath });
  expect(await read(db, 'assetMeta', move.oldPath)).toBeUndefined();
  expect(await read(db, 'assetMeta', move.newPath)).toMatchObject({ description: 'keep' });
  expect(await service.pendingMediaRelocations('p')).toEqual([move]);
  await service.completeMediaRelocation(move);
  expect(await service.pendingMediaRelocations('p')).toEqual([]);
});

it('normalizes a stale history write after relocation and cleanup', async () => {
  const relocation = await import('../../src/services/indexedDb/mediaRelocations');
  const service = await import('../../src/services/indexedDbService');
  await relocation.persistMediaRelocation(move);
  await relocation.completeMediaRelocation(move);
  await service.putHistoryEntry({ id: 'h', projectId: 'p', nodeId: 'n', nodeLabel: 'n', timestamp: 1,
    prompt: 'keep', output: '', nodeType: 'ai-image', model: 'm', provider: 'p', status: 'success',
    filePath: move.oldPath, mediaUrl: move.oldAssetUrl });
  expect((await service.getNodeHistoryEntries('p', 'n'))[0]).toMatchObject({ filePath: move.newPath, mediaUrl: move.assetUrl });
});

it('rolls back all references and the journal if an asset index constraint fails', async () => {
  const service = await import('../../src/services/indexedDb/mediaRelocations');
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  await put(db, 'history', { id: 'h', filePath: move.oldPath });
  await put(db, 'assetIndex', { assetId: 'old', path: move.oldPath });
  await put(db, 'assetIndex', { assetId: 'new', path: move.newPath });
  await expect(service.persistMediaRelocation(move)).rejects.toBeTruthy();
  expect(await read(db, 'history', 'h')).toMatchObject({ filePath: move.oldPath });
  expect(await service.pendingMediaRelocations('p')).toEqual([]);
});

it('updates undo, clipboard and URL references without changing embedded prompts', async () => {
  const { relocateMediaReferences } = await import('../../src/services/indexedDb/mediaRelocations');
  const node = { id: 'n', data: { type: 'ai-image', label: '生成图像', displayLabel: '自定义标题',
    filePath: 'D:\\p\\a.png', imageUrl: move.oldAssetUrl, prompt: `use ${move.oldPath}` } };
  const result = relocateMediaReferences({ history: [{ nodes: [node] }], clipboard: [node] }, [move]);
  expect(result.history[0].nodes[0].data.filePath).toBe(move.newPath);
  expect(result.history[0].nodes[0].data).toMatchObject({ label: '生成图像', displayLabel: '自定义标题' });
  expect(result.clipboard[0].data.imageUrl).toBe(move.assetUrl);
  expect(result.clipboard[0].data.prompt).toBe(`use ${move.oldPath}`);
  expect(node.data.filePath).toBe('D:\\p\\a.png');
});

it('syncs renamed media node titles in the canvas, undo and clipboard without renaming reference owners', async () => {
  const { relocateMediaReferences } = await import('../../src/services/indexedDb/mediaRelocations');
  const renamedFileName = '森系_4.png';
  const rename = { ...move, newPath: `D:/p/${renamedFileName}`, relativePath: renamedFileName, renamedFileName };
  const nodes = [
    { id: 'generated', data: { type: 'ai-image', label: '生成图像', filePath: 'D:\\p\\a.png' } },
    { id: 'source', data: { type: 'source-image', label: '粘贴图像', fileName: 'a.png', filePath: move.oldPath } },
    { id: 'custom', data: { type: 'ai-image', label: '生成图像', displayLabel: '旧标题', filePath: move.oldPath } },
  ];
  const owner = { type: 'ai-video', label: '视频标题', filePath: 'D:/p/other.mp4',
    reference: { path: move.oldPath, label: '参考图' } };
  const result = relocateMediaReferences({ nodes, history: [{ nodes }], clipboard: nodes, owner }, [rename]);
  for (const entries of [result.nodes, result.history[0].nodes, result.clipboard]) {
    for (const node of entries) expect(node.data).toMatchObject({ label: renamedFileName, filePath: rename.newPath });
    expect(entries[1].data.fileName).toBe(renamedFileName);
    expect(entries[2].data.displayLabel).toBe(renamedFileName);
  }
  expect(result.owner).toEqual({ ...owner, reference: { path: rename.newPath, label: '参考图' } });
  expect(nodes[0].data.label).toBe('生成图像');
});

it('persists renamed node titles across projects and repairs stale project saves through the journal', async () => {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const service = await import('../../src/services/indexedDb/mediaRelocations');
  const db = await openDB();
  const renamedFileName = '森系_4.png';
  const rename = { ...move, newPath: `D:/p/${renamedFileName}`, relativePath: renamedFileName, renamedFileName };
  const original = { id: 'p', nodes: [{ id: 'n', data: { type: 'ai-image', label: '生成图像',
    displayLabel: '旧标题', filePath: move.oldPath, imageUrl: move.oldAssetUrl } }] };
  for (const id of ['p', 'other-project']) await put(db, 'projects', { ...original, id });
  await service.persistMediaRelocation(rename);
  await service.completeMediaRelocation(rename);
  const expected = { ...original.nodes[0].data, label: renamedFileName, displayLabel: renamedFileName,
    filePath: rename.newPath, imageUrl: rename.assetUrl, relativePath: renamedFileName };
  for (const id of ['p', 'other-project']) {
    expect((await read(db, 'projects', id))?.nodes).toEqual([{ id: 'n', data: expected }]);
  }
  const moves = (await read(db, 'metadata', 'media-relocations'))?.moves as MediaRelocation[];
  expect((await replayJournal(db, original, moves)).nodes[0].data).toEqual(expected);
});

it('splits shared owners before moving the final owner and normalizes stale shared writes in order', async () => {
  const service = await import('../../src/services/indexedDb/mediaRelocations');
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  const original = { id: 'p', nodes: ['a', 'b'].map((id) => ({ id, data: { filePath: move.oldPath, assetId: 'original-asset' } })) };
  await put(db, 'projects', original);
  await service.persistMediaRelocation(move, 'a');
  expect(await service.pendingMediaRelocations('p')).toEqual([{ ...move, ownerId: 'a' }]);
  await service.completeMediaRelocation(move);
  const last = { ...move, newPath: 'D:/p/group/b.png', relativePath: 'group/b.png' };
  await service.persistMediaRelocation(last);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['projects', 'metadata'], 'readwrite');
    service.withRelocatedMedia(tx, original, (next) => tx.objectStore('projects').put(next));
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  expect((await read(db, 'projects', 'p'))?.nodes).toEqual([
    { id: 'a', data: { filePath: move.newPath, relativePath: move.relativePath } },
    { id: 'b', data: { filePath: last.newPath, relativePath: last.relativePath, assetId: 'original-asset' } },
  ]);
});

it('skips unrelated history while preserving string, array, URL and chained metadata rewrites', async () => {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  const next = { ...move, oldPath: move.newPath, newPath: 'D:/final/a.png',
    oldAssetUrl: move.assetUrl, assetUrl: 'asset://final', relativePath: 'a.png' };
  const irrelevant = Array.from({ length: 50 }, (_, index) => ({ ...move,
    oldPath: `D:/unrelated/${index}.png`, oldAssetUrl: `asset://unrelated-${index}` }));
  const values = [move.oldPath, move.oldAssetUrl, 'asset://localhost/D%3A%5Cp%5Ca.png',
    [move.oldPath, { filePath: move.oldPath, relativePath: 'old', fileName: 'old.png' }],
    { filePath: move.oldPath, references: [move.oldAssetUrl], prompt: `保留 ${move.oldPath}` }];
  for (const value of values) {
    const moves = [...irrelevant, move, next, { ...move, oldPath: 'a.png', newPath: 'metadata-renamed' }];
    expect(await replayJournal(db, value, moves)).toEqual(await legacyReplay(value, moves));
  }
  const untouched = { prompt: '没有媒体引用', values: [1, false, null] };
  expect(await replayJournal(db, untouched, irrelevant)).toBe(untouched);
});

it('retains owner order, cross-project references and same-path asset identity protection', async () => {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  vi.spyOn(Date, 'now').mockReturnValue(123);
  const globalMove: MediaRelocation = { ...move, projectId: 'another-project',
    assetMove: { assetId: 'original', rootPath: 'D:/library', source: 'folder', digest: 'a'.repeat(64), totalBytes: 4, mtimeMs: 20 } };
  const value = { id: 'different-project', nodes: [
    { id: 'a', data: { assetId: 'original', filePath: move.oldPath, relativePath: 'a.png' } },
    { id: 'b', data: { assetId: 'original', filePath: move.oldPath, relativePath: 'a.png' } },
    { id: 'new', data: { assetId: 'new-asset', filePath: move.oldPath, imageUrl: move.oldAssetUrl } },
  ], assetIndex: { assetId: 'original', path: move.oldPath, fingerprint: '4:1', projectId: 'p' },
  history: [{ nodeId: 'a', filePath: move.oldPath }] };
  const moves = [{ ...move, ownerId: 'absent' }, { ...move, ownerId: 'a' }, globalMove,
    { ...move, oldPath: move.newPath, newPath: 'D:/final.png', oldAssetUrl: move.assetUrl }];
  expect(await replayJournal(db, value, moves)).toEqual(await legacyReplay(value, moves));
  const protectedAsset = value.nodes[2];
  expect(await replayJournal(db, protectedAsset, [globalMove])).toBe(protectedAsset);
});

it('indexes derived filenames, fingerprints and status strings introduced by asset moves', async () => {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  vi.spyOn(Date, 'now').mockReturnValue(123);
  const globalMove: MediaRelocation = { ...move,
    assetMove: { assetId: 'stable', rootPath: 'D:/library', source: 'folder', digest: 'a'.repeat(64), totalBytes: 4, mtimeMs: 20 } };
  const value = { assetId: 'stable', path: move.oldPath, fingerprint: '4:1', fileName: 'old.png', projectId: 'p' };
  const introduced = ['a-new.png', '4:20', 'online', 'folder', 'D:/library', move.relativePath, move.assetUrl];
  const moves = [globalMove, ...introduced.map((oldPath) => ({ ...move, oldPath,
    oldAssetUrl: undefined, newPath: `${oldPath}-rewritten` }))];
  expect(await replayJournal(db, value, moves)).toEqual(await legacyReplay(value, moves));
});

it('keeps non-plain objects opaque and falls back for cycles or accessors', async () => {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  const moves = [move, { ...move, oldPath: 'D:/unrelated/file.png', oldAssetUrl: 'asset://unrelated' }];
  class Opaque { filePath = move.oldPath; }
  const opaque = { date: new Date(1), map: new Map([['path', move.oldPath]]), instance: new Opaque(),
    nullPrototype: Object.assign(Object.create(null), { filePath: move.oldPath }) };
  expect(await replayJournal(db, opaque, moves)).toBe(opaque);
  const cycle: { self?: unknown; content: string } = { content: 'unchanged' };
  cycle.self = cycle;
  const cycled = await replayJournal(db, cycle, moves);
  expect(cycled).toEqual(await legacyReplay(cycle, moves));
  expect(cycled.self).toBe(cycled);

  let reads = 0;
  const accessed = { get filePath() { reads++; return move.oldPath; } };
  const expected = await legacyReplay(accessed, moves);
  const legacyReads = reads;
  reads = 0;
  expect(await replayJournal(db, accessed, moves)).toEqual(expected);
  expect(reads).toBe(legacyReads);
});

it('matches the ordered legacy replay over deterministic randomized journals', async () => {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  vi.spyOn(Date, 'now').mockReturnValue(456);
  let seed = 0x91a2;
  const random = (limit: number) => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed % limit; };
  const paths = Array.from({ length: 8 }, (_, index) => `D:/project/${index}.png`);
  const urls = paths.map((path) => `asset://localhost/${encodeURIComponent(path)}`);
  for (let round = 0; round < 120; round++) {
    const value = { id: `project-${random(3)}`, nodes: Array.from({ length: 8 }, (_, index) => {
      const path = random(paths.length);
      return { id: `node-${index}`, data: { filePath: random(2) ? paths[path] : paths[path].replaceAll('/', '\\'),
        imageUrl: urls[path], assetId: `asset-${random(3)}`, relativePath: `${path}.png`, fileName: `${path}.png` } };
    }), strings: [paths[random(paths.length)], urls[random(paths.length)], '前后正文不变'],
    assetIndex: { assetId: `asset-${random(3)}`, path: paths[random(paths.length)], fingerprint: '4:1', projectId: 'p' } };
    const moves: MediaRelocation[] = Array.from({ length: 12 }, () => {
      const from = random(paths.length);
      const to = random(paths.length);
      return { projectId: `project-${random(3)}`, oldPath: paths[from], newPath: paths[to],
        oldAssetUrl: random(2) ? urls[from] : undefined, assetUrl: urls[to], relativePath: `${to}.png`,
        ownerId: random(3) ? undefined : `node-${random(10)}`,
        assetMove: random(3) ? undefined : { assetId: `asset-${random(3)}`, rootPath: 'D:/library',
          source: 'folder', digest: 'a'.repeat(64), totalBytes: 4, mtimeMs: round } };
    });
    expect(await replayJournal(db, value, moves), `round ${round}`).toEqual(await legacyReplay(value, moves));
  }
});

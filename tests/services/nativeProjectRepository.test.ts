/** 仓储测试仅使用独立 fake IndexedDB，不操作真实项目。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeProject, readNativeProject, readNativeProjectByCanvasId, listNativeProjectIdentities,
  listNativeEpisodes, convertNativeProjectToSeries, createNativeEpisode, saveNativeCanvas, saveNativeEpisodeContent,
  reorderNativeEpisodes, deleteNativeEpisode, readNativeProjectCapture, readNativeProjectSelection, readNativeProjectContent,
  readNativeEpisodeContent, saveNativeProjectContent, saveNativeProjectView, deleteNativeProject,
  updateNativeProjectMetadata, updateNativeEpisodeMetadata, updateNativeEpisodeComposite, NATIVE_PROJECT_DATABASE_NAME } from '../../src/services/indexedDb/nativeProjectRepository';
import { prepareNativeProjectExport, advanceNativeProjectExport, readNativeProjectExport, prepareNativeProjectImport,
  advanceNativeProjectImport, commitNativeProjectImport, replaceNativeContentWithRecovery,
  listNativeContentRecoveryPoints } from '../../src/services/indexedDb/nativeProjectRepository';
import { prepareProjectModelArchiveCapture, materializeProjectModelArchiveBusiness } from '../../src/services/projectModelArchiveService';
import type { ProjectModelTransferCapture, ProjectModelTransferExchange } from '../../src/types/projectModelTransfer';
import { listNativeVideoEditorProjectsForProject } from '../../src/services/indexedDb/nativeVideoEditorRepository';

const id = (prefix: 'p2' | 'e2' | 'c2', digit: string) => `${prefix}-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
let factory: IDBFactory;
beforeEach(() => { factory = new IDBFactory(); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('独立新项目仓储', () => {
  it('无媒体更新原子保存恢复点，过期预览和媒体引用不能覆盖结果', async () => {
    const root = await createNativeProject({ name: '恢复点', projectId: id('p2', '1'), canvasId: id('c2', '2') }, { factory });
    const initial = await readNativeProjectCapture(root.project.id, { factory });
    expect(initial).not.toBeNull();
    const expected: ProjectModelTransferCapture = { schemaVersion: 1, generation: 1, sessionId: 'native-project',
      sessionRevision: initial!.changeRevision, sourceToken: 'a'.repeat(64), includesHistory: false,
      aggregate: { ...initial!.aggregate, previews: [], bindings: [] }, exchange: null, history: [], historyBindings: [] };
    const next = structuredClone(expected.aggregate); next.content.script = '更新正文';
    await replaceNativeContentWithRecovery({ operationId: 'update-1', expected, next, exchange: null }, { factory });
    await replaceNativeContentWithRecovery({ operationId: 'update-1', expected, next, exchange: null }, { factory });
    const points = await listNativeContentRecoveryPoints(root.project.id, { factory });
    expect(points).toHaveLength(1); expect(points[0].aggregate.content.script).toBe(expected.aggregate.content.script);
    const changedIntent = structuredClone(next); changedIntent.content.script = '不同内容';
    await expect(replaceNativeContentWithRecovery({ operationId: 'update-1', expected, next: changedIntent, exchange: null }, { factory }))
      .rejects.toThrow('project-transfer-present');
    expect((await readNativeProject(root.project.id, { factory }))?.content.script).toBe('更新正文');
    await expect(replaceNativeContentWithRecovery({ operationId: 'update-2', expected, next, exchange: null }, { factory }))
      .rejects.toThrow('project-version-conflict');
    const withMedia = structuredClone(next);
    withMedia.canvases[0].nodes = [{ id: 'image', type: 'image', position: { x: 0, y: 0 }, data: { imageUrl: 'data:image/png;base64,AA==' } }] as typeof withMedia.canvases[0]['nodes'];
    await expect(replaceNativeContentWithRecovery({ operationId: 'update-3', expected, next: withMedia, exchange: null }, { factory }))
      .rejects.toThrow('content-update-media-not-supported');
    expect(await listNativeContentRecoveryPoints(root.project.id, { factory })).toHaveLength(1);
  });
  it('未结算的跨库共享同步冻结新项目的普通写入，完成后可继续保存', async () => {
    const project = await createNativeProject({ name: '共享锁', projectId: id('p2', '1'), canvasId: id('c2', '2') }, { factory });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(NATIVE_PROJECT_DATABASE_NAME); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
    });
    const mark = (phase: string) => new Promise<void>((resolve, reject) => {
      const tx = db.transaction('nativeTransferJournal', 'readwrite');
      tx.objectStore('nativeTransferJournal').put({ operationId: 'shared-1', projectId: project.project.id, kind: 'native-shared-sync', phase });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    try {
      await mark('prepared');
      const input = { projectId: project.project.id, expectedProjectEpoch: project.project.epoch, canvasId: project.canvas!.id,
        episodeId: null, expectedCanvasEpoch: project.canvas!.epoch, expectedCanvasRevision: project.canvas!.revision,
        document: { nodes: [], edges: [], groups: [] } };
      await expect(saveNativeCanvas(input, { factory })).rejects.toThrow('project-shared-sync-pending');
      await expect(saveNativeProjectContent({ projectId: project.project.id, expectedProjectEpoch: project.project.epoch,
        expectedRevisions: { script: 0 }, patch: { script: '不应写入' } }, { factory })).rejects.toThrow('project-shared-sync-pending');
      expect((await readNativeProject(project.project.id, { factory }))?.content.script).toBeUndefined();
      await mark('finalized');
      expect((await saveNativeCanvas(input, { factory })).revision).toBe(1);
    } finally { db.close(); }
  });
  it('导出按原操作登记回执，过期版本保留发布状态且不登记', async () => {
    const root = await createNativeProject({ name: '导出', projectId: id('p2', '1'), canvasId: id('c2', '2') }, { factory });
    const capture: ProjectModelTransferCapture = { schemaVersion: 1, generation: 1, sessionId: 'native-project', sessionRevision: 0,
      sourceToken: 'a'.repeat(64), includesHistory: true, aggregate: { ...root, previews: [], bindings: [] }, exchange: null, history: [], historyBindings: [] };
    const prepared = await prepareProjectModelArchiveCapture(capture, []);
    const input = { operationId: 'export-1', projectId: root.project.id, expectedChangeRevision: 0, sourceToken: capture.sourceToken,
      expectedExchange: null, exchange: prepared.exchange, includesHistory: true };
    const journal = await prepareNativeProjectExport(input, { factory });
    const packing = await advanceNativeProjectExport(journal.operationId, journal.sequence, 'packing', undefined, { factory });
    const receipt = { outputRef: 'opaque-receipt', packageDigest: 'b'.repeat(64) };
    const published = await advanceNativeProjectExport(journal.operationId, packing.sequence, 'published', receipt, { factory });
    await saveNativeCanvas({ projectId: root.project.id, expectedProjectEpoch: root.project.epoch, canvasId: root.canvas!.id, episodeId: null,
      expectedCanvasEpoch: root.canvas!.epoch, expectedCanvasRevision: root.canvas!.revision, document: { nodes: [], edges: [], groups: [] } }, { factory });
    await expect(advanceNativeProjectExport(journal.operationId, published.sequence, 'registered', receipt, { factory })).rejects.toThrow('project-version-conflict');
    expect((await readNativeProjectExport(journal.operationId, { factory }))?.phase).toBe('published');
    expect((await readNativeProjectCapture(root.project.id, { factory }))?.exchange).toBeNull();
  });

  it('新副本的操作先落 journal，再原子提交聚合和交换状态', async () => {
    const original = await createNativeProject({ name: '源作品', projectId: id('p2', '1'), canvasId: id('c2', '2') }, { factory });
    const capture: ProjectModelTransferCapture = { schemaVersion: 1, generation: 1, sessionId: 'native-project', sessionRevision: 0,
      sourceToken: 'a'.repeat(64), includesHistory: false, aggregate: { ...original, previews: [], bindings: [] }, exchange: null, history: [], historyBindings: [] };
    const prepared = await prepareProjectModelArchiveCapture(capture, []), target = id('p2', '4');
    const material = await materializeProjectModelArchiveBusiness(prepared.payload, prepared.snapshot, null, target, 'import-1', undefined,
      { folderName: `project-${target}`, allocateId: (kind) => kind === 'canvas' ? id('c2', '5') : `r2-${id('p2', '6').slice(3)}` });
    const exchange: ProjectModelTransferExchange = { ...prepared.exchange, identities: material.identities, fileBindings: material.fileBindings };
    const canvasId = id('c2', '5');
    const editor = { id: `${canvasId}::node`, schemaVersion: 1, projectId: canvasId, nodeId: 'node', name: '剪辑', tracks: [], createdAt: 1, updatedAt: 1 };
    const clip = { id: 'clip', kind: 'video' as const, fileName: 'clip.mp4', timelineStart: 0, sourceIn: 0, sourceOut: 1 };
    const withClip = (value: typeof clip & { sourceUrl?: string; relativePath?: string }) => ({ ...editor,
      tracks: [{ id: 'track', kind: 'video' as const, name: '视频', clips: [value] }] });
    const base = { mode: 'import-new' as const, packageDigest: 'a'.repeat(64), intentDigest: 'b'.repeat(64),
      targetProjectId: target, expected: null, next: material.aggregate, exchange, idMap: material.identities, history: [], media: [] };
    for (const [operationId, value] of [
      ['missing-file', clip],
      ['remote-url', { ...clip, sourceUrl: 'https://example.invalid/video.mp4', relativePath: 'clip.mp4' }],
      ['missing-binding', { ...clip, relativePath: 'clip.mp4' }],
    ] as const) {
      await expect(prepareNativeProjectImport({ ...base, operationId, editorRecords: [withClip(value)] }, { factory }))
        .rejects.toThrow('invalid-import-editor-media');
    }
    let journal = await prepareNativeProjectImport({ operationId: 'import-1', mode: 'import-new', packageDigest: 'a'.repeat(64), intentDigest: 'b'.repeat(64),
      targetProjectId: target, expected: null, next: material.aggregate, exchange, idMap: material.identities, history: [], media: [],
      editorRecords: [editor], sourceRef: 'native-import-11111111-1111-4111-8111-111111111111', sourceFiles: [] }, { factory });
    expect(await readNativeProject(target, { factory })).toBeNull();
    expect(await listNativeVideoEditorProjectsForProject(target, { factory })).toEqual([]);
    journal = await advanceNativeProjectImport(journal.operationId, journal.sequence, 'media_publishing', undefined, { factory });
    journal = await advanceNativeProjectImport(journal.operationId, journal.sequence, 'media_ready', 'media_v1_import-1', { factory });
    journal = await commitNativeProjectImport(journal.operationId, journal.sequence, { factory });
    expect((await readNativeProjectCapture(target, { factory }))?.aggregate.canvas?.id).toBe(id('c2', '5'));
    expect(await listNativeVideoEditorProjectsForProject(target, { factory })).toEqual([editor]);
    await advanceNativeProjectImport(journal.operationId, journal.sequence, 'finalized', undefined, { factory });
    await deleteNativeProject({ projectId: target, expectedProjectEpoch: material.aggregate.project.epoch, expectedChangeRevision: 0 }, { factory });
    expect(await readNativeProject(target, { factory })).toBeNull();
  });
  it('作品和分集元数据按各自版本更新，过期写入不能覆盖', async () => {
    const root = await createNativeProject({ name: '作品', kind: 'series', projectId: id('p2', '1') }, { factory });
    const initial = await createNativeEpisode({ projectId: root.project.id, expectedProjectEpoch: root.project.epoch,
      episodeId: id('e2', '2'), canvasId: id('c2', '3'), name: '第一集' }, { factory });
    const renamed = await updateNativeProjectMetadata({ projectId: root.project.id, expectedProjectEpoch: initial.project.epoch,
      name: '新作品名', defaultSettings: { promptSuffix: '风格' } }, { factory });
    expect(renamed.project).toMatchObject({ name: '新作品名', epoch: initial.project.epoch + 1,
      defaultSettings: { promptSuffix: '风格' } });
    await expect(updateNativeProjectMetadata({ projectId: root.project.id, expectedProjectEpoch: initial.project.epoch,
      name: '过期名称' }, { factory })).rejects.toThrow('project-version-conflict');
    const episode = renamed.episodes[0];
    const updated = await updateNativeEpisodeMetadata({ projectId: root.project.id, expectedProjectEpoch: renamed.project.epoch,
      episodeId: episode.id, expectedEpisodeRevision: episode.revision, name: '新集名',
      settingsPolicy: { mode: 'inherit', overrides: { visionModelId: { op: 'set', value: 'vision' } } } }, { factory });
    expect(updated.episodes[0]).toMatchObject({ name: '新集名', revision: episode.revision + 1 });
    await expect(updateNativeEpisodeMetadata({ projectId: root.project.id, expectedProjectEpoch: renamed.project.epoch,
      episodeId: episode.id, expectedEpisodeRevision: episode.revision, name: '过期集名' }, { factory }))
      .rejects.toThrow('episode-version-conflict');
    expect((await readNativeProject(root.project.id, { factory }))?.episodes[0].name).toBe('新集名');
  });

  it('分集配置和正文同事务更新，任一版本冲突均保留原内容', async () => {
    const root = await createNativeProject({ name: '作品', kind: 'series', projectId: id('p2', '1') }, { factory });
    const created = await createNativeEpisode({ projectId: root.project.id, expectedProjectEpoch: root.project.epoch,
      episodeId: id('e2', '2'), canvasId: id('c2', '3'), name: '一' }, { factory });
    const input = { projectId: root.project.id, expectedProjectEpoch: created.project.epoch, episodeId: id('e2', '2'),
      expectedCanvasId: id('c2', '3'), expectedEpisodeRevision: 0, expectedContentRevision: 0,
      contentPatch: { outline: '新大纲' }, creationProfile: { id: 'profile', version: '1.0.0', sha256: 'a'.repeat(64) } };
    await expect(updateNativeEpisodeComposite({ ...input, expectedContentRevision: 2 }, { factory })).rejects.toThrow('episode-version-conflict');
    expect((await readNativeProject(root.project.id, { factory }))?.episodeContents[0].outline).toBeUndefined();
    const result = await updateNativeEpisodeComposite(input, { factory });
    expect(result).toMatchObject({ episode: { revision: 1, creationProfile: input.creationProfile }, content: { revision: 1, outline: '新大纲' } });
    await expect(updateNativeEpisodeComposite(input, { factory })).rejects.toThrow('episode-version-conflict');
    const cleared = await updateNativeEpisodeComposite({ ...input, expectedEpisodeRevision: 1, expectedContentRevision: 1,
      contentPatch: undefined, creationProfile: null }, { factory });
    expect(cleared.episode.creationProfile).toBeUndefined();
    expect(cleared.content.outline).toBe('新大纲');
  });
  it('每个逻辑素材根只允许映射到其专属固定分区', async () => {
    const initial = await createNativeProject({ name: '素材分区', projectId: id('p2', '1'), canvasId: id('c2', '2') }, { factory });
    const secondary = `r2-${id('p2', '3').slice(3)}`, other = `r2-${id('p2', '4').slice(3)}`;
    const primary = initial.project.storageBindings[0], folder = initial.project.dataFolder;
    const binding = { rootRef: secondary, folderName: `${folder}/roots/${secondary}`, sourceRecordIds: [], source: 'project-managed' as const };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(NATIVE_PROJECT_DATABASE_NAME); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
    });
    const replaceBindings = async (bindings: typeof initial.project.storageBindings) => new Promise<void>((resolve, reject) => {
      const tx = db.transaction('projectRoots', 'readwrite');
      tx.objectStore('projectRoots').put({ ...initial.project, storageBindings: bindings });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    try {
      await replaceBindings([primary, binding]);
      expect((await readNativeProject(initial.project.id, { factory }))?.project.storageBindings).toHaveLength(2);
      for (const bindings of [
        [primary, { ...binding, folderName: folder }],
        [primary, { ...binding, folderName: `${folder}/roots/${other}` }],
        [primary, { ...binding, folderName: `${binding.folderName}/extra` }],
        [primary, binding, { ...binding }],
        [{ ...primary, folderName: `${folder}/roots/${primary.rootRef}` }, binding],
      ]) {
        await replaceBindings(bindings);
        await expect(readNativeProject(initial.project.id, { factory })).rejects.toThrow('invalid-membership');
        await expect(listNativeProjectIdentities({ factory })).rejects.toThrow('invalid-membership');
      }
    } finally { db.close(); }
  });

  it('共享内容按域 CAS 更新并推进统一版本；过期请求不覆盖最新内容', async () => {
    const initial = await createNativeProject({ name: '共享资料', projectId: id('p2', '1'), canvasId: id('c2', '2') }, { factory });
    expect((await readNativeProjectCapture(initial.project.id, { factory }))?.changeRevision).toBe(0);
    const saved = await saveNativeProjectContent({ projectId: initial.project.id, expectedProjectEpoch: initial.project.epoch,
      expectedRevisions: { script: 0 }, patch: { script: '全剧原稿' } }, { factory });
    expect(saved).toMatchObject({ changeRevision: 1, content: { script: '全剧原稿', revisions: { script: 1, source: 0 } } });
    await expect(saveNativeProjectContent({ projectId: initial.project.id, expectedProjectEpoch: initial.project.epoch,
      expectedRevisions: { script: 0 }, patch: { script: '不应覆盖' } }, { factory })).rejects.toThrow('content-version-conflict');
    expect((await readNativeProjectContent(initial.project.id, { factory }))?.content.script).toBe('全剧原稿');
    expect((await readNativeProjectCapture(initial.project.id, { factory }))?.changeRevision).toBe(1);
  });

  it('画布、共享资料和分集正文同时提交；任一版本冲突均不留下部分保存', async () => {
    const root = await createNativeProject({ name: '剧集', kind: 'series', projectId: id('p2', '1') }, { factory });
    const created = await createNativeEpisode({ projectId: root.project.id, expectedProjectEpoch: root.project.epoch,
      episodeId: id('e2', '2'), canvasId: id('c2', '3'), name: '一' }, { factory });
    const input = { projectId: root.project.id, expectedProjectEpoch: created.project.epoch,
      canvasId: id('c2', '3'), episodeId: id('e2', '2'), expectedCanvasEpoch: 1, expectedCanvasRevision: 0,
      document: { nodes: [], edges: [], groups: [] },
      shared: { expectedRevisions: { script: 0 }, patch: { script: '全剧' } },
      episode: { expectedEpisodeRevision: 0, expectedContentRevision: 0, patch: { script: '分集' } } };
    await expect(saveNativeProjectView({ ...input, episode: { ...input.episode, expectedContentRevision: 9 } }, { factory }))
      .rejects.toThrow('episode-version-conflict');
    let after = await readNativeProjectCapture(root.project.id, { factory });
    expect(after?.aggregate.canvases[0].revision).toBe(0);
    expect(after?.aggregate.content.revisions.script).toBe(0);
    expect(after?.aggregate.episodeContents[0].revision).toBe(0);
    const saved = await saveNativeProjectView(input, { factory });
    expect(saved).toMatchObject({ canvas: { revision: 1 }, content: { script: '全剧', revisions: { script: 1 } },
      episodeContent: { script: '分集', revision: 1 }, changeRevision: 2 });
    await expect(saveNativeProjectView({ ...input, expectedCanvasRevision: 1 }, { factory })).rejects.toThrow('content-version-conflict');
    after = await readNativeProjectCapture(root.project.id, { factory });
    expect(after?.changeRevision).toBe(2);
    expect(after?.aggregate.canvases[0].revision).toBe(1);
  });

  it('整项目删除检查统一版本并保留身份墓碑；过期删除不改变任何内容', async () => {
    const root = await createNativeProject({ name: '剧集', kind: 'series', projectId: id('p2', '1') }, { factory });
    const created = await createNativeEpisode({ projectId: root.project.id, expectedProjectEpoch: root.project.epoch,
      episodeId: id('e2', '2'), canvasId: id('c2', '3'), name: '一' }, { factory });
    await saveNativeCanvas({ projectId: root.project.id, expectedProjectEpoch: created.project.epoch,
      canvasId: id('c2', '3'), episodeId: id('e2', '2'), expectedCanvasEpoch: 1, expectedCanvasRevision: 0,
      document: { nodes: [], edges: [], groups: [] } }, { factory });
    await expect(deleteNativeProject({ projectId: root.project.id, expectedProjectEpoch: created.project.epoch, expectedChangeRevision: 1 }, { factory }))
      .rejects.toThrow('project-version-conflict');
    expect((await readNativeProjectCapture(root.project.id, { factory }))?.aggregate.canvases[0].revision).toBe(1);
    await deleteNativeProject({ projectId: root.project.id, expectedProjectEpoch: created.project.epoch, expectedChangeRevision: 2 }, { factory });
    expect(await readNativeProject(root.project.id, { factory })).toBeNull();
    expect(await readNativeProjectCapture(root.project.id, { factory })).toBeNull();
    await expect(createNativeProject({ name: '复用根', projectId: root.project.id }, { factory })).rejects.toThrow('retired-identity');
    const next = await createNativeProject({ name: '其他剧集', kind: 'series', projectId: id('p2', '4') }, { factory });
    await expect(createNativeEpisode({ projectId: next.project.id, expectedProjectEpoch: next.project.epoch,
      episodeId: id('e2', '2'), canvasId: id('c2', '5'), name: '复用集' }, { factory })).rejects.toThrow('identity-conflict');
    await expect(createNativeEpisode({ projectId: next.project.id, expectedProjectEpoch: next.project.epoch,
      episodeId: id('e2', '6'), canvasId: id('c2', '3'), name: '复用画布' }, { factory })).rejects.toThrow('identity-conflict');
  });

  it('存在传输 journal 时阻止整项目删除，保留交换记录与身份墓碑', async () => {
    const root = await createNativeProject({ name: '审计', projectId: id('p2', '1'), canvasId: id('c2', '2') }, { factory });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(NATIVE_PROJECT_DATABASE_NAME); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
    });
    const change = async (keepJournal: boolean) => new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['nativeProjectExchange', 'nativeTransferJournal'], 'readwrite');
      tx.objectStore('nativeProjectExchange').put({ projectId: root.project.id, retained: true });
      if (keepJournal) tx.objectStore('nativeTransferJournal').put({ operationId: 'test-operation', projectId: root.project.id });
      else tx.objectStore('nativeTransferJournal').delete('test-operation');
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    try {
      await change(true);
      const deletion = { projectId: root.project.id, expectedProjectEpoch: root.project.epoch, expectedChangeRevision: 0 };
      await expect(deleteNativeProject(deletion, { factory })).rejects.toThrow('project-transfer-present');
      expect(await readNativeProject(root.project.id, { factory })).not.toBeNull();
      await change(false);
      await deleteNativeProject(deletion, { factory });
      expect(await readNativeProjectCapture(root.project.id, { factory })).toBeNull();
      const exchange = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction('nativeProjectExchange').objectStore('nativeProjectExchange').get(root.project.id);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      expect(exchange).toEqual({ projectId: root.project.id, retained: true });
    } finally { db.close(); }
  });

  it('单集读写只访问该集正文与画布；其他画布损坏不被覆盖，整体捕获仍会拒绝', async () => {
    const initial = await createNativeProject({ name: '剧集', kind: 'series', projectId: id('p2', '1') }, { factory });
    const first = await createNativeEpisode({ projectId: initial.project.id, expectedProjectEpoch: 1, name: '一',
      episodeId: id('e2', '2'), canvasId: id('c2', '3') }, { factory });
    const second = await createNativeEpisode({ projectId: initial.project.id, expectedProjectEpoch: first.project.epoch, name: '二',
      episodeId: id('e2', '4'), canvasId: id('c2', '5') }, { factory });
    const other = second.canvases.find((item) => item.id === id('c2', '5'))!;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(NATIVE_PROJECT_DATABASE_NAME); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('canvasDocuments', 'readwrite');
        tx.objectStore('canvasDocuments').put({ ...other, nodes: 'broken-other-canvas' });
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
    const selection = await readNativeProjectSelection(initial.project.id, id('c2', '3'), { factory });
    expect(selection?.context).toMatchObject({ projectId: initial.project.id, episodeId: id('e2', '2'), canvasId: id('c2', '3') });
    const saved = await saveNativeCanvas({ projectId: initial.project.id, expectedProjectEpoch: second.project.epoch,
      canvasId: id('c2', '3'), episodeId: id('e2', '2'), expectedCanvasEpoch: 1, expectedCanvasRevision: 0,
      document: { nodes: [], edges: [], groups: [] } }, { factory });
    expect(saved.revision).toBe(1);
    const body = await readNativeEpisodeContent(initial.project.id, id('e2', '2'), { factory });
    expect(body?.episode.canvasId).toBe(id('c2', '3'));
    await expect(readNativeProjectCapture(initial.project.id, { factory })).rejects.toThrow();
  });

  it('空库只读不创建数据库，非新模型身份不打开库', async () => {
    const open = vi.spyOn(factory, 'open');
    expect(await readNativeProject(id('p2', '1'), { factory })).toBeNull();
    expect(await factory.databases()).toEqual([]);
    open.mockClear();
    await expect(readNativeProject('旧项目', { factory })).rejects.toThrow('invalid-project-id');
    expect(open).not.toHaveBeenCalled();
  });

  it('原子创建独立根、正文与主画布；任一画布冲突不留下半个新项目', async () => {
    const first = await createNativeProject({ name: '新项目', projectId: id('p2', '1'), canvasId: id('c2', '2'), now: 1 }, { factory });
    expect((await factory.databases()).map((database) => database.name)).toEqual([NATIVE_PROJECT_DATABASE_NAME]);
    expect(await readNativeProject(first.project.id, { factory })).toEqual(first);
    expect(await readNativeProjectByCanvasId(first.canvas!.id, { factory })).toEqual(first);
    await expect(createNativeProject({ name: '重复画布', projectId: id('p2', '3'), canvasId: first.canvas!.id }, { factory })).rejects.toThrow();
    expect(await readNativeProject(id('p2', '3'), { factory })).toBeNull();
    expect((await listNativeProjectIdentities({ factory })).map((entry) => entry.project.id)).toEqual([first.project.id]);
  });

  it('普通项目转剧集保留根和画布 ID，旧画布条件不能跨转换写入', async () => {
    const initial = await createNativeProject({ name: '原项目', projectId: id('p2', '1'), canvasId: id('c2', '2'), now: 1 }, { factory });
    const converted = await convertNativeProjectToSeries({ projectId: initial.project.id, expectedProjectEpoch: initial.project.epoch,
      expectedCanvasId: initial.canvas!.id, expectedCanvasEpoch: initial.canvas!.epoch, expectedCanvasRevision: initial.canvas!.revision, expectedStandaloneRevision: 0,
      episodeId: id('e2', '3'), name: '第一集', now: 2 }, { factory });
    expect(converted.project).toMatchObject({ id: initial.project.id, kind: 'series', epoch: 2 });
    expect(converted.canvas).toMatchObject({ id: initial.canvas!.id, episodeId: id('e2', '3'), epoch: 2 });
    await expect(saveNativeCanvas({ projectId: initial.project.id, expectedProjectEpoch: initial.project.epoch,
      canvasId: initial.canvas!.id, episodeId: null, expectedCanvasEpoch: initial.canvas!.epoch, expectedCanvasRevision: 0,
      document: { nodes: [], edges: [], groups: [] } }, { factory })).rejects.toThrow('project-version-conflict');
    expect((await listNativeEpisodes(initial.project.id, { factory })).map((episode) => episode.id)).toEqual([id('e2', '3')]);
  });

  it('分集正文先保存时旧删除被拒；删除末集保留剧集且墓碑阻止 ID 重用', async () => {
    const initial = await createNativeProject({ name: '零集剧集', kind: 'series', projectId: id('p2', '1'), now: 1 }, { factory });
    expect(initial.canvas).toBeNull();
    const one = await createNativeEpisode({ projectId: initial.project.id, expectedProjectEpoch: 1, name: '第一集',
      episodeId: id('e2', '3'), canvasId: id('c2', '2'), now: 2 }, { factory });
    const deletion = { projectId: initial.project.id, expectedProjectEpoch: one.project.epoch, episodeId: id('e2', '3'),
      expectedCanvasId: id('c2', '2'), expectedEpisodeRevision: 0, expectedContentRevision: 0, expectedCanvasEpoch: 1, expectedCanvasRevision: 0 };
    await saveNativeEpisodeContent({ projectId: initial.project.id, expectedProjectEpoch: one.project.epoch, episodeId: id('e2', '3'),
      expectedCanvasId: id('c2', '2'), expectedEpisodeRevision: 0, expectedContentRevision: 0, patch: { script: '较新正文' } }, { factory });
    await expect(deleteNativeEpisode(deletion, { factory })).rejects.toThrow('episode-version-conflict');
    expect((await readNativeProject(initial.project.id, { factory }))?.episodeContents[0].script).toBe('较新正文');
    const removed = await deleteNativeEpisode({ ...deletion, expectedContentRevision: 1 }, { factory });
    expect(removed.project).toMatchObject({ id: initial.project.id, kind: 'series' });
    expect(removed.canvas).toBeNull(); expect(removed.episodes).toEqual([]);
    await expect(createNativeEpisode({ projectId: initial.project.id, expectedProjectEpoch: removed.project.epoch, name: '重用',
      episodeId: id('e2', '3'), canvasId: id('c2', '4') }, { factory })).rejects.toThrow('identity-conflict');
  });

  it('换序要求所有分集的当前 revision，画布不能直接保存新本机路径', async () => {
    const initial = await createNativeProject({ name: '剧集', kind: 'series', projectId: id('p2', '1') }, { factory });
    const one = await createNativeEpisode({ projectId: initial.project.id, expectedProjectEpoch: 1, name: '一',
      episodeId: id('e2', '2'), canvasId: id('c2', '3') }, { factory });
    const two = await createNativeEpisode({ projectId: initial.project.id, expectedProjectEpoch: one.project.epoch, name: '二',
      episodeId: id('e2', '4'), canvasId: id('c2', '5') }, { factory });
    const order = { projectId: initial.project.id, expectedProjectEpoch: two.project.epoch,
      expectedEpisodes: two.episodes.map(({ id: episodeId, revision }) => ({ id: episodeId, revision })),
      orderedEpisodeIds: [id('e2', '4'), id('e2', '2')] };
    expect((await reorderNativeEpisodes(order, { factory })).map((episode) => episode.id)).toEqual(order.orderedEpisodeIds);
    await expect(reorderNativeEpisodes(order, { factory })).rejects.toThrow('project-version-conflict');
    const current = (await readNativeProject(initial.project.id, { factory }))!;
    const canvas = current.canvases.find((item) => item.id === id('c2', '3'))!;
    await expect(saveNativeCanvas({ projectId: initial.project.id, expectedProjectEpoch: current.project.epoch,
      canvasId: canvas.id, episodeId: canvas.episodeId, expectedCanvasEpoch: canvas.epoch, expectedCanvasRevision: canvas.revision,
      document: { nodes: [{ id: 'n', data: { filePath: 'C:\\user\\private.png' } }], edges: [], groups: [] } }, { factory })).rejects.toThrow();
  });

  it.each(['data:image/png;base64,YQ==', 'data:video/mp4;base64,YQ==', 'data:audio/wav;base64,YQ==',
    '  DATA:application/octet-stream;base64,YQ=='])('未落盘的内联数据 %s 不能作为新画布内容保存', async (url) => {
    const initial = await createNativeProject({ name: '素材', projectId: id('p2', '1'), canvasId: id('c2', '2') }, { factory });
    await expect(saveNativeCanvas({ projectId: initial.project.id, expectedProjectEpoch: initial.project.epoch,
      canvasId: initial.canvas!.id, episodeId: null, expectedCanvasEpoch: initial.canvas!.epoch, expectedCanvasRevision: 0,
      document: { nodes: [{ id: 'node', data: { unknown: { media: url } } }], edges: [], groups: [] } }, { factory }))
      .rejects.toThrow('inline-media-not-persisted');
    expect((await readNativeProject(initial.project.id, { factory }))?.canvas?.revision).toBe(0);
  });

  it('笔记、提示词和文本节点输出可以把 data: 当普通文字', async () => {
    const initial = await createNativeProject({ name: '文本', projectId: id('p2', '1'), canvasId: id('c2', '2') }, { factory });
    const nodes = [
      { id: 'note', data: { type: 'canvas-note', note: { kind: 'text', text: 'data: 笔记正文' } } },
      { id: 'text', data: { type: 'ai-text', prompt: 'data: 提示词', output: 'data:image/png;base64,作为文本示例' } },
    ];
    const saved = await saveNativeCanvas({ projectId: initial.project.id, expectedProjectEpoch: initial.project.epoch,
      canvasId: initial.canvas!.id, episodeId: null, expectedCanvasEpoch: initial.canvas!.epoch, expectedCanvasRevision: 0,
      document: { nodes, edges: [], groups: [] } }, { factory });
    expect(saved.nodes).toEqual(nodes);
  });

  it.each(['text', 'prompt', 'label', 'output'])('未知嵌套字段不能借 %s 冒充文本豁免', async (field) => {
    const initial = await createNativeProject({ name: '未知字段', projectId: id('p2', '1'), canvasId: id('c2', '2') }, { factory });
    await expect(saveNativeCanvas({ projectId: initial.project.id, expectedProjectEpoch: initial.project.epoch,
      canvasId: initial.canvas!.id, episodeId: null, expectedCanvasEpoch: initial.canvas!.epoch, expectedCanvasRevision: 0,
      document: { nodes: [{ id: 'node', data: { type: 'ai-text', unknown: { [field]: 'data:image/png;base64,YQ==' } } }], edges: [], groups: [] } },
    { factory })).rejects.toThrow('inline-media-not-persisted');
  });

  it('已保存的完全相同旧内联值可保留，但不能新增另一个内联值', async () => {
    const initial = await createNativeProject({ name: '兼容', projectId: id('p2', '1'), canvasId: id('c2', '2') }, { factory });
    const inline = 'data:image/png;base64,YQ==';
    const existing = { ...initial.canvas!, nodes: [{ id: 'node', data: { url: inline, text: '旧文字' } }] };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(NATIVE_PROJECT_DATABASE_NAME); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('canvasDocuments', 'readwrite'); tx.objectStore('canvasDocuments').put(existing);
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
    const input = { projectId: initial.project.id, expectedProjectEpoch: initial.project.epoch, canvasId: existing.id,
      episodeId: null, expectedCanvasEpoch: existing.epoch, expectedCanvasRevision: existing.revision,
      document: { nodes: [{ id: 'node', data: { url: inline, text: '新文字' } }], edges: [], groups: [] } };
    expect((await saveNativeCanvas(input, { factory })).revision).toBe(1);
    await expect(saveNativeCanvas({ ...input, expectedCanvasRevision: 1,
      document: { ...input.document, nodes: [...input.document.nodes, { id: 'extra', data: { url: inline } }] } }, { factory }))
      .rejects.toThrow('inline-media-not-persisted');
    await expect(saveNativeCanvas({ ...input, expectedCanvasRevision: 1,
      document: { ...input.document, nodes: [{ id: 'node', data: { url: 'data:image/png;base64,Yg==' } }] } }, { factory }))
      .rejects.toThrow('inline-media-not-persisted');
  });
});

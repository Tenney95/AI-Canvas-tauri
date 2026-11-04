/** 真实业务适配的跨设备往返；旧包准备仅隔离原生 IO 与 Worker 传输。 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureExchangeSnapshot, materializeExchangeSnapshot, validateExchangeDomain, type ArchiveAssetDigest } from '../../src/services/projectExchangeDomain';
import type { ProjectSaveData } from '../../src/services/storageService';
import type { ProjectExchangeIdentity, ProjectExchangeMedia, ProjectExchangeState } from '../../src/types/projectExchange';
import { normalizeDramaAssetLibrary } from '../../src/types/dramaAssets';
import { parseProjectExchangeState } from '../../src/services/indexedDb/projectExchangeRepository';
import { createProjectExchangeRevision } from '../../src/services/projectExchangeFormat';
const archiveMocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: archiveMocks.invoke, convertFileSrc: (value: string) => value }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: archiveMocks.open }));
vi.mock('../../src/services/fileService', () => ({ isTauriEnv: () => true,
  buildProjectFolderName: (name: string, id: string) => `${name}-${id}`, registerProjectFolder: vi.fn(),
  ensureProjectDataDir: async () => '/preview', deleteProjectDataDir: async () => undefined }));
vi.mock('../../src/services/projectMergeWorkerClient', () => ({
  captureProjectSnapshot: (...args: Parameters<typeof captureExchangeSnapshot>) => captureExchangeSnapshot(...args),
}));
beforeEach(() => vi.stubGlobal('crypto', webcrypto)); afterEach(() => vi.unstubAllGlobals());
describe('项目规范快照往返', () => {
  it.each(['episode', 'node'] as const)('新建实体的身份映射只保存身份字段（%s）', (kind) => {
    const source: ProjectSaveData = { id: 'root', name: '项目', nodes: [], edges: [], createdAt: 1, updatedAt: 2 };
    const records = kind === 'episode' ? [source, { ...source, id: 'episode', parentId: source.id }]
      : [{ ...source, nodes: [{ id: 'text', type: 'source-text', data: { type: 'source-text', output: '原文' } }] }];
    const captured = captureExchangeSnapshot(records, [], null);
    const identities: ProjectExchangeIdentity[] = [{ kind: 'project', scopeId: 'root', id: 'root', localId: 'recipient' }];
    const restored = materializeExchangeSnapshot(captured.snapshot, identities, [], '接收方目录', captured.files);
    const state: ProjectExchangeState = { ownerId: restored[0].id, rootProjectId: 'root', lineageId: captured.snapshot.lineageId,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities };
    expect(() => parseProjectExchangeState(state)).not.toThrow();
    for (const identity of identities) expect(Object.keys(identity).sort()).toEqual(['id', 'kind', 'localId', 'scopeId']);
    expect(captureExchangeSnapshot(restored, [], state, captured.snapshot).snapshot).toEqual(captured.snapshot);
  });

  it('拒绝合并后失去父对象的子实体，以及循环子对象列表', () => {
    const source: ProjectSaveData = { id: 'root', name: '项目', nodes: [], edges: [], createdAt: 1, updatedAt: 1 };
    const captured = captureExchangeSnapshot([source], [], null);
    const orphan = { kind: 'action' as const, scopeId: 'root', id: 'orphan', data: {}, references: [] };
    expect(() => validateExchangeDomain({ ...captured.snapshot, entities: [...captured.snapshot.entities, orphan] })).toThrow('所属对象');
    const cyclic = { ...orphan, data: { actionsIds: ['orphan'] } };
    expect(() => validateExchangeDomain({ ...captured.snapshot, entities: [...captured.snapshot.entities, cyclic] })).toThrow('循环');
  });
  it('旧项目无资产库时，规范化空库后保持相同业务快照', () => {
    const source: ProjectSaveData = { id: 'root', name: '空库', nodes: [], edges: [], createdAt: 1, updatedAt: 2 };
    const captured = captureExchangeSnapshot([source], [], null);
    const records = materializeExchangeSnapshot(captured.snapshot, [...captured.identities], [source], '文件夹', captured.files, false);
    const state: ProjectExchangeState = { ownerId: 'root', lineageId: captured.snapshot.lineageId, rootProjectId: 'root',
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: captured.identities };
    expect(captureExchangeSnapshot(records, [], state, captured.snapshot).snapshot).toEqual(captured.snapshot);
  });
  it('不同项目 ID、目录和中文媒体名称下，第二次导出仍保持逻辑身份', () => {
    const source: ProjectSaveData = { id: 'root', name: '剧集', nodes: [], edges: [], createdAt: 1, updatedAt: 2 };
    const episode = { ...source, id: 'episode', parentId: 'root', nodes: [{ id: 'n', type: 'source-image', position: { x: 0, y: 0 }, data: { relativePath: '图片/人物.png' } }] };
    const assets = [{ path: '图片/人物.png', bytes: 10, sha256: 'a'.repeat(64) }];
    const captured = captureExchangeSnapshot([source, episode], assets, null);
    const identities: ProjectExchangeIdentity[] = [{ kind: 'project', scopeId: 'root', id: 'root', localId: 'recipient' }];
    const paths = new Map([...captured.files].map(([id]) => [id, `imports/op/${id}/人物.png`]));
    const imported = materializeExchangeSnapshot(captured.snapshot, identities, [], '接收方目录', paths);
    for (const [id, path] of paths) identities.push({ kind: 'file', scopeId: 'root', id, localId: path });
    const state: ProjectExchangeState = { ownerId: 'recipient', lineageId: captured.snapshot.lineageId, rootProjectId: 'root', headRevisionId: 'b'.repeat(64), stateVersion: 1, identities };
    const receivedAssets = [...paths.values()].map((path) => ({ ...assets[0], path }));
    expect(captureExchangeSnapshot(imported, receivedAssets, state, captured.snapshot).snapshot).toEqual(captured.snapshot);
  });
});

describe('无扩展文件的媒体身份与旧 v3 兼容', () => {
  const project = (path: string): ProjectSaveData => ({ id: 'root', name: '原稿', nodes: [
    { id: 'file', type: 'source-text', data: { type: 'source-text', relativePath: path } },
  ], edges: [], groups: [], createdAt: 1, updatedAt: 2 });
  function legacy(name: 'LICENSE' | 'png') {
    const source = project(name), asset = { path: name, bytes: 10, sha256: 'a'.repeat(64) };
    const captured = captureExchangeSnapshot([source], [asset], null);
    const descriptor: ProjectExchangeMedia = { id: `${asset.sha256}_${name.toLowerCase()}`, sha256: asset.sha256, bytes: asset.bytes,
      extension: name.toLowerCase(), kind: name === 'png' ? 'image' : 'file' };
    const snapshot = validateExchangeDomain({ ...captured.snapshot, media: [descriptor], entities: captured.snapshot.entities.map((entity) =>
      entity.kind === 'file' ? { ...entity, data: { ...entity.data, mediaId: descriptor.id } } : entity) });
    return { source, asset, captured, descriptor, snapshot };
  }

  it.each([
    { path: 'LICENSE', bytes: 0, extension: 'bin' }, { path: 'LICENSE', bytes: 10, extension: 'bin' },
    { path: 'png', bytes: 10, extension: 'bin' }, { path: '制作.v1/LICENSE', bytes: 10, extension: 'bin' },
    { path: '.gitignore', bytes: 10, extension: 'gitignore' },
  ])('新捕获 $path（$bytes 字节）只按文件名后缀分类，受管目录往返不漂移', ({ path, bytes, extension }) => {
    const asset = { path, bytes, sha256: 'a'.repeat(64) }, captured = captureExchangeSnapshot([project(path)], [asset], null);
    expect(captured.snapshot.media).toEqual([{ id: `${asset.sha256}_${extension}`, sha256: asset.sha256, bytes, extension, kind: 'file' }]);
    const identities: ProjectExchangeIdentity[] = [{ kind: 'project', scopeId: 'root', id: 'root', localId: 'recipient' }];
    const paths = new Map([...captured.files].map(([id]) => [id, `imports/operation/${id}/${path.split('/').pop()}`]));
    for (const [id, localId] of paths) identities.push({ kind: 'file', scopeId: 'root', id, localId });
    const records = materializeExchangeSnapshot(captured.snapshot, identities, [], '接收目录', paths);
    const state = parseProjectExchangeState({ ownerId: 'recipient', rootProjectId: 'root', lineageId: captured.snapshot.lineageId,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities });
    const assets = [...paths.values()].map((name) => ({ ...asset, path: name }));
    expect(captureExchangeSnapshot(records, assets, state, captured.snapshot).snapshot).toEqual(captured.snapshot);
  });

  it.each(['LICENSE', 'png'] as const)('旧 v3 根文件 %s 通过真实准备校验，迁入受管目录后仍复用原描述', async (name) => {
    const { source, asset, captured, snapshot } = legacy(name), head = await createProjectExchangeRevision(snapshot);
    const state: ProjectExchangeState = { ownerId: 'root', rootProjectId: 'root', lineageId: snapshot.lineageId,
      headRevisionId: head.revisionId, stateVersion: 1, identities: captured.identities };
    archiveMocks.open.mockResolvedValue('/incoming/legacy.aicanvas');
    archiveMocks.invoke.mockResolvedValue({ assets: [asset], texts: {
      'manifest.json': JSON.stringify({ formatVersion: 3, exportedAt: 1, projectId: source.id, projectName: source.name, episodeCount: 0 }),
      'project.json': JSON.stringify(source), 'exchange-state.json': JSON.stringify(state),
      'exchange.json': JSON.stringify({ format: 'ai-canvas-project-exchange', version: 1, packageId: 'package', lineageId: state.lineageId,
        headRevisionId: head.revisionId, revisions: [head], ancestors: [], files: [{ mediaId: snapshot.media[0].id, archivePath: `assets/${name}` }] }),
    } });
    const { prepareProjectImport, closePreparedProjectImport } = await import('../../src/services/projectImportService');
    const session = await prepareProjectImport();
    expect(session?.bundle?.headRevisionId).toBe(head.revisionId);
    try {
      const paths = new Map([...captured.files].map(([id]) => [id, `imports/operation/${id}/${name}`]));
      const identities: ProjectExchangeIdentity[] = [{ kind: 'project', scopeId: 'root', id: 'root', localId: 'recipient' },
        ...[...paths].map(([id, localId]) => ({ kind: 'file' as const, scopeId: 'root', id, localId }))];
      const records = materializeExchangeSnapshot(snapshot, identities, [], '接收目录', paths);
      const received = parseProjectExchangeState({ ...state, ownerId: 'recipient', identities });
      expect(captureExchangeSnapshot(records, [...paths.values()].map((path) => ({ ...asset, path })), received, snapshot).snapshot).toEqual(snapshot);
    } finally { if (session) await closePreparedProjectImport(session); }
  });

  it.each(['sha', 'bytes', 'rename', 'descriptor'] as const)('旧描述兼容不吞掉 %s 变化或任意媒体描述', (change) => {
    const fixture = legacy('LICENSE'), snapshot = structuredClone(fixture.snapshot);
    const asset: ArchiveAssetDigest = { ...fixture.asset };
    const identities = structuredClone(fixture.captured.identities);
    if (change === 'sha') asset.sha256 = 'b'.repeat(64);
    if (change === 'bytes') asset.bytes += 1;
    if (change === 'rename') {
      asset.path = 'license';
      identities.find((identity) => identity.kind === 'file')!.localId = asset.path;
    }
    if (change === 'descriptor') {
      snapshot.media[0] = { ...snapshot.media[0], id: `${asset.sha256}_png`, extension: 'png', kind: 'image' };
      snapshot.entities.find((entity) => entity.kind === 'file')!.data.mediaId = snapshot.media[0].id;
    }
    const state: ProjectExchangeState = { ownerId: 'root', rootProjectId: 'root', lineageId: snapshot.lineageId,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities };
    const next = captureExchangeSnapshot([project(asset.path)], [asset], state, snapshot);
    expect(next.snapshot.media[0]).toEqual({ id: `${asset.sha256}_bin`, sha256: asset.sha256, bytes: asset.bytes, extension: 'bin', kind: 'file' });
  });
});

describe('项目正文与内部导入文件的往返边界', () => {
  it.each(['ai-text', 'source-text', 'ai-markdown'])('%s 保留协议开头的直接正文，嵌套媒体仍清理本机投影', (type) => {
    const output = 'https://example.com/参考资料\n\n中文正文与末尾内容';
    const source: ProjectSaveData = { id: 'root', name: '正文项目', createdAt: 1, updatedAt: 2, edges: [], nodes: [
      { id: 'text', type, data: { type, output, relativePath: '正文.md',
        preview: { relativePath: '图片.png', imageUrl: 'asset://localhost/private/image.png', output: 'https://example.com/image.png' } } },
    ] };
    const assets = [{ path: '正文.md', bytes: 10, sha256: 'a'.repeat(64) }, { path: '图片.png', bytes: 20, sha256: 'b'.repeat(64) }];
    const captured = captureExchangeSnapshot([source], assets, null);
    const data = captured.snapshot.entities.find((entity) => entity.kind === 'node')!.data.data as Record<string, unknown>;
    expect(data.output).toBe(output);
    expect(data.preview).toEqual({ relativePath: expect.stringMatching(/^exchange-file:/) });
    const identities = structuredClone(captured.identities);
    const records = materializeExchangeSnapshot(captured.snapshot, identities, [], '接收端目录', captured.files);
    const state: ProjectExchangeState = { ownerId: records[0].id, lineageId: captured.snapshot.lineageId, rootProjectId: 'root',
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities };
    expect(captureExchangeSnapshot(records, assets, state, captured.snapshot).snapshot).toEqual(captured.snapshot);
  });

  it.each([
    ['ai-image', 'imageUrl', '图片.png'], ['ai-video', 'videoUrl', '视频.mp4'], ['ai-audio', 'audioUrl', '音频.wav'],
  ])('%s 的 output 和主媒体地址继续作为投影清理，旧快照往返不变', (type, field, path) => {
    const source: ProjectSaveData = { id: 'root', name: '媒体项目', createdAt: 1, updatedAt: 2, edges: [], nodes: [
      { id: 'media', type, data: { type, relativePath: path, output: 'https://example.com/generated', [field]: 'asset://localhost/private/media' } },
    ] };
    const assets = [{ path, bytes: 10, sha256: 'a'.repeat(64) }];
    const captured = captureExchangeSnapshot([source], assets, null);
    expect(captured.snapshot.entities.find((entity) => entity.kind === 'node')!.data.data).toEqual({ type, relativePath: expect.stringMatching(/^exchange-file:/) });
    const records = materializeExchangeSnapshot(captured.snapshot, [...captured.identities], [source], '项目目录', captured.files);
    const state: ProjectExchangeState = { ownerId: 'root', lineageId: captured.snapshot.lineageId, rootProjectId: 'root',
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: captured.identities };
    expect(captureExchangeSnapshot(records, assets, state, captured.snapshot).snapshot).toEqual(captured.snapshot);
  });

  it.each(['imports', 'Imports', 'IMPORTS'])('首次建立来源时保留当前引用的 %s 和普通附件，排除无引用恢复点与失败残留', (directory) => {
    const current = `${directory}/current-op/current.png`;
    const source: ProjectSaveData = { id: 'root', name: '旧包更新后的项目', createdAt: 1, updatedAt: 2, edges: [],
      nodes: [{ id: 'image', type: 'ai-image', data: { relativePath: current } }] };
    const assets = [current, '附件/制作说明.md', `${directory}/recovery-op/旧图.png`, `${directory}/failed-op/孤儿.png`]
      .map((path, index) => ({ path, bytes: 10, sha256: String(index + 1).repeat(64) }));
    const captured = captureExchangeSnapshot([source], assets, null);
    expect([...captured.files.values()]).toEqual([current, '附件/制作说明.md']);
    const records = materializeExchangeSnapshot(captured.snapshot, [...captured.identities], [source], '项目目录', captured.files);
    const state: ProjectExchangeState = { ownerId: 'root', rootProjectId: 'root', lineageId: captured.snapshot.lineageId,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: captured.identities };
    expect(captureExchangeSnapshot(records, assets, state, captured.snapshot).snapshot).toEqual(captured.snapshot);
  });

  it.each(['imports', 'Imports', 'IMPORTS'])('已确认的 %s 文件映射可作为未引用附件保留', (directory) => {
    const path = `${directory}/confirmed-op/原稿.txt`;
    const source: ProjectSaveData = { id: 'root', name: '已确认附件', createdAt: 1, updatedAt: 2, edges: [], nodes: [] };
    const assets = [{ path, bytes: 1, sha256: 'a'.repeat(64) }];
    const state: ProjectExchangeState = { ownerId: 'root', rootProjectId: 'root', lineageId: 'lineage', headRevisionId: 'a'.repeat(64),
      stateVersion: 1, identities: [{ kind: 'file', scopeId: 'root', id: 'confirmed-file', localId: path }] };
    const captured = captureExchangeSnapshot([source], assets, state);
    expect([...captured.files]).toEqual([['confirmed-file', path]]);
  });
});

describe('项目缺失素材定位', () => {
  const project = (): ProjectSaveData => ({ id: 'root', name: '剧集', nodes: [], edges: [], createdAt: 1, updatedAt: 2 });
  const path = '生成图像_4.png';

  it.each([
    { name: '节点产物', type: 'ai-image', field: 'data.relativePath', data: { relativePath: path } },
    { name: '图片身份', type: 'source-image', field: 'data.imageRelativePath', data: { imageRelativePath: path } },
    { name: '嵌套参考图', type: 'ai-image', field: 'data.referenceImages[0].relativePath', data: { referenceImages: [{ id: 'reference', relativePath: path }] } },
    { name: '旧版原生文件', type: 'source-image', field: 'data.filePath', data: { filePath: `C:/projects/example/${path}` } },
    { name: '导演截图相对路径', type: 'ai-director', field: 'data.directorCaptureRelativePaths[0]', data: { directorCaptureRelativePaths: [path] } },
    { name: '导演截图原生路径', type: 'ai-director', field: 'data.directorCaptureFilePaths[0]', data: { directorCaptureFilePaths: [`C:/projects/example/${path}`] } },
  ])('$name缺失时指出正确分集、节点及具体字段，不暴露原生路径', ({ type, data, field }) => {
    const owner = project();
    const episode = { ...project(), id: 'episode', parentId: owner.id, name: 'EP000',
      nodes: [{ id: 'missing-image-node', type, position: { x: 0, y: 0 }, data: { label: '角色定妆图', displayId: 42, ...data } }] };
    expect(() => captureExchangeSnapshot([owner, episode], [], null, undefined, 'C:/projects/example')).toThrow(
      `项目引用的素材缺失：${path}；引用位置：项目「剧集」 → 分集「EP000」 → 节点 #42「角色定妆图」（ID：missing-image-node）；引用字段：${field}。请恢复文件或重新选择素材后重试。`,
    );
  });

  it('没有名称和展示编号的旧节点仍可通过节点 ID 定位', () => {
    const source = { ...project(), nodes: [{ id: 'legacy-node', type: 'source-image', data: { relativePath: path } }] };
    expect(() => captureExchangeSnapshot([source], [], null)).toThrow('项目「剧集」 → 节点「未命名」（ID：legacy-node）');
  });

  it.each([
    { field: 'runninghubOutputs', identity: 'relativePath', value: path },
    { field: 'workflowApiOutputs', identity: 'relativePath', value: path },
    { field: 'runninghubOutputs', identity: 'filePath', value: `C:/projects/example/${path}` },
    { field: 'workflowApiOutputs', identity: 'filePath', value: `C:/projects/example/${path}` },
  ])('主图片存在时忽略 $field 的失效单产物 $identity，保留源数据', ({ field, identity, value }) => {
    const source = { ...project(), nodes: [{ id: 'image-node', type: 'ai-image', data: { label: '当前图片', displayId: 173,
      relativePath: '当前.png', [field]: [{ kind: 'image', [identity]: value }] } }] };
    const original = structuredClone(source);
    const captured = captureExchangeSnapshot([source], [{ path: '当前.png', bytes: 1, sha256: 'a'.repeat(64) }], null, undefined, 'C:/projects/example');
    expect(captured.snapshot.entities.find((entity) => entity.kind === 'node')?.data.data).not.toHaveProperty(field);
    expect([...captured.files.values()]).toEqual(['当前.png']);
    expect(source).toEqual(original);
  });

  it.each(['runninghubOutputs', 'workflowApiOutputs'])('仍存在的 %s 单产物保留身份，旧包往返快照不变', (field) => {
    const source = { ...project(), nodes: [{ id: 'image-node', type: 'ai-image', data: { label: '当前图片',
      relativePath: '当前.png', [field]: [{ kind: 'image', relativePath: path, nodeId: 'workflow-result' }] } }] };
    const assets = [{ path: '当前.png', bytes: 1, sha256: 'a'.repeat(64) }, { path, bytes: 2, sha256: 'b'.repeat(64) }];
    const captured = captureExchangeSnapshot([source], assets, null);
    expect(captured.snapshot.entities.find((entity) => entity.kind === 'node')?.data.data).toMatchObject({
      [field]: [{ kind: 'image', relativePath: expect.stringMatching(/^exchange-file:/), nodeId: 'workflow-result' }],
    });
    const records = materializeExchangeSnapshot(captured.snapshot, [...captured.identities], [source], '项目目录', captured.files, false);
    const state: ProjectExchangeState = { ownerId: source.id, rootProjectId: source.id, lineageId: captured.snapshot.lineageId,
      headRevisionId: 'c'.repeat(64), stateVersion: 1, identities: captured.identities };
    expect(captureExchangeSnapshot(records, assets, state, captured.snapshot).snapshot).toEqual(captured.snapshot);
  });

  it.each(['runninghubOutputs', 'workflowApiOutputs'])('%s 多产物中的缺失文件继续阻止导出', (field) => {
    const source = { ...project(), nodes: [{ id: 'image-node', type: 'ai-image', data: { relativePath: '当前.png',
      [field]: [{ kind: 'image', relativePath: path }, { kind: 'image', relativePath: '当前.png' }] } }] };
    expect(() => captureExchangeSnapshot([source], [{ path: '当前.png', bytes: 1, sha256: 'a'.repeat(64) }], null, undefined, 'C:/projects/example'))
      .toThrow(`引用字段：data.${field}[0].relativePath`);
  });

  it('主图缺失时不以旧缓存为由跳过当前图片', () => {
    const source = { ...project(), nodes: [{ id: 'image-node', type: 'ai-image', data: { relativePath: '当前.png',
      runninghubOutputs: [{ kind: 'image', relativePath: path }] } }] };
    expect(() => captureExchangeSnapshot([source], [], null)).toThrow('引用字段：data.relativePath');
  });

  it('类型不同的单产物不作为当前图片的冗余缓存清理', () => {
    const source = { ...project(), nodes: [{ id: 'image-node', type: 'ai-image', data: { relativePath: '当前.png',
      runninghubOutputs: [{ kind: 'video', relativePath: '片段.mp4' }] } }] };
    expect(() => captureExchangeSnapshot([source], [{ path: '当前.png', bytes: 1, sha256: 'a'.repeat(64) }], null))
      .toThrow('引用字段：data.runninghubOutputs[0].relativePath');
  });

  it.each(['../越界.png', 'C:/private.png'])('单产物的不安全路径 %s 不能当作失效缓存忽略', (relativePath) => {
    const source = { ...project(), nodes: [{ id: 'image-node', type: 'ai-image', data: { relativePath: '当前.png',
      runninghubOutputs: [{ kind: 'image', relativePath }] } }] };
    expect(() => captureExchangeSnapshot([source], [{ path: '当前.png', bytes: 1, sha256: 'a'.repeat(64) }], null)).toThrow('不安全');
  });

  it('单产物带有未知业务引用时保留原校验', () => {
    const source = { ...project(), nodes: [{ id: 'image-node', type: 'ai-image', data: { relativePath: '当前.png',
      runninghubOutputs: [{ kind: 'image', relativePath: path, referenceImages: [{ relativePath: '参考.png' }] }] } }] };
    expect(() => captureExchangeSnapshot([source], [{ path: '当前.png', bytes: 1, sha256: 'a'.repeat(64) }], null))
      .toThrow('引用字段：data.runninghubOutputs[0].relativePath');
  });

  it('其他真实引用仍指向旧文件时继续报错', () => {
    const source = { ...project(), nodes: [{ id: 'image-node', type: 'ai-image', data: { relativePath: '当前.png',
      runninghubOutputs: [{ kind: 'image', relativePath: path }], referenceImages: [{ id: 'reference', relativePath: path }] } }] };
    expect(() => captureExchangeSnapshot([source], [{ path: '当前.png', bytes: 1, sha256: 'a'.repeat(64) }], null))
      .toThrow('引用字段：data.referenceImages[0].relativePath');
  });

  it.each([['Old.png', 'old.png'], ['e\u0301.png', 'é.png']])('旧路径 %s 与实际文件 %s 仅规范形式不同时不能清除', (oldPath, actualPath) => {
    const source = { ...project(), nodes: [{ id: 'image-node', type: 'ai-image', data: { relativePath: '当前.png',
      runninghubOutputs: [{ kind: 'image', relativePath: oldPath }] } }] };
    const assets = [{ path: '当前.png', bytes: 1, sha256: 'a'.repeat(64) }, { path: actualPath, bytes: 2, sha256: 'b'.repeat(64) }];
    expect(() => captureExchangeSnapshot([source], assets, null)).toThrow('引用字段：data.runninghubOutputs[0].relativePath');
  });

  it('分镜表中的缺失画面保留所属节点和镜号', () => {
    const source = { ...project(), nodes: [{ id: 'shotlist', type: 'ai-shotlist', data: { label: '开场分镜', displayId: 8,
      shotlistRows: [{ id: 'shot-row', shotNo: '3a', frame: { nodeId: 'deleted-image', kind: 'image', filePath: `C:/projects/example/${path}` } }] } }] };
    expect(() => captureExchangeSnapshot([source], [], null, undefined, 'C:/projects/example')).toThrow(
      '节点 #8「开场分镜」（ID：shotlist） → 镜头「3a」（ID：shot-row）',
    );
  });

  it.each([['characters', '角色'], ['scenes', '场景'], ['props', '道具']] as const)('资产库 %s 的缺失素材指出资产名称', (field, label) => {
    const source = { ...project(), dramaAssets: normalizeDramaAssetLibrary({ [field]: [{ id: 'asset', name: '创作资产', relativePath: path }] }) };
    expect(() => captureExchangeSnapshot([source], [], null)).toThrow(`项目「剧集」 → ${label}「创作资产」（ID：asset）`);
  });
});

describe('项目失效创作资产引用定位', () => {
  it.each([
    { name: '提示词', data: { prompt: '@drama{deleted-character#image:押运差头}' }, field: 'data.prompt' },
    { name: '工作流输入', data: { workflowInputs: [{ value: '@drama{deleted-character#voice/clip:押运差头}' }] }, field: 'data.workflowInputs[0].value' },
  ])('$name 中的失效引用指出分集、节点、资产与字段', ({ data, field }) => {
    const owner: ProjectSaveData = { id: 'root', name: '剧集', nodes: [], edges: [], createdAt: 1, updatedAt: 2 };
    const episode = { ...owner, id: 'episode', parentId: 'root', name: 'EP000', nodes: [{ id: 'node-93', type: 'ai-image',
      data: { label: '角色三视图', displayId: 93, ...data } }] };
    expect(() => captureExchangeSnapshot([owner, episode], [], null)).toThrow(
      `项目引用的创作资产缺失：押运差头（ID：deleted-character）；引用位置：项目「剧集」 → 分集「EP000」 → 节点 #93「角色三视图」（ID：node-93）；引用字段：${field}。请移除失效引用或重新选择资产后重试。`,
    );
  });
});

describe('项目协作格式错误定位', () => {
  function captureError(run: () => unknown): Error {
    try { run(); }
    catch (error) { if (error instanceof Error) return error; throw error; }
    throw new Error('预期快照捕获报告格式错误');
  }

  it.each([
    { code: 'missing_dependency', id: 'a-target', prompt: '@{missing-source:缺失节点}', field: 'entities[3].references' },
    { code: 'invalid_identity', id: 'a-target', prompt: '@{/private/invalid-node:无效引用}', field: 'entities[3].references[0].id' },
  ])('$code 保留原实体索引并指出正确项目、分集和节点', ({ code, id, prompt, field }) => {
    const owner: ProjectSaveData = { id: 'root', name: '剧集', nodes: [], edges: [], createdAt: 1, updatedAt: 2 };
    const episode = { ...owner, id: 'episode', parentId: 'root', name: 'EP000', nodes: [
      { id: 'z-unrelated', type: 'ai-image', data: { label: '无关节点', displayId: 92, prompt: '正常正文' } },
      { id, type: 'ai-image', data: { label: '错误目标', displayId: 93, prompt } },
    ] };
    const error = captureError(() => captureExchangeSnapshot([owner, episode], [], null));
    expect(error.cause).toMatchObject({ code, fieldPath: field });
    expect(error.message).toContain(field);
    expect(error.message).toContain('所属位置：项目「剧集」 → 分集「EP000」 → 节点 #93「错误目标」');
    expect(error.message).not.toContain('z-unrelated');
    expect(error.message).not.toContain('无关节点');
    expect(error.message).not.toContain('/private/');
  });

  it('零字节图片的媒体格式错误能定位对应项目文件', () => {
    const source: ProjectSaveData = { id: 'root', name: '剧集', createdAt: 1, updatedAt: 2, edges: [],
      nodes: [{ id: 'image', type: 'ai-image', data: { label: '图片', relativePath: '图像/空图片.png' } }] };
    const error = captureError(() => captureExchangeSnapshot([source], [{ path: '图像/空图片.png', bytes: 0, sha256: 'a'.repeat(64) }], null));
    expect(error.cause).toEqual({ code: 'invalid_media', fieldPath: 'media[0]' });
    expect(error.message).toContain('invalid_media');
    expect(error.message).toContain('media[0]');
    expect(error.message).toContain('所属位置：项目「剧集」 → 文件「空图片.png」');
  });
});

describe('资产参考图的历史节点出处', () => {
  const path = '角色/参考图.png';
  const prompt = '原生成说明 @{origin-node:原始图片节点}，保留历史文字';
  const assets = [{ path, bytes: 12, sha256: 'a'.repeat(64) }];
  const project = (): ProjectSaveData => ({ id: 'root', name: '剧集', nodes: [], edges: [], createdAt: 1, updatedAt: 2,
    dramaAssets: normalizeDramaAssetLibrary({ characters: [{ id: 'character', kind: 'character', name: '角色',
      primaryReferenceImageId: 'reference', referenceImages: [{ id: 'reference', kind: 'primary', relativePath: path,
        sourceNodeId: 'origin-node', prompt, createdAt: 1, updatedAt: 2 }] }] }) });

  it('参考图保留已删除来源节点的提示词和图片，不建立悬空执行依赖', () => {
    const source = project();
    const original = structuredClone(source);
    const captured = captureExchangeSnapshot([source], assets, null);
    const reference = captured.snapshot.entities.find((entity) => entity.kind === 'referenceImage')!;
    const file = captured.snapshot.entities.find((entity) => entity.kind === 'file')!;
    expect(reference.data).toMatchObject({ prompt, sourceNodeId: 'origin-node', relativePath: `exchange-file:${file.id}` });
    expect(reference.references).toEqual([{ kind: 'file', scopeId: 'root', id: file.id }]);
    expect([...captured.files.values()]).toEqual([path]);
    expect(captured.snapshot.media).toMatchObject([{ kind: 'image', bytes: 12, sha256: assets[0].sha256 }]);
    expect(source).toEqual(original);
  });

  it('来源节点仍存在时保持既有依赖，并能按原身份往返捕获', () => {
    const source = project();
    source.nodes = [{ id: 'origin-node', type: 'source-image', data: { label: '原始图片节点', type: 'source-image', relativePath: path } }];
    const captured = captureExchangeSnapshot([source], assets, null);
    const reference = captured.snapshot.entities.find((entity) => entity.kind === 'referenceImage')!;
    const file = captured.snapshot.entities.find((entity) => entity.kind === 'file')!;
    expect(reference.data.prompt).toBe(prompt);
    expect(reference.references).toEqual([{ kind: 'file', scopeId: 'root', id: file.id }, { kind: 'node', scopeId: 'root', id: 'origin-node' }]);
    const records = materializeExchangeSnapshot(captured.snapshot, [...captured.identities], [source], '项目目录', captured.files, false);
    const state: ProjectExchangeState = { ownerId: 'root', rootProjectId: 'root', lineageId: captured.snapshot.lineageId,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: captured.identities };
    expect(captureExchangeSnapshot(records, assets, state, captured.snapshot).snapshot).toEqual(captured.snapshot);
  });

  it('同样的失效节点引用用于真实节点提示词时仍阻止导出', () => {
    const source = project();
    source.nodes = [{ id: 'generator', type: 'ai-image', data: { label: '真实生成节点', type: 'ai-image', prompt } }];
    expect(() => captureExchangeSnapshot([source], assets, null)).toThrow('missing_dependency');
    expect(() => captureExchangeSnapshot([source], assets, null)).toThrow('节点「真实生成节点」（ID：generator）');
  });
});

describe('当前执行的精确创作素材引用', () => {
  const assets = [{ path: '参考.png', bytes: 10, sha256: 'a'.repeat(64) }, { path: '声音.wav', bytes: 20, sha256: 'b'.repeat(64) }];
  const project = (prompt: string) => ({ id: 'root', name: '精确引用', createdAt: 1, updatedAt: 2, edges: [],
    nodes: [{ id: 'generator', type: 'ai-image', data: { type: 'ai-image', label: '生成节点', prompt } as Record<string, unknown> }],
    dramaAssets: normalizeDramaAssetLibrary({ characters: [
      { id: 'character', kind: 'character', name: '角色', primaryReferenceImageId: 'primary', referenceImages: [
        { id: 'primary', kind: 'primary', relativePath: '参考.png' }, { id: 'selected', relativePath: '参考.png' },
      ], voiceClips: [{ id: 'voice', relativePath: '声音.wav' }], actions: [
        { id: 'action', name: '动作', media: [{ id: 'clip', kind: 'image', relativePath: '参考.png' }] },
        { id: 'another-action', name: '另一动作', media: [{ id: 'another-clip', kind: 'image', relativePath: '参考.png' }] },
      ] },
      { id: 'other-character', kind: 'character', name: '另一角色', referenceImages: [{ id: 'foreign-reference', relativePath: '参考.png' }],
        voiceClips: [{ id: 'foreign-voice', relativePath: '声音.wav' }], actions: [
          { id: 'foreign-action', name: '他人动作', media: [{ id: 'foreign-clip', kind: 'image', relativePath: '参考.png' }] },
        ] },
    ] }) });

  it.each(['character#selected', 'character#voice/voice', 'character#action/action/clip', 'character#all'])('%s 保留合法旧快照的父资产依赖和往返摘要', (mention) => {
    const source = project(`@drama{${mention}:角色}`);
    const captured = captureExchangeSnapshot([source], assets, null);
    const node = captured.snapshot.entities.find((entity) => entity.kind === 'node')!;
    expect(node.references).toEqual([{ kind: 'character', scopeId: 'root', id: 'character' }]);
    const records = materializeExchangeSnapshot(captured.snapshot, [...captured.identities], [source], '项目目录', captured.files);
    const state: ProjectExchangeState = { ownerId: 'root', rootProjectId: 'root', lineageId: captured.snapshot.lineageId,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: captured.identities };
    expect(captureExchangeSnapshot(records, assets, state, captured.snapshot).snapshot).toEqual(captured.snapshot);
  });

  it.each([
    'character#missing', 'character#foreign-reference', 'character#voice/missing', 'character#voice/foreign-voice',
    'character#voice/%', 'character#action/action/missing', 'character#action/action/another-clip',
    'character#action/foreign-action/foreign-clip', 'character#action/action',
  ])('%s 的缺失、错误归属或损坏选项阻止当前执行引用导出', (mention) => {
    const source = project(`@drama{${mention}:角色}`);
    const original = structuredClone(source);
    expect(() => captureExchangeSnapshot([source], assets, null)).toThrow('创作素材缺失或归属不一致');
    expect(() => captureExchangeSnapshot([source], assets, null)).toThrow('引用字段：data.prompt');
    expect(source).toEqual(original);
  });

  it('工作流输入中的精确引用同样校验；历史资产提示词与 global 沿用原边界', () => {
    const source = project('@drama{global/unknown#selected:全局角色}');
    source.dramaAssets.characters[0].referenceImages![0].prompt = '@drama{character#deleted-reference:历史选图}';
    const captured = captureExchangeSnapshot([source], assets, null);
    expect(captured.snapshot.entities.find((entity) => entity.kind === 'referenceImage' && entity.id === 'primary')!.data.prompt)
      .toBe('@drama{character#deleted-reference:历史选图}');
    expect(captured.snapshot.entities.find((entity) => entity.kind === 'node')!.references).toEqual([]);
    source.nodes[0].data.workflowInputs = { image: '@drama{character#missing:角色}' };
    expect(() => captureExchangeSnapshot([source], assets, null)).toThrow('引用字段：data.workflowInputs.image');
  });
});

describe('分镜虚拟引用与角色关系的领域校验', () => {
  const assets = [{ path: '参考.png', bytes: 10, sha256: 'a'.repeat(64) }, { path: '声音.wav', bytes: 20, sha256: 'b'.repeat(64) }];
  const virtualProjects = (prompt: string): ProjectSaveData[] => [
    { id: 'root', name: '剧集', createdAt: 1, updatedAt: 2, nodes: [], edges: [] },
    { id: 'episode', parentId: 'root', name: '分集', createdAt: 1, updatedAt: 2, edges: [], nodes: [
      { id: 'sheet', type: 'ai-shotlist', data: { type: 'ai-shotlist', shotlistRows: [{ id: 'row', shotNo: '1', content: '有人回家' }] } },
      { id: 'other-sheet', type: 'ai-shotlist', data: { type: 'ai-shotlist', shotlistRows: [{ id: 'other-row', content: '另一镜头' }] } },
      { id: 'board', type: 'ai-storyboard', data: { type: 'ai-storyboard', storyboardCols: 2, storyboardRows: 2, relativePath: '参考.png' } },
      { id: 'generator', type: 'ai-video', data: { type: 'ai-video', label: '生成节点', prompt } },
    ] },
  ];

  it.each(['sheet/shot/row', 'sheet/shot/%72ow', 'board/cell/0', 'board/cell/3'])('%s 关联真实分集节点，保留正文并跨设备往返', (id) => {
    const prompt = `@{${id}:精确引用}`;
    const captured = captureExchangeSnapshot(virtualProjects(prompt), assets, null);
    const node = captured.snapshot.entities.find((entity) => entity.kind === 'node' && entity.id === 'generator')!;
    expect((node.data.data as Record<string, unknown>).prompt).toBe(prompt);
    expect(node.references).toEqual([{ kind: 'node', scopeId: 'episode', id: id.split('/')[0] }]);
    const identities = structuredClone(captured.identities);
    const records = materializeExchangeSnapshot(captured.snapshot, identities, [], '接收方目录', captured.files);
    const state: ProjectExchangeState = { ownerId: records[0].id, rootProjectId: 'root', lineageId: captured.snapshot.lineageId,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities };
    expect(captureExchangeSnapshot(records, assets, state, captured.snapshot).snapshot).toEqual(captured.snapshot);
  });

  it.each([
    'missing/shot/row', 'board/shot/row', 'sheet/shot/missing', 'sheet/shot/other-row', 'sheet/shot/%',
    'missing/cell/0', 'sheet/cell/0', 'board/cell/4', 'board/cell/-1', 'board/cell/1junk', 'board/cell/00', 'board/cell/9007199254740992',
  ])('%s 的父类型、行归属或格范围错误时保留定位并拒绝', (id) => {
    expect(() => captureExchangeSnapshot(virtualProjects(`@{${id}:精确引用}`), assets, null)).toThrow('项目引用的分镜');
    expect(() => captureExchangeSnapshot(virtualProjects(`@{${id}:精确引用}`), assets, null)).toThrow('引用字段：data.prompt');
  });

  const characterProject = () => ({ id: 'root', name: '角色关系', createdAt: 1, updatedAt: 2, edges: [],
    nodes: [] as Array<{ id: string; type: string; data: Record<string, unknown> }>,
    dramaAssets: normalizeDramaAssetLibrary({ characters: [
      { id: 'hero', name: '角色', kind: 'character', primaryReferenceImageId: 'primary', avatarReferenceImageId: 'avatar', primaryVoiceClipId: 'voice',
        referenceImages: [{ id: 'primary', kind: 'primary', relativePath: '参考.png' }, { id: 'avatar', kind: 'avatar', relativePath: '参考.png' }],
        voiceClips: [{ id: 'voice', relativePath: '声音.wav' }], weaponIds: ['weapon'] },
      { id: 'other', name: '另一角色', kind: 'character', referenceImages: [{ id: 'foreign-avatar', kind: 'avatar', relativePath: '参考.png' }],
        voiceClips: [{ id: 'foreign-voice', relativePath: '声音.wav' }] },
    ], props: [{ id: 'weapon', kind: 'prop', name: '武器', propType: 'weapon' }, { id: 'ordinary', kind: 'prop', name: '普通道具' }] }),
  });

  it('有效声音、头像、武器保留旧依赖摘要；普通历史与全局引用仍沿既有边界', () => {
    const source = characterProject();
    source.nodes = [{ id: 'origin', type: 'ai-text', data: { type: 'ai-text', output: '原始说明' } },
      { id: 'generator', type: 'ai-image', data: { type: 'ai-image', prompt: '@drama{global/hero#voice/global-voice:全局角色}' } }];
    const prompt = '@{origin:普通出处} @{deleted/shot/row:历史镜头} @{deleted/cell/0:历史宫格}';
    source.dramaAssets.characters[0].referenceImages![0].prompt = prompt;
    const captured = captureExchangeSnapshot([source], assets, null);
    const hero = captured.snapshot.entities.find((entity) => entity.kind === 'character' && entity.id === 'hero')!;
    expect(hero.references.some((reference) => reference.kind === 'prop')).toBe(false);
    const reference = captured.snapshot.entities.find((entity) => entity.kind === 'referenceImage' && entity.id === 'primary')!;
    expect(reference.data.prompt).toBe(prompt);
    expect(reference.references.filter((item) => item.kind === 'node')).toEqual([{ kind: 'node', scopeId: 'root', id: 'origin' }]);
    const records = materializeExchangeSnapshot(captured.snapshot, [...captured.identities], [source], '项目目录', captured.files);
    const state: ProjectExchangeState = { ownerId: 'root', rootProjectId: 'root', lineageId: captured.snapshot.lineageId,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: captured.identities };
    expect(captureExchangeSnapshot(records, assets, state, captured.snapshot).snapshot).toEqual(captured.snapshot);
  });

  it.each([
    ['primaryVoiceClipId', 'missing'], ['primaryVoiceClipId', 'foreign-voice'],
    ['avatarReferenceImageId', 'missing'], ['avatarReferenceImageId', 'foreign-avatar'],
  ] as const)('%s=%s 不属于当前角色时拒绝，不静默回退', (field, id) => {
    const source = characterProject();
    source.dramaAssets.characters[0][field] = id;
    expect(() => captureExchangeSnapshot([source], assets, null)).toThrow('角色选择的声音或头像不存在或不属于本角色');
    expect(() => captureExchangeSnapshot([source], assets, null)).toThrow(`引用字段：${field}`);
    expect(source.dramaAssets.characters[0][field]).toBe(id);
  });

  it.each([{ ids: ['missing'] }, { ids: ['ordinary'] }, { ids: ['weapon', 'weapon'] }])('武器绑定 $ids 缺失、类型不符或重复时拒绝', ({ ids }) => {
    const source = characterProject();
    source.dramaAssets.characters[0].weaponIds = ids;
    expect(() => captureExchangeSnapshot([source], assets, null)).toThrow('角色绑定的武器不存在、类型无效或不属于当前作用域');
  });
});

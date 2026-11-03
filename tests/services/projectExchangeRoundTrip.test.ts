/** 真实业务适配的跨设备往返；不依赖归档编排的 mock。 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureExchangeSnapshot, materializeExchangeSnapshot, validateExchangeDomain } from '../../src/services/projectExchangeDomain';
import type { ProjectSaveData } from '../../src/services/storageService';
import type { ProjectExchangeIdentity, ProjectExchangeState } from '../../src/types/projectExchange';
import { normalizeDramaAssetLibrary } from '../../src/types/dramaAssets';
beforeEach(() => vi.stubGlobal('crypto', webcrypto)); afterEach(() => vi.unstubAllGlobals());
describe('项目规范快照往返', () => {
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

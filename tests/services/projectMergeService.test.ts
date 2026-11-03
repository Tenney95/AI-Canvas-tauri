/** 离线协作的业务结果：字段合并、逻辑删除、两轮往返、身份与依赖。 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureExchangeSnapshot, materializeExchangeSnapshot } from '../../src/services/projectExchangeDomain';
import { buildProjectMergePlan, resolveProjectMerge } from '../../src/services/projectMergeService';
import { createProjectExchangeRevision, findProjectExchangeBase } from '../../src/services/projectExchangeFormat';
import type { ProjectSaveData } from '../../src/services/storageService';
import type { ProjectExchangeState } from '../../src/types/projectExchange';
import { normalizeDramaAssetLibrary } from '../../src/types/dramaAssets';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
function project(prompt = '初始提示词', x = 0): ProjectSaveData {
  return { id: 'owner', name: '项目', createdAt: 1, updatedAt: 1, nodes: [{ id: 'node', type: 'ai-image', position: { x, y: 0 }, data: { prompt, status: 'idle' } }], edges: [], groups: [] };
}
function fixture() {
  const base = captureExchangeSnapshot([project()], [], null);
  const state: ProjectExchangeState = { ownerId: 'owner', lineageId: base.snapshot.lineageId, rootProjectId: base.snapshot.rootProjectId,
    headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: base.identities };
  const capture = (record: ProjectSaveData) => captureExchangeSnapshot([record], [], state, base.snapshot).snapshot;
  return { base: base.snapshot, state, capture };
}
describe('项目业务三方合并', () => {
  it('我的位置与对方提示词独立合并，保留模型与完整画布', () => {
    const { base, capture } = fixture();
    const plan = buildProjectMergePlan(base, capture(project('初始提示词', 200)), capture(project('对方提示词')));
    expect(plan.changes.filter((change) => change.conflict)).toHaveLength(0);
    const node = resolveProjectMerge(plan, {}).entities.find((item) => item.kind === 'node')!;
    expect(node.data.position).toEqual({ x: 200, y: 0 }); expect(node.data.data).toMatchObject({ prompt: '对方提示词' });
  });
  it('同字段不同修改必须显式选择，同值不产生冲突', () => {
    const { base, capture } = fixture(), local = capture(project('我的')), incoming = capture(project('对方'));
    const plan = buildProjectMergePlan(base, local, incoming), conflict = plan.changes.find((change) => change.conflict)!;
    expect(() => resolveProjectMerge(plan, {})).toThrow('还有冲突');
    expect(resolveProjectMerge(plan, { [conflict.id]: 'incoming' }).entities.find((item) => item.kind === 'node')!.data.data).toMatchObject({ prompt: '对方' });
    expect(buildProjectMergePlan(base, incoming, incoming).changes).toHaveLength(0);
  });
  it('双方新增不同节点和镜头，列表自动保留两项；不按名称去重', () => {
    const { base, capture } = fixture();
    const local = project(), incoming = project();
    (local.nodes as unknown[]).push({ id: 'local-node', type: 'ai-text', position: { x: 1, y: 0 }, data: { label: '同名', prompt: '本地' } });
    (incoming.nodes as unknown[]).push({ id: 'remote-node', type: 'ai-text', position: { x: 2, y: 0 }, data: { label: '同名', prompt: '对方' } });
    const plan = buildProjectMergePlan(base, capture(local), capture(incoming));
    expect(plan.changes.some((change) => change.conflict)).toBe(false);
    const result = resolveProjectMerge(plan, {});
    expect(result.entities.filter((item) => item.kind === 'node')).toHaveLength(3);
    expect(result.entities.find((item) => item.kind === 'project')!.data.nodesIds).toEqual(['node', 'local-node', 'remote-node']);
  });
  it.each([['local', 0], ['local', 1], ['incoming', 0], ['incoming', 1]] as const)(
    '%s 单边在位置 %s 插入镜头，自动合并保留原位置', (side, index) => {
      const record = (ids: string[], x = 0): ProjectSaveData => ({ ...project('正文', x), nodes: [
        { id: 'node', type: 'ai-shotlist', position: { x, y: 0 }, data: { type: 'ai-shotlist', shotlistRows: ids.map((id) => ({ id, content: id })) } },
      ] });
      const captured = captureExchangeSnapshot([record(['a', 'b'])], [], null);
      const state: ProjectExchangeState = { ownerId: 'owner', lineageId: captured.snapshot.lineageId, rootProjectId: 'owner',
        headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: captured.identities };
      const ids = ['a', 'b']; ids.splice(index, 0, 'new');
      const changed = captureExchangeSnapshot([record(ids)], [], state, captured.snapshot).snapshot;
      const other = captureExchangeSnapshot([record(['a', 'b'], 100)], [], state, captured.snapshot).snapshot;
      const plan = buildProjectMergePlan(captured.snapshot, side === 'local' ? changed : other, side === 'local' ? other : changed);
      expect(plan.changes.some((change) => change.conflict)).toBe(false);
      const node = resolveProjectMerge(plan, {}).entities.find((entity) => entity.kind === 'node')!;
      expect(node.data.shotlistRowsIds).toEqual(ids);
      expect(node.data.position).toEqual({ x: 100, y: 0 });
    },
  );

  it.each(['image', 'voice', 'action'] as const)('一侧新增精确 %s 引用、另一侧删除对应素材时不能合成断裂输入', (kind) => {
    const record = () => ({ ...project(), dramaAssets: normalizeDramaAssetLibrary({ characters: [
      { id: 'character', kind: 'character', name: '角色', primaryReferenceImageId: 'primary', referenceImages: [
        { id: 'primary', kind: 'primary', relativePath: '参考.png' }, { id: 'selected', relativePath: '参考.png' },
      ], voiceClips: [{ id: 'voice', relativePath: '声音.wav' }], actions: [
        { id: 'action', name: '动作', media: [{ id: 'clip', kind: 'image', relativePath: '参考.png' }] },
      ] },
    ] }) });
    const assets = [{ path: '参考.png', bytes: 10, sha256: 'a'.repeat(64) }, { path: '声音.wav', bytes: 20, sha256: 'b'.repeat(64) }];
    const captured = captureExchangeSnapshot([record()], assets, null);
    const state: ProjectExchangeState = { ownerId: 'owner', lineageId: captured.snapshot.lineageId, rootProjectId: 'owner',
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: captured.identities };
    const local = record(), incoming = record();
    const pick = { image: 'selected', voice: 'voice/voice', action: 'action/action/clip' }[kind];
    (local.nodes as Array<{ data: Record<string, unknown> }>)[0].data.prompt = `@drama{character#${pick}:角色}`;
    const character = incoming.dramaAssets.characters[0];
    if (kind === 'image') character.referenceImages = character.referenceImages!.filter((reference) => reference.id !== 'selected');
    if (kind === 'voice') character.voiceClips = [];
    if (kind === 'action') character.actions![0].media = [];
    const plan = buildProjectMergePlan(captured.snapshot,
      captureExchangeSnapshot([local], assets, state, captured.snapshot).snapshot,
      captureExchangeSnapshot([incoming], assets, state, captured.snapshot).snapshot);
    expect(plan.changes.some((change) => change.conflict)).toBe(false);
    expect(() => resolveProjectMerge(plan, {})).toThrow('创作素材缺失或归属不一致');
    const prompt = plan.changes.find((change) => change.field === 'data.prompt')!;
    expect(() => resolveProjectMerge(plan, { [prompt.id]: 'incoming' })).not.toThrow();
  });
  it('删除与修改冲突，选择删除时关联列表也必须一致', () => {
    const { base, capture } = fixture(), removed = project(); removed.nodes = [];
    const plan = buildProjectMergePlan(base, capture(project('我的修改')), capture(removed));
    const deletion = plan.changes.find((change) => change.kind === 'node')!;
    expect(deletion.conflict).toBe(true);
    const result = resolveProjectMerge(plan, { [deletion.id]: 'incoming' }); expect(result.entities.some((item) => item.kind === 'node')).toBe(false);
  });
  it('删除与另一侧新增连线产生依赖错误，允许调整原自动项', () => {
    const { base, capture } = fixture(), local = project(), remote = project(); local.nodes = [];
    remote.edges = [{ id: 'new-edge', source: 'node', target: 'node' }];
    const plan = buildProjectMergePlan(base, capture(local), capture(remote));
    expect(() => resolveProjectMerge(plan, {})).toThrow();
    const edge = plan.changes.find((change) => change.kind === 'edge')!, order = plan.changes.find((change) => change.field === 'edgesIds')!;
    expect(resolveProjectMerge(plan, { [edge.id]: 'local', [order.id]: 'local' }).entities.some((item) => item.kind === 'edge')).toBe(false);
  });
  it('没有基线时双方所有差异人工选择，不因缺失自动传播删除', () => {
    const { capture } = fixture(), removed = project(); removed.nodes = [];
    const plan = buildProjectMergePlan(null, capture(project()), capture(removed));
    expect(plan.changes.length).toBeGreaterThan(0); expect(plan.changes.every((change) => change.conflict)).toBe(true);
  });
  it('导入项目与分集只更换本机项目 ID，文件别名与素材字节身份独立', () => {
    const owner = project(); owner.nodes = [{ id: 'n', type: 'source-image', position: { x: 0, y: 0 }, data: { relativePath: '角色/a.png', filePath: 'C:/private/a.png', assetId: 'foreign-index' } }];
    const episode = { ...project(), id: 'episode', parentId: 'owner' };
    const capture = captureExchangeSnapshot([owner, episode], [{ path: '角色/a.png', bytes: 10, sha256: 'a'.repeat(64) }, { path: '角色/b.png', bytes: 10, sha256: 'a'.repeat(64) }], null);
    expect(capture.snapshot.media).toHaveLength(1); expect(capture.snapshot.entities.filter((item) => item.kind === 'file')).toHaveLength(2);
    expect(JSON.stringify(capture.snapshot)).not.toContain('C:/private'); expect(JSON.stringify(capture.snapshot)).not.toContain('foreign-index');
    const identities = [{ kind: 'project' as const, scopeId: 'owner', id: 'owner', localId: 'new-owner' }];
    const paths = new Map(capture.snapshot.entities.filter((item) => item.kind === 'file').map((item) => [item.id, `imports/op/${item.id}/image.png`]));
    const records = materializeExchangeSnapshot(capture.snapshot, identities, [], '新目录', paths);
    expect(records[0].id).toBe('new-owner'); expect(records[1].parentId).toBe('new-owner'); expect(records[1].id).not.toBe('episode');
    expect((records[0].nodes as Array<{ id: string }>)[0].id).toBe('n');
  });
  it('合并版本保留双亲，第二轮从上次共同版本比较，重导入旧包可识别祖先', async () => {
    const { base, capture } = fixture(), first = await createProjectExchangeRevision(base);
    const local = await createProjectExchangeRevision(capture(project('初始提示词', 1)), [first.revisionId]);
    const remote = await createProjectExchangeRevision(capture(project('第一次返回')), [first.revisionId]);
    const merged = await createProjectExchangeRevision(resolveProjectMerge(buildProjectMergePlan(base, local.snapshot, remote.snapshot), {}), [local.revisionId, remote.revisionId]);
    const nextRemote = await createProjectExchangeRevision(capture(project('第二次返回')), [remote.revisionId]);
    const match = await findProjectExchangeBase(merged.revisionId, nextRemote.revisionId, [first, local, remote, merged, nextRemote]);
    expect(match.status === 'found' && match.revision.revisionId).toBe(remote.revisionId);
    const repeated = await findProjectExchangeBase(merged.revisionId, remote.revisionId, [first, local, remote, merged]);
    expect(repeated.status === 'found' && repeated.revision.revisionId).toBe(remote.revisionId);
  });
});

/** 离线协作的业务结果：字段合并、逻辑删除、两轮往返、身份与依赖。 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureExchangeSnapshot, materializeExchangeSnapshot } from '../../src/services/projectExchangeDomain';
import { buildProjectMergePlan, resolveProjectMerge } from '../../src/services/projectMergeService';
import { createProjectExchangeRevision, findProjectExchangeBase } from '../../src/services/projectExchangeFormat';
import type { ProjectSaveData } from '../../src/services/storageService';
import type { ProjectExchangeState } from '../../src/types/projectExchange';
import { normalizeDramaAssetLibrary } from '../../src/types/dramaAssets';
import type { StoryGraphNode } from '../../src/types/storyGraph';
import { createEmptyStoryGraph } from '../../src/services/storyGraphService';

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
  it('本集正文与 TXT 文件作为同一冲突单元，选择后不会拼接不同来源的正文和引用', () => {
    const owner = project();
    const episode: ProjectSaveData = { ...project(), id: 'episode', parentId: owner.id, name: '第一集', episodeScript: '原稿',
      episodeScriptFile: { fileName: '第一集.txt', relativePath: 'manuscripts/第一集.txt', digest: 'a'.repeat(64), sourceName: '第一集.txt' } };
    const assets = [{ path: 'manuscripts/第一集.txt', bytes: 6, sha256: 'a'.repeat(64) },
      { path: 'manuscripts/第一集_1.txt', bytes: 6, sha256: 'b'.repeat(64) }];
    const captured = captureExchangeSnapshot([owner, episode], assets, null);
    const state: ProjectExchangeState = { ownerId: owner.id, lineageId: captured.snapshot.lineageId, rootProjectId: owner.id,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: captured.identities };
    const local = { ...episode, episodeScript: '本地新稿' };
    const incoming = { ...episode, episodeScriptFile: { ...episode.episodeScriptFile!, fileName: '第一集_1.txt',
      relativePath: 'manuscripts/第一集_1.txt', digest: 'b'.repeat(64) } };
    const capture = (record: ProjectSaveData) => captureExchangeSnapshot([owner, record], assets, state, captured.snapshot).snapshot;
    const localSnapshot = capture(local), incomingSnapshot = capture(incoming);
    const plan = buildProjectMergePlan(captured.snapshot, localSnapshot, incomingSnapshot);
    const conflicts = plan.changes.filter((change) => change.conflict);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('本集剧本与文件');
    expect(() => resolveProjectMerge(plan, {})).toThrow('还有冲突');
    for (const side of ['local', 'incoming'] as const) {
      const resolved = resolveProjectMerge(plan, { [conflicts[0].id]: side });
      const actual = resolved.entities.find((entity) => entity.kind === 'project' && entity.id === episode.id)!.data;
      const selected = (side === 'local' ? localSnapshot : incomingSnapshot).entities.find((entity) => entity.kind === 'project' && entity.id === episode.id)!.data;
      expect(actual.episodeScript).toBe(selected.episodeScript);
      expect(actual.episodeScriptFile).toEqual(selected.episodeScriptFile);
    }
    const paths = new Map([...captured.files].map(([id, path]) => [id, `imports/op/${id}/${path.split('/').pop()}`]));
    const restored = materializeExchangeSnapshot(resolveProjectMerge(plan, { [conflicts[0].id]: 'incoming' }), [], [], '新目录', paths);
    expect(restored.find((record) => record.episodeScriptFile)?.episodeScriptFile).toMatchObject({
      relativePath: expect.stringMatching(/^imports\/op\/.+\/第一集_1\.txt$/), sourceName: '第一集.txt', digest: 'b'.repeat(64),
    });
  });

  it('全剧正文和故事图独立合并，双方改图时整张图为一个冲突单元', () => {
    const graph = createEmptyStoryGraph('graph');
    const original = { ...project(), series: { script: '原稿', storyGraph: graph } };
    const captured = captureExchangeSnapshot([original], [], null);
    const state: ProjectExchangeState = { ownerId: original.id, lineageId: captured.snapshot.lineageId, rootProjectId: original.id,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: captured.identities };
    const node = (id: string): StoryGraphNode => ({ id, kind: 'event', label: id, description: '', aliases: [], episodeIds: [],
      evidence: [], origin: 'manual', certainty: 'explicit' });
    const local = { ...original, series: { ...original.series, storyGraph: { ...graph, revision: 9, nodes: [node('local')] } } };
    const incoming = { ...original, series: { ...original.series, script: '对方正文' } };
    const capture = (record: ProjectSaveData) => captureExchangeSnapshot([record], [], state, captured.snapshot).snapshot;
    const plan = buildProjectMergePlan(captured.snapshot, capture(local), capture(incoming));
    expect(plan.changes.some((change) => change.conflict)).toBe(false);
    expect(resolveProjectMerge(plan, {}).entities.find((entry) => entry.kind === 'project')!.data.series).toMatchObject({
      script: '对方正文', storyGraph: { nodes: [{ id: 'local' }] },
    });
    incoming.series.storyGraph = { ...graph, revision: 2, nodes: [node('incoming')] };
    const conflictPlan = buildProjectMergePlan(captured.snapshot, capture(local), capture(incoming));
    const conflicts = conflictPlan.changes.filter((change) => change.conflict);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('series.storyGraph');
    const resolved = resolveProjectMerge(conflictPlan, { [conflicts[0].id]: 'incoming' });
    expect(resolved.entities.find((entry) => entry.kind === 'project')!.data.series).toMatchObject({
      script: '对方正文', storyGraph: { nodes: [{ id: 'incoming' }] },
    });
  });
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
    if (kind === 'voice') { character.voiceClips = []; character.primaryVoiceClipId = undefined; }
    if (kind === 'action') character.actions![0].media = [];
    const plan = buildProjectMergePlan(captured.snapshot,
      captureExchangeSnapshot([local], assets, state, captured.snapshot).snapshot,
      captureExchangeSnapshot([incoming], assets, state, captured.snapshot).snapshot);
    expect(plan.changes.some((change) => change.conflict)).toBe(false);
    expect(() => resolveProjectMerge(plan, {})).toThrow('创作素材缺失或归属不一致');
    const prompt = plan.changes.find((change) => change.field === 'data.prompt')!;
    expect(() => resolveProjectMerge(plan, { [prompt.id]: 'incoming' })).not.toThrow();
  });

  it.each(['voice', 'avatar', 'weapon'] as const)('双方各自有效的 %s 选择与删除不能自动合成悬空关系', (kind) => {
    const record = () => ({ ...project(), dramaAssets: normalizeDramaAssetLibrary({ characters: [
      { id: 'hero', name: '角色', kind: 'character', primaryReferenceImageId: 'primary', avatarReferenceImageId: 'a1', primaryVoiceClipId: 'v1',
        referenceImages: [{ id: 'primary', kind: 'primary', relativePath: '参考.png' },
          { id: 'a1', kind: 'avatar', relativePath: '参考.png' }, { id: 'a2', kind: 'avatar', relativePath: '参考.png' }],
        voiceClips: [{ id: 'v1', relativePath: '声音.wav' }, { id: 'v2', relativePath: '声音.wav' }], weaponIds: ['w1'] },
    ], props: [{ id: 'w1', kind: 'prop', name: '武器一', propType: 'weapon' }, { id: 'w2', kind: 'prop', name: '武器二', propType: 'weapon' }] }) });
    const assets = [{ path: '参考.png', bytes: 10, sha256: 'a'.repeat(64) }, { path: '声音.wav', bytes: 20, sha256: 'b'.repeat(64) }];
    const captured = captureExchangeSnapshot([record()], assets, null);
    const state: ProjectExchangeState = { ownerId: 'owner', rootProjectId: 'owner', lineageId: captured.snapshot.lineageId,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: captured.identities };
    const local = record(), incoming = record();
    const selected = local.dramaAssets.characters[0], deleted = incoming.dramaAssets.characters[0];
    const field = kind === 'voice' ? 'primaryVoiceClipId' : kind === 'avatar' ? 'avatarReferenceImageId' : 'weaponIds';
    if (kind === 'voice') { selected.primaryVoiceClipId = 'v2'; deleted.voiceClips = deleted.voiceClips!.filter((item) => item.id !== 'v2'); }
    if (kind === 'avatar') { selected.avatarReferenceImageId = 'a2'; selected.avatarCrop = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
      deleted.referenceImages = deleted.referenceImages!.filter((item) => item.id !== 'a2'); }
    if (kind === 'weapon') { selected.weaponIds = ['w2']; incoming.dramaAssets.props = incoming.dramaAssets.props.filter((item) => item.id !== 'w2'); }
    const plan = buildProjectMergePlan(captured.snapshot,
      captureExchangeSnapshot([local], assets, state, captured.snapshot).snapshot,
      captureExchangeSnapshot([incoming], assets, state, captured.snapshot).snapshot);
    expect(plan.changes.some((change) => change.conflict)).toBe(false);
    expect(() => resolveProjectMerge(plan, {})).toThrow(kind === 'weapon' ? '角色绑定的武器不存在' : '角色选择的声音或头像不存在');
    const selection = plan.changes.find((change) => change.kind === 'character' && change.field === field)!;
    expect(() => resolveProjectMerge(plan, { [selection.id]: 'incoming' })).not.toThrow();
  });

  it.each(['shot', 'cell'] as const)('引用 %s 后另一侧删除镜头或缩小宫格时阻止迟到失效引用', (kind) => {
    const record = () => ({ ...project(), nodes: [
      { id: 'sheet', type: 'ai-shotlist', data: { type: 'ai-shotlist', shotlistRows: [{ id: 'row', content: '有人回家' }] } },
      { id: 'board', type: 'ai-storyboard', data: { type: 'ai-storyboard', storyboardCols: 2, storyboardRows: 2 } },
      { id: 'generator', type: 'ai-video', data: { type: 'ai-video', prompt: '' } },
    ] });
    const captured = captureExchangeSnapshot([record()], [], null);
    const state: ProjectExchangeState = { ownerId: 'owner', rootProjectId: 'owner', lineageId: captured.snapshot.lineageId,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: captured.identities };
    const local = record(), incoming = record();
    local.nodes[2].data.prompt = kind === 'shot' ? '@{sheet/shot/row:镜头}' : '@{board/cell/3:宫格}';
    if (kind === 'shot') incoming.nodes[0].data.shotlistRows = [];
    else { incoming.nodes[1].data.storyboardCols = 1; incoming.nodes[1].data.storyboardRows = 1; }
    const plan = buildProjectMergePlan(captured.snapshot,
      captureExchangeSnapshot([local], [], state, captured.snapshot).snapshot,
      captureExchangeSnapshot([incoming], [], state, captured.snapshot).snapshot);
    expect(plan.changes.some((change) => change.conflict)).toBe(false);
    expect(() => resolveProjectMerge(plan, {})).toThrow('项目引用的分镜');
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

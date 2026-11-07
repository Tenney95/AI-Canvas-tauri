/** 未执行的 P5 回归源：混规范父链、旧摘要、领域闭包和显式三方选择。 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExchangeObject, ProjectExchangeSnapshot, ProjectExchangeValue } from '../../src/types/projectExchange';
import type { ProjectExchangeBundleV2, ProjectExchangeEntityV2, ProjectExchangeSnapshotV2 } from '../../src/types/projectArchiveV4';
import { createProjectExchangeRevision, parseProjectExchangeBundle, parseProjectExchangeSnapshot } from '../../src/services/projectExchangeFormat';
import { adaptSnapshotV1ToV2, deriveLegacyExchangeIdentity, deriveLegacyProjectionProofFromRevisions } from '../../src/services/projectExchangeV2Domain';
import { assertProjectExchangeV3Compatible, createProjectExchangeRevisionV2, exchangeReferencesV2,
  findProjectExchangeBaseV2, isProjectExchangeAncestorV2, parseProjectExchangeBundleV2,
  parseProjectExchangeSnapshotV2, projectExchangeRevisionHeaderV2 } from '../../src/services/projectExchangeV2Format';
import { buildProjectMergePlanV2, resolveProjectMergeV2 } from '../../src/services/projectMergeV2Service';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

function references(snapshot: ProjectExchangeSnapshotV2): ProjectExchangeSnapshotV2 {
  return { ...snapshot, entities: snapshot.entities.map((entity) => ({ ...entity,
    references: exchangeReferencesV2(entity, snapshot.entities, snapshot.rootProjectId) })) };
}
function zeroSeries(): ProjectExchangeSnapshotV2 {
  return references({ format: 'ai-canvas-project-snapshot', canonicalVersion: 2, lineageId: 'lineage', rootProjectId: 'root', complete: true,
    entities: [{ kind: 'project', scopeId: 'root', id: 'root', data: { name: '零集剧集', kind: 'series',
      storageRoots: [{ id: 'shared', role: 'shared' }], content: {} }, references: [] }], media: [], historicalTargets: [] });
}
function standalone(script = '原稿'): ProjectExchangeSnapshotV2 {
  const result = zeroSeries();
  result.entities[0].data = { ...result.entities[0].data, name: '普通项目', kind: 'standalone', standaloneCanvasId: 'canvas',
    content: { script } };
  result.entities.push({ kind: 'canvas', scopeId: 'root', id: 'canvas', data: { projectId: 'root', episodeId: null,
    storageRootRef: 'shared', revisionScope: 'project', nodesIds: [], edgesIds: [], groupsIds: [] }, references: [] });
  return references(result);
}
function legacy(): ProjectExchangeSnapshot {
  return { format: 'ai-canvas-project-snapshot', canonicalVersion: 1, lineageId: 'lineage', rootProjectId: 'root', complete: true,
    entities: [{ kind: 'project', scopeId: 'root', id: 'root', data: { name: '普通项目', nodesIds: [], edgesIds: [], groupsIds: [],
      episodeScript: '旧普通稿件', revisionScope: 'global', series: { originalWork: { title: '原著' } } }, references: [] }], media: [] };
}
async function bundle(snapshot = zeroSeries()): Promise<ProjectExchangeBundleV2> {
  const revision = await createProjectExchangeRevisionV2(snapshot);
  return { format: 'ai-canvas-project-exchange', version: 2, packageId: 'package', lineageId: snapshot.lineageId,
    head: { canonicalVersion: 2, revisionId: revision.revisionId }, revisions: [revision], ancestors: [], files: [] };
}

describe('canonical2 与混版本历史', () => {
  it('supports a zero-episode series without manufacturing a canvas and keeps v1 parsers closed', async () => {
    expect(parseProjectExchangeSnapshotV2(zeroSeries()).entities).toHaveLength(1);
    expect(() => parseProjectExchangeSnapshot(zeroSeries())).toThrow();
    await expect(parseProjectExchangeBundle(await bundle())).rejects.toThrow();
  });

  it('keeps a retired conversation descriptor after content restore revives the same episode identity', () => {
    const source = zeroSeries();
    source.entities.push({ kind: 'episode', scopeId: 'root', id: 'episode', data: { projectId: 'root', canvasId: 'canvas',
      name: '已恢复第一集', orderRank: 0, content: {}, settingsPolicy: { mode: 'inherit', overrides: {} } }, references: [] },
    { kind: 'canvas', scopeId: 'root', id: 'canvas', data: { projectId: 'root', episodeId: 'episode', storageRootRef: 'shared',
      revisionScope: 'project', nodesIds: [], edgesIds: [], groupsIds: [] }, references: [] });
    source.historicalTargets.push({ state: 'retired', kind: 'episode', projectId: 'root', id: 'episode' });
    const parsed = parseProjectExchangeSnapshotV2(references(source));
    expect(parsed.historicalTargets).toEqual(source.historicalTargets);
    expect(parsed.entities.find((entity) => entity.kind === 'episode')!.id).toBe('episode');
  });

  it('projects old metadata and standalone manuscripts deterministically without modifying the old revision', async () => {
    const old = await createProjectExchangeRevision(legacy()), saved = JSON.stringify(old);
    const one = await adaptSnapshotV1ToV2(old.snapshot), two = await adaptSnapshotV1ToV2(structuredClone(old.snapshot));
    expect(one).toEqual(two);
    expect(one.entities.find((entity) => entity.kind === 'project')?.data).toMatchObject({ kind: 'standalone',
      content: { originalWork: { title: '原著' }, standaloneCreative: { script: '旧普通稿件' } } });
    expect(one.entities.find((entity) => entity.kind === 'canvas')?.data.revisionScope).toBe('global');
    expect(one.entities.find((entity) => entity.kind === 'canvas')?.id).toBe(await deriveLegacyExchangeIdentity('lineage', 'root', 'canvas'));
    const next = await createProjectExchangeRevisionV2(one, [{ canonicalVersion: 1, revisionId: old.revisionId }]);
    const value = await parseProjectExchangeBundleV2({ ...await bundle(one), head: { canonicalVersion: 2, revisionId: next.revisionId }, revisions: [old, next] });
    expect(value.revisions[0]).toEqual(old);
    expect(JSON.stringify(old)).toBe(saved);
    expect(next.parents).toEqual([{ canonicalVersion: 1, revisionId: old.revisionId }]);
    expect(() => assertProjectExchangeV3Compatible(value.revisions)).toThrow('导出 v4');
    expect(() => assertProjectExchangeV3Compatible([old])).not.toThrow();
  });

  it('finds a full v1 common ancestor across v2 descendants and distinguishes headers from baseline bodies', async () => {
    const old = await createProjectExchangeRevision(legacy()), projected = await adaptSnapshotV1ToV2(old.snapshot);
    const first = await createProjectExchangeRevisionV2(projected, [{ canonicalVersion: 1, revisionId: old.revisionId }]);
    const edited = structuredClone(projected); edited.entities.find((entity) => entity.kind === 'project')!.data.name = '已编辑';
    const second = await createProjectExchangeRevisionV2(edited, [{ canonicalVersion: 2, revisionId: first.revisionId }]);
    const oldRef = { canonicalVersion: 1 as const, revisionId: old.revisionId }, newRef = { canonicalVersion: 2 as const, revisionId: second.revisionId };
    expect(await findProjectExchangeBaseV2(oldRef, newRef, [old, first, second])).toEqual({ status: 'found', revision: old });
    const mixed = { ...await bundle(projected), head: newRef, revisions: [second], ancestors: [
      { ...old, snapshot: undefined }, projectExchangeRevisionHeaderV2(first),
    ] };
    // v1 header 必须沿原形状，不能携 snapshot:undefined 等新字段。
    const { snapshot: _snapshot, ...oldHeader } = old;
    const complete = { ...mixed, ancestors: [oldHeader, projectExchangeRevisionHeaderV2(first)] };
    expect(await isProjectExchangeAncestorV2(oldRef, newRef, complete)).toBe(true);
    expect(await findProjectExchangeBaseV2(oldRef, newRef, [second], complete.ancestors)).toEqual({ status: 'missingSnapshot' });
    await expect(parseProjectExchangeBundleV2(mixed)).rejects.toThrow();
  });

  it('rejects missing or wrong-version parent proofs and altered immutable content', async () => {
    const original = await bundle();
    const bad = structuredClone(original); bad.revisions[0].snapshot.entities[0].data.name = '篡改';
    await expect(parseProjectExchangeBundleV2(bad)).rejects.toThrow();
    const head = await createProjectExchangeRevisionV2(zeroSeries(), [{ canonicalVersion: 1, revisionId: 'a'.repeat(64) }]);
    await expect(parseProjectExchangeBundleV2({ ...original, head: { canonicalVersion: 2, revisionId: head.revisionId }, revisions: [head] })).rejects.toThrow('incomplete_ancestry');
    await expect(parseProjectExchangeBundleV2({ ...original, version: 3 })).rejects.toThrow();
    expect(() => parseProjectExchangeSnapshotV2({ ...zeroSeries(), canonicalVersion: 3 })).toThrow();
  });

  it('keeps same-named files from separate roots distinct and rejects forged scope or dependencies', () => {
    const snapshot = standalone();
    (snapshot.entities[0].data.storageRoots as ProjectExchangeValue[]).push({ id: 'second', role: 'canvas' });
    for (const [id, rootRef] of [['file-one', 'shared'], ['file-two', 'second']]) {
      snapshot.entities.push({ kind: 'file', id, scopeId: 'root', data: { name: 'same.txt', rootRef, relativePath: 'same.txt', mediaId: id }, references: [] });
      snapshot.media.push({ id, kind: 'file', extension: 'txt', bytes: 0, sha256: 'a'.repeat(64) });
    }
    expect(parseProjectExchangeSnapshotV2(references(snapshot)).media).toHaveLength(2);
    const bad = structuredClone(snapshot); bad.entities.find((entity) => entity.kind === 'canvas')!.scopeId = 'foreign';
    expect(() => parseProjectExchangeSnapshotV2(references(bad))).toThrow();
    const forged = standalone(); forged.entities[0].references = [];
    expect(() => parseProjectExchangeSnapshotV2(forged)).toThrow('invalid_references');
  });

  it('does not invent order from canonical entity sorting or silently discard unknown old metadata', async () => {
    const source = legacy(); source.entities[0].data.customBusinessField = '不可丢失';
    await expect(adaptSnapshotV1ToV2(source)).rejects.toThrow('LEGACY_PROJECTION_REQUIRES_REVIEW');
    const unknown = legacy(); delete unknown.entities[0].data.episodeScript;
    unknown.entities.push({ kind: 'project', id: 'episode', scopeId: 'episode', data: { name: '无集号', parentId: 'root' },
      references: [{ kind: 'project', id: 'root', scopeId: 'root' }] });
    await expect(adaptSnapshotV1ToV2(unknown)).rejects.toThrow('LEGACY_PROJECTION_REQUIRES_REVIEW');
    unknown.entities[1].data.episodeNo = 1;
    unknown.entities[0].data.creationProfile = { profileId: 'legacy-owner-profile' };
    await expect(adaptSnapshotV1ToV2(unknown)).rejects.toThrow('LEGACY_PROJECTION_REQUIRES_REVIEW');
  });

  it('preserves deleted story evidence as retired display material without recreating an active episode', async () => {
    const old = legacy();
    (old.entities[0].data.series as Record<string, unknown>).storyGraph = { schemaVersion: 1, id: 'graph', nodes: [
      { id: 'character', kind: 'character', label: '人物', description: '', aliases: [], episodeIds: ['deleted-episode'],
        evidence: [], origin: 'manual', certainty: 'explicit' },
    ], edges: [], positions: {} };
    const projected = await adaptSnapshotV1ToV2(old);
    expect(projected.historicalTargets).toContainEqual({ state: 'retired', kind: 'episode', projectId: 'root', id: 'deleted-episode' });
    expect(projected.entities.some((entity) => entity.kind === 'episode')).toBe(false);
    const bad = structuredClone(projected); bad.historicalTargets = [];
    expect(() => parseProjectExchangeSnapshotV2(bad)).toThrow('missing_story_target');
  });

  it('does not execute accessor inputs or persist machine-local URL fields in new canonical bodies', () => {
    let called = false;
    const malicious = Object.defineProperty({}, 'format', { enumerable: true, get: () => { called = true; return 'ai-canvas-project-snapshot'; } });
    expect(() => parseProjectExchangeSnapshotV2(malicious)).toThrow();
    expect(called).toBe(false);
    const value = standalone(); value.entities[0].data.content = { originalWork: { url: 'file:///private/original.txt' } };
    expect(() => parseProjectExchangeSnapshotV2(value)).toThrow('non_portable_value');
  });

  it('derives baseline file proof only from an unchanged direct migration revision, never a later rename', async () => {
    const source = legacy();
    source.entities.push({ kind: 'file', scopeId: 'root', id: 'file', data: { name: 'file.txt', mediaId: 'media' }, references: [] });
    source.media.push({ id: 'media', kind: 'file', extension: 'txt', bytes: 1, sha256: 'a'.repeat(64) });
    const old = await createProjectExchangeRevision(source), rootRef = await deriveLegacyExchangeIdentity('lineage', 'root', 'root');
    const proof = { roots: [{ scopeId: 'root', rootRef }], files: [{ fileId: 'file', rootRef, relativePath: 'folder/file.txt' }] };
    const projected = await adaptSnapshotV1ToV2(old.snapshot, proof);
    const migrated = await createProjectExchangeRevisionV2(projected, [{ canonicalVersion: 1, revisionId: old.revisionId }]);
    const renamed = structuredClone(projected), file = renamed.entities.find((entity) => entity.kind === 'file')!;
    file.data.relativePath = 'renamed.txt'; file.data.name = 'renamed.txt';
    const later = await createProjectExchangeRevisionV2(renamed, [{ canonicalVersion: 2, revisionId: migrated.revisionId }]);
    expect(await deriveLegacyProjectionProofFromRevisions(old, [old, migrated, later])).toEqual(proof);
    await expect(deriveLegacyProjectionProofFromRevisions(old, [old, later])).rejects.toThrow('LEGACY_PROJECTION_REQUIRES_REVIEW');
    const falseMigration = await createProjectExchangeRevisionV2(renamed, [{ canonicalVersion: 1, revisionId: old.revisionId }]);
    await expect(deriveLegacyProjectionProofFromRevisions(old, [old, falseMigration])).rejects.toThrow('LEGACY_PROJECTION_REQUIRES_REVIEW');
  });
});

describe('跨规范三方合并', () => {
  it('renames an empty project without dropping its required empty content container', async () => {
    const base = zeroSeries(), local = structuredClone(base);
    local.entities[0].data.name = '空稿新名称';
    const resolved = resolveProjectMergeV2(await buildProjectMergePlanV2(base, local, base), {});
    expect(resolved.entities[0].data).toMatchObject({ name: '空稿新名称', content: {} });
  });

  it('preserves dynamic dotted keys and keys matching atomic-group labels without renaming manuscript fields', async () => {
    const base = standalone();
    (base.entities[0].data.content as ProjectExchangeObject)['custom.note'] = '原资料';
    (base.entities[0].data.content as ProjectExchangeObject)['正文与文件'] = '自定义值';
    base.entities.push({ kind: 'node', id: 'node', scopeId: 'canvas', data: { type: 'source-text', '尺寸': '自定义尺寸',
      data: { type: 'source-text', 'plugin.option': '原值', '媒体产物': '自定义产物' } }, references: [] });
    base.entities.find((entity) => entity.kind === 'canvas')!.data.nodesIds = ['node'];
    const normalized = references(base), local = structuredClone(normalized);
    const node = local.entities.find((entity) => entity.kind === 'node')!;
    (node.data.data as ProjectExchangeObject)['plugin.option'] = '新值';
    (node.data.data as ProjectExchangeObject)['媒体产物'] = '新自定义产物';
    node.data['尺寸'] = '新自定义尺寸';
    (local.entities[0].data.content as ProjectExchangeObject)['custom.note'] = '新资料';
    (local.entities[0].data.content as ProjectExchangeObject)['正文与文件'] = '新自定义值';
    const resolved = resolveProjectMergeV2(await buildProjectMergePlanV2(normalized, local, normalized), {});
    const resolvedNode = resolved.entities.find((entity) => entity.kind === 'node')!;
    expect(resolvedNode.data.data).toMatchObject({ 'plugin.option': '新值', '媒体产物': '新自定义产物' });
    expect(resolvedNode.data['尺寸']).toBe('新自定义尺寸');
    expect((resolvedNode.data.data as ProjectExchangeObject).plugin).toBeUndefined();
    expect(resolved.entities.find((entity) => entity.kind === 'project')!.data.content).toMatchObject({ 'custom.note': '新资料', '正文与文件': '新自定义值', script: '原稿' });
  });

  it('rejects equal media IDs with different payload descriptors even if entity bodies are unchanged', async () => {
    const base = standalone();
    base.entities.push({ kind: 'file', scopeId: 'root', id: 'file', data: { name: 'file.txt', rootRef: 'shared', relativePath: 'file.txt', mediaId: 'opaque-media' }, references: [] });
    base.media.push({ id: 'opaque-media', kind: 'file', extension: 'txt', bytes: 1, sha256: 'a'.repeat(64) });
    const local = references(base), incoming = structuredClone(local); incoming.media[0].sha256 = 'b'.repeat(64);
    await expect(buildProjectMergePlanV2(local, local, incoming)).rejects.toThrow('MEDIA_IDENTITY_CONFLICT');
  });

  it('a storage-only v1 projection compares equal to its v2 view', async () => {
    const old = legacy(), projected = await adaptSnapshotV1ToV2(old);
    const plan = await buildProjectMergePlanV2(old, projected, old);
    expect(plan.changes).toEqual([]);
    expect(resolveProjectMergeV2(plan, {})).toEqual(projected);
  });

  it('requires explicit choices for a shared manuscript conflict and preserves a new head shape', async () => {
    const base = standalone(), local = standalone('本地稿'), incoming = standalone('远端稿');
    const plan = await buildProjectMergePlanV2(base, local, incoming);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ conflict: true, field: 'content.正文与文件' });
    expect(() => resolveProjectMergeV2(plan, {})).toThrow('还有冲突');
    const merged = resolveProjectMergeV2(plan, { [plan.changes[0].id]: 'incoming' });
    expect(merged.entities.find((entity) => entity.kind === 'project')?.data.content).toMatchObject({ script: '远端稿' });
  });

  it('rechecks complete membership after a deletion choice instead of accepting dangling canvas nodes', async () => {
    const base = standalone(), local = standalone(), incoming = standalone();
    const node: ProjectExchangeEntityV2 = { kind: 'node', scopeId: 'canvas', id: 'node', data: { type: 'source-text', data: { type: 'source-text', output: '原稿' } }, references: [] };
    local.entities.push(node); local.entities.find((entity) => entity.kind === 'canvas')!.data.nodesIds = ['node'];
    const plan = await buildProjectMergePlanV2(base, references(local), incoming);
    const choices = Object.fromEntries(plan.changes.map((change) => [change.id, change.kind === 'canvas' ? 'incoming' : 'local']));
    expect(() => resolveProjectMergeV2(plan, choices as Record<string, 'local' | 'incoming'>)).toThrow();
  });
});

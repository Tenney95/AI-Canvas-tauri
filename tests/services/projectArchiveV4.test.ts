import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectArchiveBusinessV4, ProjectArchivePayloadV4, ProjectExchangeBundleV2 } from '../../src/types/projectArchiveV4';
import { buildProjectExchangeSnapshotV2, projectArchivePayloadFromSnapshotV2, readProjectArchiveV4, serializeProjectArchiveV4 } from '../../src/services/projectArchiveV4';
import { createProjectExchangeRevisionV2 } from '../../src/services/projectExchangeV2Format';
import { sha256BytesHex } from '../../src/services/mediaDataUrl';

vi.mock('../../src/services/projectArchiveSerialization', () => ({
  serializeProjectArchiveEntries: vi.fn(async (entries: Array<{ path: string; value: unknown }>) =>
    entries.map((entry) => ({ path: entry.path, content: JSON.stringify(entry.value) }))),
}));

const emptySeries = (): ProjectArchiveBusinessV4 => ({
  project: { id: 'P', name: '零集剧集', kind: 'series', storageRoots: [{ id: 'shared', role: 'shared' }] },
  episodes: [], canvases: [], contents: { project: { projectId: 'P', data: { script: '全剧稿' } }, episodes: [] },
});
async function payload(business = emptySeries()): Promise<ProjectArchivePayloadV4> {
  const snapshot = buildProjectExchangeSnapshotV2(business, 'lineage', [], []);
  const revision = await createProjectExchangeRevisionV2(snapshot);
  const exchange: ProjectExchangeBundleV2 = { format: 'ai-canvas-project-exchange', version: 2,
    packageId: 'package', lineageId: 'lineage', head: { canonicalVersion: 2, revisionId: revision.revisionId },
    revisions: [revision], ancestors: [], files: [] };
  return { ...business, exchange };
}
const textsOf = (entries: Array<{ path: string; content: string }>) => Object.fromEntries(entries.map((entry) => [entry.path, entry.content]));
async function replaceEntry(texts: Record<string, string>, path: string, value: unknown) {
  const result = { ...texts, [path]: JSON.stringify(value) };
  const manifest = JSON.parse(result['manifest.json']);
  manifest.entries = await Promise.all(manifest.entries.map(async (entry: { path: string; bytes: number; sha256: string }) =>
    entry.path === path ? { path, bytes: new TextEncoder().encode(result[path]).byteLength,
      sha256: await sha256BytesHex(new TextEncoder().encode(result[path])) } : entry));
  result['manifest.json'] = JSON.stringify(manifest);
  return result;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('v4 archive receiving and serialization', () => {
  it('round trips a zero-episode series with the exact canonical head and no fabricated canvas', async () => {
    const input = await payload();
    const entries = await serializeProjectArchiveV4(input, { packageId: 'package', exportedAt: 1 });
    const result = await readProjectArchiveV4(textsOf(entries));
    expect(result.manifest).toMatchObject({ formatVersion: 4, projectKind: 'series', episodeCount: 0, canvasCount: 0 });
    expect(result.payload.project.kind).toBe('series');
    expect(result.payload.canvases).toEqual([]);
    expect(result.payload.contents.project.data.script).toBe('全剧稿');
    expect(result.payload.exchange.head).toEqual(input.exchange.head);
  });

  it('rejects unknown/future versions, extra sidecars, digest mismatch, and a validly rehashed sidecar that differs from head', async () => {
    const texts = textsOf(await serializeProjectArchiveV4(await payload(), { packageId: 'package', exportedAt: 1 }));
    const manifest = JSON.parse(texts['manifest.json']);
    await expect(readProjectArchiveV4({ ...texts, 'manifest.json': JSON.stringify({ ...manifest, formatVersion: 5 }) })).rejects.toThrow();
    await expect(readProjectArchiveV4({ ...texts, 'extra.json': '{}' })).rejects.toThrow('未声明');
    await expect(readProjectArchiveV4({ ...texts, 'contents.json': '{}' })).rejects.toThrow('摘要');
    const altered = await replaceEntry(texts, 'contents.json', { project: { projectId: 'P', data: { script: '篡改稿件' } }, episodes: [] });
    await expect(readProjectArchiveV4(altered)).rejects.toThrow('head');
  });

  it('refuses local URLs, credentials and runtime fields instead of silently exporting execution material', () => {
    const business = emptySeries();
    expect(() => buildProjectExchangeSnapshotV2({ ...business, contents: {
      ...business.contents, project: { projectId: 'P', data: { originalWork: { url: 'asset://private-original' } } },
    } }, 'lineage', [], [])).toThrow('本机');
    expect(() => buildProjectExchangeSnapshotV2({ ...business, contents: {
      ...business.contents, project: { projectId: 'P', data: { apiKey: 'never-export' } },
    } }, 'lineage', [], [])).toThrow();
  });

  it('keeps same-path files from different roots as distinct logical identities while deduplicating their physical media', async () => {
    const business: ProjectArchiveBusinessV4 = { project: { id: 'P', name: '多根普通项目', kind: 'standalone', standaloneCanvasId: 'C',
      storageRoots: [{ id: 'shared', role: 'shared' }, { id: 'canvas-root', role: 'canvas' }] }, episodes: [],
      canvases: [{ id: 'C', projectId: 'P', episodeId: null, storageRootRef: 'canvas-root', revisionScope: 'global',
        nodes: [{ id: 'n', type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', relativePath: 'same.png' } }], edges: [], groups: [] }],
      contents: { project: { projectId: 'P', data: { originalWork: { relativePath: 'same.png' } } }, episodes: [] } };
    const media = [{ id: 'media', kind: 'image' as const, extension: 'png', bytes: 3, sha256: 'a'.repeat(64) }];
    const files = [{ id: 'F1', rootRef: 'shared', relativePath: 'same.png', mediaId: 'media' },
      { id: 'F2', rootRef: 'canvas-root', relativePath: 'same.png', mediaId: 'media' }];
    const snapshot = buildProjectExchangeSnapshotV2(business, 'lineage', media, files);
    expect(snapshot.entities.filter((entry) => entry.kind === 'file')).toHaveLength(2);
    const restored = projectArchivePayloadFromSnapshotV2(snapshot);
    expect(restored.canvases[0].revisionScope).toBe('global');
    expect(restored.canvases[0].nodes[0].data).toMatchObject({ relativePath: 'same.png' });
    expect(restored.contents.project.data.originalWork).toMatchObject({ relativePath: 'same.png' });
    const revision = await createProjectExchangeRevisionV2(snapshot);
    const exchange: ProjectExchangeBundleV2 = { format: 'ai-canvas-project-exchange', version: 2, packageId: 'package', lineageId: 'lineage',
      head: { canonicalVersion: 2, revisionId: revision.revisionId }, revisions: [revision], ancestors: [],
      files: [{ mediaId: 'media', archivePath: 'assets/payload.png' }] };
    const assets = [{ path: 'payload.png', bytes: 3, sha256: 'a'.repeat(64) }];
    const entries = await serializeProjectArchiveV4({ ...business, exchange }, { packageId: 'package', exportedAt: 1 }, assets);
    await expect(readProjectArchiveV4(textsOf(entries), assets)).resolves.toMatchObject({ files });
    await expect(readProjectArchiveV4(textsOf(entries), [{ ...assets[0], sha256: 'b'.repeat(64) }])).rejects.toThrow('素材');
    expect(() => buildProjectExchangeSnapshotV2(business, 'lineage', media,
      [files[0], { ...files[1], rootRef: 'shared' }])).toThrow('重复');
  });

  it('preserves retired history targets as read-only sources and refuses an executable or missing replacement target', async () => {
    const business = emptySeries();
    const target = { state: 'retired' as const, kind: 'episode' as const, projectId: 'P', id: 'deleted-episode' };
    const snapshot = buildProjectExchangeSnapshotV2(business, 'lineage', [], [], [target]);
    const revision = await createProjectExchangeRevisionV2(snapshot);
    const input: ProjectArchivePayloadV4 = { ...business, exchange: { format: 'ai-canvas-project-exchange', version: 2,
      packageId: 'package', lineageId: 'lineage', head: { canonicalVersion: 2, revisionId: revision.revisionId },
      revisions: [revision], ancestors: [], files: [] }, history: { payload: {
        conversations: [{ id: 'conversation', projectId: 'P', title: '旧集工作台', titleSource: 'user', pinned: false,
          archived: true, agentMode: 'plan', messageCount: 0, createdAt: 1, updatedAt: 1 }], messages: [], memories: [],
      }, workbenchTargets: [{ conversationId: 'conversation', target }] } };
    const texts = textsOf(await serializeProjectArchiveV4(input, { packageId: 'package', exportedAt: 1 }));
    expect((await readProjectArchiveV4(texts)).payload.history?.workbenchTargets[0].target).toEqual(target);
    const history = { ...input.history!, workbenchTargets: [{ conversationId: 'conversation', target: {
      state: 'active', kind: 'episode', projectId: 'P', episodeId: 'deleted-episode' } }] };
    await expect(readProjectArchiveV4(await replaceEntry(texts, 'history.json', history))).rejects.toThrow('不存在');
  });
});

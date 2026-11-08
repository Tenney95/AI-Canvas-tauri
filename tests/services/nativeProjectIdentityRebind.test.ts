/** 仅验证隔离材料的身份重分配，不访问真实项目。 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectArchiveBusinessV4 } from '../../src/types/projectArchiveV4';
import type { ProjectModelTransferExchange } from '../../src/types/projectModelTransfer';
import { buildProjectExchangeSnapshotV2 } from '../../src/services/projectArchiveV4';
import { rebindRetiredNativeSnapshot } from '../../src/services/nativeProjectIdentityRebind';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

it('重新引入退役分集时分配新逻辑身份并保留旧历史，正文不会被字符串替换', () => {
  const business: ProjectArchiveBusinessV4 = { project: { id: 'P', name: '测试', kind: 'series',
    storageRoots: [{ id: 'root', role: 'shared' }] },
    episodes: [{ id: 'E', projectId: 'P', canvasId: 'C', name: '第一集', orderRank: 0,
      settingsPolicy: { mode: 'inherit', overrides: {} } }],
    canvases: [{ id: 'C', projectId: 'P', episodeId: 'E', storageRootRef: 'root', revisionScope: 'project',
      nodes: [{ id: 'N', type: 'source-text', position: { x: 0, y: 0 }, data: { type: 'source-text', text: 'E C 原文' } }], edges: [], groups: [] }],
    contents: { project: { projectId: 'P', data: {} }, episodes: [{ episodeId: 'E', data: { script: 'E C 原文', storageRootRef: 'root' } }] } };
  const snapshot = buildProjectExchangeSnapshotV2(business, 'lineage', [], []);
  const exchange = { identities: [{ kind: 'episode', sourceId: 'E', localId: 'old-episode' },
    { kind: 'canvas', sourceId: 'C', localId: 'old-canvas' }] } as ProjectModelTransferExchange;
  const result = rebindRetiredNativeSnapshot(snapshot, exchange, ['old-episode', 'old-canvas']);
  const episode = result.snapshot.entities.find((item) => item.kind === 'episode')!;
  const canvas = result.snapshot.entities.find((item) => item.kind === 'canvas')!;
  expect(episode.id).not.toBe('E'); expect(canvas.id).not.toBe('C');
  expect(result.rebindings).toEqual(expect.arrayContaining([
    { kind: 'episode', from: 'E', to: episode.id }, { kind: 'canvas', from: 'C', to: canvas.id },
  ]));
  expect(episode.data.canvasId).toBe(canvas.id); expect(canvas.data.episodeId).toBe(episode.id);
  expect(result.snapshot.entities.find((item) => item.kind === 'node')?.scopeId).toBe(canvas.id);
  expect(JSON.stringify(result.snapshot)).toContain('E C 原文');
  expect(result.snapshot.historicalTargets).toEqual(expect.arrayContaining([
    { state: 'retired', kind: 'episode', projectId: 'P', id: 'E' },
    { state: 'retired', kind: 'canvas', projectId: 'P', id: 'C' },
  ]));
});

/** 只验证本机字段保留的纯函数；不访问真实项目。 */
import { describe, expect, it } from 'vitest';
import { preserveNativeUpdateFields } from '../../src/services/nativeProjectUpdatePreservation';
import type { ProjectExchangeEntityV2, ProjectExchangeSnapshotV2 } from '../../src/types/projectArchiveV4';
import type { ProjectModelTransferAggregate, ProjectModelTransferCapture, ProjectModelTransferExchange } from '../../src/types/projectModelTransfer';

const entity = (kind: ProjectExchangeEntityV2['kind'], scopeId: string, id: string, data: ProjectExchangeEntityV2['data']): ProjectExchangeEntityV2 =>
  ({ kind, scopeId, id, data, references: [] });
const snapshot = (entities: ProjectExchangeEntityV2[], media: ProjectExchangeSnapshotV2['media'] = []): ProjectExchangeSnapshotV2 =>
  ({ format: 'ai-canvas-project-snapshot', canonicalVersion: 2, lineageId: 'lineage', rootProjectId: 'project',
    complete: true, entities, media, historicalTargets: [] });
const exchange = { identities: [{ kind: 'canvas', sourceId: 'logical-canvas', localId: 'local-canvas' }] } as unknown as ProjectModelTransferExchange;
function fixture(before: unknown, after: unknown, content: unknown = {}): {
  expected: ProjectModelTransferCapture; next: ProjectModelTransferAggregate;
} {
  const canvas = { id: 'local-canvas', nodes: [before], edges: [], groups: [] };
  const aggregate = { project: { id: 'project' }, content, canvases: [canvas], episodes: [], episodeContents: [] };
  return { expected: { aggregate } as unknown as ProjectModelTransferCapture,
    next: { ...structuredClone(aggregate), canvases: [{ ...canvas, nodes: [after] }] } as unknown as ProjectModelTransferAggregate };
}

describe('新项目更新保留本机字段', () => {
  it('分镜父实体不变但子行内容变化时，保留新行内容，不覆盖为旧节点', () => {
    const before = { id: 'sheet', data: { shotlistRows: [{ id: 'row', description: '旧镜头' }] } };
    const after = { id: 'sheet', data: { shotlistRows: [{ id: 'row', description: '新镜头' }] } };
    const parent = entity('node', 'logical-canvas', 'sheet', { data: {}, shotlistRowsIds: ['row'] });
    const oldRow = entity('shot', 'logical-canvas', 'row', { description: '旧镜头' });
    const newRow = entity('shot', 'logical-canvas', 'row', { description: '新镜头' });
    const { expected, next } = fixture(before, after);
    preserveNativeUpdateFields(expected, next, snapshot([parent, oldRow]), snapshot([parent, newRow]), exchange);
    expect(next.canvases[0].nodes[0]).toEqual(after);
  });

  it('子行引用的文件字节变化时不能复用旧节点掩盖变化', () => {
    const before = { id: 'sheet', data: { shotlistRows: [{ id: 'row', relativePath: 'old.png', pollTaskId: 'old-task' }] } };
    const after = { id: 'sheet', data: { shotlistRows: [{ id: 'row', relativePath: 'new.png' }] } };
    const parent = entity('node', 'logical-canvas', 'sheet', { data: {}, shotlistRowsIds: ['row'] });
    const row = entity('shot', 'logical-canvas', 'row', { relativePath: 'exchange-file:file' });
    const file = entity('file', 'project', 'file', { mediaId: 'media' });
    const oldMedia = { id: 'media', kind: 'image' as const, extension: 'png', bytes: 2, sha256: 'a'.repeat(64) };
    const newMedia = { ...oldMedia, sha256: 'b'.repeat(64) };
    const { expected, next } = fixture(before, after);
    expect(() => preserveNativeUpdateFields(expected, next, snapshot([parent, row, file], [oldMedia]),
      snapshot([parent, row, file], [newMedia]), exchange)).toThrow();
  });

  it('共享素材父 ID 不变但子实体变化时，不覆盖所选更新', () => {
    const before = { dramaAssets: { scenes: [{ id: 'scene', name: '旧场景' }] } };
    const after = { dramaAssets: { scenes: [{ id: 'scene', name: '新场景' }] } };
    const { expected, next } = fixture({ id: 'node' }, { id: 'node' }, before);
    next.content = after as unknown as ProjectModelTransferAggregate['content'];
    const project = entity('project', 'project', 'project', { content: { dramaAssets: {} }, scenesIds: ['scene'] });
    const node = entity('node', 'logical-canvas', 'node', {});
    const oldScene = entity('scene', 'project', 'scene', { name: '旧场景' });
    const newScene = entity('scene', 'project', 'scene', { name: '新场景' });
    preserveNativeUpdateFields(expected, next, snapshot([project, node, oldScene]), snapshot([project, node, newScene]), exchange);
    expect(next.content).toEqual(after);
  });
});

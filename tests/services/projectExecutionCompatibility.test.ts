/** P4 旧回执/预算只读适配；本轮未执行。 */
import { describe, expect, it } from 'vitest';
import { getLegacyCanvasAliases, readLegacyExecutionScope } from '../../src/services/projectExecutionCompatibility';
import type { LegacyProjectBinding } from '../../src/types/project';
const bindings: LegacyProjectBinding[] = [
  { namespace: 'legacy-root', legacyId: 'S', projectId: 'S', sourceEpoch: 1, storageRootRef: 'root' },
  { namespace: 'legacy-canvas', legacyId: 'A', projectId: 'S', canvasId: 'A', episodeId: 'A', sourceEpoch: 1, storageRootRef: 'root' },
  { namespace: 'legacy-episode', legacyId: 'A', projectId: 'S', canvasId: 'A', episodeId: 'A', sourceEpoch: 1, storageRootRef: 'root' },
  { namespace: 'legacy-canvas', legacyId: 'B', projectId: 'S', canvasId: 'B', episodeId: 'B', sourceEpoch: 2, storageRootRef: 'root', retired: true },
];
describe('旧身份只读scope', () => {
  it('原task/binding/预算/unknown回执不改号不归零，退役集仍能定位审计', () => {
    const record = { id: 'original-task', projectId: 'B', conversationId: 'mcp-control-B', modelRounds: 9, toolCallCount: 22,
      resumeCount: 3, metrics: { inputTokens: 1000 }, mcpOperation: { bindingId: 'original-binding', sequence: 7, phase: 'unknown' } };
    const before = structuredClone(record);
    expect(readLegacyExecutionScope(record, bindings)).toMatchObject({ state: 'retired', ownerProjectId: 'S',
      target: { kind: 'canvas', canvasId: 'B' }, access: 'history-readonly' });
    expect(record).toEqual(before); expect(getLegacyCanvasAliases('S', bindings)).toEqual(['A', 'B']);
  });
  it('工作台选中集显式解释为Episode，跨owner/未知/歧义不回退当前画布', () => {
    expect(readLegacyExecutionScope({ projectId: 'S', workbenchTarget: { seriesId: 'S', episodeId: 'A' } }, bindings))
      .toMatchObject({ state: 'active', target: { kind: 'episode', episodeId: 'A' } });
    expect(readLegacyExecutionScope({ projectId: 'X', workbenchTarget: { seriesId: 'S', episodeId: 'A' } }, bindings).state).toBe('unresolved');
    expect(readLegacyExecutionScope({ projectId: 'unknown' }, bindings).state).toBe('unresolved');
    expect(readLegacyExecutionScope({ projectId: 'S', workbenchTarget: { seriesId: 'S', episodeId: 'A' }, teamRun: { target: { seriesId: 'S', episodeId: 'B' } } }, bindings).state).toBe('unresolved');
    expect(readLegacyExecutionScope({ projectId: 'A' }, [...bindings, { ...bindings[1]!, projectId: 'other' }]).state).toBe('unresolved');
    expect(readLegacyExecutionScope({ projectId: 'S' }, bindings)).toMatchObject({ target: { kind: 'project', domain: 'shared' } });
  });
});

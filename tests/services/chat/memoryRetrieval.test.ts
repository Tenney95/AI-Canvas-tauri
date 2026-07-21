import { describe, expect, it } from 'vitest';
import type { ProjectMemory, ProjectMemoryKind } from '../../../src/types/memory';
import { rankProjectMemories } from '../../../src/services/chat/memoryRetrieval';

function memory(id: string, kind: ProjectMemoryKind, content: string, updatedAt: number): ProjectMemory {
  return {
    id, projectId: 'project-1', kind, content, enabled: true,
    source: { conversationId: 'conversation-1' }, createdAt: updatedAt, updatedAt,
  };
}

describe('project memory retrieval', () => {
  it('prioritizes query relevance over unrelated recency', () => {
    const now = Date.now();
    const ranked = rankProjectMemories([
      memory('recent', 'constraint', '视频时长不得超过十秒', now),
      memory('relevant', 'fact', '主角服装始终保持红色外套', now - 20 * 24 * 60 * 60 * 1000),
    ], 'project-1', '主角的红色服装应该怎样保持一致', { now });
    expect(ranked[0].id).toBe('relevant');
  });

  it('uses kind priority and recency when no query is available', () => {
    const now = Date.now();
    const ranked = rankProjectMemories([
      memory('fact', 'fact', '普通事实', now),
      memory('constraint', 'constraint', '必须遵守的约束', now - 1000),
    ], 'project-1', '', { now });
    expect(ranked[0].id).toBe('constraint');
  });

  it('filters disabled and cross-project memories', () => {
    const enabled = memory('enabled', 'fact', '目标内容', Date.now());
    const disabled = { ...memory('disabled', 'constraint', '目标内容', Date.now()), enabled: false };
    const other = { ...memory('other', 'constraint', '目标内容', Date.now()), projectId: 'project-2' };
    expect(rankProjectMemories([disabled, other, enabled], 'project-1', '目标')).toEqual([enabled]);
  });
});

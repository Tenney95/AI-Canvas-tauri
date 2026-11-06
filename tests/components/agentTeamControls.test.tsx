import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask } from '../../src/types/agent';
import type { TeamApplicationReceipt, TeamArtifactReference } from '../../src/types/agentTeam';
import { createDefaultTeamProfile } from '../../src/services/chat/teams/teamProfileService';
import TeamRunCard from '../../src/components/shared/agentTeams/TeamRunCard';
import TeamResultReview from '../../src/components/shared/agentTeams/TeamResultReview';
import AgentTaskCenter from '../../src/components/chat/AgentTaskCenter';

vi.mock('../../src/components/shared/ModalOverlay', () => ({
  default: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) => isOpen ? <div>{children}</div> : null,
}));

function task(application?: TeamApplicationReceipt): AgentTask {
  const artifact: TeamArtifactReference = {
    id: 'candidate', kind: 'revision', label: '修订稿', relativePath: 'team-private/candidate.txt',
    sha256: 'a'.repeat(64), bytes: 20, createdAt: 1, parentArtifactIds: [],
  };
  return {
    id: 'team-task', projectId: 'episode-a', conversationId: 'conversation-a', userMessageId: 'message-a',
    mode: 'collaborative', goal: '改进本集剧本', status: 'completed', steps: [], modelRounds: 6,
    toolCallCount: 0, budget: { ...DEFAULT_AGENT_TASK_BUDGET }, createdAt: 1, updatedAt: 2,
    teamRun: {
      version: 1, revision: 1, id: 'team-run', templateId: 'script', source: 'script-workbench',
      profile: createDefaultTeamProfile('general/model-a'),
      inputArtifact: { ...artifact, id: 'input', kind: 'input', label: '任务材料' },
      modelFingerprints: { architect: '', writer: '', continuity: '', dialogue: '', editor: '' },
      artifacts: [artifact], stages: [], callsUsed: 6, budgetTokensUsed: 100,
      usageKnown: false, usageReportedCalls: 0, unknownUsageCalls: 6, resultArtifactId: artifact.id, application, createdAt: 1,
      target: { kind: 'episode', seriesId: 'series-a', episodeId: 'episode-a', field: 'script', expectedHash: 'before', label: '第1集 · 剧本' },
    },
  };
}

const receipt = (status: TeamApplicationReceipt['status']): TeamApplicationReceipt => ({
  status, artifactId: 'candidate', originalArtifactId: 'original', targetHashBefore: 'before', targetHashAfter: 'after', appliedAt: 2,
});

describe('team result controls', () => {
  it('keeps unknown usage explicit and does not expose artifact storage paths', () => {
    const html = renderToStaticMarkup(<TeamRunCard task={task()} />);
    expect(html).toContain('实际用量待核对');
    expect(html).toContain('候选成果，尚未应用');
    expect(html).not.toContain('0 token');
    expect(html).not.toContain('team-private');
  });

  it('does not offer applying a result in Plan mode', () => {
    const planned = { ...task(), mode: 'plan' as const };
    const html = renderToStaticMarkup(<TeamResultReview task={planned} isOpen onClose={vi.fn()}
      onReadArtifact={vi.fn(async () => '')} onApply={vi.fn()} />);
    expect(html).toContain('规划模式只查看成果');
    expect(html).not.toContain('应用到原位置');
  });

  it('offers verification instead of another write when an application is pending', () => {
    const html = renderToStaticMarkup(<TeamResultReview task={task(receipt('pending'))} isOpen onClose={vi.fn()}
      onReadArtifact={vi.fn(async () => '')} onApply={vi.fn()} onRestore={vi.fn()} onReconcile={vi.fn()} />);
    expect(html).toContain('核对保存状态');
    expect(html).not.toContain('应用到原位置');
    expect(html).not.toContain('恢复应用前原稿');
  });

  it('keeps a review report from being applied as the script body', () => {
    const review = task();
    review.teamRun = { ...review.teamRun!, templateId: 'review' };
    const html = renderToStaticMarkup(<TeamResultReview task={review} isOpen onClose={vi.fn()}
      onReadArtifact={vi.fn(async () => '')} onApply={vi.fn()} />);
    expect(html).not.toContain('应用到原位置');
  });

  it('offers same-task clarification without allowing amendments during a pending application', () => {
    const paused = { ...task(), status: 'paused' as const };
    const html = renderToStaticMarkup(<TeamRunCard task={paused} onAmend={vi.fn()} />);
    expect(html).toContain('补充要求后继续');
    expect(html).toMatch(/maxlength="6000"/i);
    const saving = { ...task(receipt('pending')), status: 'paused' as const };
    expect(renderToStaticMarkup(<TeamRunCard task={saving} onAmend={vi.fn()} />)).not.toContain('补充要求后继续');
  });

  it('shows an explicitly focused completed task instead of hiding it behind the active filter', () => {
    const controls = {
      onResolveApproval: vi.fn(), mediaModelOptions: [], mediaModelAvailability: {}, onPause: vi.fn(), onResume: vi.fn(),
      onStop: vi.fn(), onSkip: vi.fn(), onReplan: vi.fn(), onRewind: vi.fn(),
    };
    const completed = task();
    const html = renderToStaticMarkup(<AgentTaskCenter tasks={[completed]} conversations={[]} onClose={vi.fn()}
      focusRequest={{ taskId: completed.id, revision: 1 }} {...controls} />);
    expect(html).toContain(completed.goal);
  });
});

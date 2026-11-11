import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask } from '../../src/types/agent';
import type { TeamApplicationReceipt, TeamArtifactReference, TeamStageRun } from '../../src/types/agentTeam';
import { createDefaultTeamProfile } from '../../src/services/chat/teams/teamProfileService';
import TeamRunCard from '../../src/components/shared/agentTeams/TeamRunCard';
import TeamResultReview from '../../src/components/shared/agentTeams/TeamResultReview';
import AgentTaskCenter from '../../src/components/chat/AgentTaskCenter';
import TeamExecutionPicker from '../../src/components/shared/agentTeams/TeamExecutionPicker';
import TeamGraphEditor from '../../src/components/shared/agentTeams/TeamGraphEditor';
import { createTemplateTeamGraph } from '../../src/services/chat/teams/teamGraphService';
import { setLocale } from '../../src/i18n';

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
      modelFingerprints: { architect: '', writer: '', continuity: '', dialogue: '', director: '', storyboard: '', editor: '' },
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
  it('distinguishes smart dispatch from a fixed team without requiring team configuration', () => {
    const props = { onChange: vi.fn(), profile: createDefaultTeamProfile(), onProfileChange: vi.fn() };
    const html = renderToStaticMarkup(<TeamExecutionPicker value={{ kind: 'single' }} {...props} />);
    expect(html).toContain('title="根据需求自动选用已授权的智能体与 Skill；简单任务直接完成"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>智能调度<\/button>/);
    expect(html).not.toContain('配置团队角色与预算');
    const teamHtml = renderToStaticMarkup(<TeamExecutionPicker value={{ kind: 'team', templateId: 'outline' }} {...props} />);
    expect(teamHtml).toMatch(/aria-pressed="true"[^>]*>团队<\/button>/);
    expect(teamHtml).toContain('配置团队角色与预算');
  });

  it('localizes the shared smart dispatch label and explanation', () => {
    try {
      for (const [locale, label, explanation] of [
        ['en-US', 'Smart dispatch', 'Automatically choose authorized agents and Skills'],
        ['ja-JP', 'スマート振り分け', '許可済みのエージェントと Skill'],
        ['ko-KR', '스마트 배정', '허용된 에이전트와 Skill'],
      ]) {
        setLocale(locale);
        const html = renderToStaticMarkup(<TeamExecutionPicker value={{ kind: 'single' }} onChange={vi.fn()}
          profile={createDefaultTeamProfile()} onProfileChange={vi.fn()} compact controls="execution" />);
        expect(html).toContain(label);
        expect(html).toContain(explanation);
        expect(html).not.toContain('根据需求自动选用');
      }
    } finally { setLocale('zh-CN'); }
  });

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

  it('edits dependencies and sources with common controls and shows a real graph validation error', () => {
    const graph = createTemplateTeamGraph('general');
    const onChange = vi.fn();
    const html = renderToStaticMarkup(<TeamGraphEditor value={graph} onChange={onChange} />);
    expect(html).toContain('最终交付任务');
    expect(html).toContain('正文来源');
    expect(html).toContain('ui-checkbox');
    expect(html).toContain('ui-select');
    const cyclic = structuredClone(graph);
    cyclic.nodes[0].dependsOn = [cyclic.finalTaskId];
    expect(renderToStaticMarkup(<TeamGraphEditor value={cyclic} onChange={onChange} />)).toContain('团队任务图不能包含循环');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows frozen owners, blocking dependencies and board revision, and only offers idle v2 edits', () => {
    const graph = createTemplateTeamGraph('general');
    const paused = { ...task(), status: 'paused' as const };
    paused.teamRun = { ...paused.teamRun!, version: 2, boardRevision: 7, graph,
      stages: graph.nodes.map((node): TeamStageRun => ({ id: node.id, title: node.title, roleId: node.roleId,
        status: 'pending', modelId: 'gpt-6.1-sol', executionTarget: { kind: 'external-agent', providerId: 'codex-app-server', modelId: 'gpt-6.1-sol' },
        attempts: 0, usageKnown: false })) };
    const html = renderToStaticMarkup(<TeamRunCard task={paused} onEditGraph={vi.fn(async () => undefined)} />);
    expect(html).toContain('任务图版本 7');
    expect(html).toContain('负责人：主笔');
    expect(html).toContain('等待依赖：');
    expect(html).toContain('Codex App Server');
    expect(html).toContain('编辑任务图');
    expect(renderToStaticMarkup(<TeamRunCard task={{ ...paused, status: 'running' }} onEditGraph={vi.fn(async () => undefined)} />)).not.toContain('编辑任务图');
    expect(renderToStaticMarkup(<TeamRunCard task={{ ...task(), status: 'paused' }} onEditGraph={vi.fn(async () => undefined)} />)).not.toContain('编辑任务图');
  });

  it('requires explicit unknown-result review without claiming abandoned means not executed', () => {
    const paused = { ...task(), status: 'paused' as const,
      dispatches: [{ id: 'dispatch', kind: 'team-model' as const, phase: 'outcome_unknown' as const, stepId: 'draft', preparedAt: 1 }] };
    const html = renderToStaticMarkup(<TeamRunCard task={paused} onResume={vi.fn()} onResolveDispatch={vi.fn()} />);
    expect(html).toContain('已核实完成');
    expect(html).toContain('放弃原调用，不重新提交');
    expect(html).toContain('放弃原调用不代表未执行');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>继续<\/button>/);
    const completed = { ...paused, status: 'completed' as const };
    const review = renderToStaticMarkup(<TeamResultReview task={completed} isOpen onClose={vi.fn()} onReadArtifact={vi.fn(async () => '')} onApply={vi.fn()} />);
    expect(review).toContain('原调用结果待核实');
    expect(review).not.toContain('应用到原位置');
  });

  it('does not label a live in-flight model dispatch as an unknown completed operation', () => {
    const running = { ...task(), status: 'running' as const,
      dispatches: [{ id: 'live', kind: 'team-model' as const, phase: 'dispatched' as const, preparedAt: 1 }] };
    expect(renderToStaticMarkup(<TeamRunCard task={running} onResolveDispatch={vi.fn()} />)).not.toContain('原调用结果待核实');
  });
});

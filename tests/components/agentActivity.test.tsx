import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import AgentTaskTimeline from '../../src/components/chat/AgentTaskTimeline';
import ReasoningPanel from '../../src/components/chat/ReasoningPanel';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask } from '../../src/types/agent';

const task: AgentTask = {
  id: 'task', projectId: 'project', conversationId: 'conversation', userMessageId: 'user',
  mode: 'collaborative', goal: 'inspect', status: 'failed', steps: [], modelRounds: 1,
  toolCallCount: 0, budget: DEFAULT_AGENT_TASK_BUDGET, createdAt: 1, updatedAt: 2,
};
const controls = {
  onResolveApproval: vi.fn(), mediaModelOptions: [], mediaModelAvailability: {},
  onPause: vi.fn(), onResume: vi.fn(), onStop: vi.fn(), onSkip: vi.fn(), onReplan: vi.fn(), onRewind: vi.fn(),
};

describe('Agent visible activity and recovery', () => {
  it('keeps the recovery action visible when failed details start collapsed', () => {
    const html = renderToStaticMarkup(<AgentTaskTimeline task={task} {...controls} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="继续"');
    expect(html).toContain('ui-btn--primary');
  });
  it('shows the real compression activity instead of planning', () => {
    const html = renderToStaticMarkup(<AgentTaskTimeline task={{ ...task, status: 'planning' }} {...controls} activity="compressing" activityStartedAt={Date.now()} />);
    expect(html).toContain('正在压缩上下文');
  });
  it('uses native keyboard-accessible disclosure and omits missing reasoning', () => {
    expect(renderToStaticMarkup(<ReasoningPanel content="" />)).toBe('');
    const html = renderToStaticMarkup(<ReasoningPanel content="provider summary" truncated />);
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('provider summary');
    expect(html).toContain('展示已截断');
    expect(html).not.toContain(' open=');
  });
});

/**
 * agentExecutionRationale — 回归测试：AgentExecutionRationale。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AgentExecutionRationale from '../../src/components/chat/AgentExecutionRationale';
import type { AgentTask } from '../../src/types/agent';

function task(withEvents = true): AgentTask {
  return {
    id: 'task-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    mode: 'collaborative',
    goal: 'audit canvas',
    status: 'running',
    steps: [],
    modelRounds: 1,
    toolCallCount: 0,
    budget: {
      maxModelRounds: 12,
      maxToolCalls: 24,
      maxParallelReadTools: 3,
      maxReadRetries: 3,
    },
    events: withEvents ? [{
      id: 'event-1',
      taskId: 'task-1',
      sequence: 0,
      type: 'model_round_start',
      timestamp: 1,
    }] : [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('AgentExecutionRationale', () => {
  it('renders active tasks expanded with an explicit hidden-reasoning boundary', () => {
    const html = renderToStaticMarkup(<AgentExecutionRationale task={task()} />);

    expect(html).toContain('执行依据');
    expect(html).toContain('第 1 轮：分析任务');
    expect(html).toContain('来自可验证的任务事件，不包含模型隐藏思维');
    expect(html).toContain('aria-expanded="true"');
  });

  it('renders terminal tasks collapsed by default', () => {
    const completed = { ...task(), status: 'completed' as const };
    const html = renderToStaticMarkup(<AgentExecutionRationale task={completed} />);

    expect(html).toContain('执行依据');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('来自可验证的任务事件');
  });

  it('renders nothing for tasks without journal events', () => {
    expect(renderToStaticMarkup(<AgentExecutionRationale task={task(false)} />)).toBe('');
  });

  it.each(['paused', 'failed', 'waiting_approval'] as const)('keeps %s rationale visible', (status) => {
    const html = renderToStaticMarkup(<AgentExecutionRationale task={{ ...task(), status }} />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('来自可验证的任务事件');
  });
});

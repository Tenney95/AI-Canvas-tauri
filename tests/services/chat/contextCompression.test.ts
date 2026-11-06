/**
 * contextCompression — 回归测试：conversation context compression validation。
 */
import { describe, expect, it } from 'vitest';
import {
  SUMMARY_REQUIRED_SECTIONS,
  validateConversationSummary,
  pruneAgentToolMessages,
} from '../../../src/services/chat/contextCompressionService';
import type { AssistantModelMessage } from '../../../src/services/ai/assistantStream';
import type { AgentTask } from '../../../src/types/agent';

function validSummary(extra = ''): string {
  return SUMMARY_REQUIRED_SECTIONS.map((section) => `【${section}】\n${section}内容`).join('\n') + extra;
}

describe('conversation context compression validation', () => {
  it('prunes older tool bodies for free while keeping the last two complete tool rounds', () => {
    const messages: AssistantModelMessage[] = [];
    for (let index = 0; index < 3; index++) messages.push(
      { role: 'assistant', content: '', tool_calls: [{ id: `c${index}`, type: 'function', function: { name: 'canvas_query', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `c${index}`, content: '甲'.repeat(3000) });
    const task = { steps: [] } as unknown as AgentTask;
    expect(pruneAgentToolMessages(messages, task)).toBe(true);
    expect(messages[1].content).toContain('旧工具正文已裁剪');
    expect(messages[3].content).toHaveLength(3000);
    expect(messages[5].content).toHaveLength(3000);
  });
  it('accepts every required section and preserved anchor', () => {
    const source = '请继续处理 @{node-1:主角}、#3，并参考 @model{image-1|图像} https://example.com/a';
    const summary = `${validSummary()}\n@{node-1:主角} #3 @model{image-1|图像} https://example.com/a`;
    expect(validateConversationSummary(summary, source)).toEqual({
      valid: true,
      missingSections: [],
      missingAnchors: [],
    });
  });

  it('rejects missing sections and dropped anchors', () => {
    const result = validateConversationSummary('【目标与背景】\n目标', '节点 #8');
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain('约束与偏好');
    expect(result.missingAnchors).toEqual(['#8']);
  });
  it('does not accept a summary that drops an opaque tool result reference', () => {
    const id = 'result-00000000-0000-4000-8000-000000000000';
    expect(validateConversationSummary(validSummary(), id).missingAnchors).toContain(id);
    expect(validateConversationSummary(`${validSummary()}\n${id}`, id).valid).toBe(true);
  });
});

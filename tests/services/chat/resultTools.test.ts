import { beforeEach, describe, expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn());
vi.mock('../../../src/services/chat/agentResultService', () => ({ AGENT_RESULT_PAGE_CHARS: 12000, readAgentResult: read }));
import { registerResultAgentTools } from '../../../src/services/chat/tools/resultTools';
import { clearAgentToolRegistryForTests, getAgentTool, prepareAgentToolCall } from '../../../src/services/chat/toolRegistry';
const context = { taskId: 'task', projectId: 'project', conversationId: 'conv', mode: 'plan' as const, signal: new AbortController().signal };
beforeEach(() => { clearAgentToolRegistryForTests(); read.mockReset(); registerResultAgentTools(); });

describe('结果回读工具合同', () => {
  it('只读且限制单段大小，不接受路径字段', () => {
    expect(getAgentTool('agent_result_read')!.effect).toBe('read');
    expect(prepareAgentToolCall({ callId: 'read', toolId: 'agent_result_read', input: { resultId: `result-${'a'.repeat(36)}`, limit: 12001 } }, context).ok).toBe(false);
    expect(prepareAgentToolCall({ callId: 'read', toolId: 'agent_result_read', input: { resultId: `result-${'a'.repeat(36)}`, path: '/tmp/data' } }, context).ok).toBe(false);
  });
  it('过期结果显式失败，不自动重读外部资料', async () => {
    read.mockRejectedValueOnce(new Error('结果已过期'));
    const result = await getAgentTool('agent_result_read')!.execute(context, { resultId: `result-${'a'.repeat(36)}` });
    expect(result.status).toBe('error'); expect(result.retryable).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../../../src/types/agent';
const fixture = vi.hoisted(() => ({ tasks: [] as AgentTask[], write: vi.fn(), read: vi.fn() }));
vi.mock('../../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({ agentTasks: fixture.tasks,
  currentProjectId: 'project', projectLoadStatus: 'ready', getCurrentRevision: () => 0,
  projects: [{ id: 'project', name: '测试项目', createdAt: 1, updatedAt: 1 }], conversations: [] }) } }));
vi.mock('../../../src/services/fs/projectFiles', () => ({
  writeImmutableProjectFile: fixture.write, readVerifiedProjectFile: fixture.read,
  sha256Hex: vi.fn(async () => 'a'.repeat(64)),
}));
import { captureAgentResult, clearAgentResults, readAgentResult, AGENT_RESULT_TTL_MS } from '../../../src/services/chat/agentResultService';
import { clearAgentToolRegistryForTests, registerAgentTool } from '../../../src/services/chat/toolRegistry';
const scope = { taskId: 'task', projectId: 'project', conversationId: 'conversation' };

beforeEach(() => {
  vi.restoreAllMocks(); clearAgentResults({});
  clearAgentToolRegistryForTests();
  registerAgentTool({ id: 'series_get_state', title: '剧集', description: '读取剧集', effect: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    resultPolicy: { storage: 'project', source: 'project-derived' },
    authorize: (context) => ({ allowed: context.projectId === 'project' }),
    execute: async () => ({ status: 'success', summary: 'unused', modelContent: 'unused' }) });
  fixture.write.mockReset().mockResolvedValue({}); fixture.read.mockReset();
  fixture.tasks = [{ id: scope.taskId, projectId: scope.projectId, conversationId: scope.conversationId, mode: 'plan', steps: [] } as unknown as AgentTask];
});

describe('有界工具结果', () => {
  it('网页/文件只在内存保存，分段回读仍须原授权', async () => {
    let authorized = true;
    const text = '甲'.repeat(9000) + '乙'.repeat(9000);
    const captured = await captureAgentResult({ scope, toolId: 'file_read_text', text,
      policy: { storage: 'memory', source: 'local-file', authorize: () => authorized } });
    expect(captured.modelContent.length).toBeLessThan(7000);
    expect(fixture.write).not.toHaveBeenCalled();
    expect((await readAgentResult(scope, captured.reference!.id, 9000, 5)).text).toBe('乙'.repeat(5));
    authorized = false;
    await expect(readAgentResult(scope, captured.reference!.id)).rejects.toThrow('授权已撤销');
  });

  it('拒绝跨会话读取，TTL过期不能假装恢复正文', async () => {
    const captured = await captureAgentResult({ scope, toolId: 'web_extract', text: '甲'.repeat(9000) });
    await expect(readAgentResult({ ...scope, conversationId: 'other' }, captured.reference!.id)).rejects.toThrow('不属于');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + AGENT_RESULT_TTL_MS + 1);
    await expect(readAgentResult(scope, captured.reference!.id)).rejects.toThrow('过期');
  });
  it('pausing and continuing the same task does not widen or discard its bounded memory snapshot', async () => {
    const captured = await captureAgentResult({ scope, toolId: 'canvas_query', text: '甲'.repeat(9000) });
    fixture.tasks[0].status = 'paused';
    expect((await readAgentResult(scope, captured.reference!.id, 0, 3)).text).toBe('甲甲甲');
    fixture.tasks[0].status = 'running';
    expect((await readAgentResult(scope, captured.reference!.id, 3, 3)).nextOffset).toBe(6);
    clearAgentResults({ taskId: scope.taskId });
    await expect(readAgentResult(scope, captured.reference!.id)).rejects.toThrow('过期');
  });

  it('只有显式项目派生结果落盘，失败时不回退完整 inline', async () => {
    await expect(captureAgentResult({ scope, toolId: 'web_extract', text: '甲'.repeat(9000),
      policy: { storage: 'project', source: 'web' } })).rejects.toThrow('项目派生');
    fixture.write.mockRejectedValueOnce(new Error('disk unavailable'));
    const captured = await captureAgentResult({ scope, toolId: 'series_get_state', text: '甲'.repeat(9000),
      policy: { storage: 'project', source: 'project-derived' } });
    expect(captured.reference).toBeUndefined(); expect(captured.modelContent.length).toBeLessThan(7000);
    expect(captured.modelContent).toContain('保存失败');
  });

  it('项目结果只用任务绑定的不可变引用恢复，内存引用不能伪造恢复', async () => {
    const captured = await captureAgentResult({ scope, toolId: 'series_get_state', text: '甲'.repeat(9000),
      policy: { storage: 'project', source: 'project-derived' } });
    const { data } = fixture.write.mock.calls[0][0] as { data: Uint8Array };
    fixture.tasks[0].steps = [{ id: 'step', taskId: 'task', index: 0, kind: 'tool', title: '读取', status: 'succeeded',
      createdAt: 1, updatedAt: 1, toolCall: { callId: 'read', toolId: 'series_get_state', retryCount: 0, resultReference: captured.reference } }];
    clearAgentResults({ taskId: scope.taskId }); fixture.read.mockResolvedValue(data);
    expect((await readAgentResult(scope, captured.reference!.id, 100, 3)).text).toBe('甲甲甲');
    expect(fixture.read).toHaveBeenCalledWith(expect.objectContaining({ reference: captured.reference!.projectFile }));
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
const provider = vi.hoisted(() => ({ stream: vi.fn(), external: vi.fn(), hash: vi.fn(), status: vi.fn() }));
vi.mock('../../../src/services/ai/assistantStream', () => ({
  streamAssistantReply: provider.stream, resolveAssistantModel: () => ({ selectionId: 'model', baseUrl: 'https://example.test',
    modelName: 'model', usesChatApiProtocol: false, protocol: { streamFormat: 'openai-sse' } }) }));
vi.mock('../../../src/services/chat/contextManager', () => ({ estimateTokens: () => 1,
  resolveAssistantContextSpec: () => ({ inputBudget: 100000 }) }));
vi.mock('../../../src/services/chat/teams/teamArtifactService', () => ({ hashTeamText: provider.hash }));
vi.mock('../../../src/services/chat/externalAgents/externalAgentService', () => ({
  executeExternalAgent: provider.external, getExternalAgentStatus: provider.status }));
import { executeTeamModel, TeamModelReturnedError } from '../../../src/services/chat/teams/teamModelExecutor';

const input = () => ({ projectId: 'episode-b', modelId: 'model', expectedFingerprint: 'a'.repeat(64),
  systemPrompt: '约束', userPrompt: '本集', maxOutputChars: 2000, signal: new AbortController().signal });

beforeEach(() => {
  vi.clearAllMocks();
  provider.hash.mockReset().mockResolvedValue('a'.repeat(64));
  provider.status.mockResolvedValue({ available: true, executionFingerprint: 'external-runtime', models: [{ id: 'model' }] });
});

describe('团队模型明确返回后的用量事实', () => {
  it.each(['length', 'canceled'] as const)('%s 结束保留已返回usage，不能伪装成功或unknown', async (finishReason) => {
    provider.stream.mockImplementationOnce(async (options: { onEvent: (event: unknown) => void }) => {
      options.onEvent({ type: 'usage', inputTokens: 10, outputTokens: 20 });
      options.onEvent({ type: 'done', finishReason });
      return '部分正文';
    });
    const error = await executeTeamModel(input()).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TeamModelReturnedError);
    expect(error).toMatchObject({ knownCompleted: false, result: { text: '部分正文', inputTokens: 10, outputTokens: 20, usageKnown: true } });
    expect(provider.stream).toHaveBeenCalledTimes(1);
  });

  it('外部成员已返回但最终身份复核失败，仍保留原结果用量并报告已知失败', async () => {
    provider.hash.mockResolvedValueOnce('a'.repeat(64)).mockResolvedValueOnce('b'.repeat(64));
    provider.external.mockResolvedValueOnce({ text: '外部候选', inputTokens: 11, outputTokens: 22, usageKnown: true });
    const error = await executeTeamModel({ ...input(), target: { kind: 'external-agent', providerId: 'codex-app-server', modelId: 'model' },
      conversationId: 'conv', taskId: 'task', stageId: 'structure', runRevision: 1 }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TeamModelReturnedError);
    expect(error).toMatchObject({ knownCompleted: false, result: { inputTokens: 11, outputTokens: 22, usageKnown: true } });
    expect(provider.external).toHaveBeenCalledTimes(1);
  });

  it('真实调用前再次校验原租约，拒绝时不发起 Provider', async () => {
    await expect(executeTeamModel({ ...input(), assertCurrent: () => { throw new Error('原租约失效'); } })).rejects.toThrow('原租约失效');
    expect(provider.stream).not.toHaveBeenCalled();
    expect(provider.external).not.toHaveBeenCalled();
  });
});

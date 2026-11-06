import { resolveAssistantModel, streamAssistantReply } from '../../ai/assistantStream';
import { estimateTokens, resolveAssistantContextSpec } from '../contextManager';
import { hashTeamText } from './teamArtifactService';
import type { TeamExecutionTarget } from '../../../types/agentTeam';
import { executeExternalAgent, getExternalAgentStatus } from '../externalAgents/externalAgentService';

export interface TeamModelResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  usageKnown: boolean;
}

/** 仅摘要执行身份。模型地址、协议和凭据本身不进入任务记录。 */
function teamModelIdentity(projectId: string, modelId: string): string {
  const model = resolveAssistantModel(projectId, modelId);
  if (!model) throw new Error('团队成员的文本模型不可用，请检查模型连接');
  if (!model.usesChatApiProtocol && model.protocol.streamFormat !== 'openai-sse') {
    throw new Error('团队成员的协议未声明可用的对话流格式');
  }
  return JSON.stringify({ selectionId: model.selectionId, baseUrl: model.baseUrl,
    modelName: model.modelName, protocol: model.protocol, chatApiProtocol: model.chatApiProtocol,
    usesChatApiProtocol: model.usesChatApiProtocol, credentialIdentity: model.apiKey,
  });
}

async function externalTeamIdentity(projectId: string, target: TeamExecutionTarget) {
  if (target.kind !== 'external-agent' || target.providerId !== 'codex-app-server') throw new Error('外部成员执行器不受支持');
  const status = await getExternalAgentStatus();
  if (!status.available || !status.executionFingerprint || !status.models.some((model) => model.id === target.modelId)) {
    throw new Error('外部成员不可用，请检查登记、密钥、启用状态和模型');
  }
  return { fingerprint: status.executionFingerprint, identity: JSON.stringify({ projectId, target, fingerprint: status.executionFingerprint }) };
}

export async function fingerprintTeamModel(projectId: string, modelId: string, target?: TeamExecutionTarget): Promise<string> {
  if (target?.kind === 'external-agent') {
    if (target.modelId !== modelId) throw new Error('外部成员模型与任务快照不一致');
    return hashTeamText((await externalTeamIdentity(projectId, target)).identity);
  }
  return hashTeamText(teamModelIdentity(projectId, modelId));
}

export async function executeTeamModel(input: {
  projectId: string;
  modelId: string;
  expectedFingerprint: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputChars: number;
  signal: AbortSignal;
  target?: TeamExecutionTarget;
  conversationId?: string;
  taskId?: string;
  stageId?: string;
  runRevision?: number;
}): Promise<TeamModelResult> {
  input.signal.throwIfAborted();
  if (input.target?.kind === 'external-agent') {
    if (!input.conversationId || !input.taskId || !input.stageId || !input.runRevision || input.modelId !== input.target.modelId) {
      throw new Error('外部成员缺少冻结的任务归属');
    }
    const before = await externalTeamIdentity(input.projectId, input.target);
    if (await hashTeamText(before.identity) !== input.expectedFingerprint) throw new Error('外部成员身份已变化，请重新确认');
    input.signal.throwIfAborted();
    const result = await executeExternalAgent({ providerId: input.target.providerId,
      invocationId: `team-${crypto.randomUUID()}`, projectId: input.projectId, conversationId: input.conversationId,
      taskId: input.taskId, stageId: input.stageId, runRevision: input.runRevision, modelId: input.modelId,
      expectedFingerprint: before.fingerprint, systemPrompt: input.systemPrompt, userPrompt: input.userPrompt,
      maxOutputChars: input.maxOutputChars, signal: input.signal });
    input.signal.throwIfAborted();
    if (await fingerprintTeamModel(input.projectId, input.modelId, input.target) !== input.expectedFingerprint) throw new Error('外部成员身份已变化，旧结果未被接纳');
    return result;
  }
  const identity = teamModelIdentity(input.projectId, input.modelId);
  if (await hashTeamText(identity) !== input.expectedFingerprint
    || teamModelIdentity(input.projectId, input.modelId) !== identity) {
    throw new Error('团队成员的模型连接已变化，请重新确认团队配置');
  }
  const context = resolveAssistantContextSpec(input.projectId, input.modelId);
  if (estimateTokens(input.systemPrompt) + estimateTokens(input.userPrompt) + 32 > context.inputBudget) {
    throw new Error('团队材料超出该成员的上下文窗口，请精简材料或更换模型');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal.addEventListener('abort', abort, { once: true });
  if (input.signal.aborted) controller.abort();
  let outputChars = 0;
  let reasoningChars = 0;
  let failure: string | undefined;
  let finishReason: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const timeout = setTimeout(() => { failure = '团队成员响应超时，已保留其他阶段成果'; controller.abort(); }, 180000);
  try {
    const text = await streamAssistantReply({ projectId: input.projectId, modelId: input.modelId,
      systemPrompt: input.systemPrompt, userMessage: input.userPrompt,
      messages: [{ role: 'system', content: input.systemPrompt }, { role: 'user', content: input.userPrompt }],
      tools: [], resolveVisualReferences: false, trackAbort: false, signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'text.delta') {
          outputChars += event.delta.length;
          if (outputChars > input.maxOutputChars) { failure = '团队成员输出超过本次上限，已停止该阶段'; controller.abort(); }
        } else if (event.type === 'reasoning.delta') {
          reasoningChars += event.delta.length;
          if (reasoningChars > input.maxOutputChars * 2) { failure = '团队成员推理输出超过本次上限，已停止该阶段'; controller.abort(); }
        } else if (event.type === 'usage') {
          if (Number.isSafeInteger(event.inputTokens) && (event.inputTokens ?? -1) >= 0) inputTokens = event.inputTokens;
          if (Number.isSafeInteger(event.outputTokens) && (event.outputTokens ?? -1) >= 0) outputTokens = event.outputTokens;
        } else if (event.type === 'tool.call.final' || event.type === 'tool.call.delta') {
          failure = '团队成员返回了不允许执行的工具调用'; controller.abort();
        } else if (event.type === 'done') finishReason = event.finishReason;
      },
    });
    input.signal.throwIfAborted();
    if (failure) throw new Error(failure);
    if (finishReason === 'length') throw new Error('团队成员输出未完成，请更换模型或缩小任务范围');
    if (finishReason === 'error' || finishReason === 'canceled') throw new Error('团队成员没有完成当前阶段');
    if (!text.trim() || text.length > input.maxOutputChars) throw new Error('团队成员未返回有效的有界正文');
    // JSON 由宿主先校验、再逐个字符串字段脱敏；不能用正则破坏 JSON 结构。
    return { text, inputTokens, outputTokens,
      usageKnown: inputTokens !== undefined && outputTokens !== undefined };
  } catch (error) {
    if (failure) throw new Error(failure, { cause: error });
    throw error;
  } finally { clearTimeout(timeout); input.signal.removeEventListener('abort', abort); }
}

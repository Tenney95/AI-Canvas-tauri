import { Channel, invoke } from '@tauri-apps/api/core';
import { CODEX_EXTERNAL_PROVIDER_ID, type ExternalAgentCollection, type ExternalAgentExecutionInput, type ExternalAgentProgress, type ExternalAgentResult } from '../../../types/externalAgent';
import { getExternalAgentStatus } from './externalAgentRegistry';

const SAFE_CODE = /^CODEX_[A-Z_]+$/;

export class ExternalAgentExecutionError extends Error {
  readonly code: string;
  readonly knownNotStarted: boolean;
  constructor(code: string, knownNotStarted = false) {
    super(SAFE_CODE.test(code) ? code : 'CODEX_EXECUTION_FAILED');
    this.name = 'ExternalAgentExecutionError';
    this.code = SAFE_CODE.test(code) ? code : 'CODEX_EXECUTION_FAILED';
    this.knownNotStarted = knownNotStarted;
  }
}

function validResult(result: ExternalAgentResult, maxChars: number): boolean {
  return !!result && typeof result.text === 'string' && !!result.text.trim()
    && result.text.length <= maxChars && typeof result.usageKnown === 'boolean'
    && [result.inputTokens, result.outputTokens].every((value) => value === undefined
      || (Number.isSafeInteger(value) && value >= 0))
    && (!result.usageKnown || (result.inputTokens !== undefined && result.outputTokens !== undefined));
}

export async function executeCodexAppServer(input: ExternalAgentExecutionInput): Promise<ExternalAgentResult> {
  input.signal.throwIfAborted();
  const status = await getExternalAgentStatus();
  input.signal.throwIfAborted();
  if (!status.available || !status.executionFingerprint) throw new ExternalAgentExecutionError(status.errorCode ?? 'CODEX_NOT_AVAILABLE');
  if (status.executionFingerprint !== input.expectedFingerprint) throw new ExternalAgentExecutionError('CODEX_IDENTITY_CHANGED');
  if (!status.models.some((model) => model.id === input.modelId)) throw new ExternalAgentExecutionError('CODEX_MODEL_UNSUPPORTED');
  const { signal, onProgress, ...request } = input;
  if (request.providerId !== CODEX_EXTERNAL_PROVIDER_ID) throw new ExternalAgentExecutionError('CODEX_PROVIDER_UNSUPPORTED');
  const channel = new Channel<ExternalAgentProgress>();
  channel.onmessage = (event) => {
    if (event.invocationId === request.invocationId && !signal.aborted) {
      try { onProgress?.(event); } catch { /* 展示观察者不能影响执行及取消。 */ }
    }
  };
  const cancel = () => { void invoke('codex_runtime_cancel', { invocationId: request.invocationId }).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const result = await invoke<ExternalAgentResult>('codex_runtime_start', { request, onProgress: channel });
    signal.throwIfAborted();
    if (!validResult(result, input.maxOutputChars)) throw new ExternalAgentExecutionError('CODEX_RESULT_INVALID');
    return result;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ExternalAgentExecutionError) throw error;
    // 仅回查同 invocation 的最终回执，绝不重投可能已经计费的 turn。
    const receipt = await invoke<ExternalAgentCollection>('codex_runtime_collect', { invocationId: request.invocationId }).catch(() => null);
    if (receipt?.status === 'completed' && receipt.result && validResult(receipt.result, input.maxOutputChars)) return receipt.result;
    const code = receipt?.errorCode ?? (typeof error === 'string' && SAFE_CODE.test(error) ? error : 'CODEX_RESULT_UNKNOWN');
    const knownNotStarted = receipt?.invocationId === request.invocationId
      && (receipt.status === 'failed' || receipt.status === 'cancelled') && receipt.turnSubmitted === false;
    throw new ExternalAgentExecutionError(code, knownNotStarted);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

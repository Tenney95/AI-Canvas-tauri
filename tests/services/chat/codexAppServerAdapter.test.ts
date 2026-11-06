import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalAgentExecutionInput } from '../../../src/types/externalAgent';
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), status: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke, Channel: class { onmessage?: (event: unknown) => void } }));
vi.mock('../../../src/services/chat/externalAgents/externalAgentRegistry', () => ({ getExternalAgentStatus: bridge.status }));
import { executeCodexAppServer } from '../../../src/services/chat/externalAgents/codexAppServerAdapter';

function request(signal = new AbortController().signal): ExternalAgentExecutionInput {
  return { providerId: 'codex-app-server', invocationId: 'invoke1', projectId: 'p', conversationId: 'c', taskId: 't', stageId: 's', runRevision: 1,
    modelId: 'gpt-6.1-sol', expectedFingerprint: 'a'.repeat(64), systemPrompt: 'structure', userPrompt: 'materials', maxOutputChars: 2000, signal };
}
beforeEach(() => {
  bridge.invoke.mockReset(); bridge.status.mockReset();
  bridge.status.mockResolvedValue({ available: true, executionFingerprint: 'a'.repeat(64), models: [{ id: 'gpt-6.1-sol' }] });
});
describe('Codex 有界建议适配器', () => {
  it('身份变化时阻止外部调用而非自动选择其他模型', async () => {
    bridge.status.mockResolvedValue({ available: true, executionFingerprint: 'b'.repeat(64), models: [{ id: 'gpt-6.1-sol' }] });
    await expect(executeCodexAppServer(request())).rejects.toMatchObject({ code: 'CODEX_IDENTITY_CHANGED' });
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it('IPC 丢失只回查原 invocation，读取完成回执而不重投模型', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'codex_runtime_start') throw new Error('IPC disconnected');
      return { invocationId: 'invoke1', status: 'completed', result: { text: '建议', usageKnown: false } };
    });
    expect(await executeCodexAppServer(request())).toEqual({ text: '建议', usageKnown: false });
    expect(bridge.invoke.mock.calls.map(([command]) => command)).toEqual(['codex_runtime_start', 'codex_runtime_collect']);
  });
  it('未知结果不视作未执行，返回明确错误且不重投', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'codex_runtime_start') throw new Error('secret fixture must not escape');
      return { status: 'running', invocationId: 'invoke1' };
    });
    await expect(executeCodexAppServer(request())).rejects.toMatchObject({ code: 'CODEX_RESULT_UNKNOWN', message: 'CODEX_RESULT_UNKNOWN', knownNotStarted: false });
    expect(bridge.invoke.mock.calls.filter(([command]) => command === 'codex_runtime_start')).toHaveLength(1);
  });
  it('取消关联原 invocation，并拒绝迟到的正文', async () => {
    const controller = new AbortController();
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'codex_runtime_start') { controller.abort(); return { text: '迟到', usageKnown: false }; }
      return true;
    });
    await expect(executeCodexAppServer(request(controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(bridge.invoke).toHaveBeenCalledWith('codex_runtime_cancel', { invocationId: 'invoke1' });
  });
  it('结果超限时拒绝返回，不将截断候选误标为成功', async () => {
    bridge.invoke.mockResolvedValue({ text: 'x'.repeat(2001), usageKnown: false });
    await expect(executeCodexAppServer(request())).rejects.toMatchObject({ code: 'CODEX_RESULT_INVALID' });
  });
  it('只有同一原生运行的明确未提交终态回执才标记 knownNotStarted', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'codex_runtime_start') throw 'CODEX_CONFIGURATION_REJECTED';
      return { invocationId: 'invoke1', status: 'failed', turnSubmitted: false, errorCode: 'CODEX_CONFIGURATION_REJECTED' };
    });
    await expect(executeCodexAppServer(request())).rejects.toMatchObject({ knownNotStarted: true });
    expect(bridge.invoke.mock.calls.filter(([command]) => command === 'codex_runtime_start')).toHaveLength(1);
  });
  it('最终身份失败或缺少回执都不能按错误码推断未启动', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'codex_runtime_start') throw 'CODEX_IDENTITY_CHANGED';
      return { invocationId: 'invoke1', status: 'failed', turnSubmitted: true, errorCode: 'CODEX_IDENTITY_CHANGED' };
    });
    await expect(executeCodexAppServer(request())).rejects.toMatchObject({ knownNotStarted: false });
    bridge.invoke.mockImplementation(async () => { throw 'CODEX_CONFIGURATION_REJECTED'; });
    await expect(executeCodexAppServer(request())).rejects.toMatchObject({ knownNotStarted: false });
  });
});

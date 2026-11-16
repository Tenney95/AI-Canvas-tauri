/** 文章候选不覆盖后续编辑，也不把停止或未完整返回的内容当作新稿。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamingCallOptions } from '../../src/services/ai/assistantStream';
import type { WorkbenchArticleCapture, WorkbenchArticleTarget } from '../../src/types/workbenchArticle';

const mocks = vi.hoisted(() => ({ stream: vi.fn(), model: vi.fn(), windowLabel: 'main' }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: mocks.windowLabel }) }));
vi.mock('../../src/services/fileService', () => ({ isTauriEnv: () => true }));
vi.mock('../../src/services/ai/assistantStream', () => ({ streamAssistantReply: mocks.stream, resolveAssistantModel: mocks.model }));
vi.mock('../../src/services/chat/subAgentMaterials', () => ({ sanitizeDomainText: (value: string) => value }));

import { createWorkbenchArticleSession } from '../../src/services/workbenchArticleService';

const target: WorkbenchArticleTarget = { kind: 'outline', episodeId: 'episode' };
function session(content = '原稿') {
  let current: WorkbenchArticleCapture = { target, projectId: 'episode', key: 'series:epoch:episode:outline',
    label: '本集大纲', content, version: 1 };
  const apply = vi.fn();
  const editor = createWorkbenchArticleSession({ readTarget: () => ({ ...current }), applyTarget: apply });
  return { editor, apply, change: (patch: Partial<WorkbenchArticleCapture>) => { current = { ...current, ...patch }; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.windowLabel = 'main';
  mocks.model.mockReturnValue({ selectionId: 'assistant-text-model' });
  mocks.stream.mockImplementation(async (request: StreamingCallOptions) => {
    request.onEvent({ type: 'done', finishReason: 'stop' });
    return '修改后的完整文章';
  });
});

describe('工作台文章改写', () => {
  it('生成只返回预览，显式采用后才交给原编辑器；摘要不携带正文', async () => {
    const { editor, apply } = session();
    const candidate = await editor.handle({ type: 'article_generate', target, instruction: '增强冲突' });
    if (typeof candidate === 'boolean') throw new Error('Expected article candidate');
    expect(apply).not.toHaveBeenCalled();
    expect(editor.summary()).toEqual({ generating: false, hasCandidate: true, targetLabel: '本集大纲' });
    expect(mocks.stream).toHaveBeenCalledWith(expect.objectContaining({ tools: [], sensitive: true,
      resolveVisualReferences: false, projectId: 'episode', modelId: 'assistant-text-model' }));
    await expect(editor.handle({ type: 'article_apply', candidateId: candidate.id })).resolves.toBe(true);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ content: '原稿', version: 1 }), '修改后的完整文章');
    editor.dispose();
  });

  it('采用前正文或版本变化时拒绝旧候选，不覆盖后续手写输入', async () => {
    const { editor, apply, change } = session();
    const candidate = await editor.handle({ type: 'article_generate', target, instruction: '精简表达' });
    if (typeof candidate === 'boolean') throw new Error('Expected article candidate');
    change({ content: '继续手写的稿件', version: 2 });
    await expect(editor.handle({ type: 'article_apply', candidateId: candidate.id })).rejects.toThrow('已变化');
    expect(apply).not.toHaveBeenCalled();
    expect(editor.summary().hasCandidate).toBe(false);
    editor.dispose();
  });

  it('生成期间切换文章后拒绝旧回执；停止后也不采纳忽略中止的模型结果', async () => {
    const first = deferred<string>();
    mocks.stream.mockReturnValueOnce(first.promise);
    const { editor, apply, change } = session();
    const generating = editor.handle({ type: 'article_generate', target, instruction: '整理结构' });
    await vi.waitFor(() => expect(mocks.stream).toHaveBeenCalledOnce());
    change({ key: 'another-article' });
    first.resolve('旧文章结果');
    await expect(generating).rejects.toThrow('已变化');
    const second = deferred<string>();
    mocks.stream.mockReturnValueOnce(second.promise);
    const stopped = editor.handle({ type: 'article_generate', target, instruction: '调整节奏' });
    await vi.waitFor(() => expect(mocks.stream).toHaveBeenCalledTimes(2));
    await editor.handle({ type: 'article_cancel' });
    second.resolve('停止后迟到的结果');
    await expect(stopped).rejects.toThrow('已停止');
    expect(apply).not.toHaveBeenCalled();
    expect(editor.summary().hasCandidate).toBe(false);
    editor.dispose();
  });

  it('超长文章拒绝整篇改写，空白文章可按需求起稿，旧候选ID不能丢弃当前结果', async () => {
    const long = session('字'.repeat(12_001));
    await expect(long.editor.handle({ type: 'article_generate', target, instruction: '改写' })).rejects.toThrow('12000');
    expect(mocks.stream).not.toHaveBeenCalled();
    long.editor.dispose();
    const blank = session('');
    const candidate = await blank.editor.handle({ type: 'article_generate', target, instruction: '写一段悬疑开场' });
    if (typeof candidate === 'boolean') throw new Error('Expected article candidate');
    await expect(blank.editor.handle({ type: 'article_discard_candidate', candidateId: 'previous-candidate' })).resolves.toBe(false);
    expect(blank.editor.summary().hasCandidate).toBe(true);
    blank.editor.dispose();
  });

  it('模型length结束、工具调用或超长输出都不能成为候选', async () => {
    const events: Parameters<StreamingCallOptions['onEvent']>[0][] = [{ type: 'done', finishReason: 'length' },
      { type: 'tool.call.final', call: { callId: 'call', toolId: 'unexpected-tool', input: {} } }];
    for (const event of events) {
      mocks.stream.mockImplementationOnce(async (request: StreamingCallOptions) => {
        request.onEvent(event);
        return '不完整结果';
      });
      const { editor } = session();
      await expect(editor.handle({ type: 'article_generate', target, instruction: '改写' })).rejects.toThrow('未完整');
      expect(editor.summary().hasCandidate).toBe(false);
      editor.dispose();
    }
    mocks.stream.mockResolvedValueOnce('字'.repeat(32_001));
    const { editor } = session();
    await expect(editor.handle({ type: 'article_generate', target, instruction: '改写' })).rejects.toThrow('过长');
    editor.dispose();
  });

  it('独立窗口不能自行创建模型改写会话', () => {
    mocks.windowLabel = 'script-workbench';
    expect(() => session()).toThrow('主窗口');
    expect(mocks.stream).not.toHaveBeenCalled();
  });
});

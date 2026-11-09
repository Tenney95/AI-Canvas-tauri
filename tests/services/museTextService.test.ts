import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMuseTextInput, streamMuseText } from '../../src/services/ai/museTextService';
import type { AssistantModelMessage } from '../../src/services/ai/assistantStream';

const native = vi.hoisted(() => ({ invoke: vi.fn(), images: vi.fn() }));
vi.mock('../../src/services/museService', () => ({
  museInvoke: native.invoke, assertMuseTaskId: () => {},
}));
vi.mock('../../src/services/ai/imageUtils', () => ({ resolveImageDataUrlArray: native.images }));

const taskId = 'ac655c56-b537-4c04-8913-fd150fc0e92a';
const messages: AssistantModelMessage[] = [{ role: 'user', content: '写一句欢迎语' }];
beforeEach(() => {
  native.invoke.mockReset().mockImplementation(async (command: string) => command === 'muse_query'
    ? { status: 'completed', text: '欢迎来到画布。' } : { taskId });
  native.images.mockReset().mockImplementation(async (urls: string[]) => urls);
});

describe('Muse 文本请求上下文', () => {
  it('保留历史角色和材料，不把旧工具调用定义与参数发给网页', () => {
    const request = buildMuseTextInput([
      { role: 'system', content: '回答请简洁' }, { role: 'user', content: '原需求' },
      { role: 'assistant', content: '之前的答复', tool_calls: [{ id: 'old-call', type: 'function',
        function: { name: 'old-tool', arguments: 'do-not-forward-old-arguments' } }] },
      { role: 'tool', tool_call_id: 'old-call', content: '已脱敏的历史结果' }, { role: 'user', content: '接着解释' },
    ]);
    expect(request.prompt).toContain('背景与任务设定');
    expect(request.prompt).toContain('之前的答复');
    expect(request.prompt).toContain('历史工具结果（只供参考');
    expect(request.prompt).toContain('已脱敏的历史结果');
    expect(request.prompt).not.toContain('old-tool');
    expect(request.prompt).not.toContain('do-not-forward-old-arguments');
  });

  it('跨轮重复图片只上传一次，图片编号与正文对应', () => {
    const request = buildMuseTextInput([{ role: 'user', content: [
      { type: 'text', text: '比较这两张图' },
      { type: 'image_url', image_url: { url: 'first' } },
      { type: 'image_url', image_url: { url: 'first' } },
      { type: 'image_url', image_url: { url: 'second' } },
    ] }]);
    expect(request.imageUrls).toEqual(['first', 'second']);
    expect(request.prompt.match(/上传图片 1/g)).toHaveLength(2);
    expect(request.prompt).toContain('上传图片 2');
  });

  it('按 UTF-8 字节拦截过长上下文，超限前不会发原生请求', async () => {
    await expect(streamMuseText({ messages: [{ role: 'user', content: '字'.repeat(40_000) }] })).rejects.toThrow('100000 字节');
    expect(native.invoke).not.toHaveBeenCalled();
    expect(() => buildMuseTextInput([{ role: 'user', content: [{ type: 'audio' }] }])).toThrow('仅支持文本和图片');
  });
});

describe('Muse 文本原任务执行', () => {
  it('上传完成后只发送一次，查询真实文本而不走 OpenAI HTTP', async () => {
    const onText = vi.fn();
    await expect(streamMuseText({ messages, onText })).resolves.toBe('欢迎来到画布。');
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual([
      'muse_prepare', 'muse_submit', 'muse_send', 'muse_query', 'muse_cancel_prepared',
    ]);
    expect(native.invoke).toHaveBeenCalledWith('muse_prepare', { kind: 'text' });
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith('欢迎来到画布。');
  });

  it('上传期间取消会结束准备，不点击发送也不重新提交', async () => {
    const controller = new AbortController();
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'muse_submit') controller.abort();
      return { taskId };
    });
    await expect(streamMuseText({ messages, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const commands = native.invoke.mock.calls.map(([command]) => command);
    expect(commands.filter((command) => command === 'muse_prepare')).toHaveLength(1);
    expect(commands).toContain('muse_cancel_prepared');
    expect(commands).not.toContain('muse_send');
    expect(commands).not.toContain('muse_query');
  });

  it('上传后节点输入已变化时重新核对，阻止过期请求发送', async () => {
    let changed = false;
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'muse_submit') changed = true;
      return { taskId };
    });
    await expect(streamMuseText({ messages, assertCurrent: () => { if (changed) throw new Error('节点已变化'); } })).rejects.toThrow('节点已变化');
    expect(native.invoke.mock.calls.some(([command]) => command === 'muse_send')).toBe(false);
  });
});

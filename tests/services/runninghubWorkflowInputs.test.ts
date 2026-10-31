import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from '../../src/types';
import { resolveRunningHubInputRouting, splitRunningHubPrompt } from '../../src/services/ai/providers/runninghubWorkflowInputs';

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../../src/services/ai/promptResolver', () => ({ resolvePromptWithMediaRefs: mocks.resolve }));
const workflow: WorkflowDefinition = {
  id: 'rh', name: 'RH', category: 'ai-video', fileContent: '', fileName: 'RH', createdAt: 1, adapterType: 'runninghub',
  defaultNodes: { prompt: '6::text', image: '9::image' },
  runninghub: { version: 1, kind: 'workflow', connectionId: 'runninghub', remoteId: '123', inputBindingMode: 'nodes', parameters: [
    { nodeId: '6', fieldName: 'text', label: '正文', type: 'string', defaultValue: '', source: 'prompt' },
    { nodeId: '9', fieldName: 'image', label: '首帧', type: 'string', defaultValue: '', source: 'image' },
    { nodeId: '9', fieldName: 'other', label: '尾帧', type: 'string', defaultValue: '', source: 'image' },
    { nodeId: '10', fieldName: 'audio', label: '音频', type: 'string', defaultValue: '', source: 'audio' },
    { nodeId: '11', fieldName: 'video', label: '视频', type: 'string', defaultValue: '', source: 'video' },
  ] },
};
beforeEach(() => mocks.resolve.mockReset().mockImplementation(async (raw: string) => ({ prompt: raw, references: [] })));

describe('RH 输入定向与默认回退', () => {
  it('剥离整个芯片，保留括号内的完整文字和外层正文', () => {
    expect(splitRunningHubPrompt('正文 @wf{6::text|正文|prompt}(特写（中文） (close-up)) 继续')).toEqual({
      prompt: '正文  继续', assignments: [{ key: '6::text', type: 'prompt', value: '特写（中文） (close-up)' }],
    });
    expect(() => splitRunningHubPrompt('@wf{6::text|正文|prompt}(未闭合')).toThrow('未闭合');
  });
  it('正文芯片优先于面板旧值，同一远端节点的两个字段分别绑定', async () => {
    const result = await resolveRunningHubInputRouting(workflow,
      '@wf{6::text|正文|prompt}(新正文) @wf{9::image|首帧|image}(https://example.com/first.png) @wf{9::other|尾帧|image}(https://example.com/last.png)',
      { '6::text': '旧正文' });
    expect(result.bindings.get('6::text')).toEqual({ value: '新正文' });
    expect(result.bindings.get('9::image')?.mediaSource).toBe('https://example.com/first.png');
    expect(result.bindings.get('9::other')?.mediaSource).toBe('https://example.com/last.png');
    expect(result.mentionedTypes).toEqual(new Set(['prompt', 'image']));
  });
  it.each(['image', 'audio', 'video'] as const)('解析 %s 引用为素材地址', async (kind) => {
    mocks.resolve.mockResolvedValue({ prompt: '素材1', references: [{ kind, url: `https://example.com/${kind}` }] });
    const key = kind === 'image' ? '9::image' : kind === 'audio' ? '10::audio' : '11::video';
    const result = await resolveRunningHubInputRouting(workflow, `@wf{${key}|素材|${kind}}(@{source:素材})`);
    expect(result.bindings.get(key)?.mediaSource).toBe(`https://example.com/${kind}`);
  });
  it('无显式赋值时不制造绑定，默认目标交由执行器使用', async () => {
    const result = await resolveRunningHubInputRouting(workflow, '正文');
    expect(result.bindings.size).toBe(0);
    expect(result.nodeMode).toBe(true);
    expect(result.defaults).toEqual(workflow.defaultNodes);
  });
  it('旧记录不强制切换输入模式', async () => {
    expect((await resolveRunningHubInputRouting({ ...workflow, runninghub: { ...workflow.runninghub!, inputBindingMode: undefined } }, '')).nodeMode).toBe(false);
  });
  it.each([
    '@wf{missing|旧输入|image}(https://example.com/a.png)',
    '@wf{6::text|正文|audio}(https://example.com/a.mp3)',
  ])('拒绝失效或冒充类型的芯片 %s', async (raw) => {
    await expect(resolveRunningHubInputRouting(workflow, raw)).rejects.toThrow('映射已失效');
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it('同一字段多次指定、素材类型错误和单槽多图明确报错', async () => {
    await expect(resolveRunningHubInputRouting(workflow, '@wf{6::text|正文|prompt}(a) @wf{6::text|正文|prompt}(b)')).rejects.toThrow('重复指定');
    mocks.resolve.mockResolvedValue({ prompt: '', references: [{ kind: 'audio', url: 'https://example.com/a.mp3' }] });
    await expect(resolveRunningHubInputRouting(workflow, '@wf{9::image|图|image}(@{a:音频})')).rejects.toThrow('对应类型');
    mocks.resolve.mockResolvedValue({ prompt: '', references: [{ kind: 'image', url: 'https://example.com/a.png' }, { kind: 'image', url: 'https://example.com/b.png' }] });
    await expect(resolveRunningHubInputRouting(workflow, '@wf{9::image|图|image}(@{a:两图})')).rejects.toThrow('一份');
  });
  it('取消后不继续解析素材', async () => {
    await expect(resolveRunningHubInputRouting(workflow, '@wf{9::image|图|image}(https://example.com/a.png)', {}, AbortSignal.abort())).rejects.toThrow();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it('未完成的芯片头和嵌套的工作流标记不发送给远端', async () => {
    expect(() => splitRunningHubPrompt('正文 @wf{6::text|')).toThrow('格式无效');
    await expect(resolveRunningHubInputRouting(workflow, '@wf{6::text|正文|prompt}(@wf{6::text|正文|prompt}(嵌套))')).rejects.toThrow('不能嵌套');
    mocks.resolve.mockResolvedValue({ prompt: '@wf{6::text|正文|prompt}(来源文字)', references: [] });
    await expect(resolveRunningHubInputRouting(workflow, '@wf{6::text|正文|prompt}(@{node:来源})')).rejects.toThrow('引用内容');
  });
});

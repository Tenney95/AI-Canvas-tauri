/**
 * runninghubWorkflowImport — 回归测试：云工作流参数界面。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RunningHubWorkflowImport from '../../src/components/runninghub/RunningHubWorkflowImport';
import RunningHubParameterFields from '../../src/components/nodes/shared/RunningHubParameterFields';
import type { WorkflowDefinition } from '../../src/types';
import type { RunningHubParameter } from '../../src/types/runninghub';
import { runningHubFieldValue } from '../../src/services/runninghubWorkflowService';

const driver = vi.hoisted(() => ({ active: false, cursor: 0, states: [] as unknown[], add: vi.fn(), update: vi.fn() }));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const stateHook = actual.useState; const effectHook = actual.useEffect; const refHook = actual.useRef;
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      if (!driver.active) return stateHook(initial);
      const index = driver.cursor++;
      if (!(index in driver.states)) driver.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [driver.states[index], (next: T | ((current: T) => T)) => {
        driver.states[index] = typeof next === 'function' ? (next as (current: T) => T)(driver.states[index] as T) : next;
      }];
    },
    useEffect: (...args: Parameters<typeof actual.useEffect>) => { if (!driver.active) effectHook(...args); },
    useRef: <T,>(initial: T) => driver.active ? { current: initial } : refHook(initial),
  };
});
vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>();
  return { ...actual, useT: () => actual.t };
});
vi.mock('../../src/store/useAppStore', async (original) => {
  const actual = await original<typeof import('../../src/store/useAppStore')>();
  const store = actual.useAppStore;
  const state = () => ({ config: { providers: {} }, addWorkflow: driver.add, updateWorkflow: driver.update });
  return { ...actual, useAppStore: Object.assign(
    (selector: (value: unknown) => unknown) => driver.active ? selector(state()) : store(selector),
    actual.useAppStore,
    { getState: () => driver.active ? state() : actual.useAppStore.getState() },
  ) };
});

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function renderEditor(editing?: WorkflowDefinition, onSaved = vi.fn()) {
  driver.active = true; driver.cursor = 0;
  return elements(RunningHubWorkflowImport({ kind: 'app', editing, onSaved }));
}
beforeEach(() => {
  driver.active = false; driver.cursor = 0; driver.states = [];
  driver.add.mockReset().mockResolvedValue(undefined); driver.update.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { driver.active = false; });

const workflow: WorkflowDefinition = { id: 'wf-cloud', name: '音频处理', category: 'ai-audio', fileContent: '', fileName: 'RH', createdAt: 1, adapterType: 'runninghub', runninghub: { version: 1, kind: 'app', remoteId: '1904152026220003329', connectionId: 'runninghub-model', parameters: [
  { nodeId: '6', fieldName: 'text', type: 'string', label: '正面提示词', defaultValue: '', source: 'prompt' },
  { nodeId: '3', fieldName: 'count', type: 'number', label: '数量', defaultValue: 0, source: 'value' },
  { nodeId: '3', fieldName: 'enabled', type: 'boolean', label: '启用', defaultValue: false, source: 'value' },
  { nodeId: '4', fieldName: 'audio', type: 'string', label: '参考音频', defaultValue: '', source: 'audio', referenceIndex: 1 },
] } };

describe('云工作流参数界面', () => {
  it('编辑时保留输出类型、长 ID、连接、参数类型与已保存映射', () => {
    const html = renderToStaticMarkup(<RunningHubWorkflowImport kind="app" editing={workflow} onSaved={vi.fn()} />);
    expect(html).toContain('value="1904152026220003329"');
    expect(html).toContain('value="ai-audio" selected=""');
    expect(html).toContain('value="runninghub-model" selected=""');
    expect(html).toContain('正面提示词 · 提示词');
    expect(html).toContain('参考音频 · audio #2');
    expect(html).toContain('保存修改');
  });
  it('生成参数保留零与 false，动态映射提示用户应提供的引用', () => {
    const html = renderToStaticMarkup(<RunningHubParameterFields parameters={workflow.runninghub!.parameters} values={{ '3::count': '2' }} onChange={vi.fn()} disabled />);
    expect(html).toContain('value="2"');
    expect(html).toContain('value="false" selected=""');
    expect(html).toContain('使用本次提示词');
    expect(html).toContain('使用第 2 个音频参考素材');
    expect(html).toContain('disabled=""');
  });
  it('新建来源明确区分应用和工作流，未解析前不出现保存按钮', () => {
    const app = renderToStaticMarkup(<RunningHubWorkflowImport kind="app" onSaved={vi.fn()} />);
    const graph = renderToStaticMarkup(<RunningHubWorkflowImport kind="workflow" onSaved={vi.fn()} />);
    expect(app).toContain('AI 应用链接或 ID');
    expect(graph).toContain('工作流链接或 ID');
    expect(app).toContain('API 定义');
    expect(app).not.toContain('添加云工作流');
  });
  it('节点参数浮层只保留可调参数，主提示词和素材统一使用节点输入', () => {
    const parameters = workflow.runninghub!.parameters.map((field) => field.source === 'prompt'
      ? { ...field, fieldName: 'prompt', source: 'value' as const, defaultValue: '过期示例正文' } : field);
    const html = renderToStaticMarkup(<RunningHubParameterFields appearance="popover" parameters={parameters} onChange={vi.fn()} />);
    expect(html).toContain('数量');
    expect(html).toContain('启用');
    expect(html).not.toContain('过期示例正文');
    expect(html).not.toContain('提示词与参考素材');
    expect(html).not.toContain('参考音频');
    const editor = renderToStaticMarkup(<RunningHubWorkflowImport kind="app" editing={{ ...workflow, runninghub: { ...workflow.runninghub!, parameters } }} onSaved={vi.fn()} />);
    expect(editor).toContain('正面提示词 · 提示词');
    expect(editor).toContain('输入来源');
  });
  it('带括号说明的主提示词使用本轮输入，反向提示词仍可在浮层编辑', () => {
    const primaryLabel = '提示词（可选, 描述你的画面, 默认不用填）';
    const negativeLabel = '反向提示词（可选）';
    const parameters: RunningHubParameter[] = [
      { nodeId: '8', fieldName: 'text_a', label: primaryLabel, type: 'string', defaultValue: '不应进入参数浮层的主提示词示例', source: 'value' },
      { nodeId: '9', fieldName: 'text_b', label: negativeLabel, type: 'string', defaultValue: '保留的反向约束', source: 'value', multiline: true },
    ];
    const html = renderToStaticMarkup(<RunningHubParameterFields appearance="popover" parameters={parameters} onChange={vi.fn()} />);
    expect(html).not.toContain(primaryLabel);
    expect(html).not.toContain('不应进入参数浮层的主提示词示例');
    expect(html).toContain(negativeLabel);
    expect(html).toContain('>保留的反向约束</textarea>');
    const editor = renderToStaticMarkup(<RunningHubWorkflowImport kind="app" editing={{ ...workflow, category: 'ai-image', runninghub: { ...workflow.runninghub!, parameters } }} onSaved={vi.fn()} />);
    expect(editor).toContain(`${primaryLabel} · 提示词`);
    expect(editor).toContain('使用本轮节点输入的提示词，不使用导入示例');
    expect(editor).toContain(`${negativeLabel} · 固定值 / 可调整`);
    expect(editor).toContain('保留的反向约束');
    expect(parameters.map((field) => field.source)).toEqual(['value', 'value']);
  });
  it('旧 RH 调度器在浮层兼容常用下拉，保留未知当前值且不修改执行合同', () => {
    const field: RunningHubParameter = { nodeId: '5', fieldName: 'scheduler', label: '调度器', type: 'string', source: 'value', defaultValue: 'simple' };
    const onChange = vi.fn();
    const html = renderToStaticMarkup(<RunningHubParameterFields appearance="popover" parameters={[field]}
      values={{ '5::scheduler': 'old_custom' }} onChange={onChange} />);
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('当前值：old_custom');
    expect(html).toContain('sgm_uniform');
    expect(html).toContain('ddim_uniform');
    expect(field.options).toBeUndefined();
    expect(runningHubFieldValue(field, 'old_custom')).toBe('old_custom');
    expect(onChange).not.toHaveBeenCalled();
    const actual = renderToStaticMarkup(<RunningHubParameterFields appearance="popover" parameters={[{ ...field, defaultValue: 'custom_a', options: ['custom_a', 'custom_b'] }]} onChange={onChange} />);
    expect(actual).toContain('aria-haspopup="listbox"');
    expect(actual).toContain('custom_b');
    expect(actual).not.toContain('sgm_uniform');
    const unrelated = renderToStaticMarkup(<RunningHubParameterFields appearance="popover" parameters={[{ ...field, defaultValue: 'other_plugin' }]} onChange={onChange} />);
    expect(unrelated).not.toContain('aria-haspopup="listbox"');
    expect(unrelated).toContain('value="other_plugin"');
  });
  it('动态来源只显示本轮绑定说明，固定参数仍保留默认值与枚举', () => {
    const parameters: RunningHubParameter[] = [
      ...(['image', 'video', 'audio'] as const).map((source, index) => ({
        nodeId: String(index + 10), fieldName: source, label: source, type: 'string' as const,
        defaultValue: 'old-example', options: ['old-candidate'], source, referenceIndex: index,
        mediaFormat: source === 'video' ? 'url' as const : 'filename' as const,
      })),
      { nodeId: '20', fieldName: 'prompt', label: '提示词', type: 'string', defaultValue: '导入的旧提示词', source: 'prompt' },
      { nodeId: '21', fieldName: 'mode', label: '模式', type: 'string', defaultValue: 'simple', options: ['simple', 'karras'], source: 'value' },
    ];
    const html = renderToStaticMarkup(<RunningHubWorkflowImport kind="app" editing={{ ...workflow, runninghub: { ...workflow.runninghub!, parameters } }} onSaved={vi.fn()} />);
    expect(html).toContain('使用本轮第 1 个图片参考素材，经 RunningHub 官方上传后传入文件名');
    expect(html).toContain('使用本轮第 2 个视频参考素材，经 RunningHub 官方上传后传入URL');
    expect(html).toContain('使用本轮第 3 个音频参考素材，经 RunningHub 官方上传后传入文件名');
    expect(html).toContain('使用本轮节点输入的提示词，不使用导入示例');
    expect(html).toContain('LoadImage 等文件读取节点使用文件名；URL 输入节点使用 URL');
    expect(html).not.toContain('old-example');
    expect(html).not.toContain('old-candidate');
    expect(html).not.toContain('导入的旧提示词');
    expect(html).toContain('默认值 · string');
    expect(html).toContain('karras');
  });
  it('保存动态来源时保留合法原值与映射，不用旧枚举拦截空值', async () => {
    const parameters: RunningHubParameter[] = [
      { nodeId: '4', fieldName: 'image', label: '上传图片', type: 'string', defaultValue: '', options: ['old.png'], source: 'image', sourceExplicit: true, required: true, referenceIndex: 1, mediaFormat: 'url' },
      { nodeId: '6', fieldName: 'prompt', label: '提示词', type: 'string', defaultValue: '', options: ['old prompt'], source: 'prompt' },
      { nodeId: '3', fieldName: 'enabled', label: '启用', type: 'boolean', defaultValue: false, source: 'value' },
    ];
    const editing = { ...workflow, runninghub: { ...workflow.runninghub!, parameters } };
    const onSaved = vi.fn();
    const save = renderEditor(editing, onSaved).find((element) => element.type === 'button' && element.props.children === '保存修改')!;
    (save.props.onClick as () => void)();
    await Promise.resolve();
    expect(driver.update).toHaveBeenCalledWith(editing.id, expect.objectContaining({ runninghub: expect.objectContaining({ parameters }) }));
    expect(driver.add).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledOnce();
  });
  it('固定参数的非法枚举仍阻止保存', async () => {
    const field: RunningHubParameter = { nodeId: '3', fieldName: 'mode', label: '模式', type: 'string', defaultValue: 'invalid', options: ['simple'], source: 'value' };
    const editing = { ...workflow, runninghub: { ...workflow.runninghub!, parameters: [field] } };
    const save = renderEditor(editing).find((element) => element.type === 'button' && element.props.children === '保存修改')!;
    (save.props.onClick as () => void)();
    await Promise.resolve();
    expect(driver.update).not.toHaveBeenCalled();
    expect(driver.add).not.toHaveBeenCalled();
    expect(renderEditor(editing).find((element) => element.props.role === 'status')?.props.children).toBe('模式 不在允许的选项中');
  });
  it('编辑目标删除后保留未保存草稿，显式添加时使用新 ID 而非更新旧记录', async () => {
    const onSaved = vi.fn();
    const editor = renderEditor(workflow, onSaved);
    const nameInput = editor.find((element) => element.type === 'input' && element.props.value === workflow.name)!;
    (nameInput.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '重新添加的音频工作流' } });
    const fields = editor.find((element) => element.type === RunningHubParameterFields && (element.props.parameters as RunningHubParameter[])[0].fieldName === 'count')!;
    (fields.props.onChange as (values: Record<string, string>) => void)({ '3::count': '2' });

    const deletedEditor = renderEditor(undefined, onSaved);
    expect(deletedEditor.some((element) => element.props.children === '保存修改')).toBe(false);
    expect(deletedEditor.some((element) => element.type === 'input' && element.props.value === '重新添加的音频工作流')).toBe(true);
    expect(driver.add).not.toHaveBeenCalled();
    expect(driver.update).not.toHaveBeenCalled();
    const save = deletedEditor.find((element) => element.type === 'button' && element.props.children === '添加云工作流')!;
    (save.props.onClick as () => void)();
    await Promise.resolve();

    expect(driver.update).not.toHaveBeenCalled();
    expect(driver.add).toHaveBeenCalledOnce();
    const added = driver.add.mock.calls[0][0] as WorkflowDefinition;
    expect(added.id).toBeTruthy();
    expect(added.id).not.toBe(workflow.id);
    expect(added).toMatchObject({
      name: '重新添加的音频工作流', category: 'ai-audio', adapterType: 'runninghub',
      runninghub: { ...workflow.runninghub!, parameters: workflow.runninghub!.parameters.map((field) => field.fieldName === 'count' ? { ...field, defaultValue: 2 } : field) },
    });
    expect(onSaved).toHaveBeenCalledOnce();
  });
});

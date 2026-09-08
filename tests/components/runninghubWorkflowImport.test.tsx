import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import RunningHubWorkflowImport from '../../src/components/runninghub/RunningHubWorkflowImport';
import RunningHubParameterFields from '../../src/components/nodes/shared/RunningHubParameterFields';
import type { WorkflowDefinition } from '../../src/types';

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
});

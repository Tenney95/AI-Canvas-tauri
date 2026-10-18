import { describe, expect, it } from 'vitest';
import { importRunningHubDefinition, parseRunningHubId, parseRunningHubJson, runningHubFieldValue, validateRunningHubManifest } from '../../src/services/runninghubWorkflowService';
import { runningHubConnection, workflowExecution } from '../../src/services/workflowExecutionService';
import { RunningHubRequestError } from '../../src/services/ai/providers/runninghubClient';
import type { RunningHubWorkflowManifest } from '../../src/types/runninghub';

const options = { kind: 'workflow' as const, remoteId: '1904152026220003329', connectionId: 'runninghub' as const };
const graph = { '6': { class_type: 'CLIPTextEncode', inputs: { text: '猫', link: ['1', 0] }, _meta: { title: '正面提示词' } }, '3': { class_type: 'KSampler', inputs: { seed: 0, denoise: 0.5, enabled: false, api_key: 'do-not-save' } } };

describe('RunningHub 导入与参数合同', () => {
  it('保留官方数字形式的长 ID，并区分工作流与应用链接', () => {
    expect(parseRunningHubJson('{"webappId":1904152026220003329}')).toEqual({ webappId: options.remoteId });
    expect(parseRunningHubId(`https://www.runninghub.cn/workflow/${options.remoteId}?x=1`, 'workflow')).toBe(options.remoteId);
    expect(parseRunningHubId(`https://www.runninghub.ai/ai-detail/${options.remoteId}`, 'app')).toBe(options.remoteId);
    expect(() => parseRunningHubId('https://evil.test/workflow/123', 'workflow')).toThrow();
    expect(() => parseRunningHubId('https://www.runninghub.cn/ai-detail/123', 'workflow')).toThrow();
  });
  it('兼容带语言前缀的官方分享链接，保持长 ID 和导入类型', () => {
    const appId = '2108920489564520450';
    expect(parseRunningHubId(`https://www.runninghub.ai/zh-cn/ai-detail/${appId}`, 'app')).toBe(appId);
    expect(parseRunningHubId(`https://runninghub.ai/en/webapp/${appId}/?share=1#detail`, 'app')).toBe(appId);
    expect(parseRunningHubId(`https://www.runninghub.cn/zh-CN/workflow/${options.remoteId}`, 'workflow')).toBe(options.remoteId);
    expect(parseRunningHubId(appId, 'app')).toBe(appId);
    const manifest = importRunningHubDefinition('{"nodeInfoList":[]}', { ...options, kind: 'app', remoteId: `https://www.runninghub.ai/zh-cn/ai-detail/${appId}` });
    expect(manifest.remoteId).toBe(appId);
    expect(manifest.connectionId).toBe(options.connectionId);
  });
  it('语言前缀不允许绕过域名、资源类型、凭据及路径结构校验', () => {
    for (const invalid of [
      'https://evil.test/zh-cn/ai-detail/123',
      'https://www.runninghub.ai.evil.test/zh-cn/ai-detail/123',
      'https://user:secret@www.runninghub.ai/zh-cn/ai-detail/123',
      'https://www.runninghub.ai/zh-cn/workflow/123',
      'https://www.runninghub.ai/arbitrary/ai-detail/123',
      'https://www.runninghub.ai/zh-cn/en/ai-detail/123',
      'https://www.runninghub.ai/zh-cn/ai-detail/123/extra',
    ]) expect(() => parseRunningHubId(invalid, 'app')).toThrow('AI 应用');
    expect(() => parseRunningHubId('https://www.runninghub.ai/zh-cn/ai-detail/123', 'workflow')).toThrow('工作流');
  });
  it('901 业务失败显示应用不存在，同时保留 HTTP 与业务码', () => {
    const error = new RunningHubRequestError(901, 200);
    expect(error.message).toContain('AI 应用不存在');
    expect(error.message).toContain('业务码 901，HTTP 200');
    expect(error).toMatchObject({ code: 901, httpStatus: 200 });
  });
  it('读取 API graph 的标量，不推测提示词映射，不保存鉴权字段', () => {
    const manifest = importRunningHubDefinition(JSON.stringify({ code: 0, data: { prompt: JSON.stringify(graph) } }), options);
    expect(manifest.parameters).toHaveLength(4);
    expect(manifest.parameters.find((field) => field.fieldName === 'text')).toMatchObject({ source: 'value', label: '正面提示词 · text', defaultValue: '猫' });
    expect(manifest.parameters.find((field) => field.fieldName === 'enabled')?.defaultValue).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain('do-not-save');
  });
  it('静态解析 curl 请求体，保留 nodeInfoList 数值与布尔类型', () => {
    const input = `curl https://www.runninghub.cn/task/openapi/ai-app/run -H 'Authorization: Bearer secret' --data '{"apiKey":"secret","webappId":1904152026220003329,"nodeInfoList":[{"nodeId":"6","fieldName":"count","fieldType":"INT","fieldValue":"0"},{"nodeId":"7","fieldName":"enabled","fieldType":"BOOLEAN","fieldValue":false}]}'`;
    const result = importRunningHubDefinition(input, { ...options, kind: 'app', remoteId: '' });
    expect(result.remoteId).toBe(options.remoteId);
    expect(result.parameters.map((field) => field.defaultValue)).toEqual([0, false]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('识别确定的媒体节点且保留各类型顺序与上传格式', () => {
    const result = importRunningHubDefinition(JSON.stringify({ a: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, b: { class_type: 'LoadImageFromUrl', inputs: { image: 'https://cdn.test/b.png' } }, c: { class_type: 'LoadAudio', inputs: { audio: 'a.wav' } } }), options);
    expect(result.parameters).toMatchObject([{ source: 'image', referenceIndex: 0, mediaFormat: 'filename' }, { source: 'image', referenceIndex: 1, mediaFormat: 'url' }, { source: 'audio', referenceIndex: 0 }]);
  });
  it('拒绝 UI graph、超长定义、额外密钥、重复参数和本地路径', () => {
    expect(() => importRunningHubDefinition('{"nodes":[]}', options)).toThrow('API');
    expect(() => parseRunningHubJson(' '.repeat(1_500_001))).toThrow('限制');
    const manifest = importRunningHubDefinition(JSON.stringify(graph), options);
    expect(() => validateRunningHubManifest({ ...manifest, apiKey: 'secret' } as RunningHubWorkflowManifest)).toThrow();
    expect(() => validateRunningHubManifest({ ...manifest, parameters: [manifest.parameters[0], manifest.parameters[0]] })).toThrow('重复');
    expect(() => validateRunningHubManifest({ ...manifest, parameters: [{ ...manifest.parameters[0], type: 'string', defaultValue: 'G:\\private\\input.png' }] })).toThrow('本地');
  });
  it('空数字不变成零，false 不变成 true，枚举按真实类型校验', () => {
    const fields = importRunningHubDefinition(JSON.stringify(graph), options).parameters;
    const seed = fields.find((field) => field.fieldName === 'seed')!;
    const enabled = fields.find((field) => field.fieldName === 'enabled')!;
    expect(runningHubFieldValue(seed, '0')).toBe(0);
    expect(runningHubFieldValue(enabled, 'false')).toBe(false);
    expect(() => runningHubFieldValue(seed, '')).toThrow('数字');
    expect(() => runningHubFieldValue({ ...seed, options: [1, 2] }, '3')).toThrow('选项');
  });
  it('旧记录按 ComfyUI 执行，云连接必须使用其指定密钥', () => {
    const wf = { id: 'local', name: '旧工作流', category: 'ai-image' as const, fileContent: '{}', fileName: 'a.json', createdAt: 1 };
    expect(workflowExecution(wf)).toMatchObject({ provider: 'comfyui', model: 'comfyui/workflow' });
    expect(workflowExecution({ ...wf, adapterType: 'runninghub', runninghub: { version: 1, ...options, parameters: [] } })).toMatchObject({ provider: 'runninghubwf', model: 'runninghubwf/local' });
    expect(runningHubConnection({ runninghub: { name: 'RH', apiKey: 'secret', baseUrl: 'https://www.runninghub.cn/openapi/v2' } }, 'runninghub').baseUrl).toBe('https://www.runninghub.cn');
    const connections = {
      runninghub: { name: '国际工作流', apiKey: 'workflow-secret', baseUrl: 'https://www.runninghub.ai/openapi/v2' },
      'runninghub-model': { name: '国内模型', apiKey: 'model-secret', baseUrl: 'https://www.runninghub.cn/openapi/v2' },
    };
    expect(runningHubConnection(connections, 'runninghub')).toEqual({ apiKey: 'workflow-secret', baseUrl: 'https://www.runninghub.ai' });
    expect(runningHubConnection(connections, 'runninghub-model')).toEqual({ apiKey: 'model-secret', baseUrl: 'https://www.runninghub.cn' });
    expect(() => runningHubConnection({ runninghub: { name: 'RH', apiKey: 'secret' } }, 'runninghub-model')).toThrow('模型');
  });
});

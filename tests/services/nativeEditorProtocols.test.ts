/** 固定合同仅使用受控 HTTP 替身，不读取项目或提交真实媒体。 */
import { beforeEach, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: transport.fetch }));
import { buildModelProtocolRequest, submitModelProtocol } from '../../src/services/ai/modelProtocol';
import { apimartEditorTaskIds, APIMART_EDITOR_PROTOCOL, DREAMINA_EDITOR_PROTOCOL, RUNNINGHUB_EDITOR_PROTOCOL, VOLCENGINE_EDITOR_PROTOCOL } from '../../src/services/nativeEditorProtocols';
import { captureNativeProtocolContext, resolveNativeProtocolContext } from '../../src/services/nativeModelProtocolTask';
import { getRunningHubModel, runningHubFrameRole } from '../../src/services/ai/providers/runninghubModelManifest';
beforeEach(() => transport.fetch.mockReset());

it('火山保持原api/v3路径、首尾帧字节与提示词原文，不把提示词当成模板再次执行', () => {
  const request = { model: 'doubao-seedance-2-5', content: [{ type: 'text', text: '保留 {{notAVariable}}' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' }, role: 'first_frame' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,BAUG' }, role: 'last_frame' }] };
  const built = buildModelProtocolRequest({ apiKey: 'ephemeral-key', baseUrl: 'https://ark.example/api/v3', protocol: VOLCENGINE_EDITOR_PROTOCOL, variables: { request } });
  expect(built.url).toBe('https://ark.example/api/v3/contents/generations/tasks');
  expect(JSON.parse(built.init.body as string)).toEqual(request);
  expect(JSON.stringify(request)).not.toContain('ephemeral-key');
});

it('APIMart用既有videos/generations与data[0].task_id解析原回执', async () => {
  transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, data: [{ task_id: 'original-task', status: 'submitted' }] }), { status: 200 }));
  const submitted = await submitModelProtocol({ apiKey: 'ephemeral-key', baseUrl: 'https://api.example/v1', protocol: APIMART_EDITOR_PROTOCOL,
    variables: { request: { model: 'seedance-2.5', prompt: '转场', image_with_roles: [{ url: 'https://media.example/first.png', role: 'first_frame' },
      { url: 'https://media.example/last.png', role: 'last_frame' }] } } });
  expect(submitted.taskId).toBe('original-task');
  expect(submitted.poll?.url).toBe('https://api.example/v1/tasks/original-task');
  expect(transport.fetch).toHaveBeenCalledOnce();
});

it('网络中断仅传播提交未知，不自动重试付费POST', async () => {
  transport.fetch.mockRejectedValueOnce(new Error('connection closed'));
  await expect(submitModelProtocol({ apiKey: 'ephemeral-key', baseUrl: 'https://ark.example/api/v3', protocol: VOLCENGINE_EDITOR_PROTOCOL,
    variables: { request: { model: 'doubao-seedance-2-5', content: [] } } })).rejects.toThrow();
  expect(transport.fetch).toHaveBeenCalledOnce();
});

it('明确首尾帧RunningHub型号与原任务查询合同一致，不把双参考型号视为首尾帧', () => {
  const definition = getRunningHubModel('runninghub/vidu/start-end-to-video-q2-turbo', true)!;
  expect(definition.parameters.filter((field) => field.required && field.mediaKind === 'image').map(runningHubFrameRole)).toEqual(['first_frame', 'last_frame']);
  const ordinary = getRunningHubModel('runninghub/vidu/image-to-video-q3-turbo', true)!;
  expect(ordinary.parameters.some((field) => runningHubFrameRole(field) === 'last_frame')).toBe(false);
  const saved = captureNativeProtocolContext(RUNNINGHUB_EDITOR_PROTOCOL, { taskId: '123456', results: [], prompt: '不可进账本' });
  expect(saved).toEqual({ submit: { taskId: '123456' } });
  expect(resolveNativeProtocolContext(RUNNINGHUB_EDITOR_PROTOCOL, '123456', saved)).toEqual(saved);
  expect(captureNativeProtocolContext(DREAMINA_EDITOR_PROTOCOL, { submitId: 'original-native-id', outputs: [] })).toEqual({ submit: { submitId: 'original-native-id' } });
});

it('APIMart保留全部原任务ID，不截首项；拒绝凭据回显和不完整任务集合', () => {
  expect(apimartEditorTaskIds({ data: [{ task_id: 'first' }, { task_id: 'second' }, { task_id: 'third' }, { task_id: 'second' }] }, 'ephemeral-key')).toEqual(['first', 'second', 'third']);
  expect(() => apimartEditorTaskIds({ data: [{ task_id: 'first' }, { task_id: 'ephemeral-key' }] }, 'ephemeral-key')).toThrow('安全');
  expect(() => apimartEditorTaskIds({ data: [{ task_id: 'first' }, {}] }, 'ephemeral-key')).toThrow();
});

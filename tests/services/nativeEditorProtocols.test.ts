/** 固定合同仅使用受控 HTTP 替身，不读取项目或提交真实媒体。 */
import { beforeEach, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: transport.fetch }));
import { buildModelProtocolRequest, submitModelProtocol } from '../../src/services/ai/modelProtocol';
import { APIMART_EDITOR_PROTOCOL, VOLCENGINE_EDITOR_PROTOCOL } from '../../src/services/nativeEditorProtocols';
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

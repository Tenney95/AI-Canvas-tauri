/** 固定协议恢复合同；不发起网络请求。测试源码待用户运行。 */
import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { GRSAI_H3_PROTOCOL } from '../../src/services/ai/grsaiModels';
import { nativeProtocolTaskDigest, nativeProtocolTaskIdContext, captureNativeProtocolContext,
  resolveNativeProtocolContext, validateNativeProtocolContext, nativeProtocolQueryDigest } from '../../src/services/nativeModelProtocolTask';

afterEach(() => vi.unstubAllGlobals());
it('原任务 ID 可重建查询；依赖输入、响应其他字段或危险路径的协议拒绝', () => {
  expect(nativeProtocolTaskIdContext(GRSAI_H3_PROTOCOL, 'original-task')).toEqual({ submit: { id: 'original-task' } });
  const other = structuredClone(GRSAI_H3_PROTOCOL);
  other.poll!.path += '&prompt={{prompt}}';
  expect(() => nativeProtocolTaskIdContext(other, 'original-task')).toThrow('任务 ID');
  const unsafe = structuredClone(GRSAI_H3_PROTOCOL);
  unsafe.response.taskIdPath = '__proto__.id';
  expect(() => nativeProtocolTaskIdContext(unsafe, 'original-task')).toThrow('任务 ID');
  expect(() => nativeProtocolTaskIdContext(GRSAI_H3_PROTOCOL, '../other-task')).toThrow('任务 ID');
});
it('模型或查询协议改变会改变冻结摘要', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const original = await nativeProtocolTaskDigest('model-a', GRSAI_H3_PROTOCOL);
  expect(await nativeProtocolTaskDigest('model-b', GRSAI_H3_PROTOCOL)).not.toBe(original);
  const changed = structuredClone(GRSAI_H3_PROTOCOL); changed.poll!.path += '&v=2';
  expect(await nativeProtocolTaskDigest('model-a', changed)).not.toBe(original);
});
it('仅冻结原查询依赖的其他响应标量，重启不需要原响应和生成请求', () => {
  const protocol = structuredClone(GRSAI_H3_PROTOCOL);
  protocol.poll!.path = '/query?job={{submit.id}}&region={{submit.data.region}}&model={{model}}';
  const context = captureNativeProtocolContext(protocol, { id: 'original-task', data: { region: 'cn-beijing' },
    apiKey: 'DO-NOT-COPY', result: { url: 'https://untrusted.invalid/private' } }, { model: 'model-v1', prompt: 'DO-NOT-COPY' });
  expect(context).toEqual({ submit: { id: 'original-task', data: { region: 'cn-beijing' } }, model: 'model-v1' });
  expect(resolveNativeProtocolContext(protocol, 'original-task', context)).toEqual(context);
  expect(() => resolveNativeProtocolContext(protocol, 'another-task', context)).toThrow('原任务');
  expect(() => resolveNativeProtocolContext(protocol, 'original-task', { submit: { id: 'original-task' } })).toThrow('上下文');
});
it('凭据、地址、危险属性和过大上下文不能借查询投影落盘', () => {
  expect(() => validateNativeProtocolContext({ token: 'private' })).toThrow();
  expect(() => validateNativeProtocolContext({ id: 'https://untrusted.invalid/task' })).toThrow();
  expect(() => validateNativeProtocolContext({ id: 'C:/private/task' })).toThrow();
  const getter = vi.fn(() => 'never-read');
  const value = Object.defineProperty({}, 'id', { get: getter, enumerable: true });
  expect(() => validateNativeProtocolContext(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
  expect(() => validateNativeProtocolContext({ rows: Array.from({ length: 129 }, () => 'id') })).toThrow();
  const protocol = structuredClone(GRSAI_H3_PROTOCOL); protocol.poll!.path += '?id={{submit.extra}}';
  expect(() => captureNativeProtocolContext(protocol, { id: 'task', extra: 'configured-secret' }, {}, ['configured-secret'])).toThrow('凭据');
});
it('引用映射只改变提交模板时，查询摘要稳定；查询或模型变化仍失效', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const changed = structuredClone(GRSAI_H3_PROTOCOL); changed.submit.body = { model: '{{model}}', images: '{{imageUrls}}' };
  expect(await nativeProtocolQueryDigest('model', changed)).toBe(await nativeProtocolQueryDigest('model', GRSAI_H3_PROTOCOL));
  changed.poll!.path += '?version=next';
  expect(await nativeProtocolQueryDigest('model', changed)).not.toBe(await nativeProtocolQueryDigest('model', GRSAI_H3_PROTOCOL));
});

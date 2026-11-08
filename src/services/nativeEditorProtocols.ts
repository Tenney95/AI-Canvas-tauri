/** 剪辑转场的固定厂商合同；帧和提示词仅通过调用期受信变量进入请求。 */
import type { NormalizedModelExecutionProtocol } from '../types/aiTypes';
import { isSafeNativeProtocolTaskId } from './nativeProtocolContext';

export const VOLCENGINE_EDITOR_PROTOCOL: NormalizedModelExecutionProtocol = { version: 2, mode: 'async', auth: { type: 'bearer' },
  submit: { method: 'POST', path: '/contents/generations/tasks', body: '{{parameters}}' },
  response: { type: 'json', taskIdPath: 'id', errorPath: 'error.message' },
  poll: { method: 'GET', path: '/contents/generations/tasks/{{submit.id}}', response: { statusPath: 'status',
    successValues: ['succeeded'], failureValues: ['failed', 'cancelled'], result: { urlPath: 'content.video_url' }, errorPath: 'error.message' } } };
export const APIMART_EDITOR_PROTOCOL: NormalizedModelExecutionProtocol = { version: 2, mode: 'async', auth: { type: 'bearer' },
  submit: { method: 'POST', path: '/videos/generations', body: '{{parameters}}' },
  response: { type: 'json', taskIdPath: 'data.0.task_id', errorPath: 'error.message' },
  poll: { method: 'GET', path: '/tasks/{{submit.data.0.task_id}}', response: { statusPath: 'status',
    successValues: ['completed'], failureValues: ['failed', 'cancelled', 'error'], result: { urlPath: 'result.videos.*.url' } } } };

/** 固定APIMart批回执逐项保留；单个转场请求也不能假定服务商永远只返回一个任务。 */
export function apimartEditorTaskIds(payload: unknown, apiKey: string): string[] {
  const data = payload && typeof payload === 'object' ? (payload as { data?: unknown }).data : undefined;
  if (!Array.isArray(data) || !data.length || data.length > 128) throw new Error('APIMart 原任务集合无效，未重新提交');
  const ids = data.map((item) => item && typeof item === 'object' ? (item as { task_id?: unknown }).task_id : undefined);
  if (!ids.every((id): id is string => isSafeNativeProtocolTaskId(id, [apiKey]))) throw new Error('APIMart 原任务身份不能安全保存');
  return [...new Set(ids)];
}

/** 只描述 RunningHub 固定模型 API；实际提交仍由受限 manifest endpoint helper 执行。 */
export const RUNNINGHUB_EDITOR_PROTOCOL: NormalizedModelExecutionProtocol = { version: 2, mode: 'async', auth: { type: 'bearer' },
  submit: { method: 'POST', path: '/openapi/v2/{{model}}', body: '{{parameters}}' },
  response: { type: 'json', taskIdPath: 'taskId' },
  poll: { method: 'POST', path: '/openapi/v2/query', body: { taskId: '{{submit.taskId}}' }, response: { statusPath: 'status',
    successValues: ['SUCCESS'], failureValues: ['FAILED', 'CANCELED', 'CANCELLED'], result: { urlPath: 'results.*.url' } } } };

/** 固定原生命令合同的身份；不会作为HTTP端点执行。 */
export const DREAMINA_EDITOR_PROTOCOL: NormalizedModelExecutionProtocol = { version: 2, mode: 'async', auth: { type: 'none' },
  submit: { method: 'POST', path: '/dreamina_generate', body: '{{parameters}}' }, response: { type: 'json', taskIdPath: 'submitId' },
  poll: { method: 'POST', path: '/dreamina_query_result', body: { submitId: '{{submit.submitId}}' },
    response: { statusPath: 'status', successValues: ['success'], failureValues: ['failed'], result: { urlPath: 'outputs.*.url' } } } };

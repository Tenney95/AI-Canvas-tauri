/** 剪辑转场的固定厂商合同；帧和提示词仅通过调用期受信变量进入请求。 */
import type { NormalizedModelExecutionProtocol } from '../types/aiTypes';

export const VOLCENGINE_EDITOR_PROTOCOL: NormalizedModelExecutionProtocol = { version: 2, mode: 'async', auth: { type: 'bearer' },
  submit: { method: 'POST', path: '/contents/generations/tasks', body: '{{request}}' },
  response: { type: 'json', taskIdPath: 'id', errorPath: 'error.message' },
  poll: { method: 'GET', path: '/contents/generations/tasks/{{submit.id}}', response: { statusPath: 'status',
    successValues: ['succeeded'], failureValues: ['failed', 'cancelled'], result: { urlPath: 'content.video_url' }, errorPath: 'error.message' } } };
export const APIMART_EDITOR_PROTOCOL: NormalizedModelExecutionProtocol = { version: 2, mode: 'async', auth: { type: 'bearer' },
  submit: { method: 'POST', path: '/videos/generations', body: '{{request}}' },
  response: { type: 'json', taskIdPath: 'data.0.task_id', errorPath: 'error.message' },
  poll: { method: 'GET', path: '/tasks/{{submit.data.0.task_id}}', response: { statusPath: 'status',
    successValues: ['completed'], failureValues: ['failed', 'cancelled', 'error'], result: { urlPath: 'result.videos.*.url' } } } };

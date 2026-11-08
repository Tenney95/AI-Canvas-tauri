/** 原任务查询只允许由已保存的 taskId 重建；协议正文不进入媒体账本。 */
import type { NormalizedModelExecutionProtocol } from '../types/aiTypes';
import { collectModelProtocolTemplatePaths } from './ai/modelProtocol';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { sha256BytesHex } from './mediaDataUrl';

export function nativeProtocolTaskIdContext(protocol: NormalizedModelExecutionProtocol, taskId: string): Record<string, unknown> {
  const path = protocol.response.taskIdPath;
  const references = collectModelProtocolTemplatePaths(JSON.stringify(protocol.poll));
  if (protocol.mode !== 'async' || !protocol.poll || !path || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)
    || path.split('.').some((part) => ['__proto__', 'constructor', 'prototype'].includes(part))
    || !/^[A-Za-z0-9_-]{1,160}$/.test(taskId) || !references.length || references.some((item) => item !== `submit.${path}`)) {
    throw new Error('查询协议不能仅由原任务 ID 安全重建，未重新提交生成');
  }
  const payload: Record<string, unknown> = {}; let cursor = payload;
  path.split('.').forEach((key, index, keys) => {
    if (index === keys.length - 1) cursor[key] = taskId;
    else { const child = {}; cursor[key] = child; cursor = child; }
  });
  return { submit: payload };
}
export const nativeProtocolTaskDigest = (modelId: string, protocol: NormalizedModelExecutionProtocol) =>
  sha256BytesHex(new TextEncoder().encode(projectModelSourceToken([modelId, protocol])));

/** 原任务查询只使用原 ID 与经过校验的必要字段；协议正文不进入媒体账本。 */
import type { NormalizedModelExecutionProtocol } from '../types/aiTypes';
import { collectModelProtocolTemplatePaths } from './ai/modelProtocol';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { sha256BytesHex } from './mediaDataUrl';

import { isSafeNativeProtocolPath as safeParts, validateNativeProtocolContext } from './nativeProtocolContext';
export { validateNativeProtocolContext, isSafeNativeProtocolTaskId } from './nativeProtocolContext';

export function nativeProtocolQueryPaths(protocol: NormalizedModelExecutionProtocol): string[] {
  const path = protocol.response.taskIdPath;
  const references = [...new Set(collectModelProtocolTemplatePaths(JSON.stringify(protocol.poll)))];
  if (protocol.mode !== 'async' || !protocol.poll || !path || !safeParts(path) || !references.length
    || references.some((reference) => !safeParts(reference))) throw new Error('原查询协议没有可冻结的安全任务上下文');
  return [...new Set([...references, `submit.${path}`])];
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, part);
    if (!descriptor || !('value' in descriptor)) return undefined;
    current = descriptor.value;
  }
  return current;
}
function setPath(context: Record<string, unknown>, path: string, value: unknown): void {
  let current: Record<string, unknown> = context;
  const parts = path.split('.');
  parts.forEach((part, index) => {
    if (index === parts.length - 1) current[part] = structuredClone(value);
    else {
      if (!current[part] || typeof current[part] !== 'object') current[part] = /^\d+$/.test(parts[index + 1]) ? [] : {};
      current = current[part] as Record<string, unknown>;
    }
  });
}

export function captureNativeProtocolContext(protocol: NormalizedModelExecutionProtocol, payload: unknown,
  variables: Record<string, unknown> = {}, secrets: readonly string[] = []): Record<string, unknown> {
  const source = { ...variables, submit: payload }, context: Record<string, unknown> = {};
  for (const path of nativeProtocolQueryPaths(protocol)) {
    const value = readPath(source, path);
    if (value === undefined) throw new Error('提交响应缺少原查询需要的字段，原任务不会重新提交');
    // 先校验选中值再复制，防止 getter／原型或凭据在结构化复制中被隐藏。
    validateNativeProtocolContext({ value });
    const serialized = JSON.stringify(value);
    if (secrets.some((secret) => [secret, secret.trim()].some((key) => key.length > 0 && serialized.includes(key)))) throw new Error('提交响应含有连接凭据，不能保存查询上下文');
    setPath(context, path, value);
  }
  validateNativeProtocolContext(context);
  return context;
}

/** 旧记录继续只由 taskId 重建；新记录核对全部投影字段和原 taskId，不能补造缺失字段。 */
export function resolveNativeProtocolContext(protocol: NormalizedModelExecutionProtocol, taskId: string,
  saved?: Record<string, unknown>): Record<string, unknown> {
  if (!saved) return nativeProtocolTaskIdContext(protocol, taskId);
  validateNativeProtocolContext(saved);
  const paths = nativeProtocolQueryPaths(protocol);
  if (paths.some((path) => readPath(saved, path) === undefined)
    || String(readPath(saved, `submit.${protocol.response.taskIdPath}`)) !== taskId) throw new Error('原任务与冻结的查询上下文不一致');
  return structuredClone(saved);
}

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
/** 动态参考图映射可以改变submit模板；原任务查询仍绑定原模型、鉴权方式与查询合同。 */
export const nativeProtocolQueryDigest = (modelId: string, protocol: NormalizedModelExecutionProtocol) =>
  sha256BytesHex(new TextEncoder().encode(projectModelSourceToken([modelId, protocol.auth, protocol.response.taskIdPath, protocol.poll])));

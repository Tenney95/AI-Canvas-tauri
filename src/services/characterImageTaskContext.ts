/** 角色图片生成的调用期目的地；普通回调和参数布尔值不能创建此身份。 */
import type { MediaDownloadAccess } from '../types/aiTypes';
import type { CharacterImageTaskRecovery } from '../types/media';
import { isSafeNativeProtocolTaskId, validateNativeProtocolContext } from './nativeProtocolContext';
import { validateAuthentication } from './ai/modelProtocolValidation';

export type CharacterImageRecoverySeed = Pick<CharacterImageTaskRecovery, 'kind'> &
  Partial<Pick<CharacterImageTaskRecovery, 'builtinMode' | 'workflow' | 'query' | 'mediaDownloadAccess'>>;
export type CharacterImageExecutionOutputs = Array<{ url: string; kind?: string }> & { incomplete?: true };
export interface CharacterImageExecutionPlan {
  expectedCount?: number;
  recovery: CharacterImageRecoverySeed;
  mediaDownloadAccess?: MediaDownloadAccess;
  isDefinitiveFailure?: (error: unknown) => boolean;
  execute: (beforePost: () => Promise<void>, received: (taskId: string, recoveryContext?: Record<string, unknown>) => Promise<void>, operationId: string) =>
    Promise<CharacterImageExecutionOutputs>;
}
export interface CharacterImageTaskContext {
  assertCurrent: () => void;
  execute: (plan: CharacterImageExecutionPlan) => Promise<never>;
}
const contexts = new WeakMap<() => void | Promise<void>, CharacterImageTaskContext>();
const executed = new WeakSet<() => void | Promise<void>>();

export function registerCharacterImageTaskContext(context: CharacterImageTaskContext) {
  const beforeSubmit = () => context.assertCurrent();
  contexts.set(beforeSubmit, context);
  return { beforeSubmit, release: () => { contexts.delete(beforeSubmit); } };
}
export const isCharacterImageTaskContext = (guard: unknown): boolean =>
  typeof guard === 'function' && contexts.has(guard as () => void);

export async function executeCharacterImageTask(guard: unknown, plan: CharacterImageExecutionPlan): Promise<never> {
  if (!isCharacterImageTaskContext(guard)) throw new Error('角色图片任务缺少受信执行目的地');
  // 登记身份由 WeakMap 核验；布尔查询不把普通回调的反向分支收窄成 never。
  const beforeSubmit = guard as () => void | Promise<void>;
  if (executed.has(beforeSubmit)) throw new Error('本次角色图片作业已经开始，不能重复提交');
  const context = contexts.get(beforeSubmit)!;
  context.assertCurrent();
  executed.add(beforeSubmit);
  return context.execute(plan);
}

/** 同步保存查询身份前检查字段和凭据；查询请求始终由原通道构造。 */
export function validateCharacterImageTaskRecovery(value: CharacterImageTaskRecovery, secrets: readonly string[] = []): void {
  const fields = (object: unknown, allowed: string[]) => !!object && typeof object === 'object' && !Array.isArray(object)
    && [Object.prototype, null].includes(Object.getPrototypeOf(object)) && Reflect.ownKeys(object).every((key) =>
      typeof key === 'string' && allowed.includes(key) && 'value' in Object.getOwnPropertyDescriptor(object, key)!);
  if (!fields(value, ['version', 'kind', 'connectionId', 'providerBase', 'modelRef', 'configurationDigest', 'expectedCount',
    'tasks', 'builtinMode', 'workflow', 'query', 'mediaDownloadAccess'])) throw new Error('角色图片查询回执包含未知字段');
  if (!value || value.version !== 1 || !['builtin', 'apimart', 'general-async', 'workflow', 'protocol'].includes(value.kind)
    || !/^[a-f0-9]{64}$/.test(value.configurationDigest)
    || typeof value.connectionId !== 'string' || !value.connectionId || value.connectionId.length > 256
    || typeof value.modelRef !== 'string' || !value.modelRef || value.modelRef.length > 512
    || !Number.isSafeInteger(value.expectedCount) || value.expectedCount < 1 || value.expectedCount > 128
    || !Array.isArray(value.tasks) || value.tasks.length > 128
    || value.tasks.some((task) => !fields(task, ['taskId', 'recoveryContext']) || !isSafeNativeProtocolTaskId(task.taskId, secrets))
    || new Set(value.tasks.map((task) => task.taskId)).size !== value.tasks.length) throw new Error('角色图片查询回执无效');
  const base = new URL(value.providerBase);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('角色图片原连接地址无效');
  }
  for (const task of value.tasks) if (task.recoveryContext) validateNativeProtocolContext(task.recoveryContext);
  const authErrors: string[] = [];
  if (value.mediaDownloadAccess?.auth) validateAuthentication(value.mediaDownloadAccess.auth, authErrors);
  if (value.kind === 'workflow' && (!fields(value.workflow, ['adapter', 'connectionId', 'providerBase', 'category', 'digest',
    'workflowId', 'modelId', 'serverId', 'outputNodeIds']) || value.workflow?.category !== 'image'
    || value.workflow.connectionId !== value.connectionId || value.workflow.providerBase !== value.providerBase)) throw new Error('角色图片工作流回执无效');
  if (value.kind === 'protocol' && (!fields(value.query, ['modelId', 'digest']) || !value.query?.modelId
    || !/^[a-f0-9]{64}$/.test(value.query.digest))) throw new Error('角色图片原查询协议缺失');
  if (value.kind === 'builtin' && !['standard', 'protocol', 'volcengine', 'ccc', 'dreamina'].includes(value.builtinMode ?? '')) {
    throw new Error('角色图片原接口合同无效');
  }
  if (value.mediaDownloadAccess && (!fields(value.mediaDownloadAccess, ['providerConfigId', 'origin', 'auth'])
    || authErrors.length > 0
    || value.mediaDownloadAccess.auth && !fields(value.mediaDownloadAccess.auth, ['type', 'name', 'prefix'])
    || value.mediaDownloadAccess.providerConfigId !== value.connectionId || value.mediaDownloadAccess.origin !== base.origin)) {
    throw new Error('角色图片下载身份与原连接不一致');
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 64 * 1024 || secrets.some((secret) => secret.trim() && serialized.includes(secret.trim()))) {
    throw new Error('角色图片查询回执超过上限或包含凭据');
  }
}

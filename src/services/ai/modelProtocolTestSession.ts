/**
 * 协议试跑的进程内续查会话；不参与节点任务恢复，也不写本地持久化。
 * 只保留任务身份与不含密钥的查询描述，调用时使用当前连接注入的 Key。
 */
import type { GeneralModelCategory } from '../../types';
import type { ImageOutputCountRange, ResolvedModelProtocolPoll } from '../../types/aiTypes';
import { PollTaskFailedError } from '../pollTask';
import { ModelProtocolHttpError } from './modelProtocolHttp';
import { pollResolvedModelProtocol, submitModelProtocol } from './modelProtocol';
import { assertImageOutputCount, assertModelProtocolResult } from './modelCapabilityValidation';
import type {
  ExecuteModelProtocolResult,
  SubmitModelProtocolOptions,
} from './modelProtocolTypes';

export const MAX_PROTOCOL_TEST_SESSIONS = 32;

export interface ProtocolTestSessionIdentity {
  scopeId: string;
  modelId: string;
  baseUrl: string;
}

export interface ProtocolTestSessionSnapshot {
  status: 'submitting' | 'polling' | 'paused' | 'uncertain' | 'failed';
  /** 固定为提交时的类别，避免编辑期间切换类别影响原任务交付。 */
  category?: GeneralModelCategory;
  taskId?: string;
  canResume: boolean;
  pauseReason?: 'user' | 'query-error';
}

export type ProtocolTestSessionErrorCode =
  | 'invalid-identity'
  | 'existing-session'
  | 'session-limit'
  | 'not-resumable'
  | 'busy'
  | 'paused'
  | 'submission-uncertain'
  | 'different-origin';

/** 界面按 code 提供本地化提示，不把凭据或请求内容拼入会话错误。 */
export class ProtocolTestSessionError extends Error {
  readonly code: ProtocolTestSessionErrorCode;

  constructor(code: ProtocolTestSessionErrorCode) {
    super(code);
    this.name = 'ProtocolTestSessionError';
    this.code = code;
  }
}

interface ProtocolTestSession {
  status: ProtocolTestSessionSnapshot['status'];
  category?: GeneralModelCategory;
  imageOutputCountRange?: ImageOutputCountRange;
  taskId?: string;
  poll?: ResolvedModelProtocolPoll;
  pauseReason?: ProtocolTestSessionSnapshot['pauseReason'];
  controller: AbortController;
  busy: boolean;
}

interface SessionContext {
  key: string;
  baseUrl: string;
}

export interface StartProtocolTestSessionOptions extends Omit<SubmitModelProtocolOptions, 'baseUrl' | 'signal'> {
  identity: ProtocolTestSessionIdentity;
  category?: GeneralModelCategory;
  imageOutputCountRange?: ImageOutputCountRange;
}

export interface ResumeProtocolTestSessionOptions {
  identity: ProtocolTestSessionIdentity;
  apiKey: string;
}

type SessionListener = (snapshot: ProtocolTestSessionSnapshot | undefined) => void;
const sessions = new Map<string, ProtocolTestSession>();
const listeners = new Map<string, Set<SessionListener>>();
const snapshots = new WeakMap<ProtocolTestSession, ProtocolTestSessionSnapshot>();

function sessionContext(identity: ProtocolTestSessionIdentity): SessionContext {
  let url: URL;
  try {
    url = new URL(identity.baseUrl.trim());
  } catch {
    throw new ProtocolTestSessionError('invalid-identity');
  }
  if (!identity.scopeId || !identity.modelId || !['https:', 'http:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) {
    throw new ProtocolTestSessionError('invalid-identity');
  }
  const baseUrl = url.toString().replace(/\/+$/, '');
  return { key: JSON.stringify([identity.scopeId, identity.modelId, baseUrl]), baseUrl };
}

function snapshot(session: ProtocolTestSession | undefined): ProtocolTestSessionSnapshot | undefined {
  if (!session) return undefined;
  const previous = snapshots.get(session);
  const canResume = session.status === 'paused' && !!session.poll && !session.busy;
  if (previous && previous.status === session.status && previous.category === session.category
    && previous.taskId === session.taskId && previous.canResume === canResume
    && previous.pauseReason === session.pauseReason) return previous;
  const current = {
    status: session.status,
    ...(session.category ? { category: session.category } : {}),
    taskId: session.taskId,
    canResume,
    pauseReason: session.pauseReason,
  };
  snapshots.set(session, current);
  return current;
}

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener(snapshot(sessions.get(key)));
}

function isCurrent(key: string, session: ProtocolTestSession): boolean {
  return sessions.get(key) === session;
}

function safeContext(identity: ProtocolTestSessionIdentity): SessionContext | undefined {
  try {
    return sessionContext(identity);
  } catch {
    // 地址仍在编辑时，读取和卸载清理不能阻断设置界面的渲染。
    return undefined;
  }
}

/** 不缓存错误对象；上游意外回显当前 Key 时也不向调用方泄露。 */
function redactError(error: unknown, apiKey: string): Error {
  const message = error instanceof Error ? error.message : 'Protocol test request failed';
  const redacted = apiKey
    ? message.replaceAll(apiKey, '[REDACTED]').replaceAll(encodeURIComponent(apiKey), '[REDACTED]')
    : message;
  if (error instanceof Error && redacted === message) return error;
  return new Error(redacted);
}

function assertSameOrigin(poll: ResolvedModelProtocolPoll, baseUrl: string): void {
  const origin = new URL(baseUrl).origin;
  if (new URL(poll.url).origin !== origin
    || (poll.resultDownload && new URL(poll.resultDownload.url).origin !== origin)) {
    throw new ProtocolTestSessionError('different-origin');
  }
}

export function getProtocolTestSession(identity: ProtocolTestSessionIdentity): ProtocolTestSessionSnapshot | undefined {
  const context = safeContext(identity);
  return context ? snapshot(sessions.get(context.key)) : undefined;
}

export function subscribeProtocolTestSession(identity: ProtocolTestSessionIdentity, listener: SessionListener): () => void {
  const context = safeContext(identity);
  if (!context) return () => {};
  const subscribers = listeners.get(context.key) ?? new Set<SessionListener>();
  subscribers.add(listener);
  listeners.set(context.key, subscribers);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) listeners.delete(context.key);
  };
}

async function querySession(
  context: SessionContext,
  session: ProtocolTestSession,
  apiKey: string,
): Promise<ExecuteModelProtocolResult> {
  const poll = session.poll!;
  try {
    // 每次续查重新验证；查询入口本身还会复核 Header、鉴权和结果下载同源。
    assertSameOrigin(poll, context.baseUrl);
    const result = await pollResolvedModelProtocol(poll, apiKey, session.controller.signal, context.baseUrl, undefined, undefined, session.taskId);
    if (!isCurrent(context.key, session) || session.controller.signal.aborted) {
      throw new ProtocolTestSessionError('paused');
    }
    // 只有可交付的结果才清理任务；映射错误仍保留原 ID 供查询和诊断。
    if (session.category) assertModelProtocolResult(session.category, result);
    assertImageOutputCount(session.imageOutputCountRange, result.urls?.length ?? 0);
    sessions.delete(context.key);
    notify(context.key);
    return { ...result, taskId: session.taskId };
  } catch (error) {
    if (isCurrent(context.key, session)) {
      if (error instanceof PollTaskFailedError) {
        session.status = 'failed';
        session.poll = undefined;
        session.pauseReason = undefined;
      } else {
        session.status = 'paused';
        session.pauseReason = session.controller.signal.aborted ? 'user' : 'query-error';
      }
    }
    throw redactError(error, apiKey);
  }
}

export async function startProtocolTestSession(options: StartProtocolTestSessionOptions): Promise<ExecuteModelProtocolResult> {
  const context = sessionContext(options.identity);
  if (sessions.has(context.key)) throw new ProtocolTestSessionError('existing-session');
  if (sessions.size >= MAX_PROTOCOL_TEST_SESSIONS) throw new ProtocolTestSessionError('session-limit');
  const session: ProtocolTestSession = {
    status: 'submitting', category: options.category, imageOutputCountRange: options.imageOutputCountRange, controller: new AbortController(), busy: true,
  };
  sessions.set(context.key, session);
  notify(context.key);
  let submitting = true;
  try {
    const submitted = await submitModelProtocol({
      apiKey: options.apiKey,
      baseUrl: context.baseUrl,
      protocol: options.protocol,
      variables: options.variables,
      validateResponse: options.validateResponse,
      signal: session.controller.signal,
    });
    if (!isCurrent(context.key, session)) throw new ProtocolTestSessionError('paused');
    // 即使暂停请求先到达，也先保存迟到的 ID，避免已有上游任务变成无法续查。
    if (submitted.poll && submitted.taskId) {
      session.taskId = submitted.taskId;
      session.poll = structuredClone(submitted.poll);
      submitting = false;
      if (session.controller.signal.aborted) {
        session.status = 'paused';
        session.pauseReason = 'user';
        throw new ProtocolTestSessionError('paused');
      }
      session.status = 'polling';
      notify(context.key);
      return await querySession(context, session, options.apiKey);
    }
    if (session.controller.signal.aborted) throw new ProtocolTestSessionError('submission-uncertain');
    const result = { ...(submitted.urls ? { urls: submitted.urls } : {}), ...(submitted.text ? { text: submitted.text } : {}) };
    if (session.category) {
      try {
        assertModelProtocolResult(session.category, result);
        assertImageOutputCount(session.imageOutputCountRange, result.urls?.length ?? 0);
      } catch (error) {
        submitting = false;
        session.status = 'failed';
        throw error;
      }
    }
    sessions.delete(context.key);
    notify(context.key);
    return result;
  } catch (error) {
    if (isCurrent(context.key, session) && submitting) {
      session.status = error instanceof ModelProtocolHttpError && error.status >= 400 && error.status < 500
        && !session.controller.signal.aborted && ![408, 429].includes(error.status) ? 'failed' : 'uncertain';
    }
    throw redactError(error, options.apiKey);
  } finally {
    session.busy = false;
    if (isCurrent(context.key, session)) notify(context.key);
  }
}

export async function resumeProtocolTestSession(options: ResumeProtocolTestSessionOptions): Promise<ExecuteModelProtocolResult> {
  const context = sessionContext(options.identity);
  const session = sessions.get(context.key);
  if (session?.busy) throw new ProtocolTestSessionError('busy');
  if (!session?.poll || session.status !== 'paused') throw new ProtocolTestSessionError('not-resumable');
  session.controller = new AbortController();
  session.status = 'polling';
  session.pauseReason = undefined;
  session.busy = true;
  notify(context.key);
  try {
    return await querySession(context, session, options.apiKey);
  } finally {
    session.busy = false;
    if (isCurrent(context.key, session)) notify(context.key);
  }
}

export function pauseProtocolTestSession(identity: ProtocolTestSessionIdentity): void {
  const context = safeContext(identity);
  const session = context && sessions.get(context.key);
  if (!context || !session || !session.busy) return;
  session.status = session.poll ? 'paused' : 'uncertain';
  session.pauseReason = session.poll ? 'user' : undefined;
  session.controller.abort();
  notify(context.key);
}

/** 仅显式放弃会话；不取消上游任务，界面需事先说明这一点。 */
export function discardProtocolTestSession(identity: ProtocolTestSessionIdentity): void {
  const context = safeContext(identity);
  if (!context) return;
  const session = sessions.get(context.key);
  if (!session) return;
  session.controller.abort();
  sessions.delete(context.key);
  notify(context.key);
}

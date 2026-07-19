/**
 * Declarative model protocol parser and executor.
 * Profiles may map trusted generation variables into JSON, but cannot execute code,
 * override authorization headers, or send requests to a different origin.
 */
import { pollTask } from '../pollTask';
import { corsSafeFetch } from './httpTransport';
import type {
  GeneralModelCategory,
} from '../../types';
import type {
  ModelExecutionProfile,
  ModelExecutionProtocol,
  ModelProtocolAuthConfig,
  ModelProtocolPollTemplate,
  ModelProtocolPresetId,
  ModelProtocolRequestTemplate,
  ProtocolJsonValue,
  ResolvedModelProtocolPoll,
} from '../../types/aiTypes';

const TEMPLATE_RE = /{{\s*([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_-]+)*)\s*}}/g;
const FULL_TEMPLATE_RE = /^{{\s*([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_-]+)*)\s*}}$/;
const ALLOWED_VARIABLE_ROOTS = new Set([
  'model',
  'prompt',
  'messages',
  'stream',
  'tools',
  'toolChoice',
  'size',
  'imageSize',
  'aspectRatio',
  'width',
  'height',
  'n',
  'batchCount',
  'frames',
  'frames8n1',
  'fps',
  'duration',
  'videoResolution',
  'videoFrames',
  'videoFps',
  'seedanceResolution',
  'seedanceRatio',
  'seedanceDuration',
  'generateAudio',
  'imageUrls',
  'audioVoice',
  'audioFormat',
  'audioSpeed',
  'musicTitle',
  'musicLyrics',
  'musicBpm',
]);
const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const BLOCKED_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'host',
  'origin',
  'referer',
  'cookie',
  'set-cookie',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
]);
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const OMIT_TEMPLATE_VALUE = Symbol('omit-template-value');

export type ModelProtocolVariables = Record<string, ProtocolJsonValue | undefined>;

export interface SubmitModelProtocolOptions {
  apiKey: string;
  baseUrl: string;
  protocol: ModelExecutionProtocol;
  variables: ModelProtocolVariables;
}

export interface SubmittedModelProtocol {
  urls?: string[];
  text?: string;
  poll?: ResolvedModelProtocolPoll;
  taskId?: string;
}

export interface ExecuteModelProtocolOptions extends SubmitModelProtocolOptions {
  signal?: AbortSignal;
}

export type BuildModelProtocolRequestOptions = SubmitModelProtocolOptions & {
  signal?: AbortSignal;
};

export interface ExecuteModelProtocolResult {
  urls?: string[];
  text?: string;
  taskId?: string;
}

export interface BuiltModelProtocolRequest {
  url: string;
  init: RequestInit;
  protocol: ModelExecutionProtocol;
}

const OPENAI_CHAT_PROTOCOL: ModelExecutionProtocol = {
  version: 1,
  mode: 'sync',
  streamFormat: 'openai-sse',
  submit: {
    method: 'POST',
    path: '/chat/completions',
    body: {
      model: '{{model}}',
      messages: '{{messages}}',
      stream: '{{stream}}',
      tools: '{{tools}}',
      tool_choice: '{{toolChoice}}',
    },
  },
  resultTextPath: 'choices.0.message.content',
  errorPath: 'error.message',
};

const OPENAI_IMAGE_PROTOCOL: ModelExecutionProtocol = {
  version: 1,
  mode: 'sync',
  submit: {
    method: 'POST',
    path: '/images/generations',
    body: {
      model: '{{model}}',
      prompt: '{{prompt}}',
      size: '{{size}}',
      extra_body: { response_format: 'url' },
    },
  },
  resultUrlPath: 'data.*.url',
  errorPath: 'error.message',
};

const AGNES_VIDEO_PROTOCOL: ModelExecutionProtocol = {
  version: 1,
  mode: 'async',
  submit: {
    method: 'POST',
    path: '/videos',
    body: {
      model: '{{model}}',
      prompt: '{{prompt}}',
      height: 768,
      width: 1152,
      num_frames: '{{frames8n1}}',
      frame_rate: '{{fps}}',
    },
  },
  taskIdPath: 'video_id',
  poll: {
    method: 'GET',
    path: '/agnesapi',
    pathMode: 'origin',
    query: { video_id: '{{submit.video_id}}' },
    statusPath: 'status',
    successValues: ['completed'],
    failureValues: ['failed', 'error'],
    resultUrlPath: 'url',
    errorPath: 'error',
    progressPath: 'progress',
    intervalMs: 10000,
  },
};

function cloneProtocol(protocol: ModelExecutionProtocol): ModelExecutionProtocol {
  return structuredClone(protocol);
}

export function getModelProtocolPreset(
  preset: Exclude<ModelProtocolPresetId, 'custom'>,
): ModelExecutionProtocol {
  if (preset === 'openai-chat') return cloneProtocol(OPENAI_CHAT_PROTOCOL);
  if (preset === 'agnes-video') return cloneProtocol(AGNES_VIDEO_PROTOCOL);
  return cloneProtocol(OPENAI_IMAGE_PROTOCOL);
}

/** 将帧数收敛到 Agnes 等模型要求的 8 * n + 1，尽量贴近用户原始选择。 */
export function normalizeFrames8n1(value: number): number {
  const finiteValue = Number.isFinite(value) ? value : 121;
  const multiplier = Math.max(1, Math.round((Math.max(9, finiteValue) - 1) / 8));
  return multiplier * 8 + 1;
}

export function resolveModelExecutionProfile(
  profile: ModelExecutionProfile | undefined,
): ModelExecutionProtocol | null {
  if (!profile) return null;
  if (profile.preset === 'custom') {
    if (!profile.protocol) throw new Error('自定义调用协议不能为空');
    return parseModelExecutionProtocol(profile.protocol);
  }
  return getModelProtocolPreset(profile.preset);
}

export function getDefaultCustomProtocol(category: GeneralModelCategory): ModelExecutionProtocol {
  if (category === 'text') return getModelProtocolPreset('openai-chat');
  if (category === 'image') return getModelProtocolPreset('openai-image');
  return {
    version: 1,
    mode: 'async',
    submit: {
      method: 'POST',
      path: category === 'video' ? '/videos/generations' : '/audio/generations',
      body: { model: '{{model}}', prompt: '{{prompt}}' },
    },
    taskIdPath: 'task_id',
    poll: {
      method: 'GET',
      path: '/tasks/{{submit.task_id}}',
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed', 'error'],
      resultUrlPath: 'url',
      errorPath: 'error.message',
      intervalMs: 3000,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateRelativePath(path: unknown, label: string, errors: string[]): void {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    errors.push(`${label}必须是以 / 开头的同源相对路径`);
  }
}

function validatePathExpression(path: unknown, label: string, errors: string[]): void {
  if (typeof path !== 'string' || !path.trim()) {
    errors.push(`${label}不能为空`);
    return;
  }
  if (path.split('.').some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) {
    errors.push(`${label}包含不允许的路径片段`);
  }
}

function validateHeaderName(name: string, label: string, errors: string[]): void {
  if (!HEADER_NAME_RE.test(name)) {
    errors.push(`${label}“${name}”不是有效的 Header 名称`);
    return;
  }
  if (BLOCKED_HEADER_NAMES.has(name.toLowerCase())) {
    errors.push(`${label}不允许设置 ${name}`);
  }
}

function validateAuthentication(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push('鉴权配置无效');
    return;
  }
  if (!['bearer', 'header', 'query', 'none'].includes(String(value.type))) {
    errors.push('鉴权类型只支持 bearer、header、query 或 none');
    return;
  }
  if (value.prefix !== undefined && typeof value.prefix !== 'string') {
    errors.push('鉴权前缀必须是字符串');
  }
  if (value.type === 'header' || value.type === 'query') {
    if (typeof value.name !== 'string' || !value.name.trim()) {
      errors.push(`${value.type === 'header' ? 'Header' : 'Query'} 鉴权字段名不能为空`);
      return;
    }
    if (value.type === 'header') {
      validateHeaderName(value.name, '鉴权 ', errors);
    } else if (!HEADER_NAME_RE.test(value.name) || BLOCKED_PATH_SEGMENTS.has(value.name)) {
      errors.push(`Query 鉴权字段名“${value.name}”无效`);
    }
  }
}

function validateRequestHeaders(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`${label} headers 必须是 JSON 对象`);
    return;
  }
  for (const [name, headerValue] of Object.entries(value)) {
    validateHeaderName(name, `${label} `, errors);
    if (typeof headerValue !== 'string') {
      errors.push(`${label} Header ${name} 的值必须是字符串`);
    }
  }
}

function visitTemplateStrings(value: unknown, visit: (value: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => visitTemplateStrings(item, visit));
    return;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((item) => visitTemplateStrings(item, visit));
  }
}

function validateTemplateVariables(
  request: Record<string, unknown>,
  allowSubmit: boolean,
  label: string,
  errors: string[],
): void {
  visitTemplateStrings(request, (template) => {
    for (const match of template.matchAll(TEMPLATE_RE)) {
      const variable = match[1];
      const root = variable.split('.')[0];
      if (!ALLOWED_VARIABLE_ROOTS.has(root) && !(allowSubmit && root === 'submit')) {
        errors.push(`${label}使用了不允许的变量 ${variable}`);
      }
    }
  });
}

function validateRequest(
  request: unknown,
  label: string,
  allowSubmit: boolean,
  errors: string[],
): request is ModelProtocolRequestTemplate {
  if (!isRecord(request)) {
    errors.push(`${label}配置无效`);
    return false;
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    errors.push(`${label} method 只支持 GET 或 POST`);
  }
  validateRelativePath(request.path, `${label} path`, errors);
  if (request.pathMode !== undefined && request.pathMode !== 'append' && request.pathMode !== 'origin') {
    errors.push(`${label} pathMode 只支持 append 或 origin`);
  }
  validateRequestHeaders(request.headers, label, errors);
  validateTemplateVariables(request, allowSubmit, label, errors);
  return true;
}

export function validateModelExecutionProtocol(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['调用协议必须是 JSON 对象'];
  if (value.version !== 1) errors.push('调用协议 version 必须为 1');
  if (value.mode !== 'sync' && value.mode !== 'async') {
    errors.push('调用协议 mode 只支持 sync 或 async');
  }
  validateAuthentication(value.auth, errors);
  if (value.streamFormat !== undefined && value.streamFormat !== 'openai-sse') {
    errors.push('流式响应格式只支持 openai-sse');
  }
  if (value.errorPath !== undefined) {
    validatePathExpression(value.errorPath, '提交错误路径', errors);
  }
  validateRequest(value.submit, '提交请求', false, errors);

  if (value.mode === 'sync') {
    if (value.resultUrlPath === undefined && value.resultTextPath === undefined) {
      errors.push('同步协议必须配置结果 URL 路径或结果文本路径');
    }
    if (value.resultUrlPath !== undefined) {
      validatePathExpression(value.resultUrlPath, '同步结果 URL 路径', errors);
    }
    if (value.resultTextPath !== undefined) {
      validatePathExpression(value.resultTextPath, '同步结果文本路径', errors);
    }
  } else {
    validatePathExpression(value.taskIdPath, '任务 ID 路径', errors);
    if (validateRequest(value.poll, '轮询请求', true, errors) && isRecord(value.poll)) {
      validatePathExpression(value.poll.statusPath, '轮询状态路径', errors);
      if (value.poll.resultUrlPath === undefined && value.poll.resultTextPath === undefined) {
        errors.push('轮询协议必须配置结果 URL 路径或结果文本路径');
      }
      if (value.poll.resultUrlPath !== undefined) {
        validatePathExpression(value.poll.resultUrlPath, '轮询结果 URL 路径', errors);
      }
      if (value.poll.resultTextPath !== undefined) {
        validatePathExpression(value.poll.resultTextPath, '轮询结果文本路径', errors);
      }
      if (!Array.isArray(value.poll.successValues) || value.poll.successValues.length === 0) {
        errors.push('轮询成功状态不能为空');
      }
      if (!Array.isArray(value.poll.failureValues)) errors.push('轮询失败状态必须是数组');
      if (value.poll.errorPath !== undefined) {
        validatePathExpression(value.poll.errorPath, '轮询错误路径', errors);
      }
      if (value.poll.progressPath !== undefined) {
        validatePathExpression(value.poll.progressPath, '轮询进度路径', errors);
      }
      if (
        value.poll.intervalMs !== undefined
        && (typeof value.poll.intervalMs !== 'number'
          || value.poll.intervalMs < 1000
          || value.poll.intervalMs > 60000)
      ) {
        errors.push('轮询间隔必须在 1000 到 60000 毫秒之间');
      }
    }
  }
  return [...new Set(errors)];
}

export function parseModelExecutionProtocol(value: unknown): ModelExecutionProtocol {
  const errors = validateModelExecutionProtocol(value);
  if (errors.length > 0) throw new Error(errors[0]);
  return cloneProtocol(value as ModelExecutionProtocol);
}

function readPathValues(value: unknown, path: string): unknown[] {
  let current = [value];
  for (const segment of path.split('.')) {
    if (!segment || BLOCKED_PATH_SEGMENTS.has(segment)) return [];
    const next: unknown[] = [];
    for (const item of current) {
      if (segment === '*' && Array.isArray(item)) {
        next.push(...item);
      } else if (Array.isArray(item) && /^\d+$/.test(segment)) {
        const indexed = item[Number(segment)];
        if (indexed !== undefined) next.push(indexed);
      } else if (isRecord(item) && Object.hasOwn(item, segment)) {
        next.push(item[segment]);
      }
    }
    current = next;
  }
  return current;
}

function readFirstScalar(value: unknown, path: string): string | number | boolean | null | undefined {
  const match = readPathValues(value, path).find((item) =>
    item === null || ['string', 'number', 'boolean'].includes(typeof item),
  );
  return match as string | number | boolean | null | undefined;
}

function readUrls(value: unknown, path: string): string[] {
  return readPathValues(value, path)
    .flatMap((item) => Array.isArray(item) ? item : [item])
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function resolveContextPath(context: Record<string, unknown>, path: string): unknown {
  return readPathValues(context, path)[0];
}

function renderTemplateString(
  template: string,
  context: Record<string, unknown>,
): ProtocolJsonValue | typeof OMIT_TEMPLATE_VALUE {
  const fullMatch = FULL_TEMPLATE_RE.exec(template);
  if (fullMatch) {
    const resolved = resolveContextPath(context, fullMatch[1]);
    if (resolved === undefined) return OMIT_TEMPLATE_VALUE;
    return resolved as ProtocolJsonValue;
  }
  return template.replace(TEMPLATE_RE, (_match, path: string) => {
    const resolved = resolveContextPath(context, path);
    if (resolved === undefined) throw new Error(`调用协议变量 ${path} 没有可用值`);
    if (typeof resolved === 'object') throw new Error(`调用协议变量 ${path} 不能嵌入字符串`);
    return String(resolved);
  });
}

function renderTemplate(
  value: ProtocolJsonValue,
  context: Record<string, unknown>,
): ProtocolJsonValue | typeof OMIT_TEMPLATE_VALUE {
  if (typeof value === 'string') return renderTemplateString(value, context);
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const rendered = renderTemplate(item, context);
      return rendered === OMIT_TEMPLATE_VALUE ? [] : [rendered];
    });
  }
  if (value && typeof value === 'object') {
    const entries: Array<[string, ProtocolJsonValue]> = [];
    for (const [key, item] of Object.entries(value)) {
      const rendered = renderTemplate(item, context);
      if (rendered !== OMIT_TEMPLATE_VALUE) entries.push([key, rendered]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

function buildSameOriginUrl(
  baseUrl: string,
  request: ModelProtocolRequestTemplate,
  context: Record<string, unknown>,
): string {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, '');
  const parsedBase = new URL(normalizedBase);
  const renderedPath = renderTemplateString(request.path, context);
  if (typeof renderedPath !== 'string') throw new Error('调用协议请求路径变量没有可用值');
  const errors: string[] = [];
  validateRelativePath(renderedPath, '请求 path', errors);
  if (errors.length > 0) throw new Error(errors[0]);

  const url = request.pathMode === 'origin'
    ? new URL(renderedPath, parsedBase.origin)
    : new URL(`${normalizedBase}${renderedPath}`);
  if (url.origin !== parsedBase.origin) throw new Error('调用协议不能请求连接地址以外的站点');

  for (const [key, rawValue] of Object.entries(request.query ?? {})) {
    const rendered = renderTemplate(rawValue, context);
    if (rendered === OMIT_TEMPLATE_VALUE || rendered === null) continue;
    if (typeof rendered === 'object') throw new Error(`查询参数 ${key} 必须是标量`);
    url.searchParams.set(key, String(rendered));
  }
  return url.toString();
}

function resolveAuthentication(auth: ModelProtocolAuthConfig | undefined): ModelProtocolAuthConfig {
  return auth ?? { type: 'bearer' };
}

function applyQueryAuthentication(
  rawUrl: string,
  auth: ModelProtocolAuthConfig | undefined,
  apiKey: string,
): string {
  const resolvedAuth = resolveAuthentication(auth);
  if (resolvedAuth.type !== 'query' || !apiKey) return rawUrl;
  const url = new URL(rawUrl);
  url.searchParams.set(resolvedAuth.name!, `${resolvedAuth.prefix ?? ''}${apiKey}`);
  return url.toString();
}

function renderRequestHeaders(
  request: ModelProtocolRequestTemplate,
  auth: ModelProtocolAuthConfig | undefined,
  apiKey: string,
  context: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(request.headers ?? {})) {
    const rendered = renderTemplateString(template, context);
    if (rendered === OMIT_TEMPLATE_VALUE || rendered === null) continue;
    if (typeof rendered === 'object') throw new Error(`请求头 ${name} 必须是标量`);
    headers[name] = String(rendered);
  }
  if (request.body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  const resolvedAuth = resolveAuthentication(auth);
  if (!apiKey) return headers;
  if (resolvedAuth.type === 'bearer') {
    headers.Authorization = `${resolvedAuth.prefix ?? 'Bearer '}${apiKey}`;
  } else if (resolvedAuth.type === 'header') {
    headers[resolvedAuth.name!] = `${resolvedAuth.prefix ?? ''}${apiKey}`;
  }
  return headers;
}

function buildRequestInit(
  request: ModelProtocolRequestTemplate,
  auth: ModelProtocolAuthConfig | undefined,
  apiKey: string,
  context: Record<string, unknown>,
  signal?: AbortSignal,
): RequestInit {
  const headers = renderRequestHeaders(request, auth, apiKey, context);
  const renderedBody = request.body === undefined ? undefined : renderTemplate(request.body, context);
  const body = renderedBody === OMIT_TEMPLATE_VALUE ? undefined : renderedBody;
  return {
    method: request.method,
    headers,
    body: request.method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
    signal,
  };
}

export function buildModelProtocolRequest(
  options: BuildModelProtocolRequestOptions,
): BuiltModelProtocolRequest {
  const protocol = parseModelExecutionProtocol(options.protocol);
  const context: Record<string, unknown> = { ...options.variables };
  const url = buildSameOriginUrl(options.baseUrl, protocol.submit, context);
  return {
    url: applyQueryAuthentication(url, protocol.auth, options.apiKey),
    init: buildRequestInit(protocol.submit, protocol.auth, options.apiKey, context, options.signal),
    protocol,
  };
}

class ModelProtocolHttpError extends Error {
  readonly status: number;

  constructor(
    status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ModelProtocolHttpError';
    this.status = status;
  }
}

async function readJsonResponse(
  response: Response,
  label: string,
  errorPath?: string,
): Promise<ProtocolJsonValue> {
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const configuredMessage = errorPath && isRecord(payload)
      ? readFirstScalar(payload, errorPath)
      : undefined;
    const message = configuredMessage !== undefined && configuredMessage !== null
      ? String(configuredMessage)
      : isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
        ? payload.error.message
      : isRecord(payload) && typeof payload.message === 'string'
        ? payload.message
        : `${label} (${response.status})`;
    if (response.status === 429 && /no deployments available/i.test(message)) {
      throw new Error('所选模型暂无可用部署，请稍后手动重试（429）');
    }
    throw new ModelProtocolHttpError(response.status, `${label} (${response.status}): ${message}`);
  }
  if (!isRecord(payload) && !Array.isArray(payload)) {
    throw new Error(`${label}：响应必须是 JSON 对象或数组`);
  }
  return payload as ProtocolJsonValue;
}

function resolvePoll(
  baseUrl: string,
  poll: ModelProtocolPollTemplate,
  auth: ModelProtocolAuthConfig | undefined,
  context: Record<string, unknown>,
): ResolvedModelProtocolPoll {
  const init = buildRequestInit(poll, { type: 'none' }, '', context);
  return {
    method: poll.method,
    url: buildSameOriginUrl(baseUrl, poll, context),
    auth: structuredClone(resolveAuthentication(auth)),
    headers: { ...(init.headers as Record<string, string>) },
    body: typeof init.body === 'string' ? JSON.parse(init.body) as ProtocolJsonValue : undefined,
    statusPath: poll.statusPath,
    successValues: [...poll.successValues],
    failureValues: [...poll.failureValues],
    resultUrlPath: poll.resultUrlPath,
    resultTextPath: poll.resultTextPath,
    errorPath: poll.errorPath,
    progressPath: poll.progressPath,
    intervalMs: poll.intervalMs ?? 3000,
  };
}

export async function submitModelProtocol(
  options: SubmitModelProtocolOptions,
): Promise<SubmittedModelProtocol> {
  const built = buildModelProtocolRequest(options);
  const protocol = built.protocol;
  const context: Record<string, unknown> = { ...options.variables };
  const response = await corsSafeFetch(built.url, built.init);
  const payload = await readJsonResponse(response, '模型请求失败', protocol.errorPath);

  if (protocol.mode === 'sync') {
    const urls = protocol.resultUrlPath ? readUrls(payload, protocol.resultUrlPath) : [];
    const textValue = protocol.resultTextPath
      ? readFirstScalar(payload, protocol.resultTextPath)
      : undefined;
    const text = textValue === undefined || textValue === null ? undefined : String(textValue);
    if (urls.length === 0 && !text) throw new Error('模型响应中未找到配置的结果');
    return {
      ...(urls.length > 0 ? { urls } : {}),
      ...(text ? { text } : {}),
    };
  }

  const taskIdValue = readFirstScalar(payload, protocol.taskIdPath!);
  if (taskIdValue === undefined || taskIdValue === null || taskIdValue === '') {
    throw new Error(`模型提交响应中未找到任务 ID：${protocol.taskIdPath}`);
  }
  const pollContext = { ...context, submit: payload };
  return {
    taskId: String(taskIdValue),
    poll: resolvePoll(options.baseUrl, protocol.poll!, protocol.auth, pollContext),
  };
}

function normalizeStatus(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : String(value ?? '').toLowerCase();
}

function buildResolvedRequestInit(
  poll: ResolvedModelProtocolPoll,
  apiKey: string,
): RequestInit {
  const errors: string[] = [];
  validateAuthentication(poll.auth, errors);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(poll.headers ?? {})) {
    validateHeaderName(name, '轮询请求 ', errors);
    headers[name] = value;
  }
  if (errors.length > 0) throw new Error(errors[0]);

  const auth = resolveAuthentication(poll.auth);
  if (apiKey && auth.type === 'bearer') {
    headers.Authorization = `${auth.prefix ?? 'Bearer '}${apiKey}`;
  } else if (apiKey && auth.type === 'header') {
    headers[auth.name!] = `${auth.prefix ?? ''}${apiKey}`;
  }
  return {
    method: poll.method,
    headers,
    body: poll.method === 'GET' || poll.body === undefined ? undefined : JSON.stringify(poll.body),
  };
}

export async function pollResolvedModelProtocol(
  poll: ResolvedModelProtocolPoll,
  apiKey: string,
  signal?: AbortSignal,
  allowedBaseUrl?: string,
): Promise<ExecuteModelProtocolResult> {
  if (allowedBaseUrl) {
    const pollUrl = new URL(poll.url);
    const baseUrl = new URL(allowedBaseUrl);
    if (pollUrl.origin !== baseUrl.origin) {
      throw new Error('轮询地址与厂商连接地址不同源');
    }
  }
  const successValues = new Set(poll.successValues.map(normalizeStatus));
  const failureValues = new Set(poll.failureValues.map(normalizeStatus));
  let consecutiveRateLimits = 0;
  return pollTask<ProtocolJsonValue, ExecuteModelProtocolResult>({
    fetchState: async () => {
      try {
        const response = await corsSafeFetch(
          applyQueryAuthentication(poll.url, poll.auth, apiKey),
          buildResolvedRequestInit(poll, apiKey),
        );
        const payload = await readJsonResponse(response, '模型任务查询失败', poll.errorPath);
        consecutiveRateLimits = 0;
        return payload;
      } catch (error) {
        if (
          error instanceof ModelProtocolHttpError
          && error.status === 429
          && consecutiveRateLimits < 3
        ) {
          consecutiveRateLimits += 1;
          return {};
        }
        throw error;
      }
    },
    isComplete: (payload) => {
      const status = normalizeStatus(readFirstScalar(payload, poll.statusPath));
      if (!successValues.has(status)) return null;
      const urls = poll.resultUrlPath ? readUrls(payload, poll.resultUrlPath) : [];
      const textValue = poll.resultTextPath
        ? readFirstScalar(payload, poll.resultTextPath)
        : undefined;
      const text = textValue === undefined || textValue === null ? undefined : String(textValue);
      if (urls.length === 0 && !text) throw new Error('模型任务完成但未返回配置的结果');
      return {
        ...(urls.length > 0 ? { urls } : {}),
        ...(text ? { text } : {}),
      };
    },
    isFailed: (payload) => {
      const status = normalizeStatus(readFirstScalar(payload, poll.statusPath));
      if (!failureValues.has(status)) return null;
      const detail = poll.errorPath ? readFirstScalar(payload, poll.errorPath) : undefined;
      return `模型任务失败：${detail || status}`;
    },
    interval: poll.intervalMs,
    signal,
  });
}

export async function executeModelProtocol(
  options: ExecuteModelProtocolOptions,
): Promise<ExecuteModelProtocolResult> {
  const submitted = await submitModelProtocol(options);
  if (submitted.urls) return { urls: submitted.urls };
  if (submitted.text) return { text: submitted.text };
  if (!submitted.poll) throw new Error('异步调用协议未生成轮询配置');
  return {
    ...await pollResolvedModelProtocol(
      submitted.poll,
      options.apiKey,
      options.signal,
      options.baseUrl,
    ),
    taskId: submitted.taskId,
  };
}

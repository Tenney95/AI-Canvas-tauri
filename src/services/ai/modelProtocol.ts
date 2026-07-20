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
  ModelProtocolBodyEncoding,
  ModelProtocolPollTemplate,
  ModelProtocolPollRetryConfig,
  ModelProtocolPresetId,
  ModelProtocolRequestTemplate,
  NormalizedModelExecutionProtocol,
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
const DEFAULT_RETRY_HTTP_STATUSES = [408, 429, 500, 502, 503, 504];
const DEFAULT_MAX_QUERY_RETRIES = 3;
const DEFAULT_MAX_RETRY_DELAY_MS = 60000;
const MIME_TYPE_RE = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/;

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
  protocol: NormalizedModelExecutionProtocol;
  renderedBody?: ProtocolJsonValue;
}

export interface ModelProtocolRequestPreview {
  method: string;
  relativeUrl: string;
  headers: Record<string, string>;
  body?: ProtocolJsonValue;
}

export interface ModelProtocolResponsePreviewEntry {
  id: string;
  label: string;
  path: string;
  matchCount: number;
  values: string[];
}

const OPENAI_CHAT_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
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
  response: {
    type: 'json',
    result: { textPath: 'choices.0.message.content' },
    errorPath: 'error.message',
  },
};

const OPENAI_IMAGE_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
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
  response: {
    type: 'json',
    result: { urlPath: 'data.*.url' },
    errorPath: 'error.message',
  },
};

const AGNES_VIDEO_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
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
  response: {
    type: 'json',
    taskIdPath: 'video_id',
  },
  poll: {
    method: 'GET',
    path: '/agnesapi',
    pathMode: 'origin',
    query: { video_id: '{{submit.video_id}}' },
    response: {
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed', 'error'],
      result: { urlPath: 'url', mimeType: 'video/mp4' },
      errorPath: 'error',
      progressPath: 'progress',
    },
    intervalMs: 10000,
  },
};

function cloneProtocol(protocol: NormalizedModelExecutionProtocol): NormalizedModelExecutionProtocol {
  return structuredClone(protocol);
}

export function getModelProtocolPreset(
  preset: Exclude<ModelProtocolPresetId, 'custom'>,
): NormalizedModelExecutionProtocol {
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
): NormalizedModelExecutionProtocol | null {
  if (!profile) return null;
  if (profile.preset === 'custom') {
    if (!profile.protocol) throw new Error('自定义调用协议不能为空');
    return parseModelExecutionProtocol(profile.protocol);
  }
  return getModelProtocolPreset(profile.preset);
}

export function getDefaultCustomProtocol(category: GeneralModelCategory): NormalizedModelExecutionProtocol {
  if (category === 'text') return getModelProtocolPreset('openai-chat');
  if (category === 'image') return getModelProtocolPreset('openai-image');
  return {
    version: 2,
    mode: 'async',
    submit: {
      method: 'POST',
      path: category === 'video' ? '/videos/generations' : '/audio/generations',
      body: { model: '{{model}}', prompt: '{{prompt}}' },
    },
    response: {
      type: 'json',
      taskIdPath: 'task_id',
    },
    poll: {
      method: 'GET',
      path: '/tasks/{{submit.task_id}}',
      response: {
        statusPath: 'status',
        successValues: ['completed'],
        failureValues: ['failed', 'error'],
        result: { urlPath: 'url' },
        errorPath: 'error.message',
      },
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
  if (
    request.bodyEncoding !== undefined
    && !['json', 'form-urlencoded', 'multipart'].includes(String(request.bodyEncoding))
  ) {
    errors.push('请求体编码只支持 json、form-urlencoded 或 multipart');
  }
  if (
    (request.bodyEncoding === 'form-urlencoded' || request.bodyEncoding === 'multipart')
    && request.body !== undefined
    && !isRecord(request.body)
  ) {
    errors.push(`${label}使用 ${request.bodyEncoding} 时请求体必须是 JSON 对象`);
  }
  validateRequestHeaders(request.headers, label, errors);
  validateTemplateVariables(request, allowSubmit, label, errors);
  return true;
}

function validatePollRetryConfig(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push('轮询重试配置无效');
    return;
  }
  if (
    value.httpStatuses !== undefined
    && (!Array.isArray(value.httpStatuses)
      || value.httpStatuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599))
  ) {
    errors.push('重试 HTTP 状态码必须是 100 到 599 的整数');
  }
  if (
    value.maxRetries !== undefined
    && (!Number.isInteger(value.maxRetries) || Number(value.maxRetries) < 0 || Number(value.maxRetries) > 10)
  ) {
    errors.push('连续错误重试次数必须在 0 到 10 之间');
  }
  if (
    value.backoff !== undefined
    && !['fixed', 'linear', 'exponential'].includes(String(value.backoff))
  ) {
    errors.push('重试退避策略只支持 fixed、linear 或 exponential');
  }
  if (
    value.maxDelayMs !== undefined
    && (!Number.isInteger(value.maxDelayMs)
      || Number(value.maxDelayMs) < 1000
      || Number(value.maxDelayMs) > 300000)
  ) {
    errors.push('最大重试间隔必须在 1000 到 300000 毫秒之间');
  }
  if (value.honorRetryAfter !== undefined && typeof value.honorRetryAfter !== 'boolean') {
    errors.push('Retry-After 开关必须是布尔值');
  }
  if (value.retryNetworkErrors !== undefined && typeof value.retryNetworkErrors !== 'boolean') {
    errors.push('网络错误重试开关必须是布尔值');
  }
}

function withoutUndefined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function upgradeLegacyProtocolValue(value: Record<string, unknown>): Record<string, unknown> {
  const upgraded = structuredClone(value);
  upgraded.version = 2;
  upgraded.response = withoutUndefined({
    type: value.responseType ?? 'json',
    taskIdPath: value.mode === 'async' ? value.taskIdPath : undefined,
    result: value.mode === 'sync'
      ? withoutUndefined({
          urlPath: value.resultUrlPath,
          textPath: value.resultTextPath,
          base64Path: value.resultBase64Path,
          mimeType: value.resultMimeType,
        })
      : undefined,
    errorPath: value.errorPath,
  });
  delete upgraded.responseType;
  delete upgraded.resultUrlPath;
  delete upgraded.resultTextPath;
  delete upgraded.resultBase64Path;
  delete upgraded.resultMimeType;
  delete upgraded.errorPath;
  delete upgraded.taskIdPath;

  if (isRecord(value.poll)) {
    const poll = structuredClone(value.poll);
    poll.response = withoutUndefined({
      statusPath: value.poll.statusPath,
      successValues: value.poll.successValues,
      failureValues: value.poll.failureValues,
      result: withoutUndefined({
        urlPath: value.poll.resultUrlPath,
        textPath: value.poll.resultTextPath,
        base64Path: value.poll.resultBase64Path,
        mimeType: value.poll.resultMimeType,
      }),
      errorPath: value.poll.errorPath,
      progressPath: value.poll.progressPath,
    });
    delete poll.statusPath;
    delete poll.successValues;
    delete poll.failureValues;
    delete poll.resultUrlPath;
    delete poll.resultTextPath;
    delete poll.resultBase64Path;
    delete poll.resultMimeType;
    delete poll.errorPath;
    delete poll.progressPath;
    upgraded.poll = poll;
  }
  return upgraded;
}

function validateResultConfig(
  value: unknown,
  label: string,
  requirePath: boolean,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${label}配置无效`);
    return;
  }
  if (requirePath && value.urlPath === undefined && value.textPath === undefined && value.base64Path === undefined) {
    errors.push(`${label}必须配置 URL、文本或 Base64 结果路径`);
  }
  if (value.urlPath !== undefined) validatePathExpression(value.urlPath, `${label} URL 路径`, errors);
  if (value.textPath !== undefined) validatePathExpression(value.textPath, `${label}文本路径`, errors);
  if (value.base64Path !== undefined) {
    validatePathExpression(value.base64Path, `${label} Base64 路径`, errors);
    if (typeof value.mimeType !== 'string' || !MIME_TYPE_RE.test(value.mimeType)) {
      errors.push(label.startsWith('轮询')
        ? '轮询 Base64 结果必须配置 MIME 类型'
        : 'Base64 结果必须配置 MIME 类型');
    }
  }
  if (
    value.mimeType !== undefined
    && (typeof value.mimeType !== 'string' || !MIME_TYPE_RE.test(value.mimeType))
  ) {
    errors.push(label.startsWith('轮询') ? '轮询结果 MIME 类型无效' : '结果 MIME 类型无效');
  }
}

export function validateModelExecutionProtocol(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['调用协议必须是 JSON 对象'];
  if (value.version !== 1 && value.version !== 2) {
    errors.push('调用协议 version 只支持 1 或 2');
    return errors;
  }
  if (
    value.version === 2
    && ['responseType', 'resultUrlPath', 'resultTextPath', 'resultBase64Path', 'resultMimeType', 'errorPath', 'taskIdPath']
      .some((key) => Object.hasOwn(value, key))
  ) {
    errors.push('version 2 响应字段必须配置在 response 中');
  }
  if (
    value.version === 2
    && isRecord(value.poll)
    && ['statusPath', 'successValues', 'failureValues', 'resultUrlPath', 'resultTextPath', 'resultBase64Path', 'resultMimeType', 'errorPath', 'progressPath']
      .some((key) => Object.hasOwn(value.poll as object, key))
  ) {
    errors.push('version 2 轮询响应字段必须配置在 poll.response 中');
  }
  const protocol = value.version === 1 ? upgradeLegacyProtocolValue(value) : value;
  if (protocol.mode !== 'sync' && protocol.mode !== 'async') {
    errors.push('调用协议 mode 只支持 sync 或 async');
  }
  validateAuthentication(protocol.auth, errors);
  if (protocol.streamFormat !== undefined && protocol.streamFormat !== 'openai-sse') {
    errors.push('流式响应格式只支持 openai-sse');
  }
  validateRequest(protocol.submit, '提交请求', false, errors);
  if (!isRecord(protocol.response)) {
    errors.push('响应配置无效');
    return [...new Set(errors)];
  }
  const response = protocol.response;
  if (!['json', 'text', 'binary'].includes(String(response.type))) {
    errors.push('响应类型只支持 json、text 或 binary');
  }
  if (response.errorPath !== undefined) {
    validatePathExpression(response.errorPath, '提交错误路径', errors);
  }

  if (protocol.mode === 'sync') {
    if (response.type === 'json' || response.result !== undefined) {
      validateResultConfig(response.result, '同步 JSON 协议', response.type === 'json', errors);
    }
  } else {
    if (response.type !== 'json') {
      errors.push('异步协议的提交与轮询响应必须使用 JSON');
    }
    validatePathExpression(response.taskIdPath, '任务 ID 路径', errors);
    if (validateRequest(protocol.poll, '轮询请求', true, errors) && isRecord(protocol.poll)) {
      if (protocol.poll.bodyEncoding === 'multipart') {
        errors.push('异步轮询请求不支持 multipart 请求体');
      }
      if (!isRecord(protocol.poll.response)) {
        errors.push('轮询响应配置无效');
        return [...new Set(errors)];
      }
      const pollResponse = protocol.poll.response;
      validatePathExpression(pollResponse.statusPath, '轮询状态路径', errors);
      validateResultConfig(pollResponse.result, '轮询协议', true, errors);
      if (!Array.isArray(pollResponse.successValues) || pollResponse.successValues.length === 0) {
        errors.push('轮询成功状态不能为空');
      }
      if (!Array.isArray(pollResponse.failureValues)) errors.push('轮询失败状态必须是数组');
      if (pollResponse.errorPath !== undefined) {
        validatePathExpression(pollResponse.errorPath, '轮询错误路径', errors);
      }
      if (pollResponse.progressPath !== undefined) {
        validatePathExpression(pollResponse.progressPath, '轮询进度路径', errors);
      }
      if (
        protocol.poll.intervalMs !== undefined
        && (typeof protocol.poll.intervalMs !== 'number'
          || protocol.poll.intervalMs < 1000
          || protocol.poll.intervalMs > 60000)
      ) {
        errors.push('轮询间隔必须在 1000 到 60000 毫秒之间');
      }
      if (
        protocol.poll.maxAttempts !== undefined
        && (!Number.isInteger(protocol.poll.maxAttempts)
          || Number(protocol.poll.maxAttempts) < 1
          || Number(protocol.poll.maxAttempts) > 10000)
      ) {
        errors.push('最大轮询次数必须在 1 到 10000 之间');
      }
      if (
        protocol.poll.maxDurationMs !== undefined
        && (!Number.isInteger(protocol.poll.maxDurationMs)
          || Number(protocol.poll.maxDurationMs) < 1000
          || Number(protocol.poll.maxDurationMs) > 86400000)
      ) {
        errors.push('最大轮询时长必须在 1000 到 86400000 毫秒之间');
      }
      validatePollRetryConfig(protocol.poll.retry, errors);
    }
  }
  return [...new Set(errors)];
}

export function parseModelExecutionProtocol(value: unknown): NormalizedModelExecutionProtocol {
  const errors = validateModelExecutionProtocol(value);
  if (errors.length > 0) throw new Error(errors[0]);
  const normalized = (value as { version: number }).version === 1
    ? upgradeLegacyProtocolValue(value as Record<string, unknown>)
    : structuredClone(value);
  return normalized as unknown as NormalizedModelExecutionProtocol;
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

function formatResponsePreviewValue(value: unknown, redactBase64: boolean): string {
  if (redactBase64 && typeof value === 'string') {
    const base64Value = value.includes(',') && /^data:/i.test(value)
      ? value.slice(value.indexOf(',') + 1)
      : value;
    return `[Base64 ${base64Value.replace(/\s/g, '').length} 字符]`;
  }
  const serialized = typeof value === 'string'
    ? value
    : value === undefined ? '' : JSON.stringify(value);
  return serialized.length > 240 ? `${serialized.slice(0, 240)}...` : serialized;
}

export function previewModelProtocolResponse(
  protocolValue: ModelExecutionProtocol,
  payload: ProtocolJsonValue,
): ModelProtocolResponsePreviewEntry[] {
  const protocol = parseModelExecutionProtocol(protocolValue);
  const entries: ModelProtocolResponsePreviewEntry[] = [];
  const addEntry = (
    id: string,
    label: string,
    path: string | undefined,
    redactBase64 = false,
  ) => {
    if (!path) return;
    const matches = readPathValues(payload, path)
      .flatMap((value) => Array.isArray(value) ? value : [value]);
    entries.push({
      id,
      label,
      path,
      matchCount: matches.length,
      values: matches.map((value) => formatResponsePreviewValue(value, redactBase64)),
    });
  };

  if (protocol.mode === 'sync') {
    if (protocol.response.type !== 'json') return [];
    addEntry('result-url', 'URL 结果', protocol.response.result?.urlPath);
    addEntry('result-text', '文本结果', protocol.response.result?.textPath);
    addEntry('result-base64', 'Base64 结果', protocol.response.result?.base64Path, true);
    addEntry('submit-error', '错误信息', protocol.response.errorPath);
    return entries;
  }

  addEntry('task-id', '任务 ID（提交响应）', protocol.response.taskIdPath);
  addEntry('submit-error', '提交错误', protocol.response.errorPath);
  addEntry('status', '任务状态（轮询响应）', protocol.poll?.response.statusPath);
  addEntry('poll-result-url', 'URL 结果', protocol.poll?.response.result.urlPath);
  addEntry('poll-result-text', '文本结果', protocol.poll?.response.result.textPath);
  addEntry('poll-result-base64', 'Base64 结果', protocol.poll?.response.result.base64Path, true);
  addEntry('poll-error', '任务错误', protocol.poll?.response.errorPath);
  addEntry('progress', '任务进度', protocol.poll?.response.progressPath);
  return entries;
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
  const resolvedAuth = resolveAuthentication(auth);
  if (!apiKey) return headers;
  if (resolvedAuth.type === 'bearer') {
    headers.Authorization = `${resolvedAuth.prefix ?? 'Bearer '}${apiKey}`;
  } else if (resolvedAuth.type === 'header') {
    headers[resolvedAuth.name!] = `${resolvedAuth.prefix ?? ''}${apiKey}`;
  }
  return headers;
}

function findHeaderName(headers: Record<string, string>, target: string): string | undefined {
  return Object.keys(headers).find((name) => name.toLowerCase() === target.toLowerCase());
}

function setContentType(headers: Record<string, string>, value: string, force = false): void {
  const existingName = findHeaderName(headers, 'content-type');
  if (existingName && !force) return;
  if (existingName) delete headers[existingName];
  headers['Content-Type'] = value;
}

function renderRequestBody(
  request: ModelProtocolRequestTemplate,
  context: Record<string, unknown>,
): ProtocolJsonValue | undefined {
  if (request.body === undefined) return undefined;
  const rendered = renderTemplate(request.body, context);
  return rendered === OMIT_TEMPLATE_VALUE ? undefined : rendered;
}

function appendUrlEncodedValue(params: URLSearchParams, name: string, value: ProtocolJsonValue): void {
  if (Array.isArray(value)) {
    value.forEach((item) => appendUrlEncodedValue(params, name, item));
    return;
  }
  if (value && typeof value === 'object') {
    params.append(name, JSON.stringify(value));
    return;
  }
  params.append(name, value === null ? '' : String(value));
}

interface ParsedDataUrl {
  mimeType: string;
  bytes: Uint8Array;
}

function parseBase64DataUrl(value: string): ParsedDataUrl {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(value);
  if (!match || !MIME_TYPE_RE.test(match[1])) {
    throw new Error('multipart 文件只支持 data URL');
  }
  try {
    const binary = atob(match[2].replace(/\s/g, ''));
    return {
      mimeType: match[1],
      bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    };
  } catch {
    throw new Error('multipart 文件 data URL 的 Base64 内容无效');
  }
}

function sanitizeMultipartToken(value: string, fallback: string): string {
  const sanitized = value.trim().replace(/[\r\n"]/g, '_');
  return sanitized || fallback;
}

function createMultipartBoundary(): string {
  const randomPart = globalThis.crypto?.randomUUID?.().replace(/-/g, '')
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `----ai-canvas-${randomPart}`;
}

function concatBytes(chunks: Uint8Array[]): ArrayBuffer {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const combined = new Uint8Array(length);
  let offset = 0;
  chunks.forEach((chunk) => {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return combined.buffer;
}

function serializeMultipartBody(body: Record<string, ProtocolJsonValue>, boundary: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const appendText = (value: string) => chunks.push(encoder.encode(value));
  const appendPart = (name: string, value: ProtocolJsonValue) => {
    const safeName = sanitizeMultipartToken(name, 'field');
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, '$file')) {
      const fileSource = value.$file;
      if (typeof fileSource !== 'string') throw new Error(`multipart 文件字段 ${name} 的 $file 必须是字符串`);
      const parsed = parseBase64DataUrl(fileSource);
      const configuredMime = value.contentType;
      if (configuredMime !== undefined && (typeof configuredMime !== 'string' || !MIME_TYPE_RE.test(configuredMime))) {
        throw new Error(`multipart 文件字段 ${name} 的 contentType 无效`);
      }
      const filename = sanitizeMultipartToken(
        typeof value.filename === 'string' ? value.filename : 'upload.bin',
        'upload.bin',
      );
      appendText(`--${boundary}\r\n`);
      appendText(`Content-Disposition: form-data; name="${safeName}"; filename="${filename}"\r\n`);
      appendText(`Content-Type: ${configuredMime ?? parsed.mimeType}\r\n\r\n`);
      chunks.push(parsed.bytes);
      appendText('\r\n');
      return;
    }
    const serialized = value && typeof value === 'object'
      ? JSON.stringify(value)
      : value === null ? '' : String(value);
    appendText(`--${boundary}\r\n`);
    appendText(`Content-Disposition: form-data; name="${safeName}"\r\n\r\n`);
    appendText(`${serialized}\r\n`);
  };

  for (const [name, value] of Object.entries(body)) {
    if (Array.isArray(value)) value.forEach((item) => appendPart(name, item));
    else appendPart(name, value);
  }
  appendText(`--${boundary}--\r\n`);
  return concatBytes(chunks);
}

function serializeRequestBody(
  body: ProtocolJsonValue,
  encoding: ModelProtocolBodyEncoding | undefined,
  headers: Record<string, string>,
): BodyInit {
  const resolvedEncoding = encoding ?? 'json';
  if (resolvedEncoding === 'json') {
    setContentType(headers, 'application/json');
    return JSON.stringify(body);
  }
  if (!isRecord(body)) {
    throw new Error(`${resolvedEncoding} 请求体必须是 JSON 对象`);
  }
  if (resolvedEncoding === 'form-urlencoded') {
    const params = new URLSearchParams();
    Object.entries(body).forEach(([name, value]) => appendUrlEncodedValue(params, name, value));
    setContentType(headers, 'application/x-www-form-urlencoded;charset=UTF-8');
    return params.toString();
  }
  const boundary = createMultipartBoundary();
  setContentType(headers, `multipart/form-data; boundary=${boundary}`, true);
  return serializeMultipartBody(body, boundary);
}

function redactMultipartPreview(value: ProtocolJsonValue): ProtocolJsonValue {
  if (Array.isArray(value)) return value.map(redactMultipartPreview);
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '$file') && typeof value.$file === 'string') {
      const parsed = parseBase64DataUrl(value.$file);
      return {
        ...value,
        $file: `[data URL ${parsed.mimeType}, ${parsed.bytes.byteLength} bytes]`,
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactMultipartPreview(item)]),
    );
  }
  return value;
}

function buildRequestInit(
  request: ModelProtocolRequestTemplate,
  auth: ModelProtocolAuthConfig | undefined,
  apiKey: string,
  context: Record<string, unknown>,
  signal?: AbortSignal,
): RequestInit {
  const headers = renderRequestHeaders(request, auth, apiKey, context);
  const body = renderRequestBody(request, context);
  return {
    method: request.method,
    headers,
    body: request.method === 'GET' || body === undefined
      ? undefined
      : serializeRequestBody(body, request.bodyEncoding, headers),
    signal,
  };
}

export function buildModelProtocolRequest(
  options: BuildModelProtocolRequestOptions,
): BuiltModelProtocolRequest {
  const protocol = parseModelExecutionProtocol(options.protocol);
  const context: Record<string, unknown> = { ...options.variables };
  const renderedBody = renderRequestBody(protocol.submit, context);
  const url = buildSameOriginUrl(options.baseUrl, protocol.submit, context);
  return {
    url: applyQueryAuthentication(url, protocol.auth, options.apiKey),
    init: buildRequestInit(protocol.submit, protocol.auth, options.apiKey, context, options.signal),
    protocol,
    ...(renderedBody === undefined ? {} : { renderedBody }),
  };
}

export function previewModelProtocolRequest(
  options: Omit<SubmitModelProtocolOptions, 'apiKey'>,
): ModelProtocolRequestPreview {
  const built = buildModelProtocolRequest({
    ...options,
    apiKey: '********',
  });
  const url = new URL(built.url);
  const headers = { ...(built.init.headers as Record<string, string> | undefined) };
  const body = built.renderedBody === undefined
    ? undefined
    : built.protocol.submit.bodyEncoding === 'multipart'
      ? redactMultipartPreview(built.renderedBody)
      : built.renderedBody;
  return {
    method: built.init.method || built.protocol.submit.method,
    relativeUrl: `${url.pathname}${url.search}${url.hash}`,
    headers,
    ...(body === undefined ? {} : { body }),
  };
}

class ModelProtocolHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    message: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ModelProtocolHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

async function readJsonResponse(
  response: Response,
  label: string,
  errorPath?: string,
): Promise<ProtocolJsonValue> {
  if (!response.ok) {
    const rawText = await response.text().catch(() => '');
    let payload: unknown;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }
    const configuredMessage = errorPath && (isRecord(payload) || Array.isArray(payload))
      ? readFirstScalar(payload, errorPath)
      : undefined;
    const message = configuredMessage !== undefined && configuredMessage !== null
      ? String(configuredMessage)
      : isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
        ? payload.error.message
      : isRecord(payload) && typeof payload.message === 'string'
        ? payload.message
        : rawText.trim() || `${label} (${response.status})`;
    if (response.status === 429 && /no deployments available/i.test(message)) {
      throw new Error('所选模型暂无可用部署，请稍后手动重试（429）');
    }
    throw new ModelProtocolHttpError(
      response.status,
      `${label} (${response.status}): ${message}`,
      parseRetryAfterMs(response.headers.get('Retry-After')),
    );
  }
  const payload = await response.json().catch(() => null) as unknown;
  if (!isRecord(payload) && !Array.isArray(payload)) {
    throw new Error(`${label}：响应必须是 JSON 对象或数组`);
  }
  return payload as ProtocolJsonValue;
}

async function ensureSuccessfulRawResponse(
  response: Response,
  label: string,
  errorPath?: string,
): Promise<Response> {
  if (response.ok) return response;
  await readJsonResponse(response, label, errorPath);
  return response;
}

function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function normalizeBase64Result(value: string, mimeType: string): string {
  if (/^data:[^;,]+;base64,/i.test(value)) return value;
  const normalized = value.replace(/\s/g, '');
  try {
    atob(normalized);
  } catch {
    throw new Error('模型响应中的 Base64 结果无效');
  }
  return `data:${mimeType};base64,${normalized}`;
}

function resolvePoll(
  baseUrl: string,
  poll: ModelProtocolPollTemplate,
  auth: ModelProtocolAuthConfig | undefined,
  context: Record<string, unknown>,
): ResolvedModelProtocolPoll {
  if (poll.bodyEncoding === 'multipart') {
    throw new Error('异步轮询请求不支持 multipart 请求体');
  }
  const headers = renderRequestHeaders(poll, { type: 'none' }, '', context);
  const body = renderRequestBody(poll, context);
  if (poll.method !== 'GET' && body !== undefined) {
    serializeRequestBody(body, poll.bodyEncoding, headers);
  }
  const response = poll.response;
  const result = response.result;
  return {
    method: poll.method,
    url: buildSameOriginUrl(baseUrl, poll, context),
    auth: structuredClone(resolveAuthentication(auth)),
    headers,
    bodyEncoding: poll.bodyEncoding,
    body,
    statusPath: response.statusPath,
    successValues: [...response.successValues],
    failureValues: [...response.failureValues],
    resultUrlPath: result.urlPath,
    resultTextPath: result.textPath,
    resultBase64Path: result.base64Path,
    resultMimeType: result.mimeType,
    errorPath: response.errorPath,
    progressPath: response.progressPath,
    intervalMs: poll.intervalMs ?? 3000,
    maxAttempts: poll.maxAttempts,
    maxDurationMs: poll.maxDurationMs,
    retry: poll.retry ? structuredClone(poll.retry) : undefined,
  };
}

export async function submitModelProtocol(
  options: SubmitModelProtocolOptions,
): Promise<SubmittedModelProtocol> {
  const built = buildModelProtocolRequest(options);
  const protocol = built.protocol;
  const context: Record<string, unknown> = { ...options.variables };
  const response = await corsSafeFetch(built.url, built.init);
  const responseConfig = protocol.response;

  if (protocol.mode === 'sync') {
    if (responseConfig.type === 'text') {
      await ensureSuccessfulRawResponse(response, '模型请求失败', responseConfig.errorPath);
      const text = await response.text();
      if (!text) throw new Error('模型响应中未找到文本结果');
      return { text };
    }
    if (responseConfig.type === 'binary') {
      await ensureSuccessfulRawResponse(response, '模型请求失败', responseConfig.errorPath);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error('模型响应中未找到二进制结果');
      const responseMimeType = response.headers.get('Content-Type')?.split(';')[0]?.trim();
      const mimeType = responseMimeType && MIME_TYPE_RE.test(responseMimeType)
        ? responseMimeType
        : responseConfig.result?.mimeType ?? 'application/octet-stream';
      return { urls: [`data:${mimeType};base64,${encodeBytesBase64(bytes)}`] };
    }
    const payload = await readJsonResponse(response, '模型请求失败', responseConfig.errorPath);
    const resultConfig = responseConfig.result!;
    const urls = resultConfig.urlPath ? readUrls(payload, resultConfig.urlPath) : [];
    const base64Urls = resultConfig.base64Path
      ? readUrls(payload, resultConfig.base64Path).map((value) =>
          normalizeBase64Result(value, resultConfig.mimeType!))
      : [];
    const textValue = resultConfig.textPath
      ? readFirstScalar(payload, resultConfig.textPath)
      : undefined;
    const text = textValue === undefined || textValue === null ? undefined : String(textValue);
    const mediaUrls = [...urls, ...base64Urls];
    if (mediaUrls.length === 0 && !text) throw new Error('模型响应中未找到配置的结果');
    return {
      ...(mediaUrls.length > 0 ? { urls: mediaUrls } : {}),
      ...(text ? { text } : {}),
    };
  }

  const payload = await readJsonResponse(response, '模型请求失败', responseConfig.errorPath);
  const taskIdValue = readFirstScalar(payload, responseConfig.taskIdPath!);
  if (taskIdValue === undefined || taskIdValue === null || taskIdValue === '') {
    throw new Error(`模型提交响应中未找到任务 ID：${responseConfig.taskIdPath}`);
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

export function getDefaultModelProtocolPollRetryConfig(): Required<ModelProtocolPollRetryConfig> {
  return {
    httpStatuses: [...DEFAULT_RETRY_HTTP_STATUSES],
    maxRetries: DEFAULT_MAX_QUERY_RETRIES,
    backoff: 'fixed',
    maxDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
    honorRetryAfter: true,
    retryNetworkErrors: true,
  };
}

function resolvePollRetryConfig(
  value: ModelProtocolPollRetryConfig | undefined,
): Required<ModelProtocolPollRetryConfig> {
  const defaults = getDefaultModelProtocolPollRetryConfig();
  return {
    ...defaults,
    ...value,
    httpStatuses: value?.httpStatuses ?? defaults.httpStatuses,
  };
}

function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (
    typeof DOMException !== 'undefined'
    && error instanceof DOMException
    && ['NetworkError', 'TimeoutError'].includes(error.name)
  ) {
    return true;
  }
  return error instanceof Error
    && /failed to fetch|network error|connection (?:closed|reset)|timed? out/i.test(error.message);
}

function calculateRetryDelayMs(
  intervalMs: number,
  retryCount: number,
  retry: Required<ModelProtocolPollRetryConfig>,
  retryAfterMs?: number,
): number {
  const multiplier = retry.backoff === 'exponential'
    ? 2 ** Math.max(0, retryCount - 1)
    : retry.backoff === 'linear'
      ? retryCount
      : 1;
  const backoffDelay = intervalMs * multiplier;
  const requestedDelay = retry.honorRetryAfter && retryAfterMs !== undefined
    ? Math.max(backoffDelay, retryAfterMs)
    : backoffDelay;
  return Math.max(intervalMs, Math.min(retry.maxDelayMs, requestedDelay));
}

async function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  if (signal?.aborted) throw new Error('任务已被取消');
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('任务已被取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
  const body = poll.method === 'GET' || poll.body === undefined
    ? undefined
    : serializeRequestBody(poll.body, poll.bodyEncoding, headers);
  return {
    method: poll.method,
    headers,
    body,
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
  const retry = resolvePollRetryConfig(poll.retry);
  const retryHttpStatuses = new Set(retry.httpStatuses);
  const pollStartedAt = Date.now();
  let consecutiveErrors = 0;
  let pendingExtraDelayMs = 0;
  return pollTask<ProtocolJsonValue, ExecuteModelProtocolResult>({
    fetchState: async () => {
      if (pendingExtraDelayMs > 0) {
        const maxDurationMs = poll.maxDurationMs ?? Infinity;
        if (Date.now() - pollStartedAt + pendingExtraDelayMs >= maxDurationMs) {
          throw new Error('模型任务轮询超时');
        }
        const delayMs = pendingExtraDelayMs;
        pendingExtraDelayMs = 0;
        await waitForRetryDelay(delayMs, signal);
      }
      try {
        const response = await corsSafeFetch(
          applyQueryAuthentication(poll.url, poll.auth, apiKey),
          buildResolvedRequestInit(poll, apiKey),
        );
        const payload = await readJsonResponse(response, '模型任务查询失败', poll.errorPath);
        consecutiveErrors = 0;
        return payload;
      } catch (error) {
        const retryAfterMs = error instanceof ModelProtocolHttpError ? error.retryAfterMs : undefined;
        const retryableHttpError = error instanceof ModelProtocolHttpError
          && retryHttpStatuses.has(error.status);
        const retryableNetworkError = retry.retryNetworkErrors
          && !(error instanceof ModelProtocolHttpError)
          && isTransientNetworkError(error);
        if ((retryableHttpError || retryableNetworkError) && consecutiveErrors < retry.maxRetries) {
          consecutiveErrors += 1;
          const retryDelayMs = calculateRetryDelayMs(
            poll.intervalMs,
            consecutiveErrors,
            retry,
            retryAfterMs,
          );
          pendingExtraDelayMs = Math.max(0, retryDelayMs - poll.intervalMs);
          return {};
        }
        throw error;
      }
    },
    isComplete: (payload) => {
      const status = normalizeStatus(readFirstScalar(payload, poll.statusPath));
      if (!successValues.has(status)) return null;
      const urls = poll.resultUrlPath ? readUrls(payload, poll.resultUrlPath) : [];
      const base64Urls = poll.resultBase64Path
        ? readUrls(payload, poll.resultBase64Path).map((value) =>
            normalizeBase64Result(value, poll.resultMimeType!))
        : [];
      const textValue = poll.resultTextPath
        ? readFirstScalar(payload, poll.resultTextPath)
        : undefined;
      const text = textValue === undefined || textValue === null ? undefined : String(textValue);
      const mediaUrls = [...urls, ...base64Urls];
      if (mediaUrls.length === 0 && !text) throw new Error('模型任务完成但未返回配置的结果');
      return {
        ...(mediaUrls.length > 0 ? { urls: mediaUrls } : {}),
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
    maxAttempts: poll.maxAttempts,
    maxDuration: poll.maxDurationMs,
    timeoutMsg: '模型任务轮询超时',
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

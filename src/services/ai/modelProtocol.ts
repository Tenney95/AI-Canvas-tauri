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
  ModelProtocolPollRetryConfig,
  ModelProtocolPresetId,
  ModelProtocolRequestTemplate,
  ModelProtocolResultConfig,
  NormalizedModelExecutionProtocol,
  ProtocolJsonValue,
  ResolvedModelProtocolPoll,
  VideoModelCapability,
} from '../../types/aiTypes';
import {
  redactModelProtocolMultipartPreview,
  serializeModelProtocolBody,
} from './modelProtocolBody';
import {
  previewNormalizedModelProtocolResponse,
  readModelProtocolFirstScalar,
  readModelProtocolPathValues,
  readModelProtocolUrls,
  type ModelProtocolResponsePreviewEntry,
} from './modelProtocolResponse';
import { PROTOCOL_VARIABLE_NAMES } from './modelProtocolVariables';

const TEMPLATE_RE = /{{\s*([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_-]+)*)\s*}}/g;
const FULL_TEMPLATE_RE = /^{{\s*([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_-]+)*)\s*}}$/;
const WHEN_PRESENT_KEY = '$whenPresent';
const FOR_EACH_KEY = '$forEach';
const CONDITIONAL_VALUE_KEY = '$value';
/**
 * Stage 1 only permits array expansion for the canonical typed reference URL lists.
 * Keeping this list narrow prevents arbitrary protocol values (messages, tools, submit
 * payloads, etc.) from becoming an implicit expression language.
 */
const FOR_EACH_VARIABLE_ROOTS = new Set([
  'referenceImageUrls',
  'referenceVideoUrls',
  'referenceAudioUrls',
]);
export const MODEL_PROTOCOL_MAX_FOR_EACH_ITEMS = 64;
const MAX_MODEL_PROTOCOL_BODY_BYTES = 512 * 1024 * 1024;
/** 变量白名单由 modelProtocolVariables 总表派生，避免与字段映射表各自漂移。 */
const ALLOWED_VARIABLE_ROOTS = PROTOCOL_VARIABLE_NAMES;
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
  signal?: AbortSignal;
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

export type { ModelProtocolResponsePreviewEntry } from './modelProtocolResponse';

/** 判断序列化协议中是否引用了指定的受信模板变量。 */
export function modelProtocolUsesVariable(source: string, ...variables: string[]): boolean {
  const requested = variables.filter(Boolean);
  if (requested.length === 0) return false;
  return [...source.matchAll(TEMPLATE_RE)].some((match) => {
    const templatePath = match[1];
    return requested.some((variable) => (
      templatePath === variable || templatePath.startsWith(`${variable}.`)
    ));
  });
}

/** 返回协议片段中出现的模板路径；调用方可据此区分整数组与 `.0` 等局部引用。 */
export function collectModelProtocolTemplatePaths(source: string): string[] {
  return [...source.matchAll(TEMPLATE_RE)].map((match) => match[1]);
}

/** 返回协议中实际使用 `$forEach` 展开的受信数组变量。 */
export function collectModelProtocolForEachVariables(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!isRecord(item)) return;
    const source = item[FOR_EACH_KEY];
    if (typeof source === 'string') {
      const path = FULL_TEMPLATE_RE.exec(source)?.[1];
      if (path && FOR_EACH_VARIABLE_ROOTS.has(path)) found.add(path);
    }
    Object.values(item).forEach(visit);
  };
  visit(value);
  return [...found];
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

/**
 * The legacy Agnes preset historically relied on the application's global
 * 5-second / 24-fps defaults. Keep that compatibility explicit at the preset
 * boundary so the canonical resolver never has to invent values for arbitrary
 * custom video protocols.
 */
const AGNES_VIDEO_CAPABILITY: VideoModelCapability = {
  operations: ['text-to-video'],
  defaultResolution: '1152x768',
  defaultRatio: '3:2',
  defaultFrameRate: 24,
  defaultDuration: 5,
  maxImageReferences: 0,
  maxVideoReferences: 0,
  maxAudioReferences: 0,
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

export function getModelProtocolPresetVideoCapability(
  profile: ModelExecutionProfile | undefined,
): VideoModelCapability | undefined {
  return profile?.preset === 'agnes-video'
    ? structuredClone(AGNES_VIDEO_CAPABILITY)
    : undefined;
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
  const requiresDocumentedVideoEndpoint = category === 'video';
  return {
    version: 2,
    mode: 'async',
    submit: {
      method: 'POST',
      // Video APIs have no cross-provider standard endpoint. An empty path is
      // deliberately invalid so the editor cannot save a guessed request.
      path: requiresDocumentedVideoEndpoint ? '' : '/audio/generations',
      body: { model: '{{model}}', prompt: '{{prompt}}' },
    },
    response: {
      type: 'json',
      taskIdPath: 'task_id',
    },
    poll: {
      method: 'GET',
      path: requiresDocumentedVideoEndpoint ? '' : '/tasks/{{submit.task_id}}',
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
      if (variable.split('.').some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) {
        errors.push(`${label}使用了不安全的变量路径 ${variable}`);
      }
    }
  });
}

function usesExactFullTemplate(value: unknown, path: string): boolean {
  let found = false;
  visitTemplateStrings(value, (template) => {
    if (FULL_TEMPLATE_RE.exec(template)?.[1] === path) found = true;
  });
  return found;
}

function validateConditionalTemplateDirectives(
  value: unknown,
  label: string,
  errors: string[],
  options: {
    enabled: boolean;
    arrayItem?: boolean;
    forEachEnabled?: boolean;
  },
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => validateConditionalTemplateDirectives(item, label, errors, {
      enabled: options.enabled,
      arrayItem: true,
      forEachEnabled: options.forEachEnabled,
    }));
    return;
  }
  if (!isRecord(value)) return;

  const hasCondition = Object.hasOwn(value, WHEN_PRESENT_KEY);
  const hasForEach = Object.hasOwn(value, FOR_EACH_KEY);
  const hasConditionalValue = Object.hasOwn(value, CONDITIONAL_VALUE_KEY);
  if (hasForEach) {
    if (!options.enabled || !options.arrayItem) {
      errors.push(`${label}数组展开项只能用于请求体数组元素`);
      return;
    }
    if (!options.forEachEnabled) {
      errors.push(`${label}数组展开项只支持 JSON 请求体`);
      return;
    }
    const keys = Object.keys(value);
    if (hasCondition || !hasConditionalValue || keys.length !== 2) {
      errors.push(`${label}数组展开项必须且只能包含 ${FOR_EACH_KEY} 和 ${CONDITIONAL_VALUE_KEY}`);
      return;
    }
    const source = value[FOR_EACH_KEY];
    const sourcePath = typeof source === 'string' ? FULL_TEMPLATE_RE.exec(source)?.[1] : undefined;
    if (!sourcePath || sourcePath.includes('.') || !FOR_EACH_VARIABLE_ROOTS.has(sourcePath)) {
      errors.push(
        `${label}${FOR_EACH_KEY} 必须是 referenceImageUrls、referenceVideoUrls 或 referenceAudioUrls 的完整根变量模板`,
      );
    }
    if (!isRecord(value[CONDITIONAL_VALUE_KEY])) {
      errors.push(`${label}${FOR_EACH_KEY} 的 ${CONDITIONAL_VALUE_KEY} 必须是 JSON 对象`);
    } else if (sourcePath && !usesExactFullTemplate(value[CONDITIONAL_VALUE_KEY], sourcePath)) {
      errors.push(`${label}${FOR_EACH_KEY} 的 ${CONDITIONAL_VALUE_KEY} 必须使用完整模板 {{${sourcePath}}} 接收当前 URL`);
    }
    validateConditionalTemplateDirectives(value[CONDITIONAL_VALUE_KEY], label, errors, {
      enabled: options.enabled,
      forEachEnabled: options.forEachEnabled,
    });
    return;
  }
  if (hasCondition || hasConditionalValue) {
    if (!options.enabled || !options.arrayItem) {
      errors.push(`${label}条件项只能用于请求体数组元素`);
      return;
    }
    const keys = Object.keys(value);
    if (!hasCondition || !hasConditionalValue || keys.length !== 2) {
      errors.push(`${label}条件项必须且只能包含 ${WHEN_PRESENT_KEY} 和 ${CONDITIONAL_VALUE_KEY}`);
      return;
    }
    if (typeof value[WHEN_PRESENT_KEY] !== 'string' || !FULL_TEMPLATE_RE.test(value[WHEN_PRESENT_KEY])) {
      errors.push(`${label}${WHEN_PRESENT_KEY} 必须是一个完整的受信变量模板`);
    }
    validateConditionalTemplateDirectives(value[CONDITIONAL_VALUE_KEY], label, errors, {
      enabled: options.enabled,
      forEachEnabled: options.forEachEnabled,
    });
    return;
  }

  Object.values(value).forEach((item) => validateConditionalTemplateDirectives(item, label, errors, {
    enabled: options.enabled,
    forEachEnabled: options.forEachEnabled,
  }));
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
    request.maxBodyBytes !== undefined
    && (!Number.isSafeInteger(request.maxBodyBytes)
      || Number(request.maxBodyBytes) <= 0
      || Number(request.maxBodyBytes) > MAX_MODEL_PROTOCOL_BODY_BYTES)
  ) {
    errors.push(
      `${label} maxBodyBytes 必须是 1 到 ${MAX_MODEL_PROTOCOL_BODY_BYTES} 的正整数`,
    );
  }
  if (request.maxBodyBytes !== undefined && request.bodyEncoding === 'multipart') {
    errors.push(`${label}使用 multipart 时不支持 maxBodyBytes，因为无法精确计算 multipart 边界开销`);
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
  validateConditionalTemplateDirectives(request.body, label, errors, {
    enabled: true,
    forEachEnabled: request.bodyEncoding === undefined || request.bodyEncoding === 'json',
  });
  validateConditionalTemplateDirectives(request.query, label, errors, { enabled: false });
  return true;
}

function pollRequestUsesTaskId(
  request: Record<string, unknown>,
  taskIdPath: unknown,
): boolean {
  if (typeof taskIdPath !== 'string' || !taskIdPath.trim()) return false;
  const expected = `submit.${taskIdPath.trim()}`;
  const source = JSON.stringify({
    path: request.path,
    query: request.query,
    body: request.body,
  });
  return [...source.matchAll(TEMPLATE_RE)].some((match) => match[1] === expected);
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
  if (value.fetchUrl !== undefined && typeof value.fetchUrl !== 'boolean') {
    errors.push(`${label}同源结果下载开关必须是布尔值`);
  }
  if (value.fetchUrl === true && value.urlPath === undefined) {
    errors.push(`${label}启用同源结果下载时必须配置 URL 路径`);
  }
  if (value.base64Transform !== undefined) {
    if (!isRecord(value.base64Transform) || value.base64Transform.type !== 'pcm-s16le-to-wav') {
      errors.push(`${label}Base64 转换只支持 pcm-s16le-to-wav`);
    } else {
      const sampleRate = value.base64Transform.sampleRate;
      const channels = value.base64Transform.channels ?? 1;
      if (!Number.isInteger(sampleRate) || Number(sampleRate) < 8000 || Number(sampleRate) > 384000) {
        errors.push(`${label}PCM 采样率必须是 8000 到 384000 的整数`);
      }
      if (!Number.isInteger(channels) || Number(channels) < 1 || Number(channels) > 8) {
        errors.push(`${label}PCM 声道数必须是 1 到 8 的整数`);
      }
      if (value.base64Path === undefined) {
        errors.push(`${label}配置 PCM 转换时必须提供 Base64 路径`);
      }
      if (value.mimeType !== 'audio/wav') {
        errors.push(`${label}PCM 转 WAV 的 MIME 类型必须是 audio/wav`);
      }
    }
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
      if (protocol.poll.maxBodyBytes !== undefined) {
        errors.push('轮询请求不支持 maxBodyBytes；该限制当前只支持提交请求');
      }
      if (!pollRequestUsesTaskId(protocol.poll, response.taskIdPath)) {
        errors.push(
          `异步轮询请求的 path、query 或 body 必须引用任务 ID 变量 {{submit.${String(response.taskIdPath ?? 'task_id')}}}，不能引用其他提交字段或写死任务 ID`,
        );
      }
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

export function previewModelProtocolResponse(
  protocolValue: ModelExecutionProtocol,
  payload: ProtocolJsonValue,
): ModelProtocolResponsePreviewEntry[] {
  return previewNormalizedModelProtocolResponse(
    parseModelExecutionProtocol(protocolValue),
    payload,
  );
}

function resolveContextPath(context: Record<string, unknown>, path: string): unknown {
  return readModelProtocolPathValues(context, path)[0];
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

function renderForEachDirective(
  directive: Record<string, ProtocolJsonValue>,
  context: Record<string, unknown>,
  options: { conditionalDirectives?: boolean },
): ProtocolJsonValue[] {
  if (!options.conditionalDirectives) {
    throw new Error('调用协议数组展开项只能用于请求体数组元素');
  }
  const sourceTemplate = directive[FOR_EACH_KEY];
  const sourcePath = typeof sourceTemplate === 'string'
    ? FULL_TEMPLATE_RE.exec(sourceTemplate)?.[1]
    : undefined;
  if (!sourcePath || sourcePath.includes('.') || !FOR_EACH_VARIABLE_ROOTS.has(sourcePath)) {
    throw new Error('调用协议数组展开变量无效');
  }
  const source = renderTemplateString(sourceTemplate as string, context);
  if (source === OMIT_TEMPLATE_VALUE || source === null) return [];
  if (!Array.isArray(source)) {
    throw new Error(`调用协议数组展开变量 ${sourcePath} 必须是字符串数组`);
  }
  if (source.length > MODEL_PROTOCOL_MAX_FOR_EACH_ITEMS) {
    throw new Error(
      `调用协议数组展开变量 ${sourcePath} 最多允许 ${MODEL_PROTOCOL_MAX_FOR_EACH_ITEMS} 项`,
    );
  }
  const template = directive[CONDITIONAL_VALUE_KEY];
  return source.flatMap((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`调用协议数组展开变量 ${sourcePath} 只能包含非空字符串`);
    }
    // Inside $value the source root denotes the current element. This keeps the
    // protocol language closed: no eval, expressions, dynamic aliases or keys.
    const rendered = renderTemplate(template, { ...context, [sourcePath]: item }, {
      conditionalDirectives: true,
    });
    if (rendered === OMIT_TEMPLATE_VALUE) return [];
    if (!rendered || typeof rendered !== 'object' || Array.isArray(rendered)) {
      throw new Error('调用协议数组展开项必须渲染为 JSON 对象');
    }
    return [rendered];
  });
}

function renderTemplate(
  value: ProtocolJsonValue,
  context: Record<string, unknown>,
  options: {
    conditionalDirectives?: boolean;
    arrayItem?: boolean;
  } = {},
): ProtocolJsonValue | typeof OMIT_TEMPLATE_VALUE {
  if (typeof value === 'string') return renderTemplateString(value, context);
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (isRecord(item) && Object.hasOwn(item, FOR_EACH_KEY)) {
        return renderForEachDirective(item as Record<string, ProtocolJsonValue>, context, options);
      }
      const rendered = renderTemplate(item, context, {
        conditionalDirectives: options.conditionalDirectives,
        arrayItem: true,
      });
      return rendered === OMIT_TEMPLATE_VALUE ? [] : [rendered];
    });
  }
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, FOR_EACH_KEY)) {
      throw new Error('调用协议数组展开项只能用于请求体数组元素');
    }
    if (Object.hasOwn(value, WHEN_PRESENT_KEY) || Object.hasOwn(value, CONDITIONAL_VALUE_KEY)) {
      if (!options.conditionalDirectives || !options.arrayItem) {
        throw new Error('调用协议条件项只能用于请求体数组元素');
      }
      const condition = renderTemplateString(String(value[WHEN_PRESENT_KEY]), context);
      const isMissing = condition === OMIT_TEMPLATE_VALUE
        || condition === null
        || (typeof condition === 'string' && !condition.trim())
        || (Array.isArray(condition) && condition.length === 0);
      if (isMissing) return OMIT_TEMPLATE_VALUE;
      return renderTemplate(value[CONDITIONAL_VALUE_KEY], context, {
        conditionalDirectives: true,
      });
    }
    const entries: Array<[string, ProtocolJsonValue]> = [];
    for (const [key, item] of Object.entries(value)) {
      const rendered = renderTemplate(item, context, {
        conditionalDirectives: options.conditionalDirectives,
      });
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

/**
 * 协议声明了鉴权却拿不到 API Key 时直接拦下。
 * 否则请求会不带 Authorization 头照常发出去，用户看到的是上游一句 401 Invalid token，
 * 完全看不出是本地没填密钥——Agent 建的连接默认就是空密钥，很容易踩到。
 */
function assertModelProtocolApiKey(
  auth: ModelProtocolAuthConfig | undefined,
  apiKey: string,
): void {
  if (apiKey || resolveAuthentication(auth).type === 'none') return;
  throw new Error('该模型所在的连接还没有填写 API Key，请在「设置 → API Key」中补填后重试');
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

function renderRequestBody(
  request: ModelProtocolRequestTemplate,
  context: Record<string, unknown>,
): ProtocolJsonValue | undefined {
  if (request.body === undefined) return undefined;
  const rendered = renderTemplate(request.body, context, { conditionalDirectives: true });
  return rendered === OMIT_TEMPLATE_VALUE ? undefined : rendered;
}

function serializedBodyByteLength(body: BodyInit): number {
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString()).byteLength;
  }
  throw new Error('调用协议无法计算该请求体的序列化字节数');
}

function assertSerializedBodyWithinLimit(
  request: ModelProtocolRequestTemplate,
  body: BodyInit,
  label: string,
): void {
  if (request.maxBodyBytes === undefined) return;
  const actualBytes = serializedBodyByteLength(body);
  if (actualBytes <= request.maxBodyBytes) return;
  throw new Error(
    `${label}序列化后为 ${actualBytes} 字节，超过调用协议 maxBodyBytes ${request.maxBodyBytes} 字节`,
  );
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
  const serializedBody = request.method === 'GET' || body === undefined
    ? undefined
    : serializeModelProtocolBody(body, request.bodyEncoding, headers);
  if (serializedBody !== undefined) {
    assertSerializedBodyWithinLimit(request, serializedBody, '提交请求体');
  }
  return {
    method: request.method,
    headers,
    body: serializedBody,
    signal,
  };
}

export function buildModelProtocolRequest(
  options: BuildModelProtocolRequestOptions,
): BuiltModelProtocolRequest {
  const protocol = parseModelExecutionProtocol(options.protocol);
  assertModelProtocolApiKey(protocol.auth, options.apiKey);
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
      ? redactModelProtocolMultipartPreview(built.renderedBody)
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
      ? readModelProtocolFirstScalar(payload, errorPath)
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

function decodeBase64Bytes(value: string): Uint8Array {
  const encoded = /^data:[^;,]+;base64,/i.test(value)
    ? value.slice(value.indexOf(',') + 1)
    : value;
  const normalized = encoded.replace(/\s/g, '');
  try {
    const binary = atob(normalized);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error('模型响应中的 Base64 结果无效');
  }
}

function pcmS16LeToWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  if (pcm.byteLength % blockAlign !== 0) {
    throw new Error('模型响应中的 PCM 数据长度与声道配置不匹配');
  }
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      wav[offset + index] = value.charCodeAt(index);
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

function normalizeBase64Result(
  value: string,
  mimeType: string,
  transform?: ModelProtocolResultConfig['base64Transform'],
): string {
  if (transform?.type === 'pcm-s16le-to-wav') {
    const wav = pcmS16LeToWav(
      decodeBase64Bytes(value),
      transform.sampleRate,
      transform.channels ?? 1,
    );
    return `data:audio/wav;base64,${encodeBytesBase64(wav)}`;
  }
  if (/^data:[^;,]+;base64,/i.test(value)) return value;
  return `data:${mimeType};base64,${encodeBytesBase64(decodeBase64Bytes(value))}`;
}

function buildResultAuthenticationHeaders(
  auth: ModelProtocolAuthConfig | undefined,
  apiKey: string,
): Record<string, string> {
  if (!apiKey) return {};
  const resolvedAuth = resolveAuthentication(auth);
  if (resolvedAuth.type === 'bearer') {
    return { Authorization: `${resolvedAuth.prefix ?? 'Bearer '}${apiKey}` };
  }
  if (resolvedAuth.type === 'header') {
    return { [resolvedAuth.name!]: `${resolvedAuth.prefix ?? ''}${apiKey}` };
  }
  return {};
}

async function fetchSameOriginResultUrls(
  urls: readonly string[],
  baseUrl: string,
  auth: ModelProtocolAuthConfig | undefined,
  apiKey: string,
  fallbackMimeType?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const allowedOrigin = new URL(baseUrl).origin;
  return Promise.all(urls.map(async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.origin !== allowedOrigin) {
      throw new Error('模型结果下载地址与厂商连接地址不同源');
    }
    const response = await corsSafeFetch(
      applyQueryAuthentication(url.toString(), auth, apiKey),
      { method: 'GET', headers: buildResultAuthenticationHeaders(auth, apiKey), signal },
    );
    await ensureSuccessfulRawResponse(response, '模型结果下载失败');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error('模型结果下载内容为空');
    const responseMimeType = response.headers.get('Content-Type')?.split(';')[0]?.trim();
    const mimeType = responseMimeType && MIME_TYPE_RE.test(responseMimeType)
      ? responseMimeType
      : fallbackMimeType ?? 'application/octet-stream';
    return `data:${mimeType};base64,${encodeBytesBase64(bytes)}`;
  }));
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
    const serializedBody = serializeModelProtocolBody(body, poll.bodyEncoding, headers);
    assertSerializedBodyWithinLimit(poll, serializedBody, '轮询请求体');
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
    resultBase64Transform: result.base64Transform
      ? structuredClone(result.base64Transform)
      : undefined,
    resultFetchUrl: result.fetchUrl,
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
    let urls = resultConfig.urlPath ? readModelProtocolUrls(payload, resultConfig.urlPath) : [];
    if (resultConfig.fetchUrl) {
      urls = await fetchSameOriginResultUrls(
        urls,
        options.baseUrl,
        protocol.auth,
        options.apiKey,
        resultConfig.mimeType,
        options.signal,
      );
    }
    const base64Urls = resultConfig.base64Path
      ? readModelProtocolUrls(payload, resultConfig.base64Path).map((value) =>
          normalizeBase64Result(value, resultConfig.mimeType!, resultConfig.base64Transform))
      : [];
    const textValue = resultConfig.textPath
      ? readModelProtocolFirstScalar(payload, resultConfig.textPath)
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
  const taskIdValue = readModelProtocolFirstScalar(payload, responseConfig.taskIdPath!);
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
    : serializeModelProtocolBody(poll.body, poll.bodyEncoding, headers);
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
  const result = await pollTask<ProtocolJsonValue, ExecuteModelProtocolResult>({
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
          {
            ...buildResolvedRequestInit(poll, apiKey),
            signal,
          },
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
      const status = normalizeStatus(readModelProtocolFirstScalar(payload, poll.statusPath));
      if (!successValues.has(status)) return null;
      const urls = poll.resultUrlPath ? readModelProtocolUrls(payload, poll.resultUrlPath) : [];
      const base64Urls = poll.resultBase64Path
        ? readModelProtocolUrls(payload, poll.resultBase64Path).map((value) =>
            normalizeBase64Result(value, poll.resultMimeType!, poll.resultBase64Transform))
        : [];
      const textValue = poll.resultTextPath
        ? readModelProtocolFirstScalar(payload, poll.resultTextPath)
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
      const status = normalizeStatus(readModelProtocolFirstScalar(payload, poll.statusPath));
      if (!failureValues.has(status)) return null;
      const detail = poll.errorPath ? readModelProtocolFirstScalar(payload, poll.errorPath) : undefined;
      return `模型任务失败：${detail || status}`;
    },
    interval: poll.intervalMs,
    maxAttempts: poll.maxAttempts,
    maxDuration: poll.maxDurationMs,
    timeoutMsg: '模型任务轮询超时',
    signal,
  });
  if (result.urls && poll.resultFetchUrl) {
    if (!allowedBaseUrl) throw new Error('同源结果下载缺少厂商连接地址');
    return {
      ...result,
      urls: await fetchSameOriginResultUrls(
        result.urls,
        allowedBaseUrl,
        poll.auth,
        apiKey,
        poll.resultMimeType,
        signal,
      ),
    };
  }
  return result;
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

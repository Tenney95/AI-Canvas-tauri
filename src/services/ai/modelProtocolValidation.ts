/**
 * ai/modelProtocolValidation — 声明式调用协议的校验与归一化。
 *
 * 协议来自用户配置、厂商文档或 Agent 草稿，一律按不可信输入处理：
 * 路径必须同源相对、变量必须在白名单内、鉴权与危险 Header 不可被协议改写，
 * version 1 的扁平字段在此升级为 version 2 的 response / poll.response 结构。
 */
import type {
  ModelExecutionProtocol,
  ModelProtocolRequestTemplate,
  NormalizedModelExecutionProtocol,
  ProtocolJsonValue,
} from '../../types/aiTypes';
import {
  previewNormalizedModelProtocolResponse,
  type ModelProtocolResponsePreviewEntry,
} from './modelProtocolResponse';
import {
  ALLOWED_VARIABLE_ROOTS,
  BLOCKED_PATH_SEGMENTS,
  CONDITIONAL_VALUE_KEY,
  FOR_EACH_KEY,
  FOR_EACH_VARIABLE_ROOTS,
  FULL_TEMPLATE_RE,
  HEADER_NAME_RE,
  MAX_MODEL_PROTOCOL_BODY_BYTES,
  MIME_TYPE_RE,
  TEMPLATE_RE,
  WHEN_PRESENT_KEY,
  isRecord,
  validateHeaderName,
  validatePathExpression,
  validateRelativePath,
  visitTemplateStrings,
} from './modelProtocolShared';

export function validateAuthentication(value: unknown, errors: string[]): void {
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

export function validateRequestHeaders(value: unknown, label: string, errors: string[]): void {
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

export function validateRequest(
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

export function upgradeLegacyProtocolValue(value: Record<string, unknown>): Record<string, unknown> {
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

/** 给协议编辑器用的响应预览：先用校验后的协议抽取各项结果路径。 */
export function previewModelProtocolResponse(
  protocolValue: ModelExecutionProtocol,
  payload: ProtocolJsonValue,
): ModelProtocolResponsePreviewEntry[] {
  return previewNormalizedModelProtocolResponse(
    parseModelExecutionProtocol(protocolValue),
    payload,
  );
}

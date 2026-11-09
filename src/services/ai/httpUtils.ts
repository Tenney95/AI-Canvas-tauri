/**
 * ai/httpUtils — HTTP 请求与错误解析共享工具
 *
 * 提取自 generateImage / generateText 中重复的 `!response.ok → 解析 errorBody → throw` 样板。
 */

/** 保留 HTTP 判定所需的有限元数据，不保留响应正文或原始 payload。 */
export class HttpResponseError extends Error {
  readonly status: number;
  readonly definitiveFailure: boolean;

  constructor(status: number, message: string, definitiveFailure = false) {
    super(message);
    this.name = 'HttpResponseError';
    this.status = status;
    this.definitiveFailure = definitiveFailure;
  }
}

/** 提交信息等包装不能丢失 HTTP 判定；仅沿有界 cause 链查找真实错误实例。 */
export function getHttpResponseError(error: unknown): HttpResponseError | undefined {
  const seen = new Set<Error>();
  for (let depth = 0; depth < 8 && error instanceof Error && !seen.has(error); depth++) {
    if (error instanceof HttpResponseError) return error;
    seen.add(error);
    error = error.cause;
  }
  return undefined;
}

const DEFINITIVE_REJECTION_CODES = new Set([
  'invalid_api_key', 'invalid_request_error', 'invalid_request', 'model_not_found',
  'permission_denied', 'insufficient_quota', 'insufficient_balance',
  'billing_hard_limit_reached', 'rate_limit_exceeded', 'content_policy_violation',
]);

function responseRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function responseFailureCandidates(record: Record<string, unknown>): Array<Record<string, unknown> | undefined> {
  const data = responseRecord(record.data), task = responseRecord(record.task);
  return [record, responseRecord(record.error), data, responseRecord(data?.error), task, responseRecord(task?.error)];
}

function hasStructuredRejection(candidates: Array<Record<string, unknown> | undefined>): boolean {
  return candidates.some((item) => item && (typeof item.status === 'string' && item.status.trim().toLowerCase() === 'failed'
    || [item.code, item.type].some((code) => typeof code === 'string' && DEFINITIVE_REJECTION_CODES.has(code.trim().toLowerCase()))));
}

/** 只检查已知任务／产物字段，冲突或已接受的批项不能被另一项的拒绝码抹掉。 */
function hasAcceptedBatchEvidence(record: Record<string, unknown>): boolean {
  const nonemptyIdentity = (value: unknown): boolean => typeof value === 'string' ? value.trim().length > 0
    : typeof value === 'number' && Number.isFinite(value);
  const hasResult = (value: unknown, depth = 0): boolean => {
    if (value === undefined || value === null) return false;
    if (depth > 4) return true; // 过深的结果描述不能被猜作空结果。
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.some((item) => hasResult(item, depth + 1));
    const result = responseRecord(value);
    return !!result && ['url', 'b64_json', 'image_url', 'video_url', 'audio_url', 'images', 'videos', 'audio', 'audios', 'result', 'results', 'output', 'outputs']
      .some((key) => hasResult(result[key], depth + 1));
  };
  return [record, responseRecord(record.data), responseRecord(record.task)].some((item) => item && (
    [item.task_id, item.taskId, item.id].some(nonemptyIdentity)
    || [item.url, item.b64_json, item.result, item.output, item.images, item.videos, item.audio, item.audios].some((value) => hasResult(value))
    || typeof item.status === 'string' && ['completed', 'succeeded', 'success', 'running', 'pending', 'queued', 'submitted', 'processing'].includes(item.status.trim().toLowerCase())
  ));
}

/** 只认 HTTP 拒绝、有限拒绝码或明确 failed 终态，不能从任意 message 推断未生成。 */
export function classifyHttpResponseFailure(status: number, payload: unknown): boolean {
  // 网关等待超时不能证明上游没接受生成，即使错误正文写了 timeout/failed。
  if (status === 408 || status === 504) return false;
  const record = responseRecord(payload);
  if (record && Array.isArray(record.data) && record.data.length > 0) {
    // 顶层错误不能覆盖已接受项；HTTP本身的明确拒绝不依赖批项补齐错误字段。
    if (record.data.some((item) => { const result = responseRecord(item); return !!result && hasAcceptedBatchEvidence(result); })) return false;
    if (status >= 400 && status < 500 && status !== 429) return true;
    // 其余响应需要每一项自己的有限结构化证据，不能用顶层错误盖过未知批项。
    return record.data.every((item) => {
      const result = responseRecord(item);
      return !!result && hasStructuredRejection(responseFailureCandidates(result));
    });
  }
  if (status >= 400 && status < 500 && status !== 429) return true;
  if (!record) return false;
  return hasStructuredRejection(responseFailureCandidates(record));
}

/**
 * 解析 fetch 响应的错误信息并抛出。
 *
 * 统一处理 `!response.ok` 场景：优先读取常见 JSON 错误字段，
 * 否则截取原始响应文本（最多 200 字符）追加到默认消息后。
 *
 * @param response  fetch 返回的 Response 对象
 * @param defaultMsg 默认错误消息（应包含状态码，如 `图片生成失败 (404)`）
 * @throws Error — 永远抛出，不会正常返回
 */
export async function parseResponseError(response: Response, defaultMsg: string): Promise<never> {
  const errorBody = await response.text().catch(() => '');
  const isHtml = /text\/html/i.test(response.headers.get('Content-Type') ?? '')
    || /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(errorBody);
  if (response.status === 504 && (isHtml || !errorBody.trim())) {
    throw new HttpResponseError(response.status, `${defaultMsg}：网关等待上游响应超时（HTTP 504）。本次生成结果尚未确认，请先检查服务商任务记录，再决定是否重新生成。`);
  }
  let errorMsg = defaultMsg;
  let definitiveFailure = classifyHttpResponseFailure(response.status, undefined);
  try {
    const payload = JSON.parse(errorBody) as unknown;
    definitiveFailure = classifyHttpResponseFailure(response.status, payload);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      const error = record.error;
      // 火山引擎 OpenAPI 错误结构：{ ResponseMetadata: { Error: { Code, Message } } }
      const volcError = (record.ResponseMetadata as Record<string, unknown> | undefined)?.Error as Record<string, unknown> | undefined;
      const volcMessage = typeof volcError?.Message === 'string' && (volcError.Message as string).trim()
        ? (volcError.Message as string).trim()
        : '';
      if (volcMessage) {
        const volcCode = typeof volcError?.Code === 'string' && (volcError.Code as string).trim()
          ? `（${(volcError.Code as string).trim()}）`
          : '';
        errorMsg = volcMessage + volcCode;
      } else if (typeof error === 'string' && error.trim()) {
        errorMsg = error.trim();
      } else if (error && typeof error === 'object' && !Array.isArray(error)) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === 'string' && message.trim()) errorMsg = message.trim();
      } else if (typeof record.message === 'string' && record.message.trim()) {
        errorMsg = record.message.trim();
      } else if (typeof record.msg === 'string' && record.msg.trim()) {
        errorMsg = record.msg.trim();
      }
    }
  } catch {
    if (errorBody) errorMsg += `: ${errorBody.slice(0, 200)}`;
  }
  if (/\bapi[\s_-]*key\b/i.test(errorMsg)) {
    errorMsg += '（请确认使用模型 API Key，而非账户令牌；若密钥正确，请检查账户权限和积分余额）';
  }
  if (/^upstream request failed[.!]?$/i.test(errorMsg.trim())) {
    errorMsg += `（HTTP ${response.status}）`;
  }
  throw new HttpResponseError(response.status, errorMsg, definitiveFailure);
}

/**
 * 构建带 Bearer 认证的 JSON 请求头。
 * apiKey 为空时不添加 Authorization 字段（兼容无需鉴权的本地服务）。
 */
export function buildAuthHeaders(apiKey: string, contentType = 'application/json'): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

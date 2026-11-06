/**
 * comfyPolling — ComfyUI 的 HTTP 通道与任务轮询。
 *
 * 单独成模块：实时生成（comfyWorkflowService）和关窗重启后的任务恢复（pollManager）
 * 都要用同一套轮询，放进任何一侧都会形成循环 import。
 */
import { corsSafeFetch } from './ai/httpTransport';
import { pollTask } from './pollTask';
import { assertComfyTextOutputSize, resolveComfyTextOutput, type ComfyOutputs, type ComfyTextOutput } from './comfyOutputs';
import { withComfyQueryTimeout } from './comfyQuery';

/**
 * 将 ComfyUI 直连地址替换为当前环境可访问的地址：
 * - Tauri 模式：保留原地址（走 Rust proxy_fetch）
 * - 浏览器开发模式：仅本机 HTTP 8188 使用固定的 Vite 代理
 * - 其他服务与生产 Web：保留原地址，不误转到另一台 ComfyUI
 */
export function normalizeComfyUrl(url: string): string {
  if (typeof window === 'undefined'
    || '__TAURI_INTERNALS__' in window
    || '__TAURI__' in window
    || !import.meta.env.DEV) return url;

  try {
    const target = new URL(url);
    if (target.protocol !== 'http:'
      || !['127.0.0.1', 'localhost'].includes(target.hostname)
      || target.port !== '8188'
      || target.username || target.password) return url;
    return `/api/comfyui${target.pathname}${target.search}${target.hash}`;
  } catch {
    return url;
  }
}

/**
 * 跨域安全的 fetch — Tauri 模式走 Rust proxy_fetch，浏览器模式走 Vite 代理。
 * FormData 交给 corsSafeFetch 自己序列化：它用浏览器原生的 Request 编码，
 * 比手搓 multipart 再 base64 来回转一遍快得多，大文件上传不会卡主线程。
 */
export async function comfyFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return corsSafeFetch(normalizeComfyUrl(url), options);
}

export interface ComfyHistoryEntry {
  outputs?: ComfyOutputs;
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: unknown[];
  };
}

function readComfyFailureMessage(entry: ComfyHistoryEntry): string | null {
  const status = entry.status;
  if (!status) return null;
  if (status.status_str?.toLowerCase() === 'error') {
    for (const message of [...(status.messages ?? [])].reverse()) {
      if (!Array.isArray(message) || typeof message[1] !== 'object' || message[1] === null) continue;
      const detail = message[1] as Record<string, unknown>;
      const text = detail.exception_message ?? detail.error ?? detail.message;
      if (typeof text === 'string' && text.trim()) return `ComfyUI 执行失败：${text.trim()}`;
    }
    return 'ComfyUI 执行失败';
  }
  return null;
}

/**
 * Stock ComfyUI writes history after task_done, but some gateways expose a partial
 * history entry while encoders or output nodes are still running. When status is
 * present, require its terminal success signal before returning a media result.
 * Status-less entries remain supported for older ComfyUI-compatible services.
 */
function isComfyHistoryEntryComplete(entry: ComfyHistoryEntry): boolean {
  const status = entry.status;
  if (!status) return true;
  if (typeof status.completed === 'boolean') return status.completed;
  return status.status_str?.toLowerCase() === 'success';
}

/** 队列项形如 [优先级, prompt_id, prompt, extra_data, outputs]；问不到就当还在排队，宁可继续等 */
async function isPromptQueued(
  baseUrl: string,
  promptId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const queue = await withComfyQueryTimeout(async (querySignal) => {
      const response = await comfyFetch(`${baseUrl}/queue`, { signal: querySignal });
      assertComfyQueryResponse(response);
      return await response.json() as Record<string, unknown>;
    }, signal);
    const lists = [queue.queue_running, queue.queue_pending].filter(Array.isArray) as unknown[][];
    if (lists.length === 0) return true;
    return lists.some((list) => list.some((item) => Array.isArray(item) && item[1] === promptId));
  } catch (error) {
    if (error instanceof ComfyQueryAuthorizationError) throw error;
    return true;
  }
}

/** 连着这么多轮 history 和 queue 里都查不到，就认定任务已经不在 ComfyUI 上了 */
const MISSING_ROUNDS_BEFORE_FAIL = 3;
/** 连着这么多轮连不上 ComfyUI 才判失败，中间的网络抖动照常重试 */
const FETCH_ERROR_ROUNDS_BEFORE_FAIL = 10;

/** 查询失败不等于远端任务失败；调用方必须保留已提交任务的恢复记录。 */
export class ComfyPendingError extends Error {
  constructor(message = 'ComfyUI 连接中断，任务已保留，请继续查询') {
    super(message);
    this.name = 'ComfyPendingError';
  }
}

export const COMFY_OUTPUT_UNAVAILABLE_MESSAGE = 'ComfyUI 已完成，但没有可下载的目标媒体。请检查输出类型，并使用 SaveImage、PreviewImage、SaveVideo 或 SaveAudio 等文件输出节点；仅 WebSocket 出图暂不支持取回。';
export const COMFY_TEXT_OUTPUT_UNAVAILABLE_MESSAGE = 'ComfyUI 已完成，但选定的 SaveText 节点没有返回有效 text[] 文本。请使用支持该输出的官方 SaveText；仅 files 文件输出暂不支持取回，原任务已保留。';

/** 执行成功不等于本客户端已识别到文件；保留回执，不能冒充远端失败。 */
export class ComfyOutputUnavailableError extends ComfyPendingError {
  constructor(message = COMFY_OUTPUT_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'ComfyOutputUnavailableError';
  }
}

const COMFY_QUERY_AUTHORIZATION_MESSAGES = {
  401: 'ComfyUI 查询未授权（HTTP 401），请检查服务端鉴权配置；原任务已保留，修复后可继续查询',
  403: 'ComfyUI 查询被拒绝（HTTP 403），请检查服务端访问权限或反向代理限制；原任务已保留，修复后可继续查询',
} as const;

/** 恢复记录仅保存固定状态码，展示时重建文案，不保留上游正文或地址。 */
export function getComfyQueryAuthorizationMessage(status: unknown): string | undefined {
  return status === 401 || status === 403 ? COMFY_QUERY_AUTHORIZATION_MESSAGES[status] : undefined;
}

export class ComfyQueryAuthorizationError extends ComfyPendingError {
  readonly status: 401 | 403;

  constructor(status: 401 | 403) {
    super(COMFY_QUERY_AUTHORIZATION_MESSAGES[status]);
    this.name = 'ComfyQueryAuthorizationError';
    this.status = status;
  }
}

function assertComfyQueryResponse(response: Response): void {
  if (response.ok) return;
  void response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) throw new ComfyQueryAuthorizationError(response.status);
  throw new Error(`HTTP ${response.status}`);
}

const TASK_GONE_MESSAGE = 'ComfyUI 上已找不到该任务（服务重启或队列被清空），请重新生成';

interface ComfyPollState {
  entry?: ComfyHistoryEntry;
  /** history 和 queue 里都连续查不到 */
  gone?: boolean;
}

/**
 * ComfyUI 共享轮询：拉 /history/{promptId}，每 3 秒一次，最多 1200 次（1 小时）。
 * ComfyUI 中途重启会把队列和历史一起丢掉，promptId 从此再也查不到；
 * 这时连 /queue 一起确认几轮就直接判失败，别让用户干等到一小时超时。
 *
 * @param extract 从 outputs 中提取结果，返回 null 表示仍需等待
 */
export async function pollComfyHistory<T>(
  baseUrl: string,
  promptId: string,
  timeoutMsg: string,
  extract: (outputs: ComfyOutputs) => T | null,
  signal?: AbortSignal,
  outputUnavailableMessage = COMFY_OUTPUT_UNAVAILABLE_MESSAGE,
): Promise<T> {
  let missingRounds = 0;
  let errorRounds = 0;

  return pollTask<ComfyPollState, T>({
    fetchState: async () => {
      try {
        const history = await withComfyQueryTimeout(async (querySignal) => {
          const response = await comfyFetch(`${baseUrl}/history/${promptId}`, { signal: querySignal });
          assertComfyQueryResponse(response);
          return await response.json() as Record<string, unknown>;
        }, signal);
        if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
        errorRounds = 0;
        const entry = history[promptId] as ComfyHistoryEntry | undefined;
        if (entry) {
          missingRounds = 0;
          return { entry };
        }
        missingRounds = (await isPromptQueued(baseUrl, promptId, signal)) ? 0 : missingRounds + 1;
        return { gone: missingRounds >= MISSING_ROUNDS_BEFORE_FAIL };
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof ComfyQueryAuthorizationError) throw error;
        errorRounds += 1;
        // 偶发的网络抖动不该打断一个跑了几分钟的任务，连续失败才上抛
        if (errorRounds >= FETCH_ERROR_ROUNDS_BEFORE_FAIL) throw new ComfyPendingError();
        return {};
      }
    },
    isComplete: ({ entry }) => {
      if (!entry || !isComfyHistoryEntryComplete(entry)) return null;
      const result = entry.outputs ? extract(entry.outputs) : null;
      // 只有明确终态才能判定输出不兼容；无 status 的旧服务继续等待。
      if (result === null && entry.status) throw new ComfyOutputUnavailableError(outputUnavailableMessage);
      return result;
    },
    isFailed: ({ entry, gone }) => {
      if (gone) return TASK_GONE_MESSAGE;
      if (!entry) return null;
      const failure = readComfyFailureMessage(entry);
      if (failure) return failure;
      return null;
    },
    interval: 3000,
    maxAttempts: 1200,
    timeoutMsg,
    signal,
  }).catch((error: unknown) => {
    if (!signal?.aborted && error instanceof Error && error.message === timeoutMsg) {
      throw new ComfyPendingError('ComfyUI 查询超时，远端任务可能仍在运行，请继续查询');
    }
    throw error;
  });
}

/** 不读取任意 URL、输入展示节点或未确认的插件字段。 */
export async function readComfyTextOutput(result: ComfyTextOutput, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (typeof result.text !== 'string' || !result.text.trim()) throw new ComfyOutputUnavailableError(COMFY_TEXT_OUTPUT_UNAVAILABLE_MESSAGE);
  assertComfyTextOutputSize(result.text);
  return result.text;
}

export async function pollComfyTextHistory(
  baseUrl: string,
  promptId: string,
  outputNodeIds: readonly string[],
  signal?: AbortSignal,
): Promise<ComfyTextOutput> {
  if (outputNodeIds.length !== 1) throw new ComfyOutputUnavailableError(COMFY_TEXT_OUTPUT_UNAVAILABLE_MESSAGE);
  return pollComfyHistory(baseUrl, promptId, 'ComfyUI 文本生成超时（1 小时）',
    (outputs) => resolveComfyTextOutput(outputs, outputNodeIds), signal, COMFY_TEXT_OUTPUT_UNAVAILABLE_MESSAGE);
}

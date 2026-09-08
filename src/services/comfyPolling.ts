/**
 * comfyPolling — ComfyUI 的 HTTP 通道与任务轮询。
 *
 * 单独成模块：实时生成（comfyWorkflowService）和关窗重启后的任务恢复（pollManager）
 * 都要用同一套轮询，放进任何一侧都会形成循环 import。
 */
import { corsSafeFetch } from './ai/httpTransport';
import { pollTask } from './pollTask';
import type { ComfyOutputs } from './comfyOutputs';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

/**
 * 将 ComfyUI 直连地址替换为当前环境可访问的地址：
 * - Tauri 模式：保留原地址（走 Rust proxy_fetch）
 * - 浏览器开发模式：替换为 Vite 代理路径 /api/comfyui
 */
export function normalizeComfyUrl(url: string): string {
  if (isTauri) return url;
  // Vite dev proxy: http://127.0.0.1:8188/xxx → /api/comfyui/xxx
  return url.replace(/^https?:\/\/127\.0\.0\.1:\d+/, '/api/comfyui');
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

/** 队列项形如 [优先级, prompt_id, prompt, extra_data, outputs]；问不到就当还在排队，宁可继续等 */
async function isPromptQueued(
  baseUrl: string,
  promptId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await comfyFetch(`${baseUrl}/queue`, { signal });
    if (!response.ok) return true;
    const queue = (await response.json()) as Record<string, unknown>;
    const lists = [queue.queue_running, queue.queue_pending].filter(Array.isArray) as unknown[][];
    if (lists.length === 0) return true;
    return lists.some((list) => list.some((item) => Array.isArray(item) && item[1] === promptId));
  } catch {
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
): Promise<T> {
  let missingRounds = 0;
  let errorRounds = 0;

  return pollTask<ComfyPollState, T>({
    fetchState: async () => {
      try {
        const response = await comfyFetch(`${baseUrl}/history/${promptId}`, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const history = (await response.json()) as Record<string, unknown>;
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
        errorRounds += 1;
        // 偶发的网络抖动不该打断一个跑了几分钟的任务，连续失败才上抛
        if (errorRounds >= FETCH_ERROR_ROUNDS_BEFORE_FAIL) throw new ComfyPendingError();
        return {};
      }
    },
    isComplete: ({ entry }) => (entry?.outputs ? extract(entry.outputs) : null),
    isFailed: ({ entry, gone }) => {
      if (gone) return TASK_GONE_MESSAGE;
      if (!entry) return null;
      const failure = readComfyFailureMessage(entry);
      if (failure) return failure;
      if (entry.status?.completed === true) {
        const result = entry.outputs ? extract(entry.outputs) : null;
        if (result === null) return 'ComfyUI 执行完成但未返回目标媒体';
      }
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

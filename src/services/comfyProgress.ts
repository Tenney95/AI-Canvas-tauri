import { useAppStore } from '../store/useAppStore';
import type { ComfyNodeProgressStage } from '../store/store.ui';

const SOCKET_READY_TIMEOUT_MS = 1_000;
const MAX_EVENT_TEXT_LENGTH = 1_048_576;

export interface ParsedComfyProgress {
  promptId?: string;
  stage: ComfyNodeProgressStage;
  value?: number;
  max?: number;
  percent?: number;
  executingNodeId?: string;
}

export interface ComfyProgressSession {
  clientId: string;
  requestId: string;
  waitUntilReady: () => Promise<void>;
  bindPrompt: (promptId: string) => void;
  close: () => void;
}

interface CreateComfyProgressSessionOptions {
  baseUrl: string;
  projectId: string;
  nodeId: string;
  signal?: AbortSignal;
}

interface ProgressStateNode {
  value?: unknown;
  max?: unknown;
  state?: unknown;
  node_id?: unknown;
  display_node_id?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numericProgress(value: unknown, max: unknown): Pick<ParsedComfyProgress, 'value' | 'max' | 'percent'> {
  const safeValue = finiteNumber(value);
  const safeMax = finiteNumber(max);
  if (safeValue === undefined || safeMax === undefined || safeMax <= 0) return {};
  return {
    value: safeValue,
    max: safeMax,
    percent: Math.max(0, Math.min(100, Math.round((safeValue / safeMax) * 100))),
  };
}

/** 将 ComfyUI 新旧 WebSocket 事件收敛为节点可显示的真实执行状态。 */
export function parseComfyProgressEvent(raw: unknown): ParsedComfyProgress | null {
  let message: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_EVENT_TEXT_LENGTH) return null;
    try {
      message = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(message) || typeof message.type !== 'string' || !isRecord(message.data)) return null;

  const { type, data } = message;
  const promptId = stringValue(data.prompt_id);

  if (type === 'progress') {
    return {
      promptId,
      stage: 'running',
      executingNodeId: stringValue(data.node),
      ...numericProgress(data.value, data.max),
    };
  }

  if (type === 'progress_state' && isRecord(data.nodes)) {
    const nodes = Object.entries(data.nodes)
      .filter((entry): entry is [string, ProgressStateNode] => isRecord(entry[1]));
    const running = nodes.find(([, node]) => node.state === 'running');
    if (running) {
      const [nodeKey, node] = running;
      return {
        promptId,
        stage: 'running',
        executingNodeId: stringValue(node.display_node_id) ?? stringValue(node.node_id) ?? nodeKey,
        ...numericProgress(node.value, node.max),
      };
    }
    const allFinished = nodes.length > 0 && nodes.every(([, node]) => node.state === 'finished');
    return { promptId, stage: allFinished ? 'finalizing' : 'queued' };
  }

  if (type === 'execution_start') return { promptId, stage: 'queued' };
  if (type === 'executing') {
    const executingNodeId = stringValue(data.node);
    return { promptId, stage: executingNodeId ? 'running' : 'finalizing', executingNodeId };
  }
  if (type === 'execution_success') return { promptId, stage: 'finalizing' };
  return null;
}

function createRequestId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return randomUuid ? randomUuid() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildSocketUrl(baseUrl: string, clientId: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  const url = new URL(`${normalized}/ws`);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else throw new Error('ComfyUI WebSocket 地址协议无效');
  url.searchParams.set('clientId', clientId);
  return url.toString();
}

/**
 * 为一次画布节点生成建立独立的 ComfyUI 进度通道。
 * 通道不可用时只退化为不确定进度，不影响 /prompt 与 /history 主流程。
 */
export function createComfyProgressSession({
  baseUrl,
  projectId,
  nodeId,
  signal,
}: CreateComfyProgressSessionOptions): ComfyProgressSession {
  const requestId = createRequestId();
  const clientId = `ai-canvas-${requestId}`;
  const store = useAppStore.getState();
  store.beginComfyNodeProgress({
    projectId,
    nodeId,
    requestId,
    clientId,
    stage: 'connecting',
  });

  let socket: WebSocket | null = null;
  let boundPromptId: string | undefined;
  let closed = false;
  let settleReady = () => {};
  let readySettled = false;
  const readyPromise = new Promise<void>((resolve) => {
    settleReady = () => {
      if (readySettled) return;
      readySettled = true;
      resolve();
    };
  });
  const readyTimer = globalThis.setTimeout(settleReady, SOCKET_READY_TIMEOUT_MS);

  const update = (patch: Parameters<typeof store.updateComfyNodeProgress>[2]) => {
    useAppStore.getState().updateComfyNodeProgress(nodeId, requestId, patch);
  };

  try {
    if (typeof globalThis.WebSocket === 'function') {
      socket = new globalThis.WebSocket(buildSocketUrl(baseUrl, clientId));
      socket.onopen = () => {
        settleReady();
        update({ stage: boundPromptId ? 'queued' : 'connecting' });
      };
      socket.onmessage = (event) => {
        if (closed || typeof event.data !== 'string') return;
        const parsed = parseComfyProgressEvent(event.data);
        if (!parsed || (boundPromptId && parsed.promptId && parsed.promptId !== boundPromptId)) return;
        update(parsed);
      };
      socket.onerror = settleReady;
      socket.onclose = () => {
        settleReady();
        if (!closed && boundPromptId) {
          update({ stage: 'running', value: undefined, max: undefined, percent: undefined });
        }
      };
    } else {
      settleReady();
    }
  } catch {
    settleReady();
  }

  const close = () => {
    if (closed) return;
    closed = true;
    globalThis.clearTimeout(readyTimer);
    settleReady();
    signal?.removeEventListener('abort', close);
    if (socket && socket.readyState < globalThis.WebSocket.CLOSING) socket.close();
    useAppStore.getState().clearComfyNodeProgress(nodeId, requestId);
  };
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();

  return {
    clientId,
    requestId,
    waitUntilReady: () => readyPromise,
    bindPrompt: (promptId) => {
      boundPromptId = promptId;
      update({ promptId, stage: 'queued' });
    },
    close,
  };
}

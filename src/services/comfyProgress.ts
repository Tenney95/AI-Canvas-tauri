import { useAppStore } from '../store/useAppStore';
import type { ComfyNodeProgressStage } from '../store/store.ui';

const SOCKET_READY_TIMEOUT_MS = 1_000;
const SOCKET_CONNECT_TIMEOUT_MS = 5_000;
const SOCKET_RECONNECT_DELAY_MS = 1_000;
const MAX_SOCKET_RECONNECTS = 3;
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
  let url = new URL(`${normalized}/ws`);
  // Vite 的固定本地代理同时服务浏览器和 Tauri dev；生产和其他服务器保持原地址。
  if (import.meta.env.DEV && typeof window !== 'undefined'
    && /^https?:$/.test(window.location?.protocol ?? '')
    && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port === '8188' && url.pathname === '/ws') {
    url = new URL('/api/comfyui/ws', window.location.origin);
  }
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
  let reconnectCount = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  const earlyProgress = new Map<string, ParsedComfyProgress>();
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
    if (closed) return;
    useAppStore.getState().updateComfyNodeProgress(nodeId, requestId, patch);
  };

  const applyProgress = (parsed: ParsedComfyProgress) => update({
    value: undefined, max: undefined, percent: undefined, executingNodeId: undefined,
    ...parsed,
    promptId: boundPromptId,
  });

  const connect = () => {
    if (closed || typeof globalThis.WebSocket !== 'function') {
      settleReady();
      return;
    }
    try {
      const currentSocket = new globalThis.WebSocket(buildSocketUrl(baseUrl, clientId));
      socket = currentSocket;
      connectTimer = globalThis.setTimeout(() => {
        if (!closed && socket === currentSocket && currentSocket.readyState === 0) currentSocket.close();
      }, SOCKET_CONNECT_TIMEOUT_MS);
      currentSocket.onopen = () => {
        if (closed || socket !== currentSocket) return;
        globalThis.clearTimeout(connectTimer);
        settleReady();
        update({ stage: boundPromptId ? 'queued' : 'connecting' });
      };
      currentSocket.onmessage = (event) => {
        if (closed || socket !== currentSocket || typeof event.data !== 'string') return;
        const parsed = parseComfyProgressEvent(event.data);
        if (!parsed) return;
        // /prompt 响应前可能已经收到执行事件，先按 promptId 暂存，绑定后只取本次任务。
        if (!boundPromptId) {
          if (parsed.promptId) {
            if (!earlyProgress.has(parsed.promptId) && earlyProgress.size >= 32) return;
            earlyProgress.set(parsed.promptId, parsed);
          }
          return;
        }
        if (parsed.promptId && parsed.promptId !== boundPromptId) return;
        applyProgress(parsed);
      };
      currentSocket.onerror = () => {
        if (closed || socket !== currentSocket) return;
        settleReady();
        currentSocket.close();
      };
      currentSocket.onclose = () => {
        if (closed || socket !== currentSocket) return;
        globalThis.clearTimeout(connectTimer);
        socket = null;
        settleReady();
        earlyProgress.clear();
        update({ stage: 'connecting', value: undefined, max: undefined, percent: undefined, executingNodeId: undefined });
        // 只重连读取进度的通道，不重新提交生成任务。
        if (reconnectCount < MAX_SOCKET_RECONNECTS) {
          reconnectCount += 1;
          reconnectTimer = globalThis.setTimeout(connect, SOCKET_RECONNECT_DELAY_MS);
        }
      };
    } catch {
      settleReady();
    }
  };
  connect();

  const close = () => {
    if (closed) return;
    closed = true;
    globalThis.clearTimeout(readyTimer);
    globalThis.clearTimeout(connectTimer);
    globalThis.clearTimeout(reconnectTimer);
    earlyProgress.clear();
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
      if (closed) return;
      boundPromptId = promptId;
      applyProgress(earlyProgress.get(promptId) ?? { stage: 'queued' });
      earlyProgress.clear();
    },
    close,
  };
}

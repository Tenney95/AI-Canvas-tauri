import {
  buildDirectorDeskWindowUrl,
  type DirectorExtensionAction,
} from './directorDeskService';

export const DIRECTOR_DESK_WINDOW_LABEL = 'director-desk';
export const DIRECTOR_DESK_HOST_EVENT = 'director-desk:host-message';
export const DIRECTOR_DESK_MESSAGE_EVENT = 'director-desk:message';

export type DirectorDeskProtocolMessage = {
  type: string;
  payload?: Record<string, unknown>;
};

export type DirectorDeskWindowEnvelope = {
  instanceId: string;
  message: DirectorDeskProtocolMessage;
};

type Subscriber = (message: DirectorDeskProtocolMessage) => void;
type PendingRequest = {
  instanceId: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const ALLOWED_DIRECTOR_MESSAGE_TYPES = new Set([
  'storyai:director-desk-ready',
  'storyai:director-desk-close',
  'storyai:director-desk-captures-sent',
  'storyai:director-desk:response',
]);

const subscribers = new Map<string, Set<Subscriber>>();
const pendingRequests = new Map<string, PendingRequest>();
let mainListenerPromise: Promise<void> | null = null;
let unlistenMain: (() => void) | null = null;
let activeInstanceId: string | null = null;

function normalizeInstanceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const instanceId = value.trim();
  if (!instanceId || instanceId.length > 128) return null;
  return instanceId;
}

export function parseDirectorDeskWindowEnvelope(value: unknown): DirectorDeskWindowEnvelope | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const instanceId = normalizeInstanceId(candidate.instanceId);
  if (!instanceId || !candidate.message || typeof candidate.message !== 'object') return null;
  const message = candidate.message as Record<string, unknown>;
  if (typeof message.type !== 'string' || !ALLOWED_DIRECTOR_MESSAGE_TYPES.has(message.type)) return null;
  if (message.payload !== undefined && (!message.payload || typeof message.payload !== 'object')) return null;
  return {
    instanceId,
    message: {
      type: message.type,
      ...(message.payload ? { payload: message.payload as Record<string, unknown> } : {}),
    },
  };
}

export function isTauriDirectorWindowAvailable(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);
}

function dispatchDirectorMessage(envelope: DirectorDeskWindowEnvelope) {
  const { instanceId, message } = envelope;
  if (message.type === 'storyai:director-desk:response') {
    const requestId = typeof message.payload?.requestId === 'string'
      ? message.payload.requestId
      : '';
    const pending = pendingRequests.get(requestId);
    if (pending && pending.instanceId === instanceId) {
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      if (message.payload?.ok === false) {
        const error = message.payload.error as { message?: unknown } | undefined;
        pending.reject(new Error(
          typeof error?.message === 'string' ? error.message : '3D 导演台请求失败',
        ));
      } else {
        pending.resolve(message.payload?.data);
      }
    }
  }

  notifySubscribers(instanceId, message);

  if (message.type === 'storyai:director-desk-close') {
    void closeDirectorDeskWindow();
  }
}

function notifySubscribers(instanceId: string, message: DirectorDeskProtocolMessage) {
  for (const subscriber of subscribers.get(instanceId) ?? []) {
    subscriber(message);
  }
}

function setActiveInstance(instanceId: string) {
  const previousInstanceId = activeInstanceId;
  activeInstanceId = instanceId;
  if (!previousInstanceId || previousInstanceId === instanceId) return;

  for (const [requestId, pending] of pendingRequests) {
    if (pending.instanceId !== previousInstanceId) continue;
    clearTimeout(pending.timer);
    pendingRequests.delete(requestId);
    pending.reject(new Error('3D 导演台已切换到其他节点'));
  }
  notifySubscribers(previousInstanceId, { type: 'storyai:director-desk-close' });
}

async function ensureMainListener(): Promise<void> {
  if (mainListenerPromise) return mainListenerPromise;
  mainListenerPromise = (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    unlistenMain = await listen<unknown>(DIRECTOR_DESK_MESSAGE_EVENT, (event) => {
      const envelope = parseDirectorDeskWindowEnvelope(event.payload);
      if (envelope) dispatchDirectorMessage(envelope);
    });
  })().catch((error) => {
    mainListenerPromise = null;
    throw error;
  });
  return mainListenerPromise;
}

async function emitHostMessage(envelope: DirectorDeskWindowEnvelope): Promise<void> {
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo(DIRECTOR_DESK_WINDOW_LABEL, DIRECTOR_DESK_HOST_EVENT, envelope);
}

export async function openDirectorDeskWindow({
  instanceId,
  theme = 'dark',
}: {
  instanceId: string;
  theme?: 'dark' | 'light';
}): Promise<void> {
  const normalizedInstanceId = normalizeInstanceId(instanceId);
  if (!normalizedInstanceId) throw new Error('导演台节点标识无效');
  if (!isTauriDirectorWindowAvailable()) {
    throw new Error('3D 导演台独立窗口仅支持 Tauri 桌面端');
  }

  await ensureMainListener();
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const existing = await WebviewWindow.getByLabel(DIRECTOR_DESK_WINDOW_LABEL);
  setActiveInstance(normalizedInstanceId);
  if (existing) {
    await existing.show().catch(() => {});
    await existing.unminimize().catch(() => {});
    await existing.setFocus();
    await emitHostMessage({
      instanceId: normalizedInstanceId,
      message: {
        type: 'storyai:director-desk-session',
        payload: { instanceId: normalizedInstanceId, theme },
      },
    });
    return;
  }

  const directorWindow = new WebviewWindow(DIRECTOR_DESK_WINDOW_LABEL, {
    url: buildDirectorDeskWindowUrl(normalizedInstanceId, theme),
    title: '3D 导演台',
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    center: true,
    resizable: true,
    decorations: true,
    visible: true,
    parent: 'main',
  });

  await new Promise<void>((resolve, reject) => {
    void directorWindow.once('tauri://created', () => resolve());
    void directorWindow.once('tauri://error', (event) => {
      activeInstanceId = null;
      reject(new Error(`创建 3D 导演台窗口失败：${String(event.payload ?? 'unknown')}`));
    });
  });

  void directorWindow.once('tauri://destroyed', () => {
    const closedInstanceId = activeInstanceId;
    activeInstanceId = null;
    if (closedInstanceId) {
      dispatchDirectorMessage({
        instanceId: closedInstanceId,
        message: { type: 'storyai:director-desk-close' },
      });
    }
  });
}

export function subscribeDirectorDeskWindow(
  instanceId: string,
  subscriber: Subscriber,
): () => void {
  const normalizedInstanceId = normalizeInstanceId(instanceId);
  if (!normalizedInstanceId) return () => {};
  const instanceSubscribers = subscribers.get(normalizedInstanceId) ?? new Set<Subscriber>();
  instanceSubscribers.add(subscriber);
  subscribers.set(normalizedInstanceId, instanceSubscribers);
  void ensureMainListener().catch((error) => {
    console.error('[directorDeskWindow] 初始化事件监听失败:', error);
  });
  return () => {
    instanceSubscribers.delete(subscriber);
    if (instanceSubscribers.size === 0) subscribers.delete(normalizedInstanceId);
  };
}

export async function postDirectorWindowSession(
  instanceId: string,
  theme: 'dark' | 'light',
): Promise<void> {
  await emitHostMessage({
    instanceId,
    message: {
      type: 'storyai:director-desk-session',
      payload: { instanceId, theme },
    },
  });
}

export async function postDirectorWindowPanorama(
  instanceId: string,
  payload: {
    edgeId?: string;
    sourceNodeId?: string;
    imageUrl: string;
    fileName?: string;
  },
): Promise<void> {
  await emitHostMessage({
    instanceId,
    message: { type: 'storyai:director-desk-panorama', payload },
  });
}

export function requestDirectorWindowAction(
  instanceId: string,
  action: DirectorExtensionAction,
  options?: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<unknown> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`3D 导演台请求超时：${action}`));
    }, timeoutMs);
    pendingRequests.set(requestId, { instanceId, resolve, reject, timer });
    void ensureMainListener()
      .then(() => emitHostMessage({
        instanceId,
        message: {
          type: 'storyai:director-desk:request',
          payload: { requestId, action, ...(options ? { options } : {}) },
        },
      }))
      .catch((error) => {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        reject(error);
      });
  });
}

export async function closeDirectorDeskWindow(): Promise<void> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const directorWindow = await WebviewWindow.getByLabel(DIRECTOR_DESK_WINDOW_LABEL);
    if (directorWindow) await directorWindow.close();
  } catch {
    /* window may already be gone */
  }
}

export function __resetDirectorDeskWindowServiceForTests() {
  unlistenMain?.();
  unlistenMain = null;
  mainListenerPromise = null;
  activeInstanceId = null;
  subscribers.clear();
  for (const pending of pendingRequests.values()) clearTimeout(pending.timer);
  pendingRequests.clear();
}

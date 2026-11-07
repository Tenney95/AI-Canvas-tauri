/**
 * chatReferencePreviewService — 路由主窗口与独立聊天窗口的引用预览请求。
 */
import { useAppStore } from '../../store/useAppStore';
import type { ReferencePreviewContent, ReferencePreviewSource } from '../../types/referencePreview';
import {
  CHAT_DETACHED_WINDOW_LABEL, CHAT_REFERENCE_PREVIEW_EVENT,
  type ChatAction, type ChatReferencePreviewResponse,
  emitAction, getChatReferenceWindowFrame, getMainChatWindowSessionId,
} from './chatWindowService';

export const CHAT_REFERENCE_PREVIEW_TIMEOUT_MS = 15_000;
type PreviewAction = Extract<ChatAction, { type: 'preview_reference' | 'cancel_reference_preview' }>;
type PreviewRequest = Extract<PreviewAction, { type: 'preview_reference' }>;

interface MainPreviewRequest {
  requestId: string;
  sessionId?: string;
  projectId: string | null;
  controller: AbortController;
  dispose: () => void;
}

let activeMainRequest: MainPreviewRequest | null = null;
let cancelClientRequest: (() => void) | null = null;

function abortError(): DOMException { return new DOMException('引用内容读取已取消', 'AbortError'); }

function supportedSource(source: ReferencePreviewSource | undefined): boolean {
  return !!source && ['node', 'drama', 'model', 'skill', 'chat-image'].includes(source.kind)
    && typeof source.id === 'string' && source.id.length > 0 && source.id.length <= 4096
    && typeof source.label === 'string' && source.label.length <= 4096;
}

function unavailable(title: string, message: string): ReferencePreviewContent {
  return { kind: 'text', title, unavailable: message };
}

function mainRequestFresh(request: MainPreviewRequest): boolean {
  const state = useAppStore.getState();
  return activeMainRequest === request && !request.controller.signal.aborted
    && request.sessionId === getMainChatWindowSessionId()
    && state.chatPanelDetached && state.currentProjectId === request.projectId;
}

/** 关闭、收回、换项目与新请求均撤掉旧读取；不修改任何业务状态。 */
export function cancelMainReferencePreview(): void {
  const request = activeMainRequest;
  activeMainRequest = null;
  request?.controller.abort();
  request?.dispose();
}

async function emitPreviewResult(response: ChatReferencePreviewResponse, valid: () => boolean): Promise<void> {
  const { emitTo } = await import('@tauri-apps/api/event');
  if (valid()) await emitTo(CHAT_DETACHED_WINDOW_LABEL, CHAT_REFERENCE_PREVIEW_EVENT, response);
}

async function readMainPreview(action: PreviewRequest): Promise<void> {
  if (typeof action.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(action.requestId)) return;
  const state = useAppStore.getState();
  if (!supportedSource(action.source) || !state.chatPanelDetached || state.currentProjectId !== action.projectId) {
    await emitPreviewResult({ requestId: action.requestId, sessionId: action.windowFrame?.sessionId, projectId: action.projectId,
      content: unavailable('引用内容', '当前项目或引用已不可用，请在当前对话重新打开') }, () => true).catch(() => {});
    return;
  }
  cancelMainReferencePreview();
  const controller = new AbortController();
  const request: MainPreviewRequest = { requestId: action.requestId, sessionId: action.windowFrame?.sessionId, projectId: action.projectId, controller, dispose: () => {} };
  activeMainRequest = request;
  const unsubscribe = useAppStore.subscribe((next) => {
    if (activeMainRequest === request && (!next.chatPanelDetached || next.currentProjectId !== request.projectId)) cancelMainReferencePreview();
  });
  const timer = setTimeout(() => { if (activeMainRequest === request) cancelMainReferencePreview(); }, CHAT_REFERENCE_PREVIEW_TIMEOUT_MS);
  request.dispose = () => { unsubscribe(); clearTimeout(timer); };
  try {
    const { resolveReferencePreview } = await import('../referencePreviewService');
    if (!mainRequestFresh(request)) return;
    // 不接收工作流值或本地路径参数，只读当前主窗口中已存在的聊天引用。
    const source = { kind: action.source.kind, id: action.source.id, label: action.source.label };
    const content = await resolveReferencePreview(source, { signal: controller.signal });
    await emitPreviewResult({ requestId: action.requestId, sessionId: request.sessionId, projectId: action.projectId, content }, () => mainRequestFresh(request));
  } catch {
    if (mainRequestFresh(request)) await emitPreviewResult({ requestId: action.requestId, sessionId: request.sessionId, projectId: action.projectId,
      content: unavailable(action.source.label || '引用内容', '引用内容读取失败，请稍后重新打开') }, () => mainRequestFresh(request)).catch(() => {});
  } finally {
    if (activeMainRequest === request) cancelMainReferencePreview();
  }
}

/** 主窗口的只读 ChatAction 路由；最多一个活动读取，响应仅发往原生聊天窗口。 */
export function handleDetachedReferencePreviewAction(action: PreviewAction): void {
  if (action.type === 'cancel_reference_preview') {
    if (activeMainRequest?.requestId === action.requestId && activeMainRequest.projectId === action.projectId) cancelMainReferencePreview();
    return;
  }
  void readMainPreview(action);
}

/** 独立窗口先登记定向结果监听，再请求主窗口读取完整引用；不扩充常驻快照。 */
export async function requestDetachedReferencePreview(
  source: ReferencePreviewSource,
  projectId: string | null,
  signal?: AbortSignal,
): Promise<ReferencePreviewContent> {
  if (signal?.aborted || useAppStore.getState().currentProjectId !== projectId) throw abortError();
  if (!supportedSource(source)) return unavailable(source.label || '引用内容', '独立聊天窗口暂不支持此类引用');
  cancelClientRequest?.();
  const { listen } = await import('@tauri-apps/api/event');
  if (signal?.aborted || useAppStore.getState().currentProjectId !== projectId) throw abortError();
  cancelClientRequest?.();
  const requestId = crypto.randomUUID();
  const windowFrame = getChatReferenceWindowFrame();
  return new Promise<ReferencePreviewContent>((resolve, reject) => {
    let finished = false;
    let sent = false;
    let unlisten: (() => void) | undefined;
    const sendCancel = () => {
      if (sent) void emitAction({ type: 'cancel_reference_preview', requestId, projectId }, windowFrame).catch(() => {});
    };
    const finish = (content?: ReferencePreviewContent, error?: Error) => {
      if (finished) return;
      finished = true;
      unlisten?.();
      unsubscribe();
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', abort);
        window.removeEventListener('beforeunload', abort);
      }
      if (cancelClientRequest === abort) cancelClientRequest = null;
      if (error) { sendCancel(); reject(error); }
      else if (content) resolve(content);
    };
    const abort = () => finish(undefined, abortError());
    const unsubscribe = useAppStore.subscribe((next) => { if (next.currentProjectId !== projectId) abort(); });
    const timer = setTimeout(() => finish(undefined, new Error('引用内容读取超时，请重新打开')), CHAT_REFERENCE_PREVIEW_TIMEOUT_MS);
    cancelClientRequest = abort;
    signal?.addEventListener('abort', abort, { once: true });
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', abort);
      window.addEventListener('beforeunload', abort);
    }
    void listen<ChatReferencePreviewResponse>(CHAT_REFERENCE_PREVIEW_EVENT, ({ payload }) => {
      if (finished || payload?.requestId !== requestId || payload.sessionId !== windowFrame?.sessionId || payload.projectId !== projectId) return;
      if (signal?.aborted || useAppStore.getState().currentProjectId !== projectId) { abort(); return; }
      const content = payload.content;
      if (!content || !['text', 'markdown', 'image', 'video', 'audio'].includes(content.kind) || typeof content.title !== 'string') return;
      finish(content);
    }).then((dispose) => {
      if (finished) { dispose(); return; }
      unlisten = dispose;
      if (signal?.aborted || useAppStore.getState().currentProjectId !== projectId) { abort(); return; }
      sent = true;
      return emitAction({
        type: 'preview_reference', requestId, projectId,
        source: { kind: source.kind, id: source.id, label: source.label },
      } satisfies ChatAction, windowFrame);
    }).catch(() => finish(undefined, new Error('无法连接主窗口读取引用内容')));
  });
}

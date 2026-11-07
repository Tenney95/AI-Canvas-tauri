/**
 * chatReferencePreviewService — 回归测试：独立窗口按需引用预览桥接。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAction, ChatReferencePreviewResponse } from '../../../src/services/chat/chatWindowService';
import type { ProjectWindowFrame } from '../../../src/types/projectWindow';

interface Frame { target: string; event: string; payload: unknown }
const bus = vi.hoisted(() => ({
  frames: [] as Frame[],
  listeners: new Set<(event: { payload: unknown }) => void>(),
  order: [] as string[],
  route: undefined as ((action: ChatAction) => void) | undefined,
  pauseListen: false,
  releaseListen: undefined as (() => void) | undefined,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
    bus.order.push('listen');
    bus.listeners.add(handler);
    if (bus.pauseListen) await new Promise<void>((resolve) => { bus.releaseListen = resolve; });
    return () => { bus.listeners.delete(handler); };
  }),
  emitTo: vi.fn(async (target: string, event: string, payload: unknown) => {
    bus.order.push(`emit:${event}`);
    bus.frames.push({ target, event, payload });
    if (target === 'main' && event === 'chat:action') bus.route?.(payload as ChatAction);
    if (target === 'chat-assistant' && event === 'chat:reference-preview-result') {
      for (const handler of bus.listeners) handler({ payload });
    }
  }),
}));
vi.mock('../../../src/services/chat/chatImageReferenceService', async (original) => ({
  ...await original<typeof import('../../../src/services/chat/chatImageReferenceService')>(),
  readChatImageReference: vi.fn(async () => 'data:image/png;base64,aW1hZ2U='),
}));

import { useAppStore } from '../../../src/store/useAppStore';
import { readChatImageReference } from '../../../src/services/chat/chatImageReferenceService';
import { handleDetachedChatAction, projectChatNodes } from '../../../src/services/chat/detachedChatSyncController';
import {
  cancelMainReferencePreview, CHAT_REFERENCE_PREVIEW_TIMEOUT_MS, requestDetachedReferencePreview,
} from '../../../src/services/chat/chatReferencePreviewService';
import { beginChatWindowSession, CHAT_ACTION_EVENT, CHAT_REFERENCE_PREVIEW_EVENT, endChatWindowSession,
  getMainChatWindowSessionId, setChatReferenceWindowFrame } from '../../../src/services/chat/chatWindowService';

const source = { kind: 'node' as const, id: 'node', label: '原文' };
const image = { kind: 'chat-image' as const, id: 'chat-ref-00000000-0000-0000-0000-000000000000.png', label: '参考图' };
const text = '独立窗口按需读取完整正文。'.repeat(100);
function requests() { return bus.frames.filter((frame) => frame.event === CHAT_ACTION_EVENT && (frame.payload as ChatAction).type === 'preview_reference'); }
function results() { return bus.frames.filter((frame) => frame.event === CHAT_REFERENCE_PREVIEW_EVENT); }
function deliver(response: ChatReferencePreviewResponse) {
  for (const handler of bus.listeners) handler({ payload: response });
}

beforeEach(() => {
  cancelMainReferencePreview();
  endChatWindowSession(getMainChatWindowSessionId());
  setChatReferenceWindowFrame(null);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project', chatPanelDetached: true,
    nodes: [{ id: 'node', type: 'source-text', position: { x: 0, y: 0 }, data: { type: 'source-text', label: '完整原文', output: text } }] });
  bus.frames = [];
  bus.order = [];
  bus.listeners.clear();
  bus.pauseListen = false;
  bus.releaseListen = undefined;
  bus.route = (action) => handleDetachedChatAction(action, vi.fn());
  vi.mocked(readChatImageReference).mockReset();
  vi.mocked(readChatImageReference).mockResolvedValue('data:image/png;base64,aW1hZ2U=');
});

afterEach(() => {
  cancelMainReferencePreview();
  endChatWindowSession(getMainChatWindowSessionId());
  setChatReferenceWindowFrame(null);
  bus.releaseListen?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('独立窗口按需引用预览桥接', () => {
  it('新窗同项目同请求 ID 也拒绝旧会话迟到的预览响应', async () => {
    bus.route = undefined;
    const sessionId = beginChatWindowSession();
    setChatReferenceWindowFrame({ sessionId } as ProjectWindowFrame);
    let completed = false;
    const pending = requestDetachedReferencePreview(source, 'project').then((content) => { completed = true; return content; });
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    const request = requests()[0].payload as Extract<ChatAction, { type: 'preview_reference' }>;
    expect(request.windowFrame?.sessionId).toBe(sessionId);
    deliver({ requestId: request.requestId, sessionId: 'old-window-session', projectId: 'project', content: { kind: 'text', title: '旧窗口', text: '迟到旧结果' } });
    await Promise.resolve();
    expect(completed).toBe(false);
    deliver({ requestId: request.requestId, sessionId, projectId: 'project', content: { kind: 'text', title: '新窗口', text } });
    expect((await pending).text).toBe(text);
  });

  it('先监听再向 main 发送，主窗口仅向 chat-assistant 返回完整内容，不扩充节点快照或写 Store', async () => {
    const state = useAppStore.getState();
    expect(projectChatNodes(state.nodes)[0].data.output).toBeUndefined();
    const content = await requestDetachedReferencePreview(source, 'project');
    expect(content).toMatchObject({ kind: 'text', title: '完整原文', text });
    expect(bus.order[0]).toBe('listen');
    expect(requests()[0].target).toBe('main');
    expect(results()[0].target).toBe('chat-assistant');
    expect(useAppStore.getState()).toBe(state);
    expect(bus.listeners.size).toBe(0);
    expect(JSON.stringify(results()[0].payload)).not.toMatch(/filePath|sourceId|apiKey|storagePath/);
  });

  it('仅接受当前 requestId 和项目，迟到或串项目结果不覆盖本次预览', async () => {
    bus.route = undefined;
    let completed = false;
    const pending = requestDetachedReferencePreview(source, 'project').then((content) => { completed = true; return content; });
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    const request = requests()[0].payload as Extract<ChatAction, { type: 'preview_reference' }>;
    deliver({ requestId: 'older-request', projectId: 'project', content: { kind: 'text', title: '旧内容', text: '旧内容' } });
    deliver({ requestId: request.requestId, projectId: 'other-project', content: { kind: 'text', title: '别的项目', text: '别的项目' } });
    await Promise.resolve();
    expect(completed).toBe(false);
    deliver({ requestId: request.requestId, projectId: 'project', content: { kind: 'text', title: '当前内容', text } });
    expect((await pending).text).toBe(text);
    expect(bus.listeners.size).toBe(0);
  });

  it('主窗口拒绝资产路径、工作流、失配项目与已关闭窗口，不执行引用读取', async () => {
    for (const kind of ['asset', 'workflow'] as const) {
      handleDetachedChatAction({ type: 'preview_reference', requestId: `unsupported-${kind}`, projectId: 'project',
        source: { kind, id: 'not-a-chat-reference', label: '不支持' } }, vi.fn());
      await vi.waitFor(() => expect(results().some((frame) => (frame.payload as ChatReferencePreviewResponse).requestId === `unsupported-${kind}`)).toBe(true));
    }
    handleDetachedChatAction({ type: 'preview_reference', requestId: 'wrong-project', projectId: 'other', source: image }, vi.fn());
    await vi.waitFor(() => expect(results()).toHaveLength(3));
    useAppStore.setState({ chatPanelDetached: false });
    handleDetachedChatAction({ type: 'preview_reference', requestId: 'closed-window', projectId: 'project', source: image }, vi.fn());
    await vi.waitFor(() => expect(results().map((frame) => (frame.payload as ChatReferencePreviewResponse).requestId))
      .toEqual(['unsupported-asset', 'unsupported-workflow', 'wrong-project', 'closed-window']));
    for (const frame of results()) expect((frame.payload as ChatReferencePreviewResponse).content.unavailable).toBeTruthy();
    expect(readChatImageReference).not.toHaveBeenCalled();
  });

  it('关闭或切换项目会中止主窗口异步读取，旧请求完成后不再发送结果', async () => {
    let finish!: (url: string) => void;
    let readSignal: AbortSignal | undefined;
    vi.mocked(readChatImageReference).mockImplementationOnce((_scope, _name, signal) => {
      readSignal = signal;
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const controller = new AbortController();
    const pending = requestDetachedReferencePreview(image, 'project', controller.signal);
    await vi.waitFor(() => expect(readChatImageReference).toHaveBeenCalled());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    useAppStore.setState({ currentProjectId: 'other-project' });
    await rejected;
    expect(readSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(bus.frames.some((frame) => (frame.payload as ChatAction).type === 'cancel_reference_preview')).toBe(true));
    finish('data:image/png;base64,bGF0ZQ==');
    await Promise.resolve();
    await Promise.resolve();
    expect(results()).toHaveLength(0);
    expect(bus.listeners.size).toBe(0);
  });

  it('主窗口仅保留最新读取，错误的取消 ID 不会撤销当前请求', async () => {
    let finish!: (url: string) => void;
    let readSignal: AbortSignal | undefined;
    vi.mocked(readChatImageReference).mockImplementationOnce((_scope, _name, signal) => {
      readSignal = signal;
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    handleDetachedChatAction({ type: 'preview_reference', requestId: 'first-read', projectId: 'project', source: image }, vi.fn());
    await vi.waitFor(() => expect(readChatImageReference).toHaveBeenCalled());
    handleDetachedChatAction({ type: 'cancel_reference_preview', requestId: 'unrelated-read', projectId: 'project' }, vi.fn());
    expect(readSignal?.aborted).toBe(false);
    handleDetachedChatAction({ type: 'preview_reference', requestId: 'latest-read', projectId: 'project', source }, vi.fn());
    expect(readSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect((results()[0].payload as ChatReferencePreviewResponse).requestId).toBe('latest-read');
    finish('data:image/png;base64,bGF0ZQ==');
    await Promise.resolve();
    await Promise.resolve();
    expect(results()).toHaveLength(1);
  });

  it('取消发生在原生监听登记完成前时，也清理迟到的监听且不发送读取', async () => {
    bus.pauseListen = true;
    const controller = new AbortController();
    const pending = requestDetachedReferencePreview(source, 'project', controller.signal);
    await vi.waitFor(() => expect(bus.releaseListen).toBeTypeOf('function'));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    bus.releaseListen?.();
    await vi.waitFor(() => expect(bus.listeners.size).toBe(0));
    expect(requests()).toHaveLength(0);
  });

  it('超时撤销远端请求并释放监听，页面关闭也走相同取消路径', async () => {
    bus.route = undefined;
    vi.useFakeTimers();
    const pending = requestDetachedReferencePreview(source, 'project');
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    const timedOut = expect(pending).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(CHAT_REFERENCE_PREVIEW_TIMEOUT_MS);
    await timedOut;
    expect(bus.listeners.size).toBe(0);
    expect(bus.frames.some((frame) => (frame.payload as ChatAction).type === 'cancel_reference_preview')).toBe(true);
    vi.useRealTimers();
    const fakeWindow = new EventTarget();
    vi.stubGlobal('window', fakeWindow);
    const closing = requestDetachedReferencePreview(source, 'project');
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    const cancelled = expect(closing).rejects.toMatchObject({ name: 'AbortError' });
    fakeWindow.dispatchEvent(new Event('pagehide'));
    await cancelled;
    expect(bus.listeners.size).toBe(0);
  });
});

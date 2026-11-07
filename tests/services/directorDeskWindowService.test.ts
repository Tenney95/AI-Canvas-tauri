/**
 * directorDeskWindowService — 回归测试：directorDeskWindowService。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  emitTo: vi.fn(async () => undefined),
  eventHandler: null as null | ((event: { payload: unknown }) => void),
  existingWindow: null as MockWindow | null,
  created: [] as MockWindow[],
  exchangeEpoch: 0,
  projectId: 'project-a', subscribers: new Set<() => void>(),
}));

class MockWindow {
  label: string;
  options: Record<string, unknown>;
  show = vi.fn(async () => undefined);
  unminimize = vi.fn(async () => undefined);
  setFocus = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);

  constructor(label: string, options: Record<string, unknown> = {}) {
    this.label = label;
    this.options = options;
    tauriMocks.created.push(this);
  }

  static getByLabel = vi.fn(async () => tauriMocks.existingWindow);

  once(event: string, handler: (event: { payload?: unknown }) => void) {
    if (event === 'tauri://created') queueMicrotask(() => handler({}));
    return Promise.resolve(() => undefined);
  }
}

vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: MockWindow }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({
  currentProjectId: tauriMocks.projectId, projects: [{ id: 'project-a', exchangeEpoch: tauriMocks.exchangeEpoch }],
  getCurrentRevision: () => 0, nodes: ['node-14', 'node-22'].map((id) => ({ id, type: 'ai-director', data: { directorInstanceId: id } })),
}), subscribe: (listener: () => void) => {
  tauriMocks.subscribers.add(listener); return () => tauriMocks.subscribers.delete(listener);
} } }));
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: tauriMocks.emitTo,
  listen: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
    tauriMocks.eventHandler = handler;
    return () => { tauriMocks.eventHandler = null; };
  }),
}));

import {
  DIRECTOR_DESK_HOST_EVENT,
  DIRECTOR_DESK_MESSAGE_EVENT,
  DIRECTOR_DESK_WINDOW_LABEL,
  __resetDirectorDeskWindowServiceForTests,
  openDirectorDeskWindow,
  requestDirectorWindowAction,
  subscribeDirectorDeskWindow,
} from '../../src/services/directorDeskWindowService';
import { buildDirectorDeskWindowUrl } from '../../src/services/directorDeskService';

describe('directorDeskWindowService', () => {
  beforeEach(() => {
    __resetDirectorDeskWindowServiceForTests();
    tauriMocks.emitTo.mockClear();
    tauriMocks.eventHandler = null;
    tauriMocks.existingWindow = null;
    tauriMocks.created.length = 0;
    tauriMocks.exchangeEpoch = 0;
    tauriMocks.projectId = 'project-a'; tauriMocks.subscribers.clear();
    MockWindow.getByLabel.mockClear();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __TAURI__: {},
        location: { origin: 'http://localhost:1420' },
        setTimeout,
        clearTimeout,
      },
    });
  });

  it('creates one Tauri window with the requested director instance', async () => {
    await openDirectorDeskWindow({ instanceId: 'node-14', theme: 'dark' });

    expect(tauriMocks.created).toHaveLength(1);
    expect(tauriMocks.created[0]?.label).toBe(DIRECTOR_DESK_WINDOW_LABEL);
    expect(String(tauriMocks.created[0]?.options.url)).toContain(
      'director-desk://localhost/index.html',
    );
    expect(String(tauriMocks.created[0]?.options.url)).toContain('instanceId=node-14');
    expect(String(tauriMocks.created[0]?.options.url)).toContain('transport=tauri');
  });

  it('always uses the installed runtime protocol', () => {
    const url = buildDirectorDeskWindowUrl('node-14', 'light');

    expect(url).toBe(
      'director-desk://localhost/index.html?instanceId=node-14&theme=light&transport=tauri&hostWindowLabel=main',
    );
    expect(url).not.toContain('127.0.0.1');
  });

  it('focuses an existing window and switches its scoped session', async () => {
    await openDirectorDeskWindow({ instanceId: 'node-14' });
    const existing = tauriMocks.created[0]!;
    tauriMocks.created.length = 0;
    tauriMocks.existingWindow = existing;

    await openDirectorDeskWindow({ instanceId: 'node-22', theme: 'light' });

    expect(existing.show).toHaveBeenCalledOnce();
    expect(existing.unminimize).toHaveBeenCalledOnce();
    expect(existing.setFocus).toHaveBeenCalledOnce();
    expect(tauriMocks.emitTo).toHaveBeenCalledWith(
      DIRECTOR_DESK_WINDOW_LABEL,
      DIRECTOR_DESK_HOST_EVENT,
      expect.objectContaining({
        instanceId: 'node-22',
        message: expect.objectContaining({ type: 'storyai:director-desk-session' }),
      }),
    );
  });

  it('marks the previous node as closed when the shared window switches instances', async () => {
    const node14 = vi.fn();
    const un14 = subscribeDirectorDeskWindow('node-14', node14);
    await openDirectorDeskWindow({ instanceId: 'node-14', theme: 'dark' });
    tauriMocks.existingWindow = tauriMocks.created[0] ?? null;

    await openDirectorDeskWindow({ instanceId: 'node-22', theme: 'dark' });

    expect(node14).toHaveBeenCalledWith({ type: 'storyai:director-desk-close' });
    expect(tauriMocks.existingWindow?.close).not.toHaveBeenCalled();
    un14();
  });

  it('delivers messages only to subscribers of the matching instance', async () => {
    const node14 = vi.fn();
    const node22 = vi.fn();
    const un14 = subscribeDirectorDeskWindow('node-14', node14);
    const un22 = subscribeDirectorDeskWindow('node-22', node22);
    await openDirectorDeskWindow({ instanceId: 'node-14' });
    await vi.waitFor(() => expect(tauriMocks.eventHandler).not.toBeNull());

    expect(DIRECTOR_DESK_MESSAGE_EVENT).toBe('director-desk:message');
    tauriMocks.eventHandler?.({
      payload: {
        instanceId: 'node-14',
        message: { type: 'storyai:director-desk-ready' },
      },
    });

    expect(node14).toHaveBeenCalledOnce();
    expect(node22).not.toHaveBeenCalled();
    un14();
    un22();
  });

  it('correlates an extension response by request id', async () => {
    await openDirectorDeskWindow({ instanceId: 'node-14' });
    tauriMocks.emitTo.mockClear();
    const request = requestDirectorWindowAction('node-14', 'project.get');
    await vi.waitFor(() => expect(tauriMocks.emitTo).toHaveBeenCalled());
    const emittedCalls = tauriMocks.emitTo.mock.calls as unknown as Array<[
      string,
      string,
      unknown,
    ]>;
    const envelope = emittedCalls.at(-1)?.[2] as {
      message?: { payload?: { requestId?: string } };
    };
    const requestId = envelope.message?.payload?.requestId;

    tauriMocks.eventHandler?.({
      payload: {
        instanceId: 'node-14',
        message: {
          type: 'storyai:director-desk:response',
          payload: { requestId, ok: true, data: { version: 1 } },
        },
      },
    });

    await expect(request).resolves.toEqual({ version: 1 });
  });

  it('drops late captures and rejects pending requests after same-id restore changes the epoch', async () => {
    const received = vi.fn();
    subscribeDirectorDeskWindow('node-14', received);
    await openDirectorDeskWindow({ instanceId: 'node-14' });
    const pending = requestDirectorWindowAction('node-14', 'project.get');
    const rejected = expect(pending).rejects.toThrow('上下文');
    await vi.waitFor(() => expect(tauriMocks.emitTo).toHaveBeenCalled());
    tauriMocks.exchangeEpoch += 1;
    tauriMocks.eventHandler?.({ payload: { instanceId: 'node-14', message: { type: 'storyai:director-desk-captures-sent', payload: { captures: [] } } } });
    await rejected;
    expect(received).not.toHaveBeenCalled();
    await expect(requestDirectorWindowAction('node-14', 'project.get')).rejects.toThrow('失效');
  });

  it('does not resurrect an old window lease after switching away and back to the same IDs', async () => {
    await openDirectorDeskWindow({ instanceId: 'node-14' });
    tauriMocks.projectId = 'project-b';
    for (const listener of tauriMocks.subscribers) listener();
    tauriMocks.projectId = 'project-a';
    for (const listener of tauriMocks.subscribers) listener();
    await expect(requestDirectorWindowAction('node-14', 'project.get')).rejects.toThrow('失效');
  });
});

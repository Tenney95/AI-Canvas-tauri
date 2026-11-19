import type { ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScriptWorkbenchDispatch, ScriptWorkbenchSnapshot } from '../../src/types/scriptWorkbench';

const driver = vi.hoisted(() => ({
  receive: undefined as ((snapshot: ScriptWorkbenchSnapshot) => void) | undefined,
  close: undefined as ((event: { preventDefault: () => void }) => void) | undefined,
  connect: vi.fn(), request: vi.fn(), dispose: vi.fn(), onClose: vi.fn(), stopClose: vi.fn(),
}));
const values: unknown[] = [];
const effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }> = [];
const pending: Array<() => void> = [];
let cursor = 0, effectCursor = 0;
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: <T,>(initial: T | (() => T)) => {
    const index = cursor++;
    if (!(index in values)) values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [values[index], (next: T | ((previous: T) => T)) => {
      values[index] = typeof next === 'function' ? (next as (previous: T) => T)(values[index] as T) : next;
    }];
  },
  useRef: <T,>(initial: T) => values[cursor++] ??= { current: initial },
  useCallback: <T,>(callback: T) => values[cursor++] ??= callback,
  useEffect: (setup: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = effectCursor++;
    const previous = effects[index];
    if (previous && deps?.length === previous.deps?.length && deps?.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
    pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: setup() ?? undefined }; });
  },
}));
vi.mock('../../src/components/ScriptWorkbench', () => ({ ScriptWorkbenchView: 'workbench-view' }));
vi.mock('../../src/i18n', () => ({ useT: () => (key: string) => key, setLocale: vi.fn() }));
vi.mock('../../src/services/scriptWorkbenchWindowService', () => ({ connectScriptWorkbenchWindow: driver.connect }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: driver.onClose }) }));

import ScriptWorkbenchWindow from '../../src/components/ScriptWorkbenchWindow';

function render() {
  cursor = effectCursor = 0;
  const tree = ScriptWorkbenchWindow() as ReactElement<Record<string, unknown>>;
  pending.splice(0).forEach((effect) => effect());
  return tree;
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); }
beforeEach(() => {
  values.length = effects.length = pending.length = 0;
  driver.receive = driver.close = undefined;
  driver.request.mockReset().mockResolvedValue(true);
  driver.dispose.mockReset(); driver.stopClose.mockReset();
  driver.connect.mockReset().mockImplementation(async (_session, receive) => {
    driver.receive = receive;
    return { request: driver.request, handoff: vi.fn(), dispose: driver.dispose };
  });
  driver.onClose.mockReset().mockImplementation(async (close) => { driver.close = close; return driver.stopClose; });
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    location: { search: '?session=session-close-test&windowSession=window-close-test' },
  }));
});
afterEach(() => { effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

it('宿主未发首帧时不拦截系统关闭按钮，不依赖宿主回应才能退出', async () => {
  expect(render().props.children).toBe('正在连接主窗口…');
  await settle(); render();
  expect(driver.connect).toHaveBeenCalledTimes(1);
  expect(driver.onClose).not.toHaveBeenCalled();
  expect(driver.request).not.toHaveBeenCalled();
});

it('首帧到达后恢复关闭握手，不直接丢弃已载入的草稿', async () => {
  render(); await settle();
  driver.receive!({ sessionId: 'session-close-test', revision: 1, acceptedEditSequence: 0,
    currentEpisode: { id: 'episode' }, isDirty: true, pendingAction: null } as ScriptWorkbenchSnapshot);
  render(); await settle();
  const preventDefault = vi.fn();
  driver.close!({ preventDefault });
  await settle();
  expect(preventDefault).toHaveBeenCalledTimes(1);
  expect(driver.request).toHaveBeenCalledWith(expect.objectContaining({ episodeId: 'episode', action: { type: 'close' } }));
});

it('应用退出用当前窗口会话交接最后一次编辑，同一请求只处理一次，等待确认后恢复交互', async () => {
  render(); await settle();
  const snapshot = { sessionId: 'session-close-test', revision: 1, acceptedEditSequence: 0,
    currentEpisode: { id: 'episode' }, pendingAction: null, contextReady: true,
    windowContext: { schemaVersion: 2, canvas: null, target: { schemaVersion: 2, kind: 'episode', modelGeneration: 1,
      projectId: 'project', projectEpoch: 1, episodeId: 'episode', episodeRevision: 0 } },
    draft: { outline: '旧稿', script: '', creative: {} } } as ScriptWorkbenchSnapshot;
  driver.receive!(snapshot);
  const dispatch = render().props.dispatch as ScriptWorkbenchDispatch;
  await dispatch({ type: 'edit_text', field: 'outline', value: '最后一次编辑' });

  let answer!: (value: boolean) => void;
  driver.request.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
  driver.receive!({ ...snapshot, revision: 2, appCloseRequestId: 'app-close-1' });
  render();
  expect(render().props.closingWindow).toBe(true);
  expect(driver.request).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2, episodeId: 'episode',
    action: { type: 'close', appCloseRequestId: 'app-close-1' },
    handoff: expect.objectContaining({ episodeId: 'episode', sequence: 1, draft: { ...snapshot.draft, outline: '最后一次编辑' } }),
  }));

  answer(false);
  await settle();
  driver.receive!({ ...snapshot, revision: 3, appCloseRequestId: 'app-close-1', pendingAction: { type: 'close' } });
  expect(render().props.closingWindow).toBe(false);
  expect(driver.request).toHaveBeenCalledTimes(2);
});

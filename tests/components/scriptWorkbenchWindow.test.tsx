import type { ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScriptWorkbenchSnapshot } from '../../src/types/scriptWorkbench';

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

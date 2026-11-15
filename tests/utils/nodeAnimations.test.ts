/** Exit cleanup belongs to captured DOM elements, including cancelled canvas deletions. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playNodeExit, waitForPendingNodeExits } from '../../src/utils/nodeAnimations';

function inner() {
  const classes = new Set<string>();
  return { classes, classList: {
    add: vi.fn((name: string) => { classes.add(name); }),
    remove: vi.fn((name: string) => { classes.delete(name); }),
  } };
}
let timers: Array<{ finish: () => void; delay: number }>;

beforeEach(() => {
  timers = [];
  vi.stubGlobal('setTimeout', (finish: () => void, delay: number) => { timers.push({ finish, delay }); return timers.length; });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});

afterEach(async () => {
  for (const timer of timers) timer.finish();
  await waitForPendingNodeExits();
  vi.unstubAllGlobals();
});

function installDom(elements: Map<string, ReturnType<typeof inner>>) {
  const querySelector = vi.fn((selector: string) => {
    const element = elements.get(/data-id="([^"]+)"/.exec(selector)?.[1] ?? '');
    return element ? { querySelector: () => element } : null;
  });
  vi.stubGlobal('document', { querySelector });
  return querySelector;
}

describe('node exit element lifecycle', () => {
  it('cleans captured elements after 130ms before the caller deletion callback and pending wait complete', async () => {
    const element = inner();
    installDom(new Map([['a', element]]));
    const exit = playNodeExit(['a', 'a']);
    let callerSawExiting: boolean | undefined;
    void exit.then(() => { callerSawExiting = element.classes.has('node-exiting'); });
    const pending = waitForPendingNodeExits();
    expect(element.classes.has('node-exiting')).toBe(true);
    expect(timers.map((timer) => timer.delay)).toEqual([130]);
    timers[0].finish();
    await pending;
    expect(callerSawExiting).toBe(false);
    expect(element.classes.has('node-exiting')).toBe(false);
    expect(element.classList.remove).toHaveBeenCalledExactlyOnceWith('node-exiting');
  });

  it('keeps the exit class until the last overlapping operation on the same element finishes', async () => {
    const element = inner();
    installDom(new Map([['a', element]]));
    const first = playNodeExit(['a']);
    const second = playNodeExit(['a']);
    timers[0].finish(); await first;
    expect(element.classes.has('node-exiting')).toBe(true);
    expect(element.classList.remove).not.toHaveBeenCalled();
    timers[1].finish(); await second;
    expect(element.classes.has('node-exiting')).toBe(false);
    expect(element.classList.remove).toHaveBeenCalledExactlyOnceWith('node-exiting');
  });

  it.each(['old-first', 'new-first'])('cleans only the captured element when the same ID is remounted (%s)', async (order) => {
    const oldElement = inner(), replacement = inner();
    const elements = new Map([['a', oldElement]]);
    const query = installDom(elements);
    const oldExit = playNodeExit(['a']);
    elements.set('a', replacement);
    const newExit = playNodeExit(['a']);
    const first = order === 'old-first' ? 0 : 1, last = 1 - first;
    timers[first].finish(); await (first === 0 ? oldExit : newExit);
    expect((first === 0 ? oldElement : replacement).classes.has('node-exiting')).toBe(false);
    expect((last === 0 ? oldElement : replacement).classes.has('node-exiting')).toBe(true);
    timers[last].finish(); await (last === 0 ? oldExit : newExit);
    expect(oldElement.classes.has('node-exiting')).toBe(false);
    expect(replacement.classes.has('node-exiting')).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each(['no-document', 'missing-element', 'reduced-motion', 'empty-ids'])('resolves immediately without exit work for %s', async (mode) => {
    const element = inner();
    const query = installDom(new Map<string, ReturnType<typeof inner>>(mode === 'missing-element' ? [] : [['a', element]]));
    if (mode === 'no-document') vi.stubGlobal('document', undefined);
    if (mode === 'reduced-motion') vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    await expect(playNodeExit(mode === 'empty-ids' ? [] : ['a'])).resolves.toBeUndefined();
    expect(timers).toEqual([]);
    expect(element.classList.add).not.toHaveBeenCalled();
    if (mode !== 'missing-element') expect(query).not.toHaveBeenCalled();
  });
});

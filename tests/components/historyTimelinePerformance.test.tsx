/**
 * historyTimelinePerformance — 回归测试：history panel subscriptions。
 */
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistorySnapshotLike } from '../../src/utils/historyOperationLabels';

const driver = vi.hoisted(() => ({
  values: [true, false], index: 0,
  memos: [] as Array<{ value: unknown; deps: readonly unknown[] }>, memoIndex: 0,
  translate: (text: string) => text,
  describeChange: vi.fn(),
  selectors: [] as Array<(state: unknown) => unknown>,
  state: {
    history: [] as HistorySnapshotLike[], historyIndex: -1,
    nodes: [] as HistorySnapshotLike['nodes'], edges: [], groups: [],
    undo: vi.fn(), redo: vi.fn(), updateConfig: vi.fn(), saveConfig: vi.fn(),
    config: { canvasHistoryPinned: false }, chatOpen: false, chatPanelDetached: false,
  },
}));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useState: () => {
    const index = driver.index++;
    return [driver.values[index], (value: boolean | ((previous: boolean) => boolean)) => {
      driver.values[index] = typeof value === 'function' ? value(driver.values[index]) : value;
    }];
  },
  useRef: () => ({ current: null }), useEffect: () => {},
  useMemo: (compute: () => unknown, deps: readonly unknown[]) => {
    const index = driver.memoIndex++;
    const previous = driver.memos[index];
    if (!previous || deps.length !== previous.deps.length || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      driver.memos[index] = { value: compute(), deps };
    }
    return driver.memos[index].value;
  },
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: (selector: unknown) => selector }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: (selector: (state: unknown) => unknown) => {
  driver.selectors.push(selector);
  return selector(driver.state);
} }));
vi.mock('../../src/utils/historyOperationLabels', () => ({ describeCanvasChange: driver.describeChange }));
vi.mock('../../src/i18n', () => ({ useT: () => driver.translate }));
vi.mock('../../src/components/shared/AnimatedButton', () => ({ default: 'button' }));
import HistoryTimelinePanel from '../../src/components/canvas/HistoryTimelinePanel';

function render(nodesDragging = false) {
  driver.index = 0;
  driver.memoIndex = 0;
  driver.selectors = [];
  return HistoryTimelinePanel({ nodesDragging }) as ReactElement<{ onPointerEnter: () => void; 'data-open': string }>;
}

beforeEach(() => {
  driver.values = [true, false];
  driver.memos = [];
  driver.translate = (text) => text;
  driver.state.history = [
    { nodes: [], edges: [], groups: [] },
    { nodes: [{ id: 'one', position: { x: 0, y: 0 }, data: { type: 'ai-text', label: 'One' } }], edges: [], groups: [] },
  ];
  driver.state.historyIndex = 1;
  driver.state.nodes = [{ ...driver.state.history[1].nodes[0], position: { x: 20, y: 10 } }];
  driver.state.config.canvasHistoryPinned = false;
  driver.describeChange.mockReset().mockReturnValue({ title: '移动节点', icon: 'mdi:arrow' });
});

describe('history panel subscriptions', () => {
  it('does no snapshot comparison or live graph reads while hidden, then opens with fresh state', () => {
    const panel = render();
    expect(panel.props['data-open']).toBe('false');
    expect(driver.describeChange).not.toHaveBeenCalled();
    const guarded = { ...driver.state };
    for (const key of ['nodes', 'edges', 'groups']) {
      Object.defineProperty(guarded, key, { get: () => { throw new Error('Hidden panel read live graph'); } });
    }
    for (const selector of driver.selectors) expect(() => selector(guarded)).not.toThrow();
    driver.state.nodes = [{ ...driver.state.nodes[0], position: { x: 99, y: 10 } }];
    panel.props.onPointerEnter();
    expect(render().props['data-open']).toBe('true');
    expect(driver.describeChange).toHaveBeenCalledTimes(2);
    expect(driver.describeChange.mock.calls[1][1].nodes[0].position.x).toBe(99);
  });

  it('updates pinned history and stops scanning when its rows are collapsed', () => {
    driver.state.config.canvasHistoryPinned = true;
    render();
    expect(driver.describeChange).toHaveBeenCalledTimes(2);
    driver.values[0] = false;
    driver.describeChange.mockClear();
    render();
    expect(driver.describeChange).not.toHaveBeenCalled();
    expect(driver.selectors.at(-1)?.(driver.state)).toBeNull();
  });

  it('compares committed steps without tracking the live graph at an older undo position', () => {
    driver.state.config.canvasHistoryPinned = true;
    driver.state.historyIndex = 0;
    render();
    expect(driver.describeChange).toHaveBeenCalledOnce();
    expect(driver.selectors.at(-1)?.(driver.state)).toBeNull();
  });

  it('skips intermediate drag positions and reads the final graph on release', () => {
    driver.state.config.canvasHistoryPinned = true;
    render();
    driver.describeChange.mockClear();
    for (const x of [30, 60, 90]) {
      driver.state.nodes = [{ ...driver.state.nodes[0], position: { x, y: 10 } }];
      render(true);
      expect(driver.selectors.at(-1)?.(driver.state)).toBeNull();
    }
    expect(driver.describeChange).not.toHaveBeenCalled();
    render(false);
    expect(driver.describeChange).toHaveBeenCalledOnce();
    expect(driver.describeChange.mock.calls[0][1].nodes[0].position.x).toBe(90);
  });

  it('reuses unchanged pairs after append and eviction, and refreshes branches and translations', () => {
    driver.state.config.canvasHistoryPinned = true;
    driver.state.historyIndex = 0;
    render();
    const [first, second] = driver.state.history;
    const third = { nodes: driver.state.nodes, edges: [], groups: [] };
    driver.describeChange.mockClear();
    driver.state.history = [first, second, third];
    render();
    expect(driver.describeChange).toHaveBeenCalledOnce();
    expect(driver.describeChange).toHaveBeenCalledWith(second, third, driver.translate);

    driver.describeChange.mockClear();
    driver.state.history = [second, third];
    render();
    expect(driver.describeChange).not.toHaveBeenCalled();

    const branch = { ...third };
    driver.state.history = [second, branch];
    render();
    expect(driver.describeChange).toHaveBeenCalledOnce();
    expect(driver.describeChange).toHaveBeenCalledWith(second, branch, driver.translate);
    driver.describeChange.mockClear();
    driver.translate = (text) => 'en:' + text;
    render();
    expect(driver.describeChange).toHaveBeenCalledOnce();
    expect(driver.describeChange).toHaveBeenCalledWith(second, branch, driver.translate);
  });
});

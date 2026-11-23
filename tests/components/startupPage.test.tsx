/**
 * startupPage — 回归测试：project startup page。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';

interface Element { type: unknown; props: Record<string, unknown> & { children?: unknown } }
const driver = vi.hoisted(() => ({
  state: {} as AppState,
  values: [] as unknown[], index: 0,
  effects: [] as Array<() => void | (() => void)>,
  nativeWindow: null as null | {
    isFocused: () => Promise<boolean>;
    onFocusChanged: (listener: (event: { payload: boolean }) => unknown) => Promise<() => void>;
  },
  nativeShortcuts: new Map<string, (event: { state?: string }) => void>(),
  rejectNativeResourceSearch: false,
}));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const index = driver.index++;
    if (!(index in driver.values)) driver.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [driver.values[index], (next: T) => { driver.values[index] = next; }];
  },
  useMemo: <T,>(factory: () => T) => factory(),
  useRef: <T,>(value: T) => ({ current: value }),
  useEffect: (effect: () => void | (() => void)) => { driver.effects.push(effect); },
  useLayoutEffect: (effect: () => void | (() => void)) => { driver.effects.push(effect); },
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));
vi.mock('framer-motion', () => ({ motion: { div: 'div', button: 'motion-button' } }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((selector: (state: AppState) => unknown) => selector(driver.state), {
    getState: () => driver.state,
    setState: (patch: Partial<AppState>) => { Object.assign(driver.state, patch); },
  }),
}));
vi.mock('../../src/i18n', () => ({
  useT: () => (text: string, vars?: Record<string, string | number>) => (
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars?.[key] ?? key))
  ),
}));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: 'modal-overlay' }));
vi.mock('../../src/components/shared/PopupCloseButton', () => ({ default: 'close-button' }));
vi.mock('../../src/components/shared/Select', () => ({ default: 'select-control' }));
vi.mock('../../src/components/assets/RecentAssetsSection', () => ({ default: 'recent-assets-section' }));
vi.mock('../../src/services/fileService', () => ({}));
vi.mock('../../src/utils/assetSearchWindow', () => ({ openAssetSearchWindow: vi.fn() }));
vi.mock('../../src/utils/nodeAnimations', () => ({ playNodeExit: vi.fn() }));
vi.mock('../../src/services/pollManager', () => ({ cancelNodePolling: vi.fn() }));
vi.mock('../../src/services/canvasPointerService', () => ({ getCanvasPointerPosition: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => {
  if (driver.nativeWindow) return driver.nativeWindow;
  throw new Error('Web test');
} }));
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  register: vi.fn(async (key: string, callback: (event: { state?: string }) => void) => {
    if (key === 'Ctrl+Shift+Space' && driver.rejectNativeResourceSearch) throw new Error('Shortcut unavailable');
    driver.nativeShortcuts.set(key, callback);
  }),
  unregister: vi.fn(async (key: string) => { driver.nativeShortcuts.delete(key); }),
  unregisterAll: vi.fn(async () => { driver.nativeShortcuts.clear(); }),
}));

import ProjectLibraryModal from '../../src/components/ProjectLibraryModal';
import { rememberOpenedSeriesEpisode } from '../../src/store/store.utils';
import Header from '../../src/components/Header';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { openAssetSearchWindow } from '../../src/utils/assetSearchWindow';

const onClose = vi.fn();
function render(page = true, isOpen = true) {
  driver.index = 0;
  driver.effects = [];
  return ProjectLibraryModal({ isOpen, onClose, presentation: page ? 'page' : 'modal' }) as Element;
}
function findAll(tree: unknown, predicate: (element: Element) => boolean): Element[] {
  if (Array.isArray(tree)) return tree.flatMap((element) => findAll(element, predicate));
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as Element;
  return [...(predicate(element) ? [element] : []), ...findAll(element.props.children, predicate)];
}
function find(tree: Element, predicate: (element: Element) => boolean) {
  const element = findAll(tree, predicate)[0];
  expect(element).toBeDefined();
  return element;
}
function button(tree: Element, label: string) {
  const text = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(text).join('');
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'props' in value) return text((value as Element).props.children);
    return '';
  };
  return find(tree, (element) => element.type === 'button'
    && (text(element.props.children) === label || element.props['aria-label'] === label));
}
async function click(element: Element) {
  await (element.props.onClick as () => unknown)();
}

beforeEach(() => {
  vi.clearAllMocks();
  driver.values = [];
  driver.effects = [];
  driver.nativeWindow = null;
  driver.nativeShortcuts.clear();
  driver.rejectNativeResourceSearch = false;
  driver.state = {
    projects: [{ id: 'p1', name: '示例项目', createdAt: 1, updatedAt: 2 }],
    currentProjectId: null, projectLoadStatus: 'ready', isCreatingProject: false,
    projectWorkspaceView: 'canvas',
    scriptWorkbenchOpenProjectId: null,
    setProjectWorkspaceView: vi.fn(), requestScriptWorkbenchOpen: vi.fn(),
    isReturningToStartPage: false, switchingProjectName: null,
    returnToStartPage: vi.fn(async () => true),
    createProject: vi.fn(async () => undefined),
    switchProject: vi.fn(async () => undefined),
    importProject: vi.fn(async () => undefined),
    setSettingsOpen: vi.fn(), showToast: vi.fn(), initFromDb: vi.fn(async () => undefined),
    selectedNodeIds: [], clipboard: { nodes: [{ id: 'copied' }], groups: [], projectId: 'p1' },
    addNode: vi.fn(), pasteNodes: vi.fn(), undo: vi.fn(), redo: vi.fn(),
    deleteSelectedCanvasElements: vi.fn(), saveCurrentProject: vi.fn(),
  } as unknown as AppState;
});

describe('project startup page', () => {
  it('shows the project list as a page with settings and no modal close button', () => {
    const tree = render();
    expect(tree.type).toBe('section');
    expect(tree.props['aria-label']).toBe('启动页');
    expect(findAll(tree, (element) => element.type === 'modal-overlay' || element.type === 'close-button')).toHaveLength(0);
    expect(findAll(tree, (element) => element.props['data-project-library-card'] !== undefined)).toHaveLength(1);
    expect(button(tree, '设置')).toBeDefined();
    (tree.props.onKeyDown as (event: unknown) => void)({ key: 'Escape', defaultPrevented: false });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens settings without selecting a project', async () => {
    const tree = render();
    const settings = find(tree, (element) => element.type === 'button'
      && Array.isArray(element.props.children) && element.props.children.includes('设置'));
    await click(settings);
    expect(driver.state.setSettingsOpen).toHaveBeenCalledWith(true);
    expect(driver.state.currentProjectId).toBeNull();
  });

  it('macOS 端启动页隐藏应用名称与图标，非 macOS 端保留显示', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
    let tree = render();
    expect(findAll(tree, (element) => element.props?.children === 'AI Canvas')).toHaveLength(0);
    expect(button(tree, '设置')).toBeDefined();

    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    tree = render();
    expect(findAll(tree, (element) => element.props?.children === 'AI Canvas')).toHaveLength(1);
    expect(button(tree, '设置')).toBeDefined();
    vi.unstubAllGlobals();
  });

  it('进入资源库整页时隐藏启动页，返回后保留项目搜索条件', () => {
    let tree = render();
    const search = find(tree, (element) => element.type === 'input' && element.props.placeholder === '搜索项目');
    (search.props.onChange as (event: unknown) => void)({ target: { value: '示例' } });
    driver.state = { ...driver.state, assetsPanelOpen: true, assetsPanelMode: 'page' };
    tree = render();
    expect(tree.props.hidden).toBe(true);
    driver.state = { ...driver.state, assetsPanelOpen: false, assetsPanelMode: 'modal' };
    tree = render();
    expect(tree.props.hidden).toBe(false);
    expect(find(tree, (element) => element.type === 'input' && element.props.placeholder === '搜索项目').props.value).toBe('示例');
    expect(driver.state.currentProjectId).toBeNull();
  });

  it('waits for project loading and closes only after the selected project is ready', async () => {
    let finish: ((id: string) => void) | undefined;
    driver.state.switchProject = vi.fn(() => new Promise<string | undefined>((resolve) => { finish = resolve; }));
    const pending = click(button(render(), '打开项目 示例项目'));
    expect(onClose).not.toHaveBeenCalled();
    expect(button(render(), '打开项目 示例项目').props.disabled).toBe(true);
    driver.state.currentProjectId = 'p1';
    finish?.('p1');
    await pending;
    expect(onClose).toHaveBeenCalledOnce();
    expect(driver.state.switchProject).toHaveBeenCalledWith('p1', { captureSnapshot: false });
  });

  it.each(['missing', 'exception'])('stays on the list when opening fails: %s', async (failure) => {
    if (failure === 'exception') driver.state.switchProject = vi.fn(async () => { throw new Error('private detail'); });
    await click(button(render(), '打开项目 示例项目'));
    expect(onClose).not.toHaveBeenCalled();
    expect(driver.state.currentProjectId).toBeNull();
    expect(button(render(), '打开项目 示例项目').props.disabled).toBe(false);
    if (failure === 'exception') expect(driver.state.showToast).toHaveBeenCalledWith('项目打开失败，请重试', 'error');
  });

  it('creates a project only after an explicit name submission', async () => {
    driver.state.createProject = vi.fn(async () => { driver.state.currentProjectId = 'created'; return 'created'; });
    await click(button(render(), '新建项目'));
    let tree = render();
    const input = find(tree, (element) => element.type === 'input' && element.props.placeholder === '输入项目名称');
    (input.props.onChange as (event: unknown) => void)({ target: { value: '新作品' } });
    tree = render();
    await (find(tree, (element) => element.type === 'form').props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault: vi.fn() });
    expect(driver.state.createProject).toHaveBeenCalledWith('新作品');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the page after cancelled import and closes after successful import', async () => {
    await click(find(render(), (element) => element.type === 'button'
      && Array.isArray(element.props.children) && element.props.children.includes('导入')));
    expect(onClose).not.toHaveBeenCalled();
    const cancelled = find(render(), (element) => typeof element.props.onImported === 'function');
    (cancelled.props.onClose as () => void)();
    expect(onClose).not.toHaveBeenCalled();
    expect(findAll(render(), (element) => typeof element.props.onImported === 'function')).toHaveLength(0);
    await click(find(render(), (element) => element.type === 'button'
      && Array.isArray(element.props.children) && element.props.children.includes('导入')));
    (find(render(), (element) => typeof element.props.onImported === 'function').props.onImported as () => void)();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('读取旧项目列表失败时可以重试，也可以直接新建项目', async () => {
    driver.state.projectLoadStatus = 'error';
    driver.state.projects = [];
    driver.state.createProject = vi.fn(async () => 'new-project');
    const tree = render();
    await click(button(tree, '重试'));
    expect(driver.state.initFromDb).toHaveBeenCalledOnce();

    const create = button(render(), '新建项目');
    expect(create.props.disabled).toBeFalsy();
    await click(create);
    const input = find(render(), (element) => element.type === 'input' && element.props.placeholder === '输入项目名称');
    (input.props.onChange as (event: unknown) => void)({ target: { value: '新作品' } });
    const form = find(render(), (element) => element.type === 'form');
    await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault: vi.fn() });
    expect(driver.state.createProject).toHaveBeenCalledWith('新作品');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ['p1', 'ready'],
    ['default', 'error'],
  ] as const)('只有一张默认画布卡片时，按钮和菜单都能确认删除（%s）', async (id, status) => {
    driver.state.projects = [{ id, name: '默认画布', createdAt: 1, updatedAt: 2 }];
    driver.state.projectLoadStatus = status;
    driver.state.deleteProject = vi.fn(async () => undefined);
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 700 });
    vi.stubGlobal('document', { body: {} });
    try {
      const trash = button(render(), '删除项目 默认画布');
      expect(trash.props.disabled).toBeFalsy();
      await click(trash);
      const dialog = find(render(), (element) => element.props.role === 'alertdialog');
      expect(driver.state.deleteProject).not.toHaveBeenCalled();
      if (id === 'default') {
        expect(find(dialog, (element) => element.props.id === 'delete-project-description').props.children)
          .toBe('这张卡片是加载项目列表时显示的占位项。确认后会从当前列表移除，本地项目和素材都会保留。');
      }
      await click(button(dialog, '取消'));
      expect(driver.state.deleteProject).not.toHaveBeenCalled();
      expect(findAll(render(), (element) => element.props.role === 'alertdialog')).toHaveLength(0);

      const card = find(render(), (element) => typeof element.props.onContextMenu === 'function'
        && typeof element.props.className === 'string' && element.props.className.startsWith('group '));
      (card.props.onContextMenu as (event: unknown) => void)({ preventDefault: vi.fn(), clientX: 10, clientY: 20 });
      const menuDelete = find(render(), (element) => element.props.label === '删除项目');
      expect(menuDelete.props.disabled).toBeFalsy();
      await click(menuDelete);
      expect(driver.state.deleteProject).not.toHaveBeenCalled();
      await click(button(render(), '确认删除'));
      expect(driver.state.deleteProject).toHaveBeenCalledOnce();
      expect(driver.state.deleteProject).toHaveBeenCalledWith(id);
    } finally { vi.unstubAllGlobals(); }
  });

  it('lets users select another project when the last canvas failed but the list is available', async () => {
    driver.state.projectLoadStatus = 'error';
    driver.state.switchProject = vi.fn(async () => {
      driver.state.currentProjectId = 'p1';
      driver.state.projectLoadStatus = 'ready';
      return 'p1';
    });
    await click(button(render(), '打开项目 示例项目'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the existing project management modal for canvas sessions', () => {
    const tree = render(false);
    expect(tree.type).toBe('modal-overlay');
    expect(findAll(tree, (element) => element.type === 'close-button')).toHaveLength(1);
    (tree.props.onClose as () => void)();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the current episode when reopening its series from the canvas modal', async () => {
    driver.state.projects = [
      { id: 'series', name: '剧集', createdAt: 1, updatedAt: 1 },
      { id: 'ep1', name: '第一集', parentId: 'series', episodeNo: 1, createdAt: 1, updatedAt: 1 },
      { id: 'ep2', name: '第二集', parentId: 'series', episodeNo: 2, createdAt: 1, updatedAt: 1 },
    ];
    driver.state.currentProjectId = 'ep2';
    await click(button(render(false), '打开项目 剧集'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(driver.state.switchProject).not.toHaveBeenCalled();
    expect(driver.state.currentProjectId).toBe('ep2');
  });

  const series = { id: 'series', name: '剧集', createdAt: 1, updatedAt: 1 };
  const first = { ...series, id: 'ep1', name: '第一集', parentId: series.id, episodeNo: 1, snapshot: 'first-cover' };
  const second = { ...first, id: 'ep2', name: '第二集', episodeNo: 2, snapshot: 'second-cover' };

  it('skips episode preference reads while the project list is hidden', () => {
    driver.state.projects = [series, first, second];
    const read = vi.spyOn(localStorage, 'getItem');
    try {
      render(false, false);
      driver.state = { ...driver.state, assetsPanelOpen: true, assetsPanelMode: 'page' };
      render();
      expect(read).not.toHaveBeenCalledWith('ai-canvas.last-episode.v1:' + series.id);
    } finally { read.mockRestore(); }
  });

  it.each([true, false])('opens the remembered episode and shows its cover (startup page: %s)', async (page) => {
    driver.state.projects = [series, first, second];
    rememberOpenedSeriesEpisode(second);
    driver.state.switchProject = vi.fn(async (id) => { driver.state.currentProjectId = id; return id; });
    const tree = render(page);
    expect(find(tree, (element) => element.props.snapshot === second.snapshot)).toBeDefined();
    await click(button(tree, '打开项目 剧集'));
    expect(driver.state.switchProject).toHaveBeenCalledWith(second.id, { captureSnapshot: !page });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(['deleted', 'moved', 'unavailable'])('falls back to the first remaining episode: %s', async (reason) => {
    rememberOpenedSeriesEpisode(second);
    driver.state.projects = [series, first];
    if (reason === 'moved') driver.state.projects.push({ ...second, parentId: 'another-series' });
    if (reason === 'unavailable') driver.state.projects.push(second);
    const read = reason === 'unavailable' ? vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error(); }) : undefined;
    try {
      await click(button(render(), '打开项目 剧集'));
      expect(driver.state.switchProject).toHaveBeenCalledWith(first.id, { captureSnapshot: false });
    } finally { read?.mockRestore(); }
  });

  it.each(['ready', 'readonly', 'error'] as const)('opens the workbench only for a writable, confirmed episode: %s', async (status) => {
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 700 });
    vi.stubGlobal('document', { body: {} });
    try {
      driver.state.projects = [series, first, second];
      rememberOpenedSeriesEpisode(second);
      driver.state.switchProject = vi.fn(async (id) => {
        driver.state.currentProjectId = id;
        driver.state.projectLoadStatus = status;
        return status === 'error' ? undefined : id;
      });
      const card = find(render(), (element) => typeof element.props.onContextMenu === 'function'
        && typeof element.props.className === 'string' && element.props.className.startsWith('group '));
      (card.props.onContextMenu as (event: unknown) => void)({ preventDefault: vi.fn(), clientX: 10, clientY: 20 });
      await click(find(render(), (element) => element.props.label === '打开剧本创作工作台'));
      expect(driver.state.switchProject).toHaveBeenCalledWith(second.id, { captureSnapshot: false });
      if (status === 'ready') expect(driver.state.requestScriptWorkbenchOpen).toHaveBeenCalledWith(second.id);
      else expect(driver.state.requestScriptWorkbenchOpen).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(status === 'error' ? 0 : 1);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('启动页资源区', () => {
  it('只在启动页项目列表下方显示资源区，项目管理弹窗保持原有范围', () => {
    const main = find(render(), (element) => element.type === 'main');
    const children = main.props.children as Element[];
    expect(children.at(-1)?.type).toBe(Symbol.for('react.suspense'));
    expect(findAll(render(false), (element) => element.type === Symbol.for('react.suspense'))).toHaveLength(0);
  });
  it('新建项目仍是首张卡片，资源区不改变项目排序和搜索', () => {
    const grid = find(render(), (element) => typeof element.props.className === 'string'
      && element.props.className.includes('grid gap-3'));
    const first = (grid.props.children as Element[])[0];
    expect(first.type).toBe('button');
    expect(button(first, '新建项目')).toBe(first);
  });
});

describe('header startup page entry', () => {
  it('exposes an accessible logo button which calls the return action', async () => {
    await click(button(Header() as Element, '返回启动页'));
    expect(driver.state.returnToStartPage).toHaveBeenCalledOnce();
  });

  it.each(['returning', 'creating', 'switching'])('disables the logo while %s', (busy) => {
    driver.state.isReturningToStartPage = busy === 'returning';
    driver.state.isCreatingProject = busy === 'creating';
    driver.state.switchingProjectName = busy === 'switching' ? '另一个项目' : null;
    const label = busy === 'returning' ? '正在返回启动页' : '返回启动页';
    expect(button(Header() as Element, label).props.disabled).toBe(true);
  });
});

describe('startup page keyboard boundary', () => {
  it('剧本整页接管保存与编辑按键，切回画布后恢复画布保存', async () => {
    driver.state.currentProjectId = 'p1';
    driver.state.projectWorkspaceView = 'script';
    let keydown: ((event: unknown) => Promise<void>) | undefined;
    const dispatchEvent = vi.fn((_event: Event) => true);
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('document', {
      body: {}, documentElement: {}, querySelector: () => null,
      addEventListener: (_: string, handler: typeof keydown) => { keydown = handler; },
      removeEventListener: vi.fn(),
    });
    driver.effects = [];
    useKeyboardShortcuts();
    const cleanup = driver.effects[0]();
    const target = { tagName: 'DIV', closest: () => null };
    try {
      for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
        const event = { target, key: 's', ...modifiers, preventDefault: vi.fn(), stopPropagation: vi.fn() };
        await keydown?.(event);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
      }
      expect(dispatchEvent).toHaveBeenCalledTimes(3);
      expect(dispatchEvent.mock.calls.every(([event]) => event.type === 'script-workbench-save')).toBe(true);
      for (const key of [
        { key: 'Delete' }, { key: '1', code: 'Digit1' }, { key: 'v', ctrlKey: true },
        { key: 'z', ctrlKey: true }, { key: 'z', ctrlKey: true, shiftKey: true },
      ]) {
        const event = { target, ...key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
        await keydown?.(event);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopPropagation).not.toHaveBeenCalled();
      }
      expect(driver.state.addNode).not.toHaveBeenCalled();
      expect(driver.state.pasteNodes).not.toHaveBeenCalled();
      expect(driver.state.deleteSelectedCanvasElements).not.toHaveBeenCalled();
      expect(driver.state.undo).not.toHaveBeenCalled();
      expect(driver.state.redo).not.toHaveBeenCalled();
      expect(driver.state.saveCurrentProject).not.toHaveBeenCalled();

      driver.state.projectWorkspaceView = 'canvas';
      await keydown?.({ target, key: 's', ctrlKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() });
      expect(driver.state.saveCurrentProject).toHaveBeenCalledOnce();
      expect(dispatchEvent).toHaveBeenCalledTimes(3);
    } finally {
      cleanup?.();
      vi.unstubAllGlobals();
    }
  });

  it('原生保存快捷键读取当前页态，不误存画布并忽略松键回调', async () => {
    driver.state.currentProjectId = 'p1';
    driver.state.projectWorkspaceView = 'script';
    driver.nativeWindow = { isFocused: async () => true, onFocusChanged: async () => () => {} };
    const dispatchEvent = vi.fn((_event: Event) => true);
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    driver.effects = [];
    useKeyboardShortcuts();
    const cleanup = driver.effects[0]();
    try {
      await vi.waitFor(() => expect(driver.nativeShortcuts.has('Alt+S')).toBe(true));
      driver.nativeShortcuts.get('CommandOrControl+S')?.({ state: 'Pressed' });
      expect(dispatchEvent).toHaveBeenCalledOnce();
      expect(dispatchEvent.mock.calls[0][0].type).toBe('script-workbench-save');
      expect(driver.state.saveCurrentProject).not.toHaveBeenCalled();
      driver.nativeShortcuts.get('Alt+S')?.({ state: 'Released' });
      expect(dispatchEvent).toHaveBeenCalledOnce();
      driver.state.projectWorkspaceView = 'canvas';
      driver.nativeShortcuts.get('Alt+S')?.({ state: 'Pressed' });
      expect(driver.state.saveCurrentProject).toHaveBeenCalledOnce();
      expect(dispatchEvent).toHaveBeenCalledOnce();
    } finally {
      cleanup?.();
      vi.unstubAllGlobals();
    }
  });

  it('原生资源搜索只响应主窗口内的按下事件，Alt+Space 仍可在失焦时使用', async () => {
    let focused = true;
    let blockingDialog = false;
    let keydown: ((event: unknown) => Promise<void>) | undefined;
    let focusChanged: ((event: { payload: boolean }) => unknown) | undefined;
    const isFocused = vi.fn(async () => focused);
    driver.nativeWindow = {
      isFocused,
      onFocusChanged: async (listener) => { focusChanged = listener; return () => {}; },
    };
    vi.stubGlobal('document', {
      activeElement: { closest: () => null },
      querySelector: () => (blockingDialog ? {} : null),
      addEventListener: (_: string, listener: typeof keydown) => { keydown = listener; },
      removeEventListener: vi.fn(),
    });
    useKeyboardShortcuts();
    const cleanup = driver.effects[0]();
    try {
      await vi.waitFor(() => expect(driver.nativeShortcuts.has('Ctrl+Shift+Space')).toBe(true));
      const onSearch = driver.nativeShortcuts.get('Ctrl+Shift+Space')!;
      onSearch({ state: 'Pressed' });
      await vi.waitFor(() => expect(openAssetSearchWindow).toHaveBeenCalledOnce());

      onSearch({ state: 'Released' });
      await keydown?.({
        target: { tagName: 'DIV', closest: () => null }, key: ' ', code: 'Space', ctrlKey: true, shiftKey: true,
        preventDefault: vi.fn(), stopPropagation: vi.fn(),
      });
      expect(openAssetSearchWindow).toHaveBeenCalledOnce();

      blockingDialog = true;
      onSearch({ state: 'Pressed' });
      await Promise.resolve();
      expect(openAssetSearchWindow).toHaveBeenCalledOnce();
      blockingDialog = false;

      // The native focus query may report blur before the listener runs.
      focused = false;
      onSearch({ state: 'Pressed' });
      await Promise.resolve();
      expect(openAssetSearchWindow).toHaveBeenCalledOnce();
      await focusChanged?.({ payload: false });
      expect(driver.nativeShortcuts.has('Ctrl+Shift+Space')).toBe(false);
      onSearch({ state: 'Pressed' });
      expect(openAssetSearchWindow).toHaveBeenCalledOnce();
      driver.nativeShortcuts.get('Alt+Space')?.({ state: 'Pressed' });
      expect(openAssetSearchWindow).toHaveBeenCalledTimes(2);
    } finally {
      cleanup?.();
      vi.unstubAllGlobals();
    }
  });

  it('系统无法注册 Ctrl+Shift+Space 时保留 keydown 回退', async () => {
    driver.rejectNativeResourceSearch = true;
    driver.nativeWindow = { isFocused: async () => true, onFocusChanged: async () => () => {} };
    let keydown: ((event: unknown) => Promise<void>) | undefined;
    vi.stubGlobal('document', {
      querySelector: () => null,
      addEventListener: (_: string, listener: typeof keydown) => { keydown = listener; },
      removeEventListener: vi.fn(),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useKeyboardShortcuts();
    const cleanup = driver.effects[0]();
    try {
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[shortcut] 注册失败: Ctrl+Shift+Space', expect.any(Error)));
      await keydown?.({
        target: { tagName: 'DIV', closest: () => null }, key: ' ', code: 'Space', ctrlKey: true, shiftKey: true,
        preventDefault: vi.fn(), stopPropagation: vi.fn(),
      });
      expect(openAssetSearchWindow).toHaveBeenCalledOnce();
    } finally {
      cleanup?.();
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it.each([null, 'p1'])('lets the active dialog own keyboard input in project %s', async (projectId) => {
    driver.state.currentProjectId = projectId;
    let keydown: ((event: unknown) => Promise<void>) | undefined;
    vi.stubGlobal('document', {
      body: {}, documentElement: {}, querySelector: () => ({}),
      addEventListener: (_: string, handler: typeof keydown) => { keydown = handler; },
      removeEventListener: vi.fn(),
    });
    driver.effects = [];
    useKeyboardShortcuts();
    const cleanup = driver.effects[0]();
    const target = { tagName: 'BUTTON', closest: () => null };
    try {
      for (const key of ['Escape', 'Tab', ' ', 'Delete', '1', 'z']) {
        const event = { target, key, code: key === ' ' ? 'Space' : 'Digit1', ctrlKey: key === 'z',
          preventDefault: vi.fn(), stopPropagation: vi.fn() };
        await keydown?.(event);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopPropagation).not.toHaveBeenCalled();
      }
      expect(driver.state.setSettingsOpen).not.toHaveBeenCalled();
      expect(driver.state.addNode).not.toHaveBeenCalled();
      expect(driver.state.undo).not.toHaveBeenCalled();
      await keydown?.({ target, key: 's', ctrlKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() });
      expect(driver.state.saveCurrentProject).toHaveBeenCalledOnce();
    } finally {
      cleanup?.();
      vi.unstubAllGlobals();
    }
  });

  it('does not create, paste, or undo nodes before opening a project', async () => {
    let keydown: ((event: unknown) => Promise<void>) | undefined;
    vi.stubGlobal('document', {
      body: {}, documentElement: {}, querySelector: () => null,
      addEventListener: (_: string, handler: typeof keydown) => { keydown = handler; },
      removeEventListener: vi.fn(),
    });
    driver.effects = [];
    useKeyboardShortcuts();
    const cleanup = driver.effects[0]();
    const target = { tagName: 'DIV', closest: () => null };
    for (const key of [
      { key: '1', code: 'Digit1' },
      { key: 'v', code: 'KeyV', ctrlKey: true },
      { key: 'z', code: 'KeyZ', ctrlKey: true },
    ]) {
      await keydown?.({ target, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...key });
    }
    expect(driver.state.addNode).not.toHaveBeenCalled();
    expect(driver.state.pasteNodes).not.toHaveBeenCalled();
    expect(driver.state.undo).not.toHaveBeenCalled();
    cleanup?.();
    vi.unstubAllGlobals();
  });
});

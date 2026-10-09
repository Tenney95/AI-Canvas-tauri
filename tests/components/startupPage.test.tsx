import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';

interface Element { type: unknown; props: Record<string, unknown> & { children?: unknown } }
const driver = vi.hoisted(() => ({
  state: {} as AppState,
  values: [] as unknown[], index: 0,
  effects: [] as Array<() => void | (() => void)>,
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
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => { throw new Error('Web test'); } }));
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({}));

import ProjectLibraryModal from '../../src/components/ProjectLibraryModal';
import Header from '../../src/components/Header';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';

const onClose = vi.fn();
function render(page = true) {
  driver.index = 0;
  driver.effects = [];
  return ProjectLibraryModal({ isOpen: true, onClose, presentation: page ? 'page' : 'modal' }) as Element;
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
  driver.state = {
    projects: [{ id: 'p1', name: '示例项目', createdAt: 1, updatedAt: 2 }],
    currentProjectId: null, projectLoadStatus: 'ready', isCreatingProject: false,
    isReturningToStartPage: false, switchingProjectName: null,
    returnToStartPage: vi.fn(async () => true),
    createProject: vi.fn(async () => undefined),
    switchProject: vi.fn(async () => undefined),
    importProject: vi.fn(async () => undefined),
    setSettingsOpen: vi.fn(), showToast: vi.fn(), initFromDb: vi.fn(async () => undefined),
    selectedNodeIds: [], clipboard: { nodes: [{ id: 'copied' }], groups: [], projectId: 'p1' },
    addNode: vi.fn(), pasteNodes: vi.fn(), undo: vi.fn(), saveCurrentProject: vi.fn(),
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
    let finish: (() => void) | undefined;
    driver.state.switchProject = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = click(button(render(), '打开项目 示例项目'));
    expect(onClose).not.toHaveBeenCalled();
    expect(button(render(), '打开项目 示例项目').props.disabled).toBe(true);
    driver.state.currentProjectId = 'p1';
    finish?.();
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
    driver.state.importProject = vi.fn(async () => { driver.state.currentProjectId = 'imported'; return 'imported'; });
    await click(find(render(), (element) => element.type === 'button'
      && Array.isArray(element.props.children) && element.props.children.includes('导入')));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('blocks creation when the list failed to load and provides retry', async () => {
    driver.state.projectLoadStatus = 'error';
    driver.state.projects = [];
    const tree = render();
    expect(button(tree, '新建项目').props.disabled).toBe(true);
    await click(button(tree, '重试'));
    expect(driver.state.initFromDb).toHaveBeenCalledOnce();
  });

  it('lets users select another project when the last canvas failed but the list is available', async () => {
    driver.state.projectLoadStatus = 'error';
    driver.state.switchProject = vi.fn(async () => {
      driver.state.currentProjectId = 'p1';
      driver.state.projectLoadStatus = 'ready';
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';

type Element = { type: unknown; props: Record<string, unknown> };
const driver = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, state: {} as AppState,
  save: vi.fn(), load: vi.fn(), ask: vi.fn(), toast: vi.fn(), close: vi.fn(),
  readOrdinary: vi.fn(), saveOrdinary: vi.fn(), pick: vi.fn(),
}));
// 真实组件事件及可重渲染状态；窗口监听、媒体加载等挂载副作用由各自测试覆盖。
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const i = driver.cursor++;
    if (!(i in driver.slots)) driver.slots[i] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [driver.slots[i], (next: T | ((old: T) => T)) => {
      driver.slots[i] = typeof next === 'function' ? (next as (old: T) => T)(driver.slots[i] as T) : next;
    }];
  },
  useRef: <T,>(initial: T) => {
    const i = driver.cursor++;
    driver.slots[i] ??= { current: initial };
    return driver.slots[i];
  },
  useEffect: () => {}, useMemo: <T,>(fn: () => T) => fn(),
  useCallback: <T,>(fn: T) => fn, useDeferredValue: <T,>(v: T) => v,
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(s: T) => s }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((s: (state: AppState) => unknown) => s(driver.state), { getState: () => driver.state }),
}));
vi.mock('../../src/i18n', () => ({ useT: () => (s: string) => s, getLocale: () => 'zh-CN', LOCALES: [], LOCALE_LABELS: {}, setLocale: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: driver.ask }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@iconify/react', () => ({ Icon: 'icon' }));
vi.mock('framer-motion', () => ({ motion: { div: 'div', button: 'button' }, AnimatePresence: 'presence' }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: 'modal' }));
vi.mock('../../src/components/shared/AnimatedButton', () => ({ default: 'button' }));
vi.mock('../../src/components/shared/PopupCloseButton', () => ({ default: 'button' }));
vi.mock('../../src/components/settings/ApiKeySettings', () => ({ default: 'api-settings' }));
vi.mock('../../src/components/settings/StorageHealthCenter', () => ({ default: 'storage-health' }));
vi.mock('../../src/components/settings/DirectorDeskStorageManager', () => ({ default: 'director-storage' }));
vi.mock('../../src/components/settings/McpControlSettings', () => ({ default: 'mcp-settings' }));
vi.mock('../../src/components/settings/SettingsNavigation', () => ({ default: 'settings-nav' }));
vi.mock('../../src/components/settings/ShortcutSettings', () => ({ default: 'shortcut-settings' }));
vi.mock('../../src/components/settings/ComfyUISettings', () => ({ default: 'comfyui-settings' }));
vi.mock('../../src/components/settings/FileAppSettings', () => ({ default: 'file-settings' }));
vi.mock('../../src/components/settings/PluginSettings', () => ({ default: 'plugin-settings' }));
vi.mock('../../src/services/backgroundService', () => ({}));
vi.mock('../../src/services/fileService', () => ({
  loadConfigWithoutSecrets: driver.readOrdinary, saveConfig: driver.saveOrdinary, pickAssetFolder: driver.pick,
  loadProjectsList: async () => [], listGlobalFiles: async () => [], listExternalFolderFiles: async () => [],
  listProjectFiles: async () => [], registerProjectFolders: vi.fn(), setBaseDataDir: vi.fn(), syncAuthorizedDirectories: async () => {},
  revealFileInFolder: vi.fn(), addAssetFilesToGlobal: vi.fn(), CATEGORY_LABELS: {},
}));
vi.mock('../../src/services/indexedDbService', () => ({ getAllAssetMeta: async () => [] }));
vi.mock('../../src/utils/assetDrag', () => ({ startAssetDrag: vi.fn(), prepareDragIcon: vi.fn() }));
vi.mock('../../src/components/shared/AssetThumb', () => ({ default: 'asset-thumb' }));

import SettingsPanel from '../../src/components/SettingsPanel';
import CanvasRadialMenu from '../../src/components/canvas/CanvasRadialMenu';
import AssetSearchWindow from '../../src/components/AssetSearchWindow';

let tree: unknown;
let component: () => unknown;
function render() { driver.cursor = 0; tree = component(); }
function all(root: unknown, predicate: (e: Element) => boolean): Element[] {
  if (Array.isArray(root)) return root.flatMap((v) => all(v, predicate));
  if (!root || typeof root !== 'object' || !('props' in root)) return [];
  const e = root as Element;
  return [...(predicate(e) ? [e] : []), ...all(e.props.children, predicate)];
}
function text(root: unknown): string {
  if (typeof root === 'string' || typeof root === 'number') return String(root);
  if (Array.isArray(root)) return root.map(text).join('');
  return root && typeof root === 'object' && 'props' in root ? text((root as Element).props.children) : '';
}
function button(label: string): Element {
  const found = all(tree, (e) => e.type === 'button' && (e.props['aria-label'] === label || text(e.props.children).trim() === label))[0];
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(e: Element) {
  await (e.props.onClick as () => unknown)();
  await new Promise<void>((resolve) => setImmediate(resolve));
  render();
}
beforeEach(() => {
  vi.clearAllMocks(); driver.slots = [];
  driver.save.mockReset().mockResolvedValue(undefined);
  driver.saveOrdinary.mockReset().mockResolvedValue([]);
  driver.ask.mockReset().mockResolvedValue(false);
  driver.readOrdinary.mockReset().mockResolvedValue({ providers: {}, theme: 'dark', assetFolders: [] });
  driver.pick.mockReset().mockResolvedValue('fixture-folder');
  driver.state = {
    settingsOpen: true, config: { providers: {}, theme: 'dark' }, configHydrated: true,
    configSaveStatus: 'idle', configSaveError: null, configSecretReadErrors: [], configDirty: false,
    saveConfig: driver.save, loadConfig: driver.load, showToast: driver.toast,
    setSettingsOpen: driver.close, updateConfig: vi.fn(),
  } as unknown as AppState;
  vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 800 });
  vi.stubGlobal('document', { documentElement: { setAttribute: vi.fn(), toggleAttribute: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());

describe('settings persistence consumers', () => {
  it('shows failed settings and exposes a retry without reporting success', async () => {
    component = SettingsPanel;
    driver.state.configSaveStatus = 'error'; driver.state.configSaveError = '保存失败';
    driver.save.mockRejectedValueOnce(new Error('fixture'));
    render(); await click(button('重试保存'));
    expect(text(tree)).toContain('保存失败');
    expect(driver.toast).not.toHaveBeenCalled();
    await click(button('重试保存'));
    expect(driver.save).toHaveBeenCalledTimes(2);
  });

  it('requires confirmation before reloading conflicted unsaved settings', async () => {
    component = SettingsPanel;
    driver.state.configSaveStatus = 'conflict'; driver.state.configDirty = true;
    render(); await click(button('重新加载'));
    expect(driver.load).not.toHaveBeenCalled();
    driver.ask.mockResolvedValueOnce(true); driver.load.mockResolvedValueOnce(undefined);
    await click(button('重新加载'));
    expect(driver.load).toHaveBeenCalledOnce();
  });

  it('only exposes reload after the initial configuration read failed', () => {
    component = SettingsPanel;
    driver.state.configHydrated = false; driver.state.configSaveStatus = 'error';
    render(); expect(button('重新加载')).toBeDefined();
    expect(all(tree, (e) => e.type === 'button' && text(e.props.children) === '重试保存')).toHaveLength(0);
  });

  it('keeps radial edits open after failure and closes only on successful retry', async () => {
    component = () => CanvasRadialMenu({ position: { x: 400, y: 300 }, onClose: driver.close });
    render(); await click(button('自定义圆环快捷方式'));
    driver.save.mockRejectedValueOnce(new Error('fixture'));
    await click(button('保存设置'));
    expect(all(tree, (e) => e.props.role === 'dialog')).toHaveLength(1);
    expect(driver.close).not.toHaveBeenCalled(); expect(driver.toast).not.toHaveBeenCalled();
    await click(button('保存设置'));
    expect(driver.close).toHaveBeenCalledOnce(); expect(driver.toast).toHaveBeenCalledWith('画布圆环快捷方式已保存');
  });

  it('submits only the selected asset folder and preserves it for a retry with a fresh baseline', async () => {
    component = AssetSearchWindow; render(); await click(button('添加'));
    driver.saveOrdinary.mockRejectedValueOnce(new Error('fixture-private'));
    await click(button('📁 添加文件夹'));
    expect(text(tree)).toContain('文件夹设置保存失败'); expect(text(tree)).not.toContain('fixture-private');
    driver.readOrdinary.mockResolvedValue({ providers: {}, theme: 'light', assetFolders: ['other-folder'] });
    await click(button('重试保存'));
    expect(driver.pick).toHaveBeenCalledOnce();
    expect(driver.saveOrdinary.mock.calls[1][1]).toEqual({
      baseline: { providers: {}, theme: 'light', assetFolders: ['other-folder'] },
      changes: [{ path: ['assetFolders'], before: ['other-folder'], after: ['other-folder', 'fixture-folder'] }],
    });
    expect(text(tree)).not.toContain('文件夹设置保存失败');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
type DropEvent = { payload: { type: 'enter' | 'leave' | 'drop'; paths: string[]; position: { x: number; y: number } } };
const driver = vi.hoisted(() => ({
  state: {} as AppState, effects: [] as Array<() => void | (() => void)>,
  onDrag: undefined as ((event: DropEvent) => void) | undefined,
  copy: vi.fn(), read: vi.fn(), mark: vi.fn(), ids: 0,
}));
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(value: T) => [value, vi.fn()], useRef: <T,>(value: T) => ({ current: value }),
  useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => driver.effects.push(effect),
}));
vi.mock('@xyflow/react', () => ({ useReactFlow: () => ({ screenToFlowPosition: (position: unknown) => position }) }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((selector: (state: AppState) => unknown) => selector(driver.state), { getState: () => driver.state }),
  generateId: () => String(++driver.ids), computeImageNodeDimensions: async () => ({ nodeWidth: 280, nodeHeight: 158 }),
}));
vi.mock('../../src/services/fileService', () => ({ copyFileToProjectData: driver.copy, readBinaryFile: driver.read,
  arrayBufferToBase64: () => 'AA==' }));
vi.mock('../../src/utils/dropCapture', () => ({ isExternalDropCaptured: () => false }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({
  onDragDropEvent: async (handler: (event: DropEvent) => void) => { driver.onDrag = handler; return vi.fn(); },
}) }));
import { useNodeCreation } from '../../src/hooks/useNodeCreation';
let cleanups: Array<void | (() => void)>;
beforeEach(async () => {
  driver.effects = []; driver.ids = 0; driver.onDrag = undefined;
  driver.copy.mockReset().mockResolvedValue({ assetUrl: 'asset://copied', fileName: 'copied', filePath: '/project/copied' });
  driver.read.mockReset().mockResolvedValue(new Uint8Array([0])); driver.mark.mockReset().mockResolvedValue(true);
  driver.state = { currentProjectId: 'project', nodes: [], workflowPanelOpen: false, showToast: vi.fn(), markAssetUsed: driver.mark,
    addNode: vi.fn((node: AppState['nodes'][number]) => { driver.state.nodes = [...driver.state.nodes, node]; }),
    updateNodeDataTransient: vi.fn((id: string, patch: Record<string, unknown>) => {
      driver.state.nodes = driver.state.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node);
    }),
  } as unknown as AppState;
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, devicePixelRatio: 1 });
  useNodeCreation(); cleanups = driver.effects.map((effect) => effect());
  await vi.waitFor(() => expect(driver.onDrag).toBeDefined());
});
afterEach(() => { cleanups.forEach((cleanup) => cleanup?.()); vi.unstubAllGlobals(); });
function drag(type: DropEvent['payload']['type'], path = '/external/source.mp4') {
  driver.onDrag!({ payload: { type, paths: [path], position: { x: 20, y: 30 } } });
}
describe('成功导入后的最近使用记录', () => {
  it('Retina Mac 的文件节点出现在原生逻辑落点，不重复除以屏幕倍率', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    window.devicePixelRatio = 2;
    drag('drop');
    expect(driver.state.nodes[0].position).toEqual({ x: 20, y: 30 });
    await vi.waitFor(() => expect(driver.mark).toHaveBeenCalledOnce());
  });
  it('进入后离开、未实际放下文件时不记录', () => {
    drag('enter'); drag('leave'); expect(driver.mark).not.toHaveBeenCalled(); expect(driver.copy).not.toHaveBeenCalled();
  });
  it.each(['png', 'mp4', 'mp3'])('%s 完成复制和节点更新后才记录原始素材', async (extension) => {
    let finish!: (result: unknown) => void;
    driver.copy.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    drag('drop', `/external/source.${extension}`);
    expect(driver.state.nodes[0].data.status).toBe('loading'); expect(driver.mark).not.toHaveBeenCalled();
    finish({ assetUrl: 'asset://copied', fileName: 'copied', filePath: '/project/copied' });
    await vi.waitFor(() => expect(driver.mark).toHaveBeenCalledWith({ path: `/external/source.${extension}` }));
    expect(driver.state.nodes[0].data.status).toBe('success');
  });
  it('复制失败不记录，也不会把错误节点当作已使用素材', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    driver.copy.mockRejectedValue(new Error('copy failed')); drag('drop');
    await vi.waitFor(() => expect(driver.state.nodes[0].data.status).toBe('error'));
    expect(driver.mark).not.toHaveBeenCalled(); logger.mockRestore();
  });
  it('复制途中切换项目或删除占位节点时不记录', async () => {
    let finish!: (result: unknown) => void;
    driver.copy.mockImplementation(() => new Promise((resolve) => { finish = resolve; })); drag('drop');
    driver.state = { ...driver.state, currentProjectId: 'other', nodes: [] };
    finish({ assetUrl: 'asset://copied', fileName: 'copied', filePath: '/project/copied' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(driver.mark).not.toHaveBeenCalled();
  });
  it('重复原生 drop 事件只记录一次，读取失败不记录', async () => {
    drag('drop'); drag('drop'); await vi.waitFor(() => expect(driver.mark).toHaveBeenCalledOnce());
    expect(driver.copy).toHaveBeenCalledOnce();
  });
});

/**
 * useNodeCreation — 回归测试：成功导入后的最近使用记录。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
type DropEvent = { payload: { type: 'enter' | 'leave' | 'drop'; paths: string[]; position: { x: number; y: number } } };
const driver = vi.hoisted(() => ({
  state: {} as AppState, effects: [] as Array<() => void | (() => void)>,
  onDrag: undefined as ((event: DropEvent) => void) | undefined,
  copy: vi.fn(), read: vi.fn(), mark: vi.fn(), trash: vi.fn(), ids: 0,
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
  moveToUndoTrash: driver.trash,
  arrayBufferToBase64: () => 'AA==' }));
vi.mock('../../src/utils/dropCapture', () => ({ isExternalDropCaptured: () => false }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({
  onDragDropEvent: async (handler: (event: DropEvent) => void) => { driver.onDrag = handler; return vi.fn(); },
}) }));
import { useNodeCreation } from '../../src/hooks/useNodeCreation';
import { hasPendingCanvasMediaImport, pauseCanvasMediaImports } from '../../src/services/canvasDerivationGuard';
import { DRAMA_ASSET_IMAGE_DRAG_TYPE, endDramaAssetImageDrag, startDramaAssetImageDrag } from '../../src/services/dramaAssetImageDrag';
import { COMFY_REFMOD_MIME } from '../../src/utils/comfyRefmod';
let cleanups: Array<void | (() => void)>;
beforeEach(async () => {
  localStorage.clear();
  driver.effects = []; driver.ids = 0; driver.onDrag = undefined;
  driver.copy.mockReset().mockResolvedValue({ assetUrl: 'asset://copied', fileName: 'copied', filePath: '/project/copied' });
  driver.read.mockReset().mockResolvedValue(new Uint8Array([0])); driver.mark.mockReset().mockResolvedValue(true);
  driver.trash.mockReset().mockResolvedValue(undefined);
  const projectSession = {};
  driver.state = { getCurrentRevision: () => 0, currentProjectId: 'project', projectLoadStatus: 'ready', projectWorkspaceView: 'canvas',
    getProjectSessionToken: () => projectSession,
    projects: [{ id: 'project', name: '项目', createdAt: 1, updatedAt: 1 }, { id: 'other', name: '另一项目', createdAt: 1, updatedAt: 1 }],
    nodes: [], workflowPanelOpen: false, showToast: vi.fn(), markAssetUsed: driver.mark,
    addNode: vi.fn((node: AppState['nodes'][number]) => { driver.state.nodes = [...driver.state.nodes, node]; }),
    updateNodeDataTransient: vi.fn((id: string, patch: Record<string, unknown>) => {
      driver.state.nodes = driver.state.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node);
    }),
  } as unknown as AppState;
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, devicePixelRatio: 1 });
  useNodeCreation(); cleanups = driver.effects.map((effect) => effect());
  await vi.waitFor(() => expect(driver.onDrag).toBeDefined());
});
afterEach(() => { endDramaAssetImageDrag(); cleanups.forEach((cleanup) => cleanup?.()); vi.unstubAllGlobals(); });
function drag(type: DropEvent['payload']['type'], path = '/external/source.mp4') {
  driver.onDrag!({ payload: { type, paths: [path], position: { x: 20, y: 30 } } });
}

function beginCreativeImageDrag() {
  driver.state.assetsPanelOpen = true;
  driver.state.assetsPanelMode = 'drawer';
  const imageUrl = 'file:///library/side.png';
  driver.state.dramaAssets = { version: 2, scenes: [], props: [], characters: [{
    id: 'hero', kind: 'character', name: '角色', key: 'hero', summary: '', visualNotes: '', importance: 'main',
    source: 'manual', createdAt: 1, updatedAt: 1, confirmed: true, identity: '', referenceImages: [
      { id: 'front', kind: 'primary', imageUrl: 'file:///library/front.png', prompt: '', createdAt: 1, updatedAt: 1 },
      { id: 'side', kind: 'turnaround', imageUrl, prompt: '', createdAt: 1, updatedAt: 1 },
    ],
  }] };
  const data = new Map<string, string>();
  const dataTransfer = {
    files: [], get types() { return [...data.keys()]; }, clearData: () => data.clear(),
    setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '',
  } as unknown as DataTransfer;
  expect(startDramaAssetImageDrag(dataTransfer, { scope: 'project', kind: 'character', assetId: 'hero', referenceId: 'side' },
    imageUrl, '角色 · 转面参考图')).toBe(true);
  expect(dataTransfer.types).toEqual([DRAMA_ASSET_IMAGE_DRAG_TYPE]);
  return { dataTransfer, clientX: 84, clientY: 120, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.DragEvent;
}

describe('创作资产参考图拖入画布', () => {
  it('复制指定图片到项目，在落点只创建一次独立源节点', async () => {
    const event = beginCreativeImageDrag();
    const { onDrop } = useNodeCreation();
    const assets = driver.state.dramaAssets;
    await onDrop(event);
    await onDrop(event);
    expect(driver.copy).toHaveBeenCalledExactlyOnceWith('/library/side.png', 'project', { redactErrors: true });
    expect(driver.state.addNode).toHaveBeenCalledOnce();
    expect(driver.state.nodes[0]).toMatchObject({ type: 'source-image', position: { x: 84, y: 120 }, data: {
      label: '角色 · 转面参考图', role: 'source', status: 'success', filePath: '/project/copied', imageUrl: 'asset://copied',
    } });
    expect(driver.state.dramaAssets).toBe(assets);
  });

  it('复制途中切换项目时清理副本，迟到结果不写入画布', async () => {
    const event = beginCreativeImageDrag();
    let finish!: (result: unknown) => void;
    driver.copy.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = useNodeCreation().onDrop(event);
    await vi.waitFor(() => expect(driver.copy).toHaveBeenCalledOnce());
    driver.state = { ...driver.state, currentProjectId: 'other' };
    finish({ assetUrl: 'asset://copied', fileName: 'copied', filePath: '/project/copied' });
    await pending;
    expect(driver.state.addNode).not.toHaveBeenCalled();
    expect(driver.trash).toHaveBeenCalledWith('/project/copied');
  });

  it('重新进入同一项目后不接受上次会话的拖动', async () => {
    const event = beginCreativeImageDrag();
    const nextProjectSession = {};
    driver.state.getProjectSessionToken = () => nextProjectSession;
    await useNodeCreation().onDrop(event);
    expect(driver.copy).not.toHaveBeenCalled();
    expect(driver.state.addNode).not.toHaveBeenCalled();
  });
});

describe('成功导入后的最近使用记录', () => {
  it('剧本整页的原生及 HTML5 拖放不会往隐藏画布添加节点', async () => {
    driver.state.projectWorkspaceView = 'script';
    driver.state.pasteExternalFromDataTransfer = vi.fn(async () => undefined);
    drag('enter'); drag('drop');
    const creation = useNodeCreation();
    const event = { dataTransfer: { types: ['Files'], files: [{}] },
      preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.DragEvent;
    creation.onDragEnter(event);
    await creation.onDrop(event);
    expect(driver.state.addNode).not.toHaveBeenCalled();
    expect(driver.state.pasteExternalFromDataTransfer).not.toHaveBeenCalled();
    expect(driver.copy).not.toHaveBeenCalled();
  });

  it('切换剧本整页后，已放置的媒体占位仍完成复制', async () => {
    let finish!: (result: unknown) => void;
    driver.copy.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    drag('drop');
    expect(driver.state.nodes[0].data.status).toBe('loading');
    driver.state.projectWorkspaceView = 'script';
    finish({ assetUrl: 'asset://copied', fileName: 'copied', filePath: '/project/copied' });
    await vi.waitFor(() => expect(driver.state.nodes[0].data.status).toBe('success'));
    expect(driver.state.addNode).toHaveBeenCalledOnce();
  });

  it('退出核对能看到等待回填的媒体，暂停期间的原生拖入不建占位', async () => {
    let finish!: (result: unknown) => void;
    driver.copy.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const resume = pauseCanvasMediaImports();
    try {
      drag('drop');
      expect(driver.state.nodes).toEqual([]);
      expect(driver.copy).not.toHaveBeenCalled();
    } finally { resume(); }

    drag('drop');
    expect(driver.state.nodes[0].data.status).toBe('loading');
    expect(hasPendingCanvasMediaImport(driver.state)).toBe(true);
    expect(hasPendingCanvasMediaImport({ ...driver.state, currentProjectId: 'other' })).toBe(false);
    expect(hasPendingCanvasMediaImport({ ...driver.state, nodes: [] })).toBe(false);
    finish({ assetUrl: 'asset://copied', fileName: 'copied', filePath: '/project/copied' });
    await vi.waitFor(() => expect(hasPendingCanvasMediaImport(driver.state)).toBe(false));
    expect(driver.state.nodes[0].data).toMatchObject({ status: 'success', filePath: '/project/copied' });
  });

  it('读取文本时切换剧本整页，迟到正文不再创建画布节点', async () => {
    let finish!: (value: Uint8Array) => void;
    driver.read.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    drag('drop', '/external/note.txt');
    driver.state.projectWorkspaceView = 'script';
    finish(new TextEncoder().encode('迟到正文'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(driver.state.addNode).not.toHaveBeenCalled();
    expect(driver.mark).not.toHaveBeenCalled();
  });

  it('双击画布新建文本时写入真实历史偏好', () => {
    localStorage.setItem('canvas-model-prefs', JSON.stringify({ 'ai-text': 'general/text' }));
    const creation = useNodeCreation();
    creation.onDoubleClick({
      target: { classList: { contains: (name: string) => name === 'react-flow__pane' } },
      clientX: 20, clientY: 40,
    } as unknown as React.MouseEvent);
    expect(driver.state.addNode).toHaveBeenCalledOnce();
    expect(driver.state.nodes[0]).toMatchObject({ position: { x: 20, y: 40 },
      data: { type: 'ai-text', model: 'general/text', provider: 'general',
        prompt: '', status: 'idle', nodeWidth: 280, nodeHeight: 160 } });
    expect(driver.state.nodes[0].data).not.toHaveProperty('role');
  });

  it('RefMod 的语义拖放留给视频节点，不显示文件导入或创建媒体节点', async () => {
    const creation = useNodeCreation();
    const event = {
      dataTransfer: { types: [COMFY_REFMOD_MIME], files: [] },
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
    } as unknown as React.DragEvent;
    creation.onDragEnter(event);
    creation.onDragOver(event);
    await creation.onDrop(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(driver.state.addNode).not.toHaveBeenCalled();
    expect(driver.copy).not.toHaveBeenCalled();
  });
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
  it.each(['png', 'mp4', 'mp3'])('%s 源素材不绑定历史模型，完成节点更新后才记录使用', async (extension) => {
    localStorage.setItem('canvas-model-prefs', JSON.stringify({
      'ai-image': 'general/image', 'ai-video': 'general/video', 'ai-audio': 'general/audio',
    }));
    let finish!: (result: unknown) => void;
    driver.copy.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    drag('drop', `/external/source.${extension}`);
    expect(driver.state.nodes[0].data.status).toBe('loading'); expect(driver.mark).not.toHaveBeenCalled();
    finish({ assetUrl: 'asset://copied', fileName: 'copied', filePath: '/project/copied' });
    await vi.waitFor(() => expect(driver.mark).toHaveBeenCalledWith({ path: `/external/source.${extension}` }));
    expect(driver.state.nodes[0].data).toMatchObject({ role: 'source', status: 'success' });
    expect(driver.state.nodes[0].data.model).toBeUndefined();
    expect(driver.state.nodes[0].data.provider).toBeUndefined();
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
    driver.state = { ...driver.state, currentProjectId: 'other', nodes: [...driver.state.nodes] };
    finish({ assetUrl: 'asset://copied', fileName: 'copied', filePath: '/project/copied' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(driver.mark).not.toHaveBeenCalled();
  });
  it('重复原生 drop 事件只记录一次，读取失败不记录', async () => {
    drag('drop'); drag('drop'); await vi.waitFor(() => expect(driver.mark).toHaveBeenCalledOnce());
    expect(driver.copy).toHaveBeenCalledOnce();
  });
  it.each(['txt', 'md'])('%s 读取期间撤销或切换项目时不建节点', async (extension) => {
    let finish!: (value: Uint8Array) => void;
    driver.read.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    drag('drop', `/external/note.${extension}`);
    driver.state = { ...driver.state, currentProjectId: 'other' };
    finish(new TextEncoder().encode('迟到正文'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(driver.state.addNode).not.toHaveBeenCalled();
    expect(driver.mark).not.toHaveBeenCalled();
  });
});

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../src-tauri/src/media/comfyui/bridge.js', import.meta.url), 'utf8');

interface GraphNode { id: number; type: string; content: string; pos: number[]; size: number[] }
interface Tab { filename: string; content: string; activeState?: { nodes: GraphNode[] } }
interface SavePayload { requestId: string; workflowId: string; name: string; fileContent: string }

function createBridge() {
  const store = { openWorkflows: [] as Tab[], activeWorkflow: null as Tab | null, openWorkflow: vi.fn(async (tab: Tab) => { store.activeWorkflow = tab; }) };
  const toast = vi.fn();
  const prompt = vi.fn(async () => '新工作流');
  const graph = { _nodes: [] as GraphNode[] };
  const activate = (tab: Tab | null) => { store.activeWorkflow = tab; graph._nodes = tab?.activeState?.nodes ?? []; };
  const app = {
    isGraphReady: true,
    vueAppReady: true,
    rootGraph: graph,
    canvas: { canvas: { clientWidth: 1000, clientHeight: 700 }, ds: { scale: 1, offset: [0, 0] }, setDirty: vi.fn() },
    extensionManager: { spinner: false, workflow: store, toast: { add: toast }, dialog: { prompt } },
    registerExtension: vi.fn(),
    graphToPrompt: vi.fn(async () => ({
      workflow: { nodes: graph._nodes },
      output: { '1': { class_type: 'PrimitiveString', inputs: { value: graph._nodes[0]?.content } } },
    })),
    loadGraphData: vi.fn(async (data: { nodes: GraphNode[] }, _clean: boolean, _restore: boolean, workflow: string | Tab) => {
      const tab = typeof workflow === 'string' ? { filename: workflow, content: data.nodes[0]?.content, activeState: data } : workflow;
      if (!store.openWorkflows.includes(tab)) store.openWorkflows.push(tab);
      tab.activeState = data;
      activate(tab);
      return true;
    }),
    loadApiJson: vi.fn(async (output: Record<string, { inputs: { value: string } }>, filename: string) => {
      const content = output['1'].inputs.value;
      const tab = { filename, content, activeState: { nodes: [{ id: 1, type: 'PrimitiveString', content, pos: [5000, 4000], size: [200, 100] }] } };
      store.openWorkflows.push(tab);
      activate(tab);
    }),
  };
  let nextId = 0;
  const window = {
    app,
    location: { hostname: '127.0.0.1', origin: 'http://127.0.0.1:8188', assign: vi.fn() },
    localStorage: { getItem: () => null, setItem: vi.fn() },
    addEventListener: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
    __AI_CANVAS_PENDING_SAVE_PAYLOAD__: undefined as SavePayload | undefined,
    __AI_CANVAS_COMFY__: undefined as unknown as {
      loadWorkflow: (payload: unknown) => Promise<void>;
      saveToAICanvas: (asNew?: boolean) => Promise<void>;
      completeSave: (requestId: string, success: boolean, detail: string) => void;
      consumePending: () => void;
      getLoadResult: (requestId: string) => { state: string; source?: string; nodeCount?: number; detail?: string } | null;
    },
    __AI_CANVAS_PENDING_WORKFLOW__: undefined as unknown,
  };
  runInNewContext(source, {
    window, navigator: { userAgent: 'Windows' },
    document: { readyState: 'loading', addEventListener: vi.fn() },
    URL, console, setTimeout, clearTimeout, crypto: { randomUUID: () => `id-${++nextId}` },
  });
  const bridge = window.__AI_CANVAS_COMFY__;
  const load = (id: string, fileName = `${id}.json`) => bridge.loadWorkflow({
    workflowId: id, workflowName: id, workflowFileName: fileName,
    workflowCategory: 'ai-image', apiJson: JSON.stringify({ '1': { class_type: 'PrimitiveString', inputs: { value: id } } }),
  });
  const complete = () => bridge.completeSave(window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.requestId, true, '已保存');
  return { bridge, load, complete, window, store, app, graph, activate, toast, prompt };
}

describe('ComfyUI 桥接真实标签保存身份', () => {
  it('打开 A、B 后手动切回 A，只导出并保存 A', async () => {
    const h = createBridge();
    await h.load('wf-a');
    const a = h.store.activeWorkflow!;
    await h.load('wf-b');
    h.activate(a);
    a.filename = '用户改过标签名.json';
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toMatchObject({ workflowId: 'wf-a', name: 'wf-a' });
    expect(JSON.parse(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.fileContent)['1'].inputs.value).toBe('wf-a');
  });

  it('同名外部标签只能新建，不覆盖已绑定的工作流', async () => {
    const h = createBridge();
    await h.load('wf-a', '同名.json');
    const external = { filename: '同名.json', content: 'external' };
    h.store.openWorkflows.push(external);
    h.activate(external);
    await h.bridge.saveToAICanvas();
    expect(h.prompt).toHaveBeenCalled();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.workflowId).not.toBe('wf-a');
  });

  it('重新编辑只聚焦原标签对象，不按重名或后缀猜测', async () => {
    const h = createBridge();
    await h.load('wf-a', '相同.json');
    const a = h.store.activeWorkflow!;
    await h.load('wf-b', '相同.json');
    await h.load('wf-a', '相同.json');
    expect(h.store.activeWorkflow).toBe(a);
    expect(h.app.loadApiJson).toHaveBeenCalledTimes(2);
  });

  it('导出等待期间切换标签时拒绝保存', async () => {
    const h = createBridge();
    await h.load('wf-a');
    const a = h.store.activeWorkflow;
    await h.load('wf-b');
    const b = h.store.activeWorkflow;
    h.activate(a);
    h.app.graphToPrompt.mockImplementationOnce(async () => {
      h.activate(b);
      return { workflow: { nodes: h.graph._nodes }, output: { '1': { class_type: 'PrimitiveString', inputs: { value: 'b' } } } };
    });
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toBeUndefined();
    expect(h.window.location.assign).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error', detail: expect.stringContaining('切换') }));
  });

  it('保存确认回来时即使活动标签已变化，也只绑定原标签', async () => {
    const h = createBridge();
    await h.load('wf-a');
    const a = h.store.activeWorkflow;
    await h.bridge.saveToAICanvas(true);
    const newId = h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.workflowId;
    await h.load('wf-b');
    h.complete();
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.workflowId).toBe('wf-b');
    h.complete();
    h.activate(a);
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.workflowId).toBe(newId);
  });

  it('打开失败不会把当前标签改绑成失败目标', async () => {
    const h = createBridge();
    await h.load('wf-a');
    h.app.loadApiJson.mockRejectedValueOnce(new Error('加载失败'));
    await expect(h.load('wf-b')).rejects.toThrow('加载失败');
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.workflowId).toBe('wf-a');
  });

  it('连续点击保存只导出并发送一次', async () => {
    const h = createBridge();
    await h.load('wf-a');
    await Promise.all([h.bridge.saveToAICanvas(), h.bridge.saveToAICanvas()]);
    expect(h.app.graphToPrompt).toHaveBeenCalledTimes(1);
    expect(h.window.location.assign).toHaveBeenCalledTimes(1);
  });

  it('另存后再次打开原记录，应重新载入原记录，不复用已改绑标签', async () => {
    const h = createBridge();
    await h.load('wf-a');
    const a = h.store.activeWorkflow;
    await h.bridge.saveToAICanvas(true);
    h.complete();
    await h.load('wf-a');
    expect(h.app.loadApiJson).toHaveBeenCalledTimes(2);
    expect(h.store.activeWorkflow).not.toBe(a);
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.workflowId).toBe('wf-a');
  });
});

describe('ComfyUI 工作流真实载入和回执', () => {
  const payload = (id: string, editableJson?: string) => ({
    requestId: `open-${id}`, workflowId: `wf-${id}`, workflowName: id, workflowFileName: `${id}.json`,
    apiJson: JSON.stringify({ '1': { class_type: 'PrimitiveString', inputs: { value: id } } }), editableJson,
  });

  it('切换已有标签会恢复真实草稿图，不只修改 store 标签', async () => {
    const h = createBridge();
    await h.load('wf-a');
    h.graph._nodes[0].content = '未保存修改';
    await h.load('wf-b');
    await h.load('wf-a');
    expect(h.graph._nodes[0].content).toBe('未保存修改');
    expect(h.store.openWorkflow).not.toHaveBeenCalled();
    expect(h.app.loadGraphData).toHaveBeenCalledTimes(1);
    await h.bridge.saveToAICanvas();
    expect(JSON.parse(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.fileContent)['1'].inputs.value).toBe('未保存修改');
  });

  it('等待启动恢复结束再载入请求，不让恢复流程覆盖目标图', async () => {
    vi.useFakeTimers();
    try {
      const h = createBridge();
      h.app.extensionManager.spinner = true;
      const loaded = h.bridge.loadWorkflow(payload('a'));
      await vi.advanceTimersByTimeAsync(500);
      expect(h.app.loadApiJson).not.toHaveBeenCalled();
      h.app.extensionManager.spinner = false;
      await vi.advanceTimersByTimeAsync(100);
      await loaded;
      expect(h.graph._nodes[0].content).toBe('a');
    } finally { vi.useRealTimers(); }
  });

  it.each(['{"nodes":[]}', 'broken json'])('空或损坏编辑布局从 API 恢复：%s', async (editable) => {
    const h = createBridge();
    await h.bridge.loadWorkflow(payload('a', editable));
    expect(h.app.loadGraphData).not.toHaveBeenCalled();
    expect(h.bridge.getLoadResult('open-a')).toMatchObject({ state: 'ready', source: 'api', nodeCount: 1, detail: expect.stringContaining('恢复') });
  });

  it.each(['empty', 'false', 'throw'])('编辑器载入%s时从 API 恢复', async (mode) => {
    const h = createBridge();
    h.app.loadGraphData.mockImplementationOnce(async () => {
      if (mode === 'throw') throw new Error('插件异常');
      return mode !== 'false';
    });
    await h.bridge.loadWorkflow(payload('a', JSON.stringify({ nodes: [{ id: 1, type: 'PrimitiveString' }] })));
    expect(h.app.loadApiJson).toHaveBeenCalledTimes(1);
    expect(h.bridge.getLoadResult('open-a')).toMatchObject({ state: 'ready', source: 'api' });
  });

  it('API 载入仍然为空时返回错误，重试可恢复', async () => {
    const h = createBridge();
    h.app.loadApiJson.mockResolvedValueOnce(undefined);
    await expect(h.bridge.loadWorkflow(payload('a'))).rejects.toThrow('没有载入节点');
    expect(h.bridge.getLoadResult('open-a')).toMatchObject({ state: 'error' });
    await h.bridge.loadWorkflow(payload('a'));
    expect(h.bridge.getLoadResult('open-a')).toMatchObject({ state: 'ready', nodeCount: 1 });
  });

  it('连续请求按顺序执行，同请求 ID 不重复加载', async () => {
    const h = createBridge();
    await Promise.all([h.bridge.loadWorkflow(payload('a')), h.bridge.loadWorkflow(payload('b')), h.bridge.loadWorkflow(payload('a'))]);
    expect(h.app.loadApiJson).toHaveBeenCalledTimes(2);
    expect(h.graph._nodes[0].content).toBe('b');
    expect(h.bridge.getLoadResult('open-a')?.state).toBe('ready');
    expect(h.bridge.getLoadResult('open-b')?.state).toBe('ready');
  });

  it('consumePending 不会在忙碌时丢失后一条请求', async () => {
    const h = createBridge();
    h.window.__AI_CANVAS_PENDING_WORKFLOW__ = payload('a'); h.bridge.consumePending();
    h.window.__AI_CANVAS_PENDING_WORKFLOW__ = payload('b'); h.bridge.consumePending();
    await h.bridge.loadWorkflow(payload('b'));
    expect(h.app.loadApiJson).toHaveBeenCalledTimes(2);
    expect(h.graph._nodes[0].content).toBe('b');
  });

  it('新工作流节点在屏幕外时居中视口，不改节点坐标', async () => {
    const h = createBridge();
    await h.load('wf-a');
    expect(h.graph._nodes[0].pos).toEqual([5000, 4000]);
    expect(h.app.canvas.ds.offset).toEqual([-4600, -3700]);
    expect(h.app.canvas.setDirty).toHaveBeenCalledWith(true, true);
  });

  it('没有有效 API 节点时不清空现有图', async () => {
    const h = createBridge();
    await h.load('wf-a');
    await expect(h.bridge.loadWorkflow({ ...payload('b'), apiJson: '{}' })).rejects.toThrow('数据无效');
    expect(h.graph._nodes[0].content).toBe('wf-a');
  });
});

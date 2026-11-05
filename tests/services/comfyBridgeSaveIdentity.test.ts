/**
 * comfyBridgeSaveIdentity — 回归测试：ComfyUI 桥接真实标签保存身份。
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../src-tauri/src/media/comfyui/bridge.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../src-tauri/src/media/comfyui/bridge.css', import.meta.url), 'utf8');
const icon = readFileSync(new URL('../../public/favicon.svg', import.meta.url), 'utf8');

interface GraphNode { id: number; type: string; content: string; pos: number[]; size: number[] }
interface Tab { filename: string; content: string; activeState?: { nodes: GraphNode[] } }
interface SavePayload { requestId: string; workflowId: string; saveMode: 'update' | 'create'; name: string; fileContent: string }

function createBridge(pageUrl = 'http://127.0.0.1:8188', configuredUrl = pageUrl, isTopFrame = true) {
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
    loadApiJson: vi.fn(async (output: Record<string, { inputs: { value: string } }>, filename: string): Promise<void | false> => {
      const content = output['1'].inputs.value;
      const tab = { filename, content, activeState: { nodes: [{ id: 1, type: 'PrimitiveString', content, pos: [5000, 4000], size: [200, 100] }] } };
      store.openWorkflows.push(tab);
      activate(tab);
    }),
  };
  let nextId = 0;
  const window = {
    comfyAPI: { api: { api: { queuePrompt: vi.fn(async (..._args: unknown[]) => ({ prompt_id: 'mock-prompt' })) } } },
    app,
    location: { hostname: new URL(pageUrl).hostname, origin: new URL(pageUrl).origin, assign: vi.fn() },
    top: undefined as unknown,
    localStorage: { getItem: () => null, setItem: vi.fn() },
    addEventListener: vi.fn(), setTimeout: vi.fn((_callback: () => void, _delay: number) => 1), clearTimeout: vi.fn(),
    __AI_CANVAS_PENDING_SAVE_PAYLOAD__: undefined as SavePayload | undefined,
    __AI_CANVAS_COMFY__: undefined as unknown as {
      loadWorkflow: (payload: unknown) => Promise<void>;
      saveToAICanvas: (asNew?: boolean) => Promise<void>;
      completeSave: (requestId: string | null, success: boolean, detail: string) => void;
      consumePending: () => void;
      getLoadResult: (requestId: string) => { state: string; source?: string; nodeCount?: number; detail?: string } | null;
    },
    __AI_CANVAS_PENDING_WORKFLOW__: undefined as unknown,
  };
  window.top = isTopFrame ? window : {};
  runInNewContext(source, {
    aiCanvasComfyOrigin: new URL(configuredUrl).origin,
    aiCanvasComfyStyles: styles,
    aiCanvasComfyIcon: icon,
    window, navigator: { userAgent: 'Windows' },
    document: { readyState: 'loading', addEventListener: vi.fn() },
    URL, TextEncoder, console, setTimeout, clearTimeout, crypto: { randomUUID: () => `id-${++nextId}` },
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
  it.each(['http://192.168.1.20:8188', 'https://comfy.example.com/comfy/'])('远程服务 %s 支持载入与保存回写', async (url) => {
    const h = createBridge(url);
    await h.load('wf-remote');
    expect(h.app.loadApiJson).toHaveBeenCalledTimes(1);
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toMatchObject({ workflowId: 'wf-remote' });
    expect(h.window.location.assign).toHaveBeenCalledWith(`${new URL(url).origin}/__ai_canvas_comfy_action__?action=save`);
    h.complete();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toBeUndefined();
  });

  it.each([
    'https://other.example.com',
    'http://comfy.example.com',
    'https://comfy.example.com:8443',
  ])('页面跳转到不同来源 %s 时不初始化桥接', (url) => {
    const h = createBridge(url, 'https://comfy.example.com');
    expect(h.bridge).toBeUndefined();
    expect(h.window.localStorage.setItem).not.toHaveBeenCalled();
    expect(h.window.addEventListener).not.toHaveBeenCalled();
  });

  it('同源子 frame 不能初始化桥接', () => {
    const h = createBridge('https://comfy.example.com', 'https://comfy.example.com', false);
    expect(h.bridge).toBeUndefined();
  });

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

  it('同名外部标签普通保存拒绝，显式另存才创建新记录', async () => {
    const h = createBridge();
    await h.load('wf-a', '同名.json');
    const external = { filename: '同名.json', content: 'external' };
    h.store.openWorkflows.push(external);
    h.activate(external);
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toBeUndefined();
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error', detail: expect.stringContaining('另存到 AI Canvas') }));
    await h.bridge.saveToAICanvas(true);
    expect(h.prompt).toHaveBeenCalled();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.workflowId).not.toBe('wf-a');
  });

  it('原记录反复编辑保存始终使用原 ID，不重新命名或创建副本', async () => {
    const h = createBridge();
    await h.load('builtin-dlss5-image-enhance');
    for (const content of ['第一次编辑', '第二次编辑']) {
      h.graph._nodes[0].content = content;
      await h.bridge.saveToAICanvas();
      expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.workflowId).toBe('builtin-dlss5-image-enhance');
      expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.saveMode).toBe('update');
      expect(JSON.parse(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.fileContent)['1'].inputs.value).toBe(content);
      h.complete();
    }
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it('同一标签经代理重新包装，仍保存原 ID，标记不进入序列化数据', async () => {
    const h = createBridge();
    await h.load('wf-a');
    const a = h.store.activeWorkflow!;
    h.activate(new Proxy(a, {}));
    h.app.graphToPrompt.mockImplementationOnce(async () => {
      h.activate(new Proxy(a, {}));
      return { workflow: { nodes: h.graph._nodes }, output: { '1': { class_type: 'PrimitiveString', inputs: { value: '修改后' } } } };
    });
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.workflowId).toBe('wf-a');
    h.complete();
    await h.load('wf-b');
    h.store.openWorkflows[0] = new Proxy(a, {});
    await h.load('wf-a');
    expect(h.app.loadApiJson).toHaveBeenCalledTimes(2);
    expect(h.prompt).not.toHaveBeenCalled();
    expect(Object.getOwnPropertySymbols(a)).toHaveLength(1);
    expect(Object.getOwnPropertySymbols({ ...a })).toHaveLength(0);
    expect(JSON.stringify(a)).not.toContain('ai-canvas-workflow-tab');
  });

  it.each([false, true])('缺少活动标签时拒绝载入绑定与保存，不回退新建（Ref=%s）', async (asRef) => {
    const h = createBridge();
    if (asRef) {
      let active: Tab | null = null;
      Object.defineProperty(h.store, 'activeWorkflow', {
        get: () => ({ value: active }),
        set: (tab: Tab | null) => { active = tab; },
      });
    }
    const load = h.app.loadApiJson.getMockImplementation()!;
    h.app.loadApiJson.mockImplementationOnce(async (...args) => {
      await load(...args);
      h.store.activeWorkflow = null;
    });
    await expect(h.load('wf-a')).rejects.toThrow('无法绑定原工作流');
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toBeUndefined();
    expect(h.prompt).not.toHaveBeenCalled();
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
    const savedRequestId = h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.requestId;
    await h.load('wf-b');
    h.complete();
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.workflowId).toBe('wf-b');
    h.bridge.completeSave(savedRequestId, true, '上次保存的迟到回执');
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

  it('超长中文名称在交接前拒绝，缩短后可重新另存', async () => {
    const h = createBridge();
    await h.load('wf-a');
    h.prompt.mockResolvedValueOnce('中'.repeat(180));
    await h.bridge.saveToAICanvas(true);
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toBeUndefined();
    expect(h.window.location.assign).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('名称过长') }));
    h.prompt.mockResolvedValueOnce('简短名称');
    await h.bridge.saveToAICanvas(true);
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toMatchObject({ name: '简短名称', saveMode: 'create' });
  });

  it('原文件名超过原生 UTF-8 字节限制时可改用短名称另存', async () => {
    const h = createBridge();
    await h.load('wf-a', `${'文'.repeat(180)}.json`);
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toBeUndefined();
    expect(h.window.location.assign).not.toHaveBeenCalled();
    await h.bridge.saveToAICanvas(true);
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.saveMode).toBe('create');
  });

  it('正文超过 16 MiB UTF-8 时先拒绝，不进入不可修正的待确认状态', async () => {
    const h = createBridge();
    await h.load('wf-a');
    const oversized = '中'.repeat(Math.floor(16 * 1024 * 1024 / 3) + 1);
    h.app.graphToPrompt.mockResolvedValueOnce({
      workflow: { nodes: h.graph._nodes },
      output: { '1': { class_type: 'PrimitiveString', inputs: { value: oversized } } },
    });
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toBeUndefined();
    expect(h.window.location.assign).not.toHaveBeenCalled();
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toMatchObject({ workflowId: 'wf-a', saveMode: 'update' });
  });

  it.each([null, '', 'save-old-request'])('无关联失败回执 %s 不清理当前在途另存身份', async (requestId) => {
    const h = createBridge();
    await h.load('wf-a');
    await h.bridge.saveToAICanvas(true);
    const pending = h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!;
    h.bridge.completeSave(requestId, false, '旧导航读取失败');
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toBe(pending);
    await h.bridge.saveToAICanvas(true);
    expect(h.app.graphToPrompt).toHaveBeenCalledOnce();
    h.complete();
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toMatchObject({ workflowId: pending.workflowId, saveMode: 'update' });
  });

  it('另存超时仍以原请求核对，确认后只绑定原发起标签', async () => {
    const h = createBridge();
    await h.load('wf-a');
    const a = h.store.activeWorkflow!;
    await h.bridge.saveToAICanvas(true);
    const pending = h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!;
    expect(pending.saveMode).toBe('create');
    h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__ = undefined;
    h.window.setTimeout.mock.calls.at(-1)![0]();
    await h.load('wf-b');
    await h.bridge.saveToAICanvas(true);
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toBe(pending);
    expect(h.app.graphToPrompt).toHaveBeenCalledOnce();
    h.complete();
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.workflowId).toBe('wf-b');
    h.complete();
    h.activate(a);
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__).toMatchObject({ workflowId: pending.workflowId, saveMode: 'update' });
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

  it('API 明确拒绝载入时不能把之前的非空画布改绑给新工作流', async () => {
    const h = createBridge();
    await h.load('wf-a');
    h.app.loadApiJson.mockResolvedValueOnce(false);
    await expect(h.load('wf-b')).rejects.toThrow('API 工作流载入被拒绝');
    await h.bridge.saveToAICanvas();
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.workflowId).toBe('wf-a');
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


describe('API 空视频参考预览', () => {
  function fixture(value = '') {
    const callback = vi.fn();
    const file = { name: 'video', value: 'old.mp4', callback };
    const element = () => ({ hidden: false, removeAttribute: vi.fn(), pause: vi.fn() });
    const preview = { name: 'videopreview', value: { hidden: false, paused: false, params: { filename: 'old.mp4' } },
      parentEl: { hidden: false }, videoEl: element(), imgEl: element(), aspectRatio: 1.5 };
    const node = { id: 201, widgets: [file, preview], video_query: { stale: true }, setDirtyCanvas: vi.fn() };
    const match = source.replace(/\r\n/g, '\n').match(/const clearEmptyVideoPreviews = ([\s\S]*?);\n\n {2}const fitLoadedGraph/);
    if (!match) throw new Error('Missing empty preview cleanup');
    const clear = runInNewContext(`(${match[1]})`, { graphNodes: () => [node] });
    clear({}, { '201': { class_type: 'VHS_LoadVideo', inputs: { video: value } } });
    return { file, preview, node, callback };
  }

  it('空文件同步清除独立预览及媒体 src', () => {
    const { file, preview, node } = fixture();
    expect(file.value).toBe('');
    expect(preview.value).toMatchObject({ hidden: true, paused: true, params: {} });
    expect(preview.parentEl.hidden).toBe(true);
    expect(preview.videoEl.pause).toHaveBeenCalled();
    expect(preview.videoEl.removeAttribute).toHaveBeenCalledWith('src');
    expect(preview.imgEl.removeAttribute).toHaveBeenCalledWith('src');
    expect(node.video_query).toBeUndefined();
  });

  it('选择新视频恢复正常回调，再清空仍可清理', () => {
    const { file, preview, callback } = fixture();
    file.callback('new.mp4');
    expect(callback).toHaveBeenCalledWith('new.mp4');
    expect(preview.value.hidden).toBe(false);
    expect(preview.parentEl.hidden).toBe(false);
    file.callback('');
    expect(preview.value.hidden).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('已填写文件的输入和预览原样保留', () => {
    const { file, preview, callback } = fixture('chosen.mp4');
    expect(file.callback).toBe(callback);
    expect(file.value).toBe('old.mp4');
    expect(preview.value.params.filename).toBe('old.mp4');
    expect(preview.videoEl.pause).not.toHaveBeenCalled();
  });
});


describe('ComfyUI 自带运行按钮的 H3 可选素材', () => {
  function workflow(counts: number[]) {
    const output: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
      '19': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { prompt: '小满推开门', width: 640 } },
    };
    for (const [g, cls, key, prefix, first, max] of [
      [0, 'LoadImage', 'image', 'ref_images.ref_image_', 101, 9],
      [1, 'VHS_LoadVideo', 'video', 'ref_videos.ref_video_', 201, 3],
      [2, 'LoadAudio', 'audio', 'ref_audios.ref_audio_', 301, 3],
    ] as const) {
      for (let i = 0; i < max; i++) {
        const id = String(first + i);
        output[id] = { class_type: cls, inputs: { [key]: i < counts[g] ? `ref-${i}.file` : '' } };
        output['19'].inputs[prefix + i] = [id, 0];
      }
    }
    return output;
  }

  it.each([[0, 0, 0], [9, 0, 0], [0, 3, 0], [0, 0, 3], [6, 3, 3]])(
    '直接运行 图%s 视频%s 音频%s 时，仅提交已填写的素材', async (images, videos, audios) => {
      const h = createBridge();
      const client = h.window.comfyAPI.api.api;
      const original = client.queuePrompt;
      await h.load('wf-optional');
      const output = workflow([images, videos, audios]);
      const before = JSON.stringify(output);
      const editable = { nodes: Object.keys(output) };
      await client.queuePrompt(0, { output, workflow: editable }, { previewMethod: 'auto' });
      const sent = original.mock.calls[0][1] as { output: typeof output; workflow: unknown };
      expect(Object.keys(sent.output)).toHaveLength(1 + images + videos + audios);
      expect(sent.output['19'].inputs.prompt).toBe('小满推开门');
      expect(sent.workflow).toBe(editable);
      expect(JSON.stringify(output)).toBe(before);
      for (const value of Object.values(sent.output['19'].inputs)) {
        if (Array.isArray(value)) expect(sent.output[value[0]]).toBeDefined();
      }
      expect(original.mock.calls[0][2]).toEqual({ previewMethod: 'auto' });
    },
  );

  it('复现错误连接：空音频 303 不再进入提交图，保留音频 VAE', async () => {
    const h = createBridge();
    const client = h.window.comfyAPI.api.api;
    const original = client.queuePrompt;
    await h.load('wf-optional');
    const output = workflow([0, 0, 0]);
    output['27'] = { class_type: 'VAELoader', inputs: { vae_name: 'audio.safetensors' } };
    output['19'].inputs.audio_vae = ['27', 0];
    await client.queuePrompt(0, { output });
    const sent = original.mock.calls[0][1] as { output: typeof output };
    expect(sent.output['303']).toBeUndefined();
    expect(sent.output['19'].inputs['ref_audios.ref_audio_2']).toBeUndefined();
    expect(sent.output['27']).toEqual(output['27']);
    expect(sent.output['19'].inputs.audio_vae).toEqual(['27', 0]);
  });

  it('同一空音频仍被必填用途引用时保留，不擅自删除其他功能', async () => {
    const h = createBridge();
    const client = h.window.comfyAPI.api.api;
    const original = client.queuePrompt;
    await h.load('wf-optional');
    const output = workflow([0, 0, 0]);
    output['400'] = { class_type: 'SaveAudio', inputs: { audio: ['303', 0] } };
    await client.queuePrompt(0, { output });
    const sent = original.mock.calls[0][1] as { output: typeof output };
    expect(sent.output['303']).toEqual(output['303']);
    expect(sent.output['400']).toEqual(output['400']);
    expect(sent.output['19'].inputs['ref_audios.ref_audio_2']).toEqual(['303', 0]);
  });

  it('重复打开不重复包装；非 H3 请求和保存模板保持原样', async () => {
    const h = createBridge();
    const client = h.window.comfyAPI.api.api;
    const original = client.queuePrompt;
    await h.load('wf-one');
    const wrapped = client.queuePrompt;
    await h.load('wf-two');
    expect(client.queuePrompt).toBe(wrapped);
    const prompt = { output: { '303': { class_type: 'LoadAudio', inputs: { audio: '' } } } };
    await client.queuePrompt(0, prompt);
    expect(original).toHaveBeenCalledWith(0, prompt);
    await h.bridge.saveToAICanvas();
    expect(original).toHaveBeenCalledTimes(1);
    expect(h.window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__?.fileContent).toContain('PrimitiveString');
  });
});

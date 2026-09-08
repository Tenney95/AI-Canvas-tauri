import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../src-tauri/src/media/comfyui/bridge.js', import.meta.url), 'utf8');

interface Tab { filename: string; content: string }
interface SavePayload { requestId: string; workflowId: string; name: string; fileContent: string }

function createBridge() {
  const store = { openWorkflows: [] as Tab[], activeWorkflow: null as Tab | null, openWorkflow: vi.fn(async (tab: Tab) => { store.activeWorkflow = tab; }) };
  const toast = vi.fn();
  const prompt = vi.fn(async () => '新工作流');
  const app = {
    isGraphReady: true,
    extensionManager: { workflow: store, toast: { add: toast }, dialog: { prompt } },
    registerExtension: vi.fn(),
    graphToPrompt: vi.fn(async () => ({
      workflow: { nodes: [] },
      output: { '1': { class_type: 'PrimitiveString', inputs: { value: store.activeWorkflow?.content } } },
    })),
    loadApiJson: vi.fn(async (output: { content: string }, filename: string) => {
      const tab = { filename, content: output.content };
      store.openWorkflows.push(tab);
      store.activeWorkflow = tab;
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
    },
  };
  runInNewContext(source, {
    window, navigator: { userAgent: 'Windows' },
    document: { readyState: 'loading', addEventListener: vi.fn() },
    URL, console, crypto: { randomUUID: () => `id-${++nextId}` },
  });
  const bridge = window.__AI_CANVAS_COMFY__;
  const load = (id: string, fileName = `${id}.json`) => bridge.loadWorkflow({
    workflowId: id, workflowName: id, workflowFileName: fileName,
    workflowCategory: 'ai-image', apiJson: JSON.stringify({ content: id }),
  });
  const complete = () => bridge.completeSave(window.__AI_CANVAS_PENDING_SAVE_PAYLOAD__!.requestId, true, '已保存');
  return { bridge, load, complete, window, store, app, toast, prompt };
}

describe('ComfyUI 桥接真实标签保存身份', () => {
  it('打开 A、B 后手动切回 A，只导出并保存 A', async () => {
    const h = createBridge();
    await h.load('wf-a');
    const a = h.store.activeWorkflow!;
    await h.load('wf-b');
    h.store.activeWorkflow = a;
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
    h.store.activeWorkflow = external;
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
    h.store.activeWorkflow = a;
    h.app.graphToPrompt.mockImplementationOnce(async () => {
      h.store.activeWorkflow = b;
      return { workflow: { nodes: [] }, output: { '1': { class_type: 'PrimitiveString', inputs: { value: 'b' } } } };
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
    h.store.activeWorkflow = a;
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

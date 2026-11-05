/**
 * comfyWorkflowSaveBack — 回归测试：ComfyUI 工作流保存回写。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  invoke: vi.fn(),
  storeState: {
    workflows: [] as Array<Record<string, unknown>>,
    addWorkflow: vi.fn<(wf: Record<string, unknown>) => Promise<void>>(),
    updateWorkflow: vi.fn<(id: string, updates: Record<string, unknown>) => Promise<void>>(),
    showToast: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: { getState: () => mocks.storeState },
  generateId: () => 'generated',
}));
vi.mock('../../src/services/comfyWorkflowService', () => ({
  findMissingNodeClasses: vi.fn(async () => []),
}));
vi.mock('../../src/services/mediaDataUrl', () => ({
  sha256BytesHex: async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
}));

let initComfyUIWindowBridge: typeof import('../../src/services/comfyUIWindowService')['initComfyUIWindowBridge'];

/** ComfyUI 存回来的两份 JSON：API 格式用来跑，界面格式用来还原布局 */
const API_JSON = JSON.stringify({
  '105:104': { class_type: 'CLIPTextEncode', inputs: { text: '改过的提示词' }, _meta: { title: '提示词' } },
});
const EDITABLE_JSON = JSON.stringify({ nodes: [{ id: 1 }] });

function savePayload(workflowId: unknown, saveMode: 'update' | 'create' = 'update') {
  return {
    requestId: 'save-request-1',
    workflowId,
    saveMode,
    name: 'MiniMax H3 文生视频',
    category: 'ai-video',
    fileName: 'minimax-h3-t2v.json',
    fileContent: API_JSON,
    editableContent: EDITABLE_JSON,
  };
}

/** 走一遍 ComfyUI → Rust 事件 → 前端落库的保存回写链路 */
async function saveFromComfyUI(workflowId: unknown, saveMode: 'update' | 'create' = 'update') {
  await initComfyUIWindowBridge();
  const handler = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => Promise<void>;
  await handler({ payload: savePayload(workflowId, saveMode) });
}

beforeEach(async () => {
  vi.resetModules();
  ({ initComfyUIWindowBridge } = await import('../../src/services/comfyUIWindowService'));
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.storeState.addWorkflow.mockResolvedValue(undefined);
  mocks.storeState.updateWorkflow.mockResolvedValue(undefined);
  // 保存回写只在 Tauri 里生效，node 环境要先把这个开关立起来
  vi.stubGlobal('window', { __TAURI__: {} });
  mocks.storeState.workflows = [
    {
      id: 'builtin-minimax-h3-t2v',
      name: 'MiniMax H3 文生视频',
      category: 'ai-video',
      fileName: 'minimax-h3-t2v.json',
      fileContent: '{}',
      defaultNodes: { prompt: '105:104' },
      createdAt: 1,
    },
    {
      id: 'wf-imported',
      name: '手动导入的',
      category: 'ai-video',
      fileName: 'x.json',
      fileContent: '{}',
      createdAt: 1,
    },
  ];
});

describe('ComfyUI 工作流保存回写', () => {
  it('内置工作流原地更新，不会存成同名副本', async () => {
    await saveFromComfyUI('builtin-minimax-h3-t2v');

    expect(mocks.storeState.addWorkflow).not.toHaveBeenCalled();
    const [id, updates] = mocks.storeState.updateWorkflow.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('builtin-minimax-h3-t2v');
    expect(updates.fileContent).toBe(API_JSON);
    expect(updates.editableContent).toBe(EDITABLE_JSON);
    // 节点还在，标好的默认节点不该被冲掉
    expect(updates.defaultNodes).toEqual({ prompt: '105:104' });
    expect(mocks.invoke).toHaveBeenCalledWith('complete_comfyui_workflow_save', {
      requestId: 'save-request-1',
      success: true,
      detail: 'MiniMax H3 文生视频',
    });
  });

  it('手动导入的工作流照常原地更新', async () => {
    await saveFromComfyUI('wf-imported');

    expect(mocks.storeState.addWorkflow).not.toHaveBeenCalled();
    expect(mocks.storeState.updateWorkflow.mock.calls[0][0]).toBe('wf-imported');
  });

  it('MCP 创建的工作流编辑后原地更新并保留服务器及默认输入', async () => {
    mocks.storeState.workflows.push({
      id: 'workflow-mcp-example-1', name: 'MCP 工作流', serverId: 'video-server',
      defaultNodes: { prompt: '105:104' },
    });
    await saveFromComfyUI('workflow-mcp-example-1');
    expect(mocks.storeState.addWorkflow).not.toHaveBeenCalled();
    expect(mocks.storeState.updateWorkflow).toHaveBeenCalledWith('workflow-mcp-example-1', expect.objectContaining({
      fileContent: API_JSON, defaultNodes: { prompt: '105:104' },
    }));
    expect(mocks.storeState.updateWorkflow.mock.calls[0][1]).not.toHaveProperty('serverId');
  });

  it('id 不合法时拒绝保存，不静默创建同名副本', async () => {
    await saveFromComfyUI('../../etc/passwd');

    expect(mocks.storeState.updateWorkflow).not.toHaveBeenCalled();
    expect(mocks.storeState.addWorkflow).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('complete_comfyui_workflow_save', {
      requestId: 'save-request-1', success: false,
      detail: 'ComfyUI 工作流标识无效，请从画布重新打开编辑',
    });
  });

  it('仅明确另存可新建工作流', async () => {
    await saveFromComfyUI('wf-new-copy', 'create');

    expect(mocks.storeState.updateWorkflow).not.toHaveBeenCalled();
    expect((mocks.storeState.addWorkflow.mock.calls[0][0] as Record<string, unknown>).id)
      .toBe('wf-new-copy');
  });

  it('原记录已删除时普通保存拒绝，不复活被删除工作流', async () => {
    await saveFromComfyUI('wf-deleted');
    expect(mocks.storeState.addWorkflow).not.toHaveBeenCalled();
    expect(mocks.storeState.updateWorkflow).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('complete_comfyui_workflow_save', expect.objectContaining({
      success: false, detail: expect.stringContaining('原工作流已删除'),
    }));
  });

  it('明确新建不能覆盖已有同 ID 记录', async () => {
    await saveFromComfyUI('wf-imported', 'create');
    expect(mocks.storeState.addWorkflow).not.toHaveBeenCalled();
    expect(mocks.storeState.updateWorkflow).not.toHaveBeenCalled();
  });

  it('相同 requestId 的并发及确认重试只持久化一次', async () => {
    await initComfyUIWindowBridge();
    const handler = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => Promise<void>;
    const event = { payload: savePayload('wf-copy', 'create') };
    let finish!: () => void;
    mocks.storeState.addWorkflow.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = handler(event);
    const second = handler(event);
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish();
    await Promise.all([first, second]);
    await handler(event);
    expect(mocks.storeState.addWorkflow).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });

  it('同 requestId 不同内容拒绝，不覆盖已处理请求', async () => {
    await saveFromComfyUI('wf-imported');
    const handler = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => Promise<void>;
    await handler({ payload: { ...savePayload('wf-imported'), name: '另一份内容' } });
    expect(mocks.storeState.updateWorkflow).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.storeState.showToast).toHaveBeenLastCalledWith(expect.stringContaining('请求内容已变化'), 'error');
  });

  it('在途请求的冲突重放不能提前发送失败确认', async () => {
    await initComfyUIWindowBridge();
    const handler = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => Promise<void>;
    let finish!: () => void;
    mocks.storeState.updateWorkflow.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = handler({ payload: savePayload('wf-imported') });
    await vi.waitFor(() => expect(finish).toBeDefined());
    await handler({ payload: { ...savePayload('wf-imported'), name: '冲突内容' } });
    await handler({ payload: { ...savePayload('wf-imported'), saveMode: 'overwrite' } });
    expect(mocks.invoke).not.toHaveBeenCalled();
    finish();
    await first;
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith('complete_comfyui_workflow_save', expect.objectContaining({ success: true }));
  });

  it('请求账本全在途时拒绝新请求，不淘汰原请求或重复执行', async () => {
    await initComfyUIWindowBridge();
    const handler = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => Promise<void>;
    const finish: Array<() => void> = [];
    mocks.storeState.updateWorkflow.mockImplementation(() => new Promise<void>((resolve) => { finish.push(resolve); }));
    const payloads = Array.from({ length: 64 }, (_, index) => ({ ...savePayload('wf-imported'), requestId: `save-capacity-${index}` }));
    const pending = payloads.map((payload) => handler({ payload }));
    await vi.waitFor(() => expect(finish).toHaveLength(64));
    await handler({ payload: { ...savePayload('wf-imported'), requestId: 'save-over-capacity' } });
    const retry = handler({ payload: payloads[0] });
    expect(mocks.storeState.updateWorkflow).toHaveBeenCalledTimes(64);
    finish.forEach((resolve) => resolve());
    await Promise.all([...pending, retry]);
    expect(mocks.storeState.updateWorkflow).toHaveBeenCalledTimes(64);
    mocks.storeState.updateWorkflow.mockResolvedValue(undefined);
    await handler({ payload: { ...savePayload('wf-imported'), requestId: 'save-after-capacity' } });
    expect(mocks.storeState.updateWorkflow).toHaveBeenCalledTimes(65);
  });

  it('落库成功但回执失败后重试只补确认', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('窗口暂时不可用'));
    await saveFromComfyUI('wf-copy', 'create');
    const handler = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => Promise<void>;
    await handler({ payload: savePayload('wf-copy', 'create') });
    expect(mocks.storeState.addWorkflow).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenLastCalledWith('complete_comfyui_workflow_save', expect.objectContaining({ success: true }));
  });

  it.each([undefined, 'overwrite'])('缺失或未知保存方式 %s 拒绝', async (saveMode) => {
    await initComfyUIWindowBridge();
    const handler = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => Promise<void>;
    await handler({ payload: { ...savePayload('wf-imported'), saveMode } });
    expect(mocks.storeState.addWorkflow).not.toHaveBeenCalled();
    expect(mocks.storeState.updateWorkflow).not.toHaveBeenCalled();
  });

  it('更新持久化失败时回传失败，不显示保存成功', async () => {
    mocks.storeState.updateWorkflow.mockRejectedValueOnce(new Error('磁盘写入失败'));

    await saveFromComfyUI('wf-imported');

    expect(mocks.invoke).toHaveBeenCalledWith('complete_comfyui_workflow_save', {
      requestId: 'save-request-1',
      success: false,
      detail: '磁盘写入失败',
    });
    expect(mocks.storeState.showToast).toHaveBeenCalledWith('磁盘写入失败', 'error');
    expect(mocks.storeState.showToast).not.toHaveBeenCalledWith(
      expect.stringContaining('已从 ComfyUI 更新'),
      'success',
    );
  });

  it('新建持久化失败时回传失败，不显示保存成功', async () => {
    mocks.storeState.addWorkflow.mockRejectedValueOnce(new Error('数据库不可用'));

    await saveFromComfyUI('wf-new-copy', 'create');

    expect(mocks.invoke).toHaveBeenCalledWith('complete_comfyui_workflow_save', {
      requestId: 'save-request-1',
      success: false,
      detail: '数据库不可用',
    });
    expect(mocks.storeState.showToast).toHaveBeenCalledWith('数据库不可用', 'error');
    expect(mocks.storeState.showToast).not.toHaveBeenCalledWith(
      expect.stringContaining('已保存到工作流库'),
      'success',
    );
  });
});

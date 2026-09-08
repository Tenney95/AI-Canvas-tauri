import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { initComfyUIWindowBridge } from '../../src/services/comfyUIWindowService';

/** ComfyUI 存回来的两份 JSON：API 格式用来跑，界面格式用来还原布局 */
const API_JSON = JSON.stringify({
  '105:104': { class_type: 'CLIPTextEncode', inputs: { text: '改过的提示词' }, _meta: { title: '提示词' } },
});
const EDITABLE_JSON = JSON.stringify({ nodes: [{ id: 1 }] });

function savePayload(workflowId: unknown) {
  return {
    requestId: 'save-request-1',
    workflowId,
    name: 'MiniMax H3 文生视频',
    category: 'ai-video',
    fileName: 'minimax-h3-t2v.json',
    fileContent: API_JSON,
    editableContent: EDITABLE_JSON,
  };
}

/** 走一遍 ComfyUI → Rust 事件 → 前端落库的保存回写链路 */
async function saveFromComfyUI(workflowId: unknown) {
  await initComfyUIWindowBridge();
  const handler = mocks.listen.mock.calls[0][1] as (event: { payload: unknown }) => Promise<void>;
  await handler({ payload: savePayload(workflowId) });
}

beforeEach(() => {
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

  it('id 不合法时当新工作流入库，不会顶掉别人', async () => {
    await saveFromComfyUI('../../etc/passwd');

    expect(mocks.storeState.updateWorkflow).not.toHaveBeenCalled();
    const [created] = mocks.storeState.addWorkflow.mock.calls[0] as [Record<string, unknown>];
    expect(created.id).toBe('wf-generated');
  });

  it('工作流是新的（id 在库里找不到）时按新建处理', async () => {
    await saveFromComfyUI('builtin-not-seeded-yet');

    expect(mocks.storeState.updateWorkflow).not.toHaveBeenCalled();
    expect((mocks.storeState.addWorkflow.mock.calls[0][0] as Record<string, unknown>).id)
      .toBe('builtin-not-seeded-yet');
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

    await saveFromComfyUI(null);

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

import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock('../../src/services/ai/generateText', () => ({ generateText: mocks.generateText }));
vi.mock('../../src/services/aiService', () => ({ generateText: mocks.generateText }));
import { useAppStore } from '../../src/store/useAppStore';
import { executeGeneration } from '../../src/services/generationService';

beforeEach(() => {
  mocks.generateText.mockReset();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'ep', projectLoadStatus: 'ready', showToast: vi.fn(), recordOutputHistory: vi.fn(),
    projects: [{ id: 'ep', name: '分集', createdAt: 1, updatedAt: 1, settings: { defaultModels: { text: 'provider/text-model' } } }],
    nodes: [{ id: 'sheet', type: 'ai-shotlist', position: { x: 0, y: 0 }, data: {
      type: 'ai-shotlist', label: '表', prompt: '拆成两个镜头', shotlistRows: [],
    } }],
  });
});

it('通用节点执行采用项目文本模型，生成镜头行而不是普通 output 文本', async () => {
  mocks.generateText.mockResolvedValue('{"shots":[{"content":"月台"},{"content":"列车"}]}');
  const result = await executeGeneration('sheet');
  expect(result.success).toBe(true);
  const data = useAppStore.getState().nodes[0].data;
  expect(data.shotlistRows?.map((row) => row.content)).toEqual(['月台', '列车']);
  expect(data.output).toBeUndefined();
  expect(data.status).toBe('success');
  expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({ model: 'provider/text-model', provider: 'provider' }));
});

it('模型响应无法解析时返回失败，已有镜头不被清空', async () => {
  useAppStore.getState().updateNodeDataTransient('sheet', { shotlistRows: [{ id: 'r1', shotNo: '1', content: '用户正文' }] });
  mocks.generateText.mockResolvedValue('没有 JSON');
  const result = await executeGeneration('sheet');
  expect(result.success).toBe(false);
  expect(useAppStore.getState().nodes[0].data.shotlistRows?.[0].content).toBe('用户正文');
});

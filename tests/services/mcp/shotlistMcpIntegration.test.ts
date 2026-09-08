import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const media = vi.hoisted(() => ({ generate: vi.fn(), persist: vi.fn() }));
vi.mock('../../../src/services/ai/generateImage', () => ({ generateImage: media.generate }));
vi.mock('../../../src/services/fileService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/fileService')>(),
  persistMediaUrlToProjectData: media.persist,
}));
vi.mock('../../../src/components/nodes/shared/defaultModels', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/components/nodes/shared/defaultModels')>(),
  findMediaModelOption: (value: string) => value === 'image/model' ? { value, provider: 'image', mediaKind: 'image' } : undefined,
}));
import { useAppStore } from '../../../src/store/useAppStore';
import { handleMcpBridgeRequest } from '../../../src/services/mcp/mcpControlService';
import { resetAgentToolsRegistrationForTests } from '../../../src/services/chat/tools';
import { clearAgentToolRegistryForTests } from '../../../src/services/chat/toolRegistry';
import { SHOTLIST_TEXT_FIELDS } from '../../../src/services/shotlistService';
import type { McpToolCallResult } from '../../../src/types/mcp';
import type { ShotRow } from '../../../src/types/shotlist';

let callNo = 0;
function request(name: string, args: unknown, requestId = `shotlist-${++callNo}`) {
  return handleMcpBridgeRequest({ sessionId: 'shotlist-session', requestId,
    method: 'tools/call', params: { name, arguments: args } }) as Promise<McpToolCallResult>;
}
function call(name: string, args: unknown, requestId?: string) {
  return request('tools_call', { name, arguments: args }, requestId);
}
function content(result: McpToolCallResult) {
  expect(result.isError).toBe(false);
  const block = result.content[0];
  if (block.type !== 'text') throw new Error('Expected text');
  return JSON.parse(block.text);
}
function setRows(rows: ShotRow[]) {
  useAppStore.setState({ nodes: [{ id: 'sheet', type: 'ai-shotlist', position: { x: 0, y: 0 },
    data: { type: 'ai-shotlist', label: '测试分镜', shotlistRows: rows } }] });
}
beforeEach(() => {
  resetAgentToolsRegistrationForTests();
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'ep', projectLoadStatus: 'ready', showToast: vi.fn(), recordOutputHistory: vi.fn(),
    projects: [{ id: 'ep', name: '测试分集', parentId: 'series', createdAt: 1, updatedAt: 1,
      episodeScript: '月台上，林夏等到了列车。', settings: { defaultModels: { image: 'image/model' } } }] });
  media.generate.mockReset().mockResolvedValue({ url: 'generated', width: 100, height: 100 });
  media.persist.mockReset().mockResolvedValue({ mediaUrl: 'local-image', sourceUrl: 'generated', filePath: 'PRIVATE_PATH' });
});
afterEach(() => {
  resetAgentToolsRegistrationForTests();
  clearAgentToolRegistryForTests();
});

describe('MCP 主窗口分镜生产链', () => {
  it('按需发现后创建、追加、读取和局部更新，沿用真实 Registry、Policy 与 Store', async () => {
    const found = content(await request('tools_search', { query: 'shotlist', limit: 8, detail: 'schema' }));
    expect(found.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining([
      'episode_create_shotlist', 'shotlist_read', 'shotlist_update_rows', 'shotlist_generate_frames',
    ]));
    const created = content(await call('episode_create_shotlist', { episodeId: 'ep' }));
    expect(useAppStore.getState().nodes.find((node) => node.id === created.sourceNodeId)?.data.output).toContain('林夏');
    content(await call('shotlist_update_rows', { nodeId: created.shotlistId, mode: 'append', rows: [{ content: '列车进站', dialogue: '等到你了' }] }));
    const read = content(await call('shotlist_read', { nodeId: created.shotlistId }));
    const rowId = read.rows[0].id;
    content(await call('shotlist_update_rows', { nodeId: created.shotlistId, mode: 'update', rows: [{ id: rowId, camera: '缓慢推近' }] }));
    const updated = content(await call('shotlist_read', { nodeId: created.shotlistId }));
    expect(updated.rows[0]).toMatchObject({ id: rowId, content: '列车进站', dialogue: '等到你了', camera: '缓慢推近' });
    expect(useAppStore.getState().agentTasks.every((task) => task.status === 'completed')).toBe(true);
    expect(useAppStore.getState().agentTasks.flatMap((task) => task.steps).some((step) => step.kind === 'approval')).toBe(false);
    expect(media.generate).not.toHaveBeenCalled();
  });

  it('含大量转义字符的五行正文仍返回完整 JSON，并可按实际文字步长续读', async () => {
    const source = '\u0001'.repeat(400);
    setRows(Array.from({ length: 5 }, (_, i) => ({ id: `row-${i}`, shotNo: String(i + 1),
      ...Object.fromEntries(SHOTLIST_TEXT_FIELDS.map((field) => [field, source])) })));
    let offset = 0;
    let restored = '';
    do {
      const data = content(await call('shotlist_read', { nodeId: 'sheet', textOffset: offset }));
      restored += data.rows[0].content;
      expect(data.rows).toHaveLength(5);
      expect(data.textChunkSize).toBeGreaterThan(0);
      expect(JSON.stringify(data).length).toBeLessThan(20_000);
      offset = data.nextTextOffset;
    } while (offset !== null);
    expect(restored).toBe(source);
  });

  it('自主补图绑定真实节点，第二次调用跳过已完成镜头且审计不保存图片路径', async () => {
    setRows([{ id: 'r1', shotNo: '1', content: '列车进站', frame: null }]);
    const first = content(await call('shotlist_generate_frames', { nodeId: 'sheet', rowIds: ['r1'] }));
    expect(first.results[0].status).toBe('success');
    expect(useAppStore.getState().nodes[0].data.shotlistRows?.[0].frame?.nodeId).toBe(first.results[0].nodeId);
    const second = content(await call('shotlist_generate_frames', { nodeId: 'sheet', rowIds: ['r1'] }));
    expect(second.results[0].status).toBe('skipped');
    expect(media.generate).toHaveBeenCalledOnce();
    expect(JSON.stringify(useAppStore.getState().messages)).not.toContain('PRIVATE_PATH');
    expect(JSON.stringify(useAppStore.getState().agentTasks)).not.toContain('PRIVATE_PATH');
  });

  it('MCP 原请求取消后保留完成画面，重新发起时只补未完成镜头', async () => {
    setRows([{ id: 'r1', shotNo: '1', content: '列车进站', frame: null }, { id: 'r2', shotNo: '2', content: '人物上车', frame: null }]);
    let resolve!: (value: { url: string }) => void;
    media.generate.mockResolvedValueOnce({ url: 'first' }).mockReturnValueOnce(new Promise<{ url: string }>((done) => { resolve = done; }));
    const pending = call('shotlist_generate_frames', { nodeId: 'sheet', rowIds: ['r1', 'r2'] }, 'cancel-batch');
    await vi.waitFor(() => expect(media.generate).toHaveBeenCalledTimes(2));
    const cancelled = await handleMcpBridgeRequest({ sessionId: 'shotlist-session', requestId: 'stop-batch',
      method: 'requests/cancel', params: { requestId: 'cancel-batch' } });
    expect(cancelled).toEqual({ cancelled: true });
    expect((await pending).isError).toBe(true);
    const result = content(await call('shotlist_generate_frames', { nodeId: 'sheet', rowIds: ['r1', 'r2'] }));
    expect(result.results.map((row: { status: string }) => row.status)).toEqual(['skipped', 'success']);
    resolve({ url: 'late' });
    await Promise.resolve();
    expect(media.persist).toHaveBeenCalledTimes(2);
    expect(media.generate).toHaveBeenCalledTimes(3);
    expect(useAppStore.getState().agentTasks[0].status).toBe('stopped');
    expect(useAppStore.getState().agentTasks[1].status).toBe('completed');
  });
});

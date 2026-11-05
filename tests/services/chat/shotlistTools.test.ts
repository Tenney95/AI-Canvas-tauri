/**
 * shotlistTools — 回归测试：分镜工具。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const frames = vi.hoisted(() => vi.fn());
vi.mock('../../../src/services/shotlistFrameService', () => ({ generateShotlistFrames: frames, MAX_SHOTLIST_FRAME_BATCH: 12 }));
import { useAppStore } from '../../../src/store/useAppStore';
import { clearAgentToolRegistryForTests, getAgentTool, getAvailableAgentTools, prepareAgentToolCall, type AgentToolContext } from '../../../src/services/chat/toolRegistry';
import { registerShotlistAgentTools } from '../../../src/services/chat/tools/shotlistTools';
import { searchMcpToolCatalog } from '../../../src/services/mcp/mcpToolCatalog';
import { SHOTLIST_TEXT_FIELDS } from '../../../src/services/shotlistService';
import type { ShotRow } from '../../../src/types/shotlist';

const context = (): AgentToolContext => ({ projectId: 'ep', conversationId: 'chat', taskId: 'task', mode: 'autonomous',
  baseRevision: useAppStore.getState().getCurrentRevision(), signal: new AbortController().signal });

function setRows(rows: ShotRow[]) {
  useAppStore.setState({ nodes: useAppStore.getState().nodes.map((node) => node.id === 'sheet'
    ? { ...node, data: { ...node.data, shotlistRows: rows } } : node) });
}

beforeEach(() => {
  frames.mockReset();
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'ep', projectLoadStatus: 'ready', showToast: vi.fn(),
    projects: [{ id: 'ep', name: '集', parentId: 'series', createdAt: 1, updatedAt: 1, episodeScript: '正文', settings: { defaultModels: { image: 'general/image' } } }],
    nodes: [{ id: 'sheet', type: 'ai-shotlist', position: { x: 0, y: 0 }, data: { type: 'ai-shotlist', label: '分镜', shotlistRows: [
      { id: 'r1', shotNo: '1', content: '剧本'.repeat(300), frame: { nodeId: 'pic', kind: 'image', filePath: 'SECRET_PATH', url: 'SECRET_URL' },
        frameAnalysis: { secret: 'PRIVATE_ANALYSIS' } as never },
    ] } }],
  });
  registerShotlistAgentTools();
});

describe('分镜工具', () => {
  it('读取稳定 ID 与分段文字，不泄漏画面路径、URL 或拉片内部数据', async () => {
    const read = getAgentTool('shotlist_read')!;
    const result = await read.execute(context(), { nodeId: 'sheet' });
    expect(result.status).toBe('success');
    expect(result.modelContent).not.toMatch(/SECRET_|PRIVATE_ANALYSIS/);
    const data = JSON.parse(result.modelContent);
    expect(data).toMatchObject({ totalRows: 1, matchedRows: 1, nextOffset: null, nextTextOffset: 400 });
    expect(SHOTLIST_TEXT_FIELDS.every((field) => Object.hasOwn(data.rows[0], field))).toBe(true);
    expect(data.rows[0]).toMatchObject({ id: 'r1', mention: '@{sheet/shot/r1:分镜 · 镜1}', frame: { nodeId: 'pic', kind: 'image' }, truncatedFields: ['content'] });
    expect(data.rows[0].content).toHaveLength(400);
    const next = await read.execute(context(), { nodeId: 'sheet', textOffset: 400 });
    expect(JSON.parse(next.modelContent).rows[0].content).toHaveLength(200);
  });

  it('按完整镜号返回所有重复候选，与稳定 ID 筛选取交集且零命中不回退全表', async () => {
    setRows([
      { id: 'nineteen', shotNo: '19', dialogue: '镜十九' },
      { id: 'seven-first', shotNo: '7', dialogue: '镜七甲' },
      { id: 'leading-zero', shotNo: '07', dialogue: '不同镜号' },
      { id: 'seven-second', shotNo: '7', dialogue: '镜七乙' },
      { id: 'inserted', shotNo: '3a', dialogue: '插入镜' },
    ]);
    const read = getAgentTool('shotlist_read')!;
    const repeated = JSON.parse((await read.execute(context(), { nodeId: 'sheet', shotNos: ['7'], fields: ['dialogue'] })).modelContent);
    expect(repeated).toMatchObject({ totalRows: 5, matchedRows: 2, nextOffset: null });
    expect(repeated.rows.map((row: { id: string }) => row.id)).toEqual(['seven-first', 'seven-second']);
    const intersection = JSON.parse((await read.execute(context(), {
      nodeId: 'sheet', rowIds: ['nineteen', 'seven-second'], shotNos: ['7'], fields: ['dialogue'],
    })).modelContent);
    expect(intersection.rows.map((row: { id: string }) => row.id)).toEqual(['seven-second']);
    const inserted = JSON.parse((await read.execute(context(), { nodeId: 'sheet', shotNos: ['3a'], fields: [] })).modelContent);
    expect(inserted.rows[0]).toMatchObject({ id: 'inserted', mention: '@{sheet/shot/inserted:分镜 · 镜3a}' });
    for (const filters of [{ rowIds: ['missing'] }, { shotNos: ['missing'] }, { rowIds: ['seven-first'], shotNos: ['07'] }]) {
      const empty = await read.execute(context(), { nodeId: 'sheet', ...filters });
      expect(empty.status).toBe('success');
      expect(JSON.parse(empty.modelContent)).toMatchObject({ totalRows: 5, matchedRows: 0, rows: [], nextOffset: null, nextTextOffset: null });
      expect(empty.summary).toBe('读取 0 个镜头');
    }
  });

  it('筛选后按原表顺序分页，offset 不受传入 ID 顺序或镜号数值影响', async () => {
    setRows(Array.from({ length: 10 }, (_, index) => ({ id: `r${index}`, shotNo: index % 2 === 0 ? '19' : '7' })));
    const read = getAgentTool('shotlist_read')!;
    const input = { nodeId: 'sheet', rowIds: ['r8', 'r6', 'r4', 'r2', 'r0'], shotNos: ['19'], limit: 2, fields: [] };
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const data = JSON.parse((await read.execute(context(), { ...input, offset })).modelContent);
      expect(data).toMatchObject({ totalRows: 10, matchedRows: 5, nextOffset: offset < 4 ? offset + 2 : null });
      seen.push(...data.rows.map((row: { id: string }) => row.id));
    }
    expect(seen).toEqual(['r0', 'r2', 'r4', 'r6', 'r8']);
    const exhausted = JSON.parse((await read.execute(context(), { ...input, offset: 5 })).modelContent);
    expect(exhausted).toMatchObject({ matchedRows: 5, rows: [], nextOffset: null });
  });

  it('只续读所选文字字段，未请求的长正文不返回也不触发续读', async () => {
    setRows([{ id: 'selected', shotNo: '7', duration: 3, dialogue: '对白'.repeat(250), content: 'PRIVATE_BODY'.repeat(300),
      frame: { nodeId: 'pic', kind: 'image', filePath: 'SECRET_PATH', url: 'SECRET_URL' } }]);
    const read = getAgentTool('shotlist_read')!;
    const input = { nodeId: 'sheet', rowIds: ['selected'], fields: ['dialogue'] };
    const first = await read.execute(context(), input);
    const data = JSON.parse(first.modelContent);
    expect(data.rows[0]).toMatchObject({ id: 'selected', duration: 3, mention: '@{sheet/shot/selected:分镜 · 镜7}',
      frame: { nodeId: 'pic', kind: 'image' }, dialogue: '对白'.repeat(200), truncatedFields: ['dialogue'] });
    expect(data.nextTextOffset).toBe(400);
    expect(SHOTLIST_TEXT_FIELDS.filter((field) => field !== 'dialogue').every((field) => !Object.hasOwn(data.rows[0], field))).toBe(true);
    expect(first.modelContent).not.toMatch(/PRIVATE_BODY|SECRET_/);
    const next = JSON.parse((await read.execute(context(), { ...input, textOffset: data.nextTextOffset })).modelContent);
    expect(next.rows[0]).toMatchObject({ dialogue: '对白'.repeat(50), truncatedFields: [] });
    expect(next.nextTextOffset).toBeNull();
    for (const fields of [[], ['note']]) {
      const projected = JSON.parse((await read.execute(context(), { nodeId: 'sheet', rowIds: ['selected'], fields })).modelContent);
      expect(projected.rows[0]).toMatchObject({ id: 'selected', duration: 3, frame: { nodeId: 'pic', kind: 'image' }, truncatedFields: [] });
      expect(projected.rows[0]).not.toHaveProperty('content');
      expect(projected.rows[0]).not.toHaveProperty('dialogue');
      expect(projected.nextTextOffset).toBeNull();
    }
  });

  it('本地 schema 限制字段白名单与非空筛选，同时允许仅元数据读取', () => {
    for (const extra of [{ fields: ['frame'] }, { fields: ['frameAnalysis'] }, { fields: ['__proto__'] },
      { rowIds: [] }, { shotNos: [] }, { shotNos: [7] }]) {
      expect(prepareAgentToolCall({ callId: 'invalid-read', toolId: 'shotlist_read', input: { nodeId: 'sheet', ...extra } }, context()).ok).toBe(false);
    }
    for (const fields of [[], ['dialogue', 'note']]) {
      expect(prepareAgentToolCall({ callId: 'projected-read', toolId: 'shotlist_read', input: { nodeId: 'sheet', fields } }, context()).ok).toBe(true);
    }
  });

  it('定点读取仍拒绝已取消请求、其它项目及未完成加载的画布', async () => {
    const read = getAgentTool('shotlist_read')!;
    const input = { nodeId: 'sheet', rowIds: ['r1'], fields: ['content'] };
    const controller = new AbortController();
    controller.abort();
    const cancelled = await read.execute({ ...context(), signal: controller.signal }, input);
    expect(cancelled).toMatchObject({ status: 'error', summary: '任务已取消', retryable: false });
    const other = { ...context(), projectId: 'other' };
    expect(read.authorize!(other, input).allowed).toBe(false);
    expect((await read.execute(other, input)).status).toBe('error');
    useAppStore.setState({ projectLoadStatus: 'loading' });
    expect(read.authorize!(context(), input).allowed).toBe(false);
    expect((await read.execute(context(), input)).status).toBe('error');
  });

  it('读取独立成片的稳定身份/就绪状态，实时源优先于快照且不泄漏路径', async () => {
    const state = useAppStore.getState();
    const sheet = state.nodes[0];
    useAppStore.setState({ nodes: [{ ...sheet, data: { ...sheet.data, shotlistRows: [
      { id: 'ready', shotNo: '1', video: { nodeId: 'ready-source', kind: 'video', filePath: 'SECRET_PATH', url: 'SECRET_SNAPSHOT' } },
      { id: 'pending', shotNo: '2', video: { nodeId: 'pending-source', kind: 'video', url: 'SECRET_OLD_VIDEO' } },
      { id: 'fallback', shotNo: '3', video: { nodeId: 'deleted-source', kind: 'video', url: 'SECRET_FALLBACK' } },
      { id: 'unbound', shotNo: '4', video: null },
      { id: 'new', shotNo: '5' },
    ] } },
    { id: 'ready-source', type: 'source-video', position: { x: 0, y: 0 }, data: { type: 'source-video', label: 'ready', videoUrl: 'SECRET_REAL_VIDEO' } },
    { id: 'pending-source', type: 'ai-video', position: { x: 0, y: 0 }, data: { type: 'ai-video', label: 'pending' } },
    ] });
    const result = await getAgentTool('shotlist_read')!.execute(context(), { nodeId: 'sheet' });
    expect(result.status).toBe('success');
    expect(result.modelContent).not.toContain('SECRET_');
    const rows = JSON.parse(result.modelContent).rows;
    expect(rows.map((row: { video?: unknown }) => row.video)).toEqual([
      { nodeId: 'ready-source', kind: 'video', ready: true },
      { nodeId: 'pending-source', kind: 'video', ready: false },
      { nodeId: 'deleted-source', kind: 'video', ready: true }, null, undefined,
    ]);
  });

  it('写工具本地 schema 拒绝媒体字段，旧 revision 不写画布', async () => {
    const invalid = prepareAgentToolCall({ callId: 'call', toolId: 'shotlist_update_rows', input: { nodeId: 'sheet', mode: 'update', rows: [{ id: 'r1', frame: { url: 'bad' } }] } }, context());
    expect(invalid.ok).toBe(false);
    expect(prepareAgentToolCall({ callId: 'video', toolId: 'shotlist_update_rows', input: { nodeId: 'sheet', mode: 'update',
      rows: [{ id: 'r1', video: { nodeId: 'fake', kind: 'video' } }] } }, context()).ok).toBe(false);
    const result = await getAgentTool('shotlist_update_rows')!.execute({ ...context(), baseRevision: -1 }, { nodeId: 'sheet', mode: 'update', rows: [{ id: 'r1', content: 'bad' }] });
    expect(result.status).toBe('error');
    expect(useAppStore.getState().nodes[0].data.shotlistRows?.[0].content).not.toBe('bad');
  });

  it('Plan 只暴露读取与差异检查；MCP 发现不依赖真实 taskId', () => {
    expect(getAvailableAgentTools({ ...context(), mode: 'plan' }).map((tool) => tool.id)).toEqual(['shotlist_script_changes', 'shotlist_read']);
    expect(getAvailableAgentTools({ ...context(), taskId: '' }).map((tool) => tool.id)).toContain('shotlist_generate_frames');
    expect(getAgentTool('shotlist_generate_frames')!.effect).toBe('media_generation');
    expect(getAgentTool('shotlist_update_rows')!.effect).toBe('canvas_write');
    const catalog = searchMcpToolCatalog(context(), { query: '补图', category: 'shotlist' });
    expect(catalog.tools.map((tool) => tool.name)).toContain('shotlist_generate_frames');
  });

  it('协作模式没有本轮模型引用时拒绝生成，MCP 自主模式可用项目默认', async () => {
    const tool = getAgentTool('shotlist_generate_frames')!;
    const input = { nodeId: 'sheet', rowIds: ['r1'] };
    const resolved = tool.resolveInput!(input, context()) as typeof input & { modelRef: string };
    expect(resolved.modelRef).toBe('general/image');
    expect(tool.authorize!({ ...context(), mode: 'collaborative' }, resolved).allowed).toBe(false);
    expect(tool.authorize!({ ...context(), taskId: '' }, resolved).allowed).toBe(true);
    frames.mockResolvedValue([{ rowId: 'r1', status: 'error' }]);
    const result = await tool.execute(context(), resolved);
    expect(result.status).toBe('error');
    expect(result.retryable).toBe(false);
    expect(frames).toHaveBeenCalledTimes(1);
  });

  it('省略工具模型参数时优先使用本轮显式引用，并拒绝与该引用不一致的模型', () => {
    const task = useAppStore.getState().createAgentTask({ projectId: 'ep', conversationId: 'chat', userMessageId: 'user',
      mode: 'collaborative', goal: '用 @model{general/selected|本轮模型} 补齐空镜' });
    const toolContext = { ...context(), taskId: task.id, mode: 'collaborative' as const };
    const prepared = prepareAgentToolCall({ callId: 'selected', toolId: 'shotlist_generate_frames',
      input: { nodeId: 'sheet', rowIds: ['r1'] } }, toolContext);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('Expected prepared tool');
    expect(prepared.prepared.input).toMatchObject({ modelRef: 'general/selected' });
    const tool = getAgentTool('shotlist_generate_frames')!;
    expect(tool.authorize!(toolContext, prepared.prepared.input).allowed).toBe(true);
    expect(tool.authorize!(toolContext, { nodeId: 'sheet', rowIds: ['r1'], modelRef: 'general/image' }).allowed).toBe(false);
  });
});

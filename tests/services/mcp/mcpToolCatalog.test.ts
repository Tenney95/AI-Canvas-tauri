import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  registerAgentTool,
  type AgentToolContext,
  type AgentToolDefinition,
} from '../../../src/services/chat/toolRegistry';
import {
  decodeMcpToolCallEnvelope,
  describeMcpToolCatalog,
  getConfiguredMcpToolExposure,
  MCP_CATALOG_MAX_BYTES,
  MCP_CALL_DESCRIPTOR,
  searchMcpToolCatalog,
  serializeMcpCatalogResult,
  toMcpToolDescriptor,
} from '../../../src/services/mcp/mcpToolCatalog';

const context: Omit<AgentToolContext, 'signal'> = {
  taskId: 'catalog-task', projectId: 'project-1', conversationId: 'mcp-control-project-1', mode: 'autonomous',
};

function register(id: string, partial: Partial<AgentToolDefinition> = {}) {
  registerAgentTool({
    id, title: id, description: '查看测试工具', effect: 'read',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    execute: async () => ({ status: 'success', summary: '完成', modelContent: '{}' }),
    ...partial,
  });
}

beforeEach(() => {
  clearAgentToolRegistryForTests();
  register('canvas_query', { title: '查看画布', description: '读取画布节点与连线。' });
  register('canvas_align', { title: '对齐节点', description: '排列选中的节点。', effect: 'canvas_write' });
  register('media_generate', { title: '生成媒体', description: '生成图片、视频和音乐。', effect: 'media_generation' });
  register('tools_search');
});

describe('MCP tool catalog', () => {
  it('shows library preference and connection rules before initial discovery and full-mode creation tools', () => {
    for (const id of ['tools_describe', 'canvas_create_nodes', 'shotlist_prepare_production']) register(id);
    const descriptors = [MCP_CALL_DESCRIPTOR, ...[
      'tools_search', 'tools_describe', 'canvas_create_nodes', 'shotlist_prepare_production',
    ].map((id) => toMcpToolDescriptor(getAgentTool(id)!))];
    for (const descriptor of descriptors) {
      expect(descriptor.description.startsWith('素材引用优先级：')).toBe(true);
      expect(descriptor.description).toContain('drama_reference_image_add');
      expect(descriptor.description).toContain('dramaAssetId');
      expect(descriptor.description).toContain('sourceId（提供内容）→ targetId（消费内容）');
      expect(descriptor.description).toContain('sourceHandle=right、targetHandle=left');
      expect(descriptor.description).toContain('水平间距至少 80');
      expect(descriptor.description).toContain('分镜表 → 导演台');
      expect(descriptor.description).toContain('不要重复连接');
      expect(descriptor.description).toContain('canvas_query(detail=true)');
      expect(descriptor.description).toContain('layout.warning');
    }
    expect(descriptors[1].inputSchema).toBe(getAgentTool('tools_search')!.inputSchema);
    expect(MCP_CALL_DESCRIPTOR.annotations?.readOnlyHint).toBe(false);
  });

  it('keeps library preference first in navigation, search and describe responses without clipping contracts', () => {
    const results = [
      searchMcpToolCatalog(context, {}),
      searchMcpToolCatalog(context, { category: 'canvas' }),
      searchMcpToolCatalog(context, { query: 'canvas_query', detail: 'schema' }),
      searchMcpToolCatalog(context, { query: 'unmatched-xyz' }),
      searchMcpToolCatalog(context, { category: 'canvas', offset: 99 }),
      describeMcpToolCatalog(context, { names: ['canvas_query'] }),
    ];
    for (const result of results) {
      const serialized = serializeMcpCatalogResult(result);
      expect(serialized.startsWith('{"hint":"素材引用优先级：')).toBe(true);
      const decoded = JSON.parse(serialized);
      expect(decoded.hint).toContain('不要把导演台反接回分镜表');
      expect(decoded.tools).toEqual(result.tools);
      if (result.hint) expect(decoded.hint.endsWith(result.hint)).toBe(true);
      expect(result.hint?.startsWith('素材引用优先级：')).not.toBe(true);
    }
  });

  it('defaults old or invalid settings to compact discovery', () => {
    for (const value of [undefined, null, '', 'invalid', 1, 'compact']) {
      expect(getConfiguredMcpToolExposure(value)).toBe('compact');
    }
    expect(getConfiguredMcpToolExposure('full')).toBe('full');
  });

  it('returns category navigation without dumping tools or schemas', () => {
    expect(searchMcpToolCatalog(context, {})).toMatchObject({
      tools: [], total: 3,
      categories: [{ id: 'canvas', count: 2 }, { id: 'media', count: 1 }],
    });
  });

  it('ranks exact IDs first and recalls Chinese phrases and English categories', () => {
    expect(searchMcpToolCatalog(context, { query: 'CANVAS_QUERY' }).tools[0].name).toBe('canvas_query');
    expect(searchMcpToolCatalog(context, { query: '帮我对齐节点' }).tools[0].name).toBe('canvas_align');
    expect(searchMcpToolCatalog(context, { query: 'image generation' }).tools[0].name).toBe('media_generate');
    expect(searchMcpToolCatalog(context, { category: 'media' }).tools.map((tool) => tool.name)).toEqual(['media_generate']);
    expect(searchMcpToolCatalog(context, { query: 'unmatched-xyz' })).toMatchObject({ tools: [], total: 0 });
  });

  it('bounds summary results and does not embed input schemas', () => {
    for (let i = 0; i < 12; i += 1) register(`canvas_probe_${i}`);
    const results = searchMcpToolCatalog(context, { category: 'canvas' });
    expect(results.tools).toHaveLength(5);
    expect(JSON.stringify(results)).not.toContain('inputSchema');
    expect(searchMcpToolCatalog(context, { category: 'canvas', limit: 8 }).tools).toHaveLength(8);
    expect(() => searchMcpToolCatalog(context, { limit: 9 })).toThrow('参数无效');
    expect(() => searchMcpToolCatalog(context, { limit: -1 })).toThrow('参数无效');
  });

  it('returns the original complete schema only when requested', () => {
    const schema = { type: 'object' as const, required: ['text'], additionalProperties: false,
      properties: { text: { type: 'string' as const, minLength: 1, description: '完整参数说明' } } };
    register('canvas_text', { inputSchema: schema });
    const described = describeMcpToolCatalog(context, { names: ['canvas_text', 'canvas_text'] });
    expect(described.tools).toHaveLength(1);
    expect(described.tools[0].inputSchema).toEqual(schema);
    expect(searchMcpToolCatalog(context, { query: 'canvas_text', detail: 'schema', limit: 1 }).tools[0].inputSchema).toEqual(schema);
    expect(() => describeMcpToolCatalog(context, { names: ['canvas_query', 'canvas_align', 'media_generate', 'canvas_text'] })).toThrow('1 至 3');
  });

  it.each(['summary', 'schema'] as const)('pages through an entire stable category without gaps or duplicates (%s)', (detail) => {
    const expected = ['canvas_align', 'canvas_query'];
    for (let i = 0; i < 21; i += 1) {
      const id = `canvas_probe_${String(i).padStart(2, '0')}`;
      register(id);
      expected.push(id);
    }
    const seen: string[] = [];
    for (const offset of [0, 8, 16]) {
      const result = searchMcpToolCatalog(context, { category: 'canvas', limit: 8, offset, detail });
      expect(result).toMatchObject({ total: 23, returned: offset < 16 ? 8 : 7, hasMore: offset < 16 });
      expect(result.nextOffset).toBe(offset < 16 ? offset + 8 : undefined);
      expect(result.tools.every((tool) => !!tool.inputSchema === (detail === 'schema'))).toBe(true);
      seen.push(...result.tools.map((tool) => tool.name));
    }
    expect(seen).toEqual(expected.sort((a, b) => a.localeCompare(b)));
    expect(new Set(seen).size).toBe(23);
  });

  it('paginates ranked searches and preserves the default first page', () => {
    for (let i = 0; i < 9; i += 1) register(`canvas_query_${i}`);
    const first = searchMcpToolCatalog(context, { query: 'canvas_query' });
    expect(first).toEqual(searchMcpToolCatalog(context, { query: 'canvas_query', offset: 0 }));
    expect(first).toMatchObject({ total: 10, returned: 5, hasMore: true, nextOffset: 5 });
    expect(first.tools[0].name).toBe('canvas_query');
    const last = searchMcpToolCatalog(context, { query: 'canvas_query', offset: first.nextOffset });
    expect(last).toMatchObject({ total: 10, returned: 5, hasMore: false });
    expect(last.nextOffset).toBeUndefined();
    expect(new Set([...first.tools, ...last.tools].map((tool) => tool.name)).size).toBe(10);
  });

  it('rejects invalid offsets and distinguishes navigation, an exhausted page and no matches', () => {
    for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(() => searchMcpToolCatalog(context, { category: 'canvas', offset })).toThrow('参数无效');
    }
    expect(searchMcpToolCatalog(context, { offset: 0 })).toEqual(searchMcpToolCatalog(context, {}));
    expect(() => searchMcpToolCatalog(context, { offset: 1 })).toThrow('类别导航不分页');
    const exhausted = searchMcpToolCatalog(context, { category: 'canvas', offset: Number.MAX_SAFE_INTEGER });
    expect(exhausted).toMatchObject({ tools: [], total: 2, returned: 0, hasMore: false });
    expect(exhausted.nextOffset).toBeUndefined();
    expect(exhausted.hint).toContain('offset=0');
    const unmatched = searchMcpToolCatalog(context, { query: 'unmatched-xyz' });
    expect(unmatched).toMatchObject({ tools: [], total: 0, returned: 0, hasMore: false });
    expect(unmatched.hint).toContain('不代表能力不存在');
  });

  it('rechecks current availability on subsequent pages instead of reusing a cached list', () => {
    let enabled = true;
    register('canvas_zzz', { isAvailable: () => enabled });
    const first = searchMcpToolCatalog(context, { category: 'canvas', limit: 2 });
    expect(first).toMatchObject({ total: 3, nextOffset: 2, hasMore: true });
    enabled = false;
    const next = searchMcpToolCatalog(context, { category: 'canvas', offset: first.nextOffset });
    expect(next).toMatchObject({ tools: [], total: 2, returned: 0, hasMore: false });
    expect(() => describeMcpToolCatalog(context, { names: ['canvas_zzz'] })).toThrow('不可用');
  });

  it('marks clipped descriptions and retrieves the original contract without truncation', () => {
    const prefix = '说'.repeat(120);
    const description = `${prefix}明：只接受授权文件，不能读取任意路径。`;
    register('file_import', { description });
    register('file_short', { description: prefix });
    const summary = searchMcpToolCatalog(context, { category: 'file' });
    expect(summary.tools).toMatchObject([
      { name: 'file_import', description: prefix, descriptionTruncated: true },
      { name: 'file_short', description: prefix, descriptionTruncated: false },
    ]);
    expect(summary.hint).toContain('tools_describe');
    expect(summary.hint).toContain('detail=schema');
    const full = describeMcpToolCatalog(context, { names: ['file_import'] });
    expect(full.tools[0]).toMatchObject({ description, descriptionTruncated: false });
    expect(searchMcpToolCatalog(context, { query: 'file_import', detail: 'schema', limit: 1 }).tools).toEqual(full.tools);
  });

  it('rechecks availability and task allowlists after earlier discovery', () => {
    let enabled = true;
    register('plugin_private', { isAvailable: () => enabled });
    expect(describeMcpToolCatalog(context, { names: ['plugin_private'] }).tools).toHaveLength(1);
    enabled = false;
    expect(() => describeMcpToolCatalog(context, { names: ['plugin_private'] })).toThrow('不可用');
    expect(searchMcpToolCatalog(context, { category: 'plugin' }).tools).toHaveLength(0);
    expect(searchMcpToolCatalog({ ...context, mode: 'plan' }, { category: 'canvas' }).tools.map((tool) => tool.name)).toEqual(['canvas_query']);
    expect(searchMcpToolCatalog({ ...context, toolAllowlist: [] }, {})).toMatchObject({ tools: [], total: 0 });
  });

  it('rejects an oversized definition without returning truncated JSON', () => {
    register('canvas_large', { description: '大'.repeat(MCP_CATALOG_MAX_BYTES) });
    const full = describeMcpToolCatalog(context, { names: ['canvas_large'] });
    expect(() => serializeMcpCatalogResult(full)).toThrow('未返回不完整');
    const compact = serializeMcpCatalogResult(searchMcpToolCatalog(context, { query: 'canvas_large' }));
    expect(JSON.parse(compact).tools[0].description.length).toBe(120);
  });

  it('accepts only a single well-formed business call envelope', () => {
    const envelope = { name: 'canvas_query', arguments: {} };
    expect(decodeMcpToolCallEnvelope(envelope)).toEqual(envelope);
    for (const input of [null, [], { name: 'canvas_query' }, { ...envelope, arguments: [] }, { ...envelope, mode: 'autonomous' }]) {
      expect(() => decodeMcpToolCallEnvelope(input)).toThrow('仅接受');
    }
    for (const name of ['tools_call', 'tools_search', 'tools_describe']) {
      expect(() => decodeMcpToolCallEnvelope({ name, arguments: {} })).toThrow('递归');
    }
  });
});

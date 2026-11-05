/**
 * mcpToolCatalog — 回归测试：MCP tool catalog。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  registerAgentTool,
  type AgentToolContext,
  type AgentToolDefinition,
} from '../../../src/services/chat/toolRegistry';
import {
  buildMcpToolOverview,
  decodeMcpToolCallEnvelope,
  describeMcpToolCatalog,
  getConfiguredMcpToolExposure,
  MCP_CATALOG_MAX_BYTES,
  MCP_CALL_DESCRIPTOR,
  searchMcpToolCatalog,
  serializeMcpCatalogResult,
  toMcpToolDescriptor,
} from '../../../src/services/mcp/mcpToolCatalog';
import {
  MCP_GLOBAL_TOOL_NAMES,
  MCP_SETTINGS_CONVERSATION_ID,
  MCP_SETTINGS_SCOPE_ID,
} from '../../../src/services/mcp/mcpSettingsScope';

const context: Omit<AgentToolContext, 'signal'> = {
  taskId: 'catalog-task', projectId: 'project-1', conversationId: 'mcp-control-project-1', mode: 'autonomous',
};
const globalContext: Omit<AgentToolContext, 'signal'> = {
  ...context,
  projectId: MCP_SETTINGS_SCOPE_ID,
  conversationId: MCP_SETTINGS_CONVERSATION_ID,
  toolAllowlist: [...MCP_GLOBAL_TOOL_NAMES],
};

function register(id: string, partial: Partial<AgentToolDefinition> = {}) {
  registerAgentTool({
    id, title: id, description: '查看测试工具', effect: 'read',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    execute: async () => ({ status: 'success', summary: '完成', modelContent: '{}' }),
    ...partial,
  });
}

function overviewEntries(overview: string): Array<{ name: string; title: string; availability: string; description?: string }> {
  const entries: Array<{ name: string; title: string; availability: string; description?: string }> = [];
  let availability: string | undefined;
  for (const line of overview.split('\n')) {
    const group = /^(当前可发现|需打开项目或满足上下文条件)（\d+ 项）$/.exec(line);
    if (group) {
      availability = group[1];
      continue;
    }
    if (!availability) continue;
    const columns = line.split(' | ');
    if (columns.length !== 3 || columns[0] === 'name') continue;
    entries.push({ name: columns[0], title: columns[1], availability,
      ...(columns[2] ? { description: columns[2] } : {}) });
  }
  return entries;
}

beforeEach(() => {
  clearAgentToolRegistryForTests();
  register('canvas_query', { title: '查看画布', description: '读取画布节点与连线。' });
  register('canvas_align', { title: '对齐节点', description: '排列选中的节点。', effect: 'canvas_write' });
  register('media_generate', { title: '生成媒体', description: '生成图片、视频和音乐。', effect: 'media_generation' });
  register('tools_search');
});

describe('MCP tool catalog', () => {
  it('lists every environment tool introduction without schemas or first-page truncation', () => {
    const ids = ['canvas_query', 'canvas_align', 'media_generate'];
    for (let i = 0; i < 12; i += 1) {
      const id = `file_overview_${i}`;
      register(id, { title: `文件工具 ${i}`, description: `读取授权文件 ${i} 的信息。`,
        inputSchema: { type: 'object', properties: { schema_only_marker: { type: 'string' } } } });
      ids.push(id);
    }
    register('tools_describe');
    register('tools_call');
    register('file_unavailable', { isAvailable: () => false });

    const overview = buildMcpToolOverview(context);
    const entries = overviewEntries(overview);

    expect(overview).toContain('当前环境工具简介目录（15 项）');
    expect(overview).toContain('简介不含参数');
    expect(overview).toContain('tools_describe({"names":["canvas_query"]})');
    expect(overview).toContain('tools_call({"name":"canvas_query","arguments":{}})');
    expect(overview).toContain('tools_search({"query":"画布","detail":"schema"})');
    expect(overview).not.toContain('tools_search(detail=');
    expect(overview).toContain('项目或配置变化后重新搜索');
    expect(overview).not.toContain('当前连接尚未打开项目画布');
    expect(overview).toContain('当前可发现（15 项）\nname | title | 简介');
    expect(overview.endsWith('工具简介目录结束。')).toBe(true);
    expect(entries.map((tool) => tool.name)).toEqual(ids.sort((a, b) => a.localeCompare(b)));
    expect(entries.every((tool) => tool.title && tool.description && tool.availability === '当前可发现')).toBe(true);
    expect(overview).not.toContain('inputSchema');
    expect(overview).not.toContain('schema_only_marker');
    expect(overview).not.toContain('file_unavailable');
  });

  it('explains the startup sequence before listing conditional canvas tools', () => {
    register('project_list', { title: '列出项目' });
    register('project_open', { title: '打开项目' });
    const overview = buildMcpToolOverview(globalContext);
    const entries = overviewEntries(overview);
    const steps = [
      'tools_describe({"names":["project_list","project_open"]})',
      'tools_call({"name":"project_list","arguments":{}})',
      'tools_call({"name":"project_open","arguments":{"projectId":"<项目条目的id>"}})',
      'tools_describe({"names":["canvas_query"]})',
      'tools_call({"name":"canvas_query","arguments":{}})',
    ];

    expect(overview).toContain('当前连接尚未打开项目画布；画布工具存在');
    expect(overview).toContain('从 projects 列表选择用户目标条目的 id');
    expect(overview).toContain('不要使用为 null 的 currentProjectId');
    expect(overview).toContain('此时不要混入尚不可发现的画布工具');
    expect(overview).toContain('打开成功后');
    const positions = steps.map((step) => overview.indexOf(step));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(overview.match(/tools_describe\(\{[^\n]*?\}\)/)?.[0]).toBe(steps[0]);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'project_list', availability: '当前可发现' }),
      expect.objectContaining({ name: 'project_open', availability: '当前可发现' }),
      expect.objectContaining({ name: 'canvas_query', availability: '需打开项目或满足上下文条件' }),
    ]));
    expect(searchMcpToolCatalog(globalContext, { query: '*' }).tools.map((tool) => tool.name))
      .toEqual(['project_list', 'project_open']);
  });

  it('keeps multiline and separator text in one row and preserves Unicode characters', () => {
    register('file_table_escape', { title: '查看\n猫🐈|节点', description: '说明|第一行\r\n第二行' });
    register('file_unicode', { description: '😀'.repeat(49) });

    const entries = overviewEntries(buildMcpToolOverview(context));

    expect(entries.find((tool) => tool.name === 'file_table_escape')).toMatchObject({
      title: '查看 猫🐈／节点', description: '说明／第一行 第二行',
    });
    expect(entries.find((tool) => tool.name === 'file_unicode')?.description).toBe('😀'.repeat(48));
    expect(entries).toHaveLength(5);
  });

  it('labels tools outside the actual allowlist without changing discovery scope or its real context', () => {
    const scoped = { ...context, toolAllowlist: ['canvas_query'] };
    register('file_other_context', { isAvailable: (current) => current.projectId !== context.projectId });
    const before = searchMcpToolCatalog(scoped, { query: '*' });

    const entries = overviewEntries(buildMcpToolOverview(scoped));

    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'canvas_query', availability: '当前可发现' }),
      expect.objectContaining({ name: 'canvas_align', availability: '需打开项目或满足上下文条件' }),
      expect.objectContaining({ name: 'media_generate', availability: '需打开项目或满足上下文条件' }),
    ]));
    expect(entries.some((tool) => tool.name === 'file_other_context')).toBe(false);
    expect(scoped.toolAllowlist).toEqual(['canvas_query']);
    expect(searchMcpToolCatalog(scoped, { query: '*' })).toEqual(before);
    expect(() => describeMcpToolCatalog(scoped, { names: ['canvas_align'] })).toThrow('不可用');
  });

  it.each([
    // 200 行仅合成工具占 27 + 3*titleLength + 3*descriptionLength 字节/行；
    // 60 字标题的 48 字简介、88 字标题的 24 字简介分别已超 64 KiB。
    { titleLength: 60, descriptionLength: 24 },
    { titleLength: 88, descriptionLength: 0 },
  ])('shortens only descriptions to fit the overview budget (title length $titleLength)', ({ titleLength, descriptionLength }) => {
    const ids = Array.from({ length: 200 }, (_, index) => `canvas_overview_${String(index).padStart(3, '0')}`);
    for (const id of ids) register(id, { title: '题'.repeat(titleLength), description: '介'.repeat(60) });

    const overview = buildMcpToolOverview(context);
    const entries = overviewEntries(overview);
    const added = entries.filter((tool) => ids.includes(tool.name));

    expect(new TextEncoder().encode(JSON.stringify(overview)).byteLength).toBeLessThanOrEqual(MCP_CATALOG_MAX_BYTES);
    expect(added.map((tool) => tool.name)).toEqual(ids);
    expect(added.every((tool) => tool.title === '题'.repeat(titleLength))).toBe(true);
    expect(added.every((tool) => descriptionLength ? tool.description?.length === descriptionLength : tool.description === undefined)).toBe(true);
  });

  it('rejects an oversized overview instead of returning partial tool identities', () => {
    register('canvas_complete_tool_identity', { title: '题'.repeat(MCP_CATALOG_MAX_BYTES) });

    expect(() => buildMcpToolOverview(context)).toThrow('未返回不完整的工具目录');
    expect(getAgentTool('canvas_complete_tool_identity')?.title).toHaveLength(MCP_CATALOG_MAX_BYTES);
  });

  it('keeps connection rules on invocation and creation contracts without repeating them on discovery entries', () => {
    for (const id of ['tools_describe', 'canvas_create_nodes', 'shotlist_prepare_production', 'episode_create_shotlist']) register(id);
    const descriptors = [MCP_CALL_DESCRIPTOR, ...[
      'canvas_create_nodes', 'shotlist_prepare_production', 'episode_create_shotlist',
    ].map((id) => toMcpToolDescriptor(getAgentTool(id)!))];
    for (const descriptor of descriptors) {
      expect(descriptor.description.indexOf('素材引用优先级：')).toBeGreaterThan(0);
      expect(descriptor.description).toContain('drama_reference_image_add');
      expect(descriptor.description).toContain('dramaAssetId');
      expect(descriptor.description).toContain('sourceId（提供内容）→ targetId（消费内容）');
      expect(descriptor.description).toContain('sourceHandle=right、targetHandle=left');
      expect(descriptor.description).toContain('默认紧凑排布');
      expect(descriptor.description).toContain('水平间距通常为 48–64');
      expect(descriptor.description).toContain('常规新建省略 x/y');
      expect(descriptor.description).toContain('分镜表 → 导演台');
      expect(descriptor.description).toContain('通过镜头来源关联成果');
      expect(descriptor.description).toContain('分镜表不是视频生成的必建前置');
      expect(descriptor.description).toContain('并先查询复用已有表');
      expect(descriptor.description).toContain('canvas_bind_shotlist_frame');
      expect(descriptor.description).toContain('生成时融合其最新景别、运镜、内容、对白');
      expect(descriptor.description).toContain('不要重复连接');
      expect(descriptor.description).toContain('canvas_query(detail=true)');
      expect(descriptor.description).toContain('layout.warning');
    }
    expect(descriptors[0].description.startsWith('执行工具：')).toBe(true);
    for (const descriptor of descriptors.slice(1)) {
      expect(descriptor.description.startsWith(getAgentTool(descriptor.name)!.description)).toBe(true);
    }
    const search = toMcpToolDescriptor(getAgentTool('tools_search')!);
    const describeTools = toMcpToolDescriptor(getAgentTool('tools_describe')!);
    expect(search.description.startsWith('查找工具：')).toBe(true);
    expect(search.description).toContain('tools_search({"query":"*","limit":8})');
    expect(search.description).toContain('tools_search({"query":"画布","detail":"schema"})');
    expect(describeTools.description.startsWith('读取参数：')).toBe(true);
    expect(describeTools.description).toContain('不要将未激活的画布工具混入同一批');
    for (const descriptor of [search, describeTools]) {
      expect(descriptor.description).not.toContain('素材引用优先级：');
      expect(descriptor.description).not.toContain('不要把导演台反接回分镜表');
    }
    expect(search.inputSchema).toBe(getAgentTool('tools_search')!.inputSchema);
    expect(MCP_CALL_DESCRIPTOR.annotations?.readOnlyHint).toBe(false);
  });

  it('returns tools before guidance without repeating unrelated production rules', () => {
    const results = [
      searchMcpToolCatalog(context, {}),
      searchMcpToolCatalog(context, { query: '*' }),
      searchMcpToolCatalog(context, { category: 'canvas' }),
      searchMcpToolCatalog(context, { query: 'canvas_query', detail: 'schema' }),
      searchMcpToolCatalog(context, { query: 'unmatched-xyz' }),
      searchMcpToolCatalog(context, { category: 'canvas', offset: 99 }),
      describeMcpToolCatalog(context, { names: ['canvas_query'] }),
    ];
    for (const result of results) {
      const serialized = serializeMcpCatalogResult(result);
      expect(serialized.startsWith('{"tools":')).toBe(true);
      const decoded = JSON.parse(serialized);
      expect(decoded.tools).toEqual(result.tools);
      expect(decoded.hint).toBe(result.hint);
      expect(serialized).not.toContain('素材引用优先级：');
      expect(serialized).not.toContain('不要把导演台反接回分镜表');
    }
  });

  it('preserves production rules and complete schemas when reading creation contracts', () => {
    const ids = ['canvas_create_nodes', 'shotlist_prepare_production', 'episode_create_shotlist'];
    for (const id of ids) register(id, { inputSchema: {
      type: 'object', properties: { contract_marker: { type: 'string', description: '完整参数' } },
    } });
    const result = describeMcpToolCatalog(context, { names: ids });
    const decoded = JSON.parse(serializeMcpCatalogResult(result));

    expect(decoded.tools).toEqual(result.tools);
    expect(decoded.tools.every((tool: { inputSchema?: unknown }) => tool.inputSchema)).toBe(true);
    expect(decoded.hint).toContain('素材引用优先级：');
    expect(decoded.hint).toContain('不要把导演台反接回分镜表');
    expect(decoded.hint).toContain('不把制作节点反接回所属分镜表输入');
    expect(decoded.hint).toContain('分镜表不是视频生成的必建前置');
    expect(decoded.hint).toContain('video_editor_create 的 shotlistNodeId');
  });

  it('guides global-context searches and unavailable describes through navigation before canvas discovery', () => {
    register('project_list');
    register('project_open');
    const navigation = searchMcpToolCatalog(globalContext, {});
    const missing = searchMcpToolCatalog(globalContext, { query: 'canvas_query', detail: 'schema' });
    const guidance = [navigation.hint, missing.hint];

    expect(navigation.tools).toEqual([]);
    expect(missing.tools).toEqual([]);
    for (const hint of guidance) {
      expect(hint).toContain('当前连接未打开项目画布');
      expect(hint).toContain('tools_describe({"names":["project_list","project_open"]})');
      expect(hint).toContain('打开用户指定项目');
      expect(hint).toContain('成功后重新读取目标工具参数');
      expect(hint).toContain('project_get 读取资料不会打开画布');
    }
    expect(describeMcpToolCatalog(globalContext, { names: ['project_list', 'project_open'] }).tools.map((tool) => tool.name))
      .toEqual(['project_list', 'project_open']);
    expect(() => describeMcpToolCatalog(globalContext, { names: ['canvas_query'] }))
      .toThrow('当前连接未打开项目画布');
    expect(() => describeMcpToolCatalog(globalContext, { names: ['project_open', 'canvas_query'] }))
      .toThrow('tools_describe({"names":["project_list","project_open"]})');
    expect(globalContext.toolAllowlist).toEqual([...MCP_GLOBAL_TOOL_NAMES]);
    for (const result of [navigation, missing]) {
      expect(serializeMcpCatalogResult(result)).not.toContain('素材引用优先级：');
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
    expect(searchMcpToolCatalog(context, {}).hint).toContain('tools_search({"query":"*","limit":8})');
  });

  it('browses every available tool with a short introduction and preserves category and permission filters', () => {
    const expected = ['canvas_query', 'canvas_align', 'media_generate'];
    for (let i = 0; i < 12; i += 1) {
      const id = `file_probe_${i}`;
      register(id, { title: `读取文件 ${i}`, description: '查看授权文件的信息。' });
      expected.push(id);
    }
    register('file_hidden', { isAvailable: () => false });
    const first = searchMcpToolCatalog(context, { query: '*', limit: 8 });
    const last = searchMcpToolCatalog(context, { query: '*', limit: 8, offset: first.nextOffset });
    expect(first).toMatchObject({ total: 15, returned: 8, hasMore: true, nextOffset: 8 });
    expect(last).toMatchObject({ total: 15, returned: 7, hasMore: false });
    expect(last.nextOffset).toBeUndefined();
    const tools = [...first.tools, ...last.tools];
    expect(tools.map((tool) => tool.name)).toEqual(expected.sort((a, b) => a.localeCompare(b)));
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(15);
    expect(tools.every((tool) => tool.title && tool.description && tool.description.length <= 120 && !tool.inputSchema)).toBe(true);
    expect(first.hint).toContain('不要把本页当作全部能力');
    expect(searchMcpToolCatalog(context, { query: ' * ', category: 'canvas' }).tools.map((tool) => tool.name))
      .toEqual(['canvas_align', 'canvas_query']);
    expect(searchMcpToolCatalog({ ...context, mode: 'plan' }, { query: '*', category: 'canvas' }).tools.map((tool) => tool.name))
      .toEqual(['canvas_query']);
    expect(searchMcpToolCatalog({ ...context, toolAllowlist: [] }, { query: '*' }))
      .toMatchObject({ tools: [], total: 0, returned: 0, hasMore: false });
    expect(searchMcpToolCatalog(context, { query: '*', offset: 99 }).hint).toContain('offset=0');
    expect(searchMcpToolCatalog(context, { query: 'unmatched*' }).tools).toHaveLength(0);
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
    expect(searchMcpToolCatalog(context, { query: '*', category: 'canvas', detail: 'schema' }).tools
      .find((tool) => tool.name === 'canvas_text')!.inputSchema).toEqual(schema);
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

  it('accepts optional context preconditions outside the business arguments', () => {
    const args = { value: 'business-only' };
    for (const expectation of [{ expectedProjectId: 'project-1' }, { expectedProjectId: 'project-1', expectedRevision: 0 }]) {
      const envelope = { name: 'canvas_query', arguments: args, ...expectation };
      const decoded = decodeMcpToolCallEnvelope(envelope);
      expect(decoded).toEqual(envelope);
      expect(decoded.arguments).toBe(args);
      expect(decoded.arguments).toEqual({ value: 'business-only' });
    }
    expect(() => decodeMcpToolCallEnvelope({ name: 'canvas_query', arguments: {}, expectedRevision: 0 }))
      .toThrow('expectedRevision 必须同时提供 expectedProjectId');
  });

  it('rejects malformed project and revision preconditions without coercion', () => {
    const envelope = { name: 'canvas_query', arguments: {}, expectedProjectId: 'project-1' };
    for (const expectation of [{ expectedProjectId: '' }, { expectedProjectId: 1 }, { expectedRevision: -1 },
      { expectedRevision: 1.5 }, { expectedRevision: '1' }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { expectedRevision: NaN }, { expectedRevision: Infinity }]) {
      expect(() => decodeMcpToolCallEnvelope({ ...envelope, ...expectation })).toThrow('仅接受');
    }
  });

  it('keeps optional operation keys outside business arguments and explains replay limits', () => {
    const argumentsValue = { nodeIds: ['node-from-query'], prompt: 'business-only' };
    const envelope = { name: 'canvas_update_nodes', arguments: argumentsValue, operationKey: 'edit-intent-1' };
    const decoded = decodeMcpToolCallEnvelope(envelope);
    expect(decoded).toEqual(envelope);
    expect(decoded.arguments).toBe(argumentsValue);
    expect(decoded.arguments).not.toHaveProperty('operationKey');
    expect(MCP_CALL_DESCRIPTOR.description).toContain('与 name/arguments 同级');
    expect(MCP_CALL_DESCRIPTOR.description).toContain('直接调用原工具名保持兼容');
    expect(MCP_CALL_DESCRIPTOR.description).toContain('不承诺跨重启幂等');
    expect(MCP_CALL_DESCRIPTOR.description).toContain('不能用新 key 自动重投');
    for (const operationKey of ['', ' ', 'with space', 'path/key', 'x'.repeat(129), 1, null]) {
      expect(() => decodeMcpToolCallEnvelope({ ...envelope, operationKey })).toThrow();
    }
  });
});

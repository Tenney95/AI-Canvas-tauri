/** MCP 的有界工具目录。定义始终来自 Registry，不缓存可用性或授权。 */
import type {
  McpToolCallEnvelope,
  McpToolCatalogEntry,
  McpToolCatalogResult,
  McpToolDescribeInput,
  McpToolDescriptor,
  McpToolExposure,
  McpToolSearchInput,
} from '../../types/mcp';
import { validateAgentToolInput, type AgentToolSchema } from '../chat/agentToolSchemas';
import { AGENT_NODE_LAYOUT_GUIDANCE } from '../chat/agentCanvasLayout';
import { isMcpGlobalContext } from './mcpSettingsScope';
import {
  getAvailableAgentTools,
  type AgentToolContext,
  type AgentToolDefinition,
} from '../chat/toolRegistry';

export const MCP_DISCOVERY_TOOL_NAMES = ['tools_search', 'tools_describe'] as const;
export const MCP_CALL_TOOL_NAME = 'tools_call';
export const MCP_CATALOG_MAX_BYTES = 64 * 1024;
const MAX_SEARCH_RESULTS = 8;
const MAX_DESCRIBE_TOOLS = 3;
const CONNECTION_RULE_TOOLS = new Set(['canvas_create_nodes', 'shotlist_prepare_production', 'episode_create_shotlist']);
const OPEN_PROJECT_GUIDANCE = '当前连接未打开项目画布。先用 tools_describe({"names":["project_list","project_open"]}) 读取导航参数，再通过 tools_call 列出并打开用户指定项目；成功后重新读取目标工具参数。project_get 读取资料不会打开画布。';

const MCP_CONNECTION_RULES = `素材引用优先级：先查 drama_asset_list/get（scope=project/global 均含人物、场景、道具），已入库的角色、场景、道具优先使用返回的 @drama 引用（多图用精确参考图 mention），无需创建节点或连线。imageReady=false 时先生成并用 drama_reference_image_add 绑定；仅项目资产的新建参考图可在 canvas_create_nodes 传 dramaAssetId；全局资产先生成图片，再以 scope=global 调用 drama_reference_image_add 绑定。只有未入库素材或真实节点依赖才引用节点。画布连线规则：sourceId（提供内容）→ targetId（消费内容），右出左入（sourceHandle=right、targetHandle=left）。${AGENT_NODE_LAYOUT_GUIDANCE}分镜表 → 导演台，镜头说明 → 导演台，不要把导演台反接回分镜表。分镜表不是视频生成的必建前置；单纯制作视频直接新建 ai-video，只有需要逐镜审稿、统一时长或按表剪辑时才创建 ai-shotlist，并先查询复用已有表。选用分镜表流程时，以镜头行为制作依据，按行调用 shotlist_prepare_production 准备视频和配音，通过镜头来源关联成果，不把制作节点反接回所属分镜表输入，也不把整表作为每个视频的普通输入，不默认额外复制每镜全文为文本节点。就绪成片用 canvas_bind_shotlist_frame 回填独立的生成视频列，图片仍绑定画面列作为参考；时间轴只采用生成视频列，按需用 video_editor_create 的 shotlistNodeId 装配。视频使用 shotlist_read 返回的 mention 精确引用某镜，生成时融合其最新景别、运镜、内容、对白、音效和备注，并保留胶囊外的附加要求。分镜表→视频节点，不引用整表；排序改号按稳定镜头 ID 跟随。旧手写提示词保留，不自动替换。创建或制作工具可能自动连线，prompt 中的 @ 节点引用也会在创建时自动连线，不要重复连接。操作前后用 canvas_query(detail=true) 核对实际方向、端口与 layout.warning，发现异常先修正再继续。`;

// 只补类别词汇；具体工具的名称、说明和 schema 全部来自注册中心。
const categories: Record<string, { title: string; keywords: string }> = {
  app: { title: '应用状态', keywords: '应用 状态 application status models 模型' },
  canvas: { title: '画布节点', keywords: '画布 节点 连线 排列 canvas nodes edges layout align' },
  project: { title: '项目', keywords: '项目 工程 project workspace' },
  media: { title: '媒体生成', keywords: '生成 图片 视频 音频 生图 音乐 image video audio generation generate' },
  video: { title: '视频剪辑', keywords: '视频 剪辑 时间轴 字幕 转场 音乐 音量 导出 验片 抽帧 video timeline edit export preview probe frames' },
  director: { title: '导演台', keywords: '导演 摄影机 镜头 渲染 blender camera render director' },
  skill: { title: 'Skill', keywords: '技能 技能包 智能体包 skill instructions' },
  plugin: { title: '插件窗口', keywords: '插件 窗口 plugin window' },
  provider: { title: '厂商配置', keywords: '厂商 接入 配置 中转站 provider api configuration' },
  comfyui: { title: 'ComfyUI', keywords: 'comfy comfyui 工作流 节点' },
  workflow: { title: '工作流', keywords: '工作流 workflow comfyui' },
  preset: { title: '快捷指令', keywords: '快捷指令 预设 preset automation' },
  style: { title: '画风', keywords: '画风 风格 style' },
  drama: { title: '短剧资产', keywords: '角色 人物 场景 道具 短剧 drama character assets' },
  series: { title: '剧集', keywords: '剧集 剧本 原著 series script' },
  shotlist: { title: '分镜表', keywords: '分镜 镜头 表格 补图 shotlist shot frames' },
  episode: { title: '分集', keywords: '分集 大纲 episode outline' },
  file: { title: '文件', keywords: '文件 授权 读取 保存 file grant read save' },
  history: { title: '历史', keywords: '历史 撤销 重做 history undo redo' },
  memory: { title: '项目记忆', keywords: '记忆 偏好 memory preference' },
  agent: { title: '智能体', keywords: '智能体 子任务 专家 agent expert task' },
  conversation: { title: '对话', keywords: '对话 会话 消息 conversation chat' },
  ui: { title: '界面', keywords: '界面 面板 截图 ui panel screenshot' },
  window: { title: '应用窗口', keywords: '应用 窗口 大小 位置 window size position' },
};

export function getConfiguredMcpToolExposure(value: unknown): McpToolExposure {
  return value === 'full' ? 'full' : 'compact';
}

export function isMcpDiscoveryTool(name: string): boolean {
  return name === MCP_CALL_TOOL_NAME
    || MCP_DISCOVERY_TOOL_NAMES.some((id) => id === name);
}

export const MCP_SEARCH_SCHEMA: AgentToolSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    query: { type: 'string', maxLength: 240, description: '需求、工具名或关键词；传 "*" 逐页浏览全部当前可用工具的名称和简介，省略时查看类别导航。' },
    category: { type: 'string', minLength: 1, maxLength: 64, description: '类别 ID，可从无参数搜索的导航中获取。' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: '默认 5。' },
    offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: '默认 0；保持 query/category 不变，使用上次 nextOffset 继续翻页。目录会随当前可用能力变化，不是固定快照。无 query/category 时仅允许 0。' },
    detail: { type: 'string', enum: ['summary', 'schema'], description: '默认 summary；schema 同时返回命中工具的完整参数，避免再调用 tools_describe。' },
  },
};

export const MCP_DESCRIBE_SCHEMA: AgentToolSchema = {
  type: 'object', required: ['names'], additionalProperties: false,
  properties: {
    names: { type: 'array', minItems: 1, maxItems: MAX_DESCRIBE_TOOLS, items: { type: 'string', minLength: 1, maxLength: 128 } },
  },
};

/** 这是传输信封，必须解包后按目标工具 effect 执行，不能注册成 read 执行器。 */
export const MCP_CALL_DESCRIPTOR: McpToolDescriptor = {
  name: MCP_CALL_TOOL_NAME,
  title: '调用 AI Canvas 工具',
  description: `执行工具：用真实工具名 name 和参数对象 arguments 调用一个业务工具，例如 {"name":"canvas_query","arguments":{}}。先用 tools_search 查找、tools_describe 读取完整参数；已知参数可直接复用。可能写入、删除或调用付费模型，按目标工具权限执行；写入和生成失败后不要自动重试。不支持递归调用发现入口。\n${MCP_CONNECTION_RULES}`,
  inputSchema: {
    type: 'object', required: ['name', 'arguments'], additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 128, description: '搜索结果中的工具名。' },
      arguments: { type: 'object', additionalProperties: true, description: '符合目标工具完整 schema 的参数对象；无参数时传 {}。' },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

export function decodeMcpToolCallEnvelope(input: unknown): McpToolCallEnvelope {
  if (!validateAgentToolInput(MCP_CALL_DESCRIPTOR.inputSchema, input).valid) {
    throw new Error('tools_call 需要且仅接受 name 字符串和 arguments 对象；请按 tools_describe 的 schema 提交参数。');
  }
  const envelope = input as McpToolCallEnvelope;
  if (isMcpDiscoveryTool(envelope.name)) {
    throw new Error('tools_call 不允许递归调用 tools_call、tools_search 或 tools_describe；请直接调用发现入口。');
  }
  return envelope;
}

export function toMcpToolDescriptor(definition: AgentToolDefinition): McpToolDescriptor {
  const showConnectionRules = CONNECTION_RULE_TOOLS.has(definition.id);
  const introduction = definition.id === 'tools_search'
    ? '查找工具：已知简介目录中的工具名时，直接用 tools_describe 读取参数；不知道名称才调用 tools_search({"query":"画布","detail":"schema"})。也可调用 tools_search({"query":"*","limit":8}) 分页浏览，用 nextOffset 继续至 hasMore=false；三个入口或单页结果不等于只有这些能力。'
    : definition.id === 'tools_describe'
      ? '读取参数：已打开项目后，调用 tools_describe({"names":["canvas_query"]}) 获取完整参数，再用 tools_call 执行。未打开项目时先只读取 project_list、project_open；不要将未激活的画布工具混入同一批。搜索已返回完整 schema 时无需重复读取。'
      : '';
  const description = [introduction, definition.description, showConnectionRules ? MCP_CONNECTION_RULES : '']
    .filter(Boolean).join('\n');
  return {
    name: definition.id, title: definition.title,
    description,
    inputSchema: definition.inputSchema,
  };
}

function availableTools(context: Omit<AgentToolContext, 'signal'>): AgentToolDefinition[] {
  return getAvailableAgentTools(context).filter((tool) => !isMcpDiscoveryTool(tool.id));
}

/** 初始简介仅展示潜在能力，不改变真实 MCP 上下文或执行阶段的允许列表。 */
export function buildMcpToolOverview(context: Omit<AgentToolContext, 'signal'>): string {
  const currentIds = new Set(availableTools(context).map((tool) => tool.id));
  const candidates = availableTools({ ...context, toolAllowlist: undefined })
    .sort((a, b) => a.id.localeCompare(b.id));
  const introduction = [
    `当前环境工具简介目录（${candidates.length} 项），简介不含参数。`,
    ...(isMcpGlobalContext(context) ? [
      '当前连接尚未打开项目画布；画布工具存在，列在下方条件组。请按以下顺序逐次调用：',
      '1. tools_describe({"names":["project_list","project_open"]}) 读取导航参数；此时不要混入尚不可发现的画布工具。',
      '2. tools_call({"name":"project_list","arguments":{}}) 列出项目。',
      '3. 从 projects 列表选择用户目标条目的 id，作为 projectId：tools_call({"name":"project_open","arguments":{"projectId":"<项目条目的id>"}})。不要使用为 null 的 currentProjectId。',
      '4. 打开成功后，tools_describe({"names":["canvas_query"]}) 读取画布参数。',
      '5. tools_call({"name":"canvas_query","arguments":{}}) 读取画布；其他业务工具也先读取对应参数再调用。',
    ] : [
      '已知下列工具名时，直接用 tools_describe({"names":["canvas_query"]}) 读取完整参数，再用 tools_call({"name":"canvas_query","arguments":{}}) 执行。',
    ]),
    '不知道工具名时，用 tools_search({"query":"画布","detail":"schema"}) 搜索并读取参数；不要省略 query。project_get 读取项目资料不等于已打开画布。',
    '项目或配置变化后重新搜索，不根据初始缓存判断工具不存在。以下列出本次全部候选工具；仅简介可能按预算缩短，简介不是执行授权。',
  ];
  const groups = [
    { title: '当前可发现', tools: candidates.filter((tool) => currentIds.has(tool.id)) },
    { title: '需打开项目或满足上下文条件', tools: candidates.filter((tool) => !currentIds.has(tool.id)) },
  ];
  const singleLine = (value: string) => value.replace(/\s+/g, ' ').replace(/\|/g, '／').trim();
  for (const descriptionLimit of [48, 24, 0]) {
    const overview = [
      ...introduction,
      ...groups.flatMap((group) => [
        `${group.title}（${group.tools.length} 项）`,
        'name | title | 简介',
        ...group.tools.map((tool) => `${tool.id} | ${singleLine(tool.title)} | ${Array.from(singleLine(tool.description)).slice(0, descriptionLimit).join('')}`),
      ]),
      '工具简介目录结束。',
    ].join('\n');
    // 按描述字符串的完整 JSON 编码计量，包含换行与引号转义，不截断工具 ID 或标题。
    if (new TextEncoder().encode(JSON.stringify(overview)).byteLength <= MCP_CATALOG_MAX_BYTES) return overview;
  }
  throw new Error('当前环境工具简介目录超过 64 KiB 预算，无法完整列出工具 ID 和标题；本次未返回不完整的工具目录。');
}

function categoryId(tool: AgentToolDefinition): string {
  return tool.id.split('_')[0];
}

function entry(tool: AgentToolDefinition, full: boolean): McpToolCatalogEntry {
  return {
    name: tool.id, title: tool.title, category: categoryId(tool), effect: tool.effect,
    description: full ? tool.description : tool.description.slice(0, 120),
    descriptionTruncated: !full && tool.description.length > 120,
    ...(full ? { inputSchema: tool.inputSchema } : {}),
  };
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
}

function searchTerms(query: string): string[] {
  const terms = new Set(query.match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? []);
  // 中文连续句使用双字词召回；不依赖额外分词模型。
  for (const word of [...terms]) {
    if (/\p{Script=Han}/u.test(word) && word.length > 2) {
      for (let i = 0; i < word.length - 1; i += 1) terms.add(word.slice(i, i + 2));
    }
  }
  return [...terms];
}

function score(tool: AgentToolDefinition, query: string, terms: string[]): number {
  const id = normalize(tool.id);
  if (id === query) return 10_000;
  const title = normalize(tool.title);
  const description = normalize(tool.description);
  const keywords = normalize(categories[categoryId(tool)]?.keywords ?? categoryId(tool));
  let weight = (id.includes(query) ? 100 : 0) + (title.includes(query) ? 80 : 0)
    + (description.includes(query) ? 20 : 0);
  for (const term of terms) {
    weight += (id.includes(term) ? 12 : 0) + (title.includes(term) ? 10 : 0)
      + (description.includes(term) ? 2 : 0) + (keywords.includes(term) ? 1 : 0);
  }
  return weight;
}

export function serializeMcpCatalogResult(result: McpToolCatalogResult): string {
  const { hint, ...catalog } = result;
  const guidance = [hint, catalog.tools.some((tool) => CONNECTION_RULE_TOOLS.has(tool.name)) ? MCP_CONNECTION_RULES : '']
    .filter(Boolean).join('\n');
  const json = JSON.stringify({ ...catalog, ...(guidance ? { hint: guidance } : {}) });
  if (new TextEncoder().encode(json).byteLength > MCP_CATALOG_MAX_BYTES) {
    throw new Error('工具定义超过单次返回预算，请减小 limit、改用 summary，或使用 tools_describe 每次读取一个工具；本次未返回不完整的 schema。');
  }
  return json;
}

export function searchMcpToolCatalog(
  context: Omit<AgentToolContext, 'signal'>,
  input: McpToolSearchInput,
): McpToolCatalogResult {
  if (!validateAgentToolInput(MCP_SEARCH_SCHEMA, input).valid) throw new Error('工具搜索参数无效');
  const tools = availableTools(context);
  const query = normalize(input.query ?? '');
  const category = normalize(input.category ?? '');
  const offset = input.offset ?? 0;
  if (!query && !category) {
    if (offset !== 0) throw new Error('类别导航不分页；请指定 query 或 category 后使用 offset。');
    const counts = new Map<string, number>();
    for (const tool of tools) counts.set(categoryId(tool), (counts.get(categoryId(tool)) ?? 0) + 1);
    return {
      tools: [], total: tools.length,
      categories: [...counts].sort(([a], [b]) => a.localeCompare(b)).slice(0, 32)
        .map(([id, count]) => ({ id, title: categories[id]?.title ?? id, count })),
      hint: `${isMcpGlobalContext(context) ? `${OPEN_PROJECT_GUIDANCE}\n` : ''}这里是类别导航，不是完整工具清单。调用 tools_search({"query":"*","limit":8}) 逐页查看所有可用工具的名称、中文标题和简介；也可按单个目的用 query 搜索或用 category 浏览。摘要不含完整参数，descriptionTruncated=true 表示说明也被截断；调用前使用 detail=schema 或 tools_describe 获取完整定义，已知参数可复用。`,
    };
  }
  const browseAll = query === '*';
  const terms = searchTerms(query);
  const matches = tools.filter((tool) => !category || categoryId(tool) === category)
    .map((tool) => ({ tool, weight: query && !browseAll ? score(tool, query, terms) : 1 }))
    .filter(({ weight }) => weight > 0)
    .sort((a, b) => b.weight - a.weight || a.tool.id.localeCompare(b.tool.id));
  const page = matches.slice(offset, offset + (input.limit ?? 5));
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < matches.length;
  return {
    tools: page.map(({ tool }) => entry(tool, input.detail === 'schema')),
    total: matches.length,
    returned: page.length,
    hasMore,
    ...(hasMore ? { nextOffset } : {}),
    hint: !matches.length
      ? (isMcpGlobalContext(context) ? OPEN_PROJECT_GUIDANCE
        : '未找到匹配工具，不代表能力不存在。请缩短为单个目的、使用工具 ID，或用 query="*" 逐页查看当前可用工具；未打开项目时请先发现并调用 project_list / project_open。')
      : !page.length
        ? 'offset 已超出当前匹配结果，请从 offset=0 重新查询；工具可用性可能已变化。'
        : `${browseAll ? '这是当前可用工具的分页清单，尚有后续页时不要把本页当作全部能力。' : '匹配结果不等于全部能力，多步骤需求请拆开搜索；不确定名称时用 query="*" 浏览全部。'}hasMore=true 时保持 query/category 不变，用 nextOffset 作为 offset 继续，直到 hasMore=false；目录随当前项目和配置变化。摘要不含完整参数，descriptionTruncated=true 表示说明也被截断；调用前用 detail=schema 或 tools_describe 获取完整定义，已知参数可直接复用 tools_call。`,
  };
}

export function describeMcpToolCatalog(
  context: Omit<AgentToolContext, 'signal'>,
  input: McpToolDescribeInput,
): McpToolCatalogResult {
  if (!validateAgentToolInput(MCP_DESCRIBE_SCHEMA, input).valid) throw new Error('每次需要读取 1 至 3 个工具名');
  const current = new Map(availableTools(context).map((tool) => [tool.id, tool]));
  const selected = [...new Set(input.names)].map((name) => current.get(name));
  if (selected.some((tool) => !tool)) {
    throw new Error(isMcpGlobalContext(context) ? OPEN_PROJECT_GUIDANCE : '请求的工具不可用或未注册，请重新搜索当前可用工具');
  }
  return { tools: selected.map((tool) => entry(tool!, true)), total: selected.length };
}

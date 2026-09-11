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
    query: { type: 'string', maxLength: 240, description: '需求、工具名或关键词；省略时查看类别导航。' },
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
  description: '用 tools_search / tools_describe 获取真实工具名和参数后，在 name 和 arguments 中提交一次调用；已知参数可直接复用。可能写入、删除或调用付费模型，按目标工具权限执行；写入和生成失败后不要自动重试。不支持递归调用发现入口。',
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
  return {
    name: definition.id, title: definition.title,
    description: definition.description, inputSchema: definition.inputSchema,
  };
}

function availableTools(context: Omit<AgentToolContext, 'signal'>): AgentToolDefinition[] {
  return getAvailableAgentTools(context).filter((tool) => !isMcpDiscoveryTool(tool.id));
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
  const json = JSON.stringify(result);
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
      hint: '按单个目的使用 query 搜索或用 category 逐页浏览；匹配结果不等于全部能力。摘要不含完整参数，descriptionTruncated=true 表示说明也被截断；调用前使用 detail=schema 或 tools_describe 获取完整定义，已知参数可复用。',
    };
  }
  const terms = searchTerms(query);
  const matches = tools.filter((tool) => !category || categoryId(tool) === category)
    .map((tool) => ({ tool, weight: query ? score(tool, query, terms) : 1 }))
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
      ? '未找到匹配工具，不代表能力不存在。请缩短为单个目的、使用工具 ID，或省略参数查看类别后逐页浏览。'
      : !page.length
        ? 'offset 已超出当前匹配结果，请从 offset=0 重新查询；工具可用性可能已变化。'
        : '匹配结果不等于全部能力，多步骤需求请拆开搜索。hasMore=true 时保持 query/category 不变，用 nextOffset 继续；目录随当前可用能力变化。摘要不含完整参数，descriptionTruncated=true 表示说明也被截断；调用前用 detail=schema 或 tools_describe 获取完整定义，已知参数可直接复用 tools_call。',
  };
}

export function describeMcpToolCatalog(
  context: Omit<AgentToolContext, 'signal'>,
  input: McpToolDescribeInput,
): McpToolCatalogResult {
  if (!validateAgentToolInput(MCP_DESCRIBE_SCHEMA, input).valid) throw new Error('每次需要读取 1 至 3 个工具名');
  const current = new Map(availableTools(context).map((tool) => [tool.id, tool]));
  const selected = [...new Set(input.names)].map((name) => current.get(name));
  if (selected.some((tool) => !tool)) throw new Error('请求的工具不可用或未注册，请重新搜索当前可用工具');
  return { tools: selected.map((tool) => entry(tool!, true)), total: selected.length };
}

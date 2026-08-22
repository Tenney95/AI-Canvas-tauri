/**
 * 通过原生受限读取接口获取 Provider 文档，并提取标题、正文与同源候选链接。
 */
import { invoke } from '@tauri-apps/api/core';
import { normalizeProviderDocUrl } from './chat/providerDocsGrantService';
import { shouldRenderDynamicHtml } from './webPageService';

interface NativeProviderDocsResponse {
  url: string;
  status: number;
  contentType: string;
  body: string;
  fetchedAt: number;
}
export interface ProviderDocLink {
  label: string;
  url: string;
}

export interface ProviderDocsPage {
  title: string;
  url: string;
  text: string;
  links: ProviderDocLink[];
  fetchedAt: number;
  truncated: boolean;
  /** 本页正文总长度（未截断前），用于告诉助手还剩多少没读。 */
  totalTextChars: number;
  /** 续读时应传的下一个 offset；已读完为 undefined。 */
  nextOffset?: number;
  /** 站点公开模型清单按分类分好组的可直接转述文本；非中转站为 undefined。 */
  modelCatalog?: string;
}

/**
 * 按 offset 取一段正文。
 *
 * 单页上限 10k 字，长文档页（参数表 + 多个请求示例）经常超过——以前直接 slice(0, limit)
 * 丢掉后半段，助手既看不到剩下的字段，也没有任何办法把它读回来，只能凭印象编请求体。
 */
export function sliceDocText(text: string, offset: number, limit: number): {
  text: string;
  truncated: boolean;
  totalTextChars: number;
  nextOffset?: number;
} {
  const start = Math.min(Math.max(0, Math.floor(offset)), text.length);
  const slice = text.slice(start, start + limit);
  const end = start + slice.length;
  return {
    text: slice,
    truncated: end < text.length,
    totalTextChars: text.length,
    ...(end < text.length ? { nextOffset: end } : {}),
  };
}

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);
const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'IFRAME', 'FORM']);
const LINK_HINT_RE = /api|model|endpoint|reference|image|video|audio|chat|模型|接口|图片|视频|音频|对话/i;

function structuredText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element) || IGNORED_TAGS.has(node.tagName)) return '';
  if (node.tagName === 'BR') return '\n';
  if (node.tagName === 'PRE') return `\n\`\`\`\n${node.textContent ?? ''}\n\`\`\`\n`;
  const content = [...node.childNodes].map(structuredText).join('');
  return BLOCK_TAGS.has(node.tagName) ? `\n${content}\n` : content;
}

function normalizeText(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n[\t ]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractHtmlPage(body: string, finalUrl: string): {
  title: string;
  text: string;
  links: ProviderDocLink[];
} {
  const parser = new DOMParser();
  const document = parser.parseFromString(body, 'text/html');
  const title = normalizeText(document.querySelector('title')?.textContent ?? '')
    || new URL(finalUrl).hostname;
  const linksByUrl = new Map<string, ProviderDocLink>();
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    let resolved: string;
    try {
      resolved = new URL(anchor.getAttribute('href') || '', finalUrl).toString();
    } catch {
      continue;
    }
    const normalized = normalizeProviderDocUrl(resolved);
    if (!normalized || normalized.length > 512) continue;
    const label = normalizeText(anchor.textContent ?? '').slice(0, 100) || new URL(normalized).pathname;
    if (!linksByUrl.has(normalized)) linksByUrl.set(normalized, { label, url: normalized });
  }
  const root = document.querySelector('article, main') ?? document.body;
  const text = root ? normalizeText(structuredText(root)) : '';
  const links = [...linksByUrl.values()]
    .sort((left, right) => Number(LINK_HINT_RE.test(right.label + right.url))
      - Number(LINK_HINT_RE.test(left.label + left.url)));
  return { title, text, links };
}

// ---- new-api（New API）中转站识别 ----

interface NewApiPricingItem {
  model_name?: unknown;
  display_name?: unknown;
  description?: unknown;
  model_price?: unknown;
  supported_endpoint_types?: unknown;
}

export interface NewApiStatusInfo {
  systemName?: string;
  announcements: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从模型 ID、显示名与端点类型推断模型类别，返回中文标签，供模型映射到
 * text / image / video / audio 配置枚举。
 */
export function inferRelayModelCategory(item: NewApiPricingItem): string {
  const types = Array.isArray(item.supported_endpoint_types)
    ? item.supported_endpoint_types
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase()
    : '';
  const idName = `${String(item.model_name ?? '')} ${String(item.display_name ?? '')}`.toLowerCase();
  const haystack = `${types} ${idName}`;
  if (/video|seedance|sora|veo|kling|hailuo|wan\d|skyreels|vidu|minimax/.test(haystack)) return '视频';
  if (/image|seedream|imagen|flux|banana|midjourney|recraft|dall-e|drawing/.test(haystack)) return '图片';
  if (/audio|tts|speech|music|voice|whisper|transcri/.test(haystack)) return '音频';
  return '文本';
}

/** 解析 /api/pricing 响应，返回 new-api 模型项；非 new-api 结构返回 null。 */
export function parseNewApiPricingPayload(body: string): NewApiPricingItem[] | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(payload) || !Array.isArray(payload.data)) return null;
  const items = payload.data
    .filter(isRecord)
    .filter((item) => typeof item.model_name === 'string' && item.model_name.trim() !== '');
  return items.length > 0 ? (items as unknown as NewApiPricingItem[]) : null;
}

/** 解析 /api/status 响应，提取站名与公告；非 new-api 结构返回 null。 */
export function parseNewApiStatusPayload(body: string): NewApiStatusInfo | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(payload) || !isRecord(payload.data)) return null;
  const data = payload.data;
  const announcements = Array.isArray(data.announcements)
    ? data.announcements
      .filter(isRecord)
      .map((item) => (typeof item.content === 'string' ? item.content.trim() : ''))
      .filter(Boolean)
    : [];
  const systemName = typeof data.system_name === 'string' ? data.system_name.trim() : undefined;
  if (!systemName && announcements.length === 0) return null;
  return { systemName, announcements };
}

/** 把 new-api 模型清单与公告拼成可读文档正文。 */
export function buildRelayCatalogContent(
  rawUrl: string,
  pricing: NewApiPricingItem[],
  status: NewApiStatusInfo | null,
): { title: string; text: string } {
  const hostname = new URL(rawUrl).hostname;
  const title = status?.systemName || hostname;
  const lines = [
    `这是 new-api（New API）中转站「${title}」的公开模型清单。`,
    '该站文档页是登录后台，无法匿名读取正文；以下信息来自公开接口 /api/pricing 与 /api/status，可直接用于生成配置草稿。',
    '',
    `模型清单（共 ${pricing.length} 个）：`,
  ];
  pricing.forEach((item, index) => {
    const id = String(item.model_name ?? '').trim();
    const name = typeof item.display_name === 'string' && item.display_name.trim()
      ? item.display_name.trim()
      : id;
    const endpointTypes = Array.isArray(item.supported_endpoint_types)
      ? item.supported_endpoint_types.filter((value): value is string => typeof value === 'string')
      : [];
    lines.push(`${index + 1}. ${id}`);
    lines.push(`   显示名：${name}`);
    lines.push(`   类型：${inferRelayModelCategory(item)}`);
    if (endpointTypes.length > 0) lines.push(`   端点类型：${endpointTypes.join('、')}`);
    if (typeof item.model_price === 'number') lines.push(`   价格：¥${item.model_price}/次`);
    if (typeof item.description === 'string' && item.description.trim()) {
      lines.push(`   说明：${item.description.trim().replace(/\s+/g, ' ')}`);
    }
  });
  if (status && status.announcements.length > 0) {
    lines.push('', '站内公告（来源 /api/status，含最新模型与请求提示）：');
    for (const announcement of status.announcements.slice(0, 15)) {
      const condensed = normalizeText(announcement).slice(0, 400);
      if (condensed) lines.push(`- ${condensed}`);
    }
  }
  lines.push(
    '',
    '【请求体字段务必以该模型自己的文档为准】',
    '中转站聚合了各家上游，同一类模型的字段名差异很大（宽高比可能叫 aspect_ratio / size / ratio，',
    '参考图可能叫 images / image_urls / image）。请求体里出现该模型不认识的字段，接口会直接返回',
    '400 unsupported field，所以：',
    '- 文档给了「请求示例」JSON 时，原样把它作为 submitRequest 传给 provider_config_preview，不要改字段名、不要补字段。',
    '- 文档只给了参数表时，只写表里列出的字段；表里没有的一律不写。',
    '- 文档标注为「固定能力」的参数（如固定时长、枚举取值、参考图上限），用 videoCapability 声明出来（视频模型），别只写进请求体。',
    '',
    '仅在完全读不到该模型文档时，才可退回到以下 new-api 通用约定（读得到文档就不要用）：',
    '- 文本：POST /v1/chat/completions，OpenAI 标准 {model, messages}。',
    '- 图片：POST /v1/images/generations，OpenAI 标准 {model, prompt, size, n}。',
    '- 视频：POST /v1/videos，异步任务，用 /v1/videos/{任务ID} 轮询。',
    '- 音频：POST /v1/audio/speech，OpenAI 标准 {model, input, voice}。',
    '',
    '本项目按字段名把画布上的宽高比、分辨率、时长、数量与连线的参考素材映射进请求体；',
    '文档里没有参考素材字段，就说明该模型不接参考图，不要自己编一个。',
  );
  return { title, text: lines.join('\n') };
}

async function probeNewApiPricing(
  origin: string,
  signal?: AbortSignal,
): Promise<NewApiPricingItem[] | null> {
  if (signal?.aborted) return null;
  try {
    const response = await invoke<NativeProviderDocsResponse>(
      'provider_docs_read',
      { url: `${origin}/api/pricing` },
    );
    if (!response.contentType.startsWith('application/json')) return null;
    return parseNewApiPricingPayload(response.body);
  } catch {
    return null;
  }
}

async function probeNewApiStatus(
  origin: string,
  signal?: AbortSignal,
): Promise<NewApiStatusInfo | null> {
  if (signal?.aborted) return null;
  try {
    const response = await invoke<NativeProviderDocsResponse>(
      'provider_docs_read',
      { url: `${origin}/api/status` },
    );
    if (!response.contentType.startsWith('application/json')) return null;
    return parseNewApiStatusPayload(response.body);
  } catch {
    return null;
  }
}

/** 文档站首页（模型总列表所在页）才值得额外探一次公开清单。 */
function isDocsIndexUrl(rawUrl: string): boolean {
  const path = new URL(rawUrl).pathname.replace(/\/+$/, '');
  return path === '' || path === '/docs' || path === '/api-docs' || path === '/doc';
}

/**
 * 把公开模型清单按 文本/图片/视频/音频 分好组，供助手原样转述给用户挑选。
 *
 * 助手自己从上万字的文档正文里归纳分类清单很不稳定（实测会直接跳过不列），
 * 这里用 /api/pricing 的结构化数据把清单拼好，它只需要照搬。
 */
export function buildGroupedModelChoiceList(pricing: NewApiPricingItem[]): string {
  const groups = new Map<string, string[]>();
  for (const item of pricing) {
    const id = String(item.model_name ?? '').trim();
    if (!id) continue;
    const name = typeof item.display_name === 'string' && item.display_name.trim()
      ? item.display_name.trim()
      : id;
    const category = inferRelayModelCategory(item);
    const lines = groups.get(category) ?? [];
    groups.set(category, lines);
    lines.push(`  - ${name} —— ${id}`);
  }
  const ordered = ['文本', '图片', '视频', '音频'].filter((category) => groups.has(category));
  if (ordered.length === 0) return '';
  return ordered
    .map((category) => [`【${category}】`, ...(groups.get(category) ?? [])].join('\n'))
    .join('\n');
}

async function readNewApiRelayCatalog(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<ProviderDocsPage | null> {
  const origin = new URL(rawUrl).origin;
  const pricing = await probeNewApiPricing(origin, signal);
  if (!pricing) return null;
  const status = await probeNewApiStatus(origin, signal);
  const content = buildRelayCatalogContent(rawUrl, pricing, status);
  return {
    title: content.title,
    url: rawUrl,
    text: content.text,
    links: [],
    fetchedAt: Date.now(),
    truncated: false,
    totalTextChars: content.text.length,
  };
}

export async function readProviderDocsPage(
  rawUrl: string,
  options: { signal?: AbortSignal; maxTextChars?: number; offset?: number } = {},
): Promise<ProviderDocsPage> {
  const normalized = normalizeProviderDocUrl(rawUrl);
  if (!normalized) throw new Error('厂商文档 URL 未通过本地安全校验');
  if (typeof window === 'undefined' || !('__TAURI__' in window)) {
    throw new Error('厂商文档读取仅在 Tauri 桌面环境可用');
  }
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  let response = await invoke<NativeProviderDocsResponse>('provider_docs_read', { url: normalized });
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  let finalUrl = normalizeProviderDocUrl(response.url);
  if (!finalUrl || new URL(finalUrl).origin !== new URL(normalized).origin) {
    throw new Error('厂商文档最终地址未通过同站安全校验');
  }

  let extracted = response.contentType.startsWith('application/json')
    ? { title: new URL(finalUrl).hostname, text: normalizeText(response.body), links: [] }
    : extractHtmlPage(response.body, finalUrl);

  // SPA 文档站先走受控渲染，拿到真实正文与同站链接。
  //
  // 顺序很重要：/api/pricing 兜底是按 origin 探测的，一旦排在渲染之前，同一站点下
  // 任何读不到正文的页面（包括 /docs/videos/{模型ID} 这种单模型文档页）都会被换成
  // 那份只有模型 ID 的清单，助手永远看不到真实字段名，只能自己编请求体。
  if (!extracted.text && shouldRenderDynamicHtml(response.body, response.contentType, extracted.text)) {
    // 渲染是尽力而为：SPA 首屏偶尔会超时，此时应退到下面的公开清单兜底，
    // 而不是让整次文档读取失败（渲染排到兜底之前后，抛错会直接吞掉兜底路径）。
    let rendered: NativeProviderDocsResponse | undefined;
    try {
      rendered = await invoke<NativeProviderDocsResponse>('assistant_web_render', { url: finalUrl });
    } catch (error) {
      console.warn('[providerDocs] 动态渲染失败，退回公开清单兜底', finalUrl, error);
      rendered = undefined;
    }
    if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    const renderedUrl = rendered ? normalizeProviderDocUrl(rendered.url) : null;
    if (rendered && (!renderedUrl || new URL(renderedUrl).origin !== new URL(normalized).origin)) {
      throw new Error('厂商文档渲染后的最终地址未通过同站安全校验');
    }
    if (rendered && renderedUrl) {
      response = rendered;
      finalUrl = renderedUrl;
      extracted = response.contentType.startsWith('application/json')
        ? { title: new URL(finalUrl).hostname, text: normalizeText(response.body), links: [] }
        : extractHtmlPage(response.body, finalUrl);
    }
  }

  // 渲染后仍读不到正文（如需要登录的后台 SPA），最后才退回公开模型清单与公告。
  if (!extracted.text) {
    const relay = await readNewApiRelayCatalog(finalUrl, options.signal);
    if (relay) {
      const limit = Math.max(1, Math.min(options.maxTextChars ?? 10_000, 10_000));
      return { ...relay, ...sliceDocText(relay.text, options.offset ?? 0, limit) };
    }
    throw new Error(
      '厂商文档页面没有可读取的正文；该页面可能是需要登录的后台 SPA，无法匿名读取。'
      + '请改用公开的模型清单/状态接口，或请用户直接提供模型列表与请求示例，不要重复读取同一地址。',
    );
  }
  // 文档首页额外附一份分好类的模型清单：让助手转述现成结构，而不是从长正文里自己归纳
  const pricing = isDocsIndexUrl(finalUrl)
    ? await probeNewApiPricing(new URL(finalUrl).origin, options.signal)
    : null;
  const modelCatalog = pricing ? buildGroupedModelChoiceList(pricing) : '';

  const limit = Math.max(1, Math.min(options.maxTextChars ?? 10_000, 10_000));
  return {
    title: extracted.title,
    url: finalUrl,
    links: extracted.links.slice(0, 24),
    fetchedAt: response.fetchedAt,
    ...sliceDocText(extracted.text, options.offset ?? 0, limit),
    ...(modelCatalog ? { modelCatalog } : {}),
  };
}

/**
 * 通过原生受限读取接口获取 Provider 文档，并提取标题、正文与同源候选链接。
 */
import { invoke } from '@tauri-apps/api/core';
import type { NativeWebReadResponse, WebReadStatus, WebSource, WebReadAccessScope, WebReadContinuation, WebReadDocument, WebReadSection, WebReadPage } from '../types/chat';
import type { ProviderModelCatalogSummary, ProviderModelChoice } from '../types/agent';
import { readWebSession } from './chat/webReadSessionService';
import { createProviderModelCatalog } from './chat/providerModelCatalogService';
import { normalizeProviderDocUrl } from './chat/providerDocsGrantService';
import { extractWebReadResponse, shouldRenderDynamicHtml } from './webPageService';
export interface ProviderDocLink {
  label: string;
  url: string;
}

export interface ProviderDocsPage extends WebReadStatus {
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
  readSessionId?: string;
  nextCursor?: string;
  sections?: WebReadSection[];
  catalog?: ProviderModelCatalogSummary;
  /** 当前返回的片段，不进入持久化来源元数据。 */
  pages?: WebReadPage[];
  /** 站点公开模型清单按分类分好组的可直接转述文本；非中转站为 undefined。 */
  modelCatalog?: string;
  /** 仅来源元数据，不携带整页正文。 */
  sources: WebSource[];
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

const LINK_HINT_RE = /api|model|endpoint|reference|image|video|audio|chat|模型|接口|图片|视频|音频|对话/i;

function normalizeText(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n[\t ]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    '未读取到目标文档（可能需要登录或渲染失败）；以下信息来自公开接口 /api/pricing 与 /api/status，只是模型目录，不能代替目标模型的接口文档。',
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
    '只有文档明确声明 OpenAI / new-api 兼容时，才可采用对应的标准约定：',
    '- 文本：POST /v1/chat/completions，OpenAI 标准 {model, messages}。',
    '- 图片：POST /v1/images/generations，OpenAI 标准 {model, prompt, size, n}。',
    '- 视频：没有跨厂商统一端点；文档缺失时停止配置，禁止猜测 /v1/videos、/videos/generations 或轮询路径。',
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
    const response = await invoke<NativeWebReadResponse>(
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
    const response = await invoke<NativeWebReadResponse>(
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
  scope?: WebReadAccessScope,
  authorize?: () => boolean,
): Promise<ProviderDocsPage | null> {
  const origin = new URL(rawUrl).origin;
  const pricing = await probeNewApiPricing(origin, signal);
  if (!pricing) return null;
  const status = await probeNewApiStatus(origin, signal);
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  if (scope && !authorize?.()) throw new Error('厂商文档授权已失效');
  const catalog = scope ? catalogFromPricing(scope, pricing) : undefined;
  const content = catalog
    ? { title: status?.systemName || new URL(rawUrl).hostname,
        text: `公开模型目录共 ${catalog.total} 个候选。目录不是接口文档；选择后必须核对每个模型的请求、响应与轮询字段。` }
    : buildRelayCatalogContent(rawUrl, pricing, status);
  const fetchedAt = Date.now();
  return {
    title: content.title,
    catalog,
    url: `${origin}/api/pricing`,
    text: content.text,
    links: [],
    fetchedAt,
    truncated: false,
    totalTextChars: content.text.length,
    readMethod: 'catalog',
    complete: false,
    issues: ['catalog_fallback'],
    sources: ['pricing', ...(status ? ['status'] : [])].map((endpoint) => ({
      id: `catalog-${fetchedAt}-${endpoint}`, title: `公开 ${endpoint} 接口`,
      url: `${origin}/api/${endpoint}`, domain: new URL(origin).hostname, fetchedAt, sourceType: 'page',
    })),
    ...(catalog && status ? { pages: [{
      source: { id: `catalog-${fetchedAt}-status`, title: '站点状态与公告', url: `${origin}/api/status`,
        domain: new URL(origin).hostname, fetchedAt, sourceType: 'page' as const },
      text: [`站点名称：${status.systemName || new URL(origin).hostname}`,
        ...status.announcements.slice(0, 15).map((text) => normalizeText(text).slice(0, 400))].join('\n'),
      links: [], truncated: status.announcements.length > 15,
    }] } : {}),
  };
}

function catalogFromPricing(scope: WebReadAccessScope, pricing: NewApiPricingItem[]) {
  const categories: Record<string, ProviderModelChoice['category']> = { 文本: 'text', 图片: 'image', 视频: 'video', 音频: 'audio' };
  return createProviderModelCatalog(scope, pricing.map((item) => ({ id: String(item.model_name).trim(),
    name: typeof item.display_name === 'string' && item.display_name.trim() ? item.display_name.trim() : String(item.model_name).trim(),
    category: categories[inferRelayModelCategory(item)] })));
}

interface ProviderDocsReadOptions extends WebReadContinuation {
  signal?: AbortSignal;
  maxTextChars?: number;
  scope?: WebReadAccessScope;
  authorize?: () => boolean;
}

export async function readProviderDocsPage(rawUrl: string, options: ProviderDocsReadOptions = {}): Promise<ProviderDocsPage> {
  if (options.scope) {
    const result = await readWebSession({ ...options, scope: options.scope, url: rawUrl, kind: 'docs',
      limit: Math.max(1, Math.min(options.maxTextChars ?? 10_000, 10_000)), authorize: options.authorize ?? (() => false) },
    () => loadProviderDocsDocument(rawUrl, options));
    return { ...result, title: result.source.title, url: result.source.url, fetchedAt: result.source.fetchedAt,
      totalTextChars: result.totalTextChars!, sources: result.pages.map((page) => page.source),
      links: result.links.map((link) => ({ label: link.title, url: link.url })) };
  }
  const document = await loadProviderDocsDocument(rawUrl, options);
  return clipProviderDocsDocument(document, options);
}

async function loadProviderDocsDocument(
  rawUrl: string,
  options: ProviderDocsReadOptions,
): Promise<WebReadDocument & { modelCatalog?: string; legacyRelay?: ProviderDocsPage }> {
  const normalized = normalizeProviderDocUrl(rawUrl);
  if (!normalized) throw new Error('厂商文档 URL 未通过本地安全校验');
  if (typeof window === 'undefined' || !('__TAURI__' in window || '__TAURI_INTERNALS__' in window)) {
    throw new Error('厂商文档读取仅在 Tauri 桌面环境可用');
  }
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  let response = await invoke<NativeWebReadResponse>('provider_docs_read', { url: normalized });
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  const finalUrl = normalizeProviderDocUrl(response.url);
  if (!finalUrl || new URL(finalUrl).origin !== new URL(normalized).origin) {
    throw new Error('厂商文档最终地址未通过同站安全校验');
  }

  const expectedOrigin = new URL(normalized).origin;
  let extracted = extractWebReadResponse(response, { expectedOrigin, linkLimit: 200 });

  // SPA 文档站先走受控渲染，拿到真实正文与同站链接。
  //
  // 顺序很重要：/api/pricing 兜底是按 origin 探测的，一旦排在渲染之前，同一站点下
  // 任何读不到正文的页面（包括 /docs/videos/{模型ID} 这种单模型文档页）都会被换成
  // 那份只有模型 ID 的清单，助手永远看不到真实字段名，只能自己编请求体。
  if (!response.pages && shouldRenderDynamicHtml(response.body, response.contentType, extracted.pages[0]?.text ?? '')) {
    // 渲染是尽力而为：SPA 首屏偶尔会超时，此时应退到下面的公开清单兜底，
    // 而不是让整次文档读取失败（渲染排到兜底之前后，抛错会直接吞掉兜底路径）。
    let rendered: NativeWebReadResponse | undefined;
    try {
      rendered = await invoke<NativeWebReadResponse>('assistant_web_render', { url: finalUrl });
    } catch {
      extracted.complete = false;
      extracted.issues.push('render_failed');
      rendered = undefined;
    }
    if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (rendered) {
      response = rendered;
      extracted = extractWebReadResponse(response, { expectedOrigin, linkLimit: 200, readMethod: 'rendered' });
    }
  }

  // 渲染后仍读不到正文（如需要登录的后台 SPA），最后才退回公开模型清单与公告。
  const readablePages = extracted.pages.filter((page) => page.text);
  if (!readablePages.length) {
    const relay = await readNewApiRelayCatalog(finalUrl, options.signal, options.scope, options.authorize);
    if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (relay) {
      return {
        readMethod: relay.readMethod, complete: relay.complete, issues: relay.issues, catalog: relay.catalog,
        pages: [{ source: relay.sources[0], text: relay.text, links: [], truncated: false }, ...(relay.pages ?? [])],
        legacyRelay: options.scope ? undefined : relay,
      };
    }
    throw new Error(
      '厂商文档页面没有可读取的正文；该页面可能是需要登录的后台 SPA，无法匿名读取。'
      + '请改用公开的模型清单/状态接口，或请用户直接提供模型列表与请求示例，不要重复读取同一地址。',
    );
  }
  // 文档首页额外附一份分好类的模型清单：让助手转述现成结构，而不是从长正文里自己归纳
  const directPricing = response.contentType.startsWith('application/json') ? parseNewApiPricingPayload(response.body) : null;
  const pricing = directPricing ?? (isDocsIndexUrl(finalUrl)
    ? await probeNewApiPricing(new URL(finalUrl).origin, options.signal)
    : null);
  const modelCatalog = pricing && !options.scope ? buildGroupedModelChoiceList(pricing) : '';
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  if (options.scope && !options.authorize?.()) throw new Error('厂商文档授权已失效');
  const catalog = pricing && options.scope ? catalogFromPricing(options.scope, pricing) : undefined;
  const pages = directPricing && catalog
    ? [{ ...readablePages[0], text: `公开模型目录共 ${catalog.total} 个候选。目录不是接口文档，选择后需要读取对应接口页。` }]
    : readablePages;
  return { ...extracted, pages, catalog, modelCatalog: modelCatalog || undefined };
}

function clipProviderDocsDocument(document: WebReadDocument & { modelCatalog?: string; legacyRelay?: ProviderDocsPage }, options: ProviderDocsReadOptions): ProviderDocsPage {
  if (document.legacyRelay) {
    const sliced = sliceDocText(document.legacyRelay.text, options.offset ?? 0, Math.max(1, Math.min(options.maxTextChars ?? 10_000, 10_000)));
    return { ...document.legacyRelay, ...sliced,
      issues: [...document.issues, ...(sliced.truncated || (options.offset ?? 0) > 0 ? ['text_limit' as const] : [])] };
  }
  const readablePages = document.pages;
  const expectedOrigin = new URL(readablePages[0].source.url).origin;
  const limit = Math.max(1, Math.min(options.maxTextChars ?? 10_000, 10_000));
  let position = 0;
  const sections = readablePages.map((page) => {
    const text = `标题: ${page.source.title}\nURL: ${page.source.url}\n${page.text}`;
    const start = position;
    position += text.length + 2;
    return { text, source: page.source, start, end: position - 2 };
  });
  const content = sections.map((section) => section.text).join('\n\n');
  const start = Math.min(Math.max(0, Math.floor(options.offset ?? 0)), content.length);
  const sliced = sliceDocText(content, start, limit);
  const sources = sections.filter((section) => section.start < start + sliced.text.length && section.end > start)
    .map((section) => section.source);
  const firstSource = sources[0] ?? readablePages[0].source;
  const links = [...new Map(readablePages.flatMap((page) => page.links)
    .filter((link) => link.url.length <= 512 && new URL(link.url).origin === expectedOrigin && normalizeProviderDocUrl(link.url))
    .map((link) => [link.url, { label: link.title.slice(0, 100), url: link.url }])).values()]
    .sort((left, right) => Number(LINK_HINT_RE.test(right.label + right.url))
      - Number(LINK_HINT_RE.test(left.label + left.url)));
  return {
    title: firstSource.title,
    url: firstSource.url,
    sources,
    links: links.slice(0, 24),
    fetchedAt: firstSource.fetchedAt,
    ...sliced,
    truncated: sliced.truncated || readablePages.some((page) => page.truncated),
    readMethod: document.readMethod,
    complete: document.complete && !sliced.truncated && start === 0,
    issues: [...document.issues, ...(sliced.truncated || start > 0 ? ['text_limit' as const] : [])],
    ...(document.modelCatalog ? { modelCatalog: document.modelCatalog } : {}),
  };
}

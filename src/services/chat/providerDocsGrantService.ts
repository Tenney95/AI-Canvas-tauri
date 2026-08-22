/**
 * 管理任务级 Provider 文档访问图，限制同源链接深度、页面数量和累计文本体积。
 */
// 中转站每个模型一个接口页，逐个读才能拿到真实字段名；页数放宽到能覆盖一站的模型数，
// 真正的安全边界是下面的字符总量（单页最多 10k，超出 80k 一律停读）。
const MAX_PROVIDER_DOC_PAGES = 24;
const MAX_PROVIDER_DOC_DEPTH = 2;
const MAX_PROVIDER_DOC_TEXT_CHARS = 80_000;
const MAX_DISCOVERED_LINKS = 80;

interface ProviderDocGrant {
  url: string;
  origin: string;
  depth: number;
}

interface ProviderDocsTaskState {
  grants: Map<string, ProviderDocGrant>;
  readUrls: Set<string>;
  reservedUrls: Set<string>;
  completedPages: number;
  totalTextChars: number;
}

export interface ProviderDocReadReservation extends ProviderDocGrant {
  taskId: string;
  conversationId?: string;
  /** 去重键：同一 URL 的不同 offset 段算不同次读取，续读长文档才不会被当成重复。 */
  readKey: string;
}

export interface ProviderDocReadCompletion {
  depth: number;
  discoveredUrls: string[];
  remainingPages: number;
  remainingTextChars: number;
}

const taskStates = new Map<string, ProviderDocsTaskState>();
/**
 * 会话级授权表：同一会话里已授权 / 已发现的文档链接。
 *
 * 「先列模型问用户，再读选中模型的接口页」这个流程天然跨两个任务：列清单的任务结束后，
 * 用户的选择会开一个新任务，而新任务的 goal 里没有 URL。授权只按任务存的话，
 * 第二轮连第一轮发现的模型接口页都读不了，整个流程直接卡死。
 * 只放宽「允许读哪些地址」，页数与字符预算仍然按任务独立计算。
 */
const conversationGrants = new Map<string, Map<string, ProviderDocGrant>>();

function rememberConversationGrant(conversationId: string | undefined, grant: ProviderDocGrant): void {
  if (!conversationId) return;
  const grants = conversationGrants.get(conversationId) ?? new Map<string, ProviderDocGrant>();
  conversationGrants.set(conversationId, grants);
  if (!grants.has(grant.url)) grants.set(grant.url, grant);
}

function createTaskState(): ProviderDocsTaskState {
  return {
    grants: new Map(),
    readUrls: new Set(),
    reservedUrls: new Set(),
    completedPages: 0,
    totalTextChars: 0,
  };
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
    || normalized.endsWith('.home.arpa')
    || normalized === '::1'
  ) return true;

  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  return octets[0] === 0
    || octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || octets[0] >= 224;
}

export function normalizeProviderDocUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (url.port && url.port !== '443') return null;
    if (isBlockedHostname(url.hostname)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function extractExplicitProviderDocUrls(text: string): string[] {
  const matches = text.match(/https:\/\/[^\s<>"'`]+/gi) ?? [];
  const urls = new Set<string>();
  for (const match of matches) {
    const normalized = normalizeProviderDocUrl(
      match.replace(/[),.;:!?\]}>，。；：！？）】》]+$/u, ''),
    );
    if (normalized) urls.add(normalized);
  }
  return [...urls];
}

function ensureTaskState(
  taskId: string,
  taskGoal: string,
  conversationId?: string,
): ProviderDocsTaskState {
  const state = taskStates.get(taskId) ?? createTaskState();
  taskStates.set(taskId, state);
  for (const url of extractExplicitProviderDocUrls(taskGoal)) {
    if (!state.grants.has(url)) {
      const grant = { url, origin: new URL(url).origin, depth: 0 };
      state.grants.set(url, grant);
      rememberConversationGrant(conversationId, grant);
    }
  }
  // 继承本会话此前已授权 / 已发现的链接，让跨任务的「选完再读」能继续
  for (const [url, grant] of conversationGrants.get(conversationId ?? '') ?? []) {
    if (!state.grants.has(url)) state.grants.set(url, grant);
  }
  return state;
}

/**
 * 已授权地址的子路径视为同样授权。
 *
 * 用户指到 https://站点/docs，那么 /docs/videos/{模型ID} 这类同站子页本就在他授权的范围内。
 * 只靠"读过的页面里发现的链接"授权，一旦首页渲染超时退回公开清单（清单没有链接），
 * 模型接口页就永远读不到，助手只能凭空编请求体——正是这个问题的成因。
 * 仅按已授权 URL 的路径前缀放宽，不放宽到整个域名。
 */
function findPrefixGrant(
  state: ProviderDocsTaskState,
  normalized: string,
): ProviderDocGrant | undefined {
  const target = new URL(normalized);
  for (const grant of state.grants.values()) {
    const base = new URL(grant.url);
    if (base.origin !== target.origin) continue;
    const basePath = base.pathname.replace(/\/+$/, '');
    if (!basePath) continue;
    if (target.pathname === basePath || target.pathname.startsWith(`${basePath}/`)) {
      return { url: normalized, origin: target.origin, depth: grant.depth + 1 };
    }
  }
  return undefined;
}

/** 取已有授权；没有精确匹配时按路径前缀补一条，并记入会话。 */
function resolveGrant(
  state: ProviderDocsTaskState,
  normalized: string,
  conversationId?: string,
): ProviderDocGrant | undefined {
  const exact = state.grants.get(normalized);
  if (exact) return exact;
  const inherited = findPrefixGrant(state, normalized);
  if (!inherited || inherited.depth > MAX_PROVIDER_DOC_DEPTH) return undefined;
  state.grants.set(normalized, inherited);
  rememberConversationGrant(conversationId, inherited);
  return inherited;
}

export function isProviderDocUrlGranted(
  taskId: string,
  taskGoal: string,
  rawUrl: string,
  conversationId?: string,
): boolean {
  const normalized = normalizeProviderDocUrl(rawUrl);
  if (!normalized) return false;
  const state = ensureTaskState(taskId, taskGoal, conversationId);
  return !!resolveGrant(state, normalized, conversationId);
}

export function beginProviderDocRead(
  taskId: string,
  taskGoal: string,
  rawUrl: string,
  conversationId?: string,
  offset = 0,
): ProviderDocReadReservation {
  const normalized = normalizeProviderDocUrl(rawUrl);
  if (!normalized) throw new Error('文档 URL 无效或不满足 HTTPS 安全要求');
  const state = ensureTaskState(taskId, taskGoal, conversationId);
  const grant = resolveGrant(state, normalized, conversationId);
  if (!grant) throw new Error('只能读取用户本轮提供或已读页面发现的同站文档链接');
  // 续读（offset>0）读的是同一页的后半段，按 URL 去重会把它当成重复读取直接拒掉；
  // 用 URL#offset 作键：重复读同一段仍然被挡住，页数与字符预算照旧计入。
  const safeOffset = Math.max(0, Math.floor(offset));
  const readKey = safeOffset > 0 ? `${normalized}#${safeOffset}` : normalized;
  if (state.readUrls.has(readKey) || state.reservedUrls.has(readKey)) {
    throw new Error('该文档页面已读取或正在读取');
  }
  if (state.completedPages + state.reservedUrls.size >= MAX_PROVIDER_DOC_PAGES) {
    throw new Error(`单个任务最多读取 ${MAX_PROVIDER_DOC_PAGES} 个文档页面`);
  }
  if (state.totalTextChars >= MAX_PROVIDER_DOC_TEXT_CHARS) {
    throw new Error('文档正文累计长度已达到任务上限');
  }
  state.reservedUrls.add(readKey);
  return { taskId, conversationId, readKey, ...grant };
}

export function releaseProviderDocRead(reservation: ProviderDocReadReservation): void {
  taskStates.get(reservation.taskId)?.reservedUrls.delete(reservation.readKey);
}

export function getProviderDocRemainingTextChars(taskId: string): number {
  const state = taskStates.get(taskId);
  return Math.max(0, MAX_PROVIDER_DOC_TEXT_CHARS - (state?.totalTextChars ?? 0));
}

export function completeProviderDocRead(
  reservation: ProviderDocReadReservation,
  textChars: number,
  discoveredUrls: string[],
): ProviderDocReadCompletion {
  const state = taskStates.get(reservation.taskId);
  if (!state || !state.reservedUrls.delete(reservation.readKey)) {
    throw new Error('文档读取授权已失效');
  }
  const safeTextChars = Math.max(0, Math.floor(textChars));
  if (state.totalTextChars + safeTextChars > MAX_PROVIDER_DOC_TEXT_CHARS) {
    throw new Error('文档正文累计长度超过任务上限');
  }
  state.readUrls.add(reservation.readKey);
  state.completedPages += 1;
  state.totalTextChars += safeTextChars;

  const nextDepth = reservation.depth + 1;
  const granted: string[] = [];
  if (nextDepth <= MAX_PROVIDER_DOC_DEPTH) {
    for (const rawUrl of discoveredUrls.slice(0, MAX_DISCOVERED_LINKS)) {
      const normalized = normalizeProviderDocUrl(rawUrl);
      if (!normalized || new URL(normalized).origin !== reservation.origin) continue;
      const grant = state.grants.get(normalized)
        ?? { url: normalized, origin: reservation.origin, depth: nextDepth };
      state.grants.set(normalized, grant);
      // 发现的链接同时记进会话，用户下一条消息开的新任务才读得到这些模型接口页
      rememberConversationGrant(reservation.conversationId, grant);
      granted.push(normalized);
    }
  }
  return {
    depth: reservation.depth,
    discoveredUrls: [...new Set(granted)],
    remainingPages: Math.max(0, MAX_PROVIDER_DOC_PAGES - state.completedPages),
    remainingTextChars: Math.max(0, MAX_PROVIDER_DOC_TEXT_CHARS - state.totalTextChars),
  };
}

/** 当前任务允许读取的文档地址，用于把拒绝原因说清楚而不是只说"不允许"。 */
export function listProviderDocGrants(
  taskId: string,
  taskGoal: string,
  conversationId?: string,
): string[] {
  const state = ensureTaskState(taskId, taskGoal, conversationId);
  return [...state.grants.keys()].filter((url) => !state.readUrls.has(url));
}

export function clearProviderDocsTask(taskId: string): void {
  taskStates.delete(taskId);
}

export function clearProviderDocsGrantsForTests(): void {
  taskStates.clear();
  conversationGrants.clear();
}

const MAX_PROVIDER_DOC_PAGES = 8;
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
}

export interface ProviderDocReadCompletion {
  depth: number;
  discoveredUrls: string[];
  remainingPages: number;
  remainingTextChars: number;
}

const taskStates = new Map<string, ProviderDocsTaskState>();

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

function ensureTaskState(taskId: string, taskGoal: string): ProviderDocsTaskState {
  const state = taskStates.get(taskId) ?? createTaskState();
  taskStates.set(taskId, state);
  for (const url of extractExplicitProviderDocUrls(taskGoal)) {
    if (!state.grants.has(url)) {
      state.grants.set(url, { url, origin: new URL(url).origin, depth: 0 });
    }
  }
  return state;
}

export function isProviderDocUrlGranted(
  taskId: string,
  taskGoal: string,
  rawUrl: string,
): boolean {
  const normalized = normalizeProviderDocUrl(rawUrl);
  if (!normalized) return false;
  return ensureTaskState(taskId, taskGoal).grants.has(normalized);
}

export function beginProviderDocRead(
  taskId: string,
  taskGoal: string,
  rawUrl: string,
): ProviderDocReadReservation {
  const normalized = normalizeProviderDocUrl(rawUrl);
  if (!normalized) throw new Error('文档 URL 无效或不满足 HTTPS 安全要求');
  const state = ensureTaskState(taskId, taskGoal);
  const grant = state.grants.get(normalized);
  if (!grant) throw new Error('只能读取用户本轮提供或已读页面发现的同站文档链接');
  if (state.readUrls.has(normalized) || state.reservedUrls.has(normalized)) {
    throw new Error('该文档页面已读取或正在读取');
  }
  if (state.completedPages + state.reservedUrls.size >= MAX_PROVIDER_DOC_PAGES) {
    throw new Error(`单个任务最多读取 ${MAX_PROVIDER_DOC_PAGES} 个文档页面`);
  }
  if (state.totalTextChars >= MAX_PROVIDER_DOC_TEXT_CHARS) {
    throw new Error('文档正文累计长度已达到任务上限');
  }
  state.reservedUrls.add(normalized);
  return { taskId, ...grant };
}

export function releaseProviderDocRead(reservation: ProviderDocReadReservation): void {
  taskStates.get(reservation.taskId)?.reservedUrls.delete(reservation.url);
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
  if (!state || !state.reservedUrls.delete(reservation.url)) {
    throw new Error('文档读取授权已失效');
  }
  const safeTextChars = Math.max(0, Math.floor(textChars));
  if (state.totalTextChars + safeTextChars > MAX_PROVIDER_DOC_TEXT_CHARS) {
    throw new Error('文档正文累计长度超过任务上限');
  }
  state.readUrls.add(reservation.url);
  state.completedPages += 1;
  state.totalTextChars += safeTextChars;

  const nextDepth = reservation.depth + 1;
  const granted: string[] = [];
  if (nextDepth <= MAX_PROVIDER_DOC_DEPTH) {
    for (const rawUrl of discoveredUrls.slice(0, MAX_DISCOVERED_LINKS)) {
      const normalized = normalizeProviderDocUrl(rawUrl);
      if (!normalized || new URL(normalized).origin !== reservation.origin) continue;
      if (!state.grants.has(normalized)) {
        state.grants.set(normalized, {
          url: normalized,
          origin: reservation.origin,
          depth: nextDepth,
        });
      }
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

export function clearProviderDocsTask(taskId: string): void {
  taskStates.delete(taskId);
}

export function clearProviderDocsGrantsForTests(): void {
  taskStates.clear();
}

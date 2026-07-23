import type { WebSource } from '../../types/chat';

const SENSITIVE_QUERY_KEYS = new Set([
  'apikey',
  'authorization',
  'auth',
  'credential',
  'key',
  'password',
  'secret',
  'sig',
  'signature',
  'token',
  'accesstoken',
]);

interface WebAccessTaskState {
  allowedUrls: Set<string>;
  citationByUrl: Map<string, string>;
}

const taskStates = new Map<string, WebAccessTaskState>();

function taskState(taskId: string): WebAccessTaskState {
  const existing = taskStates.get(taskId);
  if (existing) return existing;
  const created: WebAccessTaskState = {
    allowedUrls: new Set(),
    citationByUrl: new Map(),
  };
  taskStates.set(taskId, created);
  return created;
}

function normalizeQueryKey(value: string): string {
  return value.replace(/[\s_-]/g, '').toLowerCase();
}

function isDisallowedIpv4(hostname: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const octets = hostname.split('.').map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return true;
  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isDisallowedIpv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes(':')) return false;
  if (host === '::' || host === '::1') return true;
  if (/^(?:fc|fd|fe8|fe9|fea|feb|ff)/.test(host)) return true;
  if (host.startsWith('2001:db8:')) return true;
  const mapped = host.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  return mapped ? isDisallowedIpv4(mapped) : !/^[23]/.test(host);
}

export function normalizePublicWebUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
    if (!hostname) return null;
    if (
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname.endsWith('.internal')
      || hostname.endsWith('.home.arpa')
      || isDisallowedIpv4(hostname)
      || isDisallowedIpv6(hostname)
    ) return null;
    if (url.port && url.port !== '80' && url.port !== '443') return null;
    if ([...url.searchParams.keys()].some((key) => (
      SENSITIVE_QUERY_KEYS.has(normalizeQueryKey(key))
    ))) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function explicitGoalUrls(goal: string): string[] {
  return (goal.match(/https?:\/\/[^\s<>"']+/gi) ?? [])
    .map((value) => value.replace(/[.,;:!?\])}，。；：！？）】]+$/g, ''))
    .map(normalizePublicWebUrl)
    .filter((value): value is string => value !== null);
}

export function rememberWebSources(taskId: string, sources: WebSource[]): void {
  rememberWebUrls(taskId, sources.map((source) => source.url));
}

export function rememberWebUrls(taskId: string, rawUrls: string[]): void {
  const state = taskState(taskId);
  for (const rawUrl of rawUrls) {
    const normalized = normalizePublicWebUrl(rawUrl);
    if (normalized) state.allowedUrls.add(normalized);
  }
}

export function assignWebSourceCitations(taskId: string, sources: WebSource[]): WebSource[] {
  const state = taskState(taskId);
  const unique = new Map<string, WebSource>();
  for (const source of sources) {
    const normalized = normalizePublicWebUrl(source.url);
    if (!normalized || unique.has(normalized)) continue;
    let citationId = state.citationByUrl.get(normalized);
    if (!citationId) {
      citationId = `S${state.citationByUrl.size + 1}`;
      state.citationByUrl.set(normalized, citationId);
    }
    unique.set(normalized, { ...source, url: normalized, citationId });
  }
  return [...unique.values()];
}

export function isWebUrlAllowed(taskId: string, rawUrl: string, goal: string): boolean {
  const normalized = normalizePublicWebUrl(rawUrl);
  if (!normalized) return false;
  if (taskStates.get(taskId)?.allowedUrls.has(normalized)) return true;
  if (explicitGoalUrls(goal).includes(normalized)) return true;
  return new URL(normalized).protocol === 'https:';
}

export function clearWebAccessTask(taskId: string): void {
  taskStates.delete(taskId);
}

export function clearWebAccessGrantsForTests(): void {
  taskStates.clear();
}

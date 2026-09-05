import type { WebPageResult, WebReadAccessScope, WebReadContinuation, WebReadDocument, WebReadSection } from '../../types/chat';

export const WEB_READ_SESSION_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 24;
const MAX_DOCUMENT_CHARS = 1_000_000;
const MAX_TOTAL_CHARS = 4_000_000;
interface ReadOptions extends WebReadContinuation {
  scope: WebReadAccessScope;
  kind: 'web' | 'docs';
  url: string;
  limit?: number;
  signal?: AbortSignal;
  authorize: () => boolean;
}
interface Session {
  id: string;
  key: string;
  tasks: Set<string>;
  document: WebReadDocument;
  text: string;
  starts: number[];
  sections: WebReadSection[];
  cursors: Map<string, number>;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}
const sessions = new Map<string, Session>();
const pending = new Map<string, { tasks: Set<string>; promise: Promise<Session> }>();

export function webReadScopeKey(scope: WebReadAccessScope): string {
  return JSON.stringify([scope.projectId, scope.conversationId,
    scope.conversationId === `mcp-control-${scope.projectId}` ? 'mcp' : scope.taskId]);
}
function sessionKey(scope: WebReadAccessScope, kind: ReadOptions['kind'], rawUrl: string) {
  const url = new URL(rawUrl); url.hash = '';
  return JSON.stringify([webReadScopeKey(scope), kind, url.href]);
}
/** Metadata-only check used to permit an explicit restart after eviction, without refunding budgets. */
export function hasWebReadSession(scope: WebReadAccessScope, kind: ReadOptions['kind'], url: string): boolean {
  const key = sessionKey(scope, kind, url);
  return [...sessions.values()].some((entry) => entry.key === key && entry.expiresAt > Date.now());
}
function remove(id: string) {
  const entry = sessions.get(id);
  if (entry) clearTimeout(entry.timer);
  sessions.delete(id);
}
function authorize(options: ReadOptions) {
  if (options.signal?.aborted) throw new Error('网页读取已取消');
  if (!options.authorize()) throw new Error('网页读取授权已失效');
}
function save(key: string, options: ReadOptions, value: WebReadDocument): Session {
  const document = structuredClone(value);
  if (!document.pages.length || document.pages.length > 5) throw new Error('网页快照页数超出上限');
  const text = document.pages.map((page) => page.text).join('\n\n');
  if (!text.trim()) throw new Error('网页快照没有可读正文');
  if (text.length > MAX_DOCUMENT_CHARS) throw new Error('网页快照大小超出上限');
  let total = [...sessions.values()].reduce((sum, item) => sum + item.text.length, 0);
  for (const entry of sessions.values()) {
    if (sessions.size < MAX_SESSIONS && total + text.length <= MAX_TOTAL_CHARS) break;
    total -= entry.text.length;
    remove(entry.id);
  }
  const starts: number[] = [];
  const sections: WebReadSection[] = [];
  let offset = 0;
  for (const page of document.pages) {
    starts.push(offset);
    // Linear scan: untrusted whitespace-heavy documents must not trigger regex backtracking.
    let paragraphStart = true;
    for (let start = 0; start < page.text.length && sections.length < 48;) {
      const newline = page.text.indexOf('\n', start);
      const end = newline < 0 ? page.text.length : newline;
      const line = page.text.slice(start, end);
      const title = line.trim();
      if (title && (paragraphStart || /^#{1,6}\s/.test(title))) {
        sections.push({ id: `p${sections.length + 1}`, title: title.slice(0, 80),
          offset: offset + start + line.indexOf(title), url: page.source.url });
      }
      paragraphStart = !title;
      start = end + 1;
    }
    offset += page.text.length + 2;
  }
  const id = crypto.randomUUID();
  const expiresAt = Math.min(Date.now() + WEB_READ_SESSION_TTL_MS, document.catalog?.expiresAt ?? Infinity);
  const entry: Session = { id, key, tasks: new Set([options.scope.taskId]), document, text, starts, sections,
    cursors: new Map(), expiresAt,
    timer: setTimeout(() => remove(id), Math.max(0, expiresAt - Date.now())) };
  sessions.set(id, entry);
  return entry;
}

/** Only bounded snapshots live here. Every access must pass the caller's current grant check. */
export async function readWebSession(options: ReadOptions, loader: () => Promise<WebReadDocument>): Promise<WebPageResult> {
  authorize(options);
  for (const entry of sessions.values()) if (entry.expiresAt <= Date.now()) remove(entry.id);
  const key = sessionKey(options.scope, options.kind, options.url);
  const cursorId = options.cursor?.split(':')[0];
  if (cursorId && options.readSessionId && cursorId !== options.readSessionId) throw new Error('续读游标与快照不匹配');
  const id = options.readSessionId || cursorId;
  let entry = id ? sessions.get(id) : [...sessions.values()].find((item) => item.key === key);
  if (id && !entry) throw new Error('网页续读快照已失效，请从头重新读取');
  if (entry && entry.key !== key) throw new Error('网页续读作用域不匹配');
  if (!entry && (options.cursor || options.section || (options.offset ?? 0) > 0)) throw new Error('缺少有效快照，请从头重新读取');
  if (!entry) {
    let flight = pending.get(key);
    if (!flight) {
      if (pending.size >= MAX_SESSIONS) throw new Error('并发网页快照读取已达到上限');
      flight = { tasks: new Set([options.scope.taskId]), promise: undefined! };
      pending.set(key, flight);
      const identity = flight;
      flight.promise = (async () => {
        try {
          const document = await loader();
          authorize(options);
          if (pending.get(key) !== identity) throw new Error('网页读取任务已失效');
          return save(key, options, document);
        } finally {
          if (pending.get(key) === identity) pending.delete(key);
        }
      })();
    }
    flight.tasks.add(options.scope.taskId);
    entry = await flight.promise;
  }
  authorize(options);
  if (sessions.get(entry.id) !== entry || entry.expiresAt <= Date.now()) throw new Error('网页续读快照已失效');
  entry.tasks.add(options.scope.taskId);
  let offset = options.offset ?? 0;
  if (options.cursor) {
    const location = entry.cursors.get(options.cursor);
    if (location === undefined) throw new Error('无效的网页续读游标');
    offset = location;
  }
  if (options.section) {
    const section = entry.sections.find((item) => item.id === options.section);
    if (!section) throw new Error('网页段落位置不存在');
    offset = section.offset;
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= entry.text.length) throw new Error('网页续读位置超出范围');
  const limit = Math.max(1, Math.min(50_000, Math.floor(options.limit ?? 10_000)));
  if (!Number.isFinite(limit)) throw new Error('网页片段长度无效');
  const end = Math.min(entry.text.length, offset + limit);
  const pages = entry.document.pages.flatMap((page, index) => {
    const start = entry!.starts[index];
    const from = Math.max(offset, start), to = Math.min(end, start + page.text.length);
    return from < to ? [{ ...structuredClone(page), text: entry!.text.slice(from, to),
      truncated: page.truncated || from > start || to < start + page.text.length }] : [];
  });
  let nextCursor: string | undefined;
  if (end < entry.text.length) {
    nextCursor = [...entry.cursors].find(([, value]) => value === end)?.[0] ?? `${entry.id}:${crypto.randomUUID()}`;
    if (entry.cursors.size >= 128 && !entry.cursors.has(nextCursor)) entry.cursors.delete(entry.cursors.keys().next().value!);
    entry.cursors.set(nextCursor, end);
  }
  const partial = offset > 0 || end < entry.text.length;
  return { readMethod: entry.document.readMethod, complete: entry.document.complete && !partial,
    issues: [...new Set([...entry.document.issues, ...(partial ? ['text_limit' as const] : [])])],
    source: structuredClone((pages[0] ?? entry.document.pages[0]).source), pages, text: entry.text.slice(offset, end),
    links: pages.flatMap((page) => page.links).slice(0, 200), truncated: partial || !entry.document.complete,
    readSessionId: entry.id, nextCursor, nextOffset: nextCursor ? end : undefined, totalTextChars: entry.text.length,
    sections: structuredClone(entry.sections), catalog: structuredClone(entry.document.catalog) };
}

export function clearWebReadSessionsForTask(taskId: string) {
  for (const entry of sessions.values()) if (entry.tasks.has(taskId)) remove(entry.id);
  for (const [key, flight] of pending) if (flight.tasks.has(taskId)) pending.delete(key);
}
export function clearWebReadSessionsForTests() {
  for (const id of sessions.keys()) remove(id);
  pending.clear();
}

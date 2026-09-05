import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebReadAccessScope, WebReadDocument } from '../../../src/types/chat';
import { clearWebReadSessionsForTask, clearWebReadSessionsForTests, readWebSession, WEB_READ_SESSION_TTL_MS } from '../../../src/services/chat/webReadSessionService';

const scope: WebReadAccessScope = { projectId: 'p1', conversationId: 'c1', taskId: 't1' };
const url = 'https://example.com/docs';
const options = { scope, url, kind: 'web' as const, limit: 10_000, authorize: () => true };
function document(text = 'start\n\n' + 'x'.repeat(20_000) + '\n\nMIDDLE_MARKER\n\n' + 'z'.repeat(20_000)): WebReadDocument {
  return { readMethod: 'static', complete: true, issues: [], pages: [{
    source: { id: 's', title: 'Docs', url, domain: 'example.com', fetchedAt: 1, sourceType: 'page' }, text, links: [], truncated: false,
  }] };
}
afterEach(() => { clearWebReadSessionsForTests(); vi.useRealTimers(); });

describe('bounded web read sessions', () => {
  it('locates paragraphs in whitespace-heavy input without unbounded regex work', async () => {
    const first = await readWebSession(options, async () => document(`intro\n${' \n'.repeat(50_000)}`));
    expect(first.sections).toMatchObject([{ id: 'p1', title: 'intro', offset: 0 }]);
    await expect(readWebSession({ ...options, readSessionId: first.readSessionId, limit: NaN }, async () => document())).rejects.toThrow('无效');
  });
  it('evicts old documents on total-character and entry-count limits', async () => {
    const first = await readWebSession(options, async () => document('x'.repeat(900_000)));
    for (let index = 1; index < 5; index++) {
      await readWebSession({ ...options, url: `${url}/${index}` }, async () => document('x'.repeat(900_000)));
    }
    await expect(readWebSession({ ...options, readSessionId: first.readSessionId }, async () => document())).rejects.toThrow('失效');
    clearWebReadSessionsForTests();
    const small = await readWebSession(options, async () => document('small'));
    for (let index = 1; index <= 24; index++) await readWebSession({ ...options, url: `${url}/${index}` }, async () => document('small'));
    await expect(readWebSession({ ...options, readSessionId: small.readSessionId }, async () => document())).rejects.toThrow('失效');
  });
  it('reads the middle and final slice of the same snapshot without refetching', async () => {
    const load = vi.fn(async () => document());
    const first = await readWebSession(options, load);
    expect(first.nextOffset).toBe(10_000);
    const middle = await readWebSession({ ...options, readSessionId: first.readSessionId, offset: 20_000 }, load);
    expect(middle.text).toContain('MIDDLE_MARKER');
    const last = await readWebSession({ ...options, readSessionId: first.readSessionId, offset: 40_000 }, load);
    expect(last.nextCursor).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('uses opaque cursors and paragraph locations and rejects forged handles', async () => {
    const load = vi.fn(async () => document('First paragraph\n\nSecond paragraph'));
    const first = await readWebSession({ ...options, limit: 10 }, load);
    const next = await readWebSession({ ...options, limit: 10, cursor: first.nextCursor }, load);
    expect(next.text).toBe('graph\n\nSec');
    const located = await readWebSession({ ...options, limit: 10, readSessionId: first.readSessionId, section: 'p2' }, load);
    expect(located.text).toBe('Second par');
    await expect(readWebSession({ ...options, cursor: `${first.readSessionId}:forged` }, load)).rejects.toThrow('游标');
    await expect(readWebSession({ ...options, readSessionId: 'fake' }, load)).rejects.toThrow('失效');
  });
  it('does not refetch an expired continuation', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => document());
    const first = await readWebSession(options, load);
    await vi.advanceTimersByTimeAsync(WEB_READ_SESSION_TTL_MS + 1);
    await expect(readWebSession({ ...options, cursor: first.nextCursor }, load)).rejects.toThrow('失效');
    await expect(readWebSession({ ...options, offset: 10_000 }, load)).rejects.toThrow('重新读取');
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('isolates scope and URL but permits only the exact MCP control conversation across tasks', async () => {
    const load = vi.fn(async () => document());
    const first = await readWebSession(options, load);
    for (const change of [{ projectId: 'p2' }, { conversationId: 'c2' }, { taskId: 't2' }]) {
      await expect(readWebSession({ ...options, scope: { ...scope, ...change }, readSessionId: first.readSessionId }, load)).rejects.toThrow('作用域');
    }
    await expect(readWebSession({ ...options, url: 'https://example.com/other', readSessionId: first.readSessionId }, load)).rejects.toThrow('作用域');
    const mcp = { ...scope, conversationId: 'mcp-control-p1' };
    const mcpFirst = await readWebSession({ ...options, scope: mcp }, load);
    await expect(readWebSession({ ...options, scope: { ...mcp, taskId: 'mcp-next' }, cursor: mcpFirst.nextCursor }, load)).resolves.toBeDefined();
  });
  it('rechecks current authority on cache hits and after loading', async () => {
    let allowed = true;
    const request = { ...options, authorize: () => allowed };
    const first = await readWebSession(request, async () => document());
    allowed = false;
    await expect(readWebSession({ ...request, cursor: first.nextCursor }, async () => document())).rejects.toThrow('授权');
    allowed = true;
    clearWebReadSessionsForTask(scope.taskId);
    await expect(readWebSession(request, async () => { allowed = false; return document(); })).rejects.toThrow('授权');
  });
  it('deduplicates concurrent loads and cannot revive a cleared task from late results', async () => {
    let finish!: (value: WebReadDocument) => void;
    const load = vi.fn(() => new Promise<WebReadDocument>((resolve) => { finish = resolve; }));
    const first = readWebSession(options, load);
    const second = readWebSession(options, load);
    clearWebReadSessionsForTask(scope.taskId);
    finish(document());
    await expect(first).rejects.toThrow('失效');
    await expect(second).rejects.toThrow('失效');
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('bounds snapshot size and prevents returned slices mutating saved content', async () => {
    await expect(readWebSession(options, async () => document('x'.repeat(1_000_001)))).rejects.toThrow('上限');
    const first = await readWebSession(options, async () => document('SAFE'));
    first.pages[0].source.title = 'MUTATED';
    const again = await readWebSession({ ...options, readSessionId: first.readSessionId }, async () => document('WRONG'));
    expect(again.pages[0].source.title).toBe('Docs');
    expect(again.text).toBe('SAFE');
  });
});

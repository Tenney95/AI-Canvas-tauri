import { beforeEach, describe, expect, it } from 'vitest';
import type { WebSource } from '../../../src/types/chat';
import { readWebSession } from '../../../src/services/chat/webReadSessionService';
import {
  assignWebSourceCitations,
  clearWebAccessGrantsForTests,
  clearWebAccessTask,
  isWebUrlAllowed,
  normalizePublicWebUrl,
  rememberWebSources,
  rememberWebUrls,
} from '../../../src/services/chat/webAccessGrantService';

function source(url: string): WebSource {
  return {
    id: `source-${url}`,
    title: 'Example',
    url,
    domain: new URL(url).hostname,
    fetchedAt: 1,
    sourceType: 'search',
  };
}

beforeEach(() => {
  clearWebAccessGrantsForTests();
});

describe('web access task grants', () => {
  it('invalidates cached bodies when clearing task access even for otherwise public HTTPS URLs', async () => {
    const url = 'https://example.com/docs';
    const options = { scope: { taskId: 'clear', projectId: 'p', conversationId: 'c' }, kind: 'web' as const, url, authorize: () => true };
    const load = async () => ({ readMethod: 'static' as const, complete: true, issues: [],
      pages: [{ source: source(url), text: 'test body', links: [], truncated: false }] });
    const first = await readWebSession(options, load);
    clearWebAccessTask('clear');
    await expect(readWebSession({ ...options, readSessionId: first.readSessionId }, load)).rejects.toThrow('失效');
  });
  it('accepts public standard-port URLs and strips fragments', () => {
    expect(normalizePublicWebUrl('https://example.com/docs?q=1#section'))
      .toBe('https://example.com/docs?q=1');
    expect(normalizePublicWebUrl('http://example.com/path')).toBe('http://example.com/path');
  });

  it.each([
    'file:///tmp/secret',
    'https://user:pass@example.com/',
    'https://localhost/docs',
    'https://127.0.0.1/docs',
    'https://10.0.0.1/docs',
    'https://172.16.0.1/docs',
    'https://192.168.1.1/docs',
    'https://[::1]/docs',
    'https://example.com:8443/docs',
    'https://example.com/docs?access_token=secret',
    'https://example.com/docs?api_key=secret',
  ])('rejects unsafe URL %s', (url) => {
    expect(normalizePublicWebUrl(url)).toBeNull();
  });

  it('allows safe HTTPS navigation while keeping HTTP grants scoped to the current task', () => {
    const taskId = 'task-1';
    rememberWebSources(taskId, [source('http://example.com/result')]);
    rememberWebUrls(taskId, ['http://example.com/discovered']);

    expect(isWebUrlAllowed(taskId, 'https://example.net/research', '普通问题')).toBe(true);
    expect(isWebUrlAllowed(taskId, 'http://example.com/result', '普通问题')).toBe(true);
    expect(isWebUrlAllowed(taskId, 'http://example.com/discovered', '普通问题')).toBe(true);
    expect(isWebUrlAllowed(taskId, 'http://docs.example.org/api', '读取 http://docs.example.org/api。'))
      .toBe(true);
    expect(isWebUrlAllowed(taskId, 'http://unrelated.example/page', '普通问题')).toBe(false);
    expect(isWebUrlAllowed('task-2', 'http://example.com/result', '普通问题')).toBe(false);

    clearWebAccessTask(taskId);
    expect(isWebUrlAllowed(taskId, 'http://example.com/result', '普通问题')).toBe(false);
    expect(isWebUrlAllowed(taskId, 'https://example.net/research', '普通问题')).toBe(true);
  });

  it('assigns stable per-task citations and deduplicates normalized URLs', () => {
    const assigned = assignWebSourceCitations('task-1', [
      source('https://example.com/a#one'),
      source('https://example.com/b'),
      source('https://example.com/a#two'),
    ]);

    expect(assigned.map((item) => item.citationId)).toEqual(['S1', 'S2']);
    expect(assigned.map((item) => item.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });
});

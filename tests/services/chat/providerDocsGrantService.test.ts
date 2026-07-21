import { afterEach, describe, expect, it } from 'vitest';
import {
  beginProviderDocRead,
  clearProviderDocsGrantsForTests,
  completeProviderDocRead,
  extractExplicitProviderDocUrls,
  isProviderDocUrlGranted,
  normalizeProviderDocUrl,
  releaseProviderDocRead,
} from '../../../src/services/chat/providerDocsGrantService';

afterEach(() => clearProviderDocsGrantsForTests());

describe('providerDocsGrantService', () => {
  it('extracts only safe explicit HTTPS URLs from the task goal', () => {
    expect(extractExplicitProviderDocUrls([
      '读取 https://docs.example.com/api#models。',
      '忽略 http://docs.example.com/insecure',
      '忽略 https://127.0.0.1/admin',
    ].join(' '))).toEqual(['https://docs.example.com/api']);
    expect(normalizeProviderDocUrl('https://user:pass@docs.example.com/api')).toBeNull();
    expect(normalizeProviderDocUrl('https://docs.example.com:8443/api')).toBeNull();
  });

  it('grants the explicit root and same-origin links discovered by a completed read', () => {
    const taskId = 'task-docs';
    const goal = '分析 https://docs.example.com/api 并配置模型';
    expect(isProviderDocUrlGranted(taskId, goal, 'https://docs.example.com/api')).toBe(true);
    expect(isProviderDocUrlGranted(taskId, goal, 'https://docs.example.com/models')).toBe(false);

    const root = beginProviderDocRead(taskId, goal, 'https://docs.example.com/api');
    const completion = completeProviderDocRead(root, 1200, [
      'https://docs.example.com/models',
      'https://other.example.com/models',
    ]);

    expect(completion).toMatchObject({ depth: 0, remainingPages: 7 });
    expect(completion.discoveredUrls).toEqual(['https://docs.example.com/models']);
    expect(isProviderDocUrlGranted(taskId, goal, 'https://docs.example.com/models')).toBe(true);
    expect(isProviderDocUrlGranted(taskId, goal, 'https://other.example.com/models')).toBe(false);
  });

  it('allows at most two discovered-link levels', () => {
    const taskId = 'task-depth';
    const goal = '读取 https://docs.example.com/start';
    const root = beginProviderDocRead(taskId, goal, 'https://docs.example.com/start');
    completeProviderDocRead(root, 10, ['https://docs.example.com/level-1']);
    const level1 = beginProviderDocRead(taskId, goal, 'https://docs.example.com/level-1');
    completeProviderDocRead(level1, 10, ['https://docs.example.com/level-2']);
    const level2 = beginProviderDocRead(taskId, goal, 'https://docs.example.com/level-2');
    const completion = completeProviderDocRead(level2, 10, ['https://docs.example.com/level-3']);

    expect(completion.depth).toBe(2);
    expect(completion.discoveredUrls).toEqual([]);
    expect(isProviderDocUrlGranted(taskId, goal, 'https://docs.example.com/level-3')).toBe(false);
  });

  it('reserves reads atomically and releases failed reservations', () => {
    const taskId = 'task-reservation';
    const goal = '读取 https://docs.example.com/api';
    const reservation = beginProviderDocRead(taskId, goal, 'https://docs.example.com/api');
    expect(() => beginProviderDocRead(taskId, goal, reservation.url)).toThrow('正在读取');
    releaseProviderDocRead(reservation);
    expect(() => beginProviderDocRead(taskId, goal, reservation.url)).not.toThrow();
  });

  it('enforces the eight-page task budget', () => {
    const taskId = 'task-budget';
    const roots = Array.from({ length: 9 }, (_, index) => `https://docs.example.com/page-${index}`);
    const goal = roots.join(' ');
    for (const url of roots.slice(0, 8)) {
      completeProviderDocRead(beginProviderDocRead(taskId, goal, url), 10, []);
    }
    expect(() => beginProviderDocRead(taskId, goal, roots[8])).toThrow('最多读取 8 个');
  });
});

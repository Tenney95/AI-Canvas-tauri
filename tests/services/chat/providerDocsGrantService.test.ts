import { afterEach, describe, expect, it } from 'vitest';
import {
  beginProviderDocRead,
  clearProviderDocsGrantsForTests,
  completeProviderDocRead,
  extractExplicitProviderDocUrls,
  isProviderDocUrlGranted,
  normalizeProviderDocUrl,
  releaseProviderDocRead,
  listProviderDocGrants,} from '../../../src/services/chat/providerDocsGrantService';

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

  it('allows continuing the same page at a new offset but not re-reading the same chunk', () => {
    const taskId = 'task-offset';
    const goal = '分析 https://docs.example.com/api 并配置模型';
    const url = 'https://docs.example.com/api';

    completeProviderDocRead(beginProviderDocRead(taskId, goal, url, undefined, 0), 10_000, []);
    // 同一段重复读仍然被挡住，避免助手原地打转
    expect(() => beginProviderDocRead(taskId, goal, url, undefined, 0))
      .toThrow('该文档页面已读取或正在读取');

    const continuation = beginProviderDocRead(taskId, goal, url, undefined, 10_000);
    expect(continuation.readKey).toBe(`${url}#10000`);
    expect(completeProviderDocRead(continuation, 10_000, []))
      .toMatchObject({ remainingPages: 22, remainingTextChars: 60_000 });
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

    expect(completion).toMatchObject({ depth: 0, remainingPages: 23 });
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

  it('enforces the per-task page budget', () => {
    // 中转站要逐个读模型接口页，页数放宽到 24；真正的硬边界是 80k 字符总量
    const taskId = 'task-budget';
    const roots = Array.from({ length: 25 }, (_, index) => `https://docs.example.com/page-${index}`);
    const goal = roots.join(' ');
    for (const url of roots.slice(0, 24)) {
      completeProviderDocRead(beginProviderDocRead(taskId, goal, url), 10, []);
    }
    expect(() => beginProviderDocRead(taskId, goal, roots[24])).toThrow('最多读取 24 个');
  });
});

describe('跨任务的会话级授权', () => {
  const docsRoot = 'https://api.paipu.net/docs';
  const modelPage = 'https://api.paipu.net/docs/videos/lec-seed-2-0-900';

  it('列清单的任务结束后，用户选完模型开的新任务仍能读模型接口页', () => {
    // 第 1 轮：用户给了文档地址，助手读列表页并发现各模型接口页
    completeProviderDocRead(
      beginProviderDocRead('task-list', `请接入 ${docsRoot}`, docsRoot, 'conv-1'),
      500,
      [modelPage],
    );

    // 第 2 轮：用户只回「要 Seedance 2.0 900」，goal 里没有任何 URL
    const goal = '要 Seedance 2.0 900';
    expect(isProviderDocUrlGranted('task-pick', goal, modelPage, 'conv-1')).toBe(true);
    expect(() => beginProviderDocRead('task-pick', goal, modelPage, 'conv-1')).not.toThrow();

    // 换个会话不继承，避免授权无限扩散
    expect(isProviderDocUrlGranted('task-other', goal, modelPage, 'conv-2')).toBe(false);
  });

  it('页数预算仍按任务独立计算，不被会话授权放大', () => {
    completeProviderDocRead(
      beginProviderDocRead('task-a', `请接入 ${docsRoot}`, docsRoot, 'conv-budget'),
      500,
      [modelPage],
    );
    const completion = completeProviderDocRead(
      beginProviderDocRead('task-b', '继续', modelPage, 'conv-budget'),
      500,
      [],
    );
    // 新任务从满预算开始，只算它自己读的这 1 页
    expect(completion.remainingPages).toBe(23);
  });
});

describe('拒绝时给出可读地址', () => {
  it('列出还没读过的已授权地址，已读的不再列', () => {
    const goal = '接入 https://api.paipu.net/docs';
    const root = 'https://api.paipu.net/docs';
    const model = 'https://api.paipu.net/docs/videos/lec-seed-2-0-900';

    expect(listProviderDocGrants('task-hint', goal)).toEqual([root]);
    completeProviderDocRead(beginProviderDocRead('task-hint', goal, root), 100, [model]);
    // 读过的根页不再出现，新发现的模型页可读
    expect(listProviderDocGrants('task-hint', goal)).toEqual([model]);
  });
});

describe('已授权路径下的子页', () => {
  const goal = '接入 https://api.paipu.net/docs';

  it('首页渲染失败拿不到链接时，模型接口页仍可读', () => {
    // 兜底清单不带任何链接，只能靠路径前缀授权
    expect(isProviderDocUrlGranted('task-prefix', goal, 'https://api.paipu.net/docs/videos/lec-ac-seedance-900-720p')).toBe(true);
    expect(() => beginProviderDocRead('task-prefix', goal, 'https://api.paipu.net/docs/images/lec-image-2')).not.toThrow();
  });

  it('不放宽到授权路径之外', () => {
    // 同域但不在 /docs 下
    expect(isProviderDocUrlGranted('task-scope', goal, 'https://api.paipu.net/dashboard')).toBe(false);
    // 前缀相近但不是子路径
    expect(isProviderDocUrlGranted('task-scope', goal, 'https://api.paipu.net/docs-private/x')).toBe(false);
    // 换个域名
    expect(isProviderDocUrlGranted('task-scope', goal, 'https://evil.example.com/docs/videos/x')).toBe(false);
  });
});

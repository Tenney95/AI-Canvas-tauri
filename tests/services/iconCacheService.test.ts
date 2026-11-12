/**
 * iconCacheService — 回归测试：随包图标和额外图标的持久缓存。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _api, addIcon, getIcon, loadIcon } from '@iconify/react';

const cacheKey = (name: string) => `ai-canvas:iconify:v1:${name}`;
const body = '<path d="M1 1h10v10H1z"/>';

async function initialize(fetcher = vi.fn<typeof fetch>()) {
  _api.setFetch(fetcher);
  const { initializeIconCache } = await import('../../src/services/iconCacheService');
  initializeIconCache();
  return { fetcher, initializeIconCache, cachedFetch: _api.getFetch()! };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', { localStorage });
});

describe('Iconify 持久缓存', () => {
  it('空缓存且完全离线时，设置页和其他图标集的固定图标无需请求即可加载', async () => {
    const names = ['mdi:plus', 'mdi:file-import-outline', 'mdi:pencil-outline', 'mdi:trash-can-outline',
      'mdi:content-copy', 'lucide:receipt-text', 'icon-park-outline:grid-four', 'svg-spinners:90-ring'];
    for (const name of names) addIcon(name, { body: '' });
    const { fetcher } = await initialize(vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')));
    for (const name of names) {
      await expect(loadIcon(name)).resolves.toMatchObject({ body: expect.stringContaining('<') });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it('旧缓存不能覆盖随包图标，额外图标仍正常恢复', async () => {
    addIcon('mdi:pencil-outline', { body });
    localStorage.setItem(cacheKey('mdi:pencil-outline'), JSON.stringify({ body }));
    localStorage.setItem(cacheKey('cachetest:extra'), JSON.stringify({ body }));
    await initialize();
    expect(getIcon('mdi:pencil-outline')?.body).toBeTruthy();
    expect(getIcon('mdi:pencil-outline')?.body).not.toBe(body);
    expect(getIcon('cachetest:extra')?.body).toBe(body);
  });

  it('启动时恢复本地数据，离线加载已缓存图标无需请求', async () => {
    localStorage.setItem(cacheKey('cachetest:restored'), JSON.stringify({ body, width: 24, height: 24 }));
    const { fetcher } = await initialize(vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')));

    expect(getIcon('cachetest:restored')?.body).toBe(body);
    await expect(loadIcon('cachetest:restored')).resolves.toMatchObject({ body, width: 24 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('成功响应逐个缓存图标和解析后的别名，不受请求分组影响', async () => {
    const data = {
      prefix: 'cachetest', width: 32, height: 24,
      icons: { original: { body }, second: { body } },
      aliases: { turned: { parent: 'original', rotate: 1 } },
      not_found: ['absent'],
    };
    const response = Response.json(data);
    const { cachedFetch } = await initialize(vi.fn<typeof fetch>().mockResolvedValue(response));
    const result = await cachedFetch('https://api.iconify.design/cachetest.json?icons=original,turned,second,absent');

    expect(result).toBe(response);
    expect(await result.json()).toEqual(data);
    expect(JSON.parse(localStorage.getItem(cacheKey('cachetest:turned'))!)).toMatchObject({ body, width: 32, height: 24, rotate: 1 });
    expect(localStorage.getItem(cacheKey('cachetest:original'))).not.toBeNull();
    expect(localStorage.getItem(cacheKey('cachetest:second'))).not.toBeNull();
    expect(localStorage.getItem(cacheKey('cachetest:absent'))).toBeNull();
  });

  it('真实 loadIcon 流程首次请求后保存在本地，再次加载使用内存', async () => {
    const { fetcher } = await initialize(vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      prefix: 'cachetest', icons: { live: { body } },
    })));
    await expect(loadIcon('cachetest:live')).resolves.toMatchObject({ body });
    await expect(loadIcon('cachetest:live')).resolves.toMatchObject({ body });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(cacheKey('cachetest:live'))).not.toBeNull();
  });

  it('坏记录不会阻止恢复其他图标，不修改应用其他存储', async () => {
    localStorage.setItem(cacheKey('cachetest:broken'), '{');
    localStorage.setItem(cacheKey('cachetest:invalid'), JSON.stringify({ body, width: 'wrong' }));
    localStorage.setItem(cacheKey('cachetest:healthy'), JSON.stringify({ body }));
    localStorage.setItem('user-preferences', 'keep');
    await initialize();
    expect(getIcon('cachetest:healthy')?.body).toBe(body);
    expect(getIcon('cachetest:invalid')).toBeFalsy();
    expect(localStorage.getItem('user-preferences')).toBe('keep');
  });

  it('存储配额不足时图标仍可加载且保留已有缓存', async () => {
    localStorage.setItem(cacheKey('cachetest:kept'), JSON.stringify({ body }));
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const response = Response.json({ prefix: 'cachetest', icons: { overflow: { body } } });
    const { cachedFetch } = await initialize(vi.fn<typeof fetch>().mockResolvedValue(response));
    await expect(cachedFetch('https://api.simplesvg.com/cachetest.json?icons=overflow')).resolves.toBe(response);
    expect(getIcon('cachetest:overflow')?.body).toBe(body);
    expect(localStorage.getItem(cacheKey('cachetest:kept'))).not.toBeNull();
  });

  it('存储不可访问时内置图标仍可显示，并保留原有请求适配器', async () => {
    addIcon('mdi:plus', { body: '' });
    vi.stubGlobal('window', { get localStorage() { throw new Error('denied'); } });
    const { fetcher, cachedFetch } = await initialize();
    expect(getIcon('mdi:plus')?.body).toEqual(expect.stringContaining('<'));
    expect(cachedFetch).toBe(fetcher);
  });

  it('错误响应、无效 JSON 和非图标服务数据不缓存', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('error', { status: 500 }))
      .mockResolvedValueOnce(new Response('not json'))
      .mockResolvedValueOnce(Response.json({ prefix: 'cachetest', icons: { external: { body } } }))
      .mockResolvedValueOnce(Response.json({ prefix: 'different', icons: { mismatch: { body } } }));
    const { cachedFetch } = await initialize(fetcher);
    await cachedFetch('https://api.iconify.design/cachetest.json?icons=error');
    await cachedFetch('https://api.unisvg.com/cachetest.json?icons=error');
    await cachedFetch('https://example.com/cachetest.json?icons=external');
    await cachedFetch('https://api.iconify.design/cachetest.json?icons=mismatch');
    expect(localStorage.length).toBe(0);
  });

  it('网络异常仍按原流程拒绝，重复初始化不会多次包装请求', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    const { initializeIconCache, cachedFetch } = await initialize(fetcher);
    initializeIconCache();
    expect(_api.getFetch()).toBe(cachedFetch);
    await expect(cachedFetch('https://api.iconify.design/cachetest.json?icons=offline')).rejects.toThrow('offline');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
  });
});

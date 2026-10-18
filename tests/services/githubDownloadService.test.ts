import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadGithubBytes, githubMirrorUrl } from '../../src/services/githubDownloadService';

const url = 'https://github.com/example/repo/releases/download/v1/file.zip';
afterEach(() => vi.useRealTimers());

describe('公开 GitHub 下载回退', () => {
  it('直连失败只切一次加速源，完整重读响应体', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(new Response('done'));
    expect(new TextDecoder().decode(await downloadGithubBytes(url, { fetcher }))).toBe('done');
    expect(fetcher.mock.calls.map(([source]) => source)).toEqual([url, `https://gh-proxy.com/${url}`]);
  });

  it('响应体读取失败重置进度并从头下载，不拼接损坏数据', async () => {
    const progress = vi.fn();
    let reads = 0;
    const broken = new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode('broken'));
      else controller.error(new TypeError('connection reset'));
    } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(broken)).mockResolvedValueOnce(new Response('complete'));
    expect(new TextDecoder().decode(await downloadGithubBytes(url, { fetcher, onProgress: progress }))).toBe('complete');
    expect(progress.mock.calls.map(([bytes]) => bytes)).toContain(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('连接超时也可结束不响应 abort 的 fetch，不无限等待', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(new Response('ok'));
    const result = downloadGithubBytes(url, { fetcher });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(new TextDecoder().decode(await result)).toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([404, 403])('HTTP %s 不切源，大小校验同样不切源', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    await expect(downloadGithubBytes(url, { fetcher })).rejects.toThrow(`HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockClear().mockResolvedValue(new Response('large'));
    await expect(downloadGithubBytes(url, { fetcher, maxBytes: 2 })).rejects.toThrow('过大');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('取消与非公开地址不切源，加速源失败不再次重试', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
    await expect(downloadGithubBytes(url, { signal: controller.signal, fetcher })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
    for (const value of ['https://user@github.com/a/b', `${url}?token=secret`, 'https://other.test/a', `https://gh-proxy.com/${url}`]) {
      expect(githubMirrorUrl(value)).toBeUndefined();
    }
    await expect(downloadGithubBytes(url, { fetcher })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

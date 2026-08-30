import { afterEach, describe, expect, it, vi } from 'vitest';

import { createResilientReader, createVideoInput } from '../../src/services/videoEditorMediaService';

const WHOLE = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

function rangeResponse(start: number, end: number) {
  return {
    ok: true,
    status: 206,
    headers: new Headers({ 'Content-Range': `bytes ${start}-${end - 1}/${WHOLE.length}` }),
    arrayBuffer: async () => WHOLE.slice(start, end).buffer,
  } as unknown as Response;
}

function wholeResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Length': String(WHOLE.length) }),
    arrayBuffer: async () => WHOLE.buffer.slice(0),
  } as unknown as Response;
}

/** WKWebView 的 asset:// 在并发分片下让 fetch 直接失败时抛的就是这个 */
function webkitFetchFailure() {
  return new TypeError('Type error');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createResilientReader', () => {
  it('serves a plain ranged read with a single request', async () => {
    const fetchMock = vi.fn(async () => rangeResponse(2, 5));
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('asset://video.mp4', WHOLE.length);
    expect([...(await read(2, 5))]).toEqual([2, 3, 4]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once before giving up on a ranged read', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(webkitFetchFailure())
      .mockResolvedValueOnce(rangeResponse(0, 3));
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('asset://video.mp4', WHOLE.length);
    expect([...(await read(0, 3))]).toEqual([0, 1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to a whole-file download when ranged reads keep failing', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(webkitFetchFailure())
      .mockRejectedValueOnce(webkitFetchFailure())
      .mockResolvedValueOnce(wholeResponse());
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('asset://video.mp4', WHOLE.length);
    expect([...(await read(4, 7))]).toEqual([4, 5, 6]);
    // 两次分片尝试 + 一次整份下载
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('serves every later read from memory once it fell back', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(webkitFetchFailure())
      .mockRejectedValueOnce(webkitFetchFailure())
      .mockResolvedValueOnce(wholeResponse());
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('asset://video.mp4', WHOLE.length);
    await read(0, 2);
    fetchMock.mockClear();

    expect([...(await read(7, 10))]).toEqual([7, 8, 9]);
    expect([...(await read(1, 3))]).toEqual([1, 2]);
    // 回退之后不该再碰 asset:// 一次
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not materialize a full 200 response for a range request before switching to one shared download', async () => {
    const cancel = vi.fn(async () => undefined);
    const ignoredRangeResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Length': '999999999' }),
      body: { cancel },
      arrayBuffer: vi.fn(async () => {
        throw new Error('range response body must not be read');
      }),
    } as unknown as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ignoredRangeResponse)
      .mockResolvedValueOnce(wholeResponse());
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('https://example.test/video.mp4', WHOLE.length);
    expect([...(await read(2, 5))]).toEqual([2, 3, 4]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(ignoredRangeResponse.arrayBuffer).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await read(5, 7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels an oversized 206 body before materializing it and switches to the shared download', async () => {
    const cancel = vi.fn(async () => undefined);
    const oversizedRangeResponse = {
      ok: true,
      status: 206,
      headers: new Headers({
        'Content-Length': '999999999',
        'Content-Range': `bytes 2-4/${WHOLE.length}`,
      }),
      body: { cancel },
      arrayBuffer: vi.fn(async () => {
        throw new Error('oversized range body must not be materialized');
      }),
    } as unknown as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(oversizedRangeResponse)
      .mockResolvedValueOnce(wholeResponse());
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('https://example.test/video.mp4', WHOLE.length);
    expect([...(await read(2, 5))]).toEqual([2, 3, 4]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(oversizedRangeResponse.arrayBuffer).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops a streamed 206 response as soon as it exceeds the requested range', async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const readChunk = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array([2, 3, 4, 5]) });
    const oversizedRangeResponse = {
      ok: true,
      status: 206,
      headers: new Headers({ 'Content-Range': `bytes 2-4/${WHOLE.length}` }),
      body: {
        getReader: () => ({ read: readChunk, cancel, releaseLock }),
      },
    } as unknown as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(oversizedRangeResponse)
      .mockResolvedValueOnce(wholeResponse());
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('https://example.test/video.mp4', WHOLE.length);
    expect([...(await read(2, 5))]).toEqual([2, 3, 4]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(readChunk).toHaveBeenCalledOnce();
  });

  it('clamps reads that run past the end of the file', async () => {
    let requestedRange = '';
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      requestedRange = String((init?.headers as Record<string, string> | undefined)?.Range ?? '');
      return rangeResponse(8, 10);
    });
    vi.stubGlobal('fetch', fetchMock);

    const read = createResilientReader('asset://video.mp4', WHOLE.length);
    expect([...(await read(8, 999))]).toEqual([8, 9]);
    // 越界的 end 必须夹到文件长度，否则 Range 头会请求不存在的字节
    expect(requestedRange).toBe('bytes=8-9');
  });
});

describe('createVideoInput range probe', () => {
  it('cancels an ignored probe body before starting the single whole-file download', async () => {
    const cancel = vi.fn(async () => undefined);
    const probeResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Length': String(WHOLE.length) }),
      body: { cancel },
    } as unknown as Response;
    const whole = {
      ok: true,
      status: 200,
      blob: async () => new Blob([WHOLE], { type: 'video/mp4' }),
    } as unknown as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(probeResponse)
      .mockResolvedValueOnce(whole);
    vi.stubGlobal('fetch', fetchMock);

    const input = await createVideoInput('https://example.test/video.mp4');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    input.dispose();
  });
});

import policy from '../constants/githubDownload.json';

/** 只接受公开、无凭据的官方 GitHub 地址；加速源本身不再套加速。 */
export function githubMirrorUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search
      || !policy.officialHosts.includes(url.hostname)) return undefined;
    return `${policy.mirrorBase}${url.href}`;
  } catch { return undefined; }
}

class RetryableDownloadError extends Error {}
const abortError = () => new DOMException('下载已取消', 'AbortError');

export interface GithubDownloadOptions {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  maxBytes?: number;
  accept?: string;
  onProgress?: (downloaded: number, total?: number) => void;
}

/** 整个响应体纳入重试边界；体积校验、进度回调异常与用户取消均不触发切源。 */
export async function downloadGithubBytes(url: string, options: GithubDownloadOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const mirror = githubMirrorUrl(url);
  const attempt = async (source: string) => {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const network = async <T>(operation: () => Promise<T>, timeout: number): Promise<T> => {
      if (options.signal?.aborted) throw abortError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel: (() => void) | undefined;
      let timedOut = false;
      try {
        return await Promise.race([operation(), new Promise<never>((_, reject) => {
          cancel = () => { controller.abort(); reject(abortError()); };
          options.signal?.addEventListener('abort', cancel, { once: true });
          timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new RetryableDownloadError('GitHub 下载超时')); }, timeout);
          if (options.signal?.aborted) cancel();
        })]);
      } catch (error) {
        if (options.signal?.aborted) throw abortError();
        if (timedOut) throw new RetryableDownloadError('GitHub 下载超时');
        if (error instanceof TypeError) throw new RetryableDownloadError('GitHub 下载连接或读取中断', { cause: error });
        throw error;
      } finally {
        clearTimeout(timer);
        if (cancel) options.signal?.removeEventListener('abort', cancel);
      }
    };
    try {
      const response = await network(() => (options.fetcher ?? fetch)(source, {
        signal: controller.signal, credentials: 'omit', headers: options.accept ? { Accept: options.accept } : undefined,
      }), policy.connectTimeoutMs);
      if (!response.ok) {
        const message = `请求失败（HTTP ${response.status}）`;
        if ([408, 429].includes(response.status) || response.status >= 500) throw new RetryableDownloadError(message);
        throw new Error(message);
      }
      const limit = options.maxBytes ?? Infinity;
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > limit) throw new Error('下载内容过大');
      const encoding = response.headers.get('content-encoding');
      let total = (!encoding || encoding === 'identity') && length > 0 ? length : undefined;
      let downloaded = 0;
      const report = () => {
        if (total !== undefined && downloaded > total) total = undefined;
        options.onProgress?.(downloaded, total);
      };
      report();
      const chunks: Uint8Array[] = [];
      reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await network(() => reader!.read(), policy.readTimeoutMs);
          if (done) break;
          downloaded += value.byteLength;
          if (downloaded > limit) throw new Error('下载内容过大');
          chunks.push(value);
          report();
        }
      } else {
        const bytes = new Uint8Array(await network(() => response.arrayBuffer(), policy.readTimeoutMs));
        downloaded = bytes.byteLength;
        if (downloaded > limit) throw new Error('下载内容过大');
        chunks.push(bytes);
        report();
      }
      if (options.signal?.aborted) throw abortError();
      const bytes = new Uint8Array(downloaded);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    } finally {
      controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  };
  try { return await attempt(url); }
  catch (error) {
    if (!mirror || options.signal?.aborted || !(error instanceof RetryableDownloadError)) throw error;
    options.onProgress?.(0);
    return attempt(mirror);
  }
}

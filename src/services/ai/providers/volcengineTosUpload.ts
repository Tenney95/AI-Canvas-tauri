/** 方舟私有 TOS 上传桥；预签名 URL 只交本次方舟请求，不进入持久化缓存。 */
import { invoke } from '@tauri-apps/api/core';
import type { VolcengineTosConfig } from '../../../types/volcengineTos';
import { isTauriEnv } from '../../fs/core';
import { assertMediaDataUrlWithinLimitAsync, isMediaDataUrl, readFileToDataUrl, type MediaDataUrlKind } from '../../fileService';
import { localMediaUrlToPath } from '../../../utils/mediaUrl';
import { validateVolcengineTosConfig } from '../../volcengineTosConfigService';
import { VOLCENGINE_BASE_URL } from '../../../constants/api';

const NATIVE_INLINE_LIMIT = 32 * 1024 * 1024;
const MIN_SIGNED_URL_LIFETIME_MS = 3 * 60 * 60 * 1000;

function toVolcengineTosUploadError(error: unknown): Error {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  // 只重建已脱敏的诊断；原异常的 cause 也可能包含签名 URL 或本机路径，不能向外保留。
  const safe = /^(?:火山 TOS|TOS |参考素材上传期间)/.test(message)
    && !/https?:\/\/|secret:|[a-z]:[\\/]|[\r\n]/i.test(message) && message.length <= 240;
  return new Error(safe ? message : '火山 TOS 上传失败，请检查 Bucket、AK/SK 权限及网络；不会改用公共图床');
}

export function assertVolcengineTosMediaSize(bytes: number, kind: MediaDataUrlKind): void {
  const limit = kind === 'video' ? 200_000_000 : NATIVE_INLINE_LIMIT;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > limit) {
    throw new Error(kind === 'video' ? 'TOS 本地参考视频不能超过 200 MB' : 'TOS 本地参考图片或音频不能超过 32 MiB');
  }
}

/** 北京内网素材只允许发给北京方舟，不能发送到同名中转连接。 */
export function assertVolcengineTosEndpoint(baseUrl?: string): void {
  let endpoint: URL;
  try { endpoint = new URL(baseUrl || VOLCENGINE_BASE_URL); }
  catch { throw new Error('TOS 内网参考素材仅支持北京区域的方舟官方接口'); }
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'ark.cn-beijing.volces.com' || endpoint.port
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname.replace(/\/+$/, '') !== '/api/v3') {
    throw new Error('TOS 内网参考素材仅支持北京区域的方舟官方接口');
  }
}

export async function uploadVolcengineTosReference(
  url: string,
  kind: MediaDataUrlKind,
  config: VolcengineTosConfig | undefined,
  signal?: AbortSignal,
  expectedSource?: { digest: string; bytes: number },
  beforeUpload?: () => void,
): Promise<string> {
  signal?.throwIfAborted();
  if (!isTauriEnv()) throw new Error('方舟 TOS 本地素材上传仅支持 Tauri 桌面端');
  if (!config?.bucket || !config.credentialRef) throw new Error('请先在「设置 → API Key → 火山方舟」配置北京私有 TOS Bucket 和 AK/SK；不会改用公共图床');
  validateVolcengineTosConfig(config);
  if (kind === 'other') throw new Error('方舟 TOS 参考素材只支持图片、视频和音频');
  const path = localMediaUrlToPath(url);
  let dataUrl: string | undefined;
  if (!path) {
    // 大视频必须传原生路径；内联素材仍遵守已有内存预算，不扩大 Base64 IPC。
    dataUrl = isMediaDataUrl(url) ? url : ((await readFileToDataUrl(url, { kind, signal })) ?? undefined);
    if (!dataUrl) throw new Error('无法读取方舟本地参考素材，请重新导入文件');
    const bytes = await assertMediaDataUrlWithinLimitAsync(dataUrl, kind, '方舟 TOS 参考素材', signal);
    if (bytes > NATIVE_INLINE_LIMIT) throw new Error('超过 32 MiB 的内联素材请先保存为本地文件，再使用 TOS 上传');
  }
  signal?.throwIfAborted();
  beforeUpload?.();
  const requestId = `volcengine-tos-${crypto.randomUUID()}`;
  const cancel = () => { void invoke('cancel_volcengine_tos_upload', { requestId }).catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const result = await invoke<{ url: string; expiresAt: number }>('upload_volcengine_tos_reference', {
      req: { requestId, bucket: config.bucket, credentialRef: config.credentialRef, kind,
        source: path ? { path } : { dataUrl }, ...(expectedSource ? { expectedSource } : {}) },
    });
    signal?.throwIfAborted();
    beforeUpload?.();
    const signed = new URL(result.url);
    if (signed.protocol !== 'https:' || signed.hostname !== `${config.bucket}.tos-cn-beijing.ivolces.com`
      || signed.port || signed.username || signed.password || signed.hash
      || !signed.pathname.startsWith('/ai-canvas/ark-reference/') || !signed.searchParams.has('X-Tos-Signature')
      || !Number.isFinite(result.expiresAt) || result.expiresAt < Date.now() + MIN_SIGNED_URL_LIFETIME_MS) {
      throw new Error('火山 TOS 未返回有效的北京内网素材链接');
    }
    return result.url;
  } catch (error) {
    signal?.throwIfAborted();
    throw toVolcengineTosUploadError(error);
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

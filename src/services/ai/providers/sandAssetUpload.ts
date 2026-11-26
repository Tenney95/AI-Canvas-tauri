import type { MediaReference } from '../../../types/aiTypes';
import { localMediaUrlToPath } from '../../../utils/mediaUrl';
import { getMediaReferenceUrl } from '../connectedReferenceMedia';
import { prepareRelayonVideoUpload } from './relayonVideoUpload';
import { isSandId, sandPublicUrl, SAND_ASSETS_PATH } from './sandVideoContract';
import { waitForSandRequest } from './sandRateLimit';

const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/bmp': 'bmp',
  'image/tiff': 'tiff', 'image/gif': 'gif', 'image/heic': 'heic',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'audio/wav': 'wav', 'audio/mpeg': 'mp3',
};

export function assertSandReferenceSources(references: readonly MediaReference[]): void {
  for (const reference of references) {
    const url = getMediaReferenceUrl(reference);
    if (reference.provider || !sandPublicUrl(url) && !localMediaUrlToPath(url) && !/^(?:data|blob):/i.test(url)) {
      throw new Error('MAGI-2 参考素材需要本地文件或公开 HTTPS 地址');
    }
  }
}

export async function prepareSandAssets(
  references: readonly MediaReference[], origin: string, apiKey: string, assertCurrent: () => void,
  signal?: AbortSignal,
): Promise<ReadonlyMap<MediaReference, string>> {
  if (!apiKey.trim()) throw new Error('请填写本站点的 Sand AI API Key');
  assertSandReferenceSources(references);
  const uploaded = new Map<MediaReference, string>();
  const byKind = { image: new Map<string, string>(), video: new Map<string, string>(), audio: new Map<string, string>() };
  for (const reference of references) {
    signal?.throwIfAborted();
    assertCurrent();
    const url = getMediaReferenceUrl(reference);
    if (sandPublicUrl(url)) continue;
    const cache = byKind[reference.kind];
    const known = cache.get(url);
    if (known) {
      uploaded.set(reference, known);
      continue;
    }
    const response = await uploadMagiReference(reference, url, origin, apiKey, assertCurrent, signal);
    if (response.status !== 200) throw new Error(`Sand AI 素材上传失败（HTTP ${response.status}）`);
    const payload = await response.json() as { id?: unknown };
    if (!isSandId(payload.id)) throw new Error('Sand AI 上传未返回有效素材 ID');
    assertCurrent();
    cache.set(url, payload.id);
    uploaded.set(reference, payload.id);
  }
  return uploaded;
}

async function uploadMagiReference(
  reference: MediaReference, url: string, origin: string, apiKey: string, assertCurrent: () => void, signal?: AbortSignal,
): Promise<Response> {
  const upload = await prepareRelayonVideoUpload([{ ...reference, url, sourceUrl: undefined }], signal, origin);
  if (!upload) throw new Error('无法准备本地视频参考素材');
  try {
    const marker = upload.references[0].url;
    const extension = FILE_EXTENSIONS[marker.split(':', 3)[2]];
    if (!extension) throw new Error('当前连接不支持此素材格式');
    const beatapi = origin === 'https://api.beatapi.io';
    if (!beatapi) await waitForSandRequest(origin, 'upload', signal);
    assertCurrent();
    return await upload.submit(`${origin}${beatapi ? '/v1/files' : SAND_ASSETS_PATH}`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: 'application/json' },
    }, { file: { $file: marker, filename: `reference.${extension}` } }, signal);
  } finally {
    await upload.release();
  }
}

export async function prepareBeatApiReferences(
  references: readonly MediaReference[], apiKey: string, assertCurrent: () => void, signal?: AbortSignal,
): Promise<MediaReference[]> {
  if (!apiKey.trim()) throw new Error('请填写 BeatAPI API Key');
  assertSandReferenceSources(references);
  const prepared: MediaReference[] = [];
  const urlsByFile = new Map<string, string>();
  for (const reference of references) {
    signal?.throwIfAborted();
    assertCurrent();
    const url = getMediaReferenceUrl(reference);
    if (sandPublicUrl(url)) { prepared.push({ ...reference, url, sourceUrl: undefined }); continue; }
    const key = `${reference.kind}:${url}`;
    let uploaded = urlsByFile.get(key);
    if (!uploaded) {
      const response = await uploadMagiReference(reference, url, 'https://api.beatapi.io', apiKey, assertCurrent, signal);
      if (!response.ok) throw new Error(`BeatAPI 素材上传失败（HTTP ${response.status}）`);
      const payload = await response.json() as { data?: { url?: unknown } };
      const remote = payload.data?.url;
      if (typeof remote !== 'string' || !sandPublicUrl(remote) || new URL(remote).hostname !== 'files.beatapi.io'
        || remote.includes(apiKey.trim()) || remote.includes(encodeURIComponent(apiKey.trim()))) {
        throw new Error('BeatAPI 上传未返回有效素材地址');
      }
      assertCurrent();
      uploaded = remote;
      urlsByFile.set(key, uploaded);
    }
    prepared.push({ ...reference, url: uploaded, sourceUrl: undefined });
  }
  return prepared;
}

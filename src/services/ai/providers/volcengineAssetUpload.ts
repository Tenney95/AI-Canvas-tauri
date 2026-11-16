/** 素材库入库沿用火山连接的私有 TOS，签名链接只存在于本次请求。 */
import type { ApiProviderConfig } from '../../../types';
import type { VolcengineAssetCreateInput } from '../../../types/volcengineAssetLibrary';
import { useAppStore } from '../../../store/useAppStore';
import { isLocalMediaUrl, isRemoteMediaUrl } from '../../../utils/mediaUrl';
import { resolveProviderCatalogId } from '../providerPolicies';
import { createAsset, type AssetLibraryRequestOptions } from './volcengineAssetLibrary';
import { uploadVolcengineTosReference } from './volcengineTosUpload';

const ASSET_ENDPOINT = 'https://ark.cn-beijing.volcengineapi.com/';

function officialAssetEndpoint(value = ASSET_ENDPOINT): string {
  let endpoint: URL;
  try { endpoint = new URL(value); }
  catch { throw new Error('TOS 素材入库仅支持北京方舟官方接口'); }
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'ark.cn-beijing.volcengineapi.com'
    || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('TOS 素材入库仅支持北京方舟官方接口');
  }
  return endpoint.href;
}

function connectionIdentity(config: ApiProviderConfig | undefined): string {
  return JSON.stringify([config?.catalogId, config?.tosUpload, config?.assetLibrary]);
}

export async function createVolcengineAssetViaTos(
  connectionId: string,
  options: AssetLibraryRequestOptions,
  input: VolcengineAssetCreateInput,
): Promise<{ id: string }> {
  options.signal?.throwIfAborted();
  const connection = useAppStore.getState().config.providers[connectionId];
  if (!connection || resolveProviderCatalogId(connectionId, connection) !== 'volcengine') {
    throw new Error('请从火山方舟连接上传素材');
  }
  const library = connection.assetLibrary;
  if (!library?.enabled || !options.accessKeyId.trim() || !options.secretAccessKey.trim()) {
    throw new Error('请先启用虚拟人像库并保存素材库 AK/SK');
  }
  if (!connection.tosUpload?.bucket || !connection.tosUpload.credentialRef) {
    throw new Error('请先在火山方舟连接中配置私有 TOS Bucket 和 AK/SK');
  }
  if ((options.region || 'cn-beijing') !== 'cn-beijing' || (library.region || 'cn-beijing') !== 'cn-beijing') {
    throw new Error('TOS 素材入库仅支持北京区域');
  }
  const endpoint = officialAssetEndpoint(options.baseUrl);
  if (endpoint !== officialAssetEndpoint(library.apiBaseUrl)
    || (options.projectName?.trim() || 'default') !== (library.projectName?.trim() || 'default')) {
    throw new Error('素材库连接配置已变化，请重新打开上传窗口');
  }
  const source = input.url.trim();
  if (!['Image', 'Video', 'Audio'].includes(input.assetType) || !input.groupId.trim() || !input.name.trim()
    || (!isLocalMediaUrl(source) && !isRemoteMediaUrl(source))) {
    throw new Error('请选择素材类型、本地文件或有效素材 URL，并填写名称和素材组');
  }
  const snapshot = connectionIdentity(connection);
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    if (connectionIdentity(useAppStore.getState().config.providers[connectionId]) !== snapshot) {
      throw new Error('参考素材上传期间连接配置已变化，请重新发起');
    }
  };
  const kind = input.assetType === 'Image' ? 'image' : input.assetType === 'Video' ? 'video' : 'audio';
  const url = await uploadVolcengineTosReference(source, kind, connection.tosUpload && structuredClone(connection.tosUpload),
    options.signal, undefined, assertCurrent, 'asset-ingestion');
  assertCurrent();
  // CreateAsset 只提交一次；失败不自动重投，接收任务不等于素材已经 Active。
  const result = await createAsset({ ...options, baseUrl: endpoint, beforeRequest: () => {
    options.beforeRequest?.();
    assertCurrent();
  } }, { ...input, url, name: input.name.trim(), groupId: input.groupId.trim() });
  try { assertCurrent(); }
  catch {
    const message = '请求期间配置发生变化或操作已取消；素材入库任务可能已受理，请先检查原素材库，勿直接重投';
    if (options.signal?.aborted) throw new DOMException(message, 'AbortError');
    throw new Error(message);
  }
  if (!result.id?.trim()) throw new Error('方舟素材入库未返回素材 ID，请先检查素材库，避免重复提交');
  return result;
}

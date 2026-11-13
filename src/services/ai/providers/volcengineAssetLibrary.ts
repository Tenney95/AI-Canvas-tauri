/**
 * volcengineAssetLibrary — 请求方舟素材分组、素材列表与详情。
 */
import { corsSafeFetch } from '../httpTransport';
import { signVolcengineRequest } from './volcengineSigner';
import type { VolcengineAsset, VolcengineAssetGroup } from '../../../types/volcengineAssetLibrary';
import { isRemoteMediaUrl } from '../../../utils/mediaUrl';

export interface AssetLibraryRequestOptions { accessKeyId: string; secretAccessKey: string; projectName?: string; baseUrl?: string; region?: string; signal?: AbortSignal }
export interface VolcenginePage<T> { items: T[]; nextToken?: string; pageNumber?: number; pageSize?: number; totalCount?: number }
const DEFAULT_ENDPOINT = 'https://ark.cn-beijing.volcengineapi.com/';
function endpoint(action: string, baseUrl = DEFAULT_ENDPOINT): string { const url = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`); url.searchParams.set('Action', action); url.searchParams.set('Version', '2024-01-01'); return url.toString(); }
async function request<T>(action: string, options: AssetLibraryRequestOptions, body: Record<string, unknown>): Promise<T> {
  options.signal?.throwIfAborted();
  let response: Response;
  try {
    const url = endpoint(action, options.baseUrl);
    const rawBody = JSON.stringify(body);
    // 方舟 Assets API 仅支持 AK/SK Signature V4 鉴权；正文可能包含带签名的素材 URL。
    const signed = await signVolcengineRequest({ method: 'POST', url, body: rawBody, accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, region: options.region });
    options.signal?.throwIfAborted();
    response = await corsSafeFetch(url, { method: 'POST', headers: signed.headers, body: rawBody, signal: options.signal,
      credentials: 'omit', redirect: 'error' }, { sensitive: true });
  } catch {
    options.signal?.throwIfAborted();
    throw new Error('方舟素材库请求失败，请检查 AK/SK、接口地址和网络');
  }
  options.signal?.throwIfAborted();
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    options.signal?.throwIfAborted();
    throw new Error(`方舟素材库请求失败（HTTP ${response.status}），请检查凭据权限和素材要求`);
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch {
    options.signal?.throwIfAborted();
    throw new Error('方舟素材库返回了无效响应');
  }
  options.signal?.throwIfAborted();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('方舟素材库返回了无效响应');
  if ('ResponseMetadata' in payload) {
    const metadata = payload.ResponseMetadata;
    if (metadata && typeof metadata === 'object' && 'Error' in metadata && metadata.Error) {
      throw new Error('方舟素材库拒绝了请求，请检查凭据权限和素材要求');
    }
  }
  return payload as T;
}

/** CreateAsset 只接收可公开读取的素材地址，不把 TOS 内网推理链接自动送入素材库。 */
export function validateVolcengineAssetInputUrl(value: string): string {
  const url = typeof value === 'string' ? value.trim() : '';
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new Error('素材库仅接受有效的 HTTP(S) 公共 URL，不支持 Base64 或本地素材地址'); }
  if (!/^https?:\/\//i.test(url) || /\s/.test(url) || !isRemoteMediaUrl(url) || parsed.username || parsed.password) {
    throw new Error('素材库仅接受不含账号的 HTTP(S) 公共 URL，不支持 Base64 或本地素材地址');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'tos-cn-beijing.ivolces.com' || host.endsWith('.tos-cn-beijing.ivolces.com')) {
    throw new Error('素材库不接受 TOS 内网地址，请提供公共可访问的 HTTP(S) URL');
  }
  // 保留签名参数及原编码；不能用 parsed.href 改写素材地址。
  return url;
}
function project(options: AssetLibraryRequestOptions): string { return options.projectName?.trim() || 'default'; }
function unwrapPage<T>(value: unknown, key: string): VolcenginePage<T> { const result = value && typeof value === 'object' ? ((value as Record<string, unknown>).Result ?? value) : null; const record = result && typeof result === 'object' ? result as Record<string, unknown> : {}; const items = record[key]; return { items: Array.isArray(items) ? items as T[] : [], nextToken: typeof record.NextToken === 'string' ? record.NextToken : undefined, pageNumber: typeof record.PageNumber === 'number' ? record.PageNumber : undefined, pageSize: typeof record.PageSize === 'number' ? record.PageSize : undefined, totalCount: typeof record.TotalCount === 'number' ? record.TotalCount : undefined }; }
function unwrapOne<T>(value: unknown): T { return ((value as Record<string, unknown>).Result ?? value) as T; }
function group(value: Record<string, unknown>): VolcengineAssetGroup { return { id: String(value.Id ?? value.id ?? ''), name: String(value.Name ?? value.name ?? ''), description: String(value.Description ?? value.description ?? ''), status: String(value.Status ?? value.status ?? ''), createdAt: String(value.CreateTime ?? value.createdAt ?? ''), updatedAt: String(value.UpdateTime ?? value.updatedAt ?? '') }; }
function asset(value: Record<string, unknown>): VolcengineAsset { return { id: String(value.Id ?? value.id ?? ''), groupId: String(value.GroupId ?? value.groupId ?? ''), name: String(value.Name ?? value.name ?? ''), status: String(value.Status ?? value.status ?? ''), assetType: String(value.AssetType ?? value.assetType ?? ''), thumbnailUrl: String(value.URL ?? value.thumbnailUrl ?? ''), createdAt: String(value.CreateTime ?? value.createdAt ?? ''), updatedAt: String(value.UpdateTime ?? value.updatedAt ?? '') }; }

export async function listAssetGroups(options: AssetLibraryRequestOptions, filter: { name?: string; groupIds?: string[]; pageNumber?: number; pageSize?: number } = {}): Promise<VolcenginePage<VolcengineAssetGroup>> { const page = unwrapPage<Record<string, unknown>>(await request('ListAssetGroups', options, { Filter: { GroupType: 'AIGC', ...(filter.name ? { Name: filter.name } : {}), ...(filter.groupIds ? { GroupIds: filter.groupIds } : {}) }, PageNumber: filter.pageNumber || 1, PageSize: filter.pageSize || 20, ProjectName: project(options) }), 'Items'); return { ...page, items: page.items.map(group) }; }
export async function listAssets(options: AssetLibraryRequestOptions, groupId?: string, name?: string, pageNumber = 1, pageSize = 20): Promise<VolcenginePage<VolcengineAsset>> { const page = unwrapPage<Record<string, unknown>>(await request('ListAssets', options, { Filter: { GroupType: 'AIGC', ...(groupId ? { GroupIds: [groupId] } : {}), ...(name ? { Name: name } : {}), Statuses: ['Active', 'Processing', 'Failed'] }, PageNumber: pageNumber, PageSize: pageSize, ProjectName: project(options) }), 'Items'); return { ...page, items: page.items.map(asset) }; }
export async function getAsset(options: AssetLibraryRequestOptions, id: string): Promise<VolcengineAsset> { return asset(unwrapOne(await request('GetAsset', options, { Id: id, ProjectName: project(options) }))); }
export async function getAssetGroup(options: AssetLibraryRequestOptions, id: string): Promise<VolcengineAssetGroup> { return group(unwrapOne(await request('GetAssetGroup', options, { Id: id, ProjectName: project(options) }))); }
export async function createAssetGroup(options: AssetLibraryRequestOptions, input: { name: string; description?: string }): Promise<VolcengineAssetGroup> { return group(unwrapOne(await request('CreateAssetGroup', options, { Name: input.name, Description: input.description || '', GroupType: 'AIGC', ProjectName: project(options) }))); }
export async function updateAssetGroup(options: AssetLibraryRequestOptions, id: string, input: { name?: string; description?: string }): Promise<VolcengineAssetGroup> { return group(unwrapOne(await request('UpdateAssetGroup', options, { Id: id, ...(input.name !== undefined ? { Name: input.name } : {}), ...(input.description !== undefined ? { Description: input.description } : {}), ProjectName: project(options) }))); }
export async function updateAsset(options: AssetLibraryRequestOptions, id: string, input: { name: string }): Promise<VolcengineAsset> { return asset(unwrapOne(await request('UpdateAsset', options, { Id: id, Name: input.name, ProjectName: project(options) }))); }
export async function deleteAsset(options: AssetLibraryRequestOptions, id: string): Promise<void> { await request('DeleteAsset', options, { Id: id, ProjectName: project(options) }); }
export async function deleteAssetGroup(options: AssetLibraryRequestOptions, id: string): Promise<void> { await request('DeleteAssetGroup', options, { Id: id, ProjectName: project(options) }); }
export async function createAsset(options: AssetLibraryRequestOptions, input: { assetType: 'Image' | 'Video' | 'Audio'; groupId: string; name: string; url: string }): Promise<{ id: string }> { const url = validateVolcengineAssetInputUrl(input.url); const result = unwrapOne<Record<string, unknown>>(await request('CreateAsset', options, { AssetType: input.assetType, GroupId: input.groupId, Name: input.name, ProjectName: project(options), URL: url })); return { id: String(result.Id ?? result.id ?? '') }; }

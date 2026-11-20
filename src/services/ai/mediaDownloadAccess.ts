/**
 * mediaDownloadAccess — 规范化媒体下载凭据与请求并清理结果 URL。
 */
import { APIMART_BASE_URL, GRSAI_BASE_URL, RUNNINGHUB_MODEL_BASE_URL } from '../../constants/api';
import type { MediaDownloadAccess, ModelProtocolAuthConfig } from '../../types/aiTypes';
import { applyQueryAuthentication, renderRequestHeaders } from './modelProtocolRequest';
import { validateAuthentication } from './modelProtocolValidation';
import { resolveProviderCatalogId } from './providerPolicies';
import { isRelayonOfficialBaseUrl } from './relayonProviderGroups';
import { resolveRunningHubCredential, runningHubSiteId } from '../runninghubSiteCredentials';

function httpUrl(value: string): URL {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('媒体下载地址无效');
  }
  return url;
}

/** 只选取无密钥描述字段，不信任旧存储中的额外 headers / apiKey。 */
export function sanitizeMediaDownloadAccess(value: unknown): MediaDownloadAccess | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>;
  if (typeof input.providerConfigId !== 'string' || !input.providerConfigId.trim()
    || input.providerConfigId.length > 256 || typeof input.origin !== 'string') return;
  try {
    const origin = httpUrl(input.origin);
    if (origin.href !== `${origin.origin}/`) return;
    let auth: ModelProtocolAuthConfig | undefined;
    if (input.auth !== undefined) {
      const errors: string[] = [];
      validateAuthentication(input.auth, errors);
      if (errors.length) return;
      const raw = input.auth as ModelProtocolAuthConfig;
      if ([raw.name, raw.prefix].some((text) => text !== undefined
        && (text.length > 256 || Array.from(text).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)))) return;
      auth = { type: raw.type, ...(raw.name !== undefined ? { name: raw.name } : {}),
        ...(raw.prefix !== undefined ? { prefix: raw.prefix } : {}) };
    }
    return { providerConfigId: input.providerConfigId, origin: origin.origin, ...(auth ? { auth } : {}) };
  } catch { return; }
}

export function createMediaDownloadAccess(providerConfigId: string, baseUrl: string, auth?: ModelProtocolAuthConfig): MediaDownloadAccess {
  const access = sanitizeMediaDownloadAccess({ providerConfigId, origin: httpUrl(baseUrl).origin, auth });
  if (!access) throw new Error('媒体下载鉴权配置无效');
  return access;
}

/** 官方图片交付会返回无后缀链接；按原连接决定容器校验，不限制结果的 CDN 来源。 */
export function requiresImageContainerValidation(access?: MediaDownloadAccess): boolean {
  const safe = sanitizeMediaDownloadAccess(access);
  return Boolean(safe && isRelayonOfficialBaseUrl(`${safe.origin}/v1`));
}

export interface MediaDownloadRequest {
  url: string;
  downloadAccess?: { origin: string; headers: Record<string, string>; queryAuthName?: string };
}

/** 外部签名链接不带厂商 Key；同源结果绑定原连接，万象仅兼容两个官方来源。 */
export async function resolveMediaDownloadRequest(url: string, access?: MediaDownloadAccess): Promise<MediaDownloadRequest> {
  if (!access || !/^https?:/i.test(url)) return { url };
  const safe = sanitizeMediaDownloadAccess(access);
  if (!safe) throw new Error('媒体下载鉴权配置无效');
  const target = httpUrl(url);
  if (target.origin !== safe.origin || safe.auth?.type === 'none') return { url };
  const { useAppStore } = await import('../../store/useAppStore');
  const providers = useAppStore.getState().config.providers;
  const id = safe.providerConfigId;
  const provider = providers[id];
  const runningHub = id === 'runninghub' || id === 'runninghub-model';
  const connection = provider && runningHub ? resolveRunningHubCredential(providers, id, runningHubSiteId(safe.origin)) : provider;
  const defaultBaseUrl = runningHub ? RUNNINGHUB_MODEL_BASE_URL
    : id === 'apimart' ? APIMART_BASE_URL : id === 'grsai' ? GRSAI_BASE_URL : '';
  const currentBaseUrl = connection?.baseUrl || defaultBaseUrl;
  const relayonOfficialOrigin = resolveProviderCatalogId(id, provider) === 'relayonapi'
    && isRelayonOfficialBaseUrl(currentBaseUrl) && isRelayonOfficialBaseUrl(`${safe.origin}/v1`);
  if (!connection || !currentBaseUrl || httpUrl(currentBaseUrl).origin !== safe.origin && !relayonOfficialOrigin) {
    throw new Error('原媒体连接或接口地址已变化，请检查原连接配置');
  }
  if (!connection.apiKey) throw new Error('原媒体连接尚未填写 API Key，请补填后继续保存');
  return { url: applyQueryAuthentication(url, safe.auth, connection.apiKey), downloadAccess: {
    origin: safe.origin,
    headers: renderRequestHeaders({ method: 'GET', path: '/' }, safe.auth, connection.apiKey, {}),
    ...(safe.auth?.type === 'query' ? { queryAuthName: safe.auth.name } : {}),
  } };
}

/** 同步结果只保留可重取的 HTTP(S) 引用，内联二进制不写入任务存储。 */
export function sanitizeMediaResultUrls(value: unknown, excludedSecret?: string, maxCount = 32): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxCount) return;
  try {
    return value.map((item) => {
      if (typeof item !== 'string' || item.length > 16384) throw new Error();
      if (excludedSecret && [excludedSecret, encodeURIComponent(excludedSecret)].some((secret) => item.includes(secret))) throw new Error();
      httpUrl(item);
      return item;
    });
  } catch { return; }
}

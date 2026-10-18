/** RunningHub 两站独立凭据；复用 providers 顶层凭据记录及既有原生安全存储。 */
import { RUNNINGHUB_API_SITES, RUNNINGHUB_MODEL_BASE_URL } from '../constants/api';
import type { ApiProviderConfig } from '../types';
import type { RunningHubConnectionId, RunningHubSiteId, RunningHubSiteKeyDrafts } from '../types/runninghub';

interface CredentialEntry { apiKey?: unknown; baseUrl?: unknown; runninghubSiteCredentials?: unknown }

export function runningHubSiteId(baseUrl?: string): RunningHubSiteId | undefined {
  try {
    const url = new URL(baseUrl || RUNNINGHUB_MODEL_BASE_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.search || url.hash
      || !['', '/openapi/v2'].includes(url.pathname.replace(/\/+$/, ''))) return undefined;
    const host = url.hostname.replace(/^www\./, '');
    return host === 'runninghub.cn' ? 'cn' : host === 'runninghub.ai' ? 'ai' : undefined;
  } catch { return undefined; }
}

export function runningHubCredentialId(site: RunningHubSiteId, connection: RunningHubConnectionId): string {
  return `runninghub-credential-${site}-${connection === 'runninghub-model' ? 'model' : 'workflow'}`;
}
export const RUNNINGHUB_CREDENTIAL_IDS = RUNNINGHUB_API_SITES.flatMap((site) =>
  (['runninghub-model', 'runninghub'] as const).map((connection) => runningHubCredentialId(site.id, connection)));

export function isRunningHubCredentialAlias(id: string, entry?: CredentialEntry): boolean {
  return (id === 'runninghub' || id === 'runninghub-model') && entry?.runninghubSiteCredentials === true;
}

/** 不回退到另一站或旧入口的密钥；缺失、地址错配及读取失败都保持空值。 */
export function resolveRunningHubCredential<T extends CredentialEntry>(providers: Record<string, T>, connection: RunningHubConnectionId, taskSite?: RunningHubSiteId): T | undefined {
  const alias = providers[connection];
  if (taskSite) {
    const credential = providers[runningHubCredentialId(taskSite, connection)];
    if (credential) return typeof credential.baseUrl === 'string' && runningHubSiteId(credential.baseUrl) === taskSite ? credential : undefined;
    return !isRunningHubCredentialAlias(connection, alias) && alias
      && runningHubSiteId(typeof alias.baseUrl === 'string' ? alias.baseUrl : undefined) === taskSite ? alias : undefined;
  }
  if (!isRunningHubCredentialAlias(connection, alias)) return alias;
  const site = typeof alias.baseUrl === 'string' ? runningHubSiteId(alias.baseUrl) : undefined;
  if (!site) return undefined;
  const credential = providers[runningHubCredentialId(site, connection)];
  return typeof credential?.baseUrl === 'string' && runningHubSiteId(credential.baseUrl) === site ? credential : undefined;
}

/** 当前入口只派生内存 apiKey，配置持久化层不为这些入口另写密钥。 */
export function hydrateRunningHubAliases<T extends CredentialEntry>(providers: Record<string, T>): Record<string, T> {
  const next = { ...providers };
  for (const id of ['runninghub-model', 'runninghub'] as const) {
    if (!isRunningHubCredentialAlias(id, providers[id])) continue;
    const source = resolveRunningHubCredential(providers, id);
    next[id] = { ...providers[id], apiKey: typeof source?.apiKey === 'string' ? source.apiKey : '' };
  }
  return next;
}

export function runningHubSiteDrafts(providers: Record<string, ApiProviderConfig>): RunningHubSiteKeyDrafts {
  const drafts: RunningHubSiteKeyDrafts = { cn: { modelKey: '', workflowKey: '' }, ai: { modelKey: '', workflowKey: '' } };
  for (const site of RUNNINGHUB_API_SITES) {
    for (const connection of ['runninghub-model', 'runninghub'] as const) {
      const stored = providers[runningHubCredentialId(site.id, connection)];
      const legacy = providers[connection];
      const source = stored ? (runningHubSiteId(stored.baseUrl) === site.id ? stored : undefined)
        : (!isRunningHubCredentialAlias(connection, legacy) && legacy && runningHubSiteId(legacy.baseUrl) === site.id ? legacy : undefined);
      drafts[site.id][connection === 'runninghub-model' ? 'modelKey' : 'workflowKey'] = source?.apiKey || '';
    }
  }
  return drafts;
}

/** 返回 Store Action 的配置输入；密钥保持顶层字段，由统一持久化层摘取。 */
export function buildRunningHubSiteProviders(providers: Record<string, ApiProviderConfig>, model: ApiProviderConfig, drafts: RunningHubSiteKeyDrafts): Record<string, ApiProviderConfig> {
  if (!runningHubSiteId(model.baseUrl)) throw new Error('请先选择 RunningHub 国内站或国际站');
  const next = { ...providers };
  for (const site of RUNNINGHUB_API_SITES) {
    for (const connection of ['runninghub-model', 'runninghub'] as const) {
      const id = runningHubCredentialId(site.id, connection);
      const key = drafts[site.id][connection === 'runninghub-model' ? 'modelKey' : 'workflowKey'].trim();
      const legacy = providers[connection];
      if (!next[id] && !key && legacy?.apiKeyRef && !legacy.apiKey
        && !isRunningHubCredentialAlias(connection, legacy) && runningHubSiteId(legacy.baseUrl) === site.id) {
        throw new Error('原 RunningHub 密钥尚未读取，无法迁移。请重新加载设置或补填原站点密钥后保存');
      }
      // 未改动的空值可能是未读出的凭据，保留其原记录，不能擅自删除。
      if (next[id] && key === next[id].apiKey) continue;
      if (!key) { delete next[id]; continue; }
      next[id] = { ...next[id], name: `RunningHub ${site.label} ${connection === 'runninghub-model' ? '模型' : '工作流'}凭据`, apiKey: key, baseUrl: site.baseUrl };
    }
  }
  next['runninghub-model'] = { ...model, runninghubSiteCredentials: true, apiKey: '' };
  next.runninghub = { ...providers.runninghub, name: 'RunningHub 工作流', apiKey: '', baseUrl: model.baseUrl, runninghubSiteCredentials: true };
  return hydrateRunningHubAliases(next);
}

/**
 * 提供 API Key 设置页的纯展示判定，决定哪些 Provider 连接应出现在已配置列表。
 */
import type { ProviderAuthType } from '../../services/ai/providerCatalogService';
import type { ApiProviderConfig } from '../../types';

export function shouldListProviderConnection(
  config: Pick<ApiProviderConfig, 'apiKey' | 'catalogId' | 'runninghubSiteCredentials'>,
  authType: ProviderAuthType,
  runninghubWorkflowApiKey = '',
): boolean {
  return authType === 'oauth'
    || !!config.apiKey.trim()
    || config.catalogId === 'custom-openai'
    || (config.catalogId === 'runninghub-model' && (!!runninghubWorkflowApiKey.trim() || config.runninghubSiteCredentials === true));
}

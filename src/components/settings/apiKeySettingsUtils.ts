import type { ProviderAuthType } from '../../services/ai/providerCatalogService';
import type { ApiProviderConfig } from '../../types';

export function shouldListProviderConnection(
  config: Pick<ApiProviderConfig, 'apiKey' | 'catalogId'>,
  authType: ProviderAuthType,
): boolean {
  return authType === 'oauth'
    || !!config.apiKey.trim()
    || config.catalogId === 'custom-openai';
}

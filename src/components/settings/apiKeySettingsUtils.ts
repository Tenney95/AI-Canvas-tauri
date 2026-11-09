/**
 * 提供 API Key 设置页的纯展示判定，决定哪些 Provider 连接应出现在已配置列表。
 */
import type { ProviderAuthType } from '../../services/ai/providerCatalogService';
import type { ApiProviderConfig, ProviderModelSelection } from '../../types';
import { assertModelCapabilityProtocol } from '../../services/ai/modelCapabilityValidation';
import { assertVideoModelCapability } from '../../services/ai/videoRequestResolver';

export type CustomConnectionReadiness = 'pending' | 'invalid' | 'ready';

/** 仅描述本地配置，不把有 Key 或语法正确说成连接、真实调用已经验证。 */
export function getCustomConnectionReadiness(models: readonly ProviderModelSelection[] | undefined): CustomConnectionReadiness {
  if (!models?.length) return 'pending';
  let missingProtocol = false;
  for (const model of models) {
    try {
      if (model.category === 'video') assertVideoModelCapability(model.videoCapability);
      assertModelCapabilityProtocol(model);
    } catch {
      return 'invalid';
    }
    if (model.category !== 'text' && !model.executionProfile) missingProtocol = true;
  }
  return missingProtocol ? 'pending' : 'ready';
}

export function shouldListProviderConnection(
  config: Pick<ApiProviderConfig, 'apiKey' | 'catalogId' | 'runninghubSiteCredentials'>,
  authType: ProviderAuthType,
  runninghubWorkflowApiKey = '',
): boolean {
  return authType === 'oauth' || authType === 'browser-session'
    || !!config.apiKey.trim()
    || config.catalogId === 'custom-openai'
    || (config.catalogId === 'runninghub-model' && (!!runninghubWorkflowApiKey.trim() || config.runninghubSiteCredentials === true));
}

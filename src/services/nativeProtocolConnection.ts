/** 恢复时重取原连接的当前配置；直连声明式模型不冒充通用模型目录中的另一个 ID。 */
import { useAppStore } from '../store/useAppStore';
import type { GeneralModelConfig } from '../types';
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { resolveGeneralModelConnection } from './ai/helpers';
import { getProviderDefinition, resolveCccGeminiImageExecutionProfile } from './ai/providerCatalogService';

export function resolveNativeProtocolConnection(record: NativeMediaTaskRecord) {
  const general = record.modelRef?.startsWith('general/') ? resolveGeneralModelConnection(record.modelRef) : undefined;
  if (record.modelRef?.startsWith('general/')) return general?.providerConfigId === record.providerConfigId ? general : undefined;
  if (record.recovery?.kind !== 'general-protocol' || !record.recovery.modelId) return undefined;
  const provider = useAppStore.getState().config.providers[record.providerConfigId];
  if (!provider) return undefined;
  const modelId = record.recovery.modelId;
  const definition = getProviderDefinition(record.providerConfigId, provider);
  const selected = provider.selectedModels?.find((model) => model.id === modelId && model.category === record.category);
  const catalog = definition?.models?.find((model) => model.id === modelId && model.category === record.category);
  const profile = record.category === 'image' && definition?.id === 'cccapi'
    ? resolveCccGeminiImageExecutionProfile(modelId, selected?.executionProfile ?? catalog?.executionProfile)
    : selected?.executionProfile ?? catalog?.executionProfile;
  if (!profile) return undefined;
  const model: GeneralModelConfig = { id: modelId, modelId, name: selected?.name ?? catalog?.name ?? modelId,
    category: record.category, providerConfigId: record.providerConfigId, executionProfile: profile };
  return { model, provider, providerConfigId: record.providerConfigId,
    baseUrl: provider.baseUrl?.trim() || definition?.defaultBaseUrl || '', apiKey: provider.apiKey || '' };
}

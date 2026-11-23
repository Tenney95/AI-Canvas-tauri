import { getProviderDefinition, KLING_BASE_URL, KLING_IMAGE_MODEL_MANIFEST } from '../../../src/services/ai/providerCatalogService';
import { useAppStore } from '../../../src/store/useAppStore';

export function configureKling(series: boolean | string = false) {
  const selected = structuredClone(typeof series === 'string'
    ? getProviderDefinition('kling')!.models!.find((model) => model.id === series)!
    : KLING_IMAGE_MODEL_MANIFEST[series ? 1 : 0]);
  useAppStore.setState((state) => ({ config: { ...state.config, providers: {
    official: { name: 'Kling', apiKey: 'kling-fixture', catalogId: 'kling', baseUrl: KLING_BASE_URL, selectedModels: [selected] },
  }, generalModels: [{ id: 'kling', name: selected.name, modelId: selected.id, category: 'image', providerConfigId: 'official',
    executionProfile: selected.executionProfile, imageCapability: selected.imageCapability }] } }));
  return { model: 'general/kling', provider: 'general', prompt: 'A landscape' };
}

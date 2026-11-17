import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelGroup, WorkflowDefinition } from '../../src/types';
import type { ImageModelCapability } from '../../src/types/aiTypes';
import type { CharacterVisualModel } from '../../src/services/characterVisualWorkbenchService';

const driver = vi.hoisted(() => ({
  state: { config: { providers: {}, generalModels: [] }, workflows: [] as WorkflowDefinition[] },
  groups: [] as ModelGroup[],
  capability: { qualities: ['low', 'high'], defaultQuality: 'low', backgrounds: ['auto', 'transparent'], defaultBackground: 'auto' } as ImageModelCapability,
}));
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'), useMemo: <T,>(factory: () => T) => factory() }));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: (selector: (state: typeof driver.state) => unknown) => selector(driver.state) }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('../../src/components/nodes/shared/defaultModels', () => ({ getConfiguredModelGroups: () => driver.groups }));
vi.mock('../../src/components/nodes/shared/ModelSelector', () => ({ default: 'model-selector' }));
vi.mock('../../src/components/nodes/shared/QualityRatioSelector', () => ({ default: 'quality-ratio' }));
vi.mock('../../src/components/nodes/shared/CloudWorkflowParamSelector', () => ({ default: 'workflow-parameters' }));
vi.mock('../../src/components/nodes/shared/RunningHubParameterFields', () => ({ RunningHubModelParameterFields: 'runninghub-parameters' }));
vi.mock('../../src/services/ai/mediaModelCapabilities', () => ({ resolveImageParameterCapability: () => driver.capability }));
vi.mock('../../src/services/ai/providers/runninghubModelManifest', () => ({ getRunningHubModel: () => undefined }));
vi.mock('../../src/services/ai/providerCatalogService', () => ({ getProviderDefinition: () => undefined }));
import CharacterVisualGenerationSettings from '../../src/components/character/CharacterVisualGenerationSettings';
import ModelSelector from '../../src/components/nodes/shared/ModelSelector';
import QualityRatioSelector from '../../src/components/nodes/shared/QualityRatioSelector';

interface Element { type?: unknown; props: Record<string, unknown> & { children?: unknown } }
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element; return [element, ...elements(element.props.children)];
}
const image = (provider: string): CharacterVisualModel => ({ id: `${provider}/image`, provider, label: provider,
  ratios: ['1:1', '2:3'], resolutions: ['1K', '4K'], defaultRatio: '1:1', defaultResolution: '1K',
  supportsReferences: true, supportsMask: false, channel: 'standard', maxReferences: 2 });
const render = (props: ComponentProps<typeof CharacterVisualGenerationSettings>) => elements(CharacterVisualGenerationSettings(props));

beforeEach(() => { driver.state.workflows = []; driver.groups = [];
  driver.capability = { qualities: ['low', 'high'], defaultQuality: 'low', backgrounds: ['auto', 'transparent'], defaultBackground: 'auto' }; });
describe('shared character generation controls', () => {
  it('passes configured provider models and workflows to the image-node selector without changing node preferences', () => {
    const models = [image('apimart'), image('cccapi'), { ...image('comfyui'), workflowId: 'workflow' }];
    driver.state.workflows = [{ id: 'workflow', name: 'Workflow', category: 'ai-image' } as WorkflowDefinition];
    driver.groups = models.slice(0, 2).map((model) => ({ id: model.provider, name: model.label,
      models: [{ value: model.id, provider: model.provider, label: model.label, nodeTypes: ['ai-image'] }] } as ModelGroup));
    const onSelect = vi.fn(), onChange = vi.fn();
    const tree = render({ models, model: models[0], values: {}, onSelect, onChange });
    const selector = tree.find((element) => element.type === ModelSelector)!.props as unknown as ComponentProps<typeof ModelSelector>;
    expect(selector.persistPreference).toBe(false);
    expect(selector.configuredGroupsOverride?.map((group) => group.id)).toEqual(['apimart', 'cccapi']);
    expect(selector.workflows?.map((workflow) => workflow.id)).toEqual(['workflow']);
    selector.onWorkflowSelect?.('workflow');
    expect(onSelect).toHaveBeenCalledWith(models[2]);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ workflowInputs: {}, runninghubModelParameters: {} }));
  });

  it('passes declared GIF parameters to shared controls and clears them on model or workflow changes', () => {
    const model = image('cccapi'), workflowModel = { ...image('comfyui'), workflowId: 'workflow' }, onChange = vi.fn();
    driver.state.workflows = [{ id: 'workflow', name: 'Workflow', category: 'ai-image' } as WorkflowDefinition];
    Object.assign(driver.capability, { outputFormats: ['png', 'gif', 'svg'], defaultOutputFormat: 'png',
      squareOnlyOutputFormats: ['gif', 'svg'], textOnlyOutputFormats: ['gif', 'svg'] });
    const values = { imageOutputFormat: 'gif' as const, imageFrameCount: 9, imageFrameDurationMs: 200, imageTransparent: false };
    const tree = render({ models: [model, workflowModel], model, values, onSelect: vi.fn(), onChange });
    const control = tree.find((element) => element.type === QualityRatioSelector)!.props as unknown as ComponentProps<typeof QualityRatioSelector>;
    expect(control.ratios).toEqual(['1:1']); expect(control.imageOutputParameters).toEqual(values);
    control.onChangeImageOutputParameters?.({ imageTransparent: false });
    expect(onChange).toHaveBeenLastCalledWith({ imageTransparent: false });
    driver.capability = {};
    const selector = tree.find((element) => element.type === ModelSelector)!.props as unknown as ComponentProps<typeof ModelSelector>;
    selector.onWorkflowSelect?.('workflow');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ imageOutputFormat: undefined,
      imageFrameCount: undefined, imageFrameDurationMs: undefined, imageTransparent: undefined }));
  });

  it('uses the shared ratio and resolution panel and independently preserves an explicit API background default', () => {
    const model = image('cccapi'), onChange = vi.fn();
    const tree = render({ models: [model], model, values: { imageSize: '4K', aspectRatio: '2:3', imageQuality: 'high', imageBackground: '' },
      onSelect: vi.fn(), onChange, disabled: true });
    const selector = tree.find((element) => element.type === QualityRatioSelector)!.props as unknown as ComponentProps<typeof QualityRatioSelector>;
    expect(selector.imageSizes).toEqual(['1K', '4K']); expect(selector.ratios).toEqual(['1:1', '2:3']);
    expect(selector.imageQuality).toBe('high'); expect(selector.imageBackground).toBe('');
    expect(selector.fixedMenu).toBe(true); expect(selector.disabled).toBe(true);
    selector.onChangeImageBackground?.('');
    expect(onChange).toHaveBeenCalledWith({ imageBackground: '' });
  });
});

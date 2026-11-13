import { useMemo } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import type { CharacterVisualGenerationParameters } from '../../types/media';
import type { CharacterVisualModel } from '../../services/characterVisualWorkbenchService';
import { resolveImageParameterCapability } from '../../services/ai/mediaModelCapabilities';
import { getProviderDefinition } from '../../services/ai/providerCatalogService';
import { getRunningHubModel } from '../../services/ai/providers/runninghubModelManifest';
import { getConfiguredModelGroups } from '../nodes/shared/defaultModels';
import ModelSelector from '../nodes/shared/ModelSelector';
import QualityRatioSelector from '../nodes/shared/QualityRatioSelector';
import CloudWorkflowParamSelector from '../nodes/shared/CloudWorkflowParamSelector';
import { RunningHubModelParameterFields } from '../nodes/shared/RunningHubParameterFields';

interface Props {
  models: CharacterVisualModel[];
  model?: CharacterVisualModel;
  values: CharacterVisualGenerationParameters;
  disabled?: boolean;
  onSelect: (model: CharacterVisualModel) => void;
  onChange: (patch: CharacterVisualGenerationParameters) => void;
}

export default function CharacterVisualGenerationSettings({ models, model, values, disabled, onSelect, onChange }: Props) {
  const t = useT();
  const { config, workflows } = useAppStore(useShallow((state) => ({ config: state.config, workflows: state.workflows })));
  const groups = useMemo(() => getConfiguredModelGroups(config, 'ai-image').map((group) => ({ ...group,
    models: group.models.filter((option) => models.some((item) => item.id === option.value && item.provider === option.provider)),
  })).filter((group) => group.models.length > 0), [config, models]);
  const generalModels = useMemo(() => (config.generalModels ?? []).filter((option) =>
    models.some((item) => item.id === `general/${option.id}` && item.provider === 'general')), [config.generalModels, models]);
  const availableWorkflows = workflows.filter((workflow) => models.some((item) => item.workflowId === workflow.id));
  const workflow = availableWorkflows.find((item) => item.id === model?.workflowId);
  const capability = model && !workflow ? resolveImageParameterCapability(model.id, model.provider, config) : undefined;
  const runninghub = model?.provider === 'runninghub' ? getRunningHubModel(model.id) : undefined;
  const general = model?.provider === 'general' ? config.generalModels?.find((item) => `general/${item.id}` === model.id) : undefined;
  const connectionId = general?.providerConfigId ?? model?.connectionId ?? model?.provider;
  const connection = connectionId ? config.providers[connectionId] : undefined;
  const modelId = general?.modelId ?? (connectionId && model?.id.startsWith(`${connectionId}/`) ? model.id.slice(connectionId.length + 1) : model?.id);
  const settingsModel = connectionId && connection && getProviderDefinition(connectionId, connection)?.id === 'custom-openai'
    ? connection.selectedModels?.find((item) => item.category === 'image' && item.id === modelId) : undefined;
  const needsParameterSettings = settingsModel && (!capability?.ratios?.length
    || capability?.hasResolutionField !== false && !capability?.resolutions?.length);
  const select = (next?: CharacterVisualModel) => {
    if (!next || disabled) return;
    const nextCapability = resolveImageParameterCapability(next.id, next.provider, config);
    onSelect(next);
    onChange({
      aspectRatio: next.ratios.includes(values.aspectRatio ?? '') ? values.aspectRatio : next.defaultRatio ?? next.ratios[0],
      imageSize: next.resolutions.find((value) => value.toLowerCase() === values.imageSize?.toLowerCase()) ?? next.defaultResolution ?? next.resolutions[0],
      imageQuality: nextCapability?.qualities?.find((value) => value.toLowerCase() === values.imageQuality?.toLowerCase()) ?? nextCapability?.defaultQuality,
      imageBackground: nextCapability?.backgroundIsFixed ? nextCapability.defaultBackground : values.imageBackground === '' ? ''
        : nextCapability?.backgrounds?.find((value) => value.toLowerCase() === values.imageBackground?.toLowerCase()) ?? nextCapability?.defaultBackground,
      workflowInputs: {}, runninghubModelParameters: {},
    });
  };
  return <div className="ui-stack ui-stack--tight min-w-0">
    <div className="flex flex-wrap items-center gap-2">
      <ModelSelector nodeType="ai-image" appearance="pill" persistPreference={false}
        selectedModel={model?.id} selectedProvider={model?.provider} selectedWorkflowId={model?.workflowId}
        configuredGroupsOverride={groups} generalModelsOverride={generalModels} workflows={availableWorkflows}
        disabled={disabled || !models.length}
        onSelect={(option) => select(models.find((item) => item.id === option.value && item.provider === option.provider))}
        onWorkflowSelect={(workflowId) => { if (workflowId) select(models.find((item) => item.workflowId === workflowId)); }} />
      {needsParameterSettings && settingsModel ? <button type="button" className="img-pill-btn" disabled={disabled}
        aria-label={t('打开 {name} 图片参数设置', { name: settingsModel.name })}
        onClick={() => useAppStore.getState().openApiKeySettings(connectionId, settingsModel.id)}>
        <Icon icon="lucide:sliders-horizontal" width="16" /><span>{t('参数')}</span>
      </button> : workflow ? <CloudWorkflowParamSelector key={workflow.id} workflow={workflow} values={values.workflowInputs}
        disabled={disabled} onChange={(workflowInputs, aspectRatio) => onChange({ workflowInputs, ...(aspectRatio ? { aspectRatio } : {}) })} />
        : model && !runninghub && (model.ratios.length > 0 || model.resolutions.length > 0) ?
          <QualityRatioSelector key={model.id} fixedMenu disabled={disabled}
            aspectRatio={(values.aspectRatio ?? model.defaultRatio ?? model.ratios[0]) === 'auto' ? '自适应' : values.aspectRatio ?? model.defaultRatio ?? model.ratios[0]}
            imageSize={values.imageSize ?? model.defaultResolution ?? model.resolutions[0]}
            showAdaptive={model.ratios.includes('auto') || model.defaultRatio === 'auto'}
            ratios={model.ratios.filter((value) => value !== 'auto')} showImageSize={model.resolutions.length > 0} imageSizes={model.resolutions}
            imageQuality={values.imageQuality} imageQualities={capability?.qualities} defaultImageQuality={capability?.defaultQuality}
            imageBackground={values.imageBackground} imageBackgrounds={capability?.backgrounds}
            defaultImageBackground={capability?.defaultBackground} imageBackgroundIsFixed={capability?.backgroundIsFixed}
            onChangeAspectRatio={(value) => onChange({ aspectRatio: value === '自适应' ? 'auto' : value })}
            onChangeImageSize={(imageSize) => onChange({ imageSize })}
            onChangeImageQuality={(imageQuality) => onChange({ imageQuality })}
            onChangeImageBackground={(imageBackground) => onChange({ imageBackground })} /> : null}
    </div>
    {runninghub && <details className="ui-card p-2">
      <summary className="cursor-pointer text-xs">{t('模型参数 · {count} 项需填写', {
        count: runninghub.parameters.filter((field) => field.required && !field.binding && field.defaultValue === undefined).length,
      })}</summary>
      <div className="mt-2 max-h-80 overflow-y-auto"><RunningHubModelParameterFields model={runninghub}
        values={values.runninghubModelParameters ?? {}} disabled={disabled}
        onChange={(runninghubModelParameters) => onChange({ runninghubModelParameters })} /></div>
    </details>}
  </div>;
}

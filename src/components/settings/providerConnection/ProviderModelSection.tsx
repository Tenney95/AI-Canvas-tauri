/**
 * settings/providerConnection/ProviderModelSection — 启用模型区块。
 *
 * 承载模型清单的搜索 / 分类筛选 / 勾选 / 分类修正 / 协议与视频能力入口，
 * 以及自定义连接专属的手动添加模型。
 */
import Select from '../../shared/Select';
import { Icon } from '@iconify/react';
import { useCallback, useEffect, useId, useRef, type Dispatch, type SetStateAction } from 'react';
import { GENERAL_MODEL_CATEGORY_LABELS } from '../../../types';
import type {
  GeneralModelCategory,
  ImageReferenceRequestMode,
  ProviderModelSelection,
} from '../../../types';
import type { ImageModelCapability, VideoModelCapability } from '../../../types/aiTypes';
import { resolveKlingModelContract, type ProviderDefinition } from '../../../services/ai/providerCatalogService';
import { resolveEffectivePromptLimits } from '../../../services/ai/imagePromptLimits';
import { resolveConfiguredVideoCapability } from '../../../services/ai/videoModelCapabilityResolver';
import { normalizeBaseUrl } from '../../../services/ai/providerBaseUrl';
import { createSeedanceQuickAdaptTemplate } from '../../../services/ai/seedanceModelCapabilities';
import { createH3QuickAdaptTemplate } from '../../../services/ai/h3ModelCapabilities';
import { useT } from '../../../i18n';
import AnimatedButton from '../../shared/AnimatedButton';
import PopupCloseButton from '../../shared/PopupCloseButton';
import ModelProtocolEditor from '../ModelProtocolEditor';
import VideoCapabilityEditor from './VideoCapabilityEditor';
import ImageCapabilityEditor from './ImageCapabilityEditor';
import { describeModelParameterGaps } from '../../../services/ai/modelCapabilityValidation';
import { CATEGORY_ORDER, type CatalogStatus } from './providerConnectionShared';

interface ProviderModelSectionProps {
  definition: ProviderDefinition;
  models: ProviderModelSelection[];
  filteredModels: ProviderModelSelection[];
  selectedModels: ProviderModelSelection[];
  selectedIds: Set<string>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  category: GeneralModelCategory | 'all';
  setCategory: Dispatch<SetStateAction<GeneralModelCategory | 'all'>>;
  visibleModelCategories: Set<GeneralModelCategory>;
  catalogStatus: CatalogStatus;
  catalogMessage: string;
  missingCredentials: boolean;
  apiKey: string;
  baseUrl: string;
  setProtocolValid: Dispatch<SetStateAction<boolean>>;
  onProtocolDraftInvalidChange: (invalid: boolean) => void;
  testSessionScope: string;
  onOpenModelSettings: (modelId: string, kind: 'image' | 'video' | 'protocol') => Promise<boolean>;
  protocolModel: ProviderModelSelection | undefined;
  imageCapabilityModel: ProviderModelSelection | undefined;
  setImageCapabilityModelId: Dispatch<SetStateAction<string | null>>;
  onUpdateImageCapability: (modelId: string, capability: ImageModelCapability) => void;
  onApplyImageTemplate: (modelId: string, templateId: string) => void;
  videoCapabilityModel: ProviderModelSelection | undefined;
  setVideoCapabilityModelId: Dispatch<SetStateAction<string | null>>;
  categoryEditModelId: string | null;
  setCategoryEditModelId: Dispatch<SetStateAction<string | null>>;
  manualModelId: string;
  setManualModelId: Dispatch<SetStateAction<string>>;
  manualModelName: string;
  setManualModelName: Dispatch<SetStateAction<string>>;
  manualCategory: GeneralModelCategory;
  setManualCategory: Dispatch<SetStateAction<GeneralModelCategory>>;
  onToggleModel: (modelId: string) => void;
  onToggleVisibleModels: () => void;
  onToggleVisibleCategory: (category: GeneralModelCategory) => void;
  onToggleAllVisibleCategories: () => void;
  onAddManualModel: () => void;
  onUpdateModelCategory: (modelId: string, category: GeneralModelCategory) => void;
  onUpdateModelContextWindow: (modelId: string, raw: string) => void;
  onUpdateModelDescription: (modelId: string, description: string) => void;
  onUpdateModelVisionCapability: (modelId: string, enabled: boolean) => void;
  onUpdateModelProtocol: (
    modelId: string,
    executionProfile: ProviderModelSelection['executionProfile'],
  ) => void;
  onUpdateVideoCapability: (modelId: string, capability: VideoModelCapability | undefined) => void;
  onUpdateImageReferenceRequestMode: (modelId: string, mode: ImageReferenceRequestMode | undefined) => void;
  onCloseProtocolEditor: () => void;
  onFetchModels: () => void;
}

function PromptBudgetInput({ label, value, maximum, update }: {
  label: string; value: number; maximum: number; update: (value: number) => void;
}) {
  const id = useId();
  return <div className="ui-field">
    <label className="ui-label" htmlFor={id}>{label} (1–{maximum.toLocaleString()})</label>
    <input id={id} key={value} className="ui-input w-full" type="number" min={1} max={maximum} step={1}
      defaultValue={value} onBlur={({ currentTarget }) => {
        const next = currentTarget.valueAsNumber;
        if (!Number.isSafeInteger(next) || !currentTarget.validity.valid) {
          currentTarget.value = String(value);
          return;
        }
        if (next !== value) update(next);
      }} />
  </div>;
}

function KlingLengthEditor({ model, verified, onImage, onVideo, onClose }: {
  model: ProviderModelSelection;
  verified: ProviderModelSelection;
  onImage: (capability: ImageModelCapability) => void;
  onVideo: (capability: VideoModelCapability) => void;
  onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const video = verified.videoCapability;
  const image = verified.imageCapability;
  const published = video ?? image;
  const effectiveVideo = video && resolveConfiguredVideoCapability('kling', model.id, model.executionProfile, model.videoCapability);
  const configured = effectiveVideo ?? model.imageCapability;
  const limits = resolveEffectivePromptLimits(published ?? {}, configured);
  const maximum = published?.promptMaxCharacters;
  const nonAsciiMaximum = published?.promptMaxNonAsciiCharacters;
  const minDuration = effectiveVideo?.minDuration;
  const maxDuration = effectiveVideo?.maxDuration;
  const updateLimit = (promptMaxCharacters?: number, promptMaxNonAsciiCharacters?: number) => {
    const next = resolveEffectivePromptLimits(published ?? {}, { promptMaxCharacters, promptMaxNonAsciiCharacters });
    if (effectiveVideo) onVideo({ ...effectiveVideo, ...next });
    else if (image) onImage({ ...image, ...model.imageCapability, ...next });
  };
  const updateDuration = (minDuration: number, maxDuration: number) => {
    if (!effectiveVideo) return;
    const next = resolveConfiguredVideoCapability('kling', model.id, model.executionProfile, {
      ...effectiveVideo, durations: undefined, minDuration, maxDuration,
    });
    if (next) onVideo(next);
  };
  const title = t(video ? '视频参数能力' : '图片参数能力');
  return <section aria-labelledby={`${id}-title`} className="rounded-lg border border-canvas-border p-3">
    <div className="mb-3 flex items-center justify-between gap-3">
      <strong id={`${id}-title`}>{model.name} · {title}</strong>
      <PopupCloseButton ariaLabel={t('关闭')} onClick={onClose} />
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      {maximum !== undefined && limits.promptMaxCharacters !== undefined ? <PromptBudgetInput label={t('提示词最多字符')}
        value={limits.promptMaxCharacters} maximum={maximum} update={(next) => updateLimit(next, limits.promptMaxNonAsciiCharacters)} /> : null}
      {nonAsciiMaximum !== undefined && limits.promptMaxNonAsciiCharacters !== undefined ? <PromptBudgetInput label={t('非 ASCII 提示词预算')}
        value={limits.promptMaxNonAsciiCharacters} maximum={Math.min(nonAsciiMaximum, limits.promptMaxCharacters ?? nonAsciiMaximum)}
        update={(next) => updateLimit(limits.promptMaxCharacters, next)} /> : null}
      {video?.durations && minDuration !== undefined && maxDuration !== undefined ? <>
        <div className="ui-field">
          <label className="ui-label" htmlFor={`${id}-min`}>{t('最短生成时长（秒）')}</label>
          <Select className="w-full" id={`${id}-min`} value={minDuration}
            onChange={(seconds) => updateDuration(Number(seconds), maxDuration)}>
            {video.durations.filter((seconds) => seconds <= maxDuration).map((seconds) => (
              <option key={seconds} value={String(seconds)}>{seconds}</option>
            ))}
          </Select>
        </div>
        <div className="ui-field">
          <label className="ui-label" htmlFor={`${id}-max`}>{t('最长时长（秒）')}</label>
          <Select className="w-full" id={`${id}-max`} value={maxDuration}
            onChange={(seconds) => updateDuration(minDuration, Number(seconds))}>
            {video.durations.filter((seconds) => seconds >= minDuration).map((seconds) => (
              <option key={seconds} value={String(seconds)}>{seconds}</option>
            ))}
          </Select>
        </div>
      </> : null}
    </div>
    {nonAsciiMaximum !== undefined ? <p className="ui-hint mt-2">{t('混合提示词按 ASCII/最多字符 + 非 ASCII/非 ASCII 预算 ≤ 1 校验。')}</p> : null}
    {video?.resolutions ? <p className="ui-hint mt-2">{t('分辨率')} · {video.resolutions.join(' / ')}</p> : null}
    <button type="button" className="provider-text-btn mt-2" onClick={() => {
      if (video) onVideo(video);
      else if (image) onImage(image);
    }}>{t('恢复默认配置')}</button>
  </section>;
}

export default function ProviderModelSection({
  definition,
  models,
  filteredModels,
  selectedModels,
  selectedIds,
  query,
  setQuery,
  category,
  setCategory,
  visibleModelCategories,
  catalogStatus,
  catalogMessage,
  missingCredentials,
  apiKey,
  baseUrl,
  setProtocolValid,
  onProtocolDraftInvalidChange,
  testSessionScope,
  onOpenModelSettings,
  protocolModel,
  imageCapabilityModel,
  setImageCapabilityModelId,
  onUpdateImageCapability,
  onApplyImageTemplate,
  videoCapabilityModel,
  setVideoCapabilityModelId,
  categoryEditModelId,
  setCategoryEditModelId,
  manualModelId,
  setManualModelId,
  manualModelName,
  setManualModelName,
  manualCategory,
  setManualCategory,
  onToggleModel,
  onToggleVisibleModels,
  onToggleVisibleCategory,
  onToggleAllVisibleCategories,
  onAddManualModel,
  onUpdateModelCategory,
  onUpdateModelContextWindow,
  onUpdateModelDescription,
  onUpdateModelVisionCapability,
  onUpdateModelProtocol,
  onUpdateVideoCapability,
  onUpdateImageReferenceRequestMode,
  onCloseProtocolEditor,
  onFetchModels,
}: ProviderModelSectionProps) {
  const t = useT();
  const editableProtocols = definition.id === 'custom-openai';
  const klingContracts = new Map<string, ProviderModelSelection>();
  if (definition.id === 'kling') {
    for (const model of selectedModels) {
      const contract = resolveKlingModelContract(model.id, model.executionProfile);
      if (contract?.category === model.category) klingContracts.set(model.id, contract);
    }
  }
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsScrollFrameRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (settingsScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(settingsScrollFrameRef.current);
    }
  }, []);

  const scrollToSettings = useCallback(() => {
    if (settingsScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(settingsScrollFrameRef.current);
    }
    // 等本次点击展开的编辑器挂载后再定位；重复点击同一模型也会重新定位。
    settingsScrollFrameRef.current = window.requestAnimationFrame(() => {
      settingsScrollFrameRef.current = null;
      if (!settingsRef.current?.firstElementChild) return;
      settingsRef.current.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        block: 'start',
        inline: 'nearest',
      });
    });
  }, []);

  const protocolSettingsId = protocolModel?.id;
  const videoSettingsId = videoCapabilityModel?.id;
  const imageSettingsId = imageCapabilityModel?.id;
  useEffect(() => {
    if (protocolSettingsId || videoSettingsId || imageSettingsId) scrollToSettings();
  }, [protocolSettingsId, videoSettingsId, imageSettingsId, scrollToSettings]);

  return (
    <section className="provider-model-section">
      <div className="provider-section-heading provider-model-heading">
        <div>
          <h4>{t('启用模型')}</h4>
          <p>{t('仅勾选会在应用中使用的模型')}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <AnimatedButton
            type="button"
            className="provider-fetch-btn"
            disabled={missingCredentials || catalogStatus === 'loading'}
            onClick={() => void onFetchModels()}
          >
            <Icon
              icon={catalogStatus === 'loading' ? 'mdi:loading' : 'mdi:cloud-download-outline'}
              className={catalogStatus === 'loading' ? 'settings-spin' : undefined}
              width="15"
            />
            {catalogStatus === 'loading' ? t('拉取中') : t('拉取模型')}
          </AnimatedButton>
        </div>
      </div>

      <div className="mb-3 flex min-h-8 items-center justify-between gap-3 rounded-md border border-canvas-border bg-white/[0.03] px-2.5 py-1.5">
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-canvas-text-secondary">
          <Icon icon="mdi:eye-outline" width="14" />
          {t('是否在对应类型节点中显示')}
        </span>
        <div className="flex min-w-0 flex-wrap justify-end gap-1" role="group" aria-label={t('节点列表显示分类')}>
          <button
            type="button"
            aria-pressed={visibleModelCategories.size === CATEGORY_ORDER.length}
            className={`provider-category-choice is-all h-6 rounded px-2 text-[9px] ${
              visibleModelCategories.size === CATEGORY_ORDER.length ? 'is-active' : ''
            }`}
            onClick={onToggleAllVisibleCategories}
          >
            {t('全部')}
          </button>
          {CATEGORY_ORDER.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={visibleModelCategories.has(item)}
              className={`provider-category-choice is-${item} h-6 rounded px-2 text-[9px] ${
                visibleModelCategories.has(item) ? 'is-active' : ''
              }`}
              onClick={() => onToggleVisibleCategory(item)}
            >
              {t(GENERAL_MODEL_CATEGORY_LABELS[item])}
            </button>
          ))}
        </div>
      </div>

      {catalogMessage && (
        <div className={`provider-catalog-message is-${catalogStatus}`} role="status">
          <Icon
            icon={catalogStatus === 'error' ? 'mdi:alert-circle-outline' : 'mdi:information-outline'}
            width="14"
          />
          <span>{catalogMessage}</span>
        </div>
      )}

      {models.length > 0 && (
        <>
          <div className="provider-model-toolbar">
            <label className="provider-search">
              <Icon icon="mdi:magnify" width="15" />
              <input
                type="search"
                value={query}
                placeholder={t('搜索模型 ID 或名称')}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="provider-category-tabs" aria-label={t('模型类别')}>
              <button
                type="button"
                aria-pressed={category === 'all'}
                className={`provider-category-choice is-all ${category === 'all' ? 'is-active' : ''}`}
                onClick={() => setCategory('all')}
              >
                {t('全部')}
              </button>
              {CATEGORY_ORDER.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={category === item}
                  className={`provider-category-choice is-${item} ${category === item ? 'is-active' : ''}`}
                  onClick={() => setCategory(item)}
                >
                  {t(GENERAL_MODEL_CATEGORY_LABELS[item])}
                </button>
              ))}
            </div>
          </div>

          <div className="provider-model-list-head">
            <label>
              <input
                type="checkbox"
                checked={filteredModels.length > 0 && filteredModels.every((model) => selectedIds.has(model.id))}
                onChange={onToggleVisibleModels}
              />
              <span>{t('选择当前结果')}</span>
            </label>
            <span>{t('已选 {count} 个模型', { count: selectedModels.length })}</span>
          </div>

          <div className="provider-model-list">
            {filteredModels.length > 0 ? filteredModels.map((model) => (
              <div
                key={model.id}
                className={`provider-model-row ${categoryEditModelId === model.id ? 'provider-model-row--editing' : ''}`}
              >
                <button
                  type="button"
                  className={`provider-model-kind is-${model.category}`}
                  aria-label={t('修改 {name} 的模型分类，当前为{category}', { name: model.name, category: t(GENERAL_MODEL_CATEGORY_LABELS[model.category]) })}
                  title={t("点击修改模型分类")}
                  aria-expanded={categoryEditModelId === model.id}
                  onClick={() => setCategoryEditModelId((current) => current === model.id ? null : model.id)}
                >
                  {t(GENERAL_MODEL_CATEGORY_LABELS[model.category])}
                </button>
                <label className="provider-model-select">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(model.id)}
                    onChange={() => onToggleModel(model.id)}
                  />
                  <span className="provider-model-copy">
                    <strong>{model.name}</strong>
                    <small>{model.id}</small>
                    {editableProtocols && describeModelParameterGaps(model) ?
                      <small>{t(describeModelParameterGaps(model))}</small> : null}
                  </span>
                </label>
                {(editableProtocols || klingContracts.has(model.id)) && selectedIds.has(model.id) ? (
                  <>
                    {model.category === 'image' ? (
                      <AnimatedButton type="button"
                        className={`ui-btn ui-icon-btn ui-icon-btn--sm${imageSettingsId === model.id ? ' is-active' : ''}`}
                        aria-label={t('配置 {name} 图片参数能力', { name: model.name })} title={t("图片参数能力")}
                        aria-pressed={imageSettingsId === model.id}
                        onClick={() => {
                          void onOpenModelSettings(model.id, 'image').then((opened) => { if (opened) scrollToSettings(); });
                        }}><Icon icon="lucide:image" width="16" /></AnimatedButton>
                    ) : null}
                    {model.category === 'video' ? (
                      <AnimatedButton
                        type="button"
                        className={`ui-btn ui-icon-btn ui-icon-btn--sm${videoSettingsId === model.id ? ' is-active' : ''}`}
                        aria-label={t('配置 {name} 视频参数能力', { name: model.name })}
                        title={t("视频参数能力")}
                        aria-pressed={videoSettingsId === model.id}
                        onClick={() => {
                          void onOpenModelSettings(model.id, 'video').then((opened) => { if (opened) scrollToSettings(); });
                        }}
                      >
                        <Icon icon="lucide:video" width="16" />
                      </AnimatedButton>
                    ) : null}
                    <AnimatedButton
                      type="button"
                      className={`ui-btn ui-icon-btn ui-icon-btn--sm${protocolSettingsId === model.id ? ' is-active' : ''}`}
                      aria-label={t('配置 {name} 调用协议', { name: model.name })}
                      title={t("调用协议")}
                      aria-pressed={protocolSettingsId === model.id}
                      onClick={() => {
                        void onOpenModelSettings(model.id, 'protocol').then((opened) => { if (opened) scrollToSettings(); });
                      }}
                    >
                      <Icon icon="lucide:sliders-horizontal" width="16" />
                    </AnimatedButton>
                  </>
                  ) : null}
                {categoryEditModelId === model.id ? (
                  <div
                    className="provider-model-category-editor"
                    role="group"
                    aria-label={t('选择 {name} 的模型分类', { name: model.name })}
                  >
                    <span className="provider-model-category-editor-title">{t("分类")}</span>
                    {CATEGORY_ORDER.map((item) => (
                      <button
                        key={item}
                        type="button"
                        aria-pressed={model.category === item}
                        className={`provider-category-choice is-${item} ${model.category === item ? 'is-active' : ''}`}
                        onClick={() => {
                          if (model.category === item) setCategoryEditModelId(null);
                          else onUpdateModelCategory(model.id, item);
                        }}
                      >
                        {t(GENERAL_MODEL_CATEGORY_LABELS[item])}
                      </button>
                    ))}
                    {model.category === 'text' ? (
                      <>
                        <label className="provider-model-capability-toggle">
                          <input
                            type="checkbox"
                            checked={model.inputModalities?.includes('image') ?? false}
                            onChange={(event) => onUpdateModelVisionCapability(
                              model.id,
                              event.target.checked,
                            )}
                          />
                          <span>{t("支持图片输入")}</span>
                        </label>
                        <label className="provider-model-context-window">
                          <span>{t("上下文窗口（token）")}</span>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={model.contextWindow ?? ''}
                            placeholder={t("留空则按模型 ID 推断")}
                            onChange={(event) => onUpdateModelContextWindow(
                              model.id,
                              event.target.value,
                            )}
                          />
                        </label>
                      </>
                    ) : null}
                    <label className="provider-model-description-editor">
                      <span>{t("Agent 选型说明")}</span>
                      <textarea
                        value={model.description ?? ''}
                        maxLength={500}
                        rows={2}
                        placeholder={t("例如：适合中文 OCR、角色图分析，速度快、成本低")}
                        onChange={(event) => onUpdateModelDescription(model.id, event.target.value)}
                      />
                    </label>
                  </div>
                ) : null}
              </div>
            )) : (
              <div className="provider-model-empty">{t("没有匹配的模型")}</div>
            )}
          </div>

          <div ref={settingsRef} className="scroll-mt-3">
            {imageCapabilityModel && klingContracts.has(imageCapabilityModel.id) ? (
              <KlingLengthEditor key={imageCapabilityModel.id} model={imageCapabilityModel} verified={klingContracts.get(imageCapabilityModel.id)!}
                onImage={(capability) => onUpdateImageCapability(imageCapabilityModel.id, capability)}
                onVideo={() => undefined} onClose={() => setImageCapabilityModelId(null)} />
            ) : null}
            {videoCapabilityModel && klingContracts.has(videoCapabilityModel.id) ? (
              <KlingLengthEditor key={videoCapabilityModel.id} model={videoCapabilityModel} verified={klingContracts.get(videoCapabilityModel.id)!}
                onImage={() => undefined} onVideo={(capability) => onUpdateVideoCapability(videoCapabilityModel.id, capability)}
                onClose={() => setVideoCapabilityModelId(null)} />
            ) : null}
            {editableProtocols && imageCapabilityModel?.category === 'image'
              && selectedIds.has(imageCapabilityModel.id) ? (
                <ImageCapabilityEditor key={imageCapabilityModel.id} model={imageCapabilityModel}
                  onChange={(capability) => onUpdateImageCapability(imageCapabilityModel.id, capability)}
                  onApplyTemplate={(templateId) => onApplyImageTemplate(imageCapabilityModel.id, templateId)}
                  onClose={() => setImageCapabilityModelId(null)} />
              ) : null}
            {editableProtocols
              && videoCapabilityModel
              && videoCapabilityModel.category === 'video'
              && selectedIds.has(videoCapabilityModel.id) ? (
                <VideoCapabilityEditor
                  key={videoCapabilityModel.id}
                  model={videoCapabilityModel}
                  onChange={(capability) => onUpdateVideoCapability(
                    videoCapabilityModel.id,
                    capability,
                  )}
                  onApplySeedanceTemplate={(seedanceModel, transport) => {
                    const template = createSeedanceQuickAdaptTemplate(seedanceModel, transport);
                    onUpdateVideoCapability(videoCapabilityModel.id, template.capability);
                    onUpdateModelProtocol(videoCapabilityModel.id, template.executionProfile);
                  }}
                  onApplyH3Template={(h3Model, transport) => {
                    const template = createH3QuickAdaptTemplate(h3Model, transport);
                    onUpdateVideoCapability(videoCapabilityModel.id, template.capability);
                    onUpdateModelProtocol(videoCapabilityModel.id, template.executionProfile);
                  }}
                  onClose={() => setVideoCapabilityModelId(null)}
                />
              ) : null}

            {protocolModel && (editableProtocols || klingContracts.has(protocolModel.id))
              && selectedIds.has(protocolModel.id) ? (
                <ModelProtocolEditor
                  key={protocolModel.id}
                  model={protocolModel}
                  readOnlyProtocol={klingContracts.has(protocolModel.id)}
                  inheritanceLabel={protocolModel.category === 'text'
                    ? '跟随连接对话协议'
                    : undefined}
                  catalogId={definition.id}
                  apiKey={apiKey.trim()}
                  baseUrl={normalizeBaseUrl(baseUrl) || definition.defaultBaseUrl || ''}
                  onChange={(profile) => onUpdateModelProtocol(protocolModel.id, profile)}
                  onVideoCapabilityChange={(capability) => onUpdateVideoCapability(protocolModel.id, capability)}
                  onImageReferenceRequestModeChange={(mode) => (
                    onUpdateImageReferenceRequestMode(protocolModel.id, mode)
                  )}
                  onValidityChange={setProtocolValid}
                  onDraftInvalidChange={onProtocolDraftInvalidChange}
                  testSessionScope={testSessionScope}
                  onClose={onCloseProtocolEditor}
                />
              ) : null}
          </div>
        </>
      )}

      {definition.id === 'custom-openai' && (
        <div className="provider-manual-model">
          <div className="provider-manual-fields">
            <input
              type="text"
              value={manualModelId}
              placeholder={t("手动输入模型 ID")}
              onChange={(event) => setManualModelId(event.target.value)}
            />
            <input
              type="text"
              value={manualModelName}
              placeholder={t("显示名称（可选）")}
              onChange={(event) => setManualModelName(event.target.value)}
            />
            <Select fixedMenu
              value={manualCategory}
              onChange={(selectedOptionValue) => setManualCategory(selectedOptionValue as GeneralModelCategory)}
            >
              {CATEGORY_ORDER.map((item) => (
                <option key={item} value={item}>{t(GENERAL_MODEL_CATEGORY_LABELS[item])}</option>
              ))}
            </Select>
            <AnimatedButton
              type="button"
              className="provider-icon-btn"
              aria-label={t("添加手动模型")}
              disabled={!manualModelId.trim()}
              onClick={onAddManualModel}
            >
              <Icon icon="mdi:plus" width="17" />
            </AnimatedButton>
          </div>
        </div>
      )}
    </section>
  );
}

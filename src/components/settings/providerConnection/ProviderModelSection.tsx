/**
 * settings/providerConnection/ProviderModelSection — 启用模型区块。
 *
 * 承载模型清单的搜索 / 分类筛选 / 勾选 / 分类修正 / 协议与视频能力入口，
 * 以及自定义连接专属的文档导入与手动添加模型。
 */
import { Icon } from '@iconify/react';
import type { Dispatch, SetStateAction } from 'react';
import { GENERAL_MODEL_CATEGORY_LABELS } from '../../../types';
import type {
  GeneralModelCategory,
  ImageReferenceRequestMode,
  ProviderModelSelection,
} from '../../../types';
import type { VideoModelCapability } from '../../../types/aiTypes';
import type { ModelProtocolImportResult } from '../../../services/ai/modelProtocolImport';
import type { ProviderDefinition } from '../../../services/ai/providerCatalogService';
import { normalizeBaseUrl } from '../../../services/ai/providerBaseUrl';
import { useT } from '../../../i18n';
import AnimatedButton from '../../shared/AnimatedButton';
import ModelProtocolEditor from '../ModelProtocolEditor';
import ProtocolImportPanel from '../ProtocolImportPanel';
import VideoCapabilityEditor from './VideoCapabilityEditor';
import { CATEGORY_ORDER, type CatalogStatus, type ProtocolImportSnapshot } from './providerConnectionShared';

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
  protocolImportOpen: boolean;
  setProtocolImportOpen: Dispatch<SetStateAction<boolean>>;
  protocolImportSnapshot: ProtocolImportSnapshot | null;
  protocolModel: ProviderModelSelection | undefined;
  videoCapabilityModel: ProviderModelSelection | undefined;
  setProtocolModelId: Dispatch<SetStateAction<string | null>>;
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
  onUpdateImageReferenceRequestMode: (modelId: string, mode: ImageReferenceRequestMode) => void;
  onCloseProtocolEditor: () => void;
  onApplyProtocolImport: (result: ModelProtocolImportResult) => void;
  onUndoProtocolImport: () => void;
  onFetchModels: () => void;
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
  protocolImportOpen,
  setProtocolImportOpen,
  protocolImportSnapshot,
  protocolModel,
  videoCapabilityModel,
  setProtocolModelId,
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
  onApplyProtocolImport,
  onUndoProtocolImport,
  onFetchModels,
}: ProviderModelSectionProps) {
  const t = useT();

  return (
    <section className="provider-model-section">
      <div className="provider-section-heading provider-model-heading">
        <div>
          <h4>{t('启用模型')}</h4>
          <p>{t('仅勾选会在应用中使用的模型')}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {definition.id === 'custom-openai' ? (
            <>
              {protocolImportSnapshot ? (
                <AnimatedButton
                  type="button"
                  className="provider-text-btn h-7"
                  onClick={onUndoProtocolImport}
                >
                  <Icon icon="mdi:undo-variant" width="14" />
                  {t('撤销导入')}
                </AnimatedButton>
              ) : null}
              <AnimatedButton
                type="button"
                className="provider-secondary-btn h-7"
                aria-expanded={protocolImportOpen}
                onClick={() => setProtocolImportOpen((open) => !open)}
              >
                <Icon icon="mdi:file-import-outline" width="14" />
                {t('导入文档')}
              </AnimatedButton>
            </>
          ) : null}
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

      {definition.id === 'custom-openai' && protocolImportOpen ? (
        <ProtocolImportPanel
          onApply={onApplyProtocolImport}
          onClose={() => setProtocolImportOpen(false)}
        />
      ) : null}

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
              {GENERAL_MODEL_CATEGORY_LABELS[item]}
            </button>
          ))}
        </div>
      </div>

      {catalogMessage && (
        <div className={`provider-catalog-message is-${catalogStatus}`}>
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
                  {GENERAL_MODEL_CATEGORY_LABELS[item]}
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
            <span>{selectedModels.length} 个已选</span>
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
                  aria-label={`修改 ${model.name} 的模型分类，当前为${GENERAL_MODEL_CATEGORY_LABELS[model.category]}`}
                  title="点击修改模型分类"
                  aria-expanded={categoryEditModelId === model.id}
                  onClick={() => setCategoryEditModelId((current) => current === model.id ? null : model.id)}
                >
                  {GENERAL_MODEL_CATEGORY_LABELS[model.category]}
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
                  </span>
                </label>
                {definition.id === 'custom-openai' && selectedIds.has(model.id) ? (
                  <>
                    {model.category === 'video' ? (
                      <AnimatedButton
                        type="button"
                        className={`provider-model-protocol-btn ${model.videoCapability ? 'is-configured' : ''}`}
                        aria-label={`配置 ${model.name} 视频参数能力`}
                        title="视频参数能力"
                        onClick={() => {
                          setVideoCapabilityModelId(model.id);
                          setProtocolModelId(null);
                          setProtocolValid(true);
                        }}
                      >
                        <Icon icon="lucide:video" width="16" />
                      </AnimatedButton>
                    ) : null}
                    <AnimatedButton
                      type="button"
                      className={`provider-model-protocol-btn ${model.executionProfile ? 'is-configured' : ''}`}
                      aria-label={`配置 ${model.name} 调用协议`}
                      title="调用协议"
                      onClick={() => {
                        setProtocolModelId(model.id);
                        setVideoCapabilityModelId(null);
                        setProtocolValid(true);
                      }}
                    >
                      <Icon icon="mdi:tune-variant" width="15" />
                    </AnimatedButton>
                  </>
                  ) : null}
                {categoryEditModelId === model.id ? (
                  <div
                    className="provider-model-category-editor"
                    role="group"
                    aria-label={`选择 ${model.name} 的模型分类`}
                  >
                    <span className="provider-model-category-editor-title">分类</span>
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
                        {GENERAL_MODEL_CATEGORY_LABELS[item]}
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
                          <span>支持图片输入</span>
                        </label>
                        <label className="provider-model-context-window">
                          <span>上下文窗口（token）</span>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={model.contextWindow ?? ''}
                            placeholder="留空则按模型 ID 推断"
                            onChange={(event) => onUpdateModelContextWindow(
                              model.id,
                              event.target.value,
                            )}
                          />
                        </label>
                      </>
                    ) : null}
                    <label className="provider-model-description-editor">
                      <span>Agent 选型说明</span>
                      <textarea
                        value={model.description ?? ''}
                        maxLength={500}
                        rows={2}
                        placeholder="例如：适合中文 OCR、角色图分析，速度快、成本低"
                        onChange={(event) => onUpdateModelDescription(model.id, event.target.value)}
                      />
                    </label>
                  </div>
                ) : null}
              </div>
            )) : (
              <div className="provider-model-empty">没有匹配的模型</div>
            )}
          </div>

          {definition.id === 'custom-openai'
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
                onClose={() => setVideoCapabilityModelId(null)}
              />
            ) : null}

          {definition.id === 'custom-openai'
            && protocolModel
            && selectedIds.has(protocolModel.id) ? (
              <ModelProtocolEditor
                key={protocolModel.id}
                model={protocolModel}
                apiKey={apiKey.trim()}
                baseUrl={normalizeBaseUrl(baseUrl) || definition.defaultBaseUrl || ''}
                onChange={(profile) => onUpdateModelProtocol(protocolModel.id, profile)}
                onImageReferenceRequestModeChange={(mode) => (
                  onUpdateImageReferenceRequestMode(protocolModel.id, mode)
                )}
                onValidityChange={setProtocolValid}
                onClose={onCloseProtocolEditor}
              />
            ) : null}
        </>
      )}

      {definition.id === 'custom-openai' && (
        <div className="provider-manual-model">
          <div className="provider-manual-fields">
            <input
              type="text"
              value={manualModelId}
              placeholder="手动输入模型 ID"
              onChange={(event) => setManualModelId(event.target.value)}
            />
            <input
              type="text"
              value={manualModelName}
              placeholder="显示名称（可选）"
              onChange={(event) => setManualModelName(event.target.value)}
            />
            <select
              value={manualCategory}
              onChange={(event) => setManualCategory(event.target.value as GeneralModelCategory)}
            >
              {CATEGORY_ORDER.map((item) => (
                <option key={item} value={item}>{GENERAL_MODEL_CATEGORY_LABELS[item]}</option>
              ))}
            </select>
            <AnimatedButton
              type="button"
              className="provider-icon-btn"
              aria-label="添加手动模型"
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

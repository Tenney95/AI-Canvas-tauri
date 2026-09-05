/**
 * AgentApprovalCard — Agent 步骤审批卡（P3-E1）。
 *
 * 展示等待确认的工具操作（画布写入、文件写入、媒体生成、永久删除、项目记忆、API 配置），
 * 提供确认 / 拒绝。键盘可操作，类别用文字标签而非仅颜色表达。
 */
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import type {
  AgentApprovalKind,
  AgentApprovalResolution,
  AgentStep,
  ProviderModelChoice,
} from '../../types/agent';
import type { MediaModelOption } from '../nodes/shared/defaultModels';
import AgentToolDetails from './AgentToolDetails';
import { useT } from '../../i18n';
import { MAX_PROVIDER_MODEL_SELECTION, queryProviderModels, toggleProviderModelSelection } from '../../services/chat/providerModelCatalogService';

interface AgentApprovalCardProps {
  step: AgentStep;
  mediaModelOptions: MediaModelOption[];
  mediaModelAvailability: Record<string, boolean>;
  onResolve: (approvalId: string, resolution: AgentApprovalResolution) => void;
}

const KIND_META: Record<AgentApprovalKind, { label: string; icon: string }> = {
  user_choice: { label: '需要你选择', icon: 'mdi:format-list-checks' },
  canvas_write: { label: '画布修改', icon: 'mdi:vector-square-edit' },
  file_write: { label: '写入文件', icon: 'mdi:content-save-outline' },
  permanent_delete: { label: '永久删除', icon: 'mdi:delete-alert-outline' },
  media_generation: { label: '生成媒体', icon: 'mdi:image-plus-outline' },
  memory_write: { label: '保存记忆', icon: 'mdi:brain' },
  config_write: { label: 'API 配置', icon: 'mdi:api' },
  asset_write: { label: '资产库写入', icon: 'mdi:account-box-multiple-outline' },
};


const PROVIDER_CATEGORY_LABELS: Record<ProviderModelChoice['category'], string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
};

const MEDIA_KIND_LABELS = {
  image: '生图',
  video: '视频',
  audio: '音频',
} as const;

export default function AgentApprovalCard(props: AgentApprovalCardProps) {
  return <ApprovalCardContent key={props.step.approval?.id ?? props.step.id} {...props} />;
}

function ApprovalCardContent({
  step,
  mediaModelOptions,
  mediaModelAvailability,
  onResolve,
}: AgentApprovalCardProps) {
  const t = useT();
  const approval = step.approval;
  const inputRequest = approval?.inputRequest;
  const mediaModelRequest = inputRequest?.kind === 'media_model' ? inputRequest : undefined;
  const providerModelsRequest = inputRequest?.kind === 'provider_models' ? inputRequest : undefined;
  const [selectedModelRef, setSelectedModelRef] = useState(
    mediaModelRequest?.selectedModelRef,
  );
  // 中转站接入：默认不预选，由用户明确勾选要接入哪几个
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [page, setPage] = useState(1);
  const maxSelection = Math.min(providerModelsRequest?.maxSelection ?? MAX_PROVIDER_MODEL_SELECTION, MAX_PROVIDER_MODEL_SELECTION);
  const providerPage = useMemo(() => queryProviderModels(providerModelsRequest?.options ?? [], query, categoryFilter, page),
    [providerModelsRequest, query, categoryFilter, page]);
  const expiresAt = providerModelsRequest?.catalog?.expiresAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const catalogExpired = !!expiresAt && expiresAt <= now;
  const providerGroups = useMemo(() => {
    const groups = new Map<string, ProviderModelChoice[]>();
    for (const option of providerPage.options) {
      const list = groups.get(option.category) ?? [];
      list.push(option);
      groups.set(option.category, list);
    }
    return (['text', 'image', 'video', 'audio'] as const)
      .flatMap((category) => (groups.has(category)
        ? [[category, groups.get(category)!] as const]
        : []));
  }, [providerPage]);
  const toggleModelId = (id: string) => {
    setSelectedModelIds((current) => toggleProviderModelSelection(current, [id], maxSelection));
  };
  const toggleCategory = (ids: string[]) => {
    setSelectedModelIds((current) => toggleProviderModelSelection(current, ids, maxSelection));
  };
  const groupedModels = useMemo(() => {
    if (!mediaModelRequest) return [];
    const groups = new Map<string, MediaModelOption[]>();
    for (const model of mediaModelOptions) {
      if (model.mediaKind !== mediaModelRequest.mediaKind) continue;
      const models = groups.get(model.groupName) ?? [];
      models.push(model);
      groups.set(model.groupName, models);
    }
    return [...groups.entries()];
  }, [mediaModelRequest, mediaModelOptions]);
  if (!approval) return null;
  const meta = KIND_META[approval.kind];
  const needsModelSelection = !!mediaModelRequest;
  const needsProviderSelection = !!providerModelsRequest;
  const hasAvailableModel = groupedModels.some(([, models]) =>
    models.some((model) => mediaModelAvailability[model.value]),
  );
  const selectedModelAvailable = !!selectedModelRef
    && !!mediaModelAvailability[selectedModelRef];

  const handleConfirm = () => {
    if (approval.status !== 'pending' || (providerModelsRequest?.catalog && providerModelsRequest.catalog.expiresAt <= Date.now())
      || (needsProviderSelection && (!selectedModelIds.length || selectedModelIds.length > maxSelection))) return;
    onResolve(approval.id, {
      approved: true,
      ...(needsModelSelection ? { inputValues: { modelRef: selectedModelRef } } : {}),
      ...(needsProviderSelection ? { inputValues: { selectedModelIds } } : {}),
    });
  };

  return (
    <div
      className="mt-2 border-l-2 border-amber-400/60 bg-amber-400/5 px-3 py-2.5"
      role="group"
      aria-label={t('{label}待确认', { label: t(meta.label) })}
    >
      <div className="flex items-start gap-2">
        <Icon icon={meta.icon} width="16" className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-amber-300">
            {t('待确认')} · {t(meta.label)}
          </p>
          <p className="mt-1 break-words text-xs leading-[18px] text-canvas-text-secondary">
            {step.toolCall?.inputSummary || approval.summary}
          </p>
          <AgentToolDetails input={step.toolCall?.inputDisplay} defaultExpanded />
        </div>
      </div>
      {approval.kind === 'config_write' && (
        <div className="mt-2 flex items-start gap-1.5 border-t border-amber-300/15 pt-2 text-xs leading-[18px] text-canvas-text-secondary">
          <Icon icon="mdi:shield-key-outline" width="14" className="mt-0.5 shrink-0 text-amber-400" />
          <span>{t('不会写入 API Key；新连接保持空白，已有连接保留原值。')}</span>
        </div>
      )}
      {mediaModelRequest && (
        <div className="mt-3 border-t border-amber-300/15 pt-2.5">
          <p className="mb-2 text-[11px] font-medium text-canvas-text">
            {t('选择{kind}模型', { kind: t(MEDIA_KIND_LABELS[mediaModelRequest.mediaKind]) })}
          </p>
          {hasAvailableModel ? (
            <div className="max-h-40 space-y-2 overflow-y-auto pr-1">
              {groupedModels.map(([groupName, models]) => (
                <div key={groupName}>
                  <p className="mb-1 text-[10px] text-canvas-text-muted">{groupName}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {models.map((model) => {
                      const available = !!mediaModelAvailability[model.value];
                      const selected = selectedModelRef === model.value;
                      return (
                        <button
                          key={model.value}
                          type="button"
                          disabled={!available}
                          aria-pressed={selected}
                          title={available ? model.description : t('模型未配置或当前不可用')}
                          onClick={() => setSelectedModelRef(model.value)}
                          className={`flex min-h-7 max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-left text-[11px] leading-4 transition-colors active:scale-[0.98] motion-reduce:transform-none ${
                            selected
                              ? 'border-amber-300/70 bg-amber-300/15 text-amber-200'
                              : available
                                ? 'border-canvas-border text-canvas-text-secondary hover:border-amber-300/40 hover:text-canvas-text'
                                : 'cursor-not-allowed border-canvas-border/50 text-canvas-text-muted opacity-45'
                          }`}
                        >
                          {selected && <Icon icon="mdi:check" width="13" className="shrink-0" />}
                          <span className="break-words">{model.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] leading-[17px] text-canvas-text-muted">
              {t('暂无可用模型，请先在设置中完成模型配置。')}
            </p>
          )}
        </div>
      )}
      {providerModelsRequest && (
        <div className="mt-3 border-t border-amber-300/15 pt-2.5">
          <p className="mb-2 text-[11px] font-medium text-canvas-text">
            {t('勾选要接入的模型（已选 {selected} / {total}）', { selected: selectedModelIds.length, total: providerModelsRequest.options.length })}
          </p>
          <p className="mb-2 text-xs text-canvas-text-muted" role="status">
            {t('每批最多 {count} 个；筛选和翻页会保留已选项。', { count: maxSelection })}
          </p>
          {catalogExpired && <p role="alert" className="mb-2 text-xs text-canvas-text-secondary">{t('模型目录已过期，请拒绝本次选择并重新读取目录。')}</p>}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <input className="ui-input min-w-0 flex-1" aria-label={t('搜索模型名称或 ID')} placeholder={t('搜索模型名称或 ID')}
              value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
            <select className="ui-select__control" aria-label={t('模型分类')} value={categoryFilter}
              onChange={(event) => { setCategoryFilter(event.target.value); setPage(1); }}>
              <option value="">{t('全部分类')}</option>
              {Object.entries(PROVIDER_CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            </select>
            <button type="button" className="ui-btn ui-btn--sm" disabled={!selectedModelIds.length}
              onClick={() => setSelectedModelIds([])}>{t('清空已选')}</button>
          </div>
          {providerPage.total === 0 && <p className="py-2 text-xs text-canvas-text-muted">{t('没有匹配的模型')}</p>}
          <div className="max-h-64 space-y-2.5 overflow-y-auto pr-1">
            {providerGroups.map(([category, options]) => {
              const ids = options.map((option) => option.id);
              const allSelected = ids.every((id) => selectedModelIds.includes(id));
              return (
                <div key={category}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <p className="text-[10px] text-canvas-text-muted">
                      {t(PROVIDER_CATEGORY_LABELS[category])}（{options.length}）
                    </p>
                    <button
                      type="button"
                      onClick={() => toggleCategory(ids)}
                      disabled={catalogExpired || (!allSelected && selectedModelIds.length >= maxSelection)}
                      className="min-h-6 rounded px-1.5 text-[10px] text-canvas-text-secondary hover:text-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
                    >
                      {allSelected ? t('取消本页此类选择') : t('选取本页此类（受批次上限限制）')}
                    </button>
                  </div>
                  <div className="space-y-1">
                    {options.map((option) => {
                      const selected = selectedModelIds.includes(option.id);
                      return (
                        <label
                          key={option.id}
                          className={`flex min-h-7 cursor-pointer items-start gap-2 rounded border px-2 py-1 text-[11px] leading-4 transition-colors ${
                            selected
                              ? 'border-amber-300/70 bg-amber-300/10 text-amber-100'
                              : 'border-canvas-border text-canvas-text-secondary hover:border-amber-300/40 hover:text-canvas-text'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={catalogExpired || (!selected && selectedModelIds.length >= maxSelection)}
                            onChange={() => toggleModelId(option.id)}
                            className="mt-0.5 shrink-0 accent-amber-400"
                          />
                          <span className="min-w-0 break-words">
                            {option.name}
                            <span className="ml-1 text-canvas-text-muted">{option.id}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-canvas-text-secondary">
            <span>{t('筛选结果 {count} 个', { count: providerPage.total })} · {providerPage.page} / {providerPage.pageCount}</span>
            <div className="flex gap-2">
              <button type="button" className="ui-btn ui-btn--sm" disabled={providerPage.page <= 1}
                onClick={() => setPage(providerPage.page - 1)}>{t('上一页')}</button>
              <button type="button" className="ui-btn ui-btn--sm" disabled={providerPage.page >= providerPage.pageCount}
                onClick={() => setPage(providerPage.page + 1)}>{t('下一页')}</button>
            </div>
          </div>
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onResolve(approval.id, { approved: false })}
          className="min-h-8 rounded-md px-3 py-1 text-xs text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
        >
          {t('拒绝')}
        </button>
        <button
          type="button"
          disabled={(needsModelSelection && !selectedModelAvailable)
            || approval.status !== 'pending' || catalogExpired
            || (needsProviderSelection && (selectedModelIds.length === 0 || selectedModelIds.length > maxSelection))}
          onClick={handleConfirm}
          className="min-h-8 rounded-md bg-amber-500 px-3 py-1 text-xs font-medium text-black hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
        >
          {needsModelSelection
            ? t('确认生成')
            : needsProviderSelection
              ? t('接入选中的 {count} 个模型', { count: selectedModelIds.length })
              : t('确认执行')}
        </button>
      </div>
    </div>
  );
}

/**
 * settings/providerConnection/ProviderConnectionForm — 连接信息区块。
 * 通用连接信息与 CCC 多分组配置；CCC 各分组的凭证及模型在同一表单编辑。
 */
import Select from '../../shared/Select';
import { Icon } from '@iconify/react';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useT } from '../../../i18n';
import type { ApiProviderConfig, ChatApiProtocol, ProviderModelSelection } from '../../../types';
import { CHAT_API_PROTOCOL_LABELS } from '../../../services/ai/chatApiProtocol';
import { CCCAPI_BASE_URL, RUNNINGHUB_API_SITES, TOAPIS_API_SITES } from '../../../constants/api';
import { normalizeBaseUrl } from '../../../services/ai/providerBaseUrl';
import { runningHubSiteId } from '../../../services/runninghubSiteCredentials';
import { CCC_PROVIDER_GROUPS, cccConnectionName, getCccGroupPresetModels, isCccBananaGroup, isCccBananaModelId } from '../../../services/ai/cccProviderGroups';
import { RELAYON_PROVIDER_GROUPS, relayonConnectionName, getRelayonGroupPresetModels } from '../../../services/ai/relayonProviderGroups';
import { capCatalogModels, createConnectionId, fetchProviderModelCatalog, getProviderDefinition, type ProviderDefinition } from '../../../services/ai/providerCatalogService';
import { RELAYON_BASE_URL } from '../../../services/ai/providers/relayonModelManifest';
import AnimatedButton from '../../shared/AnimatedButton';
import { PROVIDER_LINKS, openExternal, type CatalogStatus } from './providerConnectionShared';
import { materializeLegacyImageProtocolDefault, mergeModels } from './providerConnectionModels';

interface CccGroupDraft {
  id: string;
  config: ApiProviderConfig;
  models: ProviderModelSelection[];
  selectedIds: Set<string>;
  currentModelIds?: Set<string>;
  selectionEdited: boolean;
  catalogEdited: boolean;
  existing: boolean;
  status: CatalogStatus;
  message: string;
}

/** 所有分组同时编辑；凭据仍按独立连接保存，不引入嵌套 Key 持久化。 */
export function CccGroupConnectionsForm({ providerConfigs, presetModels, onSave, onClose, onReturnToPicker, onCopyConnection, onRemoveConnection, provider = 'cccapi', onEditRelayGroup }: {
  providerConfigs: Record<string, ApiProviderConfig>;
  presetModels: ProviderModelSelection[];
  onSave: (connections: Record<string, ApiProviderConfig>) => Promise<void>;
  onClose: () => void;
  onReturnToPicker?: () => void;
  onCopyConnection?: (connectionId: string) => Promise<void>;
  onRemoveConnection?: (connectionId: string) => Promise<boolean>;
  provider?: 'cccapi' | 'relayonapi';
  onEditRelayGroup?: (connectionId: string) => void;
}) {
  const t = useT();
  const isRelay = provider === 'relayonapi';
  const externalUrl = getProviderDefinition(provider)?.externalUrl;
  const groupDefinitions = isRelay ? RELAYON_PROVIDER_GROUPS : CCC_PROVIDER_GROUPS;
  const groupOf = (config: ApiProviderConfig) => isRelay ? config.relayonGroup : config.cccGroup;
  const groupPresetModels = (group?: string) => isRelay ? getRelayonGroupPresetModels(presetModels, group) : getCccGroupPresetModels(presetModels, group);
  const newConfig = (group?: string): ApiProviderConfig => isRelay
    ? { name: relayonConnectionName({ relayonGroup: group }), apiKey: '', catalogId: provider, relayonGroup: group }
    : { name: cccConnectionName({ cccGroup: group }), apiKey: '', catalogId: provider, cccGroup: group };
  const [rows, setRows] = useState<CccGroupDraft[]>(() => {
    const connections = Object.entries(providerConfigs).filter(([id, config]) => getProviderDefinition(id, config)?.id === provider);
    const used = new Set<string>();
    const makeRow = (group?: string, saved?: [string, ApiProviderConfig]): CccGroupDraft => {
      const [id, original] = saved || [createConnectionId(provider), newConfig(group)];
      used.add(id);
      const config = { ...original };
      const savedModels = materializeLegacyImageProtocolDefault(config.selectedModels || [], config);
      const bananaGroup = !isRelay && isCccBananaGroup(group);
      const presets = groupPresetModels(group);
      const cachedModels = config.catalogModels?.length ? config.catalogModels : presets;
      const options = { preferIncomingConfiguration: isRelay || bananaGroup };
      const merged = mergeModels(bananaGroup ? mergeModels(presets, cachedModels, options) : cachedModels, savedModels, options);
      const savedById = new Map(savedModels.map((model) => [model.id, model]));
      const cachedCustomById = new Map(cachedModels.filter((model) => model.executionProfile?.preset === 'custom')
        .map((model) => [model.id, model]));
      // 已保存香蕉模型是完整配置，缺省能力也有含义，不能拼入新模板能力后改变 custom 合同。
      const models = bananaGroup ? merged.map((model) => savedById.get(model.id) ?? cachedCustomById.get(model.id) ?? model)
        : isRelay ? merged.map((model) => ({ ...model, ...savedById.get(model.id) })) : merged;
      return { id, config, models, selectedIds: new Set(config.selectedModels?.map((model) => model.id) || []),
        ...(bananaGroup ? { currentModelIds: new Set(presets.map((model) => model.id)) } : {}),
        selectionEdited: false, catalogEdited: false, existing: !!saved,
        status: 'idle', message: config.catalogModels?.length ? t('已加载该分组保存的模型目录')
          : isRelay && group === 'default' && !models.length ? t('该分组暂无已核对的预置模型，可填写 Key 后拉取。')
          : t('分组预置模型，拉取后以该 Key 返回为准。') };
    };
    const groups = groupDefinitions.map((group) => makeRow(group.name, connections.find(([, config]) => groupOf(config) === group.name)));
    // 旧连接、重复分组与未收录分组都保留原身份，不猜测 Key 的远端分组。
    return [...groups, ...connections.filter(([id]) => !used.has(id)).map((saved) => makeRow(groupOf(saved[1]), saved))];
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const busy = saving || removingId !== null;
  const requests = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const controllers = requests.current;
    return () => controllers.forEach((controller) => controller.abort());
  }, []);

  const updateKey = (id: string, value: string) => {
    requests.current.get(id)?.abort();
    setRows((current) => current.map((row) => row.id === id ? { ...row, config: { ...row.config, apiKey: value }, status: 'idle',
      message: t('Key 已修改，保存后使用此 Key；可拉取模型验证权限。') } : row));
  };
  const updateRelayGroup = (id: string, group: string) => {
    requests.current.get(id)?.abort();
    setRows((current) => current.map((row) => row.id === id ? { ...row,
      config: { ...row.config, relayonGroup: group || undefined }, status: 'idle',
      message: t('分组已更改，请保存后按需重新拉取模型。') } : row));
  };
  const relaySelectionChanged = (row: CccGroupDraft) => {
    const previous = new Set(providerConfigs[row.id]?.selectedModels?.map((model) => model.id) || []);
    return previous.size !== row.selectedIds.size || [...previous].some((id) => !row.selectedIds.has(id));
  };
  const relayRowChanged = (row: CccGroupDraft) => {
    const saved = providerConfigs[row.id];
    return row.existing
      ? row.config.apiKey !== saved?.apiKey || row.config.relayonGroup !== saved?.relayonGroup || row.catalogEdited || relaySelectionChanged(row)
      : Boolean(row.config.apiKey.trim() || row.selectedIds.size);
  };
  const hasUnsavedRelayChanges = isRelay && rows.some(relayRowChanged);
  const toggleModel = (id: string, modelId: string) => setRows((current) => current.map((row) => {
    if (row.id !== id) return row;
    const selectedIds = new Set(row.selectedIds);
    if (selectedIds.has(modelId)) selectedIds.delete(modelId); else selectedIds.add(modelId);
    return { ...row, selectedIds, selectionEdited: true };
  }));
  const fetchModels = async (id: string) => {
    const row = rows.find((item) => item.id === id);
    if (!row?.config.apiKey.trim() || busy) return;
    requests.current.get(id)?.abort();
    const controller = new AbortController();
    requests.current.set(id, controller);
    setRows((current) => current.map((item) => item.id === id ? { ...item, status: 'loading', message: '' } : item));
    try {
      const result = await fetchProviderModelCatalog({ providerId: id, config: { ...row.config, apiKey: row.config.apiKey.trim() }, fallbackModels: presetModels, signal: controller.signal });
      if (controller.signal.aborted) return;
      const ids = new Set(result.models.map((model) => model.id));
      setRows((current) => current.map((item) => {
        if (item.id !== id) return item;
        // 万象及香蕉历史连接保留目录缺失的已选身份，不能靠刷新静默停用旧节点。
        const bananaGroup = !isRelay && isCccBananaGroup(groupOf(item.config));
        const retainSelected = isRelay || bananaGroup;
        const preservedConfigurations = new Map(item.models.filter((model) => item.selectedIds.has(model.id)
          || (bananaGroup && model.executionProfile?.preset === 'custom')).map((model) => [model.id, model]));
        const merged = mergeModels(item.models.filter((model) => ids.has(model.id) || (retainSelected && item.selectedIds.has(model.id))), result.models);
        const retainedMissing = retainSelected && [...item.selectedIds].some((modelId) => !ids.has(modelId));
        const message = retainedMissing
          ? t('部分已选模型未出现在本次目录中，已保留原配置，请确认该 Key 和分组权限。')
          : result.warning ? t(result.warning) : t('已获取 {count} 个模型', { count: result.models.length });
        return { ...item,
          catalogEdited: true,
          models: bananaGroup ? merged.map((model) => preservedConfigurations.get(model.id) ?? model)
            : isRelay ? merged.map((model) => ({ ...model, ...preservedConfigurations.get(model.id) })) : merged,
          ...(bananaGroup ? { currentModelIds: new Set(result.models.filter((model) => isCccBananaModelId(model.id)).map((model) => model.id)) } : {}),
          selectedIds: retainSelected ? item.selectedIds : new Set([...item.selectedIds].filter((modelId) => ids.has(modelId))),
          config: { ...item.config, catalogUpdatedAt: Date.now(), ...(result.resolvedBaseUrl ? { baseUrl: result.resolvedBaseUrl } : {}) },
          status: result.warning || retainedMissing ? 'warning' : 'ready', message };
      }));
    } catch (error) {
      if (controller.signal.aborted) return;
      setRows((current) => current.map((item) => item.id === id ? { ...item, status: 'error', message: error instanceof Error ? error.message : t('模型列表拉取失败') } : item));
    }
  };
  const save = async () => {
    if (busy) return;
    const connections: Record<string, ApiProviderConfig> = {};
    for (const row of rows) {
      // 空白分组始终显示；填写 Key 或选择模型后才创建对应连接。
      if (!row.existing && !row.config.apiKey.trim() && !row.selectedIds.size) continue;
      if (isRelay) {
        if (!relayRowChanged(row)) continue;
        const selectedChanged = !row.existing || relaySelectionChanged(row);
        const original = providerConfigs[row.id];
        connections[row.id] = {
          ...row.config,
          apiKey: row.config.apiKey === original?.apiKey ? row.config.apiKey : row.config.apiKey.trim(),
          ...(!row.existing ? { catalogId: provider, baseUrl: row.config.baseUrl?.trim() || RELAYON_BASE_URL } : {}),
          ...(row.existing && !row.config.catalogId && row.config.relayonGroup !== original?.relayonGroup ? { catalogId: provider } : {}),
          ...(selectedChanged ? { selectedModels: row.models.filter((model) => row.selectedIds.has(model.id)).map((model) => ({ ...model, provider: row.id })) } : {}),
          ...(!row.existing || row.catalogEdited ? { catalogModels: capCatalogModels(row.models, row.selectedIds).map((model) => ({ ...model, provider: row.id })) } : {}),
        };
        continue;
      }
      connections[row.id] = { ...row.config, name: cccConnectionName(row.config), catalogId: provider, apiKey: row.config.apiKey.trim(),
        baseUrl: row.config.baseUrl?.trim() || CCCAPI_BASE_URL,
        selectedModels: row.existing && row.config.selectedModels === undefined && !row.selectionEdited
          ? undefined
          : row.models.filter((model) => row.selectedIds.has(model.id)).map((model) => ({ ...model, provider: row.id })),
        catalogModels: capCatalogModels(row.models, row.selectedIds).map((model) => ({ ...model, provider: row.id })),
      };
    }
    setSaving(true); setSaveError('');
    requests.current.forEach((controller) => controller.abort());
    setRows((current) => current.map((row) => row.status === 'loading' ? { ...row, status: 'idle', message: t('模型目录拉取已取消') } : row));
    try { await onSave(connections); onClose(); }
    catch (error) { setSaveError(error instanceof Error ? error.message : t('保存失败')); }
    finally { setSaving(false); }
  };

  const removeConnection = async (row: CccGroupDraft) => {
    if (!onRemoveConnection || busy) return;
    setRemovingId(row.id); setSaveError('');
    requests.current.get(row.id)?.abort();
    setRows((current) => current.map((item) => item.id === row.id ? { ...item, status: 'idle' } : item));
    try {
      if (!await onRemoveConnection(row.id)) return;
      requests.current.delete(row.id);
      setRows((current) => current.flatMap((item) => {
        if (item.id !== row.id) return [item];
        const group = groupOf(row.config);
        // 已删除的连接不能被「保存全部」重新写回；常驻分组保留空白输入，重新填写会获得新身份。
        if (!groupDefinitions.some((known) => known.name === group)
          || current.some((other) => other.id !== row.id && groupOf(other.config) === group)) return [];
        const id = createConnectionId(provider);
        const presets = groupPresetModels(group);
        return [{ id, config: newConfig(group),
          models: presets, selectedIds: new Set<string>(),
          ...(!isRelay && isCccBananaGroup(group) ? { currentModelIds: new Set(presets.map((model) => model.id)) } : {}),
          selectionEdited: false, catalogEdited: false,
          existing: false, status: 'idle' as const, message: isRelay && group === 'default'
            ? t('该分组暂无已核对的预置模型，可填写 Key 后拉取。') : t('分组预置模型，拉取后以该 Key 返回为准。') }];
      }));
      setPendingRemoveId(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t('连接删除失败，请重试'));
    } finally { setRemovingId(null); }
  };

  return <>
    <div className="provider-dialog-body">
      <div className="flex items-start justify-between gap-2 mb-3">
        <p className="ui-hint">{t('各分组的 Key 和模型同时保留。配置并保存后，选择模型即可自动使用所属分组的 Key，无需切换分组。')}</p>
        {onReturnToPicker && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost shrink-0" disabled={busy} onClick={onReturnToPicker}>{t('更换厂商')}</button>}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {rows.map((row) => {
          const group = groupOf(row.config) || t('旧连接（未指定分组）');
          const currentModelIds = row.currentModelIds;
          const currentModels = currentModelIds ? row.models.filter((model) => currentModelIds.has(model.id)) : row.models;
          const currentSelectedCount = currentModels.filter((model) => row.selectedIds.has(model.id)).length;
          const compatibilityModels = currentModelIds
            ? row.models.filter((model) => row.selectedIds.has(model.id) && !currentModelIds.has(model.id)) : [];
          return <section key={row.id} className="ui-card min-w-0" aria-label={group}>
            <div className="ui-card__header">
              <h4 className="ui-card__title break-words">{group}</h4>
              <span className={`ui-badge ml-auto shrink-0 ${row.config.apiKey.trim() ? 'ui-badge--success' : 'ui-badge--outline'}`}>{row.config.apiKey.trim() ? t('已填写 Key') : t('未填写 Key')}</span>
            </div>
            <div className="ui-card__body space-y-2">
              <p className="ui-hint">{t(groupDefinitions.find((item) => item.name === group)?.description || '保留已有连接与模型配置')}</p>
              {isRelay && row.existing && <p className="ui-hint break-all">{row.config.name} · {row.id}</p>}
              {isRelay && row.existing && <label className="ui-field block">
                <span className="ui-label">{t('所属分组')}</span>
                <Select aria-label={`${t('所属分组')} ${row.id}`} value={row.config.relayonGroup || ''} disabled={busy}
                  onChange={(value) => updateRelayGroup(row.id, value)} options={[
                    { value: '', label: t('旧连接（未指定分组）') },
                    ...(row.config.relayonGroup && !groupDefinitions.some((item) => item.name === row.config.relayonGroup)
                      ? [{ value: row.config.relayonGroup, label: row.config.relayonGroup }] : []),
                    ...groupDefinitions.map((item) => ({ value: item.name, label: item.name })),
                  ]} />
              </label>}
              <label className="ui-field block">
                <span className="ui-label">API Key</span>
                <input className="ui-input w-full" type="password" aria-label={`${group} API Key`} autoComplete="off" placeholder="sk-..." value={row.config.apiKey} disabled={busy} onChange={(event) => updateKey(row.id, event.target.value)} />
              </label>
              <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" aria-label={`${t('拉取模型')} ${group}`} disabled={busy || !row.config.apiKey.trim() || row.status === 'loading'} onClick={() => fetchModels(row.id)}>{row.status === 'loading' ? t('正在拉取') : t('拉取模型')}</button>
              {row.message && <p role={row.status === 'error' ? 'alert' : 'status'} className={`ui-hint ${row.status === 'error' ? 'ui-alert ui-alert--danger' : ''}`}>{row.message}</p>}
              <details>
                <summary className="cursor-pointer text-canvas-text">{t('启用模型')} · {currentSelectedCount}/{currentModels.length}</summary>
                <div className="mt-2 space-y-2">
                  {row.currentModelIds && <p className="ui-hint">{t('当前型号')}</p>}
                  <label className="flex items-center gap-2 text-canvas-text">
                    <input type="checkbox" aria-label={`${t('选择全部模型')} ${group}`} disabled={busy || !currentModels.length} checked={!!currentModels.length && currentSelectedCount === currentModels.length} onChange={(event) => {
                      const checked = event.target.checked;
                      setRows((current) => current.map((item) => {
                        if (item.id !== row.id) return item;
                        const selectedIds = item.currentModelIds ? new Set(item.selectedIds) : new Set<string>();
                        for (const model of item.models) {
                          if (item.currentModelIds && !item.currentModelIds.has(model.id)) continue;
                          if (checked) selectedIds.add(model.id); else selectedIds.delete(model.id);
                        }
                        return { ...item, selectedIds, selectionEdited: true };
                      }));
                    }} />{t('选择全部模型')}
                  </label>
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {currentModels.map((model) => <label key={model.id} className="flex items-start gap-2 p-2 rounded bg-canvas-surface text-canvas-text">
                      <input type="checkbox" className="mt-1" aria-label={`${t('启用')} ${group} ${model.id}`} disabled={busy} checked={row.selectedIds.has(model.id)} onChange={() => toggleModel(row.id, model.id)} />
                      <span className="min-w-0 break-words"><strong className="font-medium">{model.name}</strong><small className="block text-canvas-text-muted">{model.id}</small></span>
                    </label>)}
                    {!currentModels.length && <p className="ui-hint">{t('填写 Key 后拉取此连接的模型目录')}</p>}
                  </div>
                </div>
              </details>
              {compatibilityModels.length > 0 && <details aria-label={`${t('已保存的兼容型号')} ${group}`}>
                <summary className="cursor-pointer text-canvas-text">{t('已保存的兼容型号')} · {compatibilityModels.length}</summary>
                <p className="ui-hint mt-2">{t('保留原型号、选择和配置，不自动替换；实际可用性以该 Key 为准。')}</p>
                <div className="max-h-48 overflow-y-auto mt-2 space-y-1">
                  {compatibilityModels.map((model) => <label key={model.id} className="flex items-start gap-2 p-2 rounded bg-canvas-surface text-canvas-text">
                    <input type="checkbox" className="mt-1" aria-label={`${t('启用')} ${group} ${model.id}`} disabled={busy} checked={row.selectedIds.has(model.id)} onChange={() => toggleModel(row.id, model.id)} />
                    <span className="min-w-0 break-words"><strong className="font-medium">{model.name}</strong><small className="block text-canvas-text-muted">{model.id}</small></span>
                  </label>)}
                </div>
              </details>}
            </div>
            {row.existing && (onCopyConnection || onRemoveConnection || (isRelay && onEditRelayGroup)) && <div className="ui-card__footer flex flex-wrap items-center gap-2">
              {pendingRemoveId === row.id ? <>
                <span className="ui-hint w-full">{t('移除此分组连接及其模型？立即生效。')}</span>
                <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={busy} onClick={() => setPendingRemoveId(null)}>{t('取消删除')}</button>
                <button type="button" className="ui-btn ui-btn--sm ui-btn--danger" aria-label={`${t('确认删除')} ${group}`} disabled={busy} onClick={() => removeConnection(row)}>{removingId === row.id ? t('删除中') : t('确认删除')}</button>
              </> : <>
                {isRelay && onEditRelayGroup && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" aria-label={`${t('编辑模型参数')} ${row.id}`} disabled={busy || hasUnsavedRelayChanges} onClick={() => onEditRelayGroup(row.id)}>{t('编辑模型参数')}</button>}
                {onCopyConnection && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" aria-label={`${t('复制分组配置')} ${group}`} disabled={busy} onClick={() => onCopyConnection(row.id)}><Icon icon="mdi:content-copy" width="14" />{t('复制已保存配置（不含 Key）')}</button>}
                {onRemoveConnection && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" aria-label={`${t('删除分组')} ${group}`} disabled={busy} onClick={() => setPendingRemoveId(row.id)}><Icon icon="mdi:trash-can-outline" width="14" />{t('删除分组')}</button>}
              </>}
            </div>}
          </section>;
        })}
      </div>
      {hasUnsavedRelayChanges && <p className="ui-hint mt-3">{t('请先保存全部分组，再编辑单组模型参数。')}</p>}
      {externalUrl && <button type="button" className="provider-external-link mt-3" onClick={() => void openExternal(externalUrl)}>{t('前往厂商控制台')}</button>}
      {saveError && <p role="alert" className="ui-alert ui-alert--danger mt-3">{saveError}</p>}
    </div>
    <footer className="provider-dialog-footer">
      <span className="ui-hint">{t('所有已填写分组一起保存，调用时自动匹配 Key。')}</span>
      <div className="flex items-center gap-2">
        <AnimatedButton type="button" className="provider-secondary-btn" disabled={busy} onClick={onClose}>{t('取消')}</AnimatedButton>
        <AnimatedButton type="button" className="provider-primary-btn" disabled={busy || !rows.some((row) => row.existing || row.config.apiKey.trim() || row.selectedIds.size)} onClick={save}>{saving ? t('保存中') : t('保存全部分组')}</AnimatedButton>
      </div>
    </footer>
  </>;
}

interface ProviderConnectionFormProps {
  editing: boolean;
  definition: ProviderDefinition;
  isWebSearchProvider: boolean;
  connectionName: string;
  setConnectionName: Dispatch<SetStateAction<string>>;
  chatApiProtocol: ChatApiProtocol;
  setChatApiProtocol: Dispatch<SetStateAction<ChatApiProtocol>>;
  apiKey: string;
  setApiKey: Dispatch<SetStateAction<string>>;
  baseUrl: string;
  setBaseUrl: Dispatch<SetStateAction<string>>;
  workflowApiKey: string;
  setWorkflowApiKey: Dispatch<SetStateAction<string>>;
  dreaminaLoggedIn: boolean;
  dreaminaLoading: boolean;
  onDreaminaLogin: () => void;
  duplicateConnectionName: string;
  catalogStatus: CatalogStatus;
  catalogMessage: string;
  missingCredentials: boolean;
  onReturnToPicker: () => void;
  onTestConnection: () => void;
}

export default function ProviderConnectionForm({
  editing,
  definition,
  isWebSearchProvider,
  connectionName,
  setConnectionName,
  chatApiProtocol,
  setChatApiProtocol,
  apiKey,
  setApiKey,
  baseUrl,
  setBaseUrl,
  workflowApiKey,
  setWorkflowApiKey,
  dreaminaLoggedIn,
  dreaminaLoading,
  onDreaminaLogin,
  duplicateConnectionName,
  catalogStatus,
  catalogMessage,
  missingCredentials,
  onReturnToPicker,
  onTestConnection,
}: ProviderConnectionFormProps) {
  const t = useT();
  const isWorkflowApi = definition.kind === 'workflow-api';
  const runningHubBaseUrl = (baseUrl || definition.defaultBaseUrl || '').replace(/\/+$/, '');
  const runningHubSite = RUNNINGHUB_API_SITES.find((site) => site.id === runningHubSiteId(runningHubBaseUrl));
  const toapisSite = TOAPIS_API_SITES.find((site) => site.baseUrl === (baseUrl || definition.defaultBaseUrl || '').replace(/\/+$/, ''));
  const externalUrl = (definition.id === 'toapis' && toapisSite?.consoleUrl)
    || (definition.id === 'runninghub-model' && runningHubSite?.consoleUrl)
    || definition.externalUrl || PROVIDER_LINKS[definition.id];

  return (
    <section className="provider-config-section">
      <div className="provider-section-heading">
        <div>
          <h4>{t('连接信息')}</h4>
          <p>{isWorkflowApi ? t(definition.description) : definition.description}</p>
        </div>
        {!editing && !isWebSearchProvider && (
          <AnimatedButton
            type="button"
            className="provider-text-btn"
            onClick={onReturnToPicker}
          >
            {t('更换厂商')}
          </AnimatedButton>
        )}
      </div>

      {definition.id === 'custom-openai' && (
        <div className="provider-catalog-message is-warning provider-custom-openai-warning">
          <Icon icon="mdi:alert-circle-outline" width="16" />
          <span>
            {t('提示：每个中转站提供的模型和参数规则都不一样，从接口拉取下来的模型，不一定能直接拿来用。不同中转站对同一个模型的名字、传入图片、尺寸等参数往往不同，直接使用可能会报错。请先查看你所用中转站的官方文档，把对应的参数改成文档里的值。如果你不会改，可以这样做：直接把中转站的文档发给对话助手，或者开启智能体并接入 MCP，让助手照着文档帮你添加和配置。')}
          </span>
        </div>
      )}

      {(definition.id === 'custom-openai' || isWorkflowApi) && (
        <label className="provider-field">
          <span>{t('连接名称')}</span>
          <input
            type="text"
            value={connectionName}
            placeholder={t('例如：团队模型网关')}
            onChange={(event) => setConnectionName(event.target.value)}
          />
        </label>
      )}

      {definition.id === 'custom-openai' && (
        <label className="provider-field">
          <span>{t('对话协议')}</span>
          <Select fixedMenu
            className="min-w-0"
            value={chatApiProtocol}
            onChange={(selectedOptionValue) => setChatApiProtocol(selectedOptionValue as ChatApiProtocol)}
          >
            {Object.entries(CHAT_API_PROTOCOL_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{t(label)}</option>
            ))}
          </Select>
          <small>
            {chatApiProtocol === 'anthropic-compatible'
              ? t('使用 Messages API、x-api-key 和 Anthropic 流式事件')
              : chatApiProtocol === 'gemini-native'
                ? t('使用原生 generateContent、x-goog-api-key 和 Gemini 内容结构')
                : t('使用 Chat Completions、Bearer Key 和 OpenAI SSE')}
          </small>
        </label>
      )}

      {definition.authType === 'oauth' ? (
        <div className="provider-oauth-row">
          <span className={`provider-connection-dot${dreaminaLoggedIn ? ' is-online' : ''}`} />
          <div>
            <strong>{dreaminaLoggedIn ? t('即梦账号已登录') : t('即梦账号未登录')}</strong>
            <small>{t('模型调用使用桌面端 OAuth 登录态')}</small>
          </div>
          <AnimatedButton
            type="button"
            className="provider-secondary-btn"
            disabled={dreaminaLoading}
            onClick={onDreaminaLogin}
          >
            {dreaminaLoading ? t('处理中...') : dreaminaLoggedIn ? t('重新登录') : t('OAuth 登录')}
          </AnimatedButton>
        </div>
      ) : (
        <div className={definition.id === 'runninghub-model' ? 'grid grid-cols-1 gap-3 md:grid-cols-3' : 'provider-fields-grid'}>
          {definition.id === 'runninghub-model' && <label className="provider-field">
            <span>{t('API 站点')}</span>
            <Select fixedMenu className="min-w-0 w-full" value={runningHubSite?.baseUrl || runningHubBaseUrl} onChange={setBaseUrl} disabled={catalogStatus === 'loading'}>
              {RUNNINGHUB_API_SITES.map((site) => <option key={site.baseUrl} value={site.baseUrl}>{t(site.label)}</option>)}
              {!runningHubSite && runningHubBaseUrl && <option value={runningHubBaseUrl}>{t('已配置地址')} · {runningHubBaseUrl}</option>}
            </Select>
          </label>}
          {definition.id === 'toapis' && <label className="provider-field">
            <span>{t('API 站点')}</span>
            <Select fixedMenu className="min-w-0 w-full" value={toapisSite?.baseUrl || baseUrl} onChange={setBaseUrl}>
              {TOAPIS_API_SITES.map((site) => <option key={site.id} value={site.baseUrl}>{t(site.label)}</option>)}
              {!toapisSite && baseUrl && <option value={baseUrl}>{t('已配置地址')} · {baseUrl}</option>}
            </Select>
          </label>}
          {definition.credentials.map((field) => {
            const value = field.key === 'apiKey' ? apiKey : baseUrl;
            const baseUrlLocked = field.key === 'baseUrl'
              && definition.allowCustomBaseUrl === false;
            return (
              <label key={field.key} className="provider-field">
                <span>{definition.id === 'runninghub-model' && field.key === 'apiKey' ? '模型 API Key（企业级 / 共享）' : isWorkflowApi ? t(field.label) : field.label}{field.required && definition.id !== 'runninghub-model' ? ' *' : ''}</span>
                <input
                  type={field.secret ? 'password' : 'text'}
                  value={value}
                  placeholder={isWorkflowApi && field.placeholder ? t(field.placeholder) : field.placeholder}
                  readOnly={baseUrlLocked}
                  disabled={baseUrlLocked}
                  onChange={(event) => {
                    if (field.key === 'apiKey') setApiKey(event.target.value);
                    else setBaseUrl(event.target.value);
                  }}
                  onBlur={(event) => {
                    // 补协议、去尾斜杠、剥掉误贴的 /chat/completions，
                    // 让用户在保存前就看见真正会被请求的地址
                    if (field.key === 'baseUrl' && !isWorkflowApi) {
                      setBaseUrl(normalizeBaseUrl(event.target.value, chatApiProtocol));
                    }
                  }}
                />
              </label>
            );
          })}
          {definition.id === 'runninghub-model' && (
            <label className="provider-field">
              <span>{t('工作流 API Key（消费级 / 会员）')}</span>
              <input
                type="password"
                value={workflowApiKey}
                placeholder={t('用于 RunningHub 工作流执行（可选）')}
                onChange={(event) => setWorkflowApiKey(event.target.value)}
              />
            </label>
          )}
          {definition.id === 'runninghub-model' && <p className="ui-hint md:col-span-3">
            {t('国内、国际两套密钥分别保存；切换站点显示对应密钥，未配置时不会借用另一站。模型和工作流 Key 可以只填一项；保存后调用使用当前选中的站点。')}
          </p>}
          {definition.id === 'toapis' && <p className="ui-hint md:col-span-3">
            {t('国内站与国际站共用账号和 API Key；切换保留 Key，模型以当前站点实际返回为准。')}
          </p>}
        </div>
      )}

      {isWorkflowApi && <p className="mt-2 text-xs text-canvas-text-secondary">{t('填写平台提供的密钥，鉴权方式和前缀在各工作流的调用协议中配置。')}</p>}
      {duplicateConnectionName && (
        <div className="provider-catalog-message is-warning">
          <Icon icon="mdi:content-duplicate" width="14" />
          <span>
            {t('已有连接「{name}」使用相同接口地址和对话协议。继续保存会新建第二条同网关连接；如果只是想加模型，建议回列表编辑「{name}」。', {
              name: duplicateConnectionName,
            })}
          </span>
        </div>
      )}

      {externalUrl && (
        <button
          type="button"
          className="provider-external-link"
          onClick={() => void openExternal(externalUrl)}
        >
          <Icon icon="mdi:open-in-new" width="13" />
          {definition.id === 'grsai' ? t('前往 API Key 页面') : t('前往厂商控制台')}
        </button>
      )}

      {definition.authType !== 'oauth' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <AnimatedButton
            type="button"
            className="provider-secondary-btn"
            disabled={missingCredentials || catalogStatus === 'loading'}
            onClick={() => void onTestConnection()}
          >
            <Icon
              icon={catalogStatus === 'loading' ? 'mdi:loading' : 'mdi:connection'}
              className={catalogStatus === 'loading' ? 'settings-spin' : undefined}
              width="15"
            />
            {catalogStatus === 'loading' ? t('验证中') : isWorkflowApi ? t('检查配置') : t('验证连接')}
          </AnimatedButton>
          {(isWebSearchProvider || isWorkflowApi) && catalogMessage && (
            <div className={`provider-catalog-message is-${catalogStatus} m-0 flex-1`}>
              <Icon
                icon={catalogStatus === 'error' ? 'mdi:alert-circle-outline' : 'mdi:information-outline'}
                width="14"
              />
              <span>{isWorkflowApi ? t(catalogMessage) : catalogMessage}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

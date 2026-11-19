/**
 * PluginNode — 提供插件节点界面与交互。
 */
import Select from '../shared/Select';
import AnimatedButton from '../shared/AnimatedButton';
import { useT } from '../../i18n';
import { Icon } from '@iconify/react';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { memo, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { BaseNodeData } from '../../types';
import type { PluginJsonValue } from '../../types/plugin';
import { isWsagentSharedImagesNode, WSAGENT_MEDIA_CAPABILITY } from '../../types/wsagentShared';
import WsagentConnectControl from '../assets/WsagentConnectControl';
import WsagentProjectMediaPanel from './WsagentProjectMediaPanel';
import NodePluginToolDialog from './shared/toolbar/NodePluginToolDialog';
import { buildPluginModelCatalog } from '../../services/plugins/pluginModelCatalog';
import {
  executePluginNode,
  getAvailableNodePluginTools,
  getAvailablePluginNodes,
} from '../../services/plugins/pluginRuntime';
import { openWsagentDesktop } from '../../services/wsagentProjectMedia';
import { activeWsagentOwner } from '../../services/wsagentSharedImages';

const wsagentHeaderButtonClass = 'nodrag ui-btn ui-btn--secondary ui-btn--sm ui-btn--block';

function jsonRecord(value: unknown): Record<string, PluginJsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, PluginJsonValue>
    : {};
}

function PluginNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const t = useT();
  const plugins = useAppStore((state) => state.installedPlugins);
  const config = useAppStore((state) => state.config);
  const updateNodeData = useAppStore((state) => state.updateNodeData);
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const [openingWsagent, setOpeningWsagent] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const available = useMemo(
    () => getAvailablePluginNodes(plugins).find((item) => (
      item.pluginId === data.pluginId && item.node.id === data.pluginNodeId
    )),
    [data.pluginId, data.pluginNodeId, plugins],
  );
  const values = jsonRecord(data.pluginValues);
  const isWsagentNode = isWsagentSharedImagesNode(data);
  const ownerId = useAppStore((state) => isWsagentNode ? activeWsagentOwner(state) : null);
  const mediaEnabled = isWsagentNode && plugins.some((plugin) => plugin.id === data.pluginId && plugin.enabled
    && plugin.manifest?.requiredCapabilities?.includes(WSAGENT_MEDIA_CAPABILITY));
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, updateNodeInternals, available?.node]);
  const wsagentTool = useMemo(() => isWsagentNode
    ? getAvailableNodePluginTools(plugins, 'plugin-node', 'node-context-menu', true)[0] : undefined,
  [isWsagentNode, plugins]);
  const outputs = jsonRecord(data.pluginOutputs);
  const categories = useMemo(
    () => available
      ? [...new Set(available.node.fields.flatMap((field) => field.modelCategories ?? []))]
      : [],
    [available],
  );
  const models = useMemo(
    () => buildPluginModelCatalog(config, categories),
    [categories, config],
  );

  const setValue = (fieldId: string, value: PluginJsonValue) => {
    updateNodeData(id, { pluginValues: { ...values, [fieldId]: value } });
  };

  const run = async () => {
    if (!available || busy) return;
    setBusy(true);
    try {
      await executePluginNode(available, id, models);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('插件节点执行失败'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const openWsagent = async () => {
    if (!ownerId || openingWsagent) return;
    setOpeningWsagent(true);
    try {
      await openWsagentDesktop(ownerId);
    } catch (cause: unknown) {
      showToast(typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : t('无法打开 WSAGENT'), 'error');
    } finally {
      setOpeningWsagent(false);
    }
  };

  if (!available) {
    return (
      <div className="w-80 rounded-xl border border-red-500/30 bg-canvas-card p-4 text-xs text-canvas-text-secondary">
        <div className="font-medium text-red-300">{t('插件节点不可用')}</div>
        <div className="mt-1">{t('请重新安装或启用插件：{plugin}', { plugin: String(data.pluginId || t('未知插件')) })}</div>
      </div>
    );
  }

  return (
    <>
    <div className={isWsagentNode
      ? `ui-card ${mediaEnabled ? 'w-96' : 'w-80'} [&.ui-card]:overflow-visible${selected ? ' is-selected' : ''}`
      : `w-80 rounded-xl border bg-canvas-card shadow-xl transition-colors ${selected ? 'border-indigo-400/70' : 'border-canvas-border'}`}>
      {available.node.inputs.map((port, index) => (
        <Handle
          key={port.id}
          id={`plugin-in-${port.id}`}
          type="target"
          position={Position.Left}
          style={{ top: `${((index + 1) / (available.node.inputs.length + 1)) * 100}%` }}
          title={`${port.label} · ${port.type}`}
        />
      ))}
      {available.node.outputs.map((port, index) => (
        <Handle
          key={port.id}
          id={`plugin-out-${port.id}`}
          type="source"
          position={Position.Right}
          style={{ top: `${((index + 1) / (available.node.outputs.length + 1)) * 100}%` }}
          title={`${port.label} · ${mediaEnabled && (port.type === 'image' || port.type === 'video' || port.type === 'audio')
            ? data.wsagentMediaSelection?.[port.type]?.name ?? t('请先选择素材') : port.type}`}
        />
      ))}

      <header className={isWsagentNode ? 'ui-card__header' : 'flex items-center gap-2 border-b border-canvas-border px-3 py-2.5'}>
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${isWsagentNode
          ? 'bg-[var(--brand-alpha-15)] text-[var(--brand-light)]'
          : 'bg-indigo-500/15 text-indigo-400'}`}>
          <Icon icon={available.node.icon} width={17} height={17} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className={isWsagentNode ? 'ui-card__title truncate' : 'truncate text-xs font-semibold text-canvas-text'}>{available.node.title}</div>
          {!isWsagentNode && <div className="truncate text-[10px] text-canvas-text-muted">{available.pluginName}</div>}
        </div>
        {isWsagentNode ? <div className="ui-card__header-actions shrink-0 [&.ui-card__header-actions]:grid grid-flow-col auto-cols-fr">
          {mediaEnabled && <AnimatedButton type="button" className={wsagentHeaderButtonClass}
            disabled={!ownerId || openingWsagent} onClick={() => void openWsagent()}>
            {t('打开 WSAGENT')}
          </AnimatedButton>}
          <AnimatedButton type="button" className={wsagentHeaderButtonClass}
            disabled={!wsagentTool} onClick={() => setDialogOpen(true)}>
            {t('打开共享素材')}
          </AnimatedButton>
        </div> : <button
          type="button"
          className="nodrag shrink-0 whitespace-nowrap rounded-md bg-indigo-500 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
          disabled={busy}
          onClick={() => void run()}
        >
          {busy ? t('运行中…') : t('运行')}
        </button>}
      </header>

      <div className={`nodrag nowheel max-h-96 space-y-3 overflow-y-auto ${isWsagentNode ? 'ui-card__body' : 'p-3'}`}>
        {isWsagentNode && wsagentTool && <WsagentConnectControl />}
        {mediaEnabled && ownerId && <WsagentProjectMediaPanel key={ownerId} ownerId={ownerId} nodeId={id}
          selections={data.wsagentMediaSelection} />}
        {available.node.description && (
          <p className={isWsagentNode ? 'ui-hint' : 'text-[11px] leading-4 text-canvas-text-muted'}>{available.node.description}</p>
        )}
        {available.node.fields.map((field) => {
          const value = values[field.id];
          const baseClass = 'mt-1 w-full rounded-md border border-canvas-border bg-canvas-surface px-2.5 py-2 text-xs text-canvas-text outline-none focus:border-indigo-400/60';
          return (
            <label key={field.id} className="block text-[11px] text-canvas-text-secondary">
              <span>{field.label}{field.required && <span className="ml-1 text-red-400">*</span>}</span>
              {field.type === 'textarea' ? (
                <textarea
                  className={`${baseClass} resize-y`}
                  rows={3}
                  value={typeof value === 'string' ? value : ''}
                  placeholder={field.placeholder}
                  onChange={(event) => setValue(field.id, event.currentTarget.value)}
                />
              ) : field.type === 'select' ? (
                <Select fixedMenu
                  className="min-w-0"
                  value={typeof value === 'string' ? value : ''}
                  onChange={(selectedOptionValue) => setValue(field.id, selectedOptionValue)}
                >
                  <option value="">{field.placeholder || t('请选择')}</option>
                  {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Select>
              ) : field.type === 'boolean' ? (
                <input
                  className="ml-2 align-middle accent-indigo-500"
                  type="checkbox"
                  checked={value === true}
                  onChange={(event) => setValue(field.id, event.currentTarget.checked)}
                />
              ) : field.type === 'model' ? (
                <Select fixedMenu
                  className="min-w-0"
                  value={typeof value === 'string' ? value : ''}
                  onChange={(selectedOptionValue) => setValue(field.id, selectedOptionValue)}
                >
                  <option value="">{t(models.length > 0 ? '选择可调用模型' : '暂无可调用模型')}</option>
                  {models
                    .filter((model) => field.modelCategories?.includes(model.category))
                    .map((model) => <option key={model.id} value={model.id}>{model.name} · {model.category}</option>)}
                </Select>
              ) : (
                <input
                  className={baseClass}
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                  placeholder={field.placeholder}
                  onChange={(event) => setValue(
                    field.id,
                    field.type === 'number' ? Number(event.currentTarget.value) : event.currentTarget.value,
                  )}
                />
              )}
              {field.description && <span className="mt-1 block text-[10px] text-canvas-text-muted">{field.description}</span>}
            </label>
          );
        })}
        {Object.keys(outputs).length > 0 && (
          <div className="rounded-md border border-canvas-border bg-canvas-surface p-2 text-[10px] text-canvas-text-secondary">
            {available.node.outputs.map((port) => outputs[port.id] === undefined ? null : (
              <div key={port.id} className="truncate"><span className="text-canvas-text-muted">{port.label}：</span>{String(outputs[port.id])}</div>
            ))}
          </div>
        )}
      </div>
    </div>
    {dialogOpen && wsagentTool && <NodePluginToolDialog nodeId={id} pluginTool={wsagentTool} onClose={() => setDialogOpen(false)} />}
    </>
  );
}

export default memo(PluginNode);

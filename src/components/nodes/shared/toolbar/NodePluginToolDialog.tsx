import { Icon } from '@iconify/react';
import { useMemo, useState, type FormEvent } from 'react';
import type { AvailableNodePluginTool, PluginJsonValue } from '../../../../types/plugin';
import { executeNodePluginTool } from '../../../../services/plugins/pluginRuntime';
import { openPluginUiSurface } from '../../../../services/plugins/pluginUiBridge';
import {
  buildPluginModelCatalog,
  collectDeclaredModelCategories,
} from '../../../../services/plugins/pluginModelCatalog';
import { useAppStore } from '../../../../store/useAppStore';
import AnimatedButton from '../../../shared/AnimatedButton';
import ModalOverlay from '../../../shared/ModalOverlay';
import PopupCloseButton from '../../../shared/PopupCloseButton';

interface NodePluginToolDialogProps {
  pluginTool: AvailableNodePluginTool;
  nodeId: string;
  onClose: () => void;
}

type FormValue = string | boolean;

function initialFormValues(pluginTool: AvailableNodePluginTool): Record<string, FormValue> {
  const values: Record<string, FormValue> = {};
  for (const field of pluginTool.tool.dialog?.fields ?? []) {
    if (field.type === 'boolean') values[field.id] = field.defaultValue === true;
    else if (field.defaultValue !== undefined) values[field.id] = String(field.defaultValue);
    else values[field.id] = '';
  }
  return values;
}

export default function NodePluginToolDialog({ pluginTool, nodeId, onClose }: NodePluginToolDialogProps) {
  const showToast = useAppStore((state) => state.showToast);
  const config = useAppStore((state) => state.config);
  const dialog = pluginTool.tool.dialog;
  // 只有声明 models.read 的插件才拿得到模型目录，且目录不含任何厂商凭据。
  const models = useMemo(
    () => (pluginTool.permissions.includes('models.read')
      ? buildPluginModelCatalog(
        config,
        collectDeclaredModelCategories(pluginTool.tool.dialog?.fields ?? []),
      )
      : []),
    [config, pluginTool],
  );
  const [values, setValues] = useState<Record<string, FormValue>>(() => initialFormValues(pluginTool));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!dialog) return null;

  const close = () => {
    if (!busy) onClose();
  };

  const collectParameters = (strict: boolean): Record<string, PluginJsonValue> | null => {
    const parameters: Record<string, PluginJsonValue> = {};
    for (const field of dialog.fields) {
      const value = values[field.id];
      if (field.type === 'boolean') {
        if (strict && field.required && value !== true) {
          setError(`请勾选“${field.label}”`);
          return null;
        }
        parameters[field.id] = value === true;
        continue;
      }
      const textValue = typeof value === 'string' ? value : '';
      if (strict && field.required && !textValue.trim()) {
        setError(`请填写“${field.label}”`);
        return null;
      }
      if (!textValue && !field.required) continue;
      if (field.type === 'number') {
        const numberValue = Number(textValue);
        if (!Number.isFinite(numberValue)) {
          setError(`“${field.label}”必须是有效数字`);
          return null;
        }
        parameters[field.id] = numberValue;
      } else {
        parameters[field.id] = textValue;
      }
    }
    return parameters;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // L1 富 UI 下字段只充当初始值契约，必填校验交给插件组件自己处理。
    const parameters = collectParameters(!dialog.ui);
    if (!parameters) return;

    setError(null);
    setBusy(true);
    try {
      if (dialog.ui) {
        const plugin = useAppStore
          .getState()
          .installedPlugins.find((item) => item.id === pluginTool.pluginId);
        if (!plugin) throw new Error('找不到已安装的插件');
        await openPluginUiSurface({
          plugin,
          tool: pluginTool.tool,
          nodeId,
          surface: 'tool-dialog',
          exportName: dialog.ui,
          parameters,
        });
        onClose();
        return;
      }
      await executeNodePluginTool(pluginTool, nodeId, parameters);
      onClose();
    } catch (executionError) {
      const message = executionError instanceof Error ? executionError.message : '插件工具执行失败';
      setError(message);
      showToast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const inputClassName = 'mt-1.5 w-full rounded-lg border border-canvas-border bg-canvas-surface px-3 py-2 text-xs text-canvas-text outline-none transition-colors placeholder:text-canvas-text-muted focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/15';

  return (
    <ModalOverlay
      isOpen
      onClose={close}
      ariaLabel={dialog.title || pluginTool.tool.title}
      className="w-[min(460px,calc(100vw-32px))] border-canvas-border"
      closeOnBackdrop={!busy}
      motionPreset="quick"
    >
      <form onSubmit={(event) => void handleSubmit(event)}>
        <header className="flex items-center gap-3 border-b border-canvas-border px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
            <Icon icon={pluginTool.tool.icon || 'lucide:blocks'} width={18} height={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-canvas-text">
              {dialog.title || pluginTool.tool.title}
            </h2>
            <p className="mt-0.5 truncate text-[11px] text-canvas-text-muted">
              {pluginTool.pluginName}
            </p>
          </div>
          <PopupCloseButton disabled={busy} onClick={close} />
        </header>

        <div className="max-h-[min(560px,calc(100vh-180px))] space-y-4 overflow-y-auto px-4 py-4">
          {(dialog.description || pluginTool.tool.description) && (
            <p className="text-xs leading-5 text-canvas-text-secondary">
              {dialog.description || pluginTool.tool.description}
            </p>
          )}
          {dialog.fields.map((field) => (
            <label key={field.id} className="block text-xs text-canvas-text-secondary">
              {field.type === 'boolean' ? (
                <span className="flex items-start gap-2 rounded-lg border border-canvas-border bg-canvas-surface px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={values[field.id] === true}
                    disabled={busy}
                    className="mt-0.5 h-3.5 w-3.5 accent-indigo-500"
                    onChange={(event) => {
                      const nextValue = event.currentTarget.checked;
                      setValues((current) => ({ ...current, [field.id]: nextValue }));
                    }}
                  />
                  <span>
                    <span className="block font-medium text-canvas-text">{field.label}</span>
                    {field.description && <span className="mt-0.5 block text-[11px] leading-4 text-canvas-text-muted">{field.description}</span>}
                  </span>
                </span>
              ) : (
                <>
                  <span className="font-medium text-canvas-text">
                    {field.label}{field.required && <span className="ml-1 text-red-400">*</span>}
                  </span>
                  {field.type === 'textarea' ? (
                    <textarea
                      value={String(values[field.id] ?? '')}
                      rows={4}
                      required={field.required}
                      disabled={busy}
                      placeholder={field.placeholder}
                      className={`${inputClassName} resize-y`}
                      onChange={(event) => {
                        const nextValue = event.currentTarget.value;
                        setValues((current) => ({ ...current, [field.id]: nextValue }));
                      }}
                    />
                  ) : field.type === 'select' ? (
                    <select
                      value={String(values[field.id] ?? '')}
                      required={field.required}
                      disabled={busy}
                      className={inputClassName}
                      onChange={(event) => {
                        const nextValue = event.currentTarget.value;
                        setValues((current) => ({ ...current, [field.id]: nextValue }));
                      }}
                    >
                      <option value="">{field.placeholder || '请选择'}</option>
                      {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  ) : field.type === 'model' ? (
                    <select
                      value={String(values[field.id] ?? '')}
                      required={field.required}
                      disabled={busy}
                      className={inputClassName}
                      onChange={(event) => {
                        const nextValue = event.currentTarget.value;
                        setValues((current) => ({ ...current, [field.id]: nextValue }));
                      }}
                    >
                      <option value="">
                        {models.length > 0 ? (field.placeholder || '选择可调用模型') : '暂无可调用模型'}
                      </option>
                      {models
                        .filter((model) => !field.modelCategories || field.modelCategories.includes(model.category))
                        .map((model) => <option key={model.id} value={model.id}>{model.name} · {model.category}</option>)}
                    </select>
                  ) : (
                    <input
                      type={field.type === 'number' ? 'number' : 'text'}
                      value={String(values[field.id] ?? '')}
                      required={field.required}
                      disabled={busy}
                      placeholder={field.placeholder}
                      className={inputClassName}
                      onChange={(event) => {
                        const nextValue = event.currentTarget.value;
                        setValues((current) => ({ ...current, [field.id]: nextValue }));
                      }}
                    />
                  )}
                  {field.description && <span className="mt-1 block text-[11px] leading-4 text-canvas-text-muted">{field.description}</span>}
                </>
              )}
            </label>
          ))}
          {dialog.fields.length === 0 && (
            <div className="rounded-lg border border-canvas-border bg-canvas-surface px-3 py-2.5 text-xs text-canvas-text-secondary">
              确认后将对当前节点执行此插件工具。
            </div>
          )}
          {error && (
            <div role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] leading-4 text-red-300">
              {error}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-canvas-border px-4 py-3">
          <AnimatedButton
            type="button"
            className="rounded-lg border border-canvas-border px-3 py-2 text-xs text-canvas-text-secondary hover:bg-canvas-hover"
            disabled={busy}
            onClick={close}
          >
            取消
          </AnimatedButton>
          <AnimatedButton
            type="submit"
            className="inline-flex min-w-20 items-center justify-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-400 disabled:opacity-60"
            disabled={busy}
          >
            {busy && <Icon icon="lucide:loader-circle" width={14} height={14} className="animate-spin" />}
            {busy ? '执行中…' : (dialog.submitLabel || '执行')}
          </AnimatedButton>
        </footer>
      </form>
    </ModalOverlay>
  );
}

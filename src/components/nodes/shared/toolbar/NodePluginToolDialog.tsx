import { Icon } from '@iconify/react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import pluginUiHostDocument from '../../../../../plugin-ui-host.html?raw';
import type {
  AvailableNodePluginTool,
  PluginJsonValue,
} from '../../../../types/plugin';
import { executeNodePluginTool } from '../../../../services/plugins/pluginRuntime';
import { openPluginUiWindow, pluginUiWindowUnavailableReason } from '../../../../services/plugins/pluginUiWindowService';
import {
  createPluginUiFrameSession,
  type PluginUiFrameSession,
} from '../../../../services/plugins/pluginUiSessionService';
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

interface PluginUiFrameDocument {
  objectUrl: string;
  src: string;
}

const PLUGIN_UI_BOOTSTRAP_MARKUP = 'src="/plugin-ui-bootstrap.js"';

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function createPluginUiFrameDocument(sessionSrc: string): PluginUiFrameDocument {
  const sessionUrl = new URL(sessionSrc, window.location.href);
  const sessionParameters = sessionUrl.searchParams.toString();
  if (!sessionParameters) throw new Error('插件界面会话参数缺失');

  const bootstrapUrl = escapeHtmlAttribute(
    new URL('/plugin-ui-bootstrap.js', window.location.href).href,
  );
  const documentHtml = pluginUiHostDocument.replace(
    PLUGIN_UI_BOOTSTRAP_MARKUP,
    `src="${bootstrapUrl}"`,
  );
  if (documentHtml === pluginUiHostDocument) {
    throw new Error('插件界面宿主页无效');
  }

  const objectUrl = URL.createObjectURL(new Blob([documentHtml], {
    type: 'text/html;charset=utf-8',
  }));
  return {
    objectUrl,
    src: `${objectUrl}#${sessionParameters}`,
  };
}

function initialFormValues(pluginTool: AvailableNodePluginTool): Record<string, FormValue> {
  const values: Record<string, FormValue> = {};
  for (const field of pluginTool.tool.dialog?.fields ?? []) {
    if (field.type === 'boolean') values[field.id] = field.defaultValue === true;
    else if (field.defaultValue !== undefined) values[field.id] = String(field.defaultValue);
    else values[field.id] = '';
  }
  return values;
}

function initialPluginParameters(pluginTool: AvailableNodePluginTool): Record<string, PluginJsonValue> {
  const parameters: Record<string, PluginJsonValue> = {};
  for (const field of pluginTool.tool.dialog?.fields ?? []) {
    if (field.defaultValue === undefined) continue;
    if (field.type === 'boolean') parameters[field.id] = field.defaultValue === true;
    else if (field.type === 'number') parameters[field.id] = Number(field.defaultValue);
    else parameters[field.id] = String(field.defaultValue);
  }
  return parameters;
}

export default function NodePluginToolDialog({ pluginTool, nodeId, onClose }: NodePluginToolDialogProps) {
  const showToast = useAppStore((state) => state.showToast);
  const config = useAppStore((state) => state.config);
  const dialog = pluginTool.tool.dialog;
  const windowFallback = dialog?.presentation === 'window' ? pluginUiWindowUnavailableReason() : null;
  const useNativeWindow = dialog?.presentation === 'window' && windowFallback === null;
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
  const [frameSession, setFrameSession] = useState<PluginUiFrameSession | null>(null);
  const [frameDocument, setFrameDocument] = useState<PluginUiFrameDocument | null>(null);
  const [uiLoading, setUiLoading] = useState(Boolean(dialog?.ui));
  const frameSessionRef = useRef<PluginUiFrameSession | null>(null);
  const frameDocumentRef = useRef<PluginUiFrameDocument | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    frameSession?.updateTheme(config.theme);
  }, [config.theme, frameSession]);

  useEffect(() => {
    const exportName = dialog?.ui;
    if (!exportName) return undefined;
    let cancelled = false;
    const plugin = useAppStore
      .getState()
      .installedPlugins.find((item) => item.id === pluginTool.pluginId);
    if (!plugin) {
      queueMicrotask(() => {
        if (cancelled) return;
        setUiLoading(false);
        setFrameSession(null);
        setError('找不到已安装的插件');
      });
      return () => {
        cancelled = true;
      };
    }
    if (useNativeWindow) {
      // 延后启动以消除 StrictMode 的已取消挂载；启动后由会话服务持有，不随入口组件卸载关闭。
      queueMicrotask(() => {
        if (cancelled) return;
        void openPluginUiWindow({
          plugin, tool: pluginTool.tool, nodeId, exportName,
          parameters: initialPluginParameters(pluginTool),
        }).catch((cause) => {
          if (!cancelled) showToast(cause instanceof Error ? cause.message : '插件窗口打开失败', 'error');
        }).finally(() => {
          if (!cancelled) onCloseRef.current();
        });
      });
      return () => { cancelled = true; };
    }
    void createPluginUiFrameSession({
      plugin,
      tool: pluginTool.tool,
      nodeId,
      exportName,
      parameters: initialPluginParameters(pluginTool),
      onClose: () => onCloseRef.current(),
    }).then((session) => {
      if (cancelled) {
        session.dispose();
        return;
      }
      let nextFrameDocument: PluginUiFrameDocument;
      try {
        nextFrameDocument = createPluginUiFrameDocument(session.src);
      } catch (cause) {
        session.dispose();
        throw cause;
      }
      frameSessionRef.current = session;
      frameDocumentRef.current = nextFrameDocument;
      setFrameSession(session);
      setFrameDocument(nextFrameDocument);
      setError(null);
      setUiLoading(false);
    }).catch((cause) => {
      if (cancelled) return;
      setUiLoading(false);
      setFrameSession(null);
      const message = cause instanceof Error ? cause.message : '插件界面加载失败';
      setError(message);
      showToast(message, 'error');
    });
    return () => {
      cancelled = true;
      frameSessionRef.current?.dispose();
      frameSessionRef.current = null;
      if (frameDocumentRef.current) {
        URL.revokeObjectURL(frameDocumentRef.current.objectUrl);
        frameDocumentRef.current = null;
      }
    };
  }, [dialog?.ui, nodeId, pluginTool, showToast, useNativeWindow]);

  if (!dialog || useNativeWindow) return null;

  const close = () => {
    if (busy) return;
    frameSessionRef.current?.dispose();
    onClose();
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
    // 自定义 UI 下字段只充当初始值契约，必填校验交给插件视图自己处理。
    const parameters = collectParameters(!dialog.ui);
    if (!parameters) return;

    setError(null);
    setBusy(true);
    try {
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

  if (dialog.ui) {
    return (
      <ModalOverlay
        isOpen
        onClose={close}
        ariaLabel={dialog.title || pluginTool.tool.title}
        className="h-[calc(100dvh-32px)] max-h-[1100px] w-[calc(100vw-32px)] max-w-[1600px] min-w-0 border-canvas-border"
        closeOnBackdrop
        motionPreset="quick"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-canvas-border px-4 py-3">
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
          <PopupCloseButton onClick={close} />
        </header>
        {windowFallback && (
          <p role="status" className="shrink-0 border-b border-canvas-border px-4 py-1 text-xs text-canvas-text-secondary">
            {windowFallback}
          </p>
        )}
        <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-canvas-surface">
          {uiLoading && (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-canvas-text-secondary">
              <Icon icon="lucide:loader-circle" width={16} height={16} className="animate-spin" />
              正在加载插件界面…
            </div>
          )}
          {!uiLoading && error && (
            <div role="alert" className="m-4 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-300">
              {error}
            </div>
          )}
          {frameSession && frameDocument && !error && (
            <iframe
              ref={(element) => frameSession.attach(element?.contentWindow ?? null)}
              src={frameDocument.src}
              title={`${pluginTool.pluginName} · ${dialog.title || pluginTool.tool.title}`}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className="block h-full w-full min-w-0 border-0 bg-canvas-surface"
            />
          )}
        </div>
      </ModalOverlay>
    );
  }

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

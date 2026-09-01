/**
 * 插件自定义界面的宿主组件。
 *
 * 它跑在**独立的 Tauri webview 进程**里：插件界面代码即使崩溃、死循环或内存失控，
 * 也只会拖垮这个窗口，主界面照常响应。
 *
 * 插件产物通过 plugin-ui:// 协议载入，并把组件挂到 `__AI_CANVAS_PLUGIN_HOST__.exports`
 * 上。它只能拿到这里组装的 props——没有宿主的 DOM、store、Tauri 命令句柄或凭据。
 *
 * 与宿主的通信走 Tauri 事件（而不是 invoke 命令）：模型调用等宿主能力本来就实现在
 * 前端，交给主窗口执行可以复用现有的 effect 校验链路。
 */
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import type { NodeType } from '../types';
import type {
  PluginJsonValue,
  PluginModelSummary,
  PluginNodeHostEffect,
  PluginNodeHostEffectResult,
  PluginUIComponent,
  PluginUISurface,
} from '../types/plugin';

interface PluginUiContext {
  surface: PluginUISurface;
  node: { id: string; type: NodeType; data: Record<string, PluginJsonValue> };
  models: PluginModelSummary[];
  parameters: Record<string, PluginJsonValue>;
  values: Record<string, PluginJsonValue>;
}

interface HostResponse {
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** 产物把导出写进这里；宿主再按 manifest.ui.exports 的映射取组件。 */
const bundleExports: Record<string, unknown> = {};

// React 由宿主注入，产物不得重复打包，否则会出现双实例并让 hooks 直接报错。
(window as unknown as Record<string, unknown>).__AI_CANVAS_PLUGIN_HOST__ = {
  React,
  exports: bundleExports,
};

const pending = new Map<string, (response: HostResponse) => void>();
let listenerReady: Promise<unknown> | null = null;

function ensureListener(): Promise<unknown> {
  listenerReady ??= listen<HostResponse>('plugin-ui:response', (event) => {
    const resolve = pending.get(event.payload.requestId);
    if (resolve) {
      pending.delete(event.payload.requestId);
      resolve(event.payload);
    }
  });
  return listenerReady;
}

async function request<T>(sessionId: string, kind: string, payload?: unknown): Promise<T> {
  await ensureListener();
  const requestId = crypto.randomUUID();
  const response = await new Promise<HostResponse>((resolve) => {
    pending.set(requestId, resolve);
    void emitTo('main', 'plugin-ui:request', {
      sessionId,
      requestId,
      kind,
      payload: payload ?? null,
    }).catch(() => {
      pending.delete(requestId);
      resolve({ requestId, ok: false, error: '无法向宿主窗口发送请求' });
    });
  });
  if (!response.ok) throw new Error(response.error ?? '宿主拒绝了请求');
  return response.value as T;
}

/** 通过自定义协议载入插件产物：既避开 eval，也不必放宽宿主页面的 CSP。 */
function loadBundle(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('插件界面产物加载失败'));
    document.head.appendChild(script);
  });
}

const panelStyle: React.CSSProperties = {
  padding: 24,
  font: '13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
  color: '#e6e6e6',
};

export function PluginUiApp({
  sessionId,
  exportName,
}: {
  sessionId: string;
  exportName: string;
}) {
  const [context, setContext] = useState<PluginUiContext | null>(null);
  const [component, setComponent] = useState<PluginUIComponent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runEffect = useCallback(
    async (effect: PluginNodeHostEffect): Promise<PluginNodeHostEffectResult> => {
      setBusy(true);
      try {
        return await request<PluginNodeHostEffectResult>(sessionId, 'effect', effect);
      } finally {
        setBusy(false);
      }
    },
    [sessionId],
  );

  const submit = useCallback(
    async (data: Record<string, PluginJsonValue>, message?: string) => {
      setBusy(true);
      try {
        await request(sessionId, 'submit', { data, message: message ?? null });
      } finally {
        setBusy(false);
      }
    },
    [sessionId],
  );

  const setParameters = useCallback(
    (patch: Record<string, PluginJsonValue>) => {
      setContext((current) =>
        current ? { ...current, parameters: { ...current.parameters, ...patch } } : current,
      );
      void request(sessionId, 'set-parameters', patch).catch(() => undefined);
    },
    [sessionId],
  );

  const close = useCallback(() => {
    void request(sessionId, 'close').catch(() => undefined);
  }, [sessionId]);

  const toast = useCallback(
    (message: string, type?: 'success' | 'error') => {
      void request(sessionId, 'toast', { message, type: type ?? 'success' }).catch(
        () => undefined,
      );
    },
    [sessionId],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await request<PluginUiContext>(sessionId, 'context');
        if (cancelled) return;
        setContext(loaded);
        const bundleUrl = new URLSearchParams(window.location.search).get('bundle');
        if (!bundleUrl) throw new Error('缺少界面产物地址');
        await loadBundle(bundleUrl);
        if (cancelled) return;
        const resolved = bundleExports[exportName];
        if (typeof resolved !== 'function') {
          throw new Error(`插件未导出组件: ${exportName}`);
        }
        setComponent(resolved as PluginUIComponent);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, exportName]);

  if (error) {
    return (
      <div style={panelStyle}>
        <strong>插件界面加载失败</strong>
        <p>{error}</p>
      </div>
    );
  }
  if (!context || !component) {
    return <div style={panelStyle}>正在加载插件界面…</div>;
  }
  const Component = component;
  return (
    <Component
      surface={context.surface}
      node={context.node}
      models={context.models}
      parameters={context.parameters}
      values={context.values}
      runEffect={runEffect}
      setParameters={setParameters}
      submit={submit}
      close={close}
      toast={toast}
      busy={busy}
    />
  );
}

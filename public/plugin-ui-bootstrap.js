(() => {
  'use strict';

  const CHANNEL = 'ai-canvas-plugin-ui-v1';
  const REQUEST_TIMEOUT_MS = 30_000;
  const LONG_REQUEST_TIMEOUT_MS = 180_000;
  const params = new URLSearchParams(
    window.location.protocol === 'blob:'
      ? window.location.hash.slice(1)
      : window.location.search,
  );
  const sessionId = params.get('session');
  const exportName = params.get('export');
  const bundleUrl = params.get('bundle');
  const root = document.getElementById('root');
  const pending = new Map();
  const bundleExports = Object.create(null);
  let context = null;
  let busy = false;
  let cleanup = null;

  const hostGlobal = Object.freeze({ exports: bundleExports });
  Object.defineProperty(window, '__AI_CANVAS_PLUGIN_HOST__', {
    value: hostGlobal,
    writable: false,
    configurable: false,
  });

  function showStatus(message, isError = false) {
    root.replaceChildren();
    const panel = document.createElement('div');
    panel.className = isError
      ? 'plugin-ui-status plugin-ui-status-error'
      : 'plugin-ui-status';
    panel.textContent = message;
    root.appendChild(panel);
  }

  function request(kind, payload = null) {
    if (!sessionId) return Promise.reject(new Error('缺少插件界面会话'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeoutMs = kind === 'effect' || kind === 'submit'
        ? LONG_REQUEST_TIMEOUT_MS
        : REQUEST_TIMEOUT_MS;
      const timeoutId = window.setTimeout(() => {
        if (!pending.delete(requestId)) return;
        reject(new Error('宿主请求超时'));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timeoutId });
      window.parent.postMessage({
        channel: CHANNEL,
        direction: 'request',
        sessionId,
        requestId,
        kind,
        payload,
      }, '*');
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const response = event.data;
    if (!response || response.channel !== CHANNEL || response.sessionId !== sessionId) return;
    if (response.direction === 'event' && response.kind === 'theme') {
      if (response.value !== 'dark' && response.value !== 'light') return;
      context = context ? { ...context, theme: response.value } : context;
      document.documentElement.setAttribute('data-theme', response.value);
      window.dispatchEvent(new CustomEvent('ai-canvas-theme-change', { detail: response.value }));
      return;
    }
    if (response.direction !== 'response') return;
    const entry = pending.get(response.requestId);
    if (!entry) return;
    pending.delete(response.requestId);
    window.clearTimeout(entry.timeoutId);
    if (response.ok) entry.resolve(response.value);
    else entry.reject(new Error(response.error || '宿主拒绝了请求'));
  });

  function loadBundle(url) {
    const parsed = new URL(url);
    const isWindowsProtocol = parsed.origin === 'http://plugin-ui.localhost';
    const isCustomProtocol = parsed.protocol === 'plugin-ui:' && parsed.hostname === 'localhost';
    if (!isWindowsProtocol && !isCustomProtocol) {
      throw new Error('插件界面产物地址无效');
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = parsed.href;
      script.onload = resolve;
      script.onerror = () => reject(new Error('插件界面产物加载失败'));
      document.head.appendChild(script);
    });
  }

  async function withBusy(operation) {
    if (busy) throw new Error('插件界面正在执行操作');
    busy = true;
    try {
      return await operation();
    } finally {
      busy = false;
    }
  }

  function createProps() {
    const props = {
      surface: context.surface,
      get theme() {
        return context.theme;
      },
      node: context.node,
      models: context.models,
      resources: context.resources,
      get parameters() {
        return context.parameters;
      },
      get busy() {
        return busy;
      },
      runEffect(effect) {
        return withBusy(() => request('effect', effect));
      },
      async setParameters(patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new Error('参数更新必须是对象');
        }
        await request('set-parameters', patch);
        context = { ...context, parameters: { ...context.parameters, ...patch } };
      },
      submit(data = {}) {
        const submitted = { ...context.parameters, ...data };
        return withBusy(() => request('submit', { data: submitted }));
      },
      close() {
        return request('close');
      },
      toast(message, type = 'success') {
        return request('toast', { message, type });
      },
    };
    return Object.freeze(props);
  }

  async function boot() {
    if (!root || !sessionId || !exportName || !bundleUrl) {
      throw new Error('插件界面参数缺失');
    }
    let parentDocumentAccessible = true;
    try {
      void window.parent.document;
    } catch {
      parentDocumentAccessible = false;
    }
    if (
      window.parent === window
      || window.location.protocol !== 'blob:'
      || window.origin !== 'null'
      || parentDocumentAccessible
    ) {
      throw new Error('插件界面隔离边界无效');
    }
    showStatus('正在加载插件界面…');
    context = await request('context');
    document.documentElement.setAttribute('data-theme', context.theme);
    await loadBundle(bundleUrl);
    const mount = bundleExports[exportName];
    if (typeof mount !== 'function') {
      throw new Error(`插件未导出挂载函数: ${exportName}`);
    }
    root.replaceChildren();
    const result = await mount(root, createProps());
    if (typeof result === 'function') cleanup = result;
  }

  window.addEventListener('pagehide', () => {
    if (cleanup) cleanup();
    for (const entry of pending.values()) {
      window.clearTimeout(entry.timeoutId);
      entry.reject(new Error('插件界面已关闭'));
    }
    pending.clear();
  }, { once: true });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || busy) return;
    event.preventDefault();
    void request('close').catch((error) => {
      showStatus(error instanceof Error ? error.message : String(error), true);
    });
  });

  void boot().catch((error) => {
    showStatus(`插件界面加载失败：${error instanceof Error ? error.message : String(error)}`, true);
  });
})();

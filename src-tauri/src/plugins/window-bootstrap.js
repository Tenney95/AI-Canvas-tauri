(() => {
  'use strict';

  // 由原生私有协议注入，仅包含当前登记会话，不读取 query 或插件自报身份。
  const config = __PLUGIN_WINDOW_CONFIG__;
  const root = document.getElementById('root');
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  const bundleExports = Object.create(null);
  let context = null;
  let busy = false;
  let disposed = false;
  let cleanup = null;
  const pending = new Set();

  Object.defineProperty(window, '__AI_CANVAS_PLUGIN_HOST__', {
    value: Object.freeze({ exports: bundleExports }),
    writable: false,
    configurable: false,
  });

  function showStatus(message) {
    if (!root || disposed) return;
    const panel = document.createElement('div');
    panel.className = 'plugin-ui-status';
    panel.setAttribute('role', 'status');
    panel.textContent = message;
    root.replaceChildren(panel);
  }

  function request(kind, payload = null) {
    if (disposed || !invoke) return Promise.reject(new Error('插件窗口会话不可用'));
    if (pending.size >= 8) return Promise.reject(new Error('宿主请求过多'));
    // 回包固定为 JSON 字符串：不依赖 core:channel、通用事件或插件窗口控制权限。
    return new Promise((resolve, reject) => {
      const entry = { reject };
      pending.add(entry);
      void invoke('plugin_ui_window_request', {
        request: { binding: config.binding, requestId: crypto.randomUUID(), kind, payload },
      }).then((serialized) => {
        if (!pending.delete(entry)) return;
        if (disposed) throw new Error('插件窗口已关闭');
        if (typeof serialized !== 'string') throw new Error('宿主回包格式无效');
        const reply = JSON.parse(serialized);
        if (!reply || typeof reply.ok !== 'boolean') throw new Error('宿主回包格式无效');
        if (!reply.ok) throw new Error(reply.error || '宿主拒绝了请求');
        resolve(reply.value);
      }).catch((error) => {
        pending.delete(entry);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
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

  function applyTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') throw new Error('宿主主题无效');
    document.documentElement.setAttribute('data-theme', theme);
  }

  function createProps() {
    return Object.freeze({
      surface: context.surface,
      get theme() { return context.theme; },
      node: context.node,
      models: context.models,
      resources: context.resources,
      get parameters() { return context.parameters; },
      get busy() { return busy; },
      runEffect(effect) { return withBusy(() => request('effect', effect)); },
      async setParameters(patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new Error('参数更新必须是对象');
        }
        await request('set-parameters', patch);
        context = { ...context, parameters: { ...context.parameters, ...patch } };
      },
      submit(data = {}) {
        return withBusy(async () => {
          const result = await request('submit', { data: { ...context.parameters, ...data } });
          // 只有页面真正收到成功才请求关闭，避免关闭命令先于原生 submit 回包恢复。
          // 成功已确认；收尾期间销毁导致 close Promise 拒绝不应把已完成的提交显示成失败。
          void request('close').catch(() => {});
          return result;
        });
      },
      close() { return request('close'); },
      toast(message, type = 'success') { return request('toast', { message, type }); },
    });
  }

  function loadBundle() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('./bundle.js', config.url).href;
      script.onload = resolve;
      script.onerror = () => reject(new Error('插件界面产物加载失败'));
      document.head.appendChild(script);
    });
  }

  async function boot() {
    if (!root || !invoke || window.top !== window || window.location.href !== config.url) {
      throw new Error('插件窗口隔离边界无效');
    }
    showStatus('正在加载插件界面…');
    context = await request('context');
    if (disposed) return;
    applyTheme(context.theme);
    await loadBundle();
    if (disposed) return;
    const mount = bundleExports[config.exportName];
    if (typeof mount !== 'function') throw new Error('插件未导出界面挂载函数');
    root.replaceChildren();
    const result = await mount(root, createProps());
    if (typeof result === 'function') {
      if (disposed) result();
      else cleanup = result;
    }
  }

  window.addEventListener('pagehide', () => {
    disposed = true;
    for (const entry of pending) entry.reject(new Error('插件窗口已关闭'));
    pending.clear();
    if (cleanup) cleanup();
  }, { once: true });

  // 不依赖通用事件：窗口重新获得焦点时通过同一会话桥接刷新主题。
  window.addEventListener('focus', () => {
    if (!context || disposed || busy) return;
    void request('context').then((next) => {
      if (disposed || next.theme === context.theme) return;
      applyTheme(next.theme);
      context = { ...context, theme: next.theme };
      window.dispatchEvent(new CustomEvent('ai-canvas-theme-change', { detail: next.theme }));
    }).catch(() => { /* 会话被撤销时由原生层关闭窗口。 */ });
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || busy || disposed) return;
    event.preventDefault();
    void request('close').catch((error) => showStatus(error.message));
  });

  void boot().catch((error) => {
    showStatus(`插件界面加载失败：${error instanceof Error ? error.message : String(error)}`);
  });
})();

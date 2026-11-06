/** 模拟预览专用协议。不能使用生产插件 Broker 或原生 IPC。 */
(() => {
  'use strict';
  const nonce = document.currentScript.nonce;
  const sessionId = new URLSearchParams(location.hash.slice(1)).get('session');
  const channel = 'ai-canvas-plugin-preview-v1';
  const root = document.getElementById('root');
  const pending = new Map();
  const exports = Object.create(null);
  let context;
  let cleanup;
  let disposed = false;
  let bundleUrl = null;
  Object.defineProperty(window, '__AI_CANVAS_PLUGIN_HOST__', { value: Object.freeze({ exports }), writable: false, configurable: false });
  const request = (kind, payload = null) => new Promise((resolve, reject) => {
    if (disposed || pending.size >= 8) { reject(new Error('Preview is closed or busy')); return; }
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Preview request timed out')); }, 5000);
    pending.set(requestId, { resolve, reject, timer });
    parent.postMessage({ channel, sessionId, requestId, kind, payload }, '*');
  });
  const receive = (event) => {
    if (event.source !== parent || event.data?.channel !== channel || event.data.sessionId !== sessionId) return;
    const entry = pending.get(event.data.requestId);
    if (!entry) return;
    pending.delete(event.data.requestId); clearTimeout(entry.timer);
    if (event.data.ok) entry.resolve(event.data.value);
    else entry.reject(new Error('Preview only: real effects are unavailable'));
  };
  addEventListener('message', receive);
  addEventListener('pagehide', () => {
    disposed = true; removeEventListener('message', receive);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Preview closed')); }
    pending.clear(); if (bundleUrl) URL.revokeObjectURL(bundleUrl); if (typeof cleanup === 'function') cleanup();
  }, { once: true });
  const boot = async () => {
    let accessible = true;
    try { void parent.document; } catch { accessible = false; }
    if (!sessionId || parent === window || location.protocol !== 'blob:' || origin !== 'null' || accessible) throw new Error('Preview isolation is invalid');
    context = await request('context');
    document.documentElement.dataset.theme = context.theme;
    document.documentElement.lang = context.locale;
    const script = document.createElement('script');
    if (typeof context.uiSource !== 'string') throw new Error('Preview source is invalid');
    const bundle = new Blob([context.uiSource], { type: 'text/javascript' });
    if (bundle.size > 2 * 1024 * 1024) throw new Error('Preview source is too large');
    bundleUrl = URL.createObjectURL(bundle);
    script.nonce = nonce;
    script.src = bundleUrl;
    try {
      await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; document.head.appendChild(script); });
    } finally { URL.revokeObjectURL(bundleUrl); bundleUrl = null; }
    const mount = exports[context.exportName];
    if (typeof mount !== 'function') throw new Error('Preview export not found');
    const props = Object.freeze({
      host: context.host, surface: 'tool-dialog', theme: context.theme, locale: context.locale,
      node: context.node, models: [], resources: context.resources, busy: false,
      get parameters() { return context.parameters; },
      runEffect: (effect) => request('effect', effect),
      async setParameters(patch) { context.parameters = await request('set-parameters', patch); },
      submit: (data) => request('submit', data), close: () => request('close'), toast: () => request('toast'),
    });
    cleanup = await mount(root, props);
    if (disposed && typeof cleanup === 'function') { cleanup(); cleanup = null; }
  };
  boot().catch(() => { root.textContent = 'Preview failed. Check the UI export and package integrity.'; });
})();

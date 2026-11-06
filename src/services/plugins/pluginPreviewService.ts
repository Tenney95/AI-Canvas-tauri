import previewDocument from '../../../plugin-preview-host.html?raw';
import type { PluginJsonValue, PluginManifest } from '../../types/plugin';
import { PLUGIN_HOST } from './pluginHost';
import { createPluginUiFrameDocument } from './pluginUiFrameDocument';
import { createPluginLifecycleScope } from './pluginLifecycleScope';

const CHANNEL = 'ai-canvas-plugin-preview-v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
function boundedParameters(value: unknown): Record<string, PluginJsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('预览参数无效');
  if (new TextEncoder().encode(JSON.stringify(value)).length > 16384) throw new Error('预览参数过大');
  let count = 0;
  const check = (item: unknown, depth: number): void => {
    if (++count > 1024 || depth > 12) throw new Error('预览参数过深');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { item.forEach((child) => check(child, depth + 1)); return; }
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('预览参数字段无效');
        check(child, depth + 1);
      }
      return;
    }
    throw new Error('预览参数值无效');
  };
  check(value, 0);
  return structuredClone(value) as Record<string, PluginJsonValue>;
}

export async function createPluginPreview(options: {
  manifest: PluginManifest; uiSource: string; exportName: string;
  theme: 'dark' | 'light'; locale: string; onClose: () => void; onSubmit: () => void;
}) {
  const ui = options.manifest.ui;
  const globalExport = ui?.exports[options.exportName];
  if (!ui || !globalExport || !options.manifest.permissions.includes('ui.custom')) throw new Error('插件未声明可预览的界面');
  const bytes = new TextEncoder().encode(options.uiSource);
  if (bytes.length > 2 * 1024 * 1024) throw new Error('预览界面过大');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== ui.integrity.replace(/^sha256-/, '')) throw new Error('预览界面摘要不匹配');
  const scope = createPluginLifecycleScope();
  const sessionId = crypto.randomUUID();
  let frame: Window | null = null;
  const tool = options.manifest.contributes.nodeTools.find((item) => item.dialog?.ui === options.exportName);
  let parameters: Record<string, PluginJsonValue> = {};
  for (const field of tool?.dialog?.fields ?? []) {
    if (field.defaultValue !== undefined) parameters[field.id] = field.defaultValue;
  }
  parameters = boundedParameters(parameters);
  const seen = new Set<string>();
  let document: ReturnType<typeof createPluginUiFrameDocument>;
  try {
    document = createPluginUiFrameDocument(previewDocument, '/plugin-preview-bootstrap.js', new URLSearchParams({ session: sessionId }));
  } catch {
    await scope.dispose();
    throw new Error('预览宿主页无效');
  }
  scope.defer(() => URL.revokeObjectURL(document.objectUrl));
  const receive = (event: MessageEvent) => {
    const request = event.data;
    if (!scope.isActive() || !frame || event.source !== frame || !request || request.channel !== CHANNEL
      || request.sessionId !== sessionId || typeof request.requestId !== 'string' || !UUID.test(request.requestId)
      || seen.has(request.requestId) || seen.size >= 128) return;
    seen.add(request.requestId);
    let ok = true;
    let value: unknown = null;
    try {
      if (new TextEncoder().encode(JSON.stringify(request)).length > 20 * 1024) throw new Error('oversize');
      switch (request.kind) {
        case 'context': value = { host: PLUGIN_HOST, theme: options.theme, locale: options.locale, parameters,
          // 作者产物仅通过绑定的临时消息交给 opaque frame，在 frame 内创建其自己的 Blob。
          exportName: globalExport, uiSource: options.uiSource, node: { id: 'preview-node', type: tool?.nodeTypes[0] ?? 'ai-text', data: { label: 'Preview', prompt: '', output: '' } },
          resources: { self: [], incoming: [], inputs: {}, package: [], derived: [] } }; break;
        case 'set-parameters': parameters = boundedParameters({ ...parameters, ...boundedParameters(request.payload) }); value = parameters; break;
        case 'submit': boundedParameters(request.payload ?? {}); options.onSubmit(); value = { preview: true, applied: false }; break;
        case 'toast': break;
        case 'close': queueMicrotask(options.onClose); break;
        default: ok = false;
      }
    } catch { ok = false; }
    if (scope.isActive()) frame.postMessage({ channel: CHANNEL, sessionId, requestId: request.requestId, ok, value }, '*');
  };
  window.addEventListener('message', receive);
  scope.defer(() => { window.removeEventListener('message', receive); frame = null; seen.clear(); parameters = {}; });
  return { src: document.src, attach: (target: Window | null) => { if (scope.isActive()) frame = target; }, dispose: scope.dispose };
}

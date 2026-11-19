/** 公开合同目录；固定白名单，不反射 Store、对象路径或内部服务。 */
import type { InstalledPlugin, PluginContractEntry, PluginInspectInput, PluginNodeHostEffect } from '../../types/plugin';
import { PLUGIN_HOST } from './pluginHost';
import { resolvePluginDependencies } from './pluginDependencyService';
import { parsePluginModelProtocols } from './pluginManifest';

export const PLUGIN_INSPECT_SCHEMA = {
  type: 'object' as const, additionalProperties: false,
  properties: {
    section: { type: 'string' as const, enum: ['host', 'manifest', 'sdk', 'ui', 'plugins'] },
    query: { type: 'string' as const, maxLength: 120 },
    offset: { type: 'integer' as const, minimum: 0, maximum: 512 },
    limit: { type: 'integer' as const, minimum: 1, maximum: 8 },
  },
};

/** keyof 联合要求覆盖真实 SDK effect；不是新增 effect 或执行授权。 */
const EFFECT_FIELDS = {
  'model.generate': ['modelId', 'prompt', 'imageUrls?', 'resourceIds?', 'parameters?'],
  'network.request': ['url', 'method?', 'headers?', 'body?'],
  'settings.get': ['key'], 'settings.set': ['key', 'value'], 'settings.delete': ['key'],
  'resource.readText': ['resourceId', 'maxBytes?'], 'resource.readRange': ['resourceId', 'offset', 'length'],
  'resource.createText': ['content', 'suggestedName?'], 'resource.export': ['resourceId', 'suggestedName?'],
  'image.lineArt': ['resourceId'], 'video.preparePlayback': ['resourceId'],
  'video.readPlayback': ['resourceId', 'offset', 'length'],
  'video.detectShots': ['resourceId', 'start', 'end', 'threshold?', 'minShotDuration?'],
  'video.inspectFrame': ['resourceId', 'time', 'direction', 'boundary?'],
  'video.extractFrames': ['resourceId', 'mode', 'count?', 'samples?', 'replaceDerived?'],
  'prompt.mentions': ['source', 'query?', 'offset?', 'preview?'],
  'wsagent.sharedImages.list': ['offset?'], 'wsagent.sharedImages.preview': ['assetId'],
  'wsagent.sharedImages.insert': ['assetId'], 'wsagent.sharedImages.publish': ['resourceId', 'name?'],
  'video.replicaJob.start': ['resourceId', 'modelId', 'controls', 'audioMode', 'transcribe', 'analysisModelId?',
    'character?', 'scene?', 'style?', 'cuts?', 'maxSegmentSeconds?', 'resolution?', 'aspectRatio?', 'downloadSpeech?'],
  'video.replicaJob.status': ['jobId'], 'video.replicaJob.cancel': ['jobId'], 'video.replicaJob.restart': ['jobId'],
} satisfies Record<PluginNodeHostEffect['type'], readonly string[]>;

const FIELD_SCHEMAS: Record<string, Record<string, unknown>> = {
  assetId: { type: 'string' }, name: { type: 'string' },
  resourceId: { type: 'string' }, modelId: { type: 'string' }, analysisModelId: { type: 'string' }, prompt: { type: 'string' },
  url: { type: 'string' }, method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  headers: { type: 'object', additionalProperties: { type: 'string' } }, body: { type: 'string' }, key: { type: 'string' }, value: {},
  content: { type: 'string' }, suggestedName: { type: 'string' }, jobId: { type: 'string' }, query: { type: 'string' },
  offset: { type: 'integer' }, length: { type: 'integer' }, maxBytes: { type: 'integer' }, count: { type: 'integer' },
  start: { type: 'number' }, end: { type: 'number' }, time: { type: 'number' }, threshold: { type: 'number' },
  minShotDuration: { type: 'number' }, maxSegmentSeconds: { type: 'number' },
  direction: { type: 'integer', enum: [-1, 0, 1] }, boundary: { type: 'boolean' }, preview: { type: 'boolean' },
  transcribe: { type: 'boolean' }, downloadSpeech: { type: 'boolean' }, replaceDerived: { type: 'boolean' },
  mode: { type: 'string', enum: ['preview', 'analysis'] }, source: { type: 'string', enum: ['nodes', 'characters', 'assets'] },
  imageUrls: { type: 'array', items: { type: 'string' } }, resourceIds: { type: 'array', items: { type: 'string' } },
  parameters: { type: 'object' }, controls: { type: 'array', items: { type: 'string', enum: ['depth', 'pose', 'canny'] } },
  cuts: { type: 'array', items: { type: 'number' } }, samples: { type: 'array', items: {
    type: 'object', required: ['key', 'time'], properties: { key: { type: 'string' }, time: { type: 'number' } }, additionalProperties: false,
  } },
  character: { type: 'string' }, scene: { type: 'string' }, style: { type: 'string' }, resolution: { type: 'string' }, aspectRatio: { type: 'string' },
  audioMode: { type: 'string', enum: ['original', 'model', 'mute'] },
};

const PUBLIC_CONTRACTS: readonly PluginContractEntry[] = [
  { id: 'host', section: 'host', summary: '宿主支持能力与额度；支持不代表插件已获得权限', contract: { ...PLUGIN_HOST } },
  { id: 'manifest.compatibility', section: 'manifest', summary: 'API 与兼容性', contract: {
    apiVersion: [...PLUGIN_HOST.apiVersions], minHostVersion: '稳定 x.y.z', requiredCapabilities: [...PLUGIN_HOST.capabilities],
    runtime: ['javascript', 'python'], entries: ['main.js', 'main.py'],
    limits: { manifestBytes: 65536, sourceBytes: 524288, dependencies: 16 },
    dependencies: { fields: ['pluginId', 'minVersion', 'optional'], capability: 'plugin.dependencies', apiVersion: 2 },
  } },
  { id: 'manifest.modelProtocols', section: 'manifest', summary: '模型协议预设贡献（宿主原生适配器）', contract: {
    apiVersion: 2, capability: 'model.protocolPresets', location: 'contributes.modelProtocols', maxItems: 16,
    fields: ['id', 'name', 'category', 'adapter'], category: ['text'],
    adapters: ['openai-compatible', 'openai-responses', 'anthropic-compatible', 'gemini-native'],
    reference: { preset: 'plugin', plugin: { pluginId: '插件 ID', presetId: '贡献 ID' } },
    package: '允许仅贡献预设，nodeTools 可为空；保留 main.js 入口，选择预设不执行脚本',
    authority: '原生活动 revision 的核验快照；请求前和结果交付前重验；更新、停用、卸载及修复撤销调用',
    credentials: '宿主从模型连接注入，不向插件传递凭据、Base URL 或消息',
  } },
  { id: 'sdk.security', section: 'sdk', summary: '执行与宿主 effect 边界', contract: {
    identity: ['pluginId', 'sourceDigest', 'revisionDigest', 'toolId', 'invocationId'],
    permissions: ['node.read', 'node.write', 'models.read', 'models.invoke', 'prompt.references.read', 'wsagent.shared-images', 'network.request',
      'settings.read', 'settings.write', 'files.connected.read', 'files.output.create', 'plugin.resources.read', 'ui.custom'],
    resources: '调用级不透明句柄；不授予路径或内部服务',
    python: '可信本机代码，原生高风险确认；不是 OS 沙箱',
    output: '仅声明的输出字段；最终回写仍校验项目、节点、画布与 revision',
  } },
  { id: 'ui.mount', section: 'ui', summary: '隔离 UI 的真实挂载合同', contract: {
    surface: ['tool-dialog'], theme: ['dark', 'light'], events: ['ai-canvas-theme-change', 'ai-canvas-locale-change'],
    props: ['host', 'surface', 'theme', 'locale', 'node', 'models', 'parameters', 'resources', 'busy'],
    callbacks: ['runEffect', 'setParameters', 'submit', 'close', 'toast'],
    uiKit: '仅源码开发参考，宿主组件与 ui-* 样式未注入隔离页面',
    isolation: 'sandbox allow-scripts；独立原生 WebView；严格 CSP；主窗口 Broker',
  } },
];

export function inspectPluginContract(input: PluginInspectInput = {}, plugins: readonly InstalledPlugin[] = []) {
  const { section, query = '', offset = 0, limit = 4 } = input;
  if ((section && !['host', 'manifest', 'sdk', 'ui', 'plugins'].includes(section)) || query.length > 120
    || !Number.isSafeInteger(offset) || offset < 0 || offset > 512
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 8) throw new Error('插件合同查询参数无效');
  const installed: PluginContractEntry[] = plugins.filter((plugin) => /^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/u.test(plugin.id)).slice(0, 512).map((plugin) => {
    const dependencies = resolvePluginDependencies(plugins, plugin.id);
    let modelProtocols: ReturnType<typeof parsePluginModelProtocols> = [];
    try { modelProtocols = parsePluginModelProtocols(plugin.manifest.contributes.modelProtocols); } catch { /* 损坏声明不进入公开摘要。 */ }
    return { id: plugin.id, section: 'plugins', summary: `${plugin.id} · ${plugin.enabled ? '配置启用' : '配置停用'}`, contract: {
      id: plugin.id, version: /^[\d.]{1,32}$/u.test(plugin.manifest.version) ? plugin.manifest.version : 'custom',
      runtime: plugin.manifest.runtime, enabled: plugin.enabled,
      modelProtocols: modelProtocols.map(({ id, category, adapter }) => ({ id, category, adapter })),
      dependenciesReady: dependencies.ready, reasons: dependencies.ready ? [] : ['必需依赖未满足或声明存在循环'],
      nativeHealth: '需在插件设置中刷新原生健康状态，配置启用不等于实际生效',
    } };
  });
  const needle = query.toLocaleLowerCase();
  const effectEntries: PluginContractEntry[] = Object.entries(EFFECT_FIELDS).map(([type, fields]) => ({
    id: type, section: 'sdk', summary: `SDK effect ${type}（? 表示可选字段）`, contract: { type, fields,
      inputSchema: { type: 'object', additionalProperties: false, required: ['type', ...fields.filter((field) => !field.endsWith('?'))],
        properties: { type: { type: 'string', const: type }, ...Object.fromEntries(fields.map((field) => {
          const name = field.replace(/\?$/u, '');
          return [name, FIELD_SCHEMAS[name] ?? {}];
        })) } },
      authority: '按 Manifest 权限、资源租约、宿主额度与原生活动 revision 再次校验，不代表授权' },
  }));
  const entries = [...PUBLIC_CONTRACTS, ...effectEntries, ...installed].filter((entry) => (!section || entry.section === section)
    && (!needle || `${entry.id} ${entry.summary} ${JSON.stringify(entry.contract)}`.toLocaleLowerCase().includes(needle)));
  const page = entries.slice(offset, offset + limit);
  // 固定单页字节预算，整个条目裁剪，不能截断 JSON。
  while (page.length && new TextEncoder().encode(JSON.stringify(page)).length > 16 * 1024) page.pop();
  return { entries: structuredClone(page), total: entries.length, hasMore: offset + page.length < entries.length,
    nextOffset: offset + page.length, hostVersion: PLUGIN_HOST.version };
}

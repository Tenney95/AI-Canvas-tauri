/** 厂商接线策略。仅依赖类型，Store 不需加载目录、模型合同或网络执行模块。 */
import type { ApiProviderConfig, ProviderModelSelection } from '../../types';

export interface ProviderPolicy {
  readonly syncGeneralModels: boolean;
  readonly modelMenuGroup?: {
    readonly scope: 'catalog' | 'connection';
    readonly description: string;
  };
  readonly catalog: {
    readonly initialModelsOnCreate: 'fallback' | 'empty';
    readonly initialModelsOnEdit: 'fallback' | 'empty';
    readonly refresh: 'merge' | 'replace' | 'replace-unselected';
    readonly fallback: 'allow' | 'deny' | 'ungrouped-only';
    readonly invalidateOnKeyChange: boolean;
    readonly connectionTest: 'default' | 'catalog';
  };
  /** 仅选择已有上传实现；地址、凭据及媒体约束仍由各实现复核。 */
  readonly upload?: 'apimart' | 'toapis' | 'libapi' | 'minimax' | 'volcengine-tos';
  /** 内置中转站不能把参考素材改传连接图床或全局公共托管。 */
  readonly publicUploadFallback?: 'deny';
  /** 公网地址或随模型请求提交文件；后者不允许回退到独立图床上传。 */
  readonly referenceTransport?: 'public-url' | 'request-files';
  /** 仅为每次新媒体提交注入应用生成的幂等身份，不启用提交重试。 */
  readonly submitIdempotency?: boolean;
}

type PolicyOverrides = Omit<Partial<ProviderPolicy>, 'catalog'> & { catalog?: Partial<ProviderPolicy['catalog']> };

const DEFAULT_POLICY: Readonly<ProviderPolicy> = Object.freeze({
  syncGeneralModels: false,
  catalog: Object.freeze({
    initialModelsOnCreate: 'fallback', initialModelsOnEdit: 'fallback',
    refresh: 'merge', fallback: 'allow', invalidateOnKeyChange: false, connectionTest: 'default',
  }),
});

const POLICY_OVERRIDES: Record<string, PolicyOverrides> = {
  apimart: { upload: 'apimart', publicUploadFallback: 'deny' },
  grsai: { publicUploadFallback: 'deny' },
  volcengine: { upload: 'volcengine-tos' },
  'custom-openai': { syncGeneralModels: true },
  magpie: { syncGeneralModels: true, catalog: { fallback: 'deny', invalidateOnKeyChange: true, connectionTest: 'catalog' } },
  xai: { syncGeneralModels: true },
  replicate: { syncGeneralModels: true, publicUploadFallback: 'deny' },
  google: { syncGeneralModels: true },
  kling: { syncGeneralModels: true, referenceTransport: 'request-files', publicUploadFallback: 'deny' },
  minimax: { syncGeneralModels: true, upload: 'minimax',
    modelMenuGroup: { scope: 'connection', description: '使用当前 MiniMax 官方连接中的图片、视频和语音模型' } },
  sora2u: { syncGeneralModels: true, publicUploadFallback: 'deny',
    modelMenuGroup: { scope: 'connection', description: 'Seedance 视频与图片模型' } },
  cccapi: { syncGeneralModels: true, publicUploadFallback: 'deny',
    modelMenuGroup: { scope: 'catalog', description: '按模型所属分组自动使用对应的 API Key' },
    catalog: { initialModelsOnCreate: 'empty', refresh: 'replace', fallback: 'ungrouped-only', connectionTest: 'catalog' } },
  toapis: { syncGeneralModels: true,
    modelMenuGroup: { scope: 'connection', description: '使用连接中选择的国内站或国际站' },
    catalog: { refresh: 'replace-unselected', fallback: 'deny', invalidateOnKeyChange: true, connectionTest: 'catalog' },
    upload: 'toapis', publicUploadFallback: 'deny' },
  libapi: { syncGeneralModels: true,
    modelMenuGroup: { scope: 'connection', description: '使用当前 LibAPI 连接中启用的模型' },
    catalog: { refresh: 'replace', fallback: 'deny', invalidateOnKeyChange: true, connectionTest: 'catalog' },
    upload: 'libapi', publicUploadFallback: 'deny' },
  relayonapi: { syncGeneralModels: true,
    modelMenuGroup: { scope: 'catalog', description: '按模型所属分组使用对应的 API Key' },
    catalog: { refresh: 'replace-unselected', fallback: 'deny', invalidateOnKeyChange: true, connectionTest: 'catalog' },
    referenceTransport: 'request-files', publicUploadFallback: 'deny', submitIdempotency: true },
  'aigc-si': { syncGeneralModels: true,
    modelMenuGroup: { scope: 'connection', description: '使用当前 Amam 连接中启用的图片与视频模型' },
    catalog: { refresh: 'replace', fallback: 'deny', invalidateOnKeyChange: true, connectionTest: 'catalog' },
    publicUploadFallback: 'deny', submitIdempotency: true },
};

const POLICIES = new Map(Object.entries(POLICY_OVERRIDES).map(([id, overrides]) => [id, Object.freeze({
  ...DEFAULT_POLICY, ...overrides,
  catalog: Object.freeze({ ...DEFAULT_POLICY.catalog, ...overrides.catalog }),
})]));

/** 显式厂商类型优先于连接名称；自定义连接恰好叫 libapi 时也不能借用其上传或合同。 */
export function resolveProviderCatalogId(
  connectionId: string,
  config?: Pick<ApiProviderConfig, 'catalogId'>,
): string {
  const id = config?.catalogId || connectionId;
  return id === 'autodl-workflow' ? 'workflow-api' : id;
}

export function getProviderPolicy(catalogId: string | undefined): Readonly<ProviderPolicy> {
  return POLICIES.get(catalogId ?? '') ?? DEFAULT_POLICY;
}

/** 目录只授权发现。保存之前至少需要明确的媒体协议，完整映射由合同校验器检查。 */
export function assertMagpieMediaSelection(model: ProviderModelSelection): void {
  if (model.category === 'text') return;
  const preset = model.executionProfile?.preset;
  if (!preset) throw new Error(`模型“${model.name}”是 Magpie 目录候选，请先配置调用协议或取消启用`);
  if (preset === 'openai-chat' || preset === 'openai-responses' || preset === 'anthropic-chat'
    || preset === 'gemini-chat' || preset === 'plugin') {
    throw new Error(`模型“${model.name}”需要媒体调用协议，请检查当前模型类别`);
  }
}

export function isMagpieRoutingGroup(modelId: string): boolean {
  return modelId.startsWith('group/') || modelId.startsWith('auto/');
}

/** 目录没有成员的共同上限。手动值可用于已在网关核实的路由配置。 */
export function resolveMagpieContextWindow(model: Pick<ProviderModelSelection, 'id' | 'contextWindow' | 'catalogTextLimits'>): number | undefined {
  const published = readPositiveTokenCount(model.catalogTextLimits?.source === 'magpie' ? model.catalogTextLimits.contextWindow : undefined);
  const override = readPositiveTokenCount(model.contextWindow);
  if (override !== undefined) return published === undefined ? override : Math.min(override, published);
  if (isMagpieRoutingGroup(model.id)) return Math.min(32_000, published ?? Infinity);
  return published ?? 32_000;
}

export function readPositiveTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

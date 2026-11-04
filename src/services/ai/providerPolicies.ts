/** 厂商接线策略。仅依赖类型，Store 不需加载目录、模型合同或网络执行模块。 */
import type { ApiProviderConfig } from '../../types';

export interface ProviderPolicy {
  readonly syncGeneralModels: boolean;
  readonly modelMenuGroup?: {
    readonly scope: 'catalog' | 'connection';
    readonly description: string;
  };
  readonly catalog: {
    readonly initialModelsOnCreate: 'fallback' | 'empty';
    readonly initialModelsOnEdit: 'fallback' | 'empty';
    readonly refresh: 'merge' | 'replace';
    readonly fallback: 'allow' | 'deny' | 'ungrouped-only';
    readonly invalidateOnKeyChange: boolean;
    readonly connectionTest: 'default' | 'catalog';
  };
  /** 仅选择已有上传实现；地址、凭据及媒体约束仍由各实现复核。 */
  readonly upload?: 'toapis' | 'libapi';
  /** 媒体参考需要公网地址；无专用上传实现时沿用应用已有公共上传服务。 */
  readonly referenceTransport?: 'public-url';
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
  'custom-openai': { syncGeneralModels: true },
  xai: { syncGeneralModels: true },
  google: { syncGeneralModels: true },
  sora2u: { syncGeneralModels: true,
    modelMenuGroup: { scope: 'connection', description: 'Seedance 视频与图片模型' } },
  cccapi: { syncGeneralModels: true,
    modelMenuGroup: { scope: 'catalog', description: '按模型所属分组自动使用对应的 API Key' },
    catalog: { initialModelsOnCreate: 'empty', refresh: 'replace', fallback: 'ungrouped-only', connectionTest: 'catalog' } },
  toapis: { syncGeneralModels: true,
    modelMenuGroup: { scope: 'connection', description: '使用连接中选择的国内站或国际站' },
    catalog: { refresh: 'replace', fallback: 'deny', invalidateOnKeyChange: true, connectionTest: 'catalog' },
    upload: 'toapis' },
  libapi: { syncGeneralModels: true,
    modelMenuGroup: { scope: 'connection', description: '使用当前 LibAPI 连接中启用的模型' },
    catalog: { refresh: 'replace', fallback: 'deny', invalidateOnKeyChange: true, connectionTest: 'catalog' },
    upload: 'libapi' },
  relayonapi: { syncGeneralModels: true,
    modelMenuGroup: { scope: 'catalog', description: '按模型所属分组使用对应的 API Key' },
    catalog: { refresh: 'replace', fallback: 'deny', invalidateOnKeyChange: true, connectionTest: 'catalog' },
    referenceTransport: 'public-url', submitIdempotency: true },
  'aigc-si': { syncGeneralModels: true,
    modelMenuGroup: { scope: 'connection', description: '使用当前 Amam 连接中启用的图片与视频模型' },
    catalog: { refresh: 'replace', fallback: 'deny', invalidateOnKeyChange: true, connectionTest: 'catalog' },
    submitIdempotency: true },
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

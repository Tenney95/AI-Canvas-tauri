/** 恢复按原回执摘要选择协议；渠道模板更新不能替换原查询或取件合同。 */
import type { ModelExecutionProfile, NormalizedModelExecutionProtocol } from '../types/aiTypes';
import { resolveModelExecutionProfile } from './ai/modelProtocol';
import { getRelayonVideoRecoveryProfiles } from './ai/providers/relayonModelManifest';
import { replicatePredictionProtocolV1 } from './ai/providers/replicateModelManifest';
import type { MediaKind } from '../types/media';
import { nativeProtocolTaskDigest, nativeProtocolQueryDigest } from './nativeModelProtocolTask';
import { sha256BytesHex } from './mediaDataUrl';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { SAND_CONNECTIONS, SAND_VIDEO_MODEL_ID, sandProtocolFor } from './ai/providers/sandVideoContract';
import { MAGI_VIDEO_GATEWAYS, magiGatewayProtocol } from './ai/providers/magiVideoGateways';

// Published recovery revisions contain only query material. Keep them when the current model catalog changes.
function queryOnly(auth: NormalizedModelExecutionProtocol['auth'], taskIdPath: string,
  poll: NonNullable<NormalizedModelExecutionProtocol['poll']>): NormalizedModelExecutionProtocol {
  return { version: 2, mode: 'async', auth,
    submit: { method: 'POST', path: '/recovery-only' },
    response: { type: 'json', taskIdPath }, poll };
}

const klingV1 = queryOnly({ type: 'bearer' }, 'data.id', {
  method: 'GET', path: '/tasks', pathMode: 'origin', query: { task_ids: '{{submit.data.id}}' },
  response: { statusPath: 'data.0.status', successValues: ['succeeded'], failureValues: ['failed'],
    errorPath: 'data.0.message', result: { urlPath: 'data.0.outputs.*.url' } },
  intervalMs: 5_000, maxDurationMs: 7_200_000,
  retry: { maxRetries: 5, backoff: 'exponential', maxDelayMs: 60_000, honorRetryAfter: true, retryNetworkErrors: true },
});
const xaiV1 = queryOnly({ type: 'bearer' }, 'request_id', {
  method: 'GET', path: '/videos/{{submit.request_id}}',
  response: { statusPath: 'status', successValues: ['done'], failureValues: ['failed', 'expired'],
    result: { urlPath: 'video.url', mimeType: 'video/mp4' }, errorPath: 'error.message', progressPath: 'progress' },
  intervalMs: 10_000, maxDurationMs: 3_600_000,
  retry: { httpStatuses: [408, 429, 500, 502, 503, 504], maxRetries: 5, backoff: 'exponential', maxDelayMs: 60_000,
    honorRetryAfter: true, retryNetworkErrors: true },
});
const replicateV1 = (outputPath: 'output' | 'output.*') => queryOnly({ type: 'bearer' }, 'id',
  replicatePredictionProtocolV1('vendor/recovery-only', {}, outputPath).poll!);

interface NativeQueryContract {
  id: string;
  catalogId: string;
  modelId?: string;
  categories: readonly MediaKind[];
  protocol: NormalizedModelExecutionProtocol;
}

const QUERY_CONTRACTS = ([
  ...SAND_CONNECTIONS.map((site) => ({ id: site.queryId, catalogId: site.id,
    modelId: SAND_VIDEO_MODEL_ID, categories: ['video' as const], protocol: sandProtocolFor(site.id) })),
  ...MAGI_VIDEO_GATEWAYS.map((gateway) => ({ id: gateway.queryId, catalogId: gateway.id,
    modelId: SAND_VIDEO_MODEL_ID, categories: ['video' as const], protocol: magiGatewayProtocol(gateway) })),
  { id: 'kling-tasks-v1', catalogId: 'kling', categories: ['image', 'video'], protocol: klingV1 },
  { id: 'xai-video-v1', catalogId: 'xai', categories: ['video'], protocol: xaiV1 },
  { id: 'replicate-image-v1', catalogId: 'replicate', categories: ['image'], protocol: replicateV1('output.*') },
  { id: 'replicate-video-v1', catalogId: 'replicate', categories: ['video'], protocol: replicateV1('output') },
] satisfies NativeQueryContract[])
  .map((contract): NativeQueryContract => ({
    ...contract,
    protocol: resolveModelExecutionProfile({ preset: 'custom', protocol: contract.protocol })!,
  }));

export async function captureNativeQueryContractId(catalogId: string, category: MediaKind, modelId: string, queryDigest: string): Promise<string | undefined> {
  const contract = QUERY_CONTRACTS.find((item) => item.catalogId === catalogId && item.categories.includes(category)
    && (!item.modelId || item.modelId === modelId));
  return contract && await nativeProtocolQueryDigest(modelId, contract.protocol) === queryDigest ? contract.id : undefined;
}

export async function resolveNativeQueryContract(
  contractId: string | undefined, catalogId: string, category: MediaKind, modelId: string, digest: string | undefined,
): Promise<NormalizedModelExecutionProtocol | undefined> {
  const contract = QUERY_CONTRACTS.find((item) => item.id === contractId && item.catalogId === catalogId && item.categories.includes(category)
    && (!item.modelId || item.modelId === modelId));
  if (!contract) return undefined;
  return await nativeProtocolQueryDigest(modelId, contract.protocol) === digest ? structuredClone(contract.protocol) : undefined;
}

/** Per-operation comparison value for a vendor API token. Never store the token in a task record. */
export function nativeQueryCredentialProof(operationId: string, connectionId: string, apiKey: string): Promise<string> {
  return sha256BytesHex(new TextEncoder().encode(JSON.stringify(['native-query-v1', operationId, connectionId, apiKey])));
}

interface NativeRecoveryProtocolOptions {
  modelId: string;
  profile: ModelExecutionProfile | undefined;
  /** 仅真实万象视频连接允许读取已确认的新旧内置合同。 */
  catalogId?: string;
  /** 部分旧回执只保留查询摘要；缺失时仍不能通过完整摘要匹配。 */
  protocolDigest?: string;
  queryDigest?: string;
  /** 剪辑原账本使用纯协议摘要，普通媒体账本包含型号身份。 */
  digestKind?: 'model' | 'protocol';
  requireFullDigest?: boolean;
}

export async function resolveNativeRecoveryProtocol(
  options: NativeRecoveryProtocolOptions,
): Promise<NormalizedModelExecutionProtocol | undefined> {
  const profiles = options.catalogId === 'relayonapi'
    ? getRelayonVideoRecoveryProfiles(options.modelId, options.profile)
    : options.profile ? [options.profile] : [];
  const candidates = profiles.flatMap((profile) => {
    try {
      const protocol = resolveModelExecutionProfile(profile);
      return protocol ? [protocol] : [];
    } catch { return []; }
  });
  // 先遍历全部完整摘要，避免新旧协议查询摘要相同时误选新合同。
  for (const protocol of candidates) {
    const actual = options.digestKind === 'protocol'
      ? await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(protocol)))
      : await nativeProtocolTaskDigest(options.modelId, protocol);
    if (actual === options.protocolDigest) return protocol;
  }
  if (!options.requireFullDigest && options.queryDigest) {
    for (const protocol of candidates) {
      if (await nativeProtocolQueryDigest(options.modelId, protocol) === options.queryDigest) return protocol;
    }
  }
  return undefined;
}

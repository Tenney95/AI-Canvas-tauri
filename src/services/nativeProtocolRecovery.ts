/** 恢复按原回执摘要选择协议；渠道模板更新不能替换原查询或取件合同。 */
import type { ModelExecutionProfile, NormalizedModelExecutionProtocol } from '../types/aiTypes';
import { resolveModelExecutionProfile } from './ai/modelProtocol';
import { getRelayonVideoRecoveryProfiles } from './ai/providers/relayonModelManifest';
import { nativeProtocolTaskDigest, nativeProtocolQueryDigest } from './nativeModelProtocolTask';
import { sha256BytesHex } from './mediaDataUrl';
import { projectModelSourceToken } from './projectModelComparisonMaterial';

interface NativeRecoveryProtocolOptions {
  modelId: string;
  profile: ModelExecutionProfile | undefined;
  /** 仅真实万象视频连接允许读取已确认的新旧内置合同。 */
  catalogId?: string;
  protocolDigest: string;
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

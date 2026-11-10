/** 原生回执的新旧协议选择；不提交生成，也不读取用户配置。 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelExecutionProfile } from '../../src/types/aiTypes';
import { resolveNativeRecoveryProtocol } from '../../src/services/nativeProtocolRecovery';
import { RELAYON_MODEL_MANIFEST, getRelayonVideoRecoveryProfiles } from '../../src/services/ai/providers/relayonModelManifest';
import { resolveModelExecutionProfile } from '../../src/services/ai/modelProtocol';
import { resolvePoll } from '../../src/services/ai/modelProtocolPoll';
import { nativeProtocolTaskDigest, nativeProtocolQueryDigest, resolveNativeProtocolContext } from '../../src/services/nativeModelProtocolTask';
import { projectModelSourceToken } from '../../src/services/projectModelComparisonMaterial';
import { sha256BytesHex } from '../../src/services/mediaDataUrl';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

const modelId = 'sd-2.5-c1';
const currentProfile = RELAYON_MODEL_MANIFEST.find((model) => model.id === modelId)!.executionProfile!;
const current = resolveModelExecutionProfile(currentProfile)!;
const previousProfile = getRelayonVideoRecoveryProfiles(modelId, currentProfile).find((profile) => {
  const protocol = resolveModelExecutionProfile(profile)!;
  return protocol.poll!.response.result?.urlPath === 'url';
})!;
const previous = resolveModelExecutionProfile(previousProfile)!;

describe('原生回执按冻结摘要选择协议', () => {
  it.each([previousProfile, currentProfile])('原提交的 URL 合同不会被新版 /content 覆盖', async (profile) => {
    const protocol = await resolveNativeRecoveryProtocol({ modelId, profile, catalogId: 'relayonapi',
      protocolDigest: await nativeProtocolTaskDigest(modelId, previous),
      queryDigest: await nativeProtocolQueryDigest(modelId, previous) });
    expect(protocol).toEqual(previous);
    expect(protocol!.poll!.response.result).not.toHaveProperty('download');
    const poll = resolvePoll('https://relayonapi.com/v1', protocol!.poll!, protocol!.auth,
      resolveNativeProtocolContext(protocol!, 'original-task', { submit: { id: 'original-task' } }));
    expect(poll.url).toBe('https://relayonapi.com/v1/videos/original-task');
  });

  it('保存配置仍是旧模板时，新提交冻结的新版协议可以重启续查', async () => {
    const before = structuredClone(previousProfile);
    const protocol = await resolveNativeRecoveryProtocol({ modelId, profile: previousProfile, catalogId: 'relayonapi',
      protocolDigest: await nativeProtocolTaskDigest(modelId, current),
      queryDigest: await nativeProtocolQueryDigest(modelId, current) });
    expect(protocol).toEqual(current);
    expect(protocol!.poll!.response.result?.download?.path).toBe('/videos/{{submit.id}}/content');
    expect(previousProfile).toEqual(before);
  });

  it('自定义协议和其他渠道不能借官方新旧目录绕过原摘要', async () => {
    const custom = structuredClone(previousProfile);
    custom.protocol!.poll!.path += '?custom=true';
    const expected = { protocolDigest: await nativeProtocolTaskDigest(modelId, current),
      queryDigest: await nativeProtocolQueryDigest(modelId, current) };
    expect(await resolveNativeRecoveryProtocol({ modelId, profile: custom, catalogId: 'relayonapi', ...expected })).toBeUndefined();
    expect(await resolveNativeRecoveryProtocol({ modelId, profile: previousProfile, catalogId: 'custom-openai', ...expected })).toBeUndefined();
    expect(await resolveNativeRecoveryProtocol({ modelId: 'other-model', profile: currentProfile, catalogId: 'relayonapi', ...expected })).toBeUndefined();
  });

  it('普通媒体保留既有查询摘要兜底，剪辑仍要求完整协议摘要', async () => {
    const custom: ModelExecutionProfile = structuredClone(currentProfile);
    custom.protocol!.submit.body = { model: '{{model}}', prompt: '{{prompt}}' };
    const queryDigest = await nativeProtocolQueryDigest(modelId, current);
    const protocol = await resolveNativeRecoveryProtocol({ modelId, profile: custom,
      protocolDigest: await nativeProtocolTaskDigest(modelId, current), queryDigest });
    expect(protocol).toEqual(resolveModelExecutionProfile(custom));
    const editorDigest = await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(current)));
    expect(await resolveNativeRecoveryProtocol({ modelId, profile: custom,
      protocolDigest: editorDigest, queryDigest, digestKind: 'protocol', requireFullDigest: true })).toBeUndefined();
    expect(await resolveNativeRecoveryProtocol({ modelId, profile: previousProfile, catalogId: 'relayonapi',
      protocolDigest: editorDigest, queryDigest, digestKind: 'protocol', requireFullDigest: true })).toEqual(current);
  });
});

import type { ModelProtocolPresetId } from '../../types/aiTypes';

export type ProtocolChoice = ModelProtocolPresetId | 'legacy';

/**
 * 试跑的前置条件；返回 null 表示可以真发请求。
 * 「自动兼容」不走声明式协议，运行时直接调标准端点，没有协议可跑。
 */
export function describeProtocolTestRunBlocker(
  preset: ProtocolChoice,
  apiKey: string,
  baseUrl: string,
): 'legacy-preset' | 'missing-base-url' | 'missing-api-key' | null {
  if (preset === 'legacy') return 'legacy-preset';
  if (!baseUrl.trim()) return 'missing-base-url';
  if (!apiKey.trim()) return 'missing-api-key';
  return null;
}

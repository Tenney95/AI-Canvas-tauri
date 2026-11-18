/** 模型插件预设的唯一运行入口；不向插件传递连接、凭据、消息或素材。 */
import type { ModelExecutionProfile } from '../../types/aiTypes';
import type { InstalledPlugin } from '../../types/plugin';
import { acquirePluginProtocolPreset, parsePluginProtocolReference } from '../plugins/pluginProtocolPresetService';
import { isChatApiProtocol } from './chatApiProtocol';

export async function resolvePluginModelProtocol(
  profile: ModelExecutionProfile,
  getPlugins: () => readonly InstalledPlugin[],
  controller: AbortController,
) {
  if (profile.preset !== 'plugin' || profile.protocol !== undefined) throw new Error('executionProfile.plugin：协议预设配置无效');
  const lease = await acquirePluginProtocolPreset(parsePluginProtocolReference(profile.plugin), getPlugins, controller);
  if (!isChatApiProtocol(lease.adapter)) { lease.release(); throw new Error('宿主不支持该插件的对话适配器'); }
  return lease;
}

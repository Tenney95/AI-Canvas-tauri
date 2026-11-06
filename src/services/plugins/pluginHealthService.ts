import { invoke, isTauri } from '@tauri-apps/api/core';
import type { InstalledPlugin, PluginHealthSnapshot, PluginRegistrationStatus, PythonPluginRuntimeStatus } from '../../types/plugin';
import { assertPluginCompatibility } from './pluginHost';
import { resolvePluginDependencies } from './pluginDependencyService';

/** 不返回原生错误原文，避免将平台路径写入诊断、工具结果或消息。 */
export async function inspectPluginHealth(plugin: InstalledPlugin, plugins: readonly InstalledPlugin[]): Promise<PluginHealthSnapshot> {
  const result: PluginHealthSnapshot = { pluginId: plugin.id, configuredEnabled: plugin.enabled,
    nativeEnabled: false, state: 'unavailable', reasons: [], activeRevision: null, snapshotVerified: false };
  try { assertPluginCompatibility(plugin.manifest); } catch { result.reasons.push('宿主版本或能力不兼容'); }
  const dependencies = resolvePluginDependencies(plugins, plugin.id);
  if (plugin.enabled && !dependencies.ready) result.reasons.push('必需依赖未满足或存在循环');
  if (!plugin.sourceDigest || !plugin.revisionDigest) result.reasons.push('安装记录缺少双摘要');
  if (!isTauri()) { result.reasons = [...new Set([...result.reasons.slice(0, 11), '健康诊断需要 Tauri 桌面端'])]; return result; }
  try {
    const status = await invoke<PluginRegistrationStatus>('get_plugin_registration_status', { pluginId: plugin.id });
    if (!status || status.pluginId !== plugin.id || typeof status.exists !== 'boolean') throw new Error('invalid');
    result.nativeEnabled = status.enabled === true;
    result.activeRevision = typeof status.activeRevisionDigest === 'string' && /^[a-f0-9]{64}$/u.test(status.activeRevisionDigest)
      ? status.activeRevisionDigest : null;
    result.snapshotVerified = status.snapshotVerified === true;
    if (!status.exists) { result.state = 'missing'; result.reasons.push('缺少原生注册'); }
    else if (status.activeSourceDigest !== plugin.sourceDigest || status.activeRevisionDigest !== plugin.revisionDigest) {
      result.state = 'invalid'; result.reasons.push('安装记录与原生活动版本不一致');
    } else if (status.healthCode === 'invalid' || !result.snapshotVerified) {
      result.state = 'invalid'; result.reasons.push('私有快照缺失、损坏或未获授权');
    } else if (status.healthCode === 'blocked' || (plugin.enabled && result.reasons.length)) {
      result.state = 'blocked'; result.reasons.push('执行前置条件未满足');
    } else if (!plugin.enabled || !status.enabled) {
      result.state = 'disabled';
      if (plugin.enabled !== status.enabled) result.reasons.push('配置与原生启用状态不一致');
    } else result.state = 'ready';
    if (result.state === 'ready' && plugin.manifest.runtime === 'python') {
      // 复用现有环境状态探测；不执行插件源码，不返回 executable 或原生 error 原文。
      try {
        const runtime = await invoke<PythonPluginRuntimeStatus>('get_python_plugin_runtime_status');
        if (runtime?.available !== true) { result.state = 'blocked'; result.reasons.push('Python 运行环境不可用'); }
      } catch { result.state = 'blocked'; result.reasons.push('Python 运行环境未确认'); }
    }
  } catch { result.state = 'unavailable'; result.reasons.push('未能确认原生注册状态'); }
  result.reasons = [...new Set(result.reasons)].slice(0, 12);
  return result;
}

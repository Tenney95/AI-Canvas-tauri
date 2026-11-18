/** 协议预设只绑定宿主适配器；原生活动快照是执行权威，不执行插件脚本。 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { InstalledPlugin, PluginModelProtocolManifest, PluginModelProtocolReference, PluginRegistrationStatus } from '../../types/plugin';
import { assertPluginCompatibility } from './pluginHost';
import { parsePluginModelProtocols } from './pluginManifest';
import { resolvePluginDependencies } from './pluginDependencyService';

export interface PluginProtocolPresetEntry extends PluginModelProtocolReference {
  name: string;
  pluginName: string;
  available: boolean;
  reason?: string;
}

const leases = new Map<string, Set<AbortController>>();
const epochs = new Map<string, number>();

/** 安装事务先撤销租约；失败回滚只恢复后续调用，不能复活旧请求。 */
export function revokePluginProtocolPresets(pluginId?: string): void {
  const ids = pluginId ? [pluginId] : [...new Set([...epochs.keys(), ...leases.keys()])];
  for (const id of ids) {
    epochs.set(id, (epochs.get(id) ?? 0) + 1);
    for (const controller of leases.get(id) ?? []) controller.abort();
    leases.delete(id);
  }
}

export function parsePluginProtocolReference(value: unknown): PluginModelProtocolReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('executionProfile.plugin：缺少插件预设引用');
  const ref = value as Record<string, unknown>;
  if (Object.keys(ref).some((key) => !['pluginId', 'presetId'].includes(key))
    || typeof ref.pluginId !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/u.test(ref.pluginId)
    || typeof ref.presetId !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(ref.presetId)) {
    throw new Error('executionProfile.plugin：插件或预设 ID 无效');
  }
  return { pluginId: ref.pluginId, presetId: ref.presetId };
}

function installedReference(ref: PluginModelProtocolReference, plugins: readonly InstalledPlugin[]) {
  const plugin = plugins.find((item) => item.id === ref.pluginId);
  if (!plugin) throw new Error('协议插件未安装，请安装对应插件或更换协议预设');
  if (!plugin.enabled) throw new Error('协议插件未启用，请在插件设置中启用');
  assertPluginCompatibility(plugin.manifest);
  if (plugin.manifest.apiVersion !== 2 || !plugin.manifest.requiredCapabilities?.includes('model.protocolPresets')) {
    throw new Error('协议插件缺少宿主能力声明，请重新安装');
  }
  if (!plugin.sourceDigest || !plugin.revisionDigest) throw new Error('协议插件缺少注册摘要，请重新安装');
  const dependencies = resolvePluginDependencies(plugins, plugin.id);
  if (!dependencies.ready) throw new Error('协议插件的必需依赖不可用');
  const declarations = parsePluginModelProtocols(plugin.manifest.contributes.modelProtocols);
  if (!declarations.some((item) => item.id === ref.presetId)) throw new Error('协议插件未提供所选预设，请更换协议预设');
  return { plugin, dependencies, declarations };
}

/** 不回显原生异常，避免泄漏私有快照路径；不将前端清单当作执行依据。 */
export async function verifyPluginProtocolPreset(ref: PluginModelProtocolReference, plugins: readonly InstalledPlugin[]) {
  const { plugin, dependencies, declarations } = installedReference(ref, plugins);
  if (!isTauri()) throw new Error('协议插件需要 Tauri 桌面端核验');
  let status: PluginRegistrationStatus;
  try { status = await invoke<PluginRegistrationStatus>('get_plugin_registration_status', { pluginId: plugin.id }); }
  catch (error) { throw new Error('未能确认协议插件的原生注册状态', { cause: error }); }
  if (status?.pluginId !== plugin.id || status.exists !== true || status.enabled !== true
    || status.snapshotVerified !== true || status.healthCode !== 'ready'
    || status.activeSourceDigest !== plugin.sourceDigest || status.activeRevisionDigest !== plugin.revisionDigest
    || typeof status.dependencyFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(status.dependencyFingerprint)) {
    throw new Error('协议插件的活动版本不可用，请刷新插件健康状态');
  }
  const native = parsePluginModelProtocols(status.modelProtocols);
  if (JSON.stringify(native) !== JSON.stringify(declarations)) throw new Error('协议插件声明与原生快照不一致，请重新安装');
  const preset = native.find((item) => item.id === ref.presetId);
  if (!preset) throw new Error('原生活动版本未提供所选协议预设');
  return { preset, sourceDigest: plugin.sourceDigest, revisionDigest: plugin.revisionDigest,
    fingerprint: dependencies.fingerprint, nativeFingerprint: status.dependencyFingerprint };
}

export async function listPluginProtocolPresets(plugins: readonly InstalledPlugin[]): Promise<PluginProtocolPresetEntry[]> {
  const entries = await Promise.all(plugins.slice(0, 512).map(async (plugin) => {
    let declarations: PluginModelProtocolManifest[];
    try { declarations = parsePluginModelProtocols(plugin.manifest.contributes.modelProtocols); } catch { return []; }
    if (!declarations.length) return [];
    let reason: string | undefined;
    try { await verifyPluginProtocolPreset({ pluginId: plugin.id, presetId: declarations[0].id }, plugins); }
    catch (error) { reason = error instanceof Error ? error.message : '协议插件不可用'; }
    return declarations.map((preset) => ({ pluginId: plugin.id, presetId: preset.id, name: preset.name,
      pluginName: plugin.manifest.name, available: reason === undefined, ...(reason ? { reason } : {}) }));
  }));
  return entries.flat().sort((a, b) => a.name.localeCompare(b.name) || a.pluginId.localeCompare(b.pluginId) || a.presetId.localeCompare(b.presetId));
}

export interface PluginProtocolLease {
  adapter: PluginModelProtocolManifest['adapter'];
  signal: AbortSignal;
  assertActive: () => void;
  assertCurrent: () => Promise<void>;
  release: () => void;
}

/** 请求前及结果交付前均重读原生状态；每个工具轮次重新获取租约。 */
export async function acquirePluginProtocolPreset(
  reference: PluginModelProtocolReference,
  getPlugins: () => readonly InstalledPlugin[],
  controller: AbortController,
): Promise<PluginProtocolLease> {
  const ref = parsePluginProtocolReference(reference);
  const epoch = epochs.get(ref.pluginId) ?? 0;
  epochs.set(ref.pluginId, epoch);
  const active = leases.get(ref.pluginId) ?? new Set<AbortController>();
  active.add(controller);
  leases.set(ref.pluginId, active);
  const release = () => { active.delete(controller); if (!active.size && leases.get(ref.pluginId) === active) leases.delete(ref.pluginId); };
  try {
    controller.signal.throwIfAborted();
    const initial = await verifyPluginProtocolPreset(ref, getPlugins());
    const assertActive = () => {
      controller.signal.throwIfAborted();
      try {
        const current = installedReference(ref, getPlugins());
        if ((epochs.get(ref.pluginId) ?? 0) !== epoch || current.plugin.sourceDigest !== initial.sourceDigest
          || current.plugin.revisionDigest !== initial.revisionDigest || current.dependencies.fingerprint !== initial.fingerprint) {
          throw new Error('协议插件已变化，本轮调用已取消');
        }
      } catch (error) {
        controller.abort();
        throw error;
      }
    };
    assertActive();
    return { adapter: initial.preset.adapter, signal: controller.signal, assertActive, release,
      assertCurrent: async () => {
        assertActive();
        try {
          const current = await verifyPluginProtocolPreset(ref, getPlugins());
          assertActive();
          if (current.nativeFingerprint !== initial.nativeFingerprint || current.preset.adapter !== initial.preset.adapter) {
            throw new Error('协议插件的原生活动版本已变化，本轮调用已取消');
          }
        } catch (error) {
          controller.abort();
          throw error;
        }
      } };
  } catch (error) { release(); throw error; }
}

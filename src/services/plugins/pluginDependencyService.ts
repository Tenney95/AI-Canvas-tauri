/** 有界依赖解析；仅计算执行前置条件，不安装、启用或执行插件。 */
import type { InstalledPlugin, PluginDependency } from '../../types/plugin';

const STABLE_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u;
export function compareDependencyVersions(left: string, right: string): number {
  if (!STABLE_VERSION.test(left) || !STABLE_VERSION.test(right)) throw new Error('依赖版本必须为稳定 x.y.z');
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  if ([...a, ...b].some((part) => !Number.isSafeInteger(part))) throw new Error('依赖版本超出范围');
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function parsePluginDependencies(value: unknown, pluginId: string): PluginDependency[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16) throw new Error('dependencies 最多允许 16 项');
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('依赖声明必须是对象');
    const raw = item as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !['pluginId', 'minVersion', 'optional'].includes(key))) throw new Error('依赖包含未知字段');
    const id = raw.pluginId;
    if (typeof id !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/u.test(id)
      || id === pluginId || seen.has(id)) throw new Error('插件依赖 ID 无效、重复或引用自身');
    seen.add(id);
    if (raw.minVersion !== undefined) {
      if (typeof raw.minVersion !== 'string') throw new Error('依赖版本必须是字符串');
      compareDependencyVersions(raw.minVersion, raw.minVersion);
    }
    if (raw.optional !== undefined && typeof raw.optional !== 'boolean') throw new Error('optional 必须是布尔值');
    return { pluginId: id, ...(raw.minVersion === undefined ? {} : { minVersion: raw.minVersion as string }),
      ...(raw.optional === undefined ? {} : { optional: raw.optional as boolean }) };
  });
}

export interface PluginDependencyResolution {
  ready: boolean;
  reasons: string[];
  warnings: string[];
  /** 包括可用的可选依赖；任何已解析 revision 变更都会使当前租约失效。 */
  fingerprint: string;
}

export function resolvePluginDependencies(plugins: readonly InstalledPlugin[], pluginId: string): PluginDependencyResolution {
  const index = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const reasons: string[] = [];
  const warnings: string[] = [];
  const identities = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string, stack: string[], optional: boolean): void => {
    const problems = optional ? warnings : reasons;
    if (stack.includes(id) || stack.length >= 32) { reasons.push('插件依赖存在循环或深度超限'); return; }
    const visitKey = `${optional}:${id}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    const plugin = index.get(id);
    if (!plugin?.enabled || !plugin.sourceDigest || !plugin.revisionDigest) {
      problems.push(`依赖不可用：${id}`); return;
    }
    identities.add(`${id}:${plugin.sourceDigest}:${plugin.revisionDigest}`);
    for (const dependency of plugin.manifest.dependencies ?? []) {
      const soft = optional || dependency.optional === true;
      const target = index.get(dependency.pluginId);
      try {
        if (dependency.minVersion && target && compareDependencyVersions(target.manifest.version, dependency.minVersion) < 0) {
          (soft ? warnings : reasons).push(`依赖版本不足：${dependency.pluginId}`); continue;
        }
      } catch { (soft ? warnings : reasons).push(`依赖版本无效：${dependency.pluginId}`); continue; }
      walk(dependency.pluginId, [...stack, id], soft);
    }
  };
  walk(pluginId, [], false);
  return { ready: reasons.length === 0, reasons: [...new Set(reasons)], warnings: [...new Set(warnings)],
    fingerprint: [...identities].sort().join('|') };
}

export function affectedPluginIds(plugins: readonly InstalledPlugin[], changedId: string): string[] {
  const affected = new Set([changedId]);
  for (let previous = -1; previous !== affected.size;) {
    previous = affected.size;
    for (const plugin of plugins) if (plugin.manifest.dependencies?.some((dependency) => affected.has(dependency.pluginId))) affected.add(plugin.id);
  }
  return [...affected];
}

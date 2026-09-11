/** 普通配置的三方比较。补丁仅在内存和事务间传递，不写日志或保存状态元数据。 */
export interface ConfigChange {
  path: string[];
  before: unknown;
  after: unknown;
}

export class ConfigConflictError extends Error {
  readonly code = 'conflict';
  constructor() {
    super('设置已被其他窗口修改，请重新加载后再保存');
    this.name = 'ConfigConflictError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function configValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => configValuesEqual(v, b[i]));
  if (!record(a) || !record(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => configValuesEqual(a[key], b[key]));
}

export function configWithoutSecrets(value: unknown): Record<string, unknown> {
  const copy = structuredClone(record(value) ? value : {});
  if (record(copy.providers)) {
    for (const provider of Object.values(copy.providers)) {
      if (record(provider)) delete provider.apiKey;
    }
  }
  if (record(copy.dreaminaAuth)) delete copy.dreaminaAuth.cookie;
  if (Array.isArray(copy.generalModels)) {
    for (const model of copy.generalModels) if (record(model)) delete model.apiKey;
  }
  return copy;
}

export function createConfigPatch(before: unknown, after: unknown): ConfigChange[] {
  const changes: ConfigChange[] = [];
  const visit = (a: unknown, b: unknown, path: string[]) => {
    if (configValuesEqual(a, b)) return;
    if (record(a) && record(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) visit(a[key], b[key], [...path, key]);
    } else {
      changes.push({ path, before: structuredClone(a), after: structuredClone(b) });
    }
  };
  visit(before ?? {}, after ?? {}, []);
  return changes;
}

/** strict=false 仅用于把保存期间的新编辑重放到已保存基线上，不能用于数据库提交。 */
export function applyConfigPatch(current: unknown, changes: ConfigChange[], strict = true): Record<string, unknown> {
  const next = structuredClone(record(current) ? current : {});
  for (const change of changes) {
    if (!change.path.length || change.path.some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))) {
      throw new Error('配置字段无效');
    }
    let parent = next;
    for (const key of change.path.slice(0, -1)) {
      if (!record(parent[key])) {
        if (strict) throw new ConfigConflictError();
        parent[key] = {};
      }
      parent = parent[key] as Record<string, unknown>;
    }
    const key = change.path.at(-1)!;
    if (strict && !configValuesEqual(parent[key], change.before) && !configValuesEqual(parent[key], change.after)) {
      throw new ConfigConflictError();
    }
    if (change.after === undefined) delete parent[key];
    else parent[key] = structuredClone(change.after);
  }
  return next;
}

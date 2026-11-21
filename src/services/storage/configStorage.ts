import { enqueueConfigPersistence } from '../configPersistenceQueue';
import { applyConfigPatch, ConfigConflictError, configValuesEqual, configWithoutSecrets, createConfigPatch, type ConfigChange } from '../configPatch';
import { isTauriEnv } from '../fs/core';
import { loadConfigFromDb, patchConfigToDb, saveConfigToDb } from '../indexedDbService';
import { deleteProviderSecretIfUnchanged, hasPlaintextSecret, readProviderSecretFingerprint, restoreConfigSecrets, stripConfigSecrets } from '../providerSecretService';
import { classifyStorageError, readStorageWithRetry } from '../storageDiagnostics';

/**
 * 保存应用配置到 IndexedDB。
 * 凭据先摘进 Rust 侧凭据存储，数据库里只留引用；存储失败也不落明文。
 * 桌面凭据保存失败时拒绝整份配置回写，保留原数据库记录。
 * @returns 未能写入凭据存储、仅本次会话有效的连接 ID
 */
export interface ConfigSaveOptions {
  baseline: unknown;
  changes: ConfigChange[];
  /** 连接 ID → 本次凭据变更的随机版本，只在明确编辑凭据时提供。 */
  secretChanges?: Record<string, string>;
  onCommitted?: (config: unknown) => void;
}

export class ConfigCleanupError extends Error {
  constructor() { super('设置已保存，但旧渠道凭据清理失败，请重试'); this.name = 'ConfigCleanupError'; }
}

/**
 * 删除整条连接时，凭据版本可能刚被同一应用的另一保存任务推进。
 * 版本只用于防止旧 Key 回写，不属于用户可编辑配置；普通字段一致时以最新版本为删除基线。
 */
function rebaseDeletedProviderRevisions(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const baselineProviders = baseline.providers;
  const currentProviders = current.providers;
  const nextProviders = next.providers;
  if (!baselineProviders || typeof baselineProviders !== 'object' || Array.isArray(baselineProviders)
    || !currentProviders || typeof currentProviders !== 'object' || Array.isArray(currentProviders)
    || !nextProviders || typeof nextProviders !== 'object' || Array.isArray(nextProviders)) return baseline;

  let rebased: Record<string, unknown> | undefined;
  const providers = baselineProviders as Record<string, unknown>;
  for (const [id, originalProvider] of Object.entries(providers)) {
    if (id in nextProviders) continue;
    const currentProvider = (currentProviders as Record<string, unknown>)[id];
    if (!originalProvider || typeof originalProvider !== 'object' || Array.isArray(originalProvider)
      || !currentProvider || typeof currentProvider !== 'object' || Array.isArray(currentProvider)) continue;
    const { apiKeyRevision: _originalRevision, ...originalOrdinary } = originalProvider as Record<string, unknown>;
    const { apiKeyRevision: _currentRevision, ...currentOrdinary } = currentProvider as Record<string, unknown>;
    if (!configValuesEqual(originalOrdinary, currentOrdinary)) continue;
    rebased ??= structuredClone(baseline);
    (rebased.providers as Record<string, unknown>)[id] = structuredClone(currentProvider);
  }
  return rebased ?? baseline;
}

function configItemIdentity(item: unknown): string | null {
  if (typeof item === 'string') return `string:${item}`;
  if (typeof item === 'number' && Number.isFinite(item)) return `number:${item}`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = Reflect.get(item, 'id');
  return typeof id === 'string' && id ? `id:${id}` : null;
}

function identifiedItems(value: unknown): Map<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const items = new Map<string, unknown>();
  for (const item of value) {
    const identity = configItemIdentity(item);
    if (identity === null || items.has(identity)) return null;
    items.set(identity, item);
  }
  return items;
}

function configValueAtPath(root: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = root;
  for (const key of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = Reflect.get(value, key);
  }
  return value;
}

/**
 * 带稳定身份的配置列表允许合并纯删除：删除目标以调用时基线为准，
 * 同时发生的其他条目编辑和新增从最新持久化值保留。
 */
function rebaseIdentifiedArrayRemovals(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  changes: ConfigChange[],
): { baseline: Record<string, unknown>; next: Record<string, unknown> } {
  let rebasedBaseline = baseline;
  let rebasedNext = next;
  for (const change of changes) {
    const beforeItems = identifiedItems(change.before);
    const afterItems = identifiedItems(change.after);
    if (!beforeItems || !afterItems || beforeItems.size <= afterItems.size) continue;
    const beforeOrder = [...beforeItems.keys()];
    let previousIndex = -1;
    const pureRemoval = [...afterItems].every(([id, item]) => {
      const index = beforeOrder.indexOf(id);
      if (index <= previousIndex || !configValuesEqual(beforeItems.get(id), item)) return false;
      previousIndex = index;
      return true;
    });
    if (!pureRemoval) continue;
    const currentValue = configValueAtPath(current, change.path);
    const currentItems = identifiedItems(currentValue);
    if (!currentItems) continue;
    const removedIds = new Set([...beforeItems.keys()].filter((id) => !afterItems.has(id)));
    const merged = (currentValue as unknown[]).filter((item) => {
      const identity = configItemIdentity(item);
      return identity !== null && !removedIds.has(identity);
    });
    rebasedBaseline = applyConfigPatch(rebasedBaseline, [{
      path: change.path,
      before: configValueAtPath(rebasedBaseline, change.path),
      after: currentValue,
    }], false);
    rebasedNext = applyConfigPatch(rebasedNext, [{
      path: change.path,
      before: configValueAtPath(rebasedNext, change.path),
      after: merged,
    }], false);
  }
  return { baseline: rebasedBaseline, next: rebasedNext };
}

/** 与连接删除同事务持久化；仅含指纹，重启后仍可完成清理。必须在配置队列内调用。 */
async function completeSecretCleanup(raw: unknown): Promise<unknown> {
  const config = raw as { providers?: Record<string, unknown>; _pendingSecretCleanup?: Record<string, string> } | null;
  const pending = config?._pendingSecretCleanup;
  if (pending === undefined) return raw;
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) throw new ConfigCleanupError();
  let committed = raw;
  for (const [id, fingerprint] of Object.entries(pending)) {
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) throw new ConfigCleanupError();
    try {
      // 已重新出现的连接不能作为旧删除任务清理；条件删除也不能删掉已换值的条目。
      if (!config?.providers?.[id]) await deleteProviderSecretIfUnchanged(id, fingerprint);
      committed = await patchConfigToDb([{ path: ['_pendingSecretCleanup', id], before: fingerprint, after: undefined }]);
    } catch (error) {
      if (classifyStorageError(error) === 'conflict') {
        // 原生值已变化，旧清理意图作废，保留新凭据。
        committed = await patchConfigToDb([{ path: ['_pendingSecretCleanup', id], before: fingerprint, after: undefined }]);
      } else { throw new ConfigCleanupError(); }
    }
  }
  return committed;
}

export async function saveConfig(data: unknown, options?: ConfigSaveOptions): Promise<string[]> {
  try {
    // 入队前捕获快照，异步凭据操作期间调用方修改对象不能改变本次保存内容。
    const snapshot: unknown = structuredClone(data);
    const intent = options ? structuredClone({ baseline: options.baseline, changes: options.changes, secretChanges: options.secretChanges }) : undefined;
    return await enqueueConfigPersistence(async () => {
      // 先读已保存记录，确认既有引用；读取失败时不触碰任何凭据。
      const previous = await completeSecretCleanup(await readStorageWithRetry('config-read', loadConfigFromDb));
      if (intent) {
        let baseline = configWithoutSecrets(intent.baseline);
        let next = applyConfigPatch(baseline, intent.changes, false);
        const sourceProviders = (snapshot as { providers?: Record<string, Record<string, unknown>> })?.providers ?? {};
        const providers = (next.providers ?? {}) as Record<string, Record<string, unknown>>;
        const changedProviders: Record<string, Record<string, unknown>> = {};
        for (const [id, revision] of Object.entries(intent.secretChanges ?? {})) {
          const provider = sourceProviders[id];
          if (!provider || typeof provider.apiKey !== 'string' || !provider.apiKey) continue;
          providers[id] = { ...providers[id], apiKeyRevision: revision };
          changedProviders[id] = provider;
        }
        if (next.providers || Object.keys(changedProviders).length) next.providers = providers;
        const current = configWithoutSecrets(previous);
        ({ baseline, next } = rebaseIdentifiedArrayRemovals(
          baseline,
          current,
          next,
          intent.changes,
        ));
        baseline = rebaseDeletedProviderRevisions(baseline, current, next);
        // 先检查普通字段与凭据版本冲突，拒绝后不触碰原生凭据。
        applyConfigPatch(current, createConfigPatch(baseline, next));
        const deleted = Object.keys((baseline.providers ?? {}) as Record<string, unknown>).filter((id) => !providers[id]);
        const cleanup: Record<string, string> = {};
        for (const id of deleted) {
          const fingerprint = await readProviderSecretFingerprint(id);
          if (fingerprint) cleanup[id] = fingerprint;
        }
        if (Object.keys(cleanup).length) next._pendingSecretCleanup = cleanup;
        let unstored: string[] = [];
        if (Object.keys(changedProviders).length) {
          const result = await stripConfigSecrets({ providers: changedProviders }, previous);
          unstored = result.unstored;
          if (result.failedExistingSecrets.length || (isTauriEnv() && unstored.length)) throw new Error('渠道凭据保存未完成');
          const storedProviders = (result.config as { providers: Record<string, Record<string, unknown>> }).providers;
          for (const [id, provider] of Object.entries(storedProviders)) {
            if (provider.apiKeyRef) providers[id].apiKeyRef = provider.apiKeyRef;
          }
          next = configWithoutSecrets(next);
        }
        const committed = await patchConfigToDb(createConfigPatch(baseline, next));
        options?.onCommitted?.(committed);
        const cleaned = await completeSecretCleanup(committed);
        options?.onCommitted?.(cleaned);
        return unstored;
      }
      const { config, unstored, failedExistingSecrets } = await stripConfigSecrets(snapshot, previous);
      if (failedExistingSecrets.length > 0) throw new Error('既有配置凭据保存未完成');
      // 桌面新渠道也必须确认 Key 已持久化，不能降级为重启后丢 Key 的会话配置。
      if (isTauriEnv() && unstored.length > 0) throw new Error('渠道凭据保存未完成');
      await saveConfigToDb(config);
      console.log('Config saved to IndexedDB');
      return unstored;
    });
  } catch (error) {
    if (error instanceof ConfigCleanupError) throw error;
    if (error instanceof ConfigConflictError || classifyStorageError(error) === 'conflict') throw new ConfigConflictError();
    console.error('[storage] 配置保存失败，未确认配置持久化');
    // eslint-disable-next-line preserve-caught-error -- 原始存储错误可能包含凭据或路径。
    throw new Error('保存应用配置失败，请重试或检查存储状态');
  }
}

export interface LoadedConfig {
  config: unknown | null;
  /** 引用存在但凭据存储里读不到的连接 ID，需要用户重新输入 */
  missingSecrets: string[];
  /** 只有凭据读取失败；普通配置已经读到，允许无关设置继续保存。 */
  unreadSecrets?: string[];
  persistedConfig?: unknown;
  cleanupPending?: boolean;
}

/** 保留版本不兼容分类供启动层提示，不传播存储路径或原始错误正文。 */
function configLoadError(error: unknown): Error {
  const failure = new Error('读取应用配置失败，请重试或检查存储状态');
  if (classifyStorageError(error) === 'version') failure.name = 'VersionError';
  console.error('[storage] 配置加载失败:', failure.name);
  return failure;
}

/**
 * 从 IndexedDB 加载应用配置，并按引用从凭据存储补回凭据。
 * 遇到旧版明文或丢失的凭据引用会恢复并立刻回写不含明文的记录。
 * 只有配置记录不存在才返回 null；读取或迁移失败必须阻止上层保存默认配置。
 */
export async function loadConfigWithSecrets(options?: {
  allowSecretReadFailure?: boolean;
  /** 旧模型到渠道的纯转换必须在凭据迁移和数据库清理之前执行。 */
  normalize?: (config: unknown) => unknown;
}): Promise<LoadedConfig> {
  try {
    return await enqueueConfigPersistence(async () => {
      const stored = await readStorageWithRetry('config-read', loadConfigFromDb);
      let raw = stored;
      let cleanupPending = false;
      try { raw = await completeSecretCleanup(stored); }
      catch (error) {
        if (!options?.allowSecretReadFailure || !(error instanceof ConfigCleanupError)) throw error;
        // 删除已提交但后续清理失败，不影响已有普通设置的读取；由 Store 提供重试状态。
        cleanupPending = true;
      }
      if (raw === null || raw === undefined) return { config: null, missingSecrets: [] };
      const normalized = options?.normalize ? options.normalize(structuredClone(raw)) : raw;
      const normalizationChanged = createConfigPatch(raw, normalized).length > 0;
      const legacyModels = (raw as { generalModels?: Array<{ apiKey?: unknown }> }).generalModels;
      const hasLegacyKey = Array.isArray(legacyModels) && legacyModels.some((model) => !!model?.apiKey);

      if (options?.allowSecretReadFailure && !hasPlaintextSecret(normalized)
        && !hasPlaintextSecret(raw) && !hasLegacyKey) {
        const config = structuredClone(normalized) as { providers?: Record<string, unknown> };
        const providers = config.providers ?? {};
        const unreadSecrets: string[] = [];
        const missingSecrets: string[] = [];
        for (const [id, provider] of Object.entries(providers)) {
          try {
            const restored = await restoreConfigSecrets({ providers: { [id]: provider } });
            providers[id] = (restored.config as { providers: Record<string, unknown> }).providers[id];
            missingSecrets.push(...restored.missing);
          } catch { unreadSecrets.push(id); }
        }
        let persistedConfig: unknown = raw;
        // 空 Key 等旧字段也必须从实际记录中移除，否则整条连接删除时，
        // 数据库对象与不含凭据的比较基线不同，会被误判为并发修改。
        const migrationChanges = createConfigPatch(raw, configWithoutSecrets(config));
        if (migrationChanges.length) {
          persistedConfig = await patchConfigToDb(migrationChanges);
        }
        return { config, persistedConfig, missingSecrets, unreadSecrets, ...(cleanupPending ? { cleanupPending } : {}) };
      }

      const { config, migrated, missing } = await restoreConfigSecrets(normalized);
      // 旧凭据全部迁移失败时不能开放保存，否则后续保存可能清掉尚未迁出的唯一副本。
      if (hasPlaintextSecret(normalized) && !migrated) throw new Error('配置凭据迁移未完成');
      if (migrated || normalizationChanged) {
        // 在同一持久化锁内确认凭据可用，再清理数据库中的旧明文。
        const { config: scrubbed, unstored } = await stripConfigSecrets(config, raw);
        if (unstored.length > 0) throw new Error('配置凭据迁移未完成');
        await saveConfigToDb(scrubbed);
        console.log('[storage] 已更新配置中的凭据引用并清理明文字段');
      }
      return { config, missingSecrets: missing,
        ...(cleanupPending ? { cleanupPending } : {}),
        ...(options?.allowSecretReadFailure ? { persistedConfig: configWithoutSecrets(config) } : {}) };
    });
  } catch (error) {
    throw configLoadError(error);
  }
}

/** 从 IndexedDB 加载应用配置（凭据已补回）。 */
export async function loadConfig(): Promise<unknown | null> {
  return (await loadConfigWithSecrets()).config;
}

/**
 * 只读取配置本体，不触碰凭据存储。
 * 供只关心主题、窗口尺寸这类非凭据字段的早期启动路径使用，省掉无谓的凭据读取。
 */
export async function loadConfigWithoutSecrets(): Promise<unknown | null> {
  try {
    const raw = await readStorageWithRetry('config-read', loadConfigFromDb);
    return raw == null ? null : configWithoutSecrets(raw);
  } catch (error) {
    throw configLoadError(error);
  }
}

/**
 * 厂商凭据存储 —— API Key 只进 Rust 侧的凭据存储，配置里只留条目引用。
 *
 * 以前整份 config（含 providers[*].apiKey 明文）直接写进 IndexedDB：拿到 Renderer
 * 执行权的代码可以整库读走，磁盘与备份里也留有明文。现在持久化前把凭据摘出去交给
 * Rust 保管（文件在 fs scope / asset scope / path_policy 三条路径上都被拒绝，Renderer
 * 只能按条目名逐条索取），读取时再按引用补回内存，所有既有
 * `config.providers[x].apiKey` 消费方不变。
 *
 * 不变量：**任何情况下都不把明文凭据写回 IndexedDB**。凭据存储不可用时（浏览器环境
 * 等无 Rust 侧的场景）凭据仅本次会话有效，由调用方提示用户重新输入。
 */
import { isTauriEnv } from './fs/core';
import { invoke } from '@tauri-apps/api/core';
import { enqueueConfigPersistence } from './configPersistenceQueue';

/** 配置中代替明文凭据的引用前缀，便于识别与迁移。 */
const SECRET_REF_PREFIX = 'secret:';

export interface ProviderSecretEntry {
  name?: string;
  apiKey?: string;
  /** 凭据在凭据存储中的条目名；存在即表示明文不在配置里。 */
  apiKeyRef?: string;
  [key: string]: unknown;
}

interface ConfigShape {
  providers?: Record<string, ProviderSecretEntry>;
  dreaminaAuth?: { cookie?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface SecretPersistResult {
  /** 摘掉凭据、可安全写入 IndexedDB 的配置副本。 */
  config: unknown;
  /** 未能写入凭据存储的连接 ID：其凭据仅本次会话有效。 */
  unstored: string[];
  /** 既有引用或已持久化的旧凭据未能更新，调用方必须保留原配置记录。 */
  failedExistingSecrets: string[];
}

export interface SecretRestoreResult {
  config: unknown;
  /** 已迁移旧明文或补回丢失的引用，调用方需要回写不含明文的配置。 */
  migrated: boolean;
  /** 引用存在但凭据存储里读不到的连接 ID：需要用户重新输入。 */
  missing: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asConfig(value: unknown): ConfigShape | null {
  return isRecord(value) ? (value as ConfigShape) : null;
}

/**
 * 连接 ID → 凭据存储条目名。
 * 字符集与 `..` 限制都要和 Rust 侧 validate_key 对齐，否则生成的引用会被拒收。
 */
export function providerSecretRef(connectionId: string): string {
  const safeId = connectionId
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_');
  return `${SECRET_REF_PREFIX}provider/${safeId}`;
}

function refToKey(ref: string): string | null {
  return ref.startsWith(SECRET_REF_PREFIX) ? ref.slice(SECRET_REF_PREFIX.length) : null;
}

async function invokeSecret<T>(
  command: 'secret_set' | 'secret_get' | 'secret_delete',
  args: Record<string, unknown>,
): Promise<T> {
  return invoke<T>(command, args);
}

/** 凭据存储是否可用；不可用时凭据只能留在内存里。 */
export async function isSecretStoreAvailable(): Promise<boolean> {
  if (!isTauriEnv()) return false;
  try {
    return await invoke<boolean>('secret_store_available');
  } catch (error) {
    console.warn('[providerSecret] 凭据存储探测失败:', error);
    return false;
  }
}

async function writeSecret(ref: string, value: string): Promise<boolean> {
  const key = refToKey(ref);
  if (!key || !isTauriEnv()) return false;
  try {
    await invokeSecret<void>('secret_set', { key, value });
    return true;
  } catch (error) {
    console.warn('[providerSecret] 写入凭据存储失败:', ref, error);
    return false;
  }
}

/** 每次核对原生权威值；读取失败时不能覆盖未知凭据，不缓存明文。 */
async function writeProviderSecretIfChanged(ref: string, value: string): Promise<boolean> {
  const key = refToKey(ref);
  if (!key || !isTauriEnv()) return false;
  try {
    const current = await invokeSecret<string | null>('secret_get', { key });
    if (current === value) return true;
    if (current !== null && typeof current !== 'string') throw new Error('凭据读取结果无效');
    await invokeSecret<void>('secret_set', { key, value });
    return true;
  } catch {
    console.warn('[providerSecret] 凭据读取或写入失败，本次未确认持久化');
    return false;
  }
}

function existingProviderSecretRef(provider: unknown): string | undefined {
  if (!isRecord(provider) || typeof provider.apiKeyRef !== 'string') return undefined;
  const key = refToKey(provider.apiKeyRef);
  if (!key?.startsWith('provider/') || key.length > 120 || key.includes('..')) return undefined;
  return /^[A-Za-z0-9._/-]+$/.test(key) ? provider.apiKeyRef : undefined;
}

async function readSecret(ref: string): Promise<string | null> {
  const key = refToKey(ref);
  if (!key || !isTauriEnv()) return null;
  try {
    return await invokeSecret<string | null>('secret_get', { key }) ?? null;
  } catch (error) {
    console.warn('[providerSecret] 读取凭据存储失败:', ref, error);
    return null;
  }
}

/**
 * 通用凭据读写：条目名不带 `secret:` 前缀，供 provider 之外的凭据（如 MCP 固定令牌）复用。
 * 写入失败返回 false，调用方需要自行降级（凭据仅本次会话有效）。
 */
export async function writeAppSecret(key: string, value: string): Promise<boolean> {
  return writeSecret(`${SECRET_REF_PREFIX}${key}`, value);
}

export async function readAppSecret(key: string): Promise<string | null> {
  return readSecret(`${SECRET_REF_PREFIX}${key}`);
}

/** 删除某个连接的凭据（连接被移除时调用，避免凭据存储留下孤立条目）。 */
export async function deleteProviderSecret(connectionId: string): Promise<void> {
  try {
    await enqueueConfigPersistence(async () => {
      const key = refToKey(providerSecretRef(connectionId));
      if (!key || !isTauriEnv()) return;
      await invokeSecret<void>('secret_delete', { key });
    });
  } catch {
    console.warn('[providerSecret] 删除凭据存储条目失败');
  }
}

/** 渠道加载必须区分“条目不存在”和“读取失败”，失败不能把已保存的 Key 变为空值。 */
async function readProviderSecret(ref: string): Promise<string | null> {
  const key = refToKey(ref);
  if (!key || !isTauriEnv()) return null;
  try {
    const value = await invokeSecret<string | null>('secret_get', { key });
    if (value !== null && typeof value !== 'string') throw new Error('凭据读取结果无效');
    return value;
  } catch {
    // 不附带原始错误或 cause，避免凭据和本地路径进入日志或消息。
    throw new Error('渠道凭据读取失败，请重试或检查存储状态');
  }
}

/**
 * 持久化前摘除凭据：写入凭据存储并用引用替换明文。
 * 写入失败时同样不落明文；既有凭据失败额外阻止调用方覆盖原配置。
 */
export async function stripConfigSecrets(raw: unknown, previousConfig?: unknown): Promise<SecretPersistResult> {
  const config = asConfig(raw);
  if (!config) return { config: raw, unstored: [], failedExistingSecrets: [] };

  const providers = isRecord(config.providers) ? config.providers : undefined;
  const previous = asConfig(previousConfig);
  const previousProviders = isRecord(previous?.providers) ? previous.providers : undefined;
  const nextProviders: Record<string, ProviderSecretEntry> = {};
  const unstored: string[] = [];
  const failedExistingSecrets: string[] = [];

  for (const [connectionId, provider] of Object.entries(providers ?? {})) {
    if (!isRecord(provider)) {
      nextProviders[connectionId] = provider;
      continue;
    }
    const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey : '';
    const { apiKey: _omitted, ...rest } = provider;
    if (!apiKey) {
      // 编辑器或未恢复凭据的配置快照可能不含引用，必须从已保存记录补回。
      const previousProvider = previousProviders?.[connectionId];
      const previousRef = existingProviderSecretRef(previousProvider) ?? existingProviderSecretRef(provider);
      if (!previousRef && isRecord(previousProvider)
        && typeof previousProvider.apiKey === 'string' && previousProvider.apiKey.length > 0) {
        failedExistingSecrets.push(connectionId);
      }
      nextProviders[connectionId] = { ...rest, apiKey: '', ...(previousRef ? { apiKeyRef: previousRef } : {}) };
      continue;
    }

    const ref = providerSecretRef(connectionId);
    const stored = await writeProviderSecretIfChanged(ref, apiKey);
    if (stored) {
      nextProviders[connectionId] = { ...rest, apiKey: '', apiKeyRef: ref };
    } else {
      unstored.push(connectionId);
      const previousProvider = previousProviders?.[connectionId];
      const previousRef = existingProviderSecretRef(previousProvider) ?? existingProviderSecretRef(provider);
      const hadPersistedPlaintext = isRecord(previousProvider)
        && typeof previousProvider.apiKey === 'string' && previousProvider.apiKey.length > 0;
      if (previousRef || hadPersistedPlaintext) failedExistingSecrets.push(connectionId);
      const { apiKeyRef: _staleRef, ...withoutRef } = rest;
      nextProviders[connectionId] = {
        ...withoutRef,
        apiKey: '',
        ...(previousRef ? { apiKeyRef: previousRef } : {}),
      };
    }
  }

  const next: ConfigShape = { ...config };
  if (providers) next.providers = nextProviders;
  // 遗留的即梦 cookie 字段同属凭据且已无人读取，一并不再落盘
  if (isRecord(config.dreaminaAuth) && 'cookie' in config.dreaminaAuth) {
    const { cookie: _cookie, ...auth } = config.dreaminaAuth;
    next.dreaminaAuth = auth;
  }

  return { config: next, unstored, failedExistingSecrets };
}

/**
 * 读取后补回凭据。旧版配置里的明文会被迁进凭据存储并标记 migrated，
 * 由调用方立即回写一次清理后的配置，让明文尽快离开数据库。
 */
export async function restoreConfigSecrets(raw: unknown): Promise<SecretRestoreResult> {
  const config = asConfig(raw);
  if (!config || !isRecord(config.providers)) {
    return { config: raw, migrated: false, missing: [] };
  }

  const nextProviders: Record<string, ProviderSecretEntry> = {};
  const missing: string[] = [];
  let migrated = false;

  for (const [connectionId, provider] of Object.entries(config.providers)) {
    if (!isRecord(provider)) {
      nextProviders[connectionId] = provider;
      continue;
    }
    const plainKey = typeof provider.apiKey === 'string' ? provider.apiKey : '';
    const ref = typeof provider.apiKeyRef === 'string' ? provider.apiKeyRef : '';

    if (plainKey) {
      // 旧版明文配置：迁进凭据存储，内存里继续可用
      const storedRef = providerSecretRef(connectionId);
      const stored = await writeProviderSecretIfChanged(storedRef, plainKey);
      migrated = migrated || stored;
      nextProviders[connectionId] = stored
        ? { ...provider, apiKey: plainKey, apiKeyRef: storedRef }
        : { ...provider, apiKey: plainKey };
      continue;
    }

    // 旧保存路径可能丢掉引用；只查当前连接的固定条目，不枚举或借用其他渠道凭据。
    const restoredRef = ref || providerSecretRef(connectionId);
    const secret = await readProviderSecret(restoredRef);
    if (secret) {
      nextProviders[connectionId] = { ...provider, apiKey: secret, apiKeyRef: restoredRef };
      migrated = migrated || !ref;
    } else if (ref) {
      missing.push(connectionId);
      nextProviders[connectionId] = { ...provider, apiKey: '' };
    } else {
      nextProviders[connectionId] = provider;
    }
  }

  return { config: { ...config, providers: nextProviders }, migrated, missing };
}

/** 配置对象里是否仍存在明文凭据（用于自检与测试）。 */
export function hasPlaintextSecret(raw: unknown): boolean {
  const config = asConfig(raw);
  if (!config || !isRecord(config.providers)) return false;
  return Object.values(config.providers).some(
    (provider) => isRecord(provider) && typeof provider.apiKey === 'string' && provider.apiKey.length > 0,
  );
}

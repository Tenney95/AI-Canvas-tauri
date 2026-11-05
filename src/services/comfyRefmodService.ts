/**
 * comfyRefmodService — 读取 ComfyUI RefMod 目录与资源详情。
 */
import type {
  ComfyRefmodAsset,
  ComfyRefmodCatalog,
  ComfyRefmodLoaderSchema,
  ComfyRefmodLoaderType,
  ComfyRefmodServerIdentity,
  ComfyRefmodSlotSchema,
} from '../types/comfyRefmod';
import { comfyRefmodKey, isComfyRefmodFileName } from '../utils/comfyRefmod';
import { comfyFetch } from './comfyPolling';
import { resolveComfyServerSelection } from './comfyServers';
import { comfyComboOptions } from './comfyInputSpecs';

export { comfyRefmodKey } from '../utils/comfyRefmod';

const CATALOG_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 12_000;
const OPTIONAL_TIMEOUT_MS = 4_000;
const MAX_RESPONSE_LENGTH = 2 * 1024 * 1024;
const MAX_CATALOG_FILES = 20_000;
const FANTASTIC_CLASS = 'MiniMaxH3RefModStack';
const EMPTY_NAMES = new Set(['', '(none)', 'None']);

const ADAPTERS: ReadonlyArray<{
  loaderType: ComfyRefmodLoaderType;
  classType: string;
  label: string;
  description?: string;
}> = [
  { loaderType: 'minimax-h3', classType: 'MiniMaxH3RefModsLoader', label: 'MiniMax H3 RefMods' },
  {
    loaderType: 'refmods-lab',
    classType: 'H3RefModLabLoad',
    label: 'H3 RefMods Lab',
    description: 'Lab 使用独立参考包格式；参考强度沿用工作流中的 Combine 设置。',
  },
  { loaderType: 'h3-refmods', classType: 'H3RefModLoader', label: 'H3RefMods' },
];

const catalogCache = new Map<string, ComfyRefmodCatalog>();
const catalogDetailsCache = new Map<string, {
  metadata: ReturnType<typeof metadataByName>; warnings: string[]; fetchedAt: number;
}>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  // URL 的 host、默认端口等使用标准化结果，末尾斜线不改变服务器身份。
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

async function fingerprintEndpoint(baseUrl: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeEndpoint(baseUrl)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertEndpointCurrent(serverId: string | undefined, expected: string): void {
  try {
    if (normalizeEndpoint(resolveComfyServerSelection(serverId).baseUrl) === expected) return;
  } catch {
    // 删除服务也不能沿用之前捕获的地址。
  }
  throw new Error('ComfyUI 服务器配置已变化，请重新读取 RefMod 目录');
}

/** 不向资源元数据暴露服务器地址；地址变化会产生新的执行身份。 */
export async function resolveComfyRefmodServerIdentity(serverId?: string): Promise<ComfyRefmodServerIdentity> {
  const server = resolveComfyServerSelection(serverId);
  const expected = normalizeEndpoint(server.baseUrl);
  const endpointFingerprint = await fingerprintEndpoint(server.baseUrl);
  assertEndpointCurrent(serverId, expected);
  return {
    serverId: server.serverId,
    serverName: server.serverName,
    endpointFingerprint,
  };
}

async function readJson(baseUrl: string, route: string, signal: AbortSignal): Promise<unknown | undefined> {
  const response = await comfyFetch(`${baseUrl}${route}`, { signal, cache: 'no-store' });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`读取 RefMod 目录失败（HTTP ${response.status}）`);
  const text = await response.text();
  if (text.length > MAX_RESPONSE_LENGTH) throw new Error('RefMod 目录响应过大，请减少单个目录的条目数量');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('ComfyUI 返回了无效的 RefMod 目录');
  }
}

async function readOptionalJson(baseUrl: string, route: string, signal: AbortSignal): Promise<unknown | undefined> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = globalThis.setTimeout(abort, OPTIONAL_TIMEOUT_MS);
  try {
    return await readJson(baseUrl, route, controller.signal);
  } finally {
    globalThis.clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

function inputsFor(payload: unknown, classType: string): Record<string, unknown> | undefined {
  const input = record(record(record(payload)?.[classType])?.input);
  if (!input) return undefined;
  return { ...record(input.required), ...record(input.optional) };
}

function comboValues(input: unknown): string[] | undefined {
  const options = comfyComboOptions(input);
  if (!options) return undefined;
  if (options.length > MAX_CATALOG_FILES) throw new Error('RefMod 目录条目过多，请拆分目录后重试');
  return [...new Set(options.filter((value): value is string => (
    typeof value === 'string' && (EMPTY_NAMES.has(value) || isComfyRefmodFileName(value))
  )))];
}

function strengthSpec(input: unknown): Pick<ComfyRefmodSlotSchema,
  'strengthMin' | 'strengthMax' | 'strengthStep' | 'strengthDefault'> | undefined {
  if (!Array.isArray(input) || input[0] !== 'FLOAT') return undefined;
  const config = record(input[1]);
  const min = finite(config?.min);
  const max = finite(config?.max);
  if (min === undefined || max === undefined || min > 0 || max < 1) return undefined;
  const step = finite(config?.step);
  const defaultValue = finite(config?.default);
  return {
    strengthMin: min,
    strengthMax: max,
    strengthStep: step !== undefined && step > 0 ? step : undefined,
    strengthDefault: defaultValue !== undefined && defaultValue >= min && defaultValue <= max ? defaultValue : undefined,
  };
}

function parseLoader(payload: unknown, adapter: typeof ADAPTERS[number]): ComfyRefmodLoaderSchema | undefined {
  const inputs = inputsFor(payload, adapter.classType);
  if (!inputs) return undefined;
  const slots: ComfyRefmodSlotSchema[] = [];
  const slotCount = adapter.loaderType === 'minimax-h3' ? 8 : 1;
  for (let slot = 1; slot <= slotCount; slot += 1) {
    const fileField = adapter.loaderType === 'minimax-h3'
      ? `mod_${slot}`
      : adapter.loaderType === 'refmods-lab' ? 'filename' : 'mod';
    const values = comboValues(inputs[fileField]);
    if (!values) continue;
    const strengthField = adapter.loaderType === 'minimax-h3'
      ? `strength_${slot}`
      : adapter.loaderType === 'h3-refmods' ? 'weight' : undefined;
    const strength = strengthField ? strengthSpec(inputs[strengthField]) : undefined;
    // Lab 的强度属于另一个 Combine 节点，不能按加载节点输入名猜测并写入。
    if (strengthField && !strength) continue;
    const additionalStrengthFields = adapter.loaderType === 'h3-refmods'
      ? ['video_weight', 'audio_weight'].filter((field) => inputs[field] !== undefined)
      : [];
    const secondaryStrengths = additionalStrengthFields.map((field) => strengthSpec(inputs[field]));
    if (secondaryStrengths.some((secondary) => !secondary)) continue;
    if (strength) {
      strength.strengthMin = Math.max(strength.strengthMin ?? 0, ...secondaryStrengths.map((item) => item?.strengthMin ?? 0));
      strength.strengthMax = Math.min(strength.strengthMax ?? 1, ...secondaryStrengths.map((item) => item?.strengthMax ?? 1));
    }
    slots.push({
      slot,
      fileField,
      allowedNames: values.filter((value) => !EMPTY_NAMES.has(value)),
      emptyNames: values.filter((value) => EMPTY_NAMES.has(value)),
      ...(strength ? { strengthField, ...strength } : {}),
      ...(additionalStrengthFields.length ? { additionalStrengthFields } : {}),
    });
  }
  if (slots.length === 0) return undefined;
  return { ...adapter, slots };
}

function metadataByName(payload: unknown): Map<string, { kind?: string; description?: string; tokens?: number }> {
  const entries = new Map<string, { kind?: string; description?: string; tokens?: number }>();
  if (!Array.isArray(payload)) return entries;
  for (const item of payload.slice(0, MAX_CATALOG_FILES)) {
    const data = record(item);
    if (!data || typeof data.name !== 'string' || !isComfyRefmodFileName(data.name)) continue;
    const tokens = finite(data.tokens);
    entries.set(data.name, {
      kind: typeof data.kind === 'string' && ['image', 'video', 'audio', 'bundle'].includes(data.kind)
        ? data.kind : undefined,
      description: typeof data.description === 'string' ? data.description.slice(0, 2000) : undefined,
      tokens: tokens !== undefined && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : undefined,
    });
  }
  // 上游同时返回本地 path 和 config；白名单摘取字段，不向持久化或日志传播。
  return entries;
}

function catalogReadError(message: string, cause: unknown): Error {
  // 保留诊断类别，不把原始异常中的服务地址、本地路径或嵌套 cause 带出读取边界。
  const category = cause instanceof SyntaxError ? 'invalid-response'
    : cause instanceof DOMException && cause.name === 'AbortError' ? 'aborted'
      : cause instanceof Error ? 'request-failed' : 'unknown';
  return new Error(message, { cause: category });
}

/** 只读取已配置服务器的节点下拉与安全元数据，不读取模型权重或执行任何节点。 */
export async function loadComfyRefmodCatalog(
  serverId?: string,
  options: { signal?: AbortSignal; fresh?: boolean; includeDetails?: boolean } = {},
): Promise<ComfyRefmodCatalog> {
  options.signal?.throwIfAborted();
  const server = resolveComfyServerSelection(serverId);
  const expectedEndpoint = normalizeEndpoint(server.baseUrl);
  const identity: ComfyRefmodServerIdentity = {
    serverId: server.serverId,
    serverName: server.serverName,
    endpointFingerprint: await fingerprintEndpoint(server.baseUrl),
  };
  assertEndpointCurrent(serverId, expectedEndpoint);
  options.signal?.throwIfAborted();
  const cacheKey = JSON.stringify([serverId ?? null, identity.endpointFingerprint]);
  const cached = catalogCache.get(cacheKey);
  if (!options.fresh && cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    const current = { ...cached, serverName: identity.serverName };
    return options.includeDetails === false ? structuredClone(current)
      : loadComfyRefmodCatalogDetails(current, { signal: options.signal });
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = globalThis.setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    const results = await Promise.allSettled(ADAPTERS.map(async (adapter) => {
      const payload = await readJson(server.baseUrl, `/object_info/${adapter.classType}`, controller.signal);
      return { adapter, payload, loader: parseLoader(payload, adapter) };
    }));
    controller.signal.throwIfAborted();
    globalThis.clearTimeout(timeout);
    const loaders: ComfyRefmodLoaderSchema[] = [];
    const warnings: string[] = [];
    const failedLoaderTypes: ComfyRefmodLoaderType[] = [];
    let readableCount = 0;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === 'rejected') {
        failedLoaderTypes.push(ADAPTERS[index].loaderType);
        warnings.push(`${ADAPTERS[index].label} 目录读取失败，请检查服务器连接与访问权限。`);
        continue;
      }
      readableCount += 1;
      if (result.value.loader) loaders.push(result.value.loader);
      else if (record(result.value.payload)?.[result.value.adapter.classType]) {
        failedLoaderTypes.push(result.value.adapter.loaderType);
        warnings.push(`${result.value.adapter.label} 的节点定义不兼容，请检查插件版本。`);
      }
    }
    if (readableCount === 0) throw new Error('无法读取 ComfyUI RefMod 目录，请检查服务器连接与访问权限');

    const entries: ComfyRefmodAsset[] = [];
    for (const loader of loaders) {
      const names = new Set(loader.slots.flatMap((slot) => slot.allowedNames));
      for (const fileName of names) {
        const ref = { serverId, endpointFingerprint: identity.endpointFingerprint, loaderType: loader.loaderType, fileName };
        entries.push({
          ...ref,
          id: comfyRefmodKey(ref),
          name: fileName.split(/[\\/]/).at(-1) ?? fileName,
          tags: [],
          updatedAt: Date.now(),
        });
      }
    }
    assertEndpointCurrent(serverId, expectedEndpoint);
    const catalog: ComfyRefmodCatalog = { ...identity, entries, loaders, warnings, failedLoaderTypes, fetchedAt: Date.now() };
    catalogCache.set(cacheKey, catalog);
    while (catalogCache.size > 8) {
      const oldest = catalogCache.keys().next().value!;
      catalogCache.delete(oldest); catalogDetailsCache.delete(oldest);
    }
    return options.includeDetails === false ? structuredClone(catalog)
      : loadComfyRefmodCatalogDetails(catalog, { signal: options.signal, fresh: options.fresh });
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('RefMod 目录读取已取消', 'AbortError');
    if (controller.signal.aborted) throw catalogReadError('读取 RefMod 目录超时，请检查 ComfyUI 服务后重试', error);
    // 不透传网络异常中的服务器地址或后端可能返回的本地路径。
    if (error instanceof Error && /^(无法读取 ComfyUI RefMod|ComfyUI 服务器配置已变化)/.test(error.message)) throw error;
    throw catalogReadError('读取 RefMod 目录失败，请检查 ComfyUI 服务与插件', error);
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

/** 可选展示信息单独加载；执行校验只读取核心加载器，绝不等待这里。 */
export async function loadComfyRefmodCatalogDetails(
  catalog: ComfyRefmodCatalog,
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<ComfyRefmodCatalog> {
  options.signal?.throwIfAborted();
  const server = resolveComfyServerSelection(catalog.serverId);
  const expectedEndpoint = normalizeEndpoint(server.baseUrl);
  if (await fingerprintEndpoint(server.baseUrl) !== catalog.endpointFingerprint) {
    throw new Error('ComfyUI 服务器配置已变化，请重新读取 RefMod 目录');
  }
  assertEndpointCurrent(catalog.serverId, expectedEndpoint);
  const key = JSON.stringify([catalog.serverId ?? null, catalog.endpointFingerprint]);
  const enrich = (details: { metadata: ReturnType<typeof metadataByName>; warnings: string[] }): ComfyRefmodCatalog => ({
    ...catalog, warnings: [...new Set([...catalog.warnings, ...details.warnings])], entries: catalog.entries.map((entry) => ({
      ...entry, ...(entry.loaderType !== 'refmods-lab' ? details.metadata.get(entry.fileName) : {}),
    })),
  });
  const cached = catalogDetailsCache.get(key);
  if (!options.fresh && cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return enrich(cached);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const [fantastic, details] = await Promise.allSettled([
      readOptionalJson(server.baseUrl, `/object_info/${FANTASTIC_CLASS}`, controller.signal),
      catalog.loaders.some((loader) => loader.loaderType !== 'refmods-lab')
        ? readOptionalJson(server.baseUrl, '/refmods/library', controller.signal)
        : Promise.resolve(undefined),
    ]);
    controller.signal.throwIfAborted();
    assertEndpointCurrent(catalog.serverId, expectedEndpoint);
    const warnings: string[] = [];
    if (fantastic.status === 'fulfilled' && record(fantastic.value)?.[FANTASTIC_CLASS]) {
      warnings.push('检测到 Fantastic RefMod Stack；其自定义 JSON 选择暂不支持自动绑定，请在 ComfyUI 中选择。');
    }
    if (details.status === 'rejected') warnings.push('RefMod 详细信息暂不可用，仍可按已读取的文件名选择。');
    const metadata = metadataByName(details.status === 'fulfilled' ? details.value : undefined);
    // 描述只合并当前核心目录已有的文件，不覆盖任何核心缓存或文件身份。
    const detailed = { metadata, warnings, fetchedAt: Date.now() };
    catalogDetailsCache.set(key, detailed);
    while (catalogDetailsCache.size > 8) catalogDetailsCache.delete(catalogDetailsCache.keys().next().value!);
    return enrich(detailed);
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

import type {
  AgentPackageContributions,
  AgentPackageEntrypoints,
  AgentPackageHealth,
  AgentPackageInstallation,
  AgentPackageManifest,
  AgentPackageRouting,
  AgentPackageScope,
  AgentPackageSourceType,
  AgentPackageSurface,
  NormalizedAgentSourcePreview,
} from '../../types/agentPackage';

export const AGENT_PACKAGE_MANIFEST_MAX_BYTES = 64 * 1024;
export const AGENT_PACKAGE_INSTRUCTION_MAX_CHARS = 24_000;
export const AGENT_PACKAGE_MAX_ENTRYPOINTS = 128;

const PACKAGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const TOOL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_TYPES = new Set<AgentPackageSourceType>(['folder', 'archive']);
const HEALTH_VALUES = new Set<AgentPackageHealth>(['ready', 'degraded', 'invalid', 'missing']);
const SCOPE_VALUES = new Set<AgentPackageScope>(['global', 'project', 'series']);
const SURFACE_VALUES = new Set<AgentPackageSurface>(['assistant', 'canvas', 'background', 'mcp']);

const MANIFEST_KEYS = new Set([
  'schemaVersion',
  'id',
  'name',
  'version',
  'description',
  'entrypoints',
  'supportedScopes',
  'supportedSurfaces',
  'routing',
  'contributes',
]);
const ENTRYPOINT_KEYS = new Set(['instructions', 'router']);
const ROUTING_KEYS = new Set(['userInvocable', 'autoInvoke', 'whenToUse', 'triggers']);
const CONTRIBUTION_KEYS = new Set([
  'skillRoots',
  'knowledgeRoots',
  'assetRoots',
  'requestedTools',
  'excludePaths',
]);
const PREVIEW_KEYS = new Set([
  'sourceId',
  'sourceType',
  'name',
  'version',
  'manifest',
  'entrypoints',
  'instructionText',
  'skillCount',
  'fileCount',
  'totalBytes',
  'warnings',
  'health',
  'contentHash',
]);
const INSTALLATION_KEYS = new Set([
  'id',
  'packageId',
  'manifest',
  'source',
  'entrypoints',
  'skillCount',
  'fileCount',
  'totalBytes',
  'warnings',
  'health',
  'contentHash',
  'enabled',
  'installedAt',
  'updatedAt',
]);

export class AgentPackageValidationError extends Error {
  readonly code = 'AGENT_PACKAGE_INVALID';
}

function fail(message: string): never {
  throw new AgentPackageValidationError(message);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail(`${label} 包含不支持的字段: ${unknown}`);
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') fail(`${label} 必须是字符串`);
  const normalized = value.trim();
  if (!normalized) fail(`${label} 不能为空`);
  if (normalized.length > maxLength) fail(`${label} 不能超过 ${maxLength} 个字符`);
  if (Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) fail(`${label} 包含控制字符`);
  return normalized;
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : requiredString(value, label, maxLength);
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} 必须是布尔值`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} 必须是非负安全整数`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): number {
  const normalized = nonNegativeInteger(value, label);
  if (normalized === 0) fail(`${label} 必须大于 0`);
  return normalized;
}

function uniqueStringArray(
  value: unknown,
  label: string,
  options: { maxItems: number; maxLength: number; allowEmpty?: boolean },
): string[] {
  if (!Array.isArray(value)) fail(`${label} 必须是数组`);
  if (!options.allowEmpty && value.length === 0) fail(`${label} 不能为空`);
  if (value.length > options.maxItems) fail(`${label} 不能超过 ${options.maxItems} 项`);
  const normalized = value.map((item, index) => (
    requiredString(item, `${label}[${index}]`, options.maxLength)
  ));
  if (new Set(normalized).size !== normalized.length) fail(`${label} 不能包含重复项`);
  return normalized;
}

/** Normalize and validate a package-internal path. No local absolute path is accepted. */
export function normalizeAgentPackageRelativePath(value: unknown, label = '包内路径'): string {
  const normalized = requiredString(value, label, 512).replace(/\\/g, '/');
  if (
    normalized.includes(':')
    || normalized.startsWith('/')
    || normalized.startsWith('~')
  ) {
    fail(`${label} 必须是包内相对路径`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail(`${label} 必须是包内相对路径`);
  }
  return segments.join('/');
}

function relativePathArray(
  value: unknown,
  label: string,
  maxItems: number,
  allowEmpty = true,
): string[] {
  if (!Array.isArray(value)) fail(`${label} 必须是数组`);
  if (!allowEmpty && value.length === 0) fail(`${label} 不能为空`);
  if (value.length > maxItems) fail(`${label} 不能超过 ${maxItems} 项`);
  const normalized = value.map((item, index) => (
    normalizeAgentPackageRelativePath(item, `${label}[${index}]`)
  ));
  if (new Set(normalized).size !== normalized.length) fail(`${label} 不能包含重复项`);
  return normalized;
}

function parseEntrypoints(value: unknown): AgentPackageEntrypoints {
  const raw = objectValue(value, 'entrypoints');
  assertKnownKeys(raw, ENTRYPOINT_KEYS, 'entrypoints');
  return {
    instructions: normalizeAgentPackageRelativePath(
      raw.instructions,
      'entrypoints.instructions',
    ),
    router: raw.router === undefined
      ? undefined
      : normalizeAgentPackageRelativePath(raw.router, 'entrypoints.router'),
  };
}

function enumArray<T extends string>(
  value: unknown,
  label: string,
  allowed: Set<T>,
): T[] {
  const values = uniqueStringArray(value, label, {
    maxItems: allowed.size,
    maxLength: 32,
  });
  if (values.some((item) => !allowed.has(item as T))) fail(`${label} 包含不支持的值`);
  return values as T[];
}

function parseRouting(value: unknown): AgentPackageRouting {
  const raw = objectValue(value, 'routing');
  assertKnownKeys(raw, ROUTING_KEYS, 'routing');
  const triggers = raw.triggers === undefined
    ? undefined
    : uniqueStringArray(raw.triggers, 'routing.triggers', {
        maxItems: 32,
        maxLength: 80,
        allowEmpty: true,
      });
  return {
    userInvocable: requiredBoolean(raw.userInvocable, 'routing.userInvocable'),
    autoInvoke: requiredBoolean(raw.autoInvoke, 'routing.autoInvoke'),
    whenToUse: optionalString(raw.whenToUse, 'routing.whenToUse', 500),
    triggers,
  };
}

function parseContributions(value: unknown): AgentPackageContributions | undefined {
  if (value === undefined) return undefined;
  const raw = objectValue(value, 'contributes');
  assertKnownKeys(raw, CONTRIBUTION_KEYS, 'contributes');
  const requestedTools = raw.requestedTools === undefined
    ? undefined
    : uniqueStringArray(raw.requestedTools, 'contributes.requestedTools', {
        maxItems: 64,
        maxLength: 128,
        allowEmpty: true,
      });
  const invalidTool = requestedTools?.find((toolId) => !TOOL_ID_PATTERN.test(toolId));
  if (invalidTool) fail(`contributes.requestedTools 包含无效工具 ID: ${invalidTool}`);

  const result: AgentPackageContributions = {
    skillRoots: raw.skillRoots === undefined
      ? undefined
      : relativePathArray(raw.skillRoots, 'contributes.skillRoots', 32),
    knowledgeRoots: raw.knowledgeRoots === undefined
      ? undefined
      : relativePathArray(raw.knowledgeRoots, 'contributes.knowledgeRoots', 32),
    assetRoots: raw.assetRoots === undefined
      ? undefined
      : relativePathArray(raw.assetRoots, 'contributes.assetRoots', 32),
    requestedTools,
    excludePaths: raw.excludePaths === undefined
      ? undefined
      : relativePathArray(raw.excludePaths, 'contributes.excludePaths', 64),
  };
  return Object.values(result).some((item) => item !== undefined) ? result : undefined;
}

export function normalizeAgentPackageManifest(value: unknown): AgentPackageManifest {
  const raw = objectValue(value, 'manifest');
  assertKnownKeys(raw, MANIFEST_KEYS, 'manifest');
  if (raw.schemaVersion !== 1) fail('仅支持 schemaVersion: 1');
  const id = requiredString(raw.id, 'manifest.id', 128);
  if (!PACKAGE_ID_PATTERN.test(id)) {
    fail('manifest.id 只能使用小写字母、数字、点、下划线和短横线');
  }
  const version = requiredString(raw.version, 'manifest.version', 64);
  if (!SEMVER_PATTERN.test(version)) fail('manifest.version 必须是 SemVer 版本');

  return {
    schemaVersion: 1,
    id,
    name: requiredString(raw.name, 'manifest.name', 120),
    version,
    description: optionalString(raw.description, 'manifest.description', 500),
    entrypoints: parseEntrypoints(raw.entrypoints),
    supportedScopes: enumArray(raw.supportedScopes, 'supportedScopes', SCOPE_VALUES),
    supportedSurfaces: enumArray(raw.supportedSurfaces, 'supportedSurfaces', SURFACE_VALUES),
    routing: parseRouting(raw.routing),
    contributes: parseContributions(raw.contributes),
  };
}

export function parseAgentPackageManifest(manifestText: string): AgentPackageManifest {
  if (new TextEncoder().encode(manifestText).byteLength > AGENT_PACKAGE_MANIFEST_MAX_BYTES) {
    fail('ai-canvas-agent.json 过大');
  }
  let value: unknown;
  try {
    value = JSON.parse(manifestText);
  } catch {
    fail('ai-canvas-agent.json 不是有效 JSON');
  }
  return normalizeAgentPackageManifest(value);
}

function normalizeSourceId(value: unknown): string {
  const sourceId = requiredString(value, 'sourceId', 256);
  if (sourceId.includes('/') || sourceId.includes('\\')) {
    fail('sourceId 必须是不透明标识，不能包含路径');
  }
  return sourceId;
}

function normalizeSourceType(value: unknown): AgentPackageSourceType {
  if (typeof value !== 'string' || !SOURCE_TYPES.has(value as AgentPackageSourceType)) {
    fail('sourceType 不受支持');
  }
  return value as AgentPackageSourceType;
}

function normalizeHealth(value: unknown): AgentPackageHealth {
  if (typeof value !== 'string' || !HEALTH_VALUES.has(value as AgentPackageHealth)) {
    fail('health 不受支持');
  }
  return value as AgentPackageHealth;
}

function normalizeContentHash(value: unknown): string {
  const hash = requiredString(value, 'contentHash', 64).toLowerCase();
  if (!HASH_PATTERN.test(hash)) fail('contentHash 必须是 SHA-256 十六进制值');
  return hash;
}

function normalizeInstructionText(value: unknown): string {
  if (typeof value !== 'string') fail('instructionText 必须是字符串');
  if (value.length > AGENT_PACKAGE_INSTRUCTION_MAX_CHARS) {
    fail(`instructionText 不能超过 ${AGENT_PACKAGE_INSTRUCTION_MAX_CHARS} 个字符`);
  }
  return value;
}

function normalizeWarnings(value: unknown): string[] {
  return uniqueStringArray(value, 'warnings', {
    maxItems: 64,
    maxLength: 240,
    allowEmpty: true,
  });
}

export function normalizeAgentSourcePreview(value: unknown): NormalizedAgentSourcePreview {
  const raw = objectValue(value, 'preview');
  assertKnownKeys(raw, PREVIEW_KEYS, 'preview');
  const manifest = raw.manifest === null
    ? null
    : normalizeAgentPackageManifest(raw.manifest);
  const entrypoints = relativePathArray(
    raw.entrypoints,
    'entrypoints',
    AGENT_PACKAGE_MAX_ENTRYPOINTS,
  );
  const name = requiredString(raw.name, 'name', 120);
  const version = requiredString(raw.version, 'version', 64);
  if (manifest && (manifest.name !== name || manifest.version !== version)) {
    fail('预览名称或版本与 Manifest 不一致');
  }
  if (manifest) {
    const requiredEntrypoints = [
      manifest.entrypoints.instructions,
      manifest.entrypoints.router,
    ].filter((item): item is string => !!item);
    if (requiredEntrypoints.some((item) => !entrypoints.includes(item))) {
      fail('预览缺少 Manifest 声明的入口文件');
    }
  }
  return {
    sourceId: normalizeSourceId(raw.sourceId),
    sourceType: normalizeSourceType(raw.sourceType),
    name,
    version,
    manifest,
    entrypoints,
    instructionText: normalizeInstructionText(raw.instructionText),
    skillCount: nonNegativeInteger(raw.skillCount, 'skillCount'),
    fileCount: nonNegativeInteger(raw.fileCount, 'fileCount'),
    totalBytes: nonNegativeInteger(raw.totalBytes, 'totalBytes'),
    warnings: normalizeWarnings(raw.warnings),
    health: normalizeHealth(raw.health),
    contentHash: normalizeContentHash(raw.contentHash),
  };
}

/**
 * Build a host-side compatibility manifest for an older folder that has no
 * ai-canvas-agent.json. The generated record stays in the catalog and is never
 * written back to the user's source directory.
 */
export function createLegacyAgentPackageManifest(
  preview: NormalizedAgentSourcePreview,
): AgentPackageManifest {
  const instructionEntry = preview.entrypoints.find(
    (entry) => entry.toLowerCase() === 'agents.md',
  ) ?? preview.entrypoints.find(
    (entry) => entry.split('/').at(-1)?.toLowerCase() === 'agents.md',
  ) ?? preview.entrypoints.find(
    (entry) => entry.split('/').at(-1)?.toLowerCase() === 'skill.md',
  ) ?? preview.entrypoints[0];
  if (!instructionEntry) fail('旧版智能体目录中没有可用入口文件');

  const legacyVersion = SEMVER_PATTERN.test(preview.version)
    ? preview.version
    : '0.0.0-legacy';
  return normalizeAgentPackageManifest({
    schemaVersion: 1,
    id: `legacy.${preview.contentHash.slice(0, 16)}`,
    name: preview.name,
    version: legacyVersion,
    description: '由 AI Canvas 为无根清单目录生成的本地兼容描述',
    entrypoints: { instructions: instructionEntry },
    supportedScopes: ['global', 'project', 'series'],
    supportedSurfaces: ['assistant'],
    routing: {
      userInvocable: true,
      autoInvoke: false,
    },
  });
}

/** Revalidate renderer-persisted catalog records before exposing them to the Store. */
export function normalizeAgentPackageInstallation(value: unknown): AgentPackageInstallation {
  const raw = objectValue(value, 'installation');
  assertKnownKeys(raw, INSTALLATION_KEYS, 'installation');
  const manifest = normalizeAgentPackageManifest(raw.manifest);
  const packageId = requiredString(raw.packageId, 'packageId', 128);
  if (packageId !== manifest.id) fail('packageId 与 Manifest id 不一致');
  const source = objectValue(raw.source, 'source');
  assertKnownKeys(source, new Set(['sourceId', 'sourceType', 'displayName']), 'source');
  const entrypoints = relativePathArray(
    raw.entrypoints,
    'entrypoints',
    AGENT_PACKAGE_MAX_ENTRYPOINTS,
  );
  const requiredEntrypoints = [
    manifest.entrypoints.instructions,
    manifest.entrypoints.router,
  ].filter((item): item is string => !!item);
  if (requiredEntrypoints.some((item) => !entrypoints.includes(item))) {
    fail('安装记录缺少 Manifest 声明的入口文件');
  }
  return {
    id: requiredString(raw.id, 'installation.id', 180),
    packageId,
    manifest,
    source: {
      sourceId: normalizeSourceId(source.sourceId),
      sourceType: normalizeSourceType(source.sourceType),
      displayName: requiredString(source.displayName, 'source.displayName', 120),
    },
    entrypoints,
    skillCount: nonNegativeInteger(raw.skillCount, 'skillCount'),
    fileCount: nonNegativeInteger(raw.fileCount, 'fileCount'),
    totalBytes: nonNegativeInteger(raw.totalBytes, 'totalBytes'),
    warnings: normalizeWarnings(raw.warnings),
    health: normalizeHealth(raw.health),
    contentHash: normalizeContentHash(raw.contentHash),
    enabled: requiredBoolean(raw.enabled, 'enabled'),
    installedAt: timestamp(raw.installedAt, 'installedAt'),
    updatedAt: timestamp(raw.updatedAt, 'updatedAt'),
  };
}

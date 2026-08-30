/**
 * AgentPackage Skill 的运行时只读目录与资源边界。
 *
 * 包内正文只保存在主窗口内存，不复制进 UserSkill 数据库；所有文件读取仍由
 * Rust 的 opaque sourceId + package-root 边界进行第二层校验。
 */
import type {
  AgentPackageInstallation,
  AgentPackageSkill,
  AgentPackageSkillBranch,
} from '../../types/agentPackage';
import { parseSkillDocument } from '../chat/skillManifest';
import {
  readAgentPackageSourceText,
  type AgentPackageSourceTextResult,
} from './agentPackageImportService';

export const AGENT_PACKAGE_SKILL_LIMITS = {
  maxSkills: 128,
  maxEntryBytes: 128 * 1024,
  maxResourceBytes: 256 * 1024,
  maxCatalogChars: 2_000_000,
  readConcurrency: 4,
} as const;

const SAFE_RESOURCE_EXTENSIONS = new Set([
  'md',
  'txt',
  'json',
  'csv',
  'tsv',
  'yaml',
  'yml',
]);

export interface AgentPackageSkillCatalogResult {
  skills: AgentPackageSkill[];
  failures: Array<{ installationId: string; entryPath: string; reason: string }>;
}

const entryCache = new Map<string, AgentPackageSkill>();

function entryCacheKey(
  installation: AgentPackageInstallation,
  entryPath: string,
): string {
  return [
    installation.id,
    installation.source.sourceId,
    installation.contentHash,
    normalizedPath(entryPath),
  ].join(':');
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, '');
}

function pathIsWithin(path: string, root: string): boolean {
  const normalizedRoot = normalizedPath(root);
  if (!normalizedRoot) return true;
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

function pathMatchesPrefix(path: string, candidate: string): boolean {
  const normalizedCandidate = normalizedPath(candidate);
  return normalizedCandidate === path || path.startsWith(`${normalizedCandidate}/`);
}

function isSkillEntrypoint(path: string): boolean {
  return normalizedPath(path).split('/').at(-1)?.toLocaleLowerCase() === 'skill.md';
}

function installationCanLoadSkills(installation: AgentPackageInstallation): boolean {
  return installation.enabled
    && installation.health !== 'invalid'
    && installation.health !== 'missing';
}

function entrypointAllowedByManifest(
  installation: AgentPackageInstallation,
  entryPath: string,
): boolean {
  const normalized = normalizedPath(entryPath);
  const roots = installation.manifest.contributes?.skillRoots ?? [];
  const excludes = installation.manifest.contributes?.excludePaths ?? [];
  if (roots.length > 0 && !roots.some((root) => pathIsWithin(normalized, root))) return false;
  return !excludes.some((excluded) => pathMatchesPrefix(normalized, excluded));
}

function sanitizeLabel(value: string, maxLength: number): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function fallbackSkillName(entryPath: string): string {
  const segments = normalizedPath(entryPath).split('/');
  return sanitizeLabel(segments.at(-2) || 'Skill', 120) || 'Skill';
}

function fallbackDescription(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#+\s*/, '').trim())
    .find(Boolean);
  return sanitizeLabel(firstLine || '', 500);
}

/**
 * 当前兼容目录的路线标签。未知布局按 shared 处理，并由调用侧保持显式调用。
 * 标签只用于目录隔离/展示，不能改变 Policy 或工具权限。
 */
export function classifyAgentPackageSkillBranch(entryPath: string): AgentPackageSkillBranch {
  const segments = normalizedPath(entryPath).split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('实验对照_B方案_'))) {
    return 'experimental-b';
  }
  if (segments[0] === '海外短剧') return 'overseas';
  if (segments[0] === 'skills') return 'shared';
  if (/^0[0-6]-/.test(segments[0] || '')) return 'domestic';
  return 'shared';
}

async function sha256Prefix(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 24);
}

export async function createAgentPackageSkillId(
  installationId: string,
  entryPath: string,
): Promise<string> {
  const hash = await sha256Prefix(`v1\0${installationId}\0${normalizedPath(entryPath)}`);
  return `ap-skill-${hash}`;
}

async function loadEntry(
  installation: AgentPackageInstallation,
  entryPath: string,
): Promise<AgentPackageSkill> {
  const normalizedEntryPath = normalizedPath(entryPath);
  const cacheKey = entryCacheKey(installation, normalizedEntryPath);
  const cached = entryCache.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      mcpSkillReadEnabled: installation.mcpSkillReadEnabled,
      packageUserInvocable: installation.manifest.routing.userInvocable,
      packageAutoInvoke: installation.manifest.routing.autoInvoke,
    };
  }

  const source = await readAgentPackageSourceText(
    installation.source.sourceId,
    normalizedEntryPath,
    AGENT_PACKAGE_SKILL_LIMITS.maxEntryBytes,
  );
  const parsed = parseSkillDocument(source.content);
  const name = sanitizeLabel(parsed.manifest?.name || fallbackSkillName(normalizedEntryPath), 120)
    || 'Skill';
  const description = sanitizeLabel(
    parsed.manifest?.description
      || parsed.manifest?.whenToUse
      || fallbackDescription(parsed.content),
    500,
  );
  const slashIndex = normalizedEntryPath.lastIndexOf('/');
  const skill: AgentPackageSkill = {
    id: await createAgentPackageSkillId(installation.id, normalizedEntryPath),
    name,
    description,
    fileName: 'SKILL.md',
    content: source.content,
    sourceType: 'agent-package',
    ...(parsed.manifest ? { manifest: parsed.manifest } : {}),
    createdAt: installation.updatedAt,
    installationId: installation.id,
    packageId: installation.packageId,
    packageName: installation.manifest.name,
    packageVersion: installation.manifest.version,
    packageContentHash: installation.contentHash,
    sourceId: installation.source.sourceId,
    entryPath: normalizedEntryPath,
    skillRoot: slashIndex >= 0 ? normalizedEntryPath.slice(0, slashIndex) : '',
    contentHash: source.sha256,
    branch: classifyAgentPackageSkillBranch(normalizedEntryPath),
    packageUserInvocable: installation.manifest.routing.userInvocable,
    packageAutoInvoke: installation.manifest.routing.autoInvoke,
    mcpSkillReadEnabled: installation.mcpSkillReadEnabled,
    readOnly: true,
  };
  entryCache.set(cacheKey, skill);
  return skill;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(values[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker(),
  ));
  return results;
}

export async function loadAgentPackageSkillCatalog(
  installations: AgentPackageInstallation[],
): Promise<AgentPackageSkillCatalogResult> {
  const candidates = installations
    .filter(installationCanLoadSkills)
    .flatMap((installation) => installation.entrypoints
      .filter(isSkillEntrypoint)
      .filter((entryPath) => entrypointAllowedByManifest(installation, entryPath))
      .map((entryPath) => ({ installation, entryPath: normalizedPath(entryPath) })))
    .slice(0, AGENT_PACKAGE_SKILL_LIMITS.maxSkills);
  const activeCacheKeys = new Set(candidates.map(({ installation, entryPath }) => (
    entryCacheKey(installation, entryPath)
  )));
  for (const cacheKey of entryCache.keys()) {
    if (!activeCacheKeys.has(cacheKey)) entryCache.delete(cacheKey);
  }

  const settled = await mapWithConcurrency(
    candidates,
    AGENT_PACKAGE_SKILL_LIMITS.readConcurrency,
    ({ installation, entryPath }) => loadEntry(installation, entryPath),
  );
  const skills: AgentPackageSkill[] = [];
  const failures: AgentPackageSkillCatalogResult['failures'] = [];
  let usedChars = 0;
  settled.forEach((result, index) => {
    const candidate = candidates[index];
    if (result.status === 'rejected') {
      failures.push({
        installationId: candidate.installation.id,
        entryPath: candidate.entryPath,
        reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      return;
    }
    if (usedChars + result.value.content.length > AGENT_PACKAGE_SKILL_LIMITS.maxCatalogChars) {
      failures.push({
        installationId: candidate.installation.id,
        entryPath: candidate.entryPath,
        reason: '智能体 Skill 运行时目录内容超过总预算',
      });
      return;
    }
    usedChars += result.value.content.length;
    skills.push(result.value);
  });

  return {
    skills: skills.sort((left, right) => (
      left.packageName.localeCompare(right.packageName)
      || left.entryPath.localeCompare(right.entryPath)
    )),
    failures,
  };
}

function safeResourceExtension(path: string): boolean {
  const extension = path.split('/').at(-1)?.split('.').at(-1)?.toLocaleLowerCase();
  return !!extension && SAFE_RESOURCE_EXTENSIONS.has(extension);
}

function resolveRelativePath(baseRoot: string, requestedPath: string): string {
  if (
    !requestedPath
    || requestedPath.includes('\0')
    || requestedPath.includes('\\')
    || requestedPath.startsWith('/')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(requestedPath)
  ) {
    throw new Error('智能体 Skill 资源路径无效');
  }
  const segments = normalizedPath(baseRoot).split('/').filter(Boolean);
  for (const segment of requestedPath.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) throw new Error('智能体 Skill 资源越过包边界');
      segments.pop();
      continue;
    }
    if (segment.includes(':')) throw new Error('智能体 Skill 资源路径无效');
    segments.push(segment);
  }
  const resolved = segments.join('/');
  if (!resolved || !safeResourceExtension(resolved)) {
    throw new Error('智能体 Skill 仅允许读取受支持的资料文件');
  }
  return resolved;
}

function extractExplicitResourcePaths(skill: AgentPackageSkill): Map<string, string> {
  const resources = new Map<string, string>();
  for (const match of skill.content.matchAll(/`([^`\r\n]+)`/g)) {
    const raw = match[1].trim();
    if (
      !raw
      || [...raw].some((character) => '{}[]*?'.includes(character))
      || raw.includes('://')
      || raw.startsWith('--')
    ) continue;
    const portable = raw.replace(/\\/g, '/');
    try {
      const resolved = resolveRelativePath(skill.skillRoot, portable);
      resources.set(portable, resolved);
    } catch {
      // 代码片段、占位符和脚本路径不是可读取资料。
    }
  }
  return resources;
}

export function listAgentPackageSkillResources(skill: AgentPackageSkill): string[] {
  return [...extractExplicitResourcePaths(skill).keys()].sort((left, right) => (
    left.localeCompare(right)
  ));
}

export function resolveAgentPackageSkillResourcePath(
  skill: AgentPackageSkill,
  requestedPath: string,
): string {
  const resolved = resolveRelativePath(skill.skillRoot, requestedPath);
  if (skill.branch !== 'experimental-b' && classifyAgentPackageSkillBranch(resolved) === 'experimental-b') {
    throw new Error('常规 Skill 不能读取实验 B 方案资源');
  }
  if (skill.branch === 'experimental-b' && classifyAgentPackageSkillBranch(resolved) !== 'experimental-b') {
    throw new Error('实验 B 方案 Skill 不能读取常规路线资源');
  }
  if (pathIsWithin(resolved, skill.skillRoot)) return resolved;
  const explicitTargets = new Set(extractExplicitResourcePaths(skill).values());
  if (!explicitTargets.has(resolved)) {
    throw new Error('跨 Skill 目录的资料必须由当前 SKILL.md 明确引用');
  }
  return resolved;
}

export async function readAgentPackageSkillResource(
  skill: AgentPackageSkill,
  requestedPath: string,
): Promise<AgentPackageSourceTextResult> {
  const packageRelativePath = resolveAgentPackageSkillResourcePath(skill, requestedPath);
  return readAgentPackageSourceText(
    skill.sourceId,
    packageRelativePath,
    AGENT_PACKAGE_SKILL_LIMITS.maxResourceBytes,
  );
}

export function clearAgentPackageSkillCacheForTests(): void {
  entryCache.clear();
}

/** 可分享组合包的严格白名单合同，校验不安装、不启用、不执行。 */
import type { CreationProfile, CreationProfileSelection } from '../../types/creationProfile';
import { normalizeTeamProfile, TEAM_ROLES, TEAM_TEMPLATES } from '../chat/teams/teamProfileService';
import { validateTeamGraph } from '../chat/teams/teamGraphService';

const HASH = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('组合包包含不支持或敏感的字段');
}
function text(value: unknown, limit: number, id = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || [...value].some((char) => char.charCodeAt(0) < 32)
    || /(?:https?:\/\/|[A-Za-z]:[\\/]|^\/|sk-[A-Za-z0-9_-]{12,})/i.test(value)
    || (id && !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value))) throw new Error('组合包字段格式无效，不能包含地址、路径或密钥');
  return value.trim();
}
function list<T>(raw: unknown, limit: number, parse: (value: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(raw) || raw.length > limit) throw new Error('组合包引用数量超出上限');
  return raw.map((item) => { if (!record(item)) throw new Error('组合包引用格式无效'); return parse(item); });
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error('组合包能力摘要无效');
  return value;
}

export function parseCreationProfile(raw: unknown): CreationProfile {
  if (typeof raw === 'string') {
    if (new TextEncoder().encode(raw).byteLength > 256 * 1024) throw new Error('组合包超过 256 KiB');
    try { raw = JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch (cause) { throw new Error('组合包不是有效的 JSON', { cause }); }
  }
  if (!record(raw) || raw.schemaVersion !== 1) throw new Error('组合包版本不受支持');
  keys(raw, ['schemaVersion', 'id', 'version', 'name', 'description', 'pluginRefs', 'agentPackageRefs', 'skillRefs', 'teamTemplateId', 'teamProfile', 'contextPolicyRef', 'toolAllowlist']);
  const version = text(raw.version, 40);
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('组合包版本应使用 x.y.z');
  const profile: CreationProfile = {
    schemaVersion: 1, id: text(raw.id, 120, true), version, name: text(raw.name, 80),
    pluginRefs: list(raw.pluginRefs, 32, (item) => { keys(item, ['pluginId', 'revisionDigest']); return { pluginId: text(item.pluginId, 120, true), revisionDigest: hash(item.revisionDigest) }; }),
    agentPackageRefs: list(raw.agentPackageRefs, 16, (item) => { keys(item, ['packageId', 'contentHash']); return { packageId: text(item.packageId, 160, true), contentHash: hash(item.contentHash) }; }),
    skillRefs: list(raw.skillRefs, 4, (item) => { keys(item, ['skillId']); return { skillId: text(item.skillId, 220, true) }; }),
    contextPolicyRef: raw.contextPolicyRef === 'project-default' || raw.contextPolicyRef === 'explicit-materials'
      ? raw.contextPolicyRef : (() => { throw new Error('组合包上下文策略无效'); })(),
  };
  if (raw.description !== undefined) profile.description = text(raw.description, 500);
  if (raw.teamTemplateId !== undefined) {
    if (!TEAM_TEMPLATES.some((id) => id === raw.teamTemplateId)) throw new Error('组合包团队模板无效');
    profile.teamTemplateId = raw.teamTemplateId as CreationProfile['teamTemplateId'];
  }
  if (raw.teamProfile !== undefined) {
    if (!record(raw.teamProfile) || raw.teamProfile.version !== 1 || !profile.teamTemplateId || !record(raw.teamProfile.roles)) throw new Error('组合包团队配置无效');
    keys(raw.teamProfile, ['version', 'name', 'roles', 'roleExecutors', 'graph', 'maxCalls', 'maxTotalTokens', 'maxOutputChars']);
    text(raw.teamProfile.name, 60);
    keys(raw.teamProfile.roles, TEAM_ROLES);
    for (const role of TEAM_ROLES) {
      const model = raw.teamProfile.roles[role];
      if (model !== '') text(model, 200, true);
    }
    if (raw.teamProfile.roleExecutors !== undefined) {
      if (!record(raw.teamProfile.roleExecutors)) throw new Error('组合包成员执行器无效');
      keys(raw.teamProfile.roleExecutors, TEAM_ROLES);
      for (const target of Object.values(raw.teamProfile.roleExecutors)) {
        if (!record(target)) throw new Error('组合包成员执行器无效');
        keys(target, ['kind', 'providerId', 'modelId']);
        if (target.kind !== 'text-model' && !(target.kind === 'external-agent' && target.providerId === 'codex-app-server')) throw new Error('组合包外部执行器不受支持');
        if (target.kind === 'text-model' && target.providerId !== undefined) throw new Error('文本成员不接受外部执行器地址');
        text(target.modelId, 200, true);
      }
    }
    if (raw.teamProfile.graph !== undefined) {
      const graph = validateTeamGraph(raw.teamProfile.graph);
      for (const node of graph.nodes) { text(node.title, 180); if (node.modelId) text(node.modelId, 200, true); }
    }
    const normalized = normalizeTeamProfile(raw.teamProfile);
    const budgetFields = ['maxCalls', 'maxTotalTokens', 'maxOutputChars'] as const;
    if (budgetFields.some((key) => (raw.teamProfile as Record<string, unknown>)[key] !== normalized[key])) throw new Error('组合包团队预算无效');
    profile.teamProfile = normalized;
  }
  if (raw.toolAllowlist !== undefined) {
    if (!Array.isArray(raw.toolAllowlist) || raw.toolAllowlist.length > 128) throw new Error('组合包工具偏好无效');
    profile.toolAllowlist = [...new Set(raw.toolAllowlist.map((id) => text(id, 128, true)))];
  }
  for (const refs of [profile.pluginRefs.map((item) => item.pluginId), profile.agentPackageRefs.map((item) => item.packageId), profile.skillRefs.map((item) => item.skillId)]) {
    if (new Set(refs).size !== refs.length) throw new Error('组合包引用不能重复');
  }
  return profile;
}

export async function creationProfileSelection(profile: CreationProfile): Promise<CreationProfileSelection> {
  const normalized = parseCreationProfile(profile);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(normalized)));
  return { id: normalized.id, version: normalized.version, sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('') };
}

export function normalizeCreationProfileSelection(value: unknown): CreationProfileSelection | undefined {
  if (!record(value) || Object.keys(value).some((key) => !['id', 'version', 'sha256'].includes(key))
    || typeof value.id !== 'string' || typeof value.version !== 'string' || typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) return undefined;
  try { return { id: text(value.id, 120, true), version: text(value.version, 40), sha256: value.sha256 }; }
  catch { return undefined; }
}

/** 读取损坏记录时保留阻塞标记，不能静默丢失选择后退回普通任务。 */
export function restoreCreationProfileSelection(value: unknown): CreationProfileSelection | undefined {
  return normalizeCreationProfileSelection(value) ?? (value !== undefined && value !== null
    ? { id: 'invalid-creation-profile', version: '0.0.0', sha256: '0'.repeat(64) } : undefined);
}

/** 创作组合包解析与快照：只检查既有能力，不隐式下载、启用或调用模型。 */
import type { AgentTeamProfile } from '../../types/agentTeam';
import type { AgentSkillBinding } from '../../types/agent';
import type { CreationProfile, CreationProfileNotice, CreationProfileOption, CreationProfilePreview, CreationProfileSelection, CreationProfileSnapshot } from '../../types/creationProfile';
import { useAppStore } from '../../store/useAppStore';
import { resolveAssistantModel } from '../ai/assistantStream';
import { captureExplicitSkillBindings, isSkillUserInvocable } from '../skillPromptService';
import { inspectPluginHealth } from '../plugins/pluginHealthService';
import { getExternalAgentStatus } from '../chat/externalAgents/externalAgentRegistry';
import { createTemplateTeamGraph, getTeamNodeTarget } from '../chat/teams/teamGraphService';
import { normalizeTeamProfile } from '../chat/teams/teamProfileService';
import { creationProfileSelection, normalizeCreationProfileSelection, parseCreationProfile } from './creationProfileManifest';
import { configValuesEqual } from '../configPatch';

export function intersectCreationTools(current: string[] | undefined, requested: string[] | undefined): string[] | undefined {
  if (requested === undefined) return current;
  return current === undefined ? [...requested] : current.filter((id) => requested.includes(id));
}

/** 不回读可变组合包目录；只复核任务冻结的执行能力身份。 */
export function assertCreationProfileSnapshot(snapshot: CreationProfileSnapshot | undefined): void {
  if (!snapshot) return;
  const state = useAppStore.getState();
  for (const reference of snapshot.pluginRefs) {
    const current = state.installedPlugins.find((entry) => entry.id === reference.pluginId);
    if (!current?.enabled || current.revisionDigest !== reference.revisionDigest) throw new Error('任务绑定的插件身份已变化，请重新配置后发起新任务');
  }
  for (const reference of snapshot.agentPackageRefs) {
    const current = state.agentPackages.find((entry) => entry.packageId === reference.packageId);
    if (!current?.enabled || current.health !== 'ready' || current.contentHash !== reference.contentHash) throw new Error('任务绑定的 Agent 包身份已变化，请重新配置后发起新任务');
  }
}

/** 独立窗口只展示名称/ID/版本；完整组合配置始终留在主窗口。 */
export function creationProfileOptions(): CreationProfileOption[] {
  return (useAppStore.getState().config.creationProfiles ?? []).flatMap((raw) => {
    try { const profile = parseCreationProfile(raw); return [{ id: profile.id, name: profile.name, version: profile.version }]; }
    catch { return []; }
  });
}

export async function previewCreationProfileOption(option: CreationProfileOption, projectId: string): Promise<CreationProfilePreview> {
  const raw = useAppStore.getState().config.creationProfiles?.find((entry) => entry.id === option.id && entry.version === option.version);
  if (!raw) throw new Error('组合包已失效，请重新选择');
  return previewCreationProfile(raw, projectId);
}

export async function previewCreationProfile(value: unknown, projectId: string): Promise<CreationProfilePreview> {
  const profile = parseCreationProfile(value);
  const selection = await creationProfileSelection(profile);
  const state = useAppStore.getState();
  const issues: CreationProfileNotice[] = [];
  for (const reference of profile.pluginRefs) {
    const plugin = state.installedPlugins.find((entry) => entry.id === reference.pluginId);
    if (!plugin || !plugin.enabled || plugin.revisionDigest !== reference.revisionDigest) { issues.push({ message: '插件不可用或版本变化：{name}', name: reference.pluginId }); continue; }
    const health = await inspectPluginHealth(plugin, state.installedPlugins);
    if (health.state !== 'ready') issues.push({ message: '插件尚未实际生效：{name}', name: reference.pluginId });
  }
  for (const reference of profile.agentPackageRefs) {
    const installation = state.agentPackages.find((entry) => entry.packageId === reference.packageId);
    if (!installation || !installation.enabled || installation.health !== 'ready' || installation.contentHash !== reference.contentHash) issues.push({ message: 'Agent 包不可用或版本变化：{name}', name: reference.packageId });
  }
  const runtimeSkills = [...state.userSkills, ...state.agentPackageSkills];
  for (const reference of profile.skillRefs) {
    const skill = runtimeSkills.find((entry) => entry.id === reference.skillId);
    if (!skill || !isSkillUserInvocable(skill)) issues.push({ message: 'Skill 不可用：{name}', name: reference.skillId });
  }
  if (profile.teamProfile) {
    const team = normalizeTeamProfile(profile.teamProfile);
    const graph = team.graph ?? createTemplateTeamGraph(profile.teamTemplateId ?? 'general');
    const targets = graph.nodes.map((node) => getTeamNodeTarget(team, node));
    let external: Awaited<ReturnType<typeof getExternalAgentStatus>> | undefined;
    if (targets.some((target) => target.kind === 'external-agent')) {
      try { external = await getExternalAgentStatus(); } catch { /* 目录不可用以缺项显示，不泄露原生错误。 */ }
    }
    for (const target of targets) {
      if (target.kind === 'external-agent') {
        if (!external?.available || !external.models.some((model) => model.id === target.modelId)) issues.push({ message: '外部 Agent 不可用：{name}', name: target.modelId });
      } else if (!target.modelId || !resolveAssistantModel(projectId, target.modelId)) issues.push({ message: '文本模型不可用：{name}', name: target.modelId });
    }
  }
  const changes: CreationProfileNotice[] = [{ message: profile.contextPolicyRef === 'explicit-materials' ? '上下文仅使用本次明确材料' : '沿用项目上下文' },
    ...(profile.teamTemplateId ? [{ message: '采用组合包团队模板与角色默认值' }] : []),
    ...(profile.skillRefs.length ? [{ message: '固定 {count} 个显式 Skill', count: profile.skillRefs.length }] : []),
    ...(profile.toolAllowlist ? [{ message: '按组合包收窄工具范围' }] : [])];
  return { profile, selection, issues: [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()], changes };
}

export function findCreationProfile(selection: CreationProfileSelection | undefined): CreationProfile | undefined {
  if (!selection) return undefined;
  const raw = useAppStore.getState().config.creationProfiles?.find((entry) => entry.id === selection.id && entry.version === selection.version);
  if (!raw) throw new Error('选定组合包已移除或升级，请重新选择');
  return parseCreationProfile(raw);
}

export async function captureCreationProfile(selection: CreationProfileSelection | undefined, projectId: string): Promise<{
  snapshot?: CreationProfileSnapshot; profile?: CreationProfile; skillBindings: AgentSkillBinding[];
}> {
  if (selection === undefined) return { skillBindings: [] };
  const normalized = normalizeCreationProfileSelection(selection);
  if (!normalized) throw new Error('组合包选择无效，请重新应用');
  selection = normalized;
  const raw = findCreationProfile(selection)!;
  const preview = await previewCreationProfile(raw, projectId);
  if (preview.selection.sha256 !== selection.sha256) throw new Error('组合包内容已变化，请查看差异并重新应用');
  if (preview.issues.length) throw new Error(preview.issues.map((issue) => issue.message.replace('{name}', issue.name ?? '')).join('；'));
  const latest = findCreationProfile(selection)!;
  if ((await creationProfileSelection(latest)).sha256 !== selection.sha256) throw new Error('组合包在准备期间发生变化，请重新选择');
  const state = useAppStore.getState();
  const refs = raw.skillRefs.map((entry) => `@skill{${entry.skillId}|选定Skill}`).join(' ');
  const skillBindings = captureExplicitSkillBindings(refs, [...state.userSkills, ...state.agentPackageSkills]);
  if (skillBindings.length !== raw.skillRefs.length) throw new Error('组合包 Skill 在准备期间失效');
  return { profile: raw, skillBindings, snapshot: { ...selection, name: raw.name, contextPolicyRef: raw.contextPolicyRef,
    pluginRefs: structuredClone(raw.pluginRefs), agentPackageRefs: structuredClone(raw.agentPackageRefs), skillRefs: structuredClone(raw.skillRefs),
    ...(raw.toolAllowlist ? { toolAllowlist: [...raw.toolAllowlist] } : {}) } };
}

export function resolveCreationTeamProfile(selection: CreationProfileSelection | undefined, override?: AgentTeamProfile): AgentTeamProfile {
  return normalizeTeamProfile(selection
    ? override ?? findCreationProfile(selection)?.teamProfile ?? useAppStore.getState().config.agentTeamProfile
    : useAppStore.getState().config.agentTeamProfile);
}

export async function saveCreationProfile(value: unknown): Promise<CreationProfile> {
  const profile = parseCreationProfile(value);
  const state = useAppStore.getState();
  const previous = state.config.creationProfiles ?? [];
  const next = [...previous.filter((entry) => entry.id !== profile.id), profile];
  if (next.length > 64) throw new Error('最多保存 64 个创作组合包');
  state.updateConfig({ creationProfiles: next });
  if (!configValuesEqual(useAppStore.getState().config.creationProfiles, next)) throw new Error('设置暂不可修改，请稍后重试');
  try { await useAppStore.getState().saveConfig({ silent: true, throwOnError: true }); }
  catch (error) {
    if (configValuesEqual(useAppStore.getState().config.creationProfiles, next)) useAppStore.getState().updateConfig({ creationProfiles: previous });
    throw error;
  }
  return profile;
}

export async function removeCreationProfile(id: string): Promise<void> {
  const state = useAppStore.getState();
  const previous = state.config.creationProfiles ?? [];
  const next = previous.filter((entry) => entry.id !== id);
  state.updateConfig({ creationProfiles: next });
  if (!configValuesEqual(useAppStore.getState().config.creationProfiles, next)) throw new Error('设置暂不可修改，请稍后重试');
  try { await useAppStore.getState().saveConfig({ silent: true, throwOnError: true }); }
  catch (error) {
    if (configValuesEqual(useAppStore.getState().config.creationProfiles, next)) useAppStore.getState().updateConfig({ creationProfiles: previous });
    throw error;
  }
}

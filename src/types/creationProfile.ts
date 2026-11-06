/** 只引用已安装能力的创作组合包，不含源码、连接地址或凭据。 */
import type { AgentTeamProfile, TeamTemplateId } from './agentTeam';

export interface CreationProfileSelection { id: string; version: string; sha256: string }
export interface CreationProfileOption { id: string; version: string; name: string }

export interface CreationProfile {
  schemaVersion: 1;
  id: string;
  version: string;
  name: string;
  description?: string;
  pluginRefs: Array<{ pluginId: string; revisionDigest: string }>;
  agentPackageRefs: Array<{ packageId: string; contentHash: string }>;
  skillRefs: Array<{ skillId: string }>;
  teamTemplateId?: TeamTemplateId;
  teamProfile?: AgentTeamProfile;
  contextPolicyRef: 'project-default' | 'explicit-materials';
  /** 仅取交集，不能用组合包扩张模式/Skill/Registry 允许范围。 */
  toolAllowlist?: string[];
}

/** 任务启动时冻结；任务恢复不读取后来变动的全局目录。 */
export interface CreationProfileSnapshot extends CreationProfileSelection {
  name: string;
  contextPolicyRef: CreationProfile['contextPolicyRef'];
  pluginRefs: CreationProfile['pluginRefs'];
  agentPackageRefs: CreationProfile['agentPackageRefs'];
  skillRefs: CreationProfile['skillRefs'];
  toolAllowlist?: string[];
}

export interface CreationProfileNotice { message: string; name?: string; count?: number }

export interface CreationProfilePreview {
  profile: CreationProfile;
  selection: CreationProfileSelection;
  issues: CreationProfileNotice[];
  changes: CreationProfileNotice[];
}

export type CreationProfileChoicePreview = Omit<CreationProfilePreview, 'profile'> & { profile: CreationProfileOption };

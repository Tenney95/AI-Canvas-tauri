/** 项目内 Agent 过程资料的保留目录。旧任务仍引用原目录。 */
export const AGENT_PROJECT_WORKSPACE_DIRECTORY = '.agent-workspace';
export const AGENT_RESULT_DIRECTORY = 'agent-results';
export const AGENT_TEAM_DIRECTORY = 'agent-teams';

const legacyWorkspaceRoots = new Set([AGENT_RESULT_DIRECTORY, AGENT_TEAM_DIRECTORY]);
const publishedProjectRoot = /^(?:imports\/[a-z0-9][a-z0-9-]{0,109}-root-\d+|roots\/r2-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\//i;
const legacyScratchName = /^_(?:patch|verify|sync_docs|rebuild_props|upgrade_selfcheck)_[^/]+\.py$/i;

function agentProjectRelativePath(relativePath: string): string {
  let path = relativePath.replace(/\\/g, '/');
  // v4 会在导入或复制时保留原路径，并在前面加应用发布目录。
  while (publishedProjectRoot.test(path)) path = path.replace(publishedProjectRoot, '');
  return path;
}

function isAgentWorkspacePath(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  return legacyWorkspaceRoots.has(segments[0]) || segments.includes(AGENT_PROJECT_WORKSPACE_DIRECTORY);
}

export function isProjectAgentWorkspaceDirectory(relativePath: string): boolean {
  return isAgentWorkspacePath(agentProjectRelativePath(relativePath));
}

/** 兼容已落在作品根的过程脚本。这里只判定资源范围，文件来源仍由其创建方确认。 */
export function isProjectAgentInternalFile(relativePath: string): boolean {
  const path = agentProjectRelativePath(relativePath);
  const separator = path.lastIndexOf('/');
  return legacyScratchName.test(path) || (separator >= 0 && isAgentWorkspacePath(path.slice(0, separator)));
}

/** 读取端兼容旧任务引用，调用方仍须校验预期作用域、文件名和摘要。 */
export function agentWorkspaceArtifactRelativePath(relativePath: string): string {
  const prefix = `${AGENT_PROJECT_WORKSPACE_DIRECTORY}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : relativePath;
}

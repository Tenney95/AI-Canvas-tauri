/** 插件节点的内存级文本文件授权；绝对路径永不进入插件输入或持久化数据。 */
import {
  readAgentAuthorizedTextFile,
  selectAgentTextFiles,
} from '../fileService';
import type { PluginFileGrantSummary } from '../../types/plugin';

const MAX_SELECTED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 256 * 1024;

interface PluginFileGrant extends PluginFileGrantSummary {
  pluginId: string;
  nodeId: string;
  path: string;
}

const grants = new Map<string, PluginFileGrant>();

function summary(grant: PluginFileGrant): PluginFileGrantSummary {
  return {
    grantId: grant.grantId,
    displayName: grant.displayName,
    size: grant.size,
    extension: grant.extension,
  };
}

export async function authorizePluginTextFile(
  pluginId: string,
  nodeId: string,
): Promise<PluginFileGrantSummary | null> {
  const selected = (await selectAgentTextFiles('授权插件节点读取本地文本文件'))[0];
  if (!selected) return null;
  if (selected.size > MAX_SELECTED_FILE_BYTES) throw new Error('插件授权文件不能超过 2 MB');
  const grant: PluginFileGrant = {
    grantId: `plugin-file-${crypto.randomUUID()}`,
    pluginId,
    nodeId,
    path: selected.path,
    displayName: selected.fileName,
    size: selected.size,
    extension: selected.extension,
  };
  grants.set(grant.grantId, grant);
  return summary(grant);
}

export async function readPluginGrantedTextFile(
  pluginId: string,
  nodeId: string,
  grantId: string,
): Promise<{ file: PluginFileGrantSummary; content: string }> {
  const grant = grants.get(grantId);
  if (!grant || grant.pluginId !== pluginId || grant.nodeId !== nodeId) {
    throw new Error('插件文件授权不存在、已失效或不属于当前节点');
  }
  return {
    file: summary(grant),
    content: await readAgentAuthorizedTextFile(grant.path, MAX_READ_BYTES),
  };
}

export function clearPluginFileGrants(pluginId?: string, nodeIds?: ReadonlySet<string>): void {
  for (const [grantId, grant] of grants) {
    if (pluginId && grant.pluginId !== pluginId) continue;
    if (nodeIds && !nodeIds.has(grant.nodeId)) continue;
    grants.delete(grantId);
  }
}

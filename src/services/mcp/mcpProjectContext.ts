/** MCP发现与派发共用的上下文要求；权限仍由工具authorize决定。 */
import type { ProjectExpectedContext } from '../../types/project';
import type { AgentToolDefinition } from '../chat/toolRegistry';
import { isMcpGlobalTool } from './mcpSettingsScope';

export type McpProjectContextRequirement = 'global' | 'project' | 'episode' | 'canvas';

export function getMcpProjectContextRequirement(tool: Pick<AgentToolDefinition, 'id' | 'effect'>): McpProjectContextRequirement {
  if (isMcpGlobalTool(tool.id)) return 'global';
  if (tool.id === 'media_pending_tasks') return 'project';
  if (tool.id === 'episode_create_shotlist') return 'canvas';
  if (tool.id.startsWith('episode_') && tool.effect !== 'read') return 'episode';
  if (tool.id.startsWith('series_') || tool.id.startsWith('project_')) return 'project';
  if (tool.effect === 'media_generation' || /^(canvas_|shotlist_|director_|video_editor_|history_|comfyui_)/.test(tool.id)
    || tool.id.startsWith('media_') || tool.id.startsWith('plugin_window_') || tool.id.startsWith('plugin_node_')
    || ['file_import_media_to_canvas', 'file_media_download', 'file_media_upload', 'preset_apply', 'preset_run'].includes(tool.id)
    || tool.effect === 'canvas_write') return 'canvas';
  return 'project';
}

export function isMcpProjectContextCompatible(tool: Pick<AgentToolDefinition, 'id' | 'effect'>,
  context: ProjectExpectedContext, input?: Record<string, unknown>): boolean {
  if (tool.id === 'tools_search' || tool.id === 'tools_describe') return true;
  const requirement = getMcpProjectContextRequirement(tool);
  if (requirement === 'global') return context.kind === 'global';
  if (requirement === 'canvas') return context.kind === 'canvas';
  if (requirement === 'episode') return context.kind === 'episode'
    && (input?.episodeId === undefined || input.episodeId === context.episodeId);
  return context.kind !== 'global';
}

/** 应用级通用对话归属，不对应 CanvasProject，也不继承当前画布的能力。 */
export const GENERAL_ASSISTANT_SCOPE_ID = 'assistant-global';

const GENERAL_ASSISTANT_TOOLS = [
  'web_search', 'web_extract',
  'file_list_grants', 'file_read_text', 'file_write_text',
  'skill_search', 'skill_load', 'skill_read_file',
  'mcp_tools_search', 'mcp_tools_describe', 'mcp_read_tool', 'mcp_call_tool',
  'provider_docs_read', 'provider_models_select', 'provider_config_preview', 'provider_config_apply',
  'plugin_host_inspect', 'agent_result_read',
] as const;

export function isGeneralAssistantScope(projectId: string | null | undefined): boolean {
  return projectId === GENERAL_ASSISTANT_SCOPE_ID;
}

export function isGeneralAssistantTool(toolId: string): boolean {
  return GENERAL_ASSISTANT_TOOLS.some((id) => id === toolId);
}

/** Skill 的显式限制只能缩小通用范围。 */
export function resolveAssistantToolAllowlist(projectId: string, requested?: string[]): string[] | undefined {
  return isGeneralAssistantScope(projectId)
    ? GENERAL_ASSISTANT_TOOLS.filter((id) => requested === undefined || requested.includes(id))
    : requested;
}

export function isGeneralAssistantToolContext(
  context: { projectId: string; conversationId: string; toolAllowlist?: readonly string[] },
  toolId: string,
): boolean {
  return isGeneralAssistantScope(context.projectId)
    && context.conversationId.startsWith('conv-')
    && isGeneralAssistantTool(toolId)
    && !!context.toolAllowlist?.includes(toolId)
    && context.toolAllowlist?.every(isGeneralAssistantTool) === true;
}

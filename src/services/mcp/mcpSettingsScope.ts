/** 应用级 MCP 审计域：保留旧标识兼容历史，不创建 CanvasProject。 */
export const MCP_SETTINGS_SCOPE_ID = 'mcp-global-settings';
export const MCP_SETTINGS_CONVERSATION_ID = `mcp-control-${MCP_SETTINGS_SCOPE_ID}`;
export const MCP_SETTINGS_TOOL_NAMES = [
  'tools_search', 'tools_describe', 'provider_docs_read', 'provider_models_select',
  'provider_config_preview', 'provider_config_apply',
] as const;

/** 仅这些项目导航操作可以在启动页执行，项目写入工具仍须有效项目。 */
export const MCP_PROJECT_NAVIGATION_TOOL_NAMES = [
  'project_list', 'project_get', 'project_open', 'project_switch',
] as const;
export const MCP_GLOBAL_TOOL_NAMES = [
  ...MCP_SETTINGS_TOOL_NAMES, ...MCP_PROJECT_NAVIGATION_TOOL_NAMES,
] as const;

interface Scope {
  projectId: string;
  conversationId: string;
  toolAllowlist?: readonly string[];
}

export function isMcpSettingsTool(name: string): boolean {
  return MCP_SETTINGS_TOOL_NAMES.some((value) => value === name);
}

export function isMcpGlobalTool(name: string): boolean {
  return MCP_GLOBAL_TOOL_NAMES.some((value) => value === name);
}

export function isMcpGlobalContext(context: Scope): boolean {
  return context.projectId === MCP_SETTINGS_SCOPE_ID
    && context.conversationId === MCP_SETTINGS_CONVERSATION_ID
    && Boolean(context.toolAllowlist?.length)
    && context.toolAllowlist!.every(isMcpGlobalTool);
}

export function isMcpGlobalToolContext(context: Scope, toolName: string): boolean {
  return isMcpGlobalContext(context) && isMcpGlobalTool(toolName)
    && context.toolAllowlist!.includes(toolName);
}

export function isMcpSettingsContext(context: Scope): boolean {
  return context.projectId === MCP_SETTINGS_SCOPE_ID
    && context.conversationId === MCP_SETTINGS_CONVERSATION_ID
    && Boolean(context.toolAllowlist?.length)
    && context.toolAllowlist!.every(isMcpSettingsTool);
}

export function isMcpSettingsToolContext(context: Scope, toolName: string): boolean {
  return isMcpSettingsContext(context) && isMcpSettingsTool(toolName)
    && context.toolAllowlist!.includes(toolName);
}

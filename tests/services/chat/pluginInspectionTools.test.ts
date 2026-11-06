import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({ installedPlugins: [] }) } }));
import { registerPluginInspectionTools } from '../../../src/services/chat/tools/pluginInspectionTools';
import { getAgentTool, type AgentToolContext } from '../../../src/services/chat/toolRegistry';

let unregisters: Array<() => void> = [];
afterEach(() => { unregisters.forEach((unregister) => unregister()); unregisters = []; });
describe('readonly plugin inspection tool', () => {
  it('registers read-only and returns bounded public contracts without task lookup', async () => {
    unregisters = registerPluginInspectionTools();
    const tool = getAgentTool('plugin_host_inspect')!;
    expect(tool.effect).toBe('read');
    const context: AgentToolContext = { taskId: '', projectId: 'project', conversationId: 'conversation', mode: 'plan', signal: new AbortController().signal };
    const result = await tool.execute(context, { section: 'host' });
    expect(result.status).toBe('success');
    expect(JSON.parse(result.modelContent).entries[0].id).toBe('host');
    expect(result.modelContent).not.toContain('apiKey');
    const cancelled = new AbortController(); cancelled.abort();
    expect((await tool.execute({ ...context, signal: cancelled.signal }, {})).status).toBe('error');
  });
});

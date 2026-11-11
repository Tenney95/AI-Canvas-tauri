/** MCP SDK 加载与真实协议校验不得依赖 eval/Function。 */
import { describe, expect, it, vi } from 'vitest';

// 只隔离宿主能力，协议 SDK 和 Zod 使用真实实现。
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: vi.fn(), subscribe: vi.fn() } }));
vi.mock('../../src/store/store.utils', () => ({ seriesOwnerId: vi.fn() }));
vi.mock('../../src/services/chat/assistantScope', () => ({ isGeneralAssistantScope: vi.fn() }));
vi.mock('../../src/services/providerSecretService', () => ({ deleteAppSecret: vi.fn(), writeAppSecret: vi.fn() }));
vi.mock('../../src/services/configPersistenceQueue', () => ({ areSettingsMutationsFrozen: vi.fn(), registerSettingsProducer: vi.fn() }));

describe('MCP SDK strict CSP', () => {
  it('先配置无 JIT 模式再加载真实 SDK，禁止动态代码时仍严格校验协议', async () => {
    vi.resetModules();
    const core = await import('zod/v4/core');
    const originalJitless = core.config().jitless;
    core.config({ jitless: false });
    const denyDynamicCode = vi.fn((): never => { throw new EvalError('CSP blocks dynamic code'); });
    // 保留 Function.prototype 等普通语言行为，只禁止调用/构造动态代码。
    vi.stubGlobal('Function', new Proxy(globalThis.Function, { apply: denyDynamicCode, construct: denyDynamicCode }));
    try {
      await import('../../src/services/mcp/mcpClientService');
      const { ListToolsResultSchema, CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
      expect(core.config().jitless).toBe(true);
      expect(ListToolsResultSchema.safeParse({ tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] }).success).toBe(true);
      expect(ListToolsResultSchema.safeParse({ tools: [{ name: 7, inputSchema: { type: 'object' } }] }).success).toBe(false);
      expect(CallToolResultSchema.safeParse({ content: [{ type: 'text', text: 'result' }] }).success).toBe(true);
      expect(CallToolResultSchema.safeParse({ content: [{ type: 'text', text: 7 }] }).success).toBe(false);
      expect(denyDynamicCode).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      core.config({ jitless: originalJitless });
      vi.resetModules();
    }
  });
});

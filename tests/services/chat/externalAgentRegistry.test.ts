import { beforeEach, describe, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), desktop: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke }));
vi.mock('../../../src/services/fs/core', () => ({ isTauriEnv: () => bridge.desktop }));
import { getExternalAgentCatalog, getExternalAgentStatus, readExternalAgentCatalog, unavailableExternalAgentStatus } from '../../../src/services/chat/externalAgents/externalAgentRegistry';

beforeEach(() => { bridge.invoke.mockReset(); bridge.desktop = true; });
describe('外部执行器公开目录', () => {
  it('Web 环境明确不可用且不会尝试原生命令', async () => {
    bridge.desktop = false;
    const status = await getExternalAgentStatus();
    expect(status.available).toBe(false);
    expect(status.errorCode).toBe('CODEX_DESKTOP_REQUIRED');
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it('目录只带公开能力及身份摘要，不扩展宿主工具权限', async () => {
    bridge.invoke.mockResolvedValue({ ...unavailableExternalAgentStatus(), registered: true,
      executionFingerprint: 'f'.repeat(64), models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] });
    const [provider] = await getExternalAgentCatalog();
    expect(provider.capabilities).toMatchObject({ oneShot: true, hostTools: false, resume: false, fork: false, inheritsParentContext: false });
    expect(provider).not.toHaveProperty('executable');
    expect(provider).not.toHaveProperty('key');
    expect(bridge.invoke).toHaveBeenCalledWith('codex_runtime_status');
    provider.models[0].name = 'locally changed';
    expect(readExternalAgentCatalog()[0].models[0].name).toBe('GPT-6.1 Sol');
  });
});

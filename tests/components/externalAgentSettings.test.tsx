// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({ status: vi.fn(), write: vi.fn(), remove: vi.fn(), register: vi.fn(), configure: vi.fn(), removeRuntime: vi.fn(), t: (key: string) => key }));
vi.mock('../../src/i18n', () => ({ useT: () => host.t }));
vi.mock('../../src/services/providerSecretService', () => ({ writeAppSecret: host.write, deleteAppSecret: host.remove }));
vi.mock('../../src/services/chat/externalAgents/externalAgentRegistry', () => ({
  getExternalAgentStatus: host.status, registerCodexRuntime: host.register, configureCodexRuntime: host.configure, removeCodexRuntime: host.removeRuntime,
}));
import ExternalAgentSettings from '../../src/components/settings/ExternalAgentSettings';
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  host.status.mockReset().mockResolvedValue({ registered: true, version: '0.167.0', configured: true, compatible: true, available: false, enabled: false });
  host.configure.mockReset(); host.write.mockReset().mockResolvedValue(true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe('外部执行器设置', () => {
  it('显式说明进程信任与费用边界，启用仅发送布尔开关', async () => {
    await act(async () => root.render(<ExternalAgentSettings />));
    expect(container.textContent).toContain('不构成系统沙箱');
    expect(container.textContent).toContain('不复用 ChatGPT 订阅额度');
    host.configure.mockResolvedValue({ registered: true, enabled: true, available: true, configured: true, compatible: true, version: '0.167.0' });
    const enable = [...container.querySelectorAll('button')].find((button) => button.textContent === '启用执行器');
    await act(async () => enable?.click());
    expect(host.configure).toHaveBeenCalledWith(true);
    expect(host.status.mock.calls).toHaveLength(1);
  });
});

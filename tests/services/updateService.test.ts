import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  downloadAndInstall: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubGlobal('window', { __TAURI__: {} });
  mocks.downloadAndInstall.mockResolvedValue(undefined);
  mocks.relaunch.mockResolvedValue(undefined);
  mocks.check.mockResolvedValue({
    version: '0.8.18',
    downloadAndInstall: mocks.downloadAndInstall,
  });
});

describe('downloadAndInstallUpdate', () => {
  it('安装完成后等待应用重启', async () => {
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');

    await expect(downloadAndInstallUpdate()).resolves.toBe(true);
    expect(mocks.downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.downloadAndInstall.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.relaunch.mock.invocationCallOrder[0]);
  });

  it('重启失败时向调用方返回失败', async () => {
    mocks.relaunch.mockRejectedValue(new Error('restart denied'));
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');

    await expect(downloadAndInstallUpdate()).resolves.toBe(false);
  });
});

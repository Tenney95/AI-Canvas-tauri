import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadEvent } from '@tauri-apps/plugin-updater';
import type { AppUpdateProgress } from '../../src/services/updateService';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  downloadAndInstall: vi.fn(),
  relaunch: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }));
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class { onmessage?: (event: DownloadEvent) => void },
  invoke: mocks.invoke,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  vi.stubGlobal('window', { __TAURI__: {} });
  mocks.downloadAndInstall.mockResolvedValue(undefined);
  mocks.relaunch.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (_command: string, args: { onEvent: { onmessage: (event: DownloadEvent) => void } }) =>
    mocks.downloadAndInstall(args.onEvent.onmessage));
  mocks.check.mockResolvedValue({
    rid: 42,
    version: '0.8.18',
    downloadAndInstall: mocks.downloadAndInstall,
  });
});

describe('downloadAndInstallUpdate', () => {
  it('安装完成后等待应用重启', async () => {
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');

    await expect(downloadAndInstallUpdate()).resolves.toBe(true);
    expect(mocks.downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith('download_app_update', { rid: 42, onEvent: expect.any(Object) });
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.downloadAndInstall.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.relaunch.mock.invocationCallOrder[0]);
  });

  it('重启失败时向调用方返回失败', async () => {
    mocks.relaunch.mockRejectedValue(new Error('restart denied'));
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');

    await expect(downloadAndInstallUpdate()).resolves.toBe(false);
  });

  it('累计原生分块字节，并区分下载、安装与重启阶段', async () => {
    const snapshots: AppUpdateProgress[] = [];
    mocks.downloadAndInstall.mockImplementation(async (onEvent: (event: DownloadEvent) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 1000 } });
      onEvent({ event: 'Progress', data: { chunkLength: 250 } });
      onEvent({ event: 'Progress', data: { chunkLength: 750 } });
      onEvent({ event: 'Finished' });
    });
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');

    await expect(downloadAndInstallUpdate((progress) => snapshots.push(progress))).resolves.toBe(true);

    expect(snapshots).toContainEqual(expect.objectContaining({ phase: 'downloading', downloadedBytes: 250, totalBytes: 1000 }));
    expect(snapshots).toContainEqual(expect.objectContaining({ phase: 'installing', downloadedBytes: 1000, totalBytes: 1000 }));
    expect(snapshots.slice(-2).map(({ phase }) => phase)).toEqual(['restarting', 'complete']);
  });

  it('服务器未提供总大小时只报告真实已下载字节', async () => {
    const snapshots: AppUpdateProgress[] = [];
    mocks.downloadAndInstall.mockImplementation(async (onEvent: (event: DownloadEvent) => void) => {
      onEvent({ event: 'Started', data: {} });
      onEvent({ event: 'Progress', data: { chunkLength: 32 } });
      onEvent({ event: 'Progress', data: { chunkLength: -10 } });
      onEvent({ event: 'Progress', data: { chunkLength: Number.NaN } });
      onEvent({ event: 'Finished' });
    });
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');

    await downloadAndInstallUpdate((progress) => snapshots.push(progress));

    expect(snapshots.find(({ phase }) => phase === 'installing')).toMatchObject({ downloadedBytes: 32 });
    expect(snapshots.every(({ totalBytes }) => totalBytes === undefined)).toBe(true);
  });

  it('两个更新入口共享一次下载安装', async () => {
    let finishDownload: (() => void) | undefined;
    mocks.downloadAndInstall.mockReturnValue(new Promise<void>((resolve) => { finishDownload = resolve; }));
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');

    const first = downloadAndInstallUpdate();
    const second = downloadAndInstallUpdate();
    expect(second).toBe(first);
    finishDownload?.();

    await expect(first).resolves.toBe(true);
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(mocks.downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });

  it('重启失败时保留准确阶段提示', async () => {
    mocks.relaunch.mockRejectedValue(new Error('restart denied'));
    const snapshots: AppUpdateProgress[] = [];
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');

    await expect(downloadAndInstallUpdate((progress) => snapshots.push(progress))).resolves.toBe(false);
    expect(snapshots.at(-1)).toMatchObject({ phase: 'error', message: '重启失败，请手动重启应用' });
  });
});

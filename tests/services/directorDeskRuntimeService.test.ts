import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));

import {
  DIRECTOR_DESK_INSTALL_PROGRESS_EVENT,
  cancelDirectorDeskInstall,
  getDirectorDeskRuntimeStatus,
  installDirectorDeskRuntime,
  removeDirectorDeskRuntime,
  subscribeDirectorDeskInstallProgress,
} from '../../src/services/directorDeskRuntimeService';

describe('directorDeskRuntimeService', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
  });

  it('maps runtime lifecycle operations to Tauri commands', async () => {
    mocks.invoke.mockResolvedValue({ installed: false });

    await getDirectorDeskRuntimeStatus();
    await installDirectorDeskRuntime();
    await cancelDirectorDeskInstall();
    await removeDirectorDeskRuntime();

    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      'director_desk_runtime_status',
      'install_director_desk_runtime',
      'cancel_director_desk_install',
      'remove_director_desk_runtime',
    ]);
  });

  it('subscribes to typed install progress events', async () => {
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValue(unlisten);
    const handler = vi.fn();

    await subscribeDirectorDeskInstallProgress(handler);

    expect(mocks.listen).toHaveBeenCalledWith(
      DIRECTOR_DESK_INSTALL_PROGRESS_EVENT,
      expect.any(Function),
    );
    const eventHandler = mocks.listen.mock.calls[0]?.[1] as (event: { payload: unknown }) => void;
    eventHandler({
      payload: { stage: 'downloading', transferredBytes: 10, totalBytes: 100 },
    });
    expect(handler).toHaveBeenCalledWith({
      stage: 'downloading',
      transferredBytes: 10,
      totalBytes: 100,
    });
  });
});

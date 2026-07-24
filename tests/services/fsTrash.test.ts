import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  exists: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  writeFile: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  notifyProjectDiskChanged: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => fsMocks);
vi.mock('@tauri-apps/api/core', () => ({ invoke: coreMocks.invoke }));
vi.mock('../../src/services/fs/core', () => ({
  getProjectDataDir: vi.fn(),
  isTauriEnv: () => true,
  joinPath: (...parts: string[]) => parts.join('/'),
  notifyProjectDiskChanged: coreMocks.notifyProjectDiskChanged,
}));

import {
  moveToUndoTrash,
  restoreFromUndoTrash,
} from '../../src/services/fs/trash';

describe('undo trash media moves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.rename.mockResolvedValue(undefined);
    coreMocks.invoke.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('renames media into undo trash and back without reading file contents', async () => {
    const originalPath = 'D:/project/media/generated-video.mp4';

    await moveToUndoTrash(originalPath);

    expect(fsMocks.mkdir).toHaveBeenCalledWith('D:/project/media/.trash', { recursive: true });
    expect(fsMocks.rename).toHaveBeenCalledTimes(1);
    const trashPath = fsMocks.rename.mock.calls[0]?.[1] as string;
    expect(trashPath).toMatch(/^D:\/project\/media\/\.trash\/\d+-generated-video\.mp4$/);
    expect(fsMocks.readFile).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(fsMocks.remove).not.toHaveBeenCalled();
    expect(coreMocks.notifyProjectDiskChanged).toHaveBeenCalledOnce();

    await expect(restoreFromUndoTrash(originalPath)).resolves.toBe(true);

    expect(fsMocks.rename).toHaveBeenNthCalledWith(2, trashPath, originalPath);
    expect(fsMocks.readFile).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(coreMocks.notifyProjectDiskChanged).toHaveBeenCalledTimes(2);
  });

  it('falls back to the system trash when the atomic rename fails', async () => {
    const originalPath = 'D:/project/media/locked-video.mp4';
    fsMocks.rename.mockRejectedValueOnce(new Error('file is locked'));

    await moveToUndoTrash(originalPath);

    expect(coreMocks.invoke).toHaveBeenCalledWith('move_to_trash', { path: originalPath });
    expect(fsMocks.readFile).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    await expect(restoreFromUndoTrash(originalPath)).resolves.toBe(false);
  });
});

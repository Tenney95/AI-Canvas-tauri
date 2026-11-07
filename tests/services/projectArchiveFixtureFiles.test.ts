import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectArchiveFixtureDirectory } from '../../src/services/fs/projectArchiveFixtureFiles';
const mocks = vi.hoisted(() => ({ lease: vi.fn(), verify: vi.fn(), mkdir: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: async () => 'fixture-data' }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async () => false, lstat: vi.fn(), mkdir: mocks.mkdir }));
vi.mock('../../src/services/projectModelNativeSafety', () => ({ getProjectModelMaintenanceLease: mocks.lease, verifyProjectModelMaintenanceLease: mocks.verify }));
beforeEach(() => {
  vi.clearAllMocks(); mocks.lease.mockResolvedValue({ leaseId: 'lease', profileId: 'p5', productionAllowed: false, mode: 'isolated-fixture', coldStart: true });
  mocks.verify.mockResolvedValue(undefined);
});
describe('P5 fixture file boundary', () => {
  it('rejects production database names and unsafe relative paths before any native lease call', async () => {
    await expect(projectArchiveFixtureDirectory('AI-Canvas', 'safe')).rejects.toThrow('fixture');
    await expect(projectArchiveFixtureDirectory('ai-canvas-model-fixture-p5', '../outside')).rejects.toThrow();
    expect(mocks.lease).not.toHaveBeenCalled(); expect(mocks.mkdir).not.toHaveBeenCalled();
  });
  it('refuses a different profile and reverifies the cold lease even when a source directory is missing', async () => {
    await expect(projectArchiveFixtureDirectory('ai-canvas-model-fixture-other', 'assets')).rejects.toThrow('隔离');
    expect(mocks.mkdir).not.toHaveBeenCalled();
    await projectArchiveFixtureDirectory('ai-canvas-model-fixture-p5', 'incoming/assets');
    expect(mocks.verify).toHaveBeenCalledTimes(2);
  });
});

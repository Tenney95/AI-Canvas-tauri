/**
 * coreDataDir — 默认目录查询合并、失败恢复与自定义目录实时切换。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ appDataDir: vi.fn() }));
vi.mock('@tauri-apps/api/path', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/api/path')>(),
  appDataDir: paths.appDataDir,
}));

beforeEach(() => {
  vi.resetModules();
  paths.appDataDir.mockReset().mockResolvedValue('/app');
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('default storage directory', () => {
  it('coalesces concurrent path queries and reuses a successful system directory', async () => {
    let resolve!: (directory: string) => void;
    paths.appDataDir.mockImplementation(() => new Promise<string>((finish) => { resolve = finish; }));
    const core = await import('../../../src/services/fs/core');
    const requests = [core.getDefaultBaseDir(), core.getBaseDir(), core.getProjectDataDir('project')];
    // 路径调用在微任务内启动，让所有入口共享同一次查询。
    await Promise.resolve();
    expect(paths.appDataDir).toHaveBeenCalledOnce();
    resolve('/app');
    expect(await Promise.all(requests)).toEqual(['/app/data', '/app/data', '/app/data/project']);
    expect(await core.getProjectDataDir('another')).toBe('/app/data/another');
    expect(await core.getDefaultBaseDir()).toBe('/app/data');
    expect(paths.appDataDir).toHaveBeenCalledOnce();
  });

  it.each(['rejection', 'throw', 'empty'] as const)('does not retain an unsuccessful %s query', async (failure) => {
    if (failure === 'rejection') paths.appDataDir.mockRejectedValueOnce(new Error('unavailable'));
    else if (failure === 'throw') paths.appDataDir.mockImplementationOnce(() => { throw new Error('unavailable'); });
    else paths.appDataDir.mockResolvedValueOnce('');
    const core = await import('../../../src/services/fs/core');
    expect(await Promise.all([core.getDefaultBaseDir(), core.getProjectDataDir('project')])).toEqual([null, null]);
    expect(paths.appDataDir).toHaveBeenCalledOnce();
    expect(await core.getDefaultBaseDir()).toBe('/app/data');
    expect(await core.getProjectDataDir('project')).toBe('/app/data/project');
    expect(paths.appDataDir).toHaveBeenCalledTimes(2);
  });

  it('checks the runtime before querying or returning a cached system directory', async () => {
    vi.stubGlobal('window', {});
    const core = await import('../../../src/services/fs/core');
    expect(await core.getDefaultBaseDir()).toBeNull();
    expect(paths.appDataDir).not.toHaveBeenCalled();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    expect(await core.getDefaultBaseDir()).toBe('/app/data');
    vi.stubGlobal('window', {});
    expect(await core.getDefaultBaseDir()).toBeNull();
    expect(paths.appDataDir).toHaveBeenCalledOnce();
  });

  it('keeps custom roots and project folder mappings live without invalidating the system directory', async () => {
    const core = await import('../../../src/services/fs/core');
    core.setBaseDataDir('/custom');
    core.registerProjectFolder('episode', 'series');
    expect(await core.getBaseDir()).toBe('/custom');
    expect(await core.getProjectDataDir('episode')).toBe('/custom/series');
    expect(paths.appDataDir).not.toHaveBeenCalled();
    expect(await core.getDefaultBaseDir()).toBe('/app/data');
    core.setBaseDataDir('/moved');
    core.registerProjectFolder('episode', 'renamed');
    expect(await core.getProjectDataDir('episode')).toBe('/moved/renamed');
    core.setBaseDataDir(undefined);
    expect(await core.getBaseDir()).toBe('/app/data');
    expect(await core.getProjectDataDir('episode')).toBe('/app/data/renamed');
    expect(paths.appDataDir).toHaveBeenCalledOnce();
  });

  it('does not let a pending default query replace a newly chosen custom root', async () => {
    let resolve!: (directory: string) => void;
    paths.appDataDir.mockImplementation(() => new Promise<string>((finish) => { resolve = finish; }));
    const core = await import('../../../src/services/fs/core');
    const defaultQuery = core.getDefaultBaseDir();
    await Promise.resolve();
    core.setBaseDataDir('/chosen');
    expect(await core.getBaseDir()).toBe('/chosen');
    resolve('/app');
    expect(await defaultQuery).toBe('/app/data');
    expect(await core.getBaseDir()).toBe('/chosen');
    expect(await core.getProjectDataDir('project')).toBe('/chosen/project');
  });
});

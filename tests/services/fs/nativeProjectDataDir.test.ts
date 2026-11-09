import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn(), appDataDir: vi.fn(async () => '/app') }));
vi.mock('@tauri-apps/api/core', async (original) => ({
  ...await original<typeof import('@tauri-apps/api/core')>(), invoke: native.invoke,
}));
vi.mock('@tauri-apps/api/path', async (original) => ({
  ...await original<typeof import('@tauri-apps/api/path')>(), appDataDir: native.appDataDir,
}));

const projectId = 'p2-12345678-1234-4123-8123-123456789abc';
const canvasId = 'c2-12345678-1234-4123-8123-123456789abc';
const episodeId = 'e2-12345678-1234-4123-8123-123456789abc';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  native.invoke.mockReset().mockResolvedValue('/bound/project');
});
afterEach(() => vi.unstubAllGlobals());

describe('新旧项目素材根路由', () => {
  it('新建透传项目名，实体可读目录由原生绑定返回，读取时不按显示名重新拼路径', async () => {
    const core = await import('../../../src/services/fs/core');
    const directory = '/bound/新项目结构测试-12345678';
    native.invoke.mockResolvedValue(directory);
    core.registerNativeProjectFolders([{ id: canvasId, projectId }]);
    expect(await core.claimNativeProjectDataDir(projectId, '新项目结构测试')).toBe(directory);
    expect(await core.getProjectDataDir(canvasId)).toBe(directory);
    expect(native.invoke).toHaveBeenNthCalledWith(1, 'claim_native_project_media_root', { projectId, projectName: '新项目结构测试' });
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'resolve_native_project_media_root', { projectId });
  });

  it('搜索窗口只使用专用只读命令，主窗口同步显式作品列表', async () => {
    const core = await import('../../../src/services/fs/core');
    await core.syncNativeAssetSearchRoots([projectId]);
    core.registerNativeProjectFolders([{ id: canvasId, projectId }]);
    core.activateNativeAssetSearchContext();
    expect(await core.getProjectDataDir(canvasId)).toBe('/bound/project');
    expect(native.invoke).toHaveBeenNthCalledWith(1, 'sync_native_asset_search_roots', { projectIds: [projectId] });
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'resolve_asset_search_native_project_root', { projectId });
  });
  it('通过显式作品与画布绑定解析原生素材根，不回退旧目录', async () => {
    const core = await import('../../../src/services/fs/core');
    core.registerNativeProjectFolders([projectId, canvasId, episodeId].map((id) => ({ id, projectId })));
    expect(await core.claimNativeProjectDataDir(projectId)).toBe('/bound/project');
    expect(await core.getProjectDataDir(canvasId)).toBe('/bound/project');
    expect(await core.ensureProjectDataDir(episodeId)).toBe('/bound/project');
    expect(native.invoke).toHaveBeenNthCalledWith(1, 'claim_native_project_media_root', { projectId });
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'resolve_native_project_media_root', { projectId });
    expect(native.invoke).toHaveBeenNthCalledWith(3, 'resolve_native_project_media_root', { projectId });
    expect(core.isSharedProjectDataDir(canvasId)).toBe(true);
  });

  it('未确认的候选 ID 不落旧根，真正同形旧 ID 显式登记后保持旧路径', async () => {
    const core = await import('../../../src/services/fs/core');
    await expect(core.getProjectDataDir(canvasId)).rejects.toThrow('身份尚未确认');
    core.registerProjectFolder(canvasId, undefined);
    expect(await core.getProjectDataDir(canvasId)).toBe(`/app/data/${canvasId}`);
    expect(() => core.registerNativeProjectFolders([{ id: canvasId, projectId }])).toThrow('身份冲突');
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it('原生根不可用时不静默回退；批量绑定冲突不提交部分映射', async () => {
    const core = await import('../../../src/services/fs/core');
    core.registerProjectFolder(episodeId, 'old');
    expect(() => core.registerNativeProjectFolders([{ id: canvasId, projectId }, { id: episodeId, projectId }])).toThrow();
    await expect(core.getProjectDataDir(canvasId)).rejects.toThrow('身份尚未确认');
    core.registerNativeProjectFolders([{ id: canvasId, projectId }]);
    native.invoke.mockRejectedValueOnce(new Error('root unavailable'));
    await expect(core.ensureProjectDataDir(canvasId)).rejects.toThrow('root unavailable');
  });
});

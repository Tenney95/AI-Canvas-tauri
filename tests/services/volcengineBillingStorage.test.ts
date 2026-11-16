/**
 * volcengineBillingStorage — 回归测试：billing storage follows the file save root。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configured = { providers: {
  'official-ark': { name: '火山方舟', catalogId: 'volcengine', apiKey: 'fixture-ark-key' },
} };

const driver = vi.hoisted(() => ({
  desktop: true, getBaseDir: vi.fn(), invoke: vi.fn(), mkdir: vi.fn(), dispatchEvent: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: driver.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({ mkdir: driver.mkdir }));
vi.mock('../../src/services/fs/core', () => ({
  getBaseDir: driver.getBaseDir,
  isTauriEnv: () => driver.desktop,
  joinPath: (...parts: string[]) => parts.join('/'),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: vi.fn() } }));

beforeEach(() => {
  vi.resetModules();
  driver.desktop = true;
  driver.getBaseDir.mockReset().mockResolvedValue('/files');
  driver.invoke.mockReset().mockImplementation(async (command: string) => command === 'billing_has_history'
    ? false : '/files/billing/volcengine-usage.sqlite');
  driver.mkdir.mockReset().mockResolvedValue(undefined);
  driver.dispatchEvent.mockReset();
  vi.stubGlobal('window', { dispatchEvent: driver.dispatchEvent });
});
afterEach(() => vi.unstubAllGlobals());

describe('billing storage follows the file save root', () => {
  it('P4 owner汇总把退役Canvas alias原值交给SQLite统一分页，不逐集分页拼装或重写账本', async () => {
    const { queryOwnerBillingRuns } = await import('../../src/services/billing/volcengineBillingService');
    await queryOwnerBillingRuns('S', [
      { namespace: 'legacy-canvas', legacyId: 'A', projectId: 'S', canvasId: 'A', sourceEpoch: 1, storageRootRef: 'root' },
      { namespace: 'legacy-canvas', legacyId: 'B', projectId: 'S', canvasId: 'B', sourceEpoch: 2, storageRootRef: 'root', retired: true },
    ], { modelType: 'video' }, 3, 30);
    expect(driver.invoke).toHaveBeenCalledOnce();
    expect(driver.invoke).toHaveBeenCalledWith('billing_query', { filter: { appProjectIds: ['A', 'B'], modelType: 'video' }, page: 3, pageSize: 30 });
    expect(driver.mkdir).not.toHaveBeenCalled();
  });
  it('uses the billing subdirectory, avoids redundant migrations and follows root changes', async () => {
    const { syncBillingStoragePath } = await import('../../src/services/billing/volcengineBillingService');
    await syncBillingStoragePath(configured);
    await syncBillingStoragePath(configured);
    expect(driver.mkdir).toHaveBeenCalledWith('/files/billing', { recursive: true });
    expect(driver.invoke).toHaveBeenCalledTimes(1);
    expect(driver.invoke).toHaveBeenCalledWith('billing_set_storage_path', { path: '/files/billing' });
    driver.getBaseDir.mockResolvedValue('/new-files');
    await syncBillingStoragePath(configured);
    expect(driver.invoke).toHaveBeenLastCalledWith('billing_set_storage_path', { path: '/new-files/billing' });
    expect(driver.dispatchEvent).toHaveBeenCalledTimes(2);
  });

  it('keeps an explicitly selected billing directory without creating a default folder', async () => {
    const { setBillingStoragePath, syncBillingStoragePath } = await import('../../src/services/billing/volcengineBillingService');
    await setBillingStoragePath('/custom-billing');
    await syncBillingStoragePath({ volcengineBillingPath: '/custom-billing' });
    expect(driver.invoke).toHaveBeenCalledTimes(1);
    expect(driver.getBaseDir).not.toHaveBeenCalled();
    expect(driver.mkdir).not.toHaveBeenCalled();
  });

  it('allows retry after a failed migration and does not publish a path change', async () => {
    const { syncBillingStoragePath } = await import('../../src/services/billing/volcengineBillingService');
    driver.invoke.mockRejectedValueOnce('目标目录中已存在火山方舟账本，请先选择其他目录');
    await expect(syncBillingStoragePath(configured)).rejects.toThrow('目标目录中已存在火山方舟账本，请先选择其他目录');
    expect(driver.dispatchEvent).not.toHaveBeenCalled();
    await syncBillingStoragePath(configured);
    expect(driver.invoke).toHaveBeenCalledTimes(2);
    expect(driver.dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('does not access the native ledger in Web mode', async () => {
    driver.desktop = false;
    const { hasBillingHistory, syncBillingStoragePath } = await import('../../src/services/billing/volcengineBillingService');
    expect(await hasBillingHistory()).toBe(false);
    await syncBillingStoragePath(configured);
    expect(driver.getBaseDir).not.toHaveBeenCalled();
    expect(driver.invoke).not.toHaveBeenCalled();
    expect(driver.mkdir).not.toHaveBeenCalled();
  });

  it('没有火山连接和历史账本时只探测存在性，不创建、查询或迁移账本', async () => {
    const { syncBillingStoragePath } = await import('../../src/services/billing/volcengineBillingService');
    await syncBillingStoragePath({ providers: {} });
    expect(driver.invoke).toHaveBeenCalledExactlyOnceWith('billing_has_history', { path: '/files/billing' });
    expect(driver.mkdir).not.toHaveBeenCalled();
    expect(driver.dispatchEvent).not.toHaveBeenCalled();
  });

  it('历史入口使用同一只读探测，不通过查询记录造出空账本', async () => {
    const { hasBillingHistory } = await import('../../src/services/billing/volcengineBillingService');
    expect(await hasBillingHistory()).toBe(false);
    driver.invoke.mockResolvedValueOnce(true);
    expect(await hasBillingHistory({ volcengineBillingPath: '/custom-billing' })).toBe(true);
    expect(driver.invoke.mock.calls).toEqual([
      ['billing_has_history', { path: '/files/billing' }],
      ['billing_has_history', { path: '/custom-billing' }],
    ]);
    expect(driver.mkdir).not.toHaveBeenCalled();
    expect(driver.dispatchEvent).not.toHaveBeenCalled();
  });

  it('删除火山连接但有历史账本时仍跟随根目录同步，不能遗落旧账本', async () => {
    const { syncBillingStoragePath } = await import('../../src/services/billing/volcengineBillingService');
    driver.invoke.mockResolvedValueOnce(true);
    await syncBillingStoragePath({ providers: {} });
    expect(driver.invoke.mock.calls).toEqual([
      ['billing_has_history', { path: '/files/billing' }],
      ['billing_set_storage_path', { path: '/files/billing' }],
    ]);
    expect(driver.mkdir).toHaveBeenCalledExactlyOnceWith('/files/billing', { recursive: true });
    expect(driver.dispatchEvent).toHaveBeenCalledOnce();
  });

  it('已保存 API Key 引用的真实火山连接仍同步，不因明文尚未读取而漏掉', async () => {
    const { syncBillingStoragePath } = await import('../../src/services/billing/volcengineBillingService');
    await syncBillingStoragePath({ providers: {
      'my-ark': { name: '方舟', catalogId: 'volcengine', apiKey: '', apiKeyRef: 'secret:provider/my-ark' },
    } });
    expect(driver.invoke).toHaveBeenCalledExactlyOnceWith('billing_set_storage_path', { path: '/files/billing' });
  });

  it.each([
    { label: '同名自定义', providers: { volcengine: { name: '同名自定义', catalogId: 'custom-openai', apiKey: 'fixture-relay-key' } } },
    { label: '没有凭据的空火山条目', providers: { volcengine: { name: '尚未配置的火山', catalogId: 'volcengine', apiKey: '' } } },
  ])('$label 不触发同步', async ({ providers }) => {
    const { syncBillingStoragePath } = await import('../../src/services/billing/volcengineBillingService');
    await syncBillingStoragePath({ providers });
    expect(driver.invoke).toHaveBeenCalledExactlyOnceWith('billing_has_history', { path: '/files/billing' });
    expect(driver.mkdir).not.toHaveBeenCalled();
  });

  it('没有历史账本时不初始化单独配置的空目录，探测失败也不继续写入', async () => {
    const { syncBillingStoragePath } = await import('../../src/services/billing/volcengineBillingService');
    await syncBillingStoragePath({ volcengineBillingPath: '/custom-billing' });
    expect(driver.getBaseDir).not.toHaveBeenCalled();
    expect(driver.invoke).toHaveBeenCalledExactlyOnceWith('billing_has_history', { path: '/custom-billing' });
    driver.invoke.mockRejectedValueOnce('原账本无法读取');
    await expect(syncBillingStoragePath({ volcengineBillingPath: '/custom-billing' })).rejects.toThrow('原账本无法读取');
    expect(driver.invoke.mock.calls.every(([command]) => command === 'billing_has_history')).toBe(true);
    expect(driver.mkdir).not.toHaveBeenCalled();
    expect(driver.dispatchEvent).not.toHaveBeenCalled();
  });

  it('目录创建失败会给出具体权限分类，不回显本机路径和原始 cause', async () => {
    const { getBillingStorageErrorMessage, syncBillingStoragePath } = await import('../../src/services/billing/volcengineBillingService');
    driver.mkdir.mockRejectedValueOnce(new Error('permission denied: C:\\private-fixture\\billing'));
    const error: unknown = await syncBillingStoragePath(configured).catch((cause: unknown) => cause);
    expect(getBillingStorageErrorMessage(error)).toBe('账本目录没有读写权限，请检查文件夹权限');
    expect(error).toMatchObject({ message: '账本目录没有读写权限，请检查文件夹权限' });
    expect(error).not.toHaveProperty('cause');
    expect(driver.invoke).not.toHaveBeenCalled();
    expect(driver.dispatchEvent).not.toHaveBeenCalled();
  });

  it('未知原生错误不回显路径、签名或凭据，也不发布成功事件', async () => {
    const { getBillingStorageErrorMessage, setBillingStoragePath } = await import('../../src/services/billing/volcengineBillingService');
    const raw = 'unexpected private C:\\private-fixture\\ledger key=private-fixture-key';
    driver.invoke.mockRejectedValueOnce(new Error(raw));
    const error: unknown = await setBillingStoragePath('/custom-billing').catch((cause: unknown) => cause);
    expect(getBillingStorageErrorMessage(error)).toBe('账本目录同步失败，未能识别具体原因，请重试或更新桌面应用');
    expect(error).not.toHaveProperty('cause');
    expect(error).toMatchObject({ message: '账本目录同步失败，未能识别具体原因，请重试或更新桌面应用' });
    expect(String(error)).not.toContain('private-fixture');
    expect(driver.dispatchEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['no space left on device (os error 28)', '磁盘空间不足，无法保存账本'],
    ['read-only file system', '账本目录为只读，请选择可写目录'],
  ])('原生 %s 经目录切换、同步和提示多层处理仍保留具体分类', async (raw, reason) => {
    const { getBillingStorageErrorMessage, syncBillingStoragePath } = await import('../../src/services/billing/volcengineBillingService');
    driver.invoke.mockRejectedValueOnce(new Error(raw));
    const error: unknown = await syncBillingStoragePath(configured).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ message: reason });
    expect(getBillingStorageErrorMessage(error)).toBe(reason);
    expect(driver.invoke).toHaveBeenCalledExactlyOnceWith('billing_set_storage_path', { path: '/files/billing' });
    expect(driver.dispatchEvent).not.toHaveBeenCalled();
  });
});

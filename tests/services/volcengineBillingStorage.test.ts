import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  driver.invoke.mockReset().mockResolvedValue('/files/billing/volcengine-usage.sqlite');
  driver.mkdir.mockReset().mockResolvedValue(undefined);
  driver.dispatchEvent.mockReset();
  vi.stubGlobal('window', { dispatchEvent: driver.dispatchEvent });
});
afterEach(() => vi.unstubAllGlobals());

describe('billing storage follows the file save root', () => {
  it('uses the billing subdirectory, avoids redundant migrations and follows root changes', async () => {
    const { syncBillingStoragePath } = await import('../../src/services/billing/volcengineBillingService');
    await syncBillingStoragePath({});
    await syncBillingStoragePath({});
    expect(driver.mkdir).toHaveBeenCalledWith('/files/billing', { recursive: true });
    expect(driver.invoke).toHaveBeenCalledTimes(1);
    expect(driver.invoke).toHaveBeenCalledWith('billing_set_storage_path', { path: '/files/billing' });
    driver.getBaseDir.mockResolvedValue('/new-files');
    await syncBillingStoragePath({});
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
    driver.invoke.mockRejectedValueOnce('目录不可写');
    await expect(syncBillingStoragePath({})).rejects.toThrow('目录不可写');
    expect(driver.dispatchEvent).not.toHaveBeenCalled();
    await syncBillingStoragePath({});
    expect(driver.invoke).toHaveBeenCalledTimes(2);
    expect(driver.dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('does not access the native ledger in Web mode', async () => {
    driver.desktop = false;
    const { syncBillingStoragePath } = await import('../../src/services/billing/volcengineBillingService');
    await syncBillingStoragePath({});
    expect(driver.getBaseDir).not.toHaveBeenCalled();
    expect(driver.invoke).not.toHaveBeenCalled();
    expect(driver.mkdir).not.toHaveBeenCalled();
  });
});

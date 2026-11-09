import { beforeEach, expect, it, vi } from 'vitest';
import { museInvoke } from '../../src/services/museService';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => true }));
beforeEach(() => native.invoke.mockReset());

it('有限原生分类保留原因，未知IPC对象和过长正文不进入公开异常链', async () => {
  native.invoke.mockRejectedValueOnce('Muse 登录已失效');
  await expect(museInvoke('muse_auth_status')).rejects.toMatchObject({ message: 'Muse 登录已失效', cause: 'Muse 登录已失效' });
  const hidden = { cookie: 'fixture-private-cookie', nested: new Error('fixture-private-details') };
  for (const failure of [hidden, 'fixture-private-oversized'.repeat(30)]) {
    native.invoke.mockRejectedValueOnce(failure);
    await expect(museInvoke('muse_auth_status')).rejects.toMatchObject({
      message: 'Muse 原生操作失败，请在设置中检查登录状态', cause: 'Muse 原生操作失败，请在设置中检查登录状态',
    });
  }
});

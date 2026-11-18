import { beforeEach, expect, it, vi } from 'vitest';
import { recycleRetiredNativeProjectDirectory } from '../../src/services/fs/nativeProjectRecycle';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), transition: vi.fn(), scan: vi.fn(), trash: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/services/indexedDb/nativeProjectRepository', () => ({ transitionNativeProjectRecycle: mocks.transition }));
vi.mock('../../src/services/fs/nativeProjectRecycleReferences', () => ({ assertNativeProjectRecycleReferences: mocks.scan }));
vi.mock('../../src/services/fs/trash', () => ({ moveToTrash: mocks.trash }));

const projectId = 'p2-12345678-1234-4abc-9abc-123456789abc';
const requestId = '02345678-1234-4abc-9abc-123456789abc';
const originalRoot = 'F:/素材/隔离示例-12345678';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.invoke.mockResolvedValue(originalRoot);
  mocks.transition.mockResolvedValue(true);
  mocks.scan.mockResolvedValue(() => {});
  mocks.trash.mockResolvedValue(undefined);
});

it('核对目录与引用并消费删除回执后，才尝试一次系统回收', async () => {
  const assertCurrent = vi.fn();
  await expect(recycleRetiredNativeProjectDirectory(projectId, requestId, originalRoot, assertCurrent)).resolves.toBe('recycled');
  expect(mocks.invoke).toHaveBeenCalledWith('resolve_native_project_media_root', { projectId });
  expect(mocks.scan).toHaveBeenCalledWith(projectId, originalRoot);
  expect(mocks.transition.mock.calls).toEqual([
    [projectId, requestId, 'pending', 'recycling'], [projectId, requestId, 'recycling', 'recycled'],
  ]);
  expect(mocks.scan.mock.invocationCallOrder[0]).toBeLessThan(mocks.trash.mock.invocationCallOrder[0]);
  expect(mocks.transition.mock.invocationCallOrder[0]).toBeLessThan(mocks.trash.mock.invocationCallOrder[0]);
  expect(mocks.trash).toHaveBeenCalledExactlyOnceWith(originalRoot, { throwOnError: true, nativeProjectId: projectId });
  expect(assertCurrent).toHaveBeenCalledTimes(2);
});

it('归属变化、引用检查失败或回执已被消费时，不移动目录', async () => {
  mocks.invoke.mockResolvedValueOnce('F:/不匹配');
  await expect(recycleRetiredNativeProjectDirectory(projectId, requestId, originalRoot, () => {})).resolves.toBe('retained');
  expect(mocks.scan).not.toHaveBeenCalled();
  mocks.scan.mockRejectedValueOnce(new Error('有恢复引用'));
  await expect(recycleRetiredNativeProjectDirectory(projectId, requestId, originalRoot, () => {})).resolves.toBe('retained');
  mocks.transition.mockResolvedValueOnce(false);
  await expect(recycleRetiredNativeProjectDirectory(projectId, requestId, originalRoot, () => {})).resolves.toBe('retained');
  expect(mocks.trash).not.toHaveBeenCalled();
});

it('回收失败时只确认仍具备原归属的目录已保留', async () => {
  mocks.trash.mockRejectedValueOnce(new Error('系统回收失败'));
  await expect(recycleRetiredNativeProjectDirectory(projectId, requestId, originalRoot, () => {})).resolves.toBe('retained');
  expect(mocks.transition).toHaveBeenLastCalledWith(projectId, requestId, 'recycling', 'retained');
  mocks.transition.mockClear();
  mocks.invoke.mockResolvedValueOnce(originalRoot).mockRejectedValueOnce(new Error('目录不可核对'));
  mocks.trash.mockRejectedValueOnce(new Error('IPC 中断'));
  await expect(recycleRetiredNativeProjectDirectory(projectId, requestId, originalRoot, () => {})).resolves.toBe('unconfirmed');
  expect(mocks.transition.mock.calls).toEqual([[projectId, requestId, 'pending', 'recycling']]);
});

it('回收记录认领期间出现新引用时，重新保护目录', async () => {
  mocks.scan.mockResolvedValueOnce(() => { throw new Error('出现新的进行中复制'); });
  await expect(recycleRetiredNativeProjectDirectory(projectId, requestId, originalRoot, () => {})).resolves.toBe('retained');
  expect(mocks.transition).toHaveBeenLastCalledWith(projectId, requestId, 'recycling', 'retained');
  expect(mocks.trash).not.toHaveBeenCalled();
});

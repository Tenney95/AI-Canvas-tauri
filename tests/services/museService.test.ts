import { beforeEach, describe, expect, it, vi } from 'vitest';
import { museInvoke, queryMuseTask } from '../../src/services/museService';
import { PollTaskFailedError } from '../../src/services/pollTask';

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

const TASK_ID = '04779e97-4d73-4cd6-84cf-96c0af450249';
const NOT_SENT = 'Muse 原任务在网页发送前已结束，尚未发送生成请求';
const LEGACY_FAILED = 'Muse 旧任务已被本机标记为失败，请核对原网页；该记录未保存官网失败原因';
const DELIVERY_UNCONFIRMED = 'Muse 尚未确认新对话已送达，原任务已保留；不会自动重发';

function expectOnlyOriginalQuery() {
  expect(native.invoke.mock.calls).toEqual([['muse_query', { taskId: TASK_ID }]]);
}

describe('Muse 原任务查询分类', () => {
  it('只有明确未发送的 failed 可作为本地可清理终态，不宣称官网生成失败', async () => {
    native.invoke.mockResolvedValueOnce({ status: 'failed', error: NOT_SENT });
    const failure = await queryMuseTask(TASK_ID, 'video').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PollTaskFailedError);
    expect(failure).toMatchObject({ message: NOT_SENT });
    expectOnlyOriginalQuery();
  });

  it.each([undefined, LEGACY_FAILED, 'fixture-private-cookie', { message: 'fixture-private-cookie' }, `${NOT_SENT}: fixture-private-cookie`])(
    '旧 failed 不具有明确未发送证据时仅提示本机旧标记 %#', async (error) => {
      native.invoke.mockResolvedValueOnce({ status: 'failed', error });
      const failure = await queryMuseTask(TASK_ID, 'video').catch((reason: unknown) => reason);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(PollTaskFailedError);
      expect(failure).toMatchObject({ message: LEGACY_FAILED });
      expect(failure).not.toHaveProperty('cause');
      expectOnlyOriginalQuery();
    },
  );

  it.each([
    DELIVERY_UNCONFIRMED,
    'Muse 网页返回了拒绝生成说明，尚未取得媒体；请查看原任务，可继续查询',
    'Muse 会话出现额外轮次或文本超过 256 KiB，请在官网查看原回复；不会重新发送',
  ])('unknown 仅透传精确白名单原因，并保留原任务 %#', async (error) => {
    native.invoke.mockResolvedValueOnce({ status: 'unknown', error });
    const failure = await queryMuseTask(TASK_ID, 'video').catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PollTaskFailedError);
    expect(failure).toMatchObject({ message: error });
    expectOnlyOriginalQuery();
  });

  it.each(['prepared', 'ready', 'unknown'])('%s 中未知原生正文不进入公开异常，不自动补发', async (status) => {
    for (const error of [undefined, null, 'fixture-private-cookie', { cookie: 'fixture-private-cookie' },
      new Error('fixture-private-cookie'), `${DELIVERY_UNCONFIRMED}: fixture-private-cookie`, NOT_SENT]) {
      native.invoke.mockClear();
      native.invoke.mockResolvedValueOnce({ status, error });
      const failure = await queryMuseTask(TASK_ID, 'image').catch((reason: unknown) => reason);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(PollTaskFailedError);
      expect(failure).toMatchObject({ message: DELIVERY_UNCONFIRMED });
      expect(failure).not.toHaveProperty('cause');
      expectOnlyOriginalQuery();
    }
  });

  it('completed 沿用媒体类型校验，不因附加未知错误丢弃媒体', async () => {
    const url = 'data:image/png;base64,iVBORw0KGgo=';
    native.invoke.mockResolvedValueOnce({ status: 'completed', url, error: { cookie: 'fixture-private-cookie' } });
    await expect(queryMuseTask(TASK_ID, 'image')).resolves.toBe(url);
    expectOnlyOriginalQuery();
  });

  it('completed 缺少视频媒体时保留原任务，不把图片封面当视频', async () => {
    native.invoke.mockResolvedValueOnce({ status: 'completed', url: 'data:image/png;base64,iVBORw0KGgo=' });
    const failure = await queryMuseTask(TASK_ID, 'video').catch((reason: unknown) => reason);
    expect(failure).toMatchObject({ message: 'Muse 原任务没有可交付的受支持媒体，原任务保留' });
    expect(failure).not.toBeInstanceOf(PollTaskFailedError);
    expectOnlyOriginalQuery();
  });

  it('已取消的续查不发起任何原生请求', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(queryMuseTask(TASK_ID, 'video', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(native.invoke).not.toHaveBeenCalled();
  });
});

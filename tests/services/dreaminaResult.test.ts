/** 即梦原任务查询与有序产物交付。 */
import { expect, it, vi } from 'vitest';
import { queryDreaminaResult } from '../../src/services/dreaminaResult';
import { generateDreaminaVideo } from '../../src/services/dreaminaService';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://local${path}`),
}));
vi.mock('@tauri-apps/api/core', async (original) => ({
  ...await original<typeof import('@tauri-apps/api/core')>(),
  ...tauri,
}));

const submitId = 'dreamina-original-result-fixture';
const results = {
  status: 'success',
  outputs: [
    { localPath: '/cache/first.mp4', url: 'https://files.example/remote-first.mp4' },
    { localPath: '', url: 'https://files.example/second.mp4' },
    { localPath: '/cache/third.mp4', url: '' },
  ],
};

it('submits a video once and reads the task ID returned by the same submission', async () => {
  const originalId = `dreamina-${crypto.randomUUID()}`;
  tauri.invoke.mockResolvedValueOnce({ submitId: originalId }).mockResolvedValueOnce(results);

  await expect(generateDreaminaVideo({ model: 'dreamina/seedance2.5', prompt: '生成视频', references: [] }))
    .resolves.toEqual({ url: 'asset://local/cache/first.mp4' });
  expect(tauri.invoke.mock.calls).toEqual([
    ['dreamina_generate', { params: expect.objectContaining({ kind: 'text2video' }) }],
    ['dreamina_query_result', { submitId: originalId }],
  ]);
});

it('queries the original submitId, prefers a local result and keeps the original output order', async () => {
  tauri.invoke.mockResolvedValueOnce(results);

  await expect(queryDreaminaResult(submitId)).resolves.toEqual([
    'asset://local/cache/first.mp4',
    'https://files.example/second.mp4',
    'asset://local/cache/third.mp4',
  ]);
  expect(tauri.invoke.mock.calls).toEqual([['dreamina_query_result', { submitId }]]);
});

it('can return only the first output for callers that display a single result', async () => {
  tauri.invoke.mockResolvedValueOnce(results);

  await expect(queryDreaminaResult(submitId, { firstOnly: true })).resolves.toEqual(['asset://local/cache/first.mp4']);
  expect(tauri.invoke.mock.calls).toEqual([['dreamina_query_result', { submitId }]]);
});

it('uses the caller’s safe message for confirmed task failure', async () => {
  tauri.invoke.mockResolvedValueOnce({ status: 'failed', outputs: [], failReason: 'supplier detail' });

  await expect(queryDreaminaResult(submitId, { failureMessage: '原转场任务已失败' }))
    .rejects.toMatchObject({ name: 'PollTaskFailedError', message: '原转场任务已失败' });
  expect(tauri.invoke.mock.calls).toEqual([['dreamina_query_result', { submitId }]]);
});

it('ignores the late result after canceling the local wait and can query the same original ID again', async () => {
  let settleQuery!: (value: typeof results) => void;
  tauri.invoke.mockImplementationOnce(() => new Promise<typeof results>((resolve) => { settleQuery = resolve; }));
  const controller = new AbortController();
  const pending = queryDreaminaResult(submitId, { signal: controller.signal });
  await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledOnce());
  const canceled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await canceled;
  settleQuery(results);
  expect(tauri.convertFileSrc).not.toHaveBeenCalled();
  tauri.invoke.mockResolvedValueOnce(results);

  await expect(queryDreaminaResult(submitId, { firstOnly: true })).resolves.toEqual(['asset://local/cache/first.mp4']);
  expect(tauri.convertFileSrc).toHaveBeenCalledExactlyOnceWith('/cache/first.mp4');
  expect(tauri.invoke.mock.calls).toEqual([
    ['dreamina_query_result', { submitId }],
    ['dreamina_query_result', { submitId }],
  ]);
});

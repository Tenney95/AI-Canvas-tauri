import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { MediaReference } from '../../src/types/aiTypes';
import { prepareRelayonVideoUpload } from '../../src/services/ai/providers/relayonVideoUpload';
import { prepareBeatApiReferences } from '../../src/services/ai/providers/sandAssetUpload';

const native = vi.hoisted(() => ({ invoke: vi.fn(), desktop: false }));
vi.mock('@tauri-apps/api/core', async (load) => ({
  ...await load<typeof import('@tauri-apps/api/core')>(), invoke: native.invoke,
}));
vi.mock('../../src/services/fs/core', async (load) => ({
  ...await load<typeof import('../../src/services/fs/core')>(), isTauriEnv: () => native.desktop,
}));

const endpoint = 'https://api.relayonapi.com/v1/videos';
const reference = (kind: MediaReference['kind'], url: string): MediaReference => ({ kind, url, origin: 'connection', role: 'reference' });
const image = (base64: string) => reference('image', 'data:image/png;base64,' + base64);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(() => { native.desktop = false; native.invoke.mockReset(); vi.unstubAllGlobals(); });

it('纯 HTTPS 参考沿用 URL 协议，全程不下载文件', async () => {
  const network = vi.fn(); vi.stubGlobal('fetch', network);
  expect(await prepareRelayonVideoUpload([reference('video', 'https://media.example/clip.mp4')])).toBeUndefined();
  expect(network).not.toHaveBeenCalled();
  expect(native.invoke).not.toHaveBeenCalled();
});

it('BeatAPI 只上传同一个本地文件一次并保留首尾帧角色', async () => {
  native.desktop = true;
  const url = 'https://files.beatapi.io/u/image.png';
  native.invoke.mockImplementation(async (command: string) => {
    if (command === 'seal_relayon_video_upload') return [{ mimeType: 'image/png', bytes: 9, sha256: digest('image') }];
    if (command === 'submit_relayon_video_upload') {
      return { status: 201, body: JSON.stringify({ data: { url } }), headers: [] };
    }
  });
  const source = reference('image', 'file:///fixture/source.png');
  const prepared = await prepareBeatApiReferences([
    { ...source, role: 'first_frame' }, { ...source, role: 'last_frame' },
  ], 'fixture-key', () => {});
  expect(prepared.map((entry) => [entry.role, entry.url])).toEqual([['first_frame', url], ['last_frame', url]]);
  expect(native.invoke.mock.calls.filter(([name]) => name === 'submit_relayon_video_upload')).toEqual([
    ['submit_relayon_video_upload', expect.objectContaining({ url: 'https://api.beatapi.io/v1/files',
      parts: [{ name: 'file', fileIndex: 0, filename: 'reference.png' }] })],
  ]);
  expect(native.invoke.mock.calls.filter(([name]) => name === 'append_relayon_video_upload')).toHaveLength(0);
});

it('Web 表单按原序交付文件，其他类型的 HTTPS 引用保留单个 JSON 字段', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{"task_id":"original"}'));
  vi.stubGlobal('fetch', fetch);
  const first = { ...image('YQ=='), sourceUrl: 'https://media.example/old.png', filePath: '/old.png' };
  const remote = { ...reference('audio', 'https://media.example/preview.mp3'), sourceUrl: 'https://media.example/input.mp3' };
  const prepared = (await prepareRelayonVideoUpload([first, image('Yg=='), remote, first]))!;
  try {
    const [a, b, audio, repeated] = prepared.references;
    expect(a).toMatchObject({ url: 'relayon-file:0:image/png', sourceUrl: undefined, filePath: undefined });
    expect(repeated.url).toBe(a.url);
    expect(audio.url).toBe(remote.sourceUrl);
    const body = { prompt: '两张图', images: [{ $file: a.url, filename: 'image-1.png' }, { $file: b.url, filename: 'image-2.png' }],
      references: [[{ type: 'audio', url: audio.url }]] };
    const fingerprint = await prepared.fingerprint(body);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await prepared.fingerprint({ ...body, images: [...body.images].reverse() })).not.toBe(fingerprint);
    const response = await prepared.submit(endpoint, { method: 'POST', headers: {
      'Content-Type': 'multipart/form-data; boundary=unused', Authorization: 'Bearer fixture',
    } }, body);
    expect(response.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Headers).has('content-type')).toBe(false);
    expect((init.headers as Headers).get('authorization')).toBe('Bearer fixture');
    const form = init.body as FormData;
    expect(form.getAll('references')).toEqual([JSON.stringify(body.references[0])]);
    const files = form.getAll('images') as File[];
    expect(files.map((file) => [file.name, file.type])).toEqual([['image-1.png', 'image/png'], ['image-2.png', 'image/png']]);
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(['a', 'b']);
    await expect(prepared.submit(endpoint, {}, body)).rejects.toThrow('已经提交');
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { await prepared.release(); }
});

it('桌面只传授权路径与同类远程来源，大文件指纹采用快照字节和摘要', async () => {
  native.desktop = true;
  const local = reference('video', 'asset://localhost/%2Ffixture%2Fsource.mp4');
  const remote = reference('video', 'https://public.example/b.mp4');
  const size = 800 * 1024 * 1024;
  const files = [{ mimeType: 'video/mp4', bytes: size, sha256: digest('a') },
    { mimeType: 'video/mp4', bytes: size, sha256: digest('b') }];
  native.invoke.mockImplementation(async (command: string) => {
    if (command === 'seal_relayon_video_upload') return files;
    if (command === 'submit_relayon_video_upload') return { status: 429, body: '{"error":"limit"}', headers: [['Retry-After', '12']] };
  });
  const prepared = (await prepareRelayonVideoUpload([local, remote]))!;
  const body = { videos: { $file: prepared.references.map((ref) => ref.url), filename: 'ref.mp4' } };
  try {
    const id = native.invoke.mock.calls[0][1].requestId;
    expect(native.invoke.mock.calls[0]).toEqual(['prepare_relayon_video_upload', { requestId: id, sources: [
      expect.objectContaining({ kind: 'video', path: '/fixture/source.mp4' }),
      expect.objectContaining({ kind: 'video', remoteUrl: remote.url }),
    ] }]);
    const fields = files.map((file) => ['videos', 'file', 'ref.mp4', file.mimeType, file.bytes, file.sha256]);
    expect(await prepared.fingerprint(body)).toBe(digest(JSON.stringify(['relayon-video-upload-v1', fields])));
    const response = await prepared.submit(endpoint, { method: 'POST' }, body);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('12');
    expect(await response.json()).toEqual({ error: 'limit' });
    expect(native.invoke).toHaveBeenCalledWith('submit_relayon_video_upload', {
      requestId: id, url: endpoint, headers: [], parts: files.map((_, fileIndex) => ({ name: 'videos', fileIndex, filename: 'ref.mp4' })),
    });
  } finally { await Promise.all([prepared.release(), prepared.release()]); }
  expect(native.invoke.mock.calls.some(([name]) => name === 'cancel_relayon_video_upload')).toBe(false);
  expect(native.invoke.mock.calls.some(([name]) => name === 'append_relayon_video_upload')).toBe(false);
});

it.each(['校验拒绝', '上传中取消'] as const)('桌面提交发生%s时只清理一次快照', async (stage) => {
  native.desktop = true;
  const cancel = new AbortController();
  native.invoke.mockImplementation(async (command: string) => {
    if (command === 'seal_relayon_video_upload') return [{ mimeType: 'video/mp4', bytes: 8, sha256: digest('a') }];
    if (command === 'submit_relayon_video_upload') {
      if (stage === '校验拒绝') throw new Error('原生校验失败');
      cancel.abort();
      // 请求已发出时，取消和服务器响应可能先后到达。
      return { status: 200, body: '{"task_id":"original"}' };
    }
  });
  const prepared = (await prepareRelayonVideoUpload([reference('video', 'file:///fixture/source.mp4')]))!;
  const submit = prepared.submit(endpoint, { method: 'POST' }, { video: { $file: prepared.references[0].url } }, cancel.signal);
  if (stage === '校验拒绝') await expect(submit).rejects.toThrow('原生校验失败');
  else expect(await (await submit).json()).toEqual({ task_id: 'original' });
  await Promise.all([prepared.release(), prepared.release()]);
  expect(native.invoke.mock.calls.filter(([name]) => name === 'cancel_relayon_video_upload')).toHaveLength(1);
});

it('内联数据按块传输，中途取消会清理快照并停止提交', async () => {
  native.desktop = true;
  const controller = new AbortController();
  native.invoke.mockImplementation(async (name: string) => {
    if (name === 'append_relayon_video_upload') controller.abort();
  });
  const encoded = Buffer.alloc(600 * 1024, 37).toString('base64');
  await expect(prepareRelayonVideoUpload([image(encoded)], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(native.invoke.mock.calls.map(([name]) => name)).toEqual([
    'prepare_relayon_video_upload', 'append_relayon_video_upload', 'cancel_relayon_video_upload',
  ]);
  const chunk = native.invoke.mock.calls[1][1].chunk as string;
  expect(Buffer.from(chunk, 'base64').length).toBeLessThanOrEqual(256 * 1024);
});

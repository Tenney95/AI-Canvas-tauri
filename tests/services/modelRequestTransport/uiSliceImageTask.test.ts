import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';
import { openDB, STORE_METADATA } from '../../../src/services/indexedDb/schema';
import { generateUiSliceImage, type UiSliceImageDestination } from '../../../src/services/plugins/pluginUiSliceImageTask';
import { jsonResponse, setupTransportFixture } from './transportFixture';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), persist: vi.fn(), verifyFile: vi.fn() }));
vi.mock('../../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.fetch, logAiResponse: vi.fn() }));
vi.mock('../../../src/services/nativeMediaResultPersistence', () => ({ persistNativeMediaResult: mocks.persist }));
vi.mock('../../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: mocks.verifyFile }));
vi.mock('../../../src/services/fileService', async (load) => ({
  ...await load<typeof import('../../../src/services/fileService')>(), getProjectDataDir: async () => 'project',
  getAssetUrlFromPath: async () => 'asset://localhost/project/image.png',
}));
vi.mock('../../../src/services/fs/imageSourceBlob', () => ({ readImageSourceBlob: async () => new Blob(['png']) }));

setupTransportFixture(mocks.fetch);
const preview = 'data:image/png;base64,cHJldmlldw==';
const reference = 'data:image/png;base64,aW1hZ2U=';
const params = { model: 'general/slice-test', provider: 'general', prompt: '金色按钮', image_urls: [reference] };
const target = (): UiSliceImageDestination => ({ sourceSha256: 'a'.repeat(64), selection: '{"index":1}', sourceWidth: 1200,
  sourceHeight: 1600, description: '原图中的金色按钮', candidates: new Map() });
let sourceNode: string;
const generate = (destination: UiSliceImageDestination) => generateUiSliceImage(params, sourceNode, destination, new AbortController().signal, () => {});
beforeEach(() => {
  sourceNode = crypto.randomUUID();
  useAppStore.setState((state) => ({
    currentProjectId: 'canvas', projectLoadStatus: 'ready', projectExecutionContext: { kind: 'canvas', schemaVersion: 2, modelGeneration: 1,
      projectId: 'project', projectEpoch: 1, canvasId: 'canvas', canvasEpoch: 1, canvasRevision: 1, episodeId: null },
    config: { ...state.config, generalModels: [{ id: 'slice-test', name: '切图', modelId: 'fixture', category: 'image',
      providerConfigId: 'slice-provider', imageReferenceRequestMode: 'generation-json-image-data-urls' }],
      providers: { ...state.config.providers, 'slice-provider': { name: '测试', catalogId: 'custom-openai',
        apiKey: 'fixture-secret', baseUrl: 'https://fixture.example/v1' } } },
  }));
  mocks.persist.mockReset().mockResolvedValue({ sha256: 'b'.repeat(64), relativePath: 'media/' + 'b'.repeat(64) + '.png', bytes: 4321 });
  mocks.verifyFile.mockReset();
  vi.stubGlobal('Image', class { naturalWidth = 800; naturalHeight = 400; async decode() {} });
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => preview }) });
});
afterEach(() => vi.unstubAllGlobals());

async function replaceReceipt(operationId: string, change: (row: Record<string, unknown>) => void) {
  const database = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_METADATA, 'readwrite');
    const cursor = transaction.objectStore(STORE_METADATA).openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) { transaction.abort(); return; }
      if (entry.value.operationId !== operationId) { entry.continue(); return; }
      const row = entry.value;
      change(row);
      entry.update(row);
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('缺少测试回执'));
  });
}

it('同一素材并发点击只提交一次，预览期间关闭后可复取原图', async () => {
  const destination = target();
  const controller = new AbortController();
  let releaseDecode!: () => void;
  let decoding!: () => void;
  const enteredDecode = new Promise<void>((resolve) => { decoding = resolve; });
  const waitDecode = new Promise<void>((resolve) => { releaseDecode = resolve; });
  vi.stubGlobal('Image', class { naturalWidth = 800; naturalHeight = 400; async decode() { decoding(); await waitDecode; } });
  mocks.fetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/original.png' }] }));
  const pending = generateUiSliceImage(params, sourceNode, destination, controller.signal, () => {});
  await enteredDecode;
  await expect(generate(destination)).rejects.toThrow('正在进行');
  controller.abort();
  releaseDecode();
  await expect(pending).rejects.toThrow();
  expect(destination.candidates.size).toBe(0);
  await expect(generate(destination)).resolves.toMatchObject({ url: preview });
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it('取消发生在回执落盘和实际发送之间时，可重新发起首次提交', async () => {
  const controller = new AbortController();
  const put = IDBObjectStore.prototype.put;
  const intercept = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === STORE_METADATA && value.status === 'submitted') controller.abort();
    return put.call(this, value, key);
  });
  try {
    await expect(generateUiSliceImage(params, sourceNode, target(), controller.signal, () => {})).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  } finally { intercept.mockRestore(); }
  mocks.fetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/retry.png' }] }));
  await expect(generate(target())).resolves.toMatchObject({ url: preview });
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it('保存前另一窗口已完成同一作业时，迟到的结果不能覆盖回执', async () => {
  const persisted = { relativePath: 'media/' + 'c'.repeat(64) + '.png', bytes: 2150, sha256: 'c'.repeat(64) };
  mocks.persist.mockImplementationOnce(async (_url, _canvas, options) => {
    await replaceReceipt(options.label.slice('UI切图-'.length), (row) => {
      row.status = 'saved';
      row.file = persisted;
      row.revision = Number(row.revision ?? 0) + 1;
    });
    return { ...persisted, bytes: 123 };
  });
  mocks.fetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/image.png' }] }));
  await expect(generate(target())).rejects.toThrow('已更新');
  const restored = target();
  const result = await generate(restored);
  expect(restored.candidates.get(result.uiSliceCandidateId)?.file).toEqual(persisted);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it('已保存回执缺少原图信息时保留现场且不再次提交', async () => {
  mocks.fetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/image.png' }] }));
  const result = await generate(target());
  await replaceReceipt(result.uiSliceCandidateId, (row) => { delete row.file; });
  await expect(generate(target())).rejects.toThrow('回执');
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it('可复用无修订号的旧回执，模型改绑后按新模型执行', async () => {
  mocks.fetch.mockImplementation(async () => jsonResponse({ data: [{ url: 'https://cdn.example/image.png' }] }));
  const original = await generate(target());
  await replaceReceipt(original.uiSliceCandidateId, (row) => { delete row.revision; });
  expect(await generate(target())).toEqual(original);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  useAppStore.setState((state) => ({ config: { ...state.config, generalModels: state.config.generalModels!.map(
    (model) => model.id === 'slice-test' ? { ...model, modelId: 'replacement' } : model) } }));
  const result = await generate(target());
  expect(result.uiSliceCandidateId).not.toBe(original.uiSliceCandidateId);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).model).toBe('replacement');
});

it('原生切图逐项提交，复取已保存原图，显式重生才再次付费', async () => {
  mocks.fetch.mockResolvedValue(jsonResponse({ data: [{ url: 'https://cdn.example/a.png' }] }));
  const first = target();
  const result = await generate(first);
  expect(result).toMatchObject({ url: preview, width: 800, height: 400 });
  expect(first.candidates.get(result.uiSliceCandidateId)).toMatchObject({ prompt: params.prompt, model: params.model, previewSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    selection: first.selection, file: { bytes: 4321 } });
  expect(JSON.stringify(first.candidates.get(result.uiSliceCandidateId))).not.toContain(preview);
  expect(JSON.parse(String(mocks.fetch.mock.calls[0][1].body))).toMatchObject({ prompt: params.prompt, n: 1 });
  expect(JSON.stringify(mocks.fetch.mock.calls[0][1].body)).toContain(reference);
  expect(await generate(target())).toEqual(result);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  mocks.fetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/b.png' }] }));
  const second = await generate({ ...target(), selection: '{"index":2}' });
  expect(second.uiSliceCandidateId).not.toBe(result.uiSliceCandidateId);
  mocks.fetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/c.png' }] }));
  const regenerated = await generate({ ...first, previousId: result.uiSliceCandidateId });
  expect(regenerated.uiSliceCandidateId).not.toBe(result.uiSliceCandidateId);
  expect(mocks.fetch).toHaveBeenCalledTimes(3);
});

it('同步提交的响应丢失时重开仍不会重复提交', async () => {
  mocks.fetch.mockRejectedValue(new Error('连接中断'));
  await expect(generate(target())).rejects.toThrow();
  await expect(generate(target())).rejects.toThrow('提交结果未知');
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(mocks.persist).not.toHaveBeenCalled();
});

it('损坏的原图不能添加到画布，用户再次点击可以重新生成', async () => {
  const goodImage = Image;
  vi.stubGlobal('Image', class { async decode() { throw new Error('损坏图片'); } });
  mocks.fetch.mockImplementation(async () => jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
  const destination = target();
  await expect(generate(destination)).rejects.toThrow('无法解码');
  expect(destination.candidates.size).toBe(0);
  vi.stubGlobal('Image', goodImage);
  await expect(generate(destination)).resolves.toMatchObject({ width: 800, height: 400 });
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});

it('异步任务首次查询失败，下一次点击只查询原 ID 并保存对应原图', async () => {
  useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
    'slice-provider': { ...state.config.providers['slice-provider'], catalogId: 'cccapi', baseUrl: 'https://cccapi.cn/v1' } } } }));
  mocks.fetch.mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'original-slice' }] }))
    .mockResolvedValueOnce(new Response('query interrupted', { status: 401 }));
  await expect(generate(target())).rejects.toThrow();
  const original = useAppStore.getState().config;
  useAppStore.setState({ config: { ...original, providers: { ...original.providers,
    'slice-provider': { ...original.providers['slice-provider'], apiKey: 'another-account' } } } });
  await expect(generate(target())).rejects.toThrow('提交时的连接凭据');
  useAppStore.setState({ config: original });
  mocks.fetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'original-slice', status: 'completed',
    result: { images: [{ url: ['https://cdn.example/original.png'] }] } } }));
  await expect(generate(target())).resolves.toMatchObject({ url: preview });
  expect(mocks.fetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
    ['https://cccapi.cn/v1/images/generations', 'POST'], ['https://cccapi.cn/v1/tasks/original-slice', 'GET'],
    ['https://cccapi.cn/v1/tasks/original-slice', 'GET'],
  ]);
  expect(mocks.persist).toHaveBeenCalledWith('https://cdn.example/original.png', 'canvas', expect.anything());
});

it('RunningHub 切图用模型站点凭据提交并续查，换 Key 后不发送原任务 ID', async () => {
  const baseUrl = 'https://www.runninghub.cn';
  const credentialId = 'runninghub-credential-cn-model';
  const original = useAppStore.getState().config;
  const config = { ...original, providers: { ...original.providers,
    runninghub: { name: '工作流', apiKey: 'workflow-key', baseUrl },
    'runninghub-model': { name: '模型', apiKey: '', baseUrl, runninghubSiteCredentials: true },
    [credentialId]: { name: '国内站模型', apiKey: 'model-key', baseUrl },
  } };
  useAppStore.setState({ config });
  const model = 'rhart-image-n-g31-flash-lite-official/image-to-image';
  const generateRunningHubSlice = () => generateUiSliceImage({ ...params, model: `runninghub/${model}`, provider: 'runninghub' },
    sourceNode, target(), new AbortController().signal, () => {});
  const changed = { ...config, providers: { ...config.providers, [credentialId]: {
    ...config.providers[credentialId], apiKey: 'another-model-key',
  } } };
  vi.mocked(fetch).mockResolvedValueOnce(new Response('image', { headers: { 'Content-Type': 'image/gif' } }));
  mocks.fetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: { fileName: 'reference.gif', download_url: 'https://cdn.example/reference.gif' } }))
    .mockImplementationOnce(async () => {
      useAppStore.setState({ config: changed });
      return jsonResponse({ code: 0, data: { taskId: '1904152026220003329' } });
    });
  await expect(generateRunningHubSlice()).rejects.toThrow('切图模型连接已变化');
  await expect(generateRunningHubSlice()).rejects.toThrow('提交时的连接凭据');
  expect(mocks.fetch).toHaveBeenCalledTimes(2);

  useAppStore.setState({ config });
  mocks.fetch.mockResolvedValueOnce(new Response('query interrupted', { status: 401 }));
  await expect(generateRunningHubSlice()).rejects.toThrow('HTTP 401');
  mocks.fetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: { status: 'SUCCESS',
    results: [{ url: 'https://cdn.example/original.png' }] } }));
  await expect(generateRunningHubSlice()).resolves.toMatchObject({ url: preview });
  expect(mocks.fetch.mock.calls.map(([url, init]) => [url, new Headers(init.headers).get('Authorization')])).toEqual([
    [`${baseUrl}/openapi/v2/media/upload/binary`, 'Bearer model-key'],
    [`${baseUrl}/openapi/v2/${model}`, 'Bearer model-key'],
    [`${baseUrl}/openapi/v2/query`, 'Bearer model-key'],
    [`${baseUrl}/openapi/v2/query`, 'Bearer model-key'],
  ]);
  expect(JSON.parse(mocks.fetch.mock.calls[3][1].body)).toEqual({ taskId: '1904152026220003329' });
});

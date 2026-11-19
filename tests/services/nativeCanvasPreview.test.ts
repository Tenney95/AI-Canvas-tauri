import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { convertNativeProjectToSeries, createNativeProject, deleteNativeEpisode, readNativeCanvasPreviews,
  readNativeProjectCapture, saveNativeCanvasPreview } from '../../src/services/indexedDb/nativeProjectRepository';

let factory: IDBFactory;
const image = 'data:image/webp;base64,AAAA';

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
afterEach(() => vi.unstubAllGlobals());

it('封面保存后可在新连接上读回，独立于正文和交换版本，并能清空', async () => {
  const { project, canvas } = await createNativeProject({ name: '封面' }, { factory });
  const other = await createNativeProject({ name: '其它作品' }, { factory });
  const target = { projectId: project.id, canvasId: canvas!.id };
  const write = { ...target, expectedCanvasEpoch: canvas!.epoch };
  const before = await readNativeProjectCapture(project.id, { factory });
  expect((await readNativeCanvasPreviews([target], { factory })).size).toBe(0);

  await saveNativeCanvasPreview({ ...write, snapshot: image }, { factory });

  expect((await readNativeCanvasPreviews([target], { factory })).get(canvas!.id)).toMatchObject({ canvasId: canvas!.id, snapshot: image });
  expect((await readNativeCanvasPreviews([{ ...target, projectId: other.project.id }], { factory })).size).toBe(0);
  await expect(saveNativeCanvasPreview({ ...write, projectId: other.project.id, snapshot: image }, { factory })).rejects.toThrow('canvas-version-conflict');
  await expect(saveNativeCanvasPreview({ ...write, snapshot: 'data:image/svg+xml;base64,AAAA' }, { factory })).rejects.toThrow('invalid-canvas-preview');
  expect(await readNativeProjectCapture(project.id, { factory })).toEqual(before);

  await saveNativeCanvasPreview(write, { factory });
  expect((await readNativeCanvasPreviews([target], { factory })).size).toBe(0);
});

it('普通项目转剧集保留原图，迟到的旧画布代际和已删除分集不能重新写入', async () => {
  const { project, canvas, content } = await createNativeProject({ name: '转剧集' }, { factory });
  const target = { projectId: project.id, canvasId: canvas!.id };
  const previousPreview = { ...target, expectedCanvasEpoch: canvas!.epoch, snapshot: image };
  await saveNativeCanvasPreview(previousPreview, { factory });
  const series = await convertNativeProjectToSeries({ projectId: project.id, expectedProjectEpoch: project.epoch,
    expectedCanvasId: canvas!.id, expectedCanvasEpoch: canvas!.epoch, expectedCanvasRevision: canvas!.revision,
    expectedStandaloneRevision: content.standaloneCreative?.revision ?? 0, name: '第一集' }, { factory });
  const episode = series.episodes[0], activeCanvas = series.canvases[0];
  expect((await readNativeCanvasPreviews([target], { factory })).get(canvas!.id)?.snapshot).toBe(image);
  await expect(saveNativeCanvasPreview(previousPreview, { factory })).rejects.toThrow('canvas-version-conflict');

  await deleteNativeEpisode({ projectId: project.id, expectedProjectEpoch: series.project.epoch, episodeId: episode.id,
    expectedEpisodeRevision: episode.revision, expectedContentRevision: series.episodeContents[0].revision,
    expectedCanvasId: activeCanvas.id, expectedCanvasEpoch: activeCanvas.epoch, expectedCanvasRevision: activeCanvas.revision }, { factory });
  expect((await readNativeCanvasPreviews([target], { factory })).size).toBe(0);
  await expect(saveNativeCanvasPreview({ ...previousPreview, expectedCanvasEpoch: activeCanvas.epoch }, { factory })).rejects.toThrow('canvas-version-conflict');
});

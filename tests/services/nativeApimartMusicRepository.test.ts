/** 音乐分阶段写前意图与原任务身份；全部为合成新库，不调用远端或真实用户目录。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import { createNativeProject, saveNativeCanvas } from '../../src/services/indexedDb/nativeProjectRepository';
import { prepareNativeMediaTask, listNativeMediaTasks, reviewNativeMediaTask } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import { prepareNativeApimartMusicState, beginNativeApimartMusicStage, readNativeApimartMusicState,
  recordNativeApimartMusicStage, type NativeAudioContentFile } from '../../src/services/indexedDb/nativeApimartMusicRepository';

let factory: IDBFactory;
const file = (letter: string): NativeAudioContentFile => ({ relativePath: `media/${letter.repeat(64)}.json`, sha256: letter.repeat(64), bytes: 100, mimeType: 'application/json' });
beforeEach(() => { factory = new IDBFactory(); vi.stubGlobal('IDBKeyRange', IDBKeyRange); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const root = await createNativeProject({ name: '合成原音乐项目' }, { factory });
  const canvas = await saveNativeCanvas({ projectId: root.project.id, canvasId: root.canvas!.id, episodeId: null,
    expectedProjectEpoch: root.project.epoch, expectedCanvasEpoch: root.canvas!.epoch, expectedCanvasRevision: 0,
    document: { nodes: [{ id: 'audio', type: 'ai-audio', position: { x: 0, y: 0 }, data: { type: 'ai-audio', prompt: '合成输入' } }], edges: [], groups: [] } }, { factory });
  const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, projectId: root.project.id, canvasId: canvas.id,
    episodeId: null, projectEpoch: root.project.epoch, canvasEpoch: canvas.epoch, canvasRevision: canvas.revision, runtimeEpoch: 'initial-runtime' };
  const record = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'audio', category: 'audio',
    providerConfigId: 'apimart', providerBase: 'https://apimart.example/v1', modelRef: 'apimart/flowmusic', protocolDigest: 'b'.repeat(64),
    recovery: { kind: 'builtin-audio', modelId: 'flowmusic', digest: 'b'.repeat(64) }, submissionKind: 'async', fingerprintScheme: 'media-input-v2',
    requestFingerprint: file('a').sha256, inputFingerprint: 'c'.repeat(64), sourceCanvasRevision: canvas.revision }, { factory });
  const state = await prepareNativeApimartMusicState(record, file('a'), true, { factory });
  return { context, canvas, record, state };
}
it('歌词与音乐各自保存未知提交意图，重启只能续查原阶段，不能重放未知POST', async () => {
  const { record, state, canvas } = await fixture();
  const begun = await beginNativeApimartMusicStage(state, 'lyrics', canvas.revision, { factory });
  expect(begun.lyrics.state).toBe('unknown');
  await expect(beginNativeApimartMusicStage(begun, 'lyrics', canvas.revision, { factory })).rejects.toThrow('原音乐阶段');
  const acknowledged = await recordNativeApimartMusicStage(begun, 'lyrics', { taskId: 'original-lyrics-id' }, { factory });
  const afterRestart = await readNativeApimartMusicState(record, { factory });
  expect(afterRestart.lyrics).toMatchObject({ taskId: 'original-lyrics-id', state: 'submitted' });
  expect((await listNativeMediaTasks(record.ownerProjectId, { factory }))[0].remoteTaskId).toBeUndefined();
  await expect(beginNativeApimartMusicStage(afterRestart, 'music', canvas.revision, { factory })).rejects.toThrow();
  const lyricsDone = await recordNativeApimartMusicStage(acknowledged, 'lyrics', { resultFile: file('d') }, { factory });
  const musicBegun = await beginNativeApimartMusicStage(lyricsDone, 'music', canvas.revision, { factory });
  const music = await recordNativeApimartMusicStage(musicBegun, 'music', { taskId: 'original-music-id' }, { factory });
  expect(music.lyrics.taskId).toBe('original-lyrics-id'); expect(music.music.taskId).toBe('original-music-id');
  expect(music.inputFile).toEqual(file('a')); expect(music.lyrics.resultFile).toEqual(file('d'));
  expect(Object.keys(music)).not.toContain('prompt'); expect(Object.keys(music.lyrics)).not.toContain('lyrics');
});
it('两个窗口只有一个能取得下一阶段首次POST槽位；没有新任务身份替换原回执', async () => {
  const { record, state, canvas } = await fixture();
  const outcomes = await Promise.allSettled([beginNativeApimartMusicStage(state, 'lyrics', canvas.revision, { factory }),
    beginNativeApimartMusicStage(state, 'lyrics', canvas.revision, { factory })]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  const saved = await readNativeApimartMusicState(record, { factory });
  expect(saved.lyrics.submissionId).toBe(state.lyrics.submissionId); expect(saved.lyrics.state).toBe('unknown');
});
it('可证未发送允许显式首发，已核对结束跟踪后迟到ID只保留而不授予下阶段写权限', async () => {
  const { record, state, context, canvas } = await fixture();
  let next = await beginNativeApimartMusicStage(state, 'lyrics', canvas.revision, { factory });
  next = await recordNativeApimartMusicStage(next, 'lyrics', { notStarted: true }, { factory });
  expect(next.lyrics.state).toBe('not-started');
  next = await beginNativeApimartMusicStage(next, 'lyrics', canvas.revision, { factory });
  await reviewNativeMediaTask(record.operationId, context, { factory });
  next = await recordNativeApimartMusicStage(next, 'lyrics', { taskId: 'late-original-id' }, { factory });
  next = await recordNativeApimartMusicStage(next, 'lyrics', { resultFile: file('e') }, { factory });
  expect(next.lyrics.taskId).toBe('late-original-id');
  await expect(beginNativeApimartMusicStage(next, 'music', canvas.revision, { factory })).rejects.toThrow();
  expect((await listNativeMediaTasks(record.ownerProjectId, { factory }))[0].status).toBe('reviewed');
});
it('不能拿另一个画布版本或篡改的输入文件开启付费阶段', async () => {
  const { state, canvas } = await fixture();
  await expect(beginNativeApimartMusicStage(state, 'lyrics', canvas.revision + 1, { factory })).rejects.toThrow();
  await expect(beginNativeApimartMusicStage({ ...state, inputFile: file('f') }, 'lyrics', canvas.revision, { factory })).rejects.toThrow();
});

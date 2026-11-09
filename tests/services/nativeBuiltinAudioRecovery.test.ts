/** 同步音频返回后先保留原根，切集／重启不触发第二次付费请求。 */
import { createHash, webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import { createNativeProject, readNativeProjectCapture, saveNativeCanvas } from '../../src/services/indexedDb/nativeProjectRepository';
import { listNativeMediaTasks } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import { bindNativeMediaOrigin } from '../../src/services/nativeMediaOrigin';
import { nativeMediaInputMaterial } from '../../src/services/nativeMediaInput';
import type { AppState } from '../../src/store/useAppStore';
import { readNativeApimartMusicState } from '../../src/services/indexedDb/nativeApimartMusicRepository';

const driver = vi.hoisted(() => ({ context: undefined as CanvasContext | undefined, canvasRevision: 0,
  state: {} as Record<string, unknown>, switchAfterSpeech: false, speech: vi.fn(), deliver: vi.fn(), invoke: vi.fn(),
  inputFingerprint: '', lyricsSubmit: vi.fn(), musicSubmit: vi.fn(), fetchTask: vi.fn(), originPersist: vi.fn(), musicPosts: 0,
  contents: new Map<string, number[]>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: driver.invoke }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => driver.state, subscribe: () => () => {} } }));
vi.mock('../../src/services/projectExecutionContext', async (original) => ({
  ...await original<typeof import('../../src/services/projectExecutionContext')>(),
  captureLegacyCanvasContext: () => driver.context,
  isProjectExpectedContextCurrent: (context: CanvasContext) => context.canvasId === driver.context?.canvasId && context.runtimeEpoch === driver.context?.runtimeEpoch,
}));
vi.mock('../../src/services/nativeVideoSubmission', () => ({ isNativeVideoSubmissionGuard: () => true,
  captureNativeVideoSubmissionBaseline: async () => ({ inputFingerprint: driver.inputFingerprint, canvasRevision: driver.canvasRevision }),
  assertNativeVideoSubmissionInput: async () => {},
}));
vi.mock('../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: async () => {}, captureNativeMediaLocalResult: vi.fn() }));
vi.mock('../../src/services/nativeVolcengineRecovery', () => ({ resumeNativeVolcengineTask: driver.deliver }));
vi.mock('../../src/services/nativeMediaOriginPersistence', () => ({ persistNativeMediaOrigin: driver.originPersist }));
vi.mock('../../src/services/ai/apimartAudio', async (original) => ({
  ...await original<typeof import('../../src/services/ai/apimartAudio')>(), generateApimartSpeech: driver.speech,
  submitFlowMusicLyrics: driver.lyricsSubmit, submitFlowMusicGeneration: driver.musicSubmit, fetchFlowMusicTask: driver.fetchTask,
}));

import { generateNativeBuiltinAudio, resumeNativeBuiltinAudioTask } from '../../src/services/nativeBuiltinAudioRecovery';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); vi.stubGlobal('crypto', webcrypto);
  driver.context = undefined; driver.contents.clear(); driver.switchAfterSpeech = false;
  driver.inputFingerprint = 'a'.repeat(64); driver.musicPosts = 0; driver.lyricsSubmit.mockReset(); driver.musicSubmit.mockReset(); driver.fetchTask.mockReset();
  driver.originPersist.mockReset().mockResolvedValue(undefined);
  driver.deliver.mockReset().mockResolvedValue(undefined); driver.speech.mockReset(); driver.invoke.mockReset();
  driver.invoke.mockImplementation(async (command: string, input: { projectId: string; mimeType?: string; data?: number[]; reference?: { relativePath: string } }) => {
    if (command === 'write_native_project_media') {
      const data = input.data!, sha256 = createHash('sha256').update(new Uint8Array(data)).digest('hex');
      const relativePath = `media/${sha256}.${input.mimeType === 'application/json' ? 'json' : 'wav'}`;
      driver.contents.set(`${input.projectId}/${relativePath}`, [...data]);
      return { relativePath, sha256, bytes: data.length, mimeType: input.mimeType };
    }
    if (command === 'read_native_project_media') {
      const bytes = driver.contents.get(`${input.projectId}/${input.reference!.relativePath}`);
      if (!bytes) throw new Error('missing synthetic content'); return bytes;
    }
    throw new Error('unexpected synthetic IO');
  });
  driver.speech.mockImplementation(async (_key: string, _base: string, _params: unknown, _signal: AbortSignal | undefined, beforeSubmit: () => Promise<void>) => {
    await beforeSubmit();
    if (driver.switchAfterSpeech) driver.context = { ...driver.context!, runtimeEpoch: 'other-view' };
    return { url: 'data:audio/wav;base64,AQID', bytes: new Uint8Array([1, 2, 3]), format: 'wav' };
  });
});
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const created = await createNativeProject({ name: '隔离TTS' });
  const canvas = await saveNativeCanvas({ projectId: created.project.id, canvasId: created.canvas!.id, episodeId: null,
    expectedProjectEpoch: created.project.epoch, expectedCanvasEpoch: created.canvas!.epoch, expectedCanvasRevision: 0,
    document: { nodes: [{ id: 'audio', type: 'ai-audio', position: { x: 0, y: 0 }, data: { type: 'ai-audio', model: 'gpt-4o-mini-tts', provider: 'apimart', prompt: '合成朗读' } }], edges: [], groups: [] } });
  const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, projectId: created.project.id,
    projectEpoch: created.project.epoch, canvasId: canvas.id, canvasEpoch: canvas.epoch, canvasRevision: canvas.revision,
    episodeId: null, runtimeEpoch: 'original-view' };
  driver.context = context; driver.canvasRevision = canvas.revision;
  driver.state = { currentProjectId: canvas.id, projectExecutionContext: context, nodes: canvas.nodes, projects: [],
    config: { providers: { apimart: { apiKey: 'synthetic-key', baseUrl: 'https://apimart.example/v1' } } },
    beginNativeMediaSubmissionPreparation: async (expected: CanvasContext) => {
      let released = false;
      const assertCurrent = () => {
        const active = driver.context;
        if (released || !active || expected.projectId !== active.projectId || expected.canvasId !== active.canvasId
          || expected.projectEpoch !== active.projectEpoch || expected.canvasEpoch !== active.canvasEpoch
          || expected.episodeId !== active.episodeId || expected.runtimeEpoch !== active.runtimeEpoch) throw new Error('原音频准备租约已变化');
      };
      assertCurrent();
      const current = (await readNativeProjectCapture(expected.projectId))!.aggregate.canvases.find((item) => item.id === expected.canvasId)!;
      const saved = await saveNativeCanvas({ projectId: expected.projectId, canvasId: expected.canvasId, episodeId: expected.episodeId,
        expectedProjectEpoch: expected.projectEpoch, expectedCanvasEpoch: expected.canvasEpoch, expectedCanvasRevision: current.revision,
        document: { nodes: driver.state.nodes as unknown[], edges: current.edges, groups: current.groups } });
      assertCurrent(); driver.canvasRevision = saved.revision;
      return { context: expected, canvasRevision: saved.revision, assertCurrent, release: () => { released = true; } };
    },
    saveCurrentProjectSilent: async () => canvas.id };
  return { context, input: { params: { model: 'gpt-4o-mini-tts', provider: 'apimart', nodeId: 'audio', prompt: '合成朗读', audioFormat: 'wav' as const },
    prompt: '合成朗读', apiKey: 'synthetic-key', baseUrl: 'https://apimart.example/v1', beforeSubmit: async () => {} } };
}
it('返回音频时窗口已切换仍保存原根及SHA，只有当前视图投递暂停', async () => {
  const { context, input } = await fixture(); driver.switchAfterSpeech = true;
  await expect(generateNativeBuiltinAudio(input)).rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  const [record] = await listNativeMediaTasks(context.projectId);
  expect(record).toMatchObject({ ownerProjectId: context.projectId, canvasId: context.canvasId, status: 'submitted', submissionKind: 'sync' });
  expect(record.localResults).toHaveLength(1); expect(record.remoteTaskId).toBeUndefined();
  const output = record.localResults![0];
  expect(output.sha256).toBe(createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'));
  expect(driver.contents.get(`${context.projectId}/${output.relativePath}`)).toEqual([1, 2, 3]);
  expect(driver.deliver).not.toHaveBeenCalled(); expect(driver.speech).toHaveBeenCalledOnce();
});
it('重启并移除API Key后缓存只走原产物交付，不再次提交TTS', async () => {
  const { context, input } = await fixture(); driver.switchAfterSpeech = true;
  await expect(generateNativeBuiltinAudio(input)).rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  const [record] = await listNativeMediaTasks(context.projectId);
  driver.context = { ...context, runtimeEpoch: 'after-restart' }; driver.state.config = { providers: {} };
  await resumeNativeBuiltinAudioTask(record.operationId);
  expect(driver.deliver).toHaveBeenCalledWith(record.operationId, undefined); expect(driver.speech).toHaveBeenCalledOnce();
});
it('正常TTS先建立本机回执再自动交付原操作', async () => {
  const { context, input } = await fixture();
  await expect(generateNativeBuiltinAudio(input)).rejects.toMatchObject({ name: 'NativeMediaTaskDelivered' });
  const [record] = await listNativeMediaTasks(context.projectId);
  expect(record.localResults?.[0].category).toBe('audio');
  expect(driver.deliver).toHaveBeenCalledWith(record.operationId, undefined); expect(driver.speech).toHaveBeenCalledOnce();
});

it('纯对话歌词已完成后重启，项目输入变化不能仅凭消息归属首发音乐阶段', async () => {
  const { context } = await fixture(), nodeId = `media-message-${crypto.randomUUID()}`;
  const prompt = '合成音乐风格', modelRef = 'apimart/flowmusic';
  const intent = { kind: 'audio', prompt, modelRef, deliveryMode: 'chat' };
  const material = JSON.stringify([intent, undefined, undefined, undefined, undefined,
    nativeMediaInputMaterial({ id: nodeId, type: 'ai-audio', position: { x: 0, y: 0 },
      data: { type: 'ai-audio', label: '', prompt, model: modelRef, provider: 'apimart' } }, driver.state as unknown as AppState, 'media-input-v3')]);
  driver.inputFingerprint = createHash('sha256').update(material).digest('hex');
  const release = bindNativeMediaOrigin(context.canvasId, nodeId, { conversationId: 'original-chat', messageId: 'original-response',
    deliveryMode: 'chat', modelId: modelRef }, { material, assertCurrent: () => {} });
  driver.state.saveCurrentProjectSilent = async () => context.canvasId;
  driver.lyricsSubmit.mockImplementation(async (_key: string, _base: string, _prompt: string, _signal: AbortSignal | undefined, guard: () => Promise<void>) => {
    await guard(); return 'original-lyrics-task';
  });
  driver.musicSubmit.mockImplementation(async (_key: string, _base: string, _request: unknown, _signal: AbortSignal | undefined, guard: () => Promise<void>) => {
    await guard(); driver.musicPosts++; return 'music-task-must-not-start';
  });
  driver.fetchTask.mockImplementation(async () => {
    driver.state.projects = [{ id: context.canvasId, settings: { name: '输入已修改' } }];
    return { status: 'completed', result: { lyrics: [{ title: '原标题', lyrics: '原歌词' }] } };
  });
  try {
    await expect(generateNativeBuiltinAudio({ params: { provider: 'apimart', model: 'flowmusic', nodeId, prompt, autoGenerateLyrics: true },
      prompt, apiKey: 'synthetic-key', baseUrl: 'https://apimart.example/v1', beforeSubmit: async () => {} })).rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  } finally { release(); }
  const [record] = await listNativeMediaTasks(context.projectId), state = await readNativeApimartMusicState(record);
  expect(state.lyrics.state).toBe('completed'); expect(state.music.state).toBe('prepared'); expect(driver.musicPosts).toBe(0);
  driver.context = { ...context, runtimeEpoch: 'after-restart' };
  await expect(resumeNativeBuiltinAudioTask(record.operationId)).rejects.toThrow('下一阶段尚未提交');
  await expect(resumeNativeBuiltinAudioTask(record.operationId, undefined, undefined, { allowUnstartedStage: true })).rejects.toThrow('项目设置、引用或模型输入已变化');
  expect(driver.musicPosts).toBe(0); expect(driver.lyricsSubmit).toHaveBeenCalledOnce(); expect(driver.fetchTask).toHaveBeenCalledOnce();
});

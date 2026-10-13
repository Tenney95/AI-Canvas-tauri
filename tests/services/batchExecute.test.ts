import type { Edge, Node } from '@xyflow/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import type { BatchContext } from '../../src/utils/batchExecute';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  generateAudio: vi.fn(),
  buildPanoramaPrompt: vi.fn(),
  buildAnimationSpritePrompt: vi.fn(),
  resolveAnimationSheetAspectRatio: vi.fn(),
  persistAudioGenerationResult: vi.fn(),
  persistMediaUrlToProjectData: vi.fn(),
  syncDramaAssetImageFromNode: vi.fn(),
  liveState: { currentProjectId: null as string | null, nodes: [] as Node<BaseNodeData>[], revision: 0 },
}));

vi.mock('../../src/services/aiService', () => ({
  generateText: mocks.generateText,
  generateImage: mocks.generateImage,
  generateVideo: mocks.generateVideo,
  generateAudio: mocks.generateAudio,
  buildPanoramaPrompt: mocks.buildPanoramaPrompt,
}));

vi.mock('../../src/services/ai/animationPrompt', () => ({
  buildAnimationSpritePrompt: mocks.buildAnimationSpritePrompt,
  resolveAnimationSheetAspectRatio: mocks.resolveAnimationSheetAspectRatio,
}));

vi.mock('../../src/services/ai/generateAudio', () => ({
  persistAudioGenerationResult: mocks.persistAudioGenerationResult,
}));

vi.mock('../../src/services/fileService', () => ({
  persistMediaUrlToProjectData: mocks.persistMediaUrlToProjectData,
}));
vi.mock('../../src/services/pollManager', () => ({
  prepareVideoNodeGeneration: vi.fn(), completeVideoNodeTask: vi.fn(), pauseVideoNodeTask: vi.fn(),
  getPendingTasksForProject: () => [],
  VideoPollingPausedError: class extends Error {
    constructor() { super('视频查询已暂停'); }
  },
}));

vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: {
    getState: () => ({
      ...mocks.liveState,
      getCurrentRevision: () => mocks.liveState.revision,
      syncDramaAssetImageFromNode: mocks.syncDramaAssetImageFromNode,
    }),
  },
}));

import { batchExecuteNodes } from '../../src/utils/batchExecute';
import { VideoPollingPausedError } from '../../src/services/pollManager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createNode(
  id: string,
  type: BaseNodeData['type'] = 'ai-image',
  patch: Partial<BaseNodeData> = {},
): Node<BaseNodeData> {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type,
      prompt: `prompt-${id}`,
      model: `model-${id}`,
      provider: `provider-${id}`,
      status: 'idle',
      ...patch,
    } as BaseNodeData,
  };
}

function createContext(): BatchContext {
  return {
    currentProjectId: null,
    commitToHistory: vi.fn<BatchContext['commitToHistory']>(),
    updateNodeDataTransient: vi.fn<BatchContext['updateNodeDataTransient']>(),
    recordOutputHistory: vi.fn<BatchContext['recordOutputHistory']>().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  mocks.liveState = { currentProjectId: null, nodes: [], revision: 0 };
  mocks.generateText.mockReset();
  mocks.generateImage.mockReset();
  mocks.generateVideo.mockReset();
  mocks.generateAudio.mockReset();
  mocks.buildPanoramaPrompt.mockReset().mockImplementation((prompt: string) => `panorama:${prompt}`);
  mocks.buildAnimationSpritePrompt.mockReset().mockImplementation((prompt: string) => `animation:${prompt}`);
  mocks.resolveAnimationSheetAspectRatio.mockReset().mockReturnValue('2:1');
  mocks.persistAudioGenerationResult.mockReset();
  mocks.persistMediaUrlToProjectData.mockReset().mockImplementation(async (url: string) => ({
    mediaUrl: url,
    sourceUrl: url,
  }));
  mocks.syncDramaAssetImageFromNode.mockReset();
});

describe('batchExecuteNodes', () => {
  it('does not mark a paused video query as a failed node or resubmit it', async () => {
    mocks.generateVideo.mockRejectedValueOnce(new VideoPollingPausedError());
    const node = createNode('slow-video', 'ai-video');
    const ctx = createContext();
    await batchExecuteNodes([node.id], [node], [], ctx);
    expect(mocks.generateVideo).toHaveBeenCalledOnce();
    expect(ctx.recordOutputHistory).not.toHaveBeenCalled();
    expect(ctx.updateNodeDataTransient).not.toHaveBeenCalledWith(node.id, expect.objectContaining({ status: 'error' }));
  });
  it('queues workflows by display number and waits for generation and saving before starting the next', async () => {
    const generated = deferred<{ url: string }>();
    const saved = deferred<{ mediaUrl: string; sourceUrl: string }>();
    mocks.generateVideo.mockImplementation(async ({ nodeId }: { nodeId: string }) => (
      nodeId === 'random-z' ? generated.promise : { url: `${nodeId}.mp4` }
    ));
    mocks.persistMediaUrlToProjectData.mockImplementation(async (url: string) => (
      url === 'first.mp4' ? saved.promise : { mediaUrl: url, sourceUrl: url }
    ));
    const nodes = [
      createNode('random-a', 'ai-video', { provider: 'comfyui', workflowId: 'wf', displayId: 10 }),
      createNode('ordinary', 'ai-video'),
      createNode('random-z', 'ai-video', { provider: 'comfyui', workflowId: 'wf', displayId: 2 }),
    ];
    const ctx = createContext();
    ctx.currentProjectId = 'project';
    mocks.liveState = { currentProjectId: 'project', nodes, revision: 0 };
    const execution = batchExecuteNodes(nodes.map((node) => node.id), nodes, [], ctx);
    await vi.waitFor(() => expect(mocks.generateVideo.mock.calls.map(([request]) => request.nodeId)).toEqual(['random-z', 'ordinary']));
    generated.resolve({ url: 'first.mp4' });
    await vi.waitFor(() => expect(mocks.persistMediaUrlToProjectData).toHaveBeenCalledWith(
      'first.mp4', 'project', 'ai-video', 'random-z',
    ));
    expect(mocks.generateVideo).toHaveBeenCalledTimes(2);
    saved.resolve({ mediaUrl: 'saved.mp4', sourceUrl: 'first.mp4' });
    await expect(execution).resolves.toEqual({ ok: 3, fail: 0 });
    expect(mocks.generateVideo.mock.calls.map(([request]) => request.nodeId)).toEqual(['random-z', 'ordinary', 'random-a']);
  });

  it('preserves dependencies through ordinary nodes while serializing all workflow types', async () => {
    mocks.generateVideo.mockResolvedValue({ url: 'result.mp4' });
    const nodes = [
      createNode('last', 'ai-video', { workflowId: 'cloud', provider: 'runninghubwf', displayId: 9 }),
      createNode('middle', 'ai-video'),
      createNode('first', 'ai-video', { workflowId: 'local', provider: 'comfyui', displayId: 1 }),
      createNode('before', 'ai-video'),
      createNode('after', 'ai-video'),
    ];
    const edges = [
      { id: 'a', source: 'before', target: 'first' },
      { id: 'b', source: 'first', target: 'middle' },
      { id: 'c', source: 'middle', target: 'last' },
      { id: 'd', source: 'last', target: 'after' },
    ];
    const originalEdges = structuredClone(edges);
    await expect(batchExecuteNodes(nodes.map((node) => node.id), nodes, edges, createContext()))
      .resolves.toEqual({ ok: 5, fail: 0 });
    expect(mocks.generateVideo.mock.calls.map(([request]) => request.nodeId))
      .toEqual(['before', 'first', 'middle', 'last', 'after']);
    expect(edges).toEqual(originalEdges);
    expect(nodes.map((node) => node.id)).toEqual(['last', 'middle', 'first', 'before', 'after']);
  });

  it('prioritizes workflow display order over reverse edges and continues after a failure', async () => {
    mocks.generateVideo.mockRejectedValueOnce(new Error('workflow failed')).mockResolvedValue({ url: 'result.mp4' });
    const nodes = [
      createNode('ten', 'ai-video', { workflowId: 'wf', displayId: 10 }),
      createNode('two', 'ai-video', { workflowId: 'wf', displayId: 2 }),
    ];
    await expect(batchExecuteNodes(['ten', 'two'], nodes, [{ id: 'reverse', source: 'ten', target: 'two' }], createContext()))
      .resolves.toEqual({ ok: 1, fail: 1 });
    expect(mocks.generateVideo.mock.calls.map(([request]) => request.nodeId)).toEqual(['two', 'ten']);
  });

  it('keeps unnumbered workflows last in stable order and skips ineligible nodes', async () => {
    mocks.generateVideo.mockResolvedValue({ url: 'result.mp4' });
    const nodes = [
      createNode('old-b', 'ai-video', { workflowId: 'wf' }),
      createNode('loading', 'ai-video', { workflowId: 'wf', displayId: 1, status: 'loading' }),
      createNode('numbered', 'ai-video', { workflowId: 'wf', displayId: 2 }),
      createNode('old-a', 'ai-video', { workflowId: 'wf' }),
      createNode('empty', 'ai-video', { workflowId: 'wf', displayId: 3, prompt: '' }),
    ];
    await expect(batchExecuteNodes(nodes.map((node) => node.id), nodes, [], createContext()))
      .resolves.toEqual({ ok: 3, fail: 0 });
    expect(mocks.generateVideo.mock.calls.map(([request]) => request.nodeId)).toEqual(['numbered', 'old-b', 'old-a']);
  });

  it('serializes connected nodes while starting isolated nodes concurrently', async () => {
    const pending = new Map([
      ['a', deferred<{ url: string; width: number; height: number }>()],
      ['b', deferred<{ url: string; width: number; height: number }>()],
      ['c', deferred<{ url: string; width: number; height: number }>()],
    ]);
    mocks.generateVideo.mockImplementation(({ nodeId }: { nodeId: string }) => pending.get(nodeId)!.promise);

    const nodes = ['a', 'b', 'c'].map((id) => createNode(id, 'ai-video'));
    const edges = [{ id: 'a-b', source: 'a', target: 'b' }] as Edge[];
    const ctx = createContext();
    const execution = batchExecuteNodes(nodes.map((node) => node.id), nodes, edges, ctx);

    await vi.waitFor(() => expect(mocks.generateVideo.mock.calls.map(([request]) => request.nodeId)).toEqual(['a', 'c']));

    pending.get('c')!.resolve({ url: 'https://example.com/c.png', width: 64, height: 64 });
    pending.get('a')!.resolve({ url: 'https://example.com/a.png', width: 64, height: 64 });
    await vi.waitFor(() => {
      expect(mocks.generateVideo.mock.calls.map(([request]) => request.nodeId)).toEqual(['a', 'c', 'b']);
    });

    pending.get('b')!.resolve({ url: 'https://example.com/b.png', width: 64, height: 64 });
    await expect(execution).resolves.toEqual({ ok: 3, fail: 0 });
    expect(ctx.commitToHistory).toHaveBeenCalledTimes(1);
  });

  it('filters non-executable nodes and reports individual failures', async () => {
    mocks.generateImage
      .mockResolvedValueOnce({ url: 'https://example.com/ok.png', width: 64, height: 64 })
      .mockRejectedValueOnce(new Error('provider unavailable'));

    const nodes = [
      createNode('ok'),
      createNode('failed'),
      createNode('loading', 'ai-image', { status: 'loading' }),
      createNode('blank', 'ai-image', { prompt: '   ' }),
      createNode('group', 'group' as BaseNodeData['type']),
    ];
    const ctx = createContext();

    await expect(batchExecuteNodes(nodes.map((node) => node.id), nodes, [], ctx)).resolves.toEqual({
      ok: 1,
      fail: 1,
    });
    expect(mocks.generateImage).toHaveBeenCalledTimes(2);
    expect(ctx.updateNodeDataTransient).toHaveBeenCalledWith('failed', {
      status: 'error',
      error: 'provider unavailable',
    });
    expect(ctx.recordOutputHistory).toHaveBeenCalledWith('failed', expect.objectContaining({
      status: 'error',
      error: 'provider unavailable',
    }));
  });

  it('forwards image and video parameters from each node snapshot', async () => {
    mocks.generateImage.mockResolvedValue({ url: 'https://example.com/image.png', width: 1280, height: 720 });
    mocks.generateVideo.mockResolvedValue({ url: 'https://example.com/video.mp4' });
    const nodes = [
      createNode('image', 'ai-image', {
        imageSize: '4K',
        aspectRatio: '16:9',
        workflowId: 'workflow-image',
        workflowInputs: { steps: '30' },
      }),
      createNode('video', 'ai-video', {
        videoResolution: 1280,
        videoFps: 30,
        videoFrames: 121,
        seedanceResolution: '1080p',
        seedanceRatio: '9:16',
        seedanceDuration: 10,
        generateAudio: true,
        workflowId: 'workflow-video',
        workflowInputs: { motion: '8' },
      }),
    ];

    await batchExecuteNodes(nodes.map((node) => node.id), nodes, [], createContext());

    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'image',
      imageSize: '4K',
      aspectRatio: '16:9',
      workflowId: 'workflow-image',
      workflowInputs: { steps: '30' },
    }));
    expect(mocks.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'video',
      videoResolution: 1280,
      videoFps: 30,
      videoFrames: 301,
      seedanceResolution: '1080p',
      seedanceRatio: '9:16',
      seedanceDuration: 10,
      generateAudio: true,
      workflowId: 'workflow-video',
      workflowInputs: { motion: '8' },
    }));
  });

  it('does not inject legacy video defaults into direct general batch requests', async () => {
    mocks.generateVideo.mockResolvedValue({ url: 'https://example.com/video.mp4' });
    const node = createNode('general-video', 'ai-video', {
      provider: 'general',
      model: 'general/custom-video',
    });

    await expect(batchExecuteNodes([node.id], [node], [], createContext())).resolves.toEqual({
      ok: 1,
      fail: 0,
    });

    expect(mocks.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'general-video',
      videoResolution: undefined,
      videoFps: undefined,
      videoFrames: undefined,
      seedanceResolution: undefined,
      seedanceRatio: undefined,
      seedanceDuration: undefined,
    }));
  });

  it('forwards audio parameters and persists the generated result', async () => {
    mocks.generateAudio.mockResolvedValue({
      url: 'blob:audio-result',
      title: 'Generated title',
      lyrics: 'Generated lyrics',
      clipId: 'clip-1',
    });
    mocks.persistAudioGenerationResult.mockResolvedValue({
      mediaUrl: 'asset://audio.wav',
      sourceUrl: 'blob:audio-result',
      filePath: 'data/audio.wav',
      outputUrl: 'asset://audio.wav',
    });
    const node = createNode('audio', 'ai-audio', {
      audioVoice: 'nova',
      audioFormat: 'aac',
      audioSpeed: 1.25,
      musicTitle: 'Draft title',
      musicLyrics: 'Draft lyrics',
      musicBpm: 132,
      musicDuration: 90,
      autoGenerateLyrics: true,
      workflowId: 'workflow-audio',
      workflowInputs: { quality: 'high' },
    });
    const ctx = createContext();
    ctx.currentProjectId = 'project-a';

    await expect(batchExecuteNodes([node.id], [node], [], ctx)).resolves.toEqual({ ok: 1, fail: 0 });

    expect(mocks.generateAudio).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'audio',
      audioVoice: 'nova',
      audioFormat: 'aac',
      audioSpeed: 1.25,
      musicTitle: 'Draft title',
      musicLyrics: 'Draft lyrics',
      musicBpm: 132,
      musicDuration: 90,
      autoGenerateLyrics: true,
      workflowId: 'workflow-audio',
      workflowInputs: { quality: 'high' },
    }));
    expect(mocks.persistAudioGenerationResult).toHaveBeenCalledWith(
      expect.objectContaining({ clipId: 'clip-1' }),
      'project-a',
      'audio',
    );
    expect(ctx.recordOutputHistory).toHaveBeenCalledWith('audio', expect.objectContaining({
      params: expect.objectContaining({
        musicTitle: 'Generated title',
        musicBpm: 132,
        musicDuration: 90,
      }),
    }));
  });

  it('executes every node in a cycle while preserving dependencies outside the cycle', async () => {
    mocks.generateImage.mockImplementation(({ nodeId }: { nodeId: string }) => Promise.resolve({
      url: `https://example.com/${nodeId}.png`,
      width: 64,
      height: 64,
    }));
    const nodes = [
      createNode('downstream'),
      createNode('cycle-b'),
      createNode('cycle-a'),
      createNode('upstream'),
    ];
    const edges = [
      { id: 'upstream-a', source: 'upstream', target: 'cycle-a' },
      { id: 'a-b', source: 'cycle-a', target: 'cycle-b' },
      { id: 'b-a', source: 'cycle-b', target: 'cycle-a' },
      { id: 'b-downstream', source: 'cycle-b', target: 'downstream' },
    ] as Edge[];

    await expect(batchExecuteNodes(nodes.map((node) => node.id), nodes, edges, createContext())).resolves.toEqual({
      ok: 4,
      fail: 0,
    });
    expect(mocks.generateImage.mock.calls.map(([request]) => request.nodeId)).toEqual([
      'upstream',
      'cycle-b',
      'cycle-a',
      'downstream',
    ]);
  });

  it('maps animation and panorama requests without losing node-specific parameters', async () => {
    mocks.generateImage.mockResolvedValue({ url: 'https://example.com/result.png', width: 1280, height: 720 });
    const nodes = [
      createNode('animation', 'ai-animation', {
        imageSize: '4K',
        animationAction: 'run',
        animationFrames: 12,
      }),
      createNode('panorama', 'ai-panorama', {
        imageSize: '2K',
        aspectRatio: '21:9',
      }),
    ];
    const ctx = createContext();

    await expect(batchExecuteNodes(nodes.map((node) => node.id), nodes, [], ctx)).resolves.toEqual({
      ok: 2,
      fail: 0,
    });

    expect(mocks.resolveAnimationSheetAspectRatio).toHaveBeenCalledWith(12, 'provider-animation');
    expect(mocks.buildAnimationSpritePrompt).toHaveBeenCalledWith('prompt-animation', 'run', 12, '2:1', expect.objectContaining({ alignment: 'foot', ground: true }));
    expect(mocks.buildPanoramaPrompt).toHaveBeenCalledWith('prompt-panorama');
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'animation',
      prompt: 'animation:prompt-animation',
      imageSize: '4K',
      aspectRatio: '2:1',
    }));
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'panorama',
      prompt: 'panorama:prompt-panorama',
      imageSize: '2K',
      aspectRatio: '21:9',
    }));
    expect(ctx.recordOutputHistory).toHaveBeenCalledWith('animation', expect.objectContaining({
      nodeType: 'ai-animation',
      params: expect.objectContaining({
        animationAction: 'run',
        animationFrames: 12,
        aspectRatio: '2:1',
      }),
    }));
    expect(ctx.updateNodeDataTransient).toHaveBeenCalledWith('animation', expect.objectContaining({ animationSheet: { cols: 4, rows: 3, frameCount: 12, action: 'run' }, animationEdits: undefined }));
  });

  it.each(['project', 'revision'])('discards an animation result after its %s changes', async (change) => {
    const waiting = deferred<{ url: string }>();
    const nodes = [createNode('animation', 'ai-animation')];
    const ctx = createContext(); ctx.currentProjectId = 'p1';
    mocks.liveState = { currentProjectId: 'p1', nodes, revision: 1 };
    mocks.generateImage.mockReturnValue(waiting.promise);
    const task = batchExecuteNodes(['animation'], nodes, [], ctx);
    await vi.waitFor(() => expect(mocks.generateImage).toHaveBeenCalledOnce());
    if (change === 'project') mocks.liveState.currentProjectId = 'p2'; else mocks.liveState.revision++;
    waiting.resolve({ url: 'https://example.com/stale.png' }); await task;
    expect(mocks.persistMediaUrlToProjectData).not.toHaveBeenCalled();
    expect(ctx.recordOutputHistory).not.toHaveBeenCalled();
    expect(ctx.updateNodeDataTransient).not.toHaveBeenCalledWith('animation', expect.objectContaining({ status: 'success' }));
  });
});

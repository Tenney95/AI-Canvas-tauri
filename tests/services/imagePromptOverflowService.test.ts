import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import { ImagePromptOverflowError } from '../../src/services/ai/imagePromptLimits';
import type { StreamingCallOptions } from '../../src/services/ai/assistantStream';
import { startImageOutpaint } from '../../src/services/imageOutpaintService';

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), execute: vi.fn(), stream: vi.fn(), model: vi.fn() }));
vi.mock('../../src/services/ai/generateImage', () => ({ inspectImagePromptLength: mocks.inspect, generateImage: vi.fn(), generateImagesBatch: vi.fn() }));
vi.mock('../../src/services/generationService', () => ({ executeGeneration: mocks.execute }));
vi.mock('../../src/services/ai/assistantStream', () => ({ resolveAssistantModel: mocks.model, streamAssistantReply: mocks.stream }));

import {
  applyImagePromptOptimization, chooseImagePromptTruncation, closeImagePromptOverflow,
  executeGenerationWithImagePromptChoice, getImagePromptOverflow, optimizeImagePrompt,
  updateImagePromptOverflowPreview,
} from '../../src/services/imagePromptOverflowService';

const fullPrompt = '图'.repeat(38_956);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspect.mockResolvedValue(new ImagePromptOverflowError('gpt-image-2.6', fullPrompt, 32_000, 2));
  mocks.execute.mockResolvedValue({ success: true });
  mocks.model.mockReturnValue({ selectionId: 'general/text-model' });
  mocks.stream.mockImplementation(async (options: StreamingCallOptions) => {
    options.onEvent({ type: 'text.delta', delta: '精简后的构图与风格' });
    options.onEvent({ type: 'done', finishReason: 'stop' });
    return '精简后的构图与风格';
  });
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'prompt-project', projectLoadStatus: 'ready', projectExecutionContext: undefined,
    switchingProjectName: null, isCreatingProject: false, isReturningToStartPage: false,
    projects: [{ id: 'prompt-project', name: '提示词长度', createdAt: 1, updatedAt: 1 }],
    nodes: [{ id: 'image-node', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: '图片', prompt: '原文', provider: 'general', model: 'general/image-model', status: 'success', imageUrl: 'old.png' } }],
    edges: [], groups: [], getCurrentRevision: () => 1, showToast: vi.fn() });
});

afterEach(() => { closeImagePromptOverflow(); });

async function openChoice() {
  const result = executeGenerationWithImagePromptChoice('image-node');
  await vi.waitFor(() => expect(getImagePromptOverflow()).not.toBeNull());
  return { result };
}

describe('超长生图提示词的用户选择', () => {
  it.each(['gif', 'svg'] as const)('%s 预检沿用已选输出参数，不误用默认 PNG', async (imageOutputFormat) => {
    const capabilities = await import('../../src/services/ai/mediaModelCapabilities');
    vi.spyOn(capabilities, 'resolveImageParameterCapability').mockReturnValue({
      modelId: 'image-model', resolutionStyle: 'K', resolutions: ['2K'], ratios: ['1:1'], supportsBatch: false,
      outputFormats: ['png', 'gif', 'svg'], defaultOutputFormat: 'png',
      gifFrameCount: { min: 2, max: 16, default: 9 },
      gifFrameDurationMs: { min: 20, max: 655350, step: 10, default: 200 }, supportsGifTransparency: true,
    });
    useAppStore.getState().updateNodeDataTransient('image-node', { imageOutputFormat });
    const { result } = await openChoice();
    expect(mocks.inspect).toHaveBeenCalledWith(expect.objectContaining({ imageOutputFormat,
      ...(imageOutputFormat === 'gif' ? { imageFrameCount: 9, imageFrameDurationMs: 200, imageTransparent: false } : {}),
    }), 2, expect.any(AbortSignal));
    chooseImagePromptTruncation();
    await expect(result).resolves.toEqual({ success: true });
  });

  it('扩图预检使用独立垫图，与实际生成的参考图和最终提示词保持一致', async () => {
    useAppStore.getState().updateNodeDataTransient('image-node', {
      outpaintInput: { url: 'asset://localhost/padded.png', width: 1600, height: 900 },
    });
    const { result } = await openChoice();
    expect(mocks.inspect).toHaveBeenCalledWith(expect.objectContaining({ image_urls: ['asset://localhost/padded.png'] }), 2, expect.any(AbortSignal));
    expect(mocks.execute).not.toHaveBeenCalled();
    chooseImagePromptTruncation();
    await expect(result).resolves.toEqual({ success: true });
    expect(useAppStore.getState().nodes[0].data.imageUrl).toBe('old.png');
  });

  it('首次扩图超限时先等待选择，返回编辑打开新增的扩图节点', async () => {
    const result = startImageOutpaint('image-node', 'old.png', 'data:image/png;base64,cGFk', {
      model: 'general/image-model', provider: 'general', prompt: '延展背景', size: '16:9', width: 1600, height: 900,
    });
    await vi.waitFor(() => expect(getImagePromptOverflow()).not.toBeNull());
    const outpaintNodeId = getImagePromptOverflow()!.nodeId;
    expect(outpaintNodeId).not.toBe('image-node');
    expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(mocks.inspect.mock.calls[0][0]).toMatchObject({
      nodeId: outpaintNodeId, image_urls: ['data:image/png;base64,cGFk'],
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    closeImagePromptOverflow(true);
    await expect(result).resolves.toMatchObject({ success: false });
    expect(useAppStore.getState().activeNodeId).toBe(outpaintNodeId);
    expect(useAppStore.getState().nodes).toHaveLength(2);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('等待选择和返回精简均不提交，保留原图与原文', async () => {
    const original = useAppStore.getState().nodes[0];
    const { result } = await openChoice();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.inspect).toHaveBeenCalledWith(expect.objectContaining({ imageSize: '2K' }), 2, expect.any(AbortSignal));
    closeImagePromptOverflow(true);
    await expect(result).resolves.toMatchObject({ success: false });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes[0]).toBe(original);
    expect(useAppStore.getState().activeNodeId).toBe('image-node');
  });

  it('明确裁剪后只为本次传递最终提示词快照，不覆盖输入', async () => {
    const { result } = await openChoice();
    chooseImagePromptTruncation();
    await expect(result).resolves.toEqual({ success: true });
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('image-node', undefined, undefined, undefined, undefined, {
      imagePromptResolution: { original: fullPrompt, replacement: '图'.repeat(32_000) },
    });
    expect(useAppStore.getState().nodes[0].data.prompt).toBe('原文');
  });

  it('创建可复用的文本优化节点，预览确认前不生图', async () => {
    const { result } = await openChoice();
    await optimizeImagePrompt('general/text-model');
    const state = useAppStore.getState();
    const optimization = state.nodes.find((node) => node.id !== 'image-node')!;
    expect(optimization.data).toMatchObject({ type: 'ai-text', model: 'general/text-model', output: '精简后的构图与风格', status: 'success' });
    expect(optimization.data.prompt).toContain(fullPrompt);
    expect(mocks.stream).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'general/text-model',
      tools: [], resolveVisualReferences: false, trackAbort: false, signal: expect.any(AbortSignal) }));
    expect(mocks.execute).not.toHaveBeenCalled();
    updateImagePromptOverflowPreview('用户确认的精简描述');
    applyImagePromptOptimization();
    await expect(result).resolves.toEqual({ success: true });
    expect(mocks.execute).toHaveBeenCalledWith('image-node', undefined, undefined, undefined, undefined,
      { imagePromptResolution: { original: fullPrompt, replacement: '用户确认的精简描述' } });
    expect(useAppStore.getState().nodes.find((node) => node.id === optimization.id)?.data.output).toBe('用户确认的精简描述');
  });

  it('优化失败或结果仍超长时停在预览，不自动裁剪或生图', async () => {
    const { result } = await openChoice();
    mocks.stream.mockRejectedValueOnce(new Error('文本服务失败'));
    await optimizeImagePrompt('general/text-model');
    expect(getImagePromptOverflow()).toMatchObject({ busy: false, error: '文本服务失败' });
    updateImagePromptOverflowPreview(fullPrompt);
    applyImagePromptOptimization();
    expect(getImagePromptOverflow()?.error).toContain('超出上限');
    expect(mocks.execute).not.toHaveBeenCalled();
    closeImagePromptOverflow();
    await result;
  });

  it.each(['project', 'input', 'reference'] as const)('%s 变化使等待的选择失效', async (change) => {
    if (change === 'reference') {
      const state = useAppStore.getState();
      state.addNode({ id: 'reference', type: 'ai-text',
        position: { x: 0, y: 0 }, data: { type: 'ai-text', label: '参考正文', output: '旧正文' } });
      state.updateNodeDataTransient('image-node', { prompt: '参考 @{reference:参考正文}' });
    }
    const { result } = await openChoice();
    if (change === 'project') useAppStore.setState({ currentProjectId: 'other-project' });
    else useAppStore.getState().updateNodeDataTransient(change === 'input' ? 'image-node' : 'reference',
      change === 'input' ? { prompt: '新要求' } : { output: '新正文' });
    await expect(result).resolves.toMatchObject({ success: false });
    expect(getImagePromptOverflow()).toBeNull();
    chooseImagePromptTruncation();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('预检与选择期间，无关 RunningHub 任务推进和交付均不影响生图', async () => {
    const store = useAppStore.getState();
    store.addNode({ id: 'video', type: 'ai-video', position: { x: 320, y: 0 },
      data: { type: 'ai-video', label: 'RunningHub 视频', provider: 'runninghub', status: 'loading' } });
    let finishInspection!: (overflow: ImagePromptOverflowError) => void;
    mocks.inspect.mockReturnValueOnce(new Promise((resolve) => { finishInspection = resolve; }));
    const result = executeGenerationWithImagePromptChoice('image-node');
    store.updateNodeDataTransient('video', { runninghubStage: '运行中' });
    finishInspection(new ImagePromptOverflowError('gpt-image-2.6', fullPrompt, 32_000));
    await vi.waitFor(() => expect(getImagePromptOverflow()?.nodeId).toBe('image-node'));
    store.updateNodeDataTransient('video', { runninghubStage: '已完成', status: 'success', videoUrl: 'finished.mp4' });
    expect(getImagePromptOverflow()?.nodeId).toBe('image-node');
    chooseImagePromptTruncation();
    await expect(result).resolves.toEqual({ success: true });
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it('被引用节点的轮询状态可推进，替换引用素材会取消选择', async () => {
    const store = useAppStore.getState();
    store.addNode({ id: 'video', type: 'ai-video', position: { x: 320, y: 0 },
      data: { type: 'ai-video', label: 'RunningHub 视频', provider: 'runninghub', status: 'loading', videoUrl: 'previous.mp4' } });
    store.updateNodeDataTransient('image-node', { prompt: '参考 @{video:视频}' });
    const { result } = await openChoice();
    store.updateNodeDataTransient('video', { runninghubStage: '运行中' });
    expect(getImagePromptOverflow()?.nodeId).toBe('image-node');
    store.updateNodeDataTransient('video', { videoUrl: 'replacement.mp4' });
    expect(getImagePromptOverflow()).toBeNull();
    await expect(result).resolves.toMatchObject({ success: false });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('输入改动后立即取消预检并允许重试，旧预检迟到时不能影响新选择', async () => {
    let finishInspection!: (overflow: ImagePromptOverflowError) => void;
    mocks.inspect.mockReturnValueOnce(new Promise((resolve) => { finishInspection = resolve; }));
    const first = executeGenerationWithImagePromptChoice('image-node');
    const signal: AbortSignal = mocks.inspect.mock.calls[0][2];
    useAppStore.getState().updateNodeDataTransient('image-node', { prompt: '修改后的原文' });
    expect(signal.aborted).toBe(true);
    const { result: second } = await openChoice();
    finishInspection(new ImagePromptOverflowError('gpt-image-2.6', '旧预检', 1));
    await expect(first).resolves.toMatchObject({ success: false });
    expect(getImagePromptOverflow()?.overflow.prompt).toBe(fullPrompt);
    chooseImagePromptTruncation();
    await expect(second).resolves.toEqual({ success: true });
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it('创建优化节点时同步修改生图输入会取消选择并清理忙碌状态', async () => {
    const { result } = await openChoice();
    const unsubscribe = useAppStore.subscribe((state) => {
      if (!state.nodes.some((node) => node.data.type === 'ai-text')) return;
      unsubscribe();
      state.updateNodeDataTransient('image-node', { prompt: '同步更新的要求' });
    });
    try {
      await optimizeImagePrompt('general/text-model');
      await expect(result).resolves.toMatchObject({ success: false });
      expect(getImagePromptOverflow()).toBeNull();
      expect(useAppStore.getState().nodes.find((node) => node.data.type === 'ai-text')?.data.status).toBe('idle');
      expect(mocks.stream).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('优化中取消会中止文本请求并清理节点忙碌状态', async () => {
    let options!: StreamingCallOptions;
    let finish!: (value: string) => void;
    mocks.stream.mockImplementation((input: StreamingCallOptions) => {
      options = input;
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const { result } = await openChoice();
    const optimizing = optimizeImagePrompt('general/text-model');
    await vi.waitFor(() => expect(getImagePromptOverflow()?.busy).toBe(true));
    closeImagePromptOverflow();
    expect(options.signal?.aborted).toBe(true);
    expect(useAppStore.getState().nodes.every((node) => node.data.status !== 'loading')).toBe(true);
    finish('迟到结果');
    await optimizing;
    await result;
    expect(useAppStore.getState().nodes.every((node) => node.data.status !== 'loading')).toBe(true);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('图片编号必须完整匹配，手动修改预览也不能把图片1替换成图片10', async () => {
    mocks.inspect.mockResolvedValueOnce(new ImagePromptOverflowError('gpt-image-2.6', `图片1 图片10 ${fullPrompt}`, 32_000));
    mocks.stream.mockImplementationOnce(async (options: StreamingCallOptions) => {
      options.onEvent({ type: 'text.delta', delta: '图片10 保持构图' });
      options.onEvent({ type: 'done', finishReason: 'stop' });
      return '图片10 保持构图';
    });
    const { result } = await openChoice();
    await optimizeImagePrompt('general/text-model');
    expect(getImagePromptOverflow()?.error).toContain('改变了图片引用');
    updateImagePromptOverflowPreview('图片10 保持构图');
    applyImagePromptOptimization();
    expect(mocks.execute).not.toHaveBeenCalled();
    updateImagePromptOverflowPreview('图片1 和图片10 保持构图');
    applyImagePromptOptimization();
    await expect(result).resolves.toEqual({ success: true });
  });

  it.each([false, true])('缺少完整结束事件或被输出上限截断时不允许继续生图（截断=%s）', async (truncated) => {
    mocks.stream.mockImplementationOnce(async (options: StreamingCallOptions) => {
      options.onEvent({ type: 'text.delta', delta: '只有一半的描述' });
      if (truncated) options.onEvent({ type: 'done', finishReason: 'length' });
      return '只有一半的描述';
    });
    const { result } = await openChoice();
    await optimizeImagePrompt('general/text-model');
    expect(getImagePromptOverflow()).toMatchObject({ preview: '', busy: false });
    expect(getImagePromptOverflow()?.error).toContain('未完整返回');
    expect(mocks.execute).not.toHaveBeenCalled();
    closeImagePromptOverflow();
    await result;
  });

  it('不同节点同时完成预检时不覆盖已有选择或遗留未决请求', async () => {
    const original = useAppStore.getState().nodes[0];
    useAppStore.setState({ nodes: [original, { ...original, id: 'image-second' }] });
    let firstReady!: (overflow: ImagePromptOverflowError) => void;
    let secondReady!: (overflow: ImagePromptOverflowError) => void;
    mocks.inspect.mockImplementationOnce(() => new Promise((resolve) => { firstReady = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { secondReady = resolve; }));
    const first = executeGenerationWithImagePromptChoice('image-node');
    const second = executeGenerationWithImagePromptChoice('image-second');
    firstReady(new ImagePromptOverflowError('gpt-image-2.6', fullPrompt, 32_000));
    await vi.waitFor(() => expect(getImagePromptOverflow()?.nodeId).toBe('image-node'));
    secondReady(new ImagePromptOverflowError('gpt-image-2.6', fullPrompt, 32_000));
    await expect(second).resolves.toMatchObject({ success: false });
    expect(getImagePromptOverflow()?.nodeId).toBe('image-node');
    closeImagePromptOverflow();
    await expect(first).resolves.toMatchObject({ success: false });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('未超长和工作流均使用原生成链路', async () => {
    mocks.inspect.mockResolvedValueOnce(undefined);
    await expect(executeGenerationWithImagePromptChoice('image-node')).resolves.toEqual({ success: true });
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('image-node', undefined, undefined, undefined);
    mocks.execute.mockClear();
    useAppStore.getState().updateNodeDataTransient('image-node', { workflowId: 'workflow' });
    await executeGenerationWithImagePromptChoice('image-node');
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it.each(['short', 'workflow', 'truncated'])('%s 提交后释放选择锁，旧生成结束不能清掉新一轮预检锁', async (mode) => {
    let finishGeneration!: (value: { success: boolean }) => void;
    mocks.execute.mockReturnValueOnce(new Promise((resolve) => { finishGeneration = resolve; }));
    if (mode === 'short') mocks.inspect.mockResolvedValueOnce(undefined);
    if (mode === 'workflow') useAppStore.getState().updateNodeDataTransient('image-node', { workflowId: 'workflow' });
    const first = executeGenerationWithImagePromptChoice('image-node');
    if (mode === 'truncated') {
      await vi.waitFor(() => expect(getImagePromptOverflow()).not.toBeNull());
      chooseImagePromptTruncation();
    }
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    if (mode === 'workflow') useAppStore.getState().updateNodeDataTransient('image-node', { workflowId: undefined });
    let finishInspection!: (value: ImagePromptOverflowError) => void;
    mocks.inspect.mockClear().mockReturnValueOnce(new Promise((resolve) => { finishInspection = resolve; }));
    const second = executeGenerationWithImagePromptChoice('image-node');
    await vi.waitFor(() => expect(mocks.inspect).toHaveBeenCalledOnce());
    finishGeneration({ success: true });
    await expect(first).resolves.toEqual({ success: true });
    await expect(executeGenerationWithImagePromptChoice('image-node')).resolves.toMatchObject({ success: false });
    expect(mocks.inspect).toHaveBeenCalledOnce();
    finishInspection(new ImagePromptOverflowError('gpt-image-2.6', fullPrompt, 32_000));
    await vi.waitFor(() => expect(getImagePromptOverflow()).not.toBeNull());
    closeImagePromptOverflow();
    await expect(second).resolves.toMatchObject({ success: false });
    expect(mocks.execute).toHaveBeenCalledOnce();
  });
});

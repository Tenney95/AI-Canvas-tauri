import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deferred,
  findElement,
  componentName,
  installReactHookDriver,
  createStore,
  installStoreMock,
  mockComfyDeliveries,
} from './nodeFixture';

export function registerImageGenerationTests() {
  describe('source image generation', () => {
    afterEach(() => {
      vi.doUnmock('../../../src/services/ai/mediaModelCapabilities');
      vi.doUnmock('../../../src/services/projectSettingsService');
    });

    it.each([
      { type: 'source-image', entry: 'dialog' }, { type: 'source-image', entry: 'toolbar' },
      { type: 'ai-image', entry: 'dialog' }, { type: 'ai-image', entry: 'toolbar' },
    ].flatMap((entry) => ['9:16', undefined].map((aspectRatio) => ({ ...entry, aspectRatio }))))(
      'uses image models for $type through $entry while preserving ratio $aspectRatio and source identity', async ({ type, entry, aspectRatio }) => {
      const store = createStore([{
        id: 'imported-image', type, position: { x: 12, y: 34 },
        data: { type, label: '上传图片', role: 'source', status: 'success',
          imageUrl: 'asset://original.png', filePath: 'original.png', assetId: 'original-asset',
          dramaAssetId: 'character-1', prompt: '@{reference:参考图} 重绘',
          aspectRatio, nodeWidth: 158, nodeHeight: 280,
          model: 'old-model', provider: 'general' },
      }], () => 1);
      store.activeNodeId = 'imported-image';
      const generateImage = vi.fn().mockResolvedValue({ url: 'https://example.com/result.png', width: 768, height: 1024 });
      const generateText = vi.fn();
      const resolveProjectGenerationPrompt = vi.fn(
        ({ prompt, data }: { prompt: string; data: Record<string, unknown> }) => `${data.type}:${prompt}`,
      );
      await installReactHookDriver();
      installStoreMock(store);
      vi.doUnmock('../../../src/services/generationService');
      vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
      vi.doMock('../../../src/i18n', () => ({ useT: () => (text: string) => text }));
      vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
      vi.doMock('../../../src/components/nodes/shared/PromptPanel', () => ({
        default: function PromptPanelMock() { return null; },
      }));
      vi.doMock('../../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
      vi.doMock('../../../src/services/aiService', () => ({
        generateText, generateTextResult: vi.fn(), generateImage, generateImagesBatch: vi.fn(), generateVideo: vi.fn(), generateAudio: vi.fn(), buildPanoramaPrompt: vi.fn(),
      }));
      vi.doMock('../../../src/services/fileService', () => ({
        persistMediaUrlToProjectData: vi.fn(async (url: string) => ({ mediaUrl: url, sourceUrl: url, filePath: 'result.png' })),
      }));
      vi.doMock('../../../src/services/ai/mediaModelCapabilities', async () => ({
        ...await vi.importActual<typeof import('../../../src/services/ai/mediaModelCapabilities')>('../../../src/services/ai/mediaModelCapabilities'),
        resolveImageParameterCapability: () => ({ resolutions: ['1K'], defaultResolution: '1K', ratios: ['3:4', '9:16', '1:1'], defaultRatio: '3:4',
          qualities: ['low', 'high'], defaultQuality: 'high', backgrounds: ['auto', 'opaque', 'transparent'] }),
      }));
      vi.doMock('../../../src/services/projectSettingsService', async () => ({
        ...await vi.importActual<typeof import('../../../src/services/projectSettingsService')>('../../../src/services/projectSettingsService'),
        resolveProjectGenerationPrompt,
        getImageNodeDimensionsForAspectRatio: () => ({ nodeWidth: 210, nodeHeight: 280 }),
        getProjectModelKind: (nodeType: string) => nodeType === 'ai-image' ? 'image' : null,
        parseProjectModelRef: (model: string | undefined) => model ? { model, provider: 'general' } : null,
      }));
      vi.doMock('../../../src/services/pollManager', () => ({
        ...mockComfyDeliveries(), getPendingTasksForProject: () => [],
        prepareMediaNodeGeneration: vi.fn(), registerMediaNodeOperation: () => vi.fn(), completeMediaNodeTask: vi.fn(),
      }));

      const AINodeDialog = (await import('../../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
      const panel = findElement(AINodeDialog(), (element) => componentName(element) === 'PromptPanelMock');
      expect(panel.props.nodeType).toBe('ai-image');
      expect(panel.props.onPassThrough).toBeUndefined();
      (panel.props.onModelSelect as (model: Record<string, unknown>) => void)({
        value: 'general/image-model', provider: 'general', label: 'Image model',
      });
      expect(store.nodes[0].data).toMatchObject({
        type, role: 'source', model: 'general/image-model', imageSize: '1K', aspectRatio, imageQuality: 'high',
        nodeWidth: 158, nodeHeight: 280,
        imageUrl: 'asset://original.png', filePath: 'original.png', assetId: 'original-asset', dramaAssetId: 'character-1',
      });
      (panel.props.onChangeImageQuality as (quality: string) => void)('low');
      (panel.props.onChangeImageBackground as (background: string) => void)('transparent');
      if (entry === 'dialog') await (panel.props.onSubmit as () => Promise<void>)();
      else {
        const { executeGeneration } = await import('../../../src/services/generationService');
        expect(await executeGeneration('imported-image')).toEqual({ success: true });
      }
      expect(resolveProjectGenerationPrompt).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ type: 'ai-image', role: 'source' }),
      }));
      expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
        nodeId: 'imported-image', model: 'general/image-model', provider: 'general',
        prompt: 'ai-image:@{reference:参考图} 重绘', imageSize: '1K', aspectRatio: aspectRatio ?? '1:1', imageQuality: 'low', imageBackground: 'transparent',
      }));
      expect(generateText).not.toHaveBeenCalled();
      expect(store.nodes[0]).toMatchObject({ id: 'imported-image', type, position: { x: 12, y: 34 },
        data: { type, role: 'source', assetId: 'original-asset', dramaAssetId: 'character-1',
          status: 'success', imageUrl: 'https://example.com/result.png' } });
      expect(store.recordOutputHistory).toHaveBeenCalledWith('imported-image', expect.objectContaining({
        nodeType: 'ai-image', params: expect.objectContaining({ imageQuality: 'low', imageBackground: 'transparent' }),
      }));
    });
  });

  describe('AINodeDialog local ComfyUI text delivery', () => {
    afterEach(() => {
      vi.doUnmock('../../../src/services/projectSettingsService');
      vi.doUnmock('../../../src/services/pollManager');
      vi.doUnmock('../../../src/services/dramaAssetExtract');
    });

    async function setupLocalTextDialog() {
      const store = createStore([{ id: 'local-text', type: 'ai-text', position: { x: 0, y: 0 },
        data: { type: 'ai-text', label: '本地提示词增强', status: 'idle', prompt: '待增强的描述',
          provider: 'comfyui', model: 'comfyui/workflow', workflowId: 'wf-local-text', workflowInputs: { '1': '指定输入' } } }], () => 1);
      store.activeNodeId = 'local-text';
      const pendingTasks: import('../../../src/services/pollManager').PendingTask[] = [];
      const textReceipt = { projectId: 'project-a', nodeId: 'local-text', taskId: 'local-text-task', attemptId: 'text-attempt' };
      const generateTextResult = vi.fn().mockImplementation(async () => {
        pendingTasks.push({ ...textReceipt, nodeType: 'ai-text', provider: 'comfyui', taskType: 'comfyui', submitted: true,
          comfyRecoveryState: 'save_pending', comfyTextOutputNodeIds: ['7'] });
        return { text: '完整增强后的提示词', comfyTaskId: 'local-text-task' };
      });
      const generateText = vi.fn();
      const completeComfyNodeTask = vi.fn();
      const pauseComfyNodeDelivery = vi.fn();
      const prepareMediaNodeGeneration = vi.fn();
      await installReactHookDriver();
      installStoreMock(store);
      vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
      vi.doMock('../../../src/i18n', () => ({ useT: () => (text: string) => text }));
      vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
      vi.doMock('../../../src/components/nodes/shared/PromptPanel', () => ({ default: function PromptPanelMock() { return null; } }));
      vi.doMock('../../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
      vi.doMock('../../../src/services/aiService', () => ({ generateText, generateTextResult, generateImage: vi.fn(),
        generateImagesBatch: vi.fn(), generateVideo: vi.fn(), generateAudio: vi.fn(), buildPanoramaPrompt: vi.fn() }));
      vi.doMock('../../../src/services/projectSettingsService', async () => ({
        ...await vi.importActual<typeof import('../../../src/services/projectSettingsService')>('../../../src/services/projectSettingsService'),
        resolveProjectGenerationPrompt: ({ prompt }: { prompt: string }) => prompt,
      }));
      vi.doMock('../../../src/services/generationService', () => ({ executeGeneration: vi.fn(), cancelImageBatchGeneration: vi.fn(),
        isImageBatchGenerating: () => false, subscribeImageBatches: () => () => {}, usesSequentialImageBatch: () => false }));
      vi.doMock('../../../src/services/pollManager', () => ({ ...mockComfyDeliveries(), getPendingTasksForProject: () => pendingTasks,
        completeComfyNodeTask, pauseComfyNodeDelivery, prepareMediaNodeGeneration }));
      const Dialog = (await import('../../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
      const panel = () => findElement(Dialog(), (element) => componentName(element) === 'PromptPanelMock');
      return { store, panel, generateText, generateTextResult, completeComfyNodeTask, pauseComfyNodeDelivery,
        prepareMediaNodeGeneration, textReceipt };
    }

    it('passes the selected local workflow without an API key and confirms it after durable text history', async () => {
      const { store, panel, generateText, generateTextResult, completeComfyNodeTask, prepareMediaNodeGeneration, textReceipt } = await setupLocalTextDialog();
      const history = deferred<void>();
      store.recordOutputHistory.mockReturnValueOnce(history.promise);
      const pending = (panel().props.onSubmit as () => Promise<void>)();
      await vi.waitFor(() => expect(store.recordOutputHistory).toHaveBeenCalledOnce());
      expect(store.config.providers).toEqual({});
      expect(generateTextResult).toHaveBeenCalledExactlyOnceWith({ prompt: '待增强的描述', provider: 'comfyui',
        model: 'comfyui/workflow', nodeId: 'local-text', workflowId: 'wf-local-text', workflowInputs: { '1': '指定输入' } });
      expect(prepareMediaNodeGeneration).toHaveBeenCalledWith('local-text');
      expect(store.nodes[0].data.output).toBe('完整增强后的提示词');
      expect(store.recordOutputHistory).toHaveBeenCalledWith('local-text', expect.objectContaining({
        nodeType: 'ai-text', output: '完整增强后的提示词', status: 'success' }), true, textReceipt);
      expect(completeComfyNodeTask).not.toHaveBeenCalled();
      history.resolve();
      await pending;
      expect(completeComfyNodeTask).toHaveBeenCalledExactlyOnceWith('local-text', 'local-text-task');
      expect(generateText).not.toHaveBeenCalled();
    });

    it('keeps the original Comfy text task when history persistence fails', async () => {
      const { store, panel, generateTextResult, completeComfyNodeTask, pauseComfyNodeDelivery } = await setupLocalTextDialog();
      const failure = new Error('history storage failed');
      store.recordOutputHistory.mockRejectedValueOnce(failure);
      await (panel().props.onSubmit as () => Promise<void>)();
      expect(generateTextResult).toHaveBeenCalledOnce();
      expect(completeComfyNodeTask).not.toHaveBeenCalled();
      expect(pauseComfyNodeDelivery).toHaveBeenCalledWith('local-text', 'local-text-task', expect.any(Function), failure);
    });

    it('does not fill another canvas after a late local text response', async () => {
      const { store, panel, generateTextResult, completeComfyNodeTask, pauseComfyNodeDelivery } = await setupLocalTextDialog();
      const response = deferred<{ text: string; comfyTaskId: string }>();
      generateTextResult.mockReturnValueOnce(response.promise);
      const pending = (panel().props.onSubmit as () => Promise<void>)();
      await vi.waitFor(() => expect(generateTextResult).toHaveBeenCalledOnce());
      store.getCurrentRevision = () => 2;
      response.resolve({ text: '过期增强结果', comfyTaskId: 'local-text-task' });
      await pending;
      expect(store.nodes[0].data.output).toBeUndefined();
      expect(store.recordOutputHistory).not.toHaveBeenCalled();
      expect(completeComfyNodeTask).not.toHaveBeenCalled();
      expect(pauseComfyNodeDelivery).toHaveBeenCalledWith('local-text', 'local-text-task', expect.any(Function), undefined);
    });

    it('does not confirm the text task or merge extracted assets after the project changes during history persistence', async () => {
      vi.doMock('../../../src/services/dramaAssetExtract', () => ({
        prepareDramaExtractPrompt: (prompt: string) => prompt,
        postProcessDramaExtractOutput: () => ({ ok: true, output: '原项目人物简介', kind: 'character', parsed: { characters: [] } }),
      }));
      const { store, panel, completeComfyNodeTask } = await setupLocalTextDialog();
      const history = deferred<void>();
      store.recordOutputHistory.mockReturnValueOnce(history.promise);
      const pending = (panel().props.onSubmit as () => Promise<void>)();
      await vi.waitFor(() => expect(store.recordOutputHistory).toHaveBeenCalledOnce());
      store.currentProjectId = 'another-project';
      history.resolve();
      await pending;
      expect(completeComfyNodeTask).not.toHaveBeenCalled();
      expect(store.mergeDramaExtract).not.toHaveBeenCalled();
    });
  });

  describe('AINodeDialog image quality', () => {
    afterEach(() => {
      for (const module of [
        '../../../src/services/ai/mediaModelCapabilities', '../../../src/services/projectSettingsService',
        '../../../src/services/imageBatchService', '../../../src/services/pollManager',
        '../../../src/components/nodes/shared/MediaTaskStatus',
      ]) vi.doUnmock(module);
    });

    async function setupImageQualityDialog(batchCount = 1, outputsPerJob = 1) {
      const store = createStore([{
        id: 'quality-image', type: 'ai-image', position: { x: 0, y: 0 },
        data: { type: 'ai-image', label: '图片', status: 'idle', prompt: 'cat',
          model: 'general/model-a', provider: 'general', imageSize: '2K', aspectRatio: '16:9', imageQuality: 'max', imageBackground: 'transparent', batchCount,
          nodeWidth: 280, nodeHeight: 158 },
      }], () => 1);
      store.activeNodeId = 'quality-image';
      const generateImage = vi.fn().mockResolvedValue({ url: 'https://example.com/result.png', width: 1024, height: 1024 });
      const generateImagesBatch = vi.fn().mockResolvedValue({ results: [{ url: 'https://example.com/result.png' }] });
      const applyImageBatchResults = vi.fn().mockResolvedValue(true);
      const savingController = new AbortController();
      const registerNodePolling = vi.fn(() => savingController.signal);
      const cleanupNodePolling = vi.fn();
      const registerMediaNodeOperation = vi.fn((_nodeId: string, _ownsGeneration?: boolean) => vi.fn());
      const persistMediaUrlToProjectData = vi.fn(async (url: string) => ({ mediaUrl: url, sourceUrl: url, filePath: 'result.png' }));
      const completeMediaNodeTask = vi.fn();
      const pauseMediaTask = vi.fn();
      const pauseComfyNodeDelivery = vi.fn();
      const pendingTasks: import('../../../src/services/pollManager').PendingTask[] = [];
      await installReactHookDriver();
      installStoreMock(store);
      vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
      vi.doMock('../../../src/i18n', () => ({ t: (text: string) => text, useT: () => (text: string) => text }));
      vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
      vi.doMock('../../../src/components/nodes/shared/PromptPanel', () => ({ default: function PromptPanelMock() { return null; } }));
      vi.doMock('../../../src/components/nodes/shared/MediaTaskStatus', () => ({ default: function MediaTaskStatusMock() { return null; } }));
      vi.doMock('../../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
      vi.doMock('../../../src/services/aiService', () => ({
        generateText: vi.fn(), generateTextResult: vi.fn(), generateImage, generateImagesBatch, generateVideo: vi.fn(), generateAudio: vi.fn(), buildPanoramaPrompt: vi.fn(),
      }));
      vi.doMock('../../../src/services/fileService', () => ({
        persistMediaUrlToProjectData,
      }));
      vi.doMock('../../../src/services/ai/mediaModelCapabilities', async (importOriginal) => ({
        ...await importOriginal<typeof import('../../../src/services/ai/mediaModelCapabilities')>(),
        resolveImageOutputsPerJob: () => outputsPerJob,
        resolveImageParameterCapability: (model: string) => model === 'general/model-compatible'
          ? { resolutions: ['1K', '2k', '4K'], defaultResolution: '1K', ratios: ['1:1', '16:9', '9:16', 'auto'], defaultRatio: '1:1',
            qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], defaultQuality: 'auto',
            backgrounds: ['auto', 'opaque', 'transparent'], defaultBackground: 'opaque' }
          : model === 'general/model-restricted'
          ? { resolutions: ['1K'], defaultResolution: '1K', ratios: ['1:1'], defaultRatio: '1:1',
            qualities: ['low', 'medium', 'high'], defaultQuality: 'medium', backgrounds: ['auto', 'opaque'], defaultBackground: 'opaque' }
          : model === 'general/model-fixed'
          ? { resolutions: ['2K'], defaultResolution: '2K', ratios: ['16:9'], defaultRatio: '16:9',
            qualities: ['high'], defaultQuality: 'high', backgrounds: ['transparent'], defaultBackground: 'transparent', backgroundIsFixed: true }
          : ['general/model-b', 'general/model-c'].includes(model)
          ? { resolutions: ['1K'], defaultResolution: '1K', ratios: ['1:1', '16:9', '9:16'], defaultRatio: '1:1',
            qualities: ['low', 'medium', 'high'], defaultQuality: 'medium', backgrounds: ['auto', 'opaque', 'transparent'],
            defaultBackground: model === 'general/model-c' ? 'opaque' : undefined }
          : undefined,
      }));
      vi.doMock('../../../src/services/projectSettingsService', async () => ({
        ...await vi.importActual<typeof import('../../../src/services/projectSettingsService')>('../../../src/services/projectSettingsService'),
        resolveProjectGenerationPrompt: ({ prompt }: { prompt: string }) => prompt,
      }));
      vi.doMock('../../../src/services/pollManager', () => ({
        ...mockComfyDeliveries(), getPendingTasksForProject: () => pendingTasks, pauseComfyNodeDelivery,
        prepareMediaNodeGeneration: vi.fn(), registerMediaNodeOperation, completeMediaNodeTask, pauseMediaTask,
        registerNodePolling, cleanupNodePolling,
      }));
      vi.doMock('../../../src/services/imageBatchService', () => ({
        prepareImageBatchNodes: () => ({ nodeIds: ['quality-image', 'batch-image'] }),
        applyImageBatchResults, failImageBatchNodes: vi.fn(),
      }));
      const AINodeDialog = (await import('../../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
      const panel = () => findElement(AINodeDialog(), (element) => componentName(element) === 'PromptPanelMock');
      return { store, panel, generateImage, generateImagesBatch, applyImageBatchResults,
        persistMediaUrlToProjectData, savingController, registerNodePolling, cleanupNodePolling, registerMediaNodeOperation,
        completeMediaNodeTask, pauseMediaTask, pauseComfyNodeDelivery, pendingTasks, dialog: AINodeDialog };
    }

    it('固定四候选即使选择一次作业也委托完整图片交付入口，不走本地首图保存分支', async () => {
      const executeGeneration = vi.fn().mockResolvedValue({ success: true });
      vi.doMock('../../../src/services/generationService', () => ({ executeGeneration,
        subscribeImageBatches: () => () => {}, isImageBatchGenerating: () => false,
        cancelImageBatchGeneration: vi.fn(), usesSequentialImageBatch: () => false,
      }));
      const { panel, generateImage, generateImagesBatch, persistMediaUrlToProjectData } = await setupImageQualityDialog(1, 4);
      await (panel().props.onSubmit as (prompt: string) => Promise<void>)('MJ prompt');
      expect(executeGeneration).toHaveBeenCalledOnce();
      expect(executeGeneration).toHaveBeenCalledWith('quality-image', 'MJ prompt', undefined, undefined);
      expect(generateImage).not.toHaveBeenCalled();
      expect(generateImagesBatch).not.toHaveBeenCalled();
      expect(persistMediaUrlToProjectData).not.toHaveBeenCalled();
    });

    it('本地 ComfyUI 保存失败把原始错误交给恢复层，保留原任务而不重新生成', async () => {
      const { panel, store, generateImage, persistMediaUrlToProjectData, pauseComfyNodeDelivery, completeMediaNodeTask } = await setupImageQualityDialog();
      const currentAtPause: boolean[] = [];
      pauseComfyNodeDelivery.mockImplementation((_nodeId: string, _taskId: string, isCurrent: () => boolean) => {
        currentAtPause.push(isCurrent());
      });
      const error = Object.assign(new Error('生成媒体未能写入项目目录：保存目录无法写入'), {
        name: 'MediaPersistenceError', failureKind: 'permission',
      });
      generateImage.mockResolvedValueOnce({ url: 'https://example.com/result.png', width: 1024, height: 1024, comfyTaskId: 'original' });
      persistMediaUrlToProjectData.mockRejectedValueOnce(error);
      await (panel().props.onSubmit as () => Promise<void>)();
      expect(pauseComfyNodeDelivery).toHaveBeenCalledWith('quality-image', 'original', expect.any(Function), error);
      expect(currentAtPause).toEqual([true]);
      expect(pauseComfyNodeDelivery.mock.calls[0][2]()).toBe(false);
      expect(generateImage).toHaveBeenCalledOnce();
      expect(store.nodes[0].data.imageUrl).toBeUndefined();
      expect(completeMediaNodeTask).not.toHaveBeenCalled();
    });

    it('保存交付已结束但旧 loading 状态仍保留时，恢复横条不能被空的通用卡遮掉', async () => {
      const { dialog, panel, store, pendingTasks } = await setupImageQualityDialog();
      store.nodes[0].data = { ...store.nodes[0].data, provider: 'comfyui', workflowId: 'wf-1', status: 'loading', mediaTaskState: 'delivery_pending' };
      pendingTasks.push({ projectId: 'project-a', nodeId: 'quality-image', nodeType: 'ai-image', provider: 'comfyui',
        taskType: 'comfyui', taskId: 'original', submitted: true, comfyRecoveryState: 'save_pending' });
      const tree = dialog();
      expect(() => findElement(tree, (element) => componentName(element) === 'MediaTaskStatusMock')).toThrow('Element not found');
      expect(findElement(tree, (element) => element.type === 'button' && element.props.children === '继续保存')).toBeDefined();
      expect(findElement(tree, (element) => element.type === 'button' && element.props.children === '再次终止')).toBeDefined();
      expect(panel().props.canGenerate).toBe(false);
    });

    it('ComfyUI 已有通用恢复卡时不重复展示横条，但保留终止和防重复生成', async () => {
      const { dialog, panel, store, pendingTasks } = await setupImageQualityDialog();
      store.nodes[0].data = { ...store.nodes[0].data, provider: 'comfyui', workflowId: 'wf-1', status: 'idle', mediaTaskState: 'delivery_pending' };
      pendingTasks.push({ projectId: 'project-a', nodeId: 'quality-image', nodeType: 'ai-image', provider: 'comfyui',
        taskType: 'comfyui', taskId: 'original', submitted: true, comfyRecoveryState: 'save_pending' });
      const tree = dialog();
      expect(findElement(tree, (element) => componentName(element) === 'MediaTaskStatusMock')).toBeDefined();
      expect(findElement(tree, (element) => element.type === 'button' && element.props.children === '再次终止')).toBeDefined();
      expect(() => findElement(tree, (element) => element.type === 'span' && element.props.children === 'ComfyUI 已完成，结果尚未保存或回填，任务已保留')).toThrow('Element not found');
      expect(panel().props.canGenerate).toBe(false);
    });

    it.each(['save_pending', 'cancel_pending', 'output_unavailable'] as const)('ComfyUI %s 旧恢复记录或专用状态继续保留说明和原任务操作', async (recoveryState) => {
      const { dialog, panel, store, pendingTasks } = await setupImageQualityDialog();
      store.nodes[0].data = { ...store.nodes[0].data, provider: 'comfyui', workflowId: 'wf-1', status: 'error',
        mediaTaskState: recoveryState === 'save_pending' ? undefined : 'paused',
        videoTaskState: recoveryState === 'output_unavailable' ? 'paused' : undefined };
      pendingTasks.push({ projectId: 'project-a', nodeId: 'quality-image', nodeType: 'ai-image', provider: 'comfyui',
        taskType: 'comfyui', taskId: 'original', submitted: true, comfyRecoveryState: recoveryState });
      const tree = dialog();
      expect(() => findElement(tree, (element) => componentName(element) === 'MediaTaskStatusMock')).toThrow('Element not found');
      const expected = recoveryState === 'save_pending' ? 'ComfyUI 已完成，结果尚未保存或回填，任务已保留'
        : recoveryState === 'cancel_pending' ? 'ComfyUI 取消尚未确认，任务已保留'
          : 'ComfyUI 已完成，但没有可下载的目标媒体。请检查输出类型，并使用 SaveImage、PreviewImage、SaveVideo 或 SaveAudio 等文件输出节点；仅 WebSocket 出图暂不支持取回。';
      expect(findElement(tree, (element) => element.type === 'span' && element.props.children === expected)).toBeDefined();
      expect(findElement(tree, (element) => element.type === 'button' && element.props.children === '再次终止')).toBeDefined();
      expect(findElement(tree, (element) => element.type === 'button' && element.props.children === (recoveryState === 'save_pending' ? '继续保存' : '继续查询'))).toBeDefined();
      expect(panel().props.canGenerate).toBe(false);
    });

    it.each(['dialog', 'toolbar'].flatMap((entry) => ['saving', 'delivered'].map((newerStage) => ({ entry, newerStage }))))(
      '$entry 中旧同步图片迟到时不能抢占 $newerStage 的新一轮保存', async ({ entry, newerStage }) => {
        const { store, panel, generateImage, persistMediaUrlToProjectData, registerNodePolling, registerMediaNodeOperation } = await setupImageQualityDialog();
        let owner = 0;
        registerMediaNodeOperation.mockImplementation((_nodeId, ownsGeneration) => {
          const token = ownsGeneration ? ++owner : owner;
          return Object.assign(vi.fn(), { isCurrent: () => owner === token });
        });
        const saveControllers: AbortController[] = [];
        registerNodePolling.mockImplementation(() => {
          saveControllers.at(-1)?.abort();
          const controller = new AbortController();
          saveControllers.push(controller);
          return controller.signal;
        });
        const first = deferred<{ url: string; width: number; height: number }>();
        const second = deferred<{ url: string; width: number; height: number }>();
        const saving = deferred<{ mediaUrl: string; sourceUrl: string; filePath: string }>();
        generateImage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        persistMediaUrlToProjectData.mockReturnValueOnce(saving.promise);
        const submit = entry === 'dialog' ? panel().props.onSubmit as () => Promise<void> : async () => {
          vi.doUnmock('../../../src/services/generationService');
          const { executeGeneration } = await import('../../../src/services/generationService');
          await executeGeneration('quality-image');
        };
        const older = submit();
        await vi.waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
        const newer = submit();
        await vi.waitFor(() => expect(generateImage).toHaveBeenCalledTimes(2));
        expect(registerMediaNodeOperation).toHaveBeenNthCalledWith(1, 'quality-image', true);
        expect(registerMediaNodeOperation).toHaveBeenNthCalledWith(2, 'quality-image', true);
        second.resolve({ url: 'https://example.com/new.png', width: 1024, height: 1024 });
        await vi.waitFor(() => expect(persistMediaUrlToProjectData).toHaveBeenCalledOnce());
        const finishNewSave = () => saving.resolve({ mediaUrl: 'asset://new.png', sourceUrl: 'https://example.com/new.png', filePath: 'new.png' });
        if (newerStage === 'delivered') { finishNewSave(); await newer; }
        first.resolve({ url: 'https://example.com/old.png', width: 1024, height: 1024 });
        await older;
        expect(registerNodePolling).toHaveBeenCalledOnce();
        expect(saveControllers[0].signal.aborted).toBe(false);
        expect(persistMediaUrlToProjectData).toHaveBeenCalledOnce();
        if (newerStage === 'saving') { finishNewSave(); await newer; }
        expect(store.nodes[0].data.imageUrl).toBe('asset://new.png');
        expect(store.recordOutputHistory).toHaveBeenCalledOnce();
        expect(store.recordOutputHistory).toHaveBeenCalledWith('quality-image', expect.objectContaining({ output: 'https://example.com/new.png' }));
      },
    );

    it('图片保存接入取消信号，取消后保留原任务且不回填', async () => {
      const { store, panel, generateImage, persistMediaUrlToProjectData, savingController,
        registerNodePolling, cleanupNodePolling, completeMediaNodeTask, pauseMediaTask } = await setupImageQualityDialog();
      const receipt = { projectId: 'project-a', nodeId: 'quality-image', taskId: 'original', attemptId: 'first' };
      generateImage.mockResolvedValueOnce({ url: 'https://example.com/result.png', width: 1024, height: 1024, taskReceipt: receipt });
      const saving = deferred<{ mediaUrl: string; sourceUrl: string; filePath: string }>();
      persistMediaUrlToProjectData.mockReturnValueOnce(saving.promise);
      const pending = (panel().props.onSubmit as () => Promise<void>)();
      await vi.waitFor(() => expect(persistMediaUrlToProjectData).toHaveBeenCalledOnce());
      expect(registerNodePolling).toHaveBeenCalledWith('quality-image', undefined);
      expect(persistMediaUrlToProjectData).toHaveBeenCalledWith('https://example.com/result.png', 'project-a', 'ai-image', '图片', {
        mediaDownloadAccess: undefined, signal: savingController.signal,
      });
      savingController.abort();
      saving.resolve({ mediaUrl: 'asset://late.png', sourceUrl: 'https://example.com/result.png', filePath: 'late.png' });
      await pending;
      expect(store.nodes[0].data.imageUrl).toBeUndefined();
      expect(store.recordOutputHistory).not.toHaveBeenCalled();
      expect(completeMediaNodeTask).not.toHaveBeenCalled();
      expect(pauseMediaTask).toHaveBeenCalledWith(receipt, undefined, 'canvas_changed');
      expect(cleanupNodePolling).toHaveBeenCalledWith('quality-image', savingController.signal);
      expect(generateImage).toHaveBeenCalledOnce();
    });

    it('批量入口把保存取消信号交给共享交付器', async () => {
      const { panel, applyImageBatchResults, savingController, cleanupNodePolling } = await setupImageQualityDialog(2);
      await (panel().props.onSubmit as () => Promise<void>)();
      expect(applyImageBatchResults).toHaveBeenCalledWith(expect.objectContaining({ signal: savingController.signal }));
      expect(cleanupNodePolling).toHaveBeenCalledWith('quality-image', savingController.signal);
    });

    it('adjusts only incompatible quality while retaining compatible background, ratio and dimensions', async () => {
      const { store, panel } = await setupImageQualityDialog();
      const select = (value: string) => (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({ value, provider: 'general' });
      select('general/model-a');
      expect(store.nodes[0].data.imageQuality).toBe('max');
      expect(store.nodes[0].data.imageBackground).toBe('transparent');
      select('general/model-b');
      expect(store.nodes[0].data.imageQuality).toBe('medium');
      expect(store.nodes[0].data.imageBackground).toBe('transparent');
      (panel().props.onChangeImageBackground as (background: string) => void)('transparent');
      expect(store.nodes[0].data).toMatchObject({ aspectRatio: '16:9', nodeWidth: 280, nodeHeight: 158 });
      (panel().props.onChangeAspectRatio as (ratio: string) => void)('9:16');
      expect(store.nodes[0].data).toMatchObject({ aspectRatio: '9:16', nodeWidth: 158, nodeHeight: 280 });
      (panel().props.onChangeImageQuality as (quality: string) => void)('high');
      expect(store.nodes[0].data.imageQuality).toBe('high');
      select('general/model-a');
      expect(store.nodes[0].data.imageQuality).toBeUndefined();
      expect(store.nodes[0].data.imageBackground).toBeUndefined();
      expect(store.nodes[0].data.aspectRatio).toBe('9:16');
      select('general/model-b');
      (panel().props.onChangeImageBackground as (background: string) => void)('transparent');
      (panel().props.onWorkflowSelect as (id: string | undefined) => void)('workflow-1');
      expect(store.nodes[0].data.imageQuality).toBeUndefined();
      expect(store.nodes[0].data.imageBackground).toBeUndefined();
      select('general/model-b');
      expect(store.nodes[0].data.imageQuality).toBe('medium');
      (panel().props.onChangeImageBackground as (background: string) => void)('transparent');
      (panel().props.onClearModel as () => void)();
      expect(store.nodes[0].data.imageQuality).toBeUndefined();
      expect(store.nodes[0].data.imageBackground).toBeUndefined();
    });

    it('MCP图片节点在生成弹窗改比例立即改框，实际生成参数与回填后的画框保持一致', async () => {
      const { store, panel, generateImage } = await setupImageQualityDialog();
      Object.assign(store.nodes[0].data, { role: 'source', aspectRatio: '1:1', nodeWidth: 185, nodeHeight: 327,
        imageUrl: 'asset://previous.png' });
      (panel().props.onChangeAspectRatio as (ratio: string) => void)('9:16');
      expect(store.nodes[0].data).toMatchObject({ aspectRatio: '9:16', nodeWidth: 158, nodeHeight: 280 });
      await (panel().props.onSubmit as () => Promise<void>)();
      expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({ aspectRatio: '9:16' }));
      expect(store.nodes[0].data).toMatchObject({ aspectRatio: '9:16', nodeWidth: 158, nodeHeight: 280 });
    });

    it.each([
      { imageSize: '2K', imageQuality: 'xhigh', imageBackground: 'transparent', aspectRatio: '16:9' },
      { imageSize: '4K', imageQuality: 'max', imageBackground: '', aspectRatio: '9:16' },
      { imageSize: '2k', imageQuality: 'high', imageBackground: 'opaque', aspectRatio: '自适应' },
    ])('keeps compatible image parameters through the real menu callback sequence: $imageQuality / $imageBackground', async (parameters) => {
      const { store, panel } = await setupImageQualityDialog();
      Object.assign(store.nodes[0].data, parameters);
      const dimensions = { nodeWidth: store.nodes[0].data.nodeWidth, nodeHeight: store.nodes[0].data.nodeHeight };
      const callbacks = panel().props;
      (callbacks.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-compatible', provider: 'general' });
      (callbacks.onWorkflowSelect as (id: string | undefined) => void)(undefined);
      expect(store.nodes[0].data).toMatchObject({ ...parameters, ...dimensions, model: 'general/model-compatible' });
      expect(store.updateNodeData).toHaveBeenCalledTimes(1);
      // 重选同一型号并再次通知清空工作流，也不能覆盖已选参数。
      (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-compatible', provider: 'general' });
      (panel().props.onWorkflowSelect as (id: string | undefined) => void)(undefined);
      expect(store.nodes[0].data).toMatchObject({ ...parameters, ...dimensions });
    });

    it('falls back only unsupported values and updates dimensions only for an incompatible ratio', async () => {
      const { store, panel } = await setupImageQualityDialog();
      (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-restricted', provider: 'general' });
      (panel().props.onWorkflowSelect as (id: string | undefined) => void)(undefined);
      expect(store.nodes[0].data).toMatchObject({ imageSize: '1K', imageQuality: 'medium', imageBackground: 'opaque',
        aspectRatio: '1:1', nodeWidth: 280, nodeHeight: 280 });
    });

    it('clears workflow execution fields once without resetting compatible image parameters', async () => {
      const { store, panel } = await setupImageQualityDialog();
      Object.assign(store.nodes[0].data, { workflowId: 'previous-workflow', workflowInputs: { prompt: 'old workflow input' },
        workflowApiOutputs: [{ url: 'https://example.com/old.png', kind: 'image' }], workflowApiStage: '已完成', comfyRefmods: [] });
      const callbacks = panel().props;
      (callbacks.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-compatible', provider: 'general' });
      (callbacks.onWorkflowSelect as (id: string | undefined) => void)(undefined);
      expect(store.nodes[0].data).toMatchObject({ workflowId: undefined, workflowInputs: undefined,
        workflowApiOutputs: undefined, workflowApiStage: undefined, comfyRefmods: undefined,
        imageSize: '2K', imageQuality: 'max', imageBackground: 'transparent', aspectRatio: '16:9', nodeWidth: 280, nodeHeight: 158 });
      expect(store.updateNodeData).toHaveBeenCalledTimes(1);
    });

    it('honors a fixed background contract while retaining the compatible resolution and ratio', async () => {
      const { store, panel } = await setupImageQualityDialog();
      store.nodes[0].data.imageBackground = '';
      (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-fixed', provider: 'general' });
      (panel().props.onWorkflowSelect as (id: string | undefined) => void)(undefined);
      expect(store.nodes[0].data).toMatchObject({ imageSize: '2K', imageQuality: 'high', imageBackground: 'transparent',
        aspectRatio: '16:9', nodeWidth: 280, nodeHeight: 158 });
    });

    it('does not initialize an unset ratio or discard explicit API-default background on a model change', async () => {
      const { store, panel } = await setupImageQualityDialog();
      Object.assign(store.nodes[0].data, { aspectRatio: undefined, imageBackground: '' });
      (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-compatible', provider: 'general' });
      (panel().props.onWorkflowSelect as (id: string | undefined) => void)(undefined);
      expect(store.nodes[0].data).toMatchObject({ imageSize: '2K', imageQuality: 'max', imageBackground: '',
        aspectRatio: undefined, nodeWidth: 280, nodeHeight: 158 });
    });

    it('keeps a compatible Dreamina resolution when selecting an OAuth image model', async () => {
      const { store, panel } = await setupImageQualityDialog();
      (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'dreamina/3.0', provider: 'dreamina' });
      (panel().props.onWorkflowSelect as (id: string | undefined) => void)(undefined);
      expect(store.nodes[0].data).toMatchObject({ imageSize: '2K', imageQuality: undefined, imageBackground: undefined,
        aspectRatio: '16:9', nodeWidth: 280, nodeHeight: 158 });
    });

    it.each([
      { count: 1, quality: undefined, expected: 'medium' }, { count: 1, quality: 'high', expected: 'high' },
      { count: 2, quality: undefined, expected: 'medium' }, { count: 2, quality: 'high', expected: 'high' },
    ])('passes effective quality $expected through submission/history for batch count $count', async ({ count, quality, expected }) => {
      const { store, panel, generateImage, generateImagesBatch, applyImageBatchResults } = await setupImageQualityDialog(count);
      const currentPanel = panel();
      (currentPanel.props.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-b', provider: 'general' });
      (currentPanel.props.onChangeImageQuality as (quality: string | undefined) => void)(quality);
      await (currentPanel.props.onSubmit as () => Promise<void>)();
      if (count === 1) {
        expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({ imageQuality: expected }));
        expect(store.recordOutputHistory).toHaveBeenCalledWith('quality-image', expect.objectContaining({
          params: expect.objectContaining({ imageQuality: expected }),
        }));
      } else {
        expect(generateImagesBatch).toHaveBeenCalledWith(expect.objectContaining({ imageQuality: expected }), 2);
        expect(applyImageBatchResults).toHaveBeenCalledWith(expect.objectContaining({ imageQuality: expected }));
      }
    });

    it('omits stale quality when the selected model has no quality capability', async () => {
      const { store, panel, generateImage } = await setupImageQualityDialog();
      await (panel().props.onSubmit as () => Promise<void>)();
      expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({ imageQuality: undefined, imageBackground: undefined }));
      expect(store.recordOutputHistory).toHaveBeenCalledWith('quality-image', expect.objectContaining({
        params: expect.objectContaining({ imageQuality: undefined, imageBackground: undefined }),
      }));
    });

    it.each([1, 2].flatMap((count) => (count === 1 ? ['dialog', 'toolbar', 'selection'] : ['dialog', 'toolbar']).flatMap((entry) => (
      [undefined, 'transparent', ''].map((background) => ({ count, entry, background }))
    ))))('passes background $background through $entry with batch count $count while history keeps the effective value', async ({ count, entry, background }) => {
      const { store, panel, generateImage, generateImagesBatch, applyImageBatchResults } = await setupImageQualityDialog(count);
      const currentPanel = panel();
      (currentPanel.props.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-c', provider: 'general' });
      expect(store.nodes[0].data.imageBackground).toBe('transparent');
      (currentPanel.props.onChangeImageBackground as (value: string | undefined) => void)(background);
      const effective = background === '' ? undefined : background ?? 'opaque';
      const requested = background === '' ? '' : effective;
      if (entry === 'dialog') await (currentPanel.props.onSubmit as () => Promise<void>)();
      else if (entry === 'toolbar') {
        vi.doUnmock('../../../src/services/generationService');
        const { executeGeneration } = await import('../../../src/services/generationService');
        expect(await executeGeneration('quality-image')).toEqual({ success: true });
      } else {
        vi.doUnmock('../../../src/services/generationService');
        vi.doUnmock('../../../src/utils/batchExecute');
        const { batchExecuteNodes } = await import('../../../src/utils/batchExecute');
        expect(await batchExecuteNodes(['quality-image'], store.nodes as unknown as Parameters<typeof batchExecuteNodes>[1], [], {
          commitToHistory: store.commitToHistory, currentProjectId: store.currentProjectId,
        })).toEqual({ ok: 1, fail: 0, skipped: 0 });
      }
      if (count === 1) {
        expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({ imageBackground: requested, aspectRatio: '16:9' }));
        expect(store.recordOutputHistory).toHaveBeenCalledWith('quality-image', expect.objectContaining({
          params: expect.objectContaining({ imageBackground: effective }),
        }));
      } else {
        expect(generateImagesBatch).toHaveBeenCalledWith(expect.objectContaining({ imageBackground: requested, aspectRatio: '16:9' }), 2);
        expect(applyImageBatchResults).toHaveBeenCalledWith(expect.objectContaining({ imageBackground: effective }));
      }
      expect(store.nodes[0].data).toMatchObject({ aspectRatio: '16:9', nodeWidth: 280, nodeHeight: 158 });
    });
  });
}

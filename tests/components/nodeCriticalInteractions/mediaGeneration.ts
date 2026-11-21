import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmVideoReferencesBeforeGeneration,
  findElement,
  componentName,
  installReactHookDriver,
  createStore,
  installStoreMock,
  mockComfyDeliveries,
} from './nodeFixture';

export function registerMediaGenerationTests() {
  it.each([
    { catalogId: 'libapi', modelId: 'gm-3.1-flash-tts', customized: false, adapted: true },
    { catalogId: 'custom-openai', modelId: 'gm-3.1-flash-tts', customized: false, adapted: false },
    { catalogId: 'libapi', modelId: 'gm-3.1-flash-tts', customized: true, adapted: false },
    { catalogId: 'minimax', modelId: 'speech-2.8-hd', customized: false, adapted: true },
    { catalogId: 'minimax', modelId: 'speech-2.8-turbo', customized: false, adapted: true },
    { catalogId: 'custom-openai', modelId: 'speech-2.8-hd', customized: false, adapted: false },
    { catalogId: 'minimax', modelId: 'speech-2.8-hd', customized: true, adapted: false },
  ])('音频模型切换按真实合同清理参数并保留兼容的声音、格式和语速（$modelId / $catalogId / 自定义 $customized）', async ({ catalogId, modelId, customized, adapted }) => {
    const { getProviderDefinition } = await import('../../../src/services/ai/providerCatalogService');
    const usesVoiceId = modelId.startsWith('speech-');
    const selected = structuredClone(getProviderDefinition(usesVoiceId ? 'minimax' : 'libapi')!.models!.find((model) => model.id === modelId)!);
    if (customized) selected.executionProfile!.protocol!.submit.path = '/custom/audio';
    const voice = usesVoiceId ? 'male-qn-qingse' : 'alloy';
    const store = createStore([{
      id: 'speech-node', type: 'ai-audio', position: { x: 0, y: 0 }, data: { type: 'ai-audio', label: '配音', status: 'idle',
        prompt: '你好', model: 'general/previous-audio', provider: 'general', audioVoice: voice, audioFormat: 'wav', audioSpeed: 1,
        musicDuration: 60, musicBpm: 120, autoGenerateLyrics: true },
    }], () => 1);
    store.activeNodeId = 'speech-node';
    store.config = { ...store.config, providers: { 'audio-connection': { name: '音频连接', apiKey: 'fixture', catalogId } },
      generalModels: [{ id: 'selected-audio', name: selected.name, modelId: selected.id, category: 'audio',
        providerConfigId: 'audio-connection', executionProfile: selected.executionProfile }] };
    await installReactHookDriver();
    installStoreMock(store);
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('../../../src/i18n', () => ({ useT: () => (text: string) => text }));
    vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
    vi.doMock('../../../src/components/nodes/shared/PromptPanel', () => ({ default: function PromptPanelMock() { return null; } }));
    vi.doMock('../../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
    vi.doMock('../../../src/services/aiService', () => ({ generateText: vi.fn(), generateTextResult: vi.fn(), generateImage: vi.fn(), generateImagesBatch: vi.fn(),
      generateVideo: vi.fn(), generateAudio: vi.fn(), buildPanoramaPrompt: vi.fn() }));
    vi.doMock('../../../src/services/pollManager', () => ({ ...mockComfyDeliveries(), getPendingTasksForProject: () => [],
      prepareMediaNodeGeneration: vi.fn(), registerMediaNodeOperation: () => vi.fn(), completeMediaNodeTask: vi.fn() }));
    const Dialog = (await import('../../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
    const panel = () => findElement(Dialog(), (element) => componentName(element) === 'PromptPanelMock');
    (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({
      value: 'general/selected-audio', provider: 'general', audioPurpose: 'speech',
    });
    expect(store.nodes[0].data.audioFormat).toBe('wav');
    if (adapted) {
      expect(store.nodes[0].data).toMatchObject({ audioVoice: usesVoiceId ? voice : undefined, audioSpeed: usesVoiceId ? 1 : undefined,
        musicDuration: undefined, musicBpm: undefined, autoGenerateLyrics: undefined });
      expect(panel().props.audioVoice).toBe(usesVoiceId ? voice : undefined);
      expect(panel().props.audioSpeed).toBe(usesVoiceId ? 1 : undefined);
    } else {
      expect(store.nodes[0].data).toMatchObject({ audioVoice: voice, audioSpeed: 1,
        musicDuration: 60, musicBpm: 120, autoGenerateLyrics: true });
    }
  });

  describe('MiniMax 普通 TTS 的共享参数控件', () => {
    afterEach(() => {
      vi.doUnmock('framer-motion');
      vi.doUnmock('../../../src/components/nodes/shared/AudioParamSelector');
      vi.doUnmock('../../../src/components/nodes/shared/PromptPanel');
    });

    it.each(['minimax', 'custom-openai'])('PromptPanel 按真实 %s 连接传递声音与格式能力', async (catalogId) => {
      const { resolveMinimaxExecutionProfile } = await import('../../../src/services/ai/providers/minimaxModelManifest');
      const store = Object.assign(createStore([], () => 1), {
        userPresets: [], presetFolders: [], userSkills: [], agentPackageSkills: [],
      });
      store.config = { ...store.config,
        providers: { minimax: { name: 'MiniMax 官方', catalogId, apiKey: 'fixture' } },
        generalModels: [{ id: 'tts', name: 'Speech 2.8', modelId: 'speech-2.8-hd', category: 'audio', providerConfigId: 'minimax',
          executionProfile: resolveMinimaxExecutionProfile('speech-2.8-hd') }],
      };
      await installReactHookDriver();
      installStoreMock(store);
      vi.doMock('../../../src/i18n', () => ({ useT: () => (text: string) => text, t: (text: string) => text }));
      // Framer Motion 的 CJS Hook 持有真实 React；本用例的元素树驱动只替换直接导入的 React Hook。
      vi.doMock('framer-motion', async () => ({
        ...await vi.importActual<typeof import('framer-motion')>('framer-motion'),
        useReducedMotion: () => false,
      }));
      vi.doUnmock('../../../src/components/nodes/shared/PromptPanel');
      vi.doUnmock('../../../src/components/nodes/shared/defaultModels');
      vi.doMock('../../../src/components/nodes/shared/AudioParamSelector', () => ({
        default: function AudioParamSelectorMock() { return null; },
      }));
      const Panel = (await import('../../../src/components/nodes/shared/PromptPanel')).default;
      const tree = Panel({ nodeType: 'ai-audio', selectedModel: 'general/tts', selectedProvider: 'general', prompt: '你好',
        onChange: vi.fn(), onSubmit: vi.fn(), onModelSelect: vi.fn() });
      const params = findElement(tree, (element) => componentName(element) === 'AudioParamSelectorMock');
      if (catalogId === 'minimax') {
        expect(params.props.capability).toMatchObject({ kind: 'speech', voiceInput: 'id', defaultVoice: 'male-qn-qingse',
          formats: ['mp3', 'wav', 'flac'], defaultFormat: 'mp3', speed: { min: 0.5, max: 2, default: 1 } });
      } else expect(params.props.capability).toBeUndefined();
    });
  });

  it.each([
    { type: 'source-text', generationType: 'ai-text' },
    { type: 'ai-markdown', generationType: 'ai-text' },
    { type: 'source-video', generationType: 'ai-video' },
    { type: 'source-audio', generationType: 'ai-audio' },
  ].flatMap((item) => ['dialog', 'toolbar'].map((entry) => ({ ...item, entry }))))('routes $type through $entry while preserving the original node identity', async ({ type, generationType, entry }) => {
    const store = createStore([{
      id: 'source-node', type, position: { x: 12, y: 34 },
      data: { type, label: '原始素材', role: 'source', status: 'success', output: '原始正文',
        prompt: '参考 @{reference:原始素材} 生成', model: 'old-model', provider: 'general', assetId: 'asset-1' },
    }], () => 1);
    store.activeNodeId = 'source-node';
    const generateText = vi.fn().mockResolvedValue('生成后的文本');
    const generateVideo = vi.fn().mockResolvedValue({ url: 'https://example.com/result.mp4' });
    const generateAudio = vi.fn().mockResolvedValue({ url: 'https://example.com/result.mp3' });
    const generateImage = vi.fn();
    await installReactHookDriver(); installStoreMock(store);
    vi.doUnmock('../../../src/services/generationService');
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('../../../src/i18n', () => ({ useT: () => (text: string) => text }));
    vi.doMock('../../../src/components/nodes/shared/PromptPanel', () => ({ default: function PromptPanelMock() { return null; } }));
    vi.doMock('../../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
    vi.doMock('../../../src/services/aiService', () => ({
      generateText, generateVideo, generateAudio, generateImage, generateImagesBatch: vi.fn(), buildPanoramaPrompt: vi.fn(),
    }));
    vi.doMock('../../../src/services/fileService', () => ({
      persistMediaUrlToProjectData: vi.fn(async (url: string) => ({ mediaUrl: url, sourceUrl: url })),
    }));
    vi.doMock('../../../src/services/ai/generateAudio', () => ({
      persistAudioGenerationResult: vi.fn(async ({ url }: { url: string }) => ({ mediaUrl: url, sourceUrl: url, outputUrl: url })),
    }));
    vi.doMock('../../../src/services/projectSettingsService', async () => ({
      ...await vi.importActual<typeof import('../../../src/services/projectSettingsService')>('../../../src/services/projectSettingsService'),
      resolveProjectGenerationPrompt: ({ prompt }: { prompt: string }) => prompt,
    }));
    vi.doMock('../../../src/services/pollManager', () => ({
      ...mockComfyDeliveries(),
      getPendingTasksForProject: () => [], prepareVideoNodeGeneration: vi.fn(), completeVideoNodeTask: vi.fn(),
    }));
    const AINodeDialog = (await import('../../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
    const panel = findElement(AINodeDialog(), (element) => componentName(element) === 'PromptPanelMock');
    expect(panel.props.nodeType).toBe(generationType);
    expect(typeof panel.props.onPassThrough).toBe(generationType === 'ai-text' ? 'function' : 'undefined');
    (panel.props.onModelSelect as (model: Record<string, unknown>) => void)({
      value: 'general/new-model', provider: 'general', label: '模型',
    });
    expect(store.nodes[0].data).toMatchObject({ type, role: 'source', output: '原始正文', model: 'general/new-model' });
    if (entry === 'dialog') await (panel.props.onSubmit as () => Promise<void>)();
    else {
      const { executeGeneration } = await import('../../../src/services/generationService');
      expect(await executeGeneration('source-node')).toEqual({ success: true });
    }
    if (entry === 'dialog' && generationType === 'ai-video') {
      expect(confirmVideoReferencesBeforeGeneration).toHaveBeenCalledExactlyOnceWith('source-node', undefined);
    } else {
      expect(confirmVideoReferencesBeforeGeneration).not.toHaveBeenCalled();
    }
    const expectedGenerator = generationType === 'ai-text' ? generateText : generationType === 'ai-video' ? generateVideo : generateAudio;
    expect(expectedGenerator).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '参考 @{reference:原始素材} 生成', model: 'general/new-model', provider: 'general',
    }));
    expect([generateText, generateVideo, generateAudio].filter((generate) => generate.mock.calls.length)).toEqual([expectedGenerator]);
    expect(generateImage).not.toHaveBeenCalled();
    expect(store.nodes[0]).toMatchObject({ id: 'source-node', type, position: { x: 12, y: 34 },
      data: { type, role: 'source', assetId: 'asset-1', status: 'success' } });
    expect(store.recordOutputHistory).toHaveBeenCalledWith('source-node', expect.objectContaining({ nodeType: generationType }),
      ...(generationType === 'ai-video' ? [true] : []));
    vi.doUnmock('../../../src/services/projectSettingsService');
  });

  describe('text asset extraction preserves source content on failure', () => {
    afterEach(() => { vi.doUnmock('../../../src/services/projectSettingsService'); });

    async function setupExtraction(entry: 'dialog' | 'toolbar', kind: 'character' | 'scene' | 'prop', output = '原始剧本：阿青在旧车站捡到一枚铜钥匙。') {
      const type = kind === 'character' ? 'source-text' : kind === 'scene' ? 'ai-markdown' : 'ai-text';
      const store = createStore([{
        id: 'script-source', type, position: { x: 12, y: 34 },
        data: { type, label: '分镜执行单.md', role: 'source', status: 'success', output,
          prompt: '', model: 'general/text-model', provider: 'general', assetId: 'source-file' },
      }], () => 1);
      store.activeNodeId = 'script-source';
      const generateText = vi.fn().mockResolvedValue(JSON.stringify({ kind, items: [{ name: '提取资产', summary: '有效简介' }] }));
      await installReactHookDriver(); installStoreMock(store);
      vi.doUnmock('../../../src/services/generationService');
      vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
      vi.doMock('../../../src/i18n', () => ({ useT: () => (text: string) => text }));
      vi.doMock('../../../src/components/nodes/shared/PromptPanel', () => ({ default: function PromptPanelMock() { return null; } }));
      vi.doMock('../../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
      vi.doMock('../../../src/services/aiService', () => ({ generateText, generateImage: vi.fn(), generateImagesBatch: vi.fn(),
        generateVideo: vi.fn(), generateAudio: vi.fn(), buildPanoramaPrompt: vi.fn() }));
      vi.doMock('../../../src/services/projectSettingsService', async () => ({
        ...await vi.importActual<typeof import('../../../src/services/projectSettingsService')>('../../../src/services/projectSettingsService'),
        resolveProjectGenerationPrompt: ({ prompt }: { prompt: string }) => `${prompt}\n\n项目附加提示词：简介要简洁。`,
      }));
      vi.doMock('../../../src/services/pollManager', () => ({ ...mockComfyDeliveries(), getPendingTasksForProject: () => [] }));
      const { getSlashCommands, fillTemplate } = await import('../../../src/components/nodes/shared/slashCommands');
      const id = kind === 'character' ? 'text-extract-characters' : kind === 'scene' ? 'text-extract-scenes' : 'text-extract-props';
      const command = getSlashCommands('ai-text').find((item) => item.id === id)!;
      const prompt = fillTemplate(command.promptTemplate!, '');
      const submit = async () => {
        if (entry === 'toolbar') {
          const { executeGeneration } = await import('../../../src/services/generationService');
          return executeGeneration('script-source', prompt);
        }
        const Dialog = (await import('../../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
        const panel = findElement(Dialog(), (element) => componentName(element) === 'PromptPanelMock');
        return (panel.props.onSubmit as (prompt: string) => Promise<void>)(prompt);
      };
      return { store, generateText, submit, output, type };
    }

    const extractionCases = (['character', 'scene', 'prop'] as const).flatMap((kind) => (
      (['dialog', 'toolbar'] as const).map((entry) => ({ kind, entry }))
    ));
    it.each(extractionCases.flatMap((item) => ['invalid-json', 'empty-items', 'request-error'].map((failure) => ({ ...item, failure }))))(
      'keeps $kind original content and failure history through $entry on $failure', async ({ kind, entry, failure }) => {
      const { store, generateText, submit, output, type } = await setupExtraction(entry, kind);
      if (failure === 'request-error') generateText.mockRejectedValueOnce(new Error('测试接口暂时不可用'));
      else generateText.mockResolvedValueOnce(failure === 'empty-items' ? JSON.stringify({ kind, items: [], notes: '未提供正文' }) : '这不是有效 JSON');
      const result = await submit();
      if (entry === 'toolbar') expect(result).toMatchObject({ success: false });
      expect(generateText).toHaveBeenCalledOnce();
      const sent = generateText.mock.calls[0][0].prompt as string;
      expect(sent).toContain(output);
      expect(sent.indexOf(output)).toBeLessThan(sent.indexOf('项目附加提示词'));
      expect(store.nodes[0]).toMatchObject({ id: 'script-source', type, position: { x: 12, y: 34 },
        data: { role: 'source', assetId: 'source-file', output, status: 'error', error: expect.any(String) } });
      expect(store.mergeDramaExtract).not.toHaveBeenCalled();
      expect(store.updateNodeData).not.toHaveBeenCalled();
      expect(store.recordOutputHistory).toHaveBeenCalledExactlyOnceWith('script-source', expect.objectContaining({ status: 'error', output: '', error: expect.any(String) }));
      expect(store.showToast).toHaveBeenCalledWith(expect.any(String), 'error');
    });

    it.each(extractionCases)('fills $kind script and accepts a validated result through $entry', async ({ kind, entry }) => {
      const { store, generateText, submit, output, type } = await setupExtraction(entry, kind);
      await submit();
      expect(generateText).toHaveBeenCalledOnce();
      expect(generateText.mock.calls[0][0].prompt).toContain(output);
      expect(store.nodes[0]).toMatchObject({ type, data: { role: 'source', assetId: 'source-file', status: 'success' } });
      expect(store.nodes[0].data.output).toContain('提取资产');
      expect(store.mergeDramaExtract).toHaveBeenCalledOnce();
      expect(store.recordOutputHistory).toHaveBeenCalledExactlyOnceWith('script-source', expect.objectContaining({ status: 'success', prompt: expect.stringContaining(output) }));
    });

    it.each(['dialog', 'toolbar'] as const)('rejects an empty source before requesting the model through %s', async (entry) => {
      const { store, generateText, submit } = await setupExtraction(entry, 'character', '');
      const result = await submit();
      if (entry === 'toolbar') expect(result).toMatchObject({ success: false });
      expect(generateText).not.toHaveBeenCalled();
      expect(store.nodes[0].data).toMatchObject({ output: '', status: 'error', error: expect.stringContaining('缺少剧本正文') });
      expect(store.mergeDramaExtract).not.toHaveBeenCalled();
      expect(store.recordOutputHistory).toHaveBeenCalledWith('script-source', expect.objectContaining({ status: 'error' }));
    });
  });

  describe('AINodeDialog shared video generation', () => {
    afterEach(() => {
      vi.doUnmock('../../../src/services/generationService');
    });

    it.each(['ai-video', 'source-video'].flatMap((type) => (
      ['submit', 'reference-cancel', 'project-switch', 'node-replaced', 'comfy-recovery'].map((scenario) => ({ type, scenario }))
    )))('delegates $type safely after loading the executor: $scenario', async ({ type, scenario }) => {
      const store = createStore([{
        id: 'video-node', type, position: { x: 0, y: 0 },
        data: { type, label: '视频', prompt: '旧提示词', model: 'general/video', provider: 'general' },
      }], () => 1);
      store.activeNodeId = 'video-node';
      const executeGeneration = vi.fn().mockResolvedValue({ success: true });
      await installReactHookDriver();
      installStoreMock(store);
      vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
      vi.doMock('../../../src/i18n', () => ({ useT: () => (text: string) => text }));
      vi.doMock('../../../src/components/nodes/shared/PromptPanel', () => ({
        default: function PromptPanelMock() { return null; },
      }));
      vi.doMock('../../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
      vi.doMock('../../../src/services/pollManager', () => ({
        ...mockComfyDeliveries(),
        getPendingTasksForProject: () => scenario === 'comfy-recovery'
          ? [{ nodeId: 'video-node', taskType: 'comfyui', comfyRecoveryState: 'cancel_pending' }] : [],
      }));
      vi.doMock('../../../src/services/generationService', () => ({
        executeGeneration, subscribeImageBatches: () => () => {}, isImageBatchGenerating: () => false,
        cancelImageBatchGeneration: vi.fn(), usesSequentialImageBatch: () => false,
      }));
      const AINodeDialog = (await import('../../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
      const panel = findElement(AINodeDialog(), (element) => componentName(element) === 'PromptPanelMock');
      const overridePrompt = '@{sheet/shot/stable-row:第1镜} 保留附加要求';
      if (scenario === 'reference-cancel') confirmVideoReferencesBeforeGeneration.mockResolvedValueOnce(false);
      const submission = (panel.props.onSubmit as (prompt: string) => Promise<void>)(overridePrompt);
      if (scenario === 'comfy-recovery') {
        await submission;
        expect(store.showToast).toHaveBeenCalledWith('该节点还有未确认结束的 ComfyUI 任务，请先继续查询或终止任务', 'error');
      } else {
        // onSubmit 已捕获原始节点；在动态 import 的 await 边界切换输入。
        if (scenario === 'project-switch') store.currentProjectId = 'project-b';
        if (scenario === 'node-replaced') {
          store.nodes[0] = { ...store.nodes[0], data: { ...store.nodes[0].data, prompt: '新提示词' } };
        }
        await submission;
      }
      if (scenario === 'submit') {
        expect(confirmVideoReferencesBeforeGeneration).toHaveBeenCalledExactlyOnceWith('video-node', overridePrompt);
        expect(executeGeneration).toHaveBeenCalledExactlyOnceWith('video-node', overridePrompt);
      } else {
        if (scenario === 'reference-cancel') {
          expect(confirmVideoReferencesBeforeGeneration).toHaveBeenCalledExactlyOnceWith('video-node', overridePrompt);
        } else {
          expect(confirmVideoReferencesBeforeGeneration).not.toHaveBeenCalled();
        }
        expect(executeGeneration).not.toHaveBeenCalled();
      }
      expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
      expect(store.recordOutputHistory).not.toHaveBeenCalled();
    });
  });

  describe('AINodeDialog shared audio generation', () => {
    it.each([
      { type: 'ai-audio', scenario: 'submit' },
      { type: 'source-audio', scenario: 'submit' },
      { type: 'ai-audio', scenario: 'project-switch' },
      { type: 'source-audio', scenario: 'node-replaced' },
      { type: 'ai-audio', scenario: 'missing-model' },
      { type: 'ai-audio', scenario: 'missing-provider' },
    ])('delegates $type using the original input identity: $scenario', async ({ type, scenario }) => {
      const store = createStore([{
        id: 'audio-node', type, position: { x: 0, y: 0 },
        data: { type, label: '配音', prompt: '当前节点提示词',
          model: scenario === 'missing-model' ? undefined : 'general/voice',
          provider: scenario === 'missing-provider' ? undefined : 'general' },
      }], () => 1);
      store.activeNodeId = 'audio-node';
      store.projects[0].settings = { defaultModels: { audio: 'general/default-voice' } };
      const executeGeneration = vi.fn().mockResolvedValue({ success: true });
      await installReactHookDriver();
      installStoreMock(store);
      vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
      vi.doMock('../../../src/i18n', () => ({ useT: () => (text: string) => text }));
      vi.doMock('../../../src/components/nodes/shared/PromptPanel', () => ({
        default: function PromptPanelMock() { return null; },
      }));
      vi.doMock('../../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
      vi.doMock('../../../src/services/pollManager', () => ({ ...mockComfyDeliveries(), getPendingTasksForProject: () => [] }));
      vi.doMock('../../../src/services/generationService', () => ({
        executeGeneration, subscribeImageBatches: () => () => {}, isImageBatchGenerating: () => false,
        cancelImageBatchGeneration: vi.fn(), usesSequentialImageBatch: () => false,
      }));
      const Dialog = (await import('../../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
      const panel = findElement(Dialog(), (element) => componentName(element) === 'PromptPanelMock');
      const override = '临时配音提示词 @{reference:角色声音}';
      const submission = (panel.props.onSubmit as (prompt: string) => Promise<void>)(override);
      if (scenario === 'project-switch') store.currentProjectId = 'project-b';
      if (scenario === 'node-replaced') {
        store.nodes[0] = { ...store.nodes[0], data: { ...store.nodes[0].data, prompt: '编辑后的正文' } };
      }

      await submission;

      if (scenario === 'submit') expect(executeGeneration).toHaveBeenCalledExactlyOnceWith('audio-node', override, undefined);
      else expect(executeGeneration).not.toHaveBeenCalled();
      if (scenario === 'missing-model' || scenario === 'missing-provider') {
        expect(store.showToast).toHaveBeenCalledWith('请先在底部模型选择器中选择一个模型', 'error');
      }
      expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
      expect(store.recordOutputHistory).not.toHaveBeenCalled();
    });
  });

  it.each([
    { label: '通用到通用', from: 'general/video-a', fromProvider: 'general', to: 'general/video-b', provider: 'general', ratio: '9:16' },
    { label: '通用到原生', from: 'general/video-a', fromProvider: 'general', to: 'volcengine/doubao-seedance-2-5', provider: 'volcengine', ratio: '9:16' },
    { label: '原生到通用', from: 'apimart/seedance-2.5', fromProvider: 'apimart', to: 'general/video-b', provider: 'general', ratio: '9:16' },
    { label: '原生到原生', from: 'volcengine/doubao-seedance-2-5', fromProvider: 'volcengine', to: 'dreamina/seedance2.5', provider: 'dreamina', ratio: '16:9' },
    { label: '未设比例到通用', from: 'general/video-a', fromProvider: 'general', to: 'general/video-b', provider: 'general', ratio: undefined },
    { label: '未设比例到原生', from: 'general/video-a', fromProvider: 'general', to: 'dreamina/seedance2.5', provider: 'dreamina', ratio: undefined },
    { label: '重选同一通用模型', from: 'general/video-a', fromProvider: 'general', to: 'general/video-a', provider: 'general', ratio: '9:16' },
    { label: '未设比例重选同一原生模型', from: 'volcengine/doubao-seedance-2-5', fromProvider: 'volcengine', to: 'volcengine/doubao-seedance-2-5', provider: 'volcengine', ratio: undefined },
    { label: '工作流转通用模型', from: 'comfyui/workflow-a', fromProvider: 'comfyui', to: 'general/video-b', provider: 'general', ratio: '9:16', workflowId: 'workflow-a' },
    { label: '未设置任何参数到原生', from: 'general/video-a', fromProvider: 'general', to: 'dreamina/seedance2.5', provider: 'dreamina', ratio: undefined, unsetParameters: true },
  ])('视频模型切换保留已有参数（$label）', async ({ from, fromProvider, to, provider, ratio, workflowId, unsetParameters }) => {
    const parameters = { videoResolution: unsetParameters ? undefined : 1280, videoFps: unsetParameters ? undefined : 30,
      videoFrames: unsetParameters ? undefined : 301, seedanceResolution: unsetParameters ? undefined : '1080p',
      seedanceDuration: unsetParameters ? undefined : 10, generateAudio: unsetParameters ? undefined : false };
    const store = createStore([{
      id: 'ratio-video', type: 'ai-video', position: { x: 0, y: 0 }, data: {
        type: 'ai-video', label: '比例保持', status: 'idle', prompt: '视频', model: from, provider: fromProvider,
        seedanceRatio: ratio, aspectRatio: ratio, nodeWidth: 280, nodeHeight: 498,
        ...parameters, workflowId,
      },
    }], () => 1);
    store.activeNodeId = 'ratio-video';
    await installReactHookDriver();
    installStoreMock(store);
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('../../../src/i18n', () => ({ useT: () => (text: string) => text }));
    vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
    vi.doMock('../../../src/components/nodes/shared/PromptPanel', () => ({ default: function PromptPanelMock() { return null; } }));
    vi.doMock('../../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
    const generateVideo = vi.fn();
    vi.doMock('../../../src/services/aiService', () => ({ generateText: vi.fn(), generateTextResult: vi.fn(), generateImage: vi.fn(), generateImagesBatch: vi.fn(),
      generateVideo, generateAudio: vi.fn(), buildPanoramaPrompt: vi.fn() }));
    vi.doMock('../../../src/services/pollManager', () => ({ ...mockComfyDeliveries(), getPendingTasksForProject: () => [],
      prepareMediaNodeGeneration: vi.fn(), registerMediaNodeOperation: () => vi.fn(), completeMediaNodeTask: vi.fn() }));
    const Dialog = (await import('../../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
    const panel = () => findElement(Dialog(), (element) => componentName(element) === 'PromptPanelMock');
    (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({ value: to, provider });
    expect(store.nodes[0].data).toMatchObject({ model: to, provider, seedanceRatio: ratio,
      aspectRatio: ratio, nodeWidth: 280, nodeHeight: 498, workflowId: undefined,
      ...parameters });
    expect(panel().props.seedanceRatio).toBe(ratio);
    expect(panel().props.seedanceResolution).toBe(parameters.seedanceResolution);
    for (const key of ['seedanceRatio', ...Object.keys(parameters)]) {
      expect(store.updateNodeData.mock.calls.at(-1)?.[1]).not.toHaveProperty(key);
    }
    expect(generateVideo).not.toHaveBeenCalled();
  });

  it('AINodeDialog submits the latest video parameters and resolved project prompt', async () => {
    const originalData = {
      type: 'ai-video',
      label: 'Video node',
      prompt: 'old prompt',
      model: 'old-model',
      provider: 'old-provider',
      videoResolution: 640,
      videoFps: 24,
      videoFrames: 77,
      seedanceResolution: '720p',
      seedanceRatio: '16:9',
      seedanceDuration: 5,
      generateAudio: false,
      style: 'old-style',
      cameraSettings: { lens: '85mm', aperture: 'f/2.8' },
    };
    const store = createStore([{
      id: 'video-node',
      type: 'ai-video',
      position: { x: 0, y: 0 },
      data: originalData,
    }], () => 1);
    store.activeNodeId = 'video-node';
    const generateVideo = vi.fn().mockResolvedValue({ url: 'https://example.com/result.mp4' });
    const resolveProjectGenerationPrompt = vi.fn(
      ({ prompt, data }: { prompt: string; data: Record<string, unknown> }) => `resolved:${prompt}:${data.style}`,
    );

    await installReactHookDriver();
    installStoreMock(store);
    vi.doUnmock('../../../src/services/generationService');
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
    vi.doMock('../../../src/components/nodes/shared/PromptPanel', () => ({
      default: function PromptPanelMock() { return null; },
    }));
    vi.doMock('../../../src/services/aiService', () => ({
      generateText: vi.fn(), generateTextResult: vi.fn(),
      generateImage: vi.fn(),
      generateImagesBatch: vi.fn(),
      generateVideo,
      generateAudio: vi.fn(),
      buildPanoramaPrompt: vi.fn(),
    }));
    vi.doMock('../../../src/services/ai/generateAudio', () => ({ persistAudioGenerationResult: vi.fn() }));
    vi.doMock('../../../src/services/fileService', () => ({
      persistMediaUrlToProjectData: vi.fn(async (url: string) => ({
        mediaUrl: url,
        sourceUrl: url,
      })),
    }));
    vi.doMock('../../../src/services/imageBatchService', () => ({ applyImageBatchResults: vi.fn() }));
    vi.doMock('../../../src/services/onnxService', () => ({
      checkModelExists: vi.fn(), createCharacterDirectionGrid: vi.fn(), downloadModel: vi.fn(),
    }));
    vi.doMock('../../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
    vi.doMock('../../../src/services/canvasViewportService', () => ({
      CANVAS_PAN_DURATION_MS: 200,
      requestCanvasPanBy: vi.fn(),
    }));
    vi.doMock('../../../src/services/projectSettingsService', async () => ({
      ...await vi.importActual<typeof import('../../../src/services/projectSettingsService')>('../../../src/services/projectSettingsService'),
      resolveProjectGenerationPrompt,
    }));
    vi.doMock('../../../src/services/pollManager', () => ({
      ...mockComfyDeliveries(),
      getPendingTasksForProject: () => [],
      prepareVideoNodeGeneration: vi.fn(), completeVideoNodeTask: vi.fn(), pauseVideoNodeTask: vi.fn(),
      VideoPollingPausedError: class extends Error {},
    }));

    const AINodeDialog = (await import('../../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
    const tree = AINodeDialog();
    const promptPanel = findElement(tree, (element) => componentName(element) === 'PromptPanelMock');
    const changePrompt = promptPanel.props.onChange as (value: string, previousValue?: string) => void;
    // 后连线已经写入 Store，但编辑器还持有旧 DOM；继续输入不能抹掉新引用。
    store.updateNodeDataTransient('video-node', { prompt: 'old prompt @{image:新参考图} @{audio:新声音}' });
    changePrompt('正在编辑的内容', 'old prompt');
    expect(store.nodes[0].data.prompt).toBe('正在编辑的内容 @{image:新参考图} @{audio:新声音}');
    (promptPanel.props.onContinuousEditEnd as () => void)();
    expect(store.commitToHistory).not.toHaveBeenCalled();
    store.updateNodeDataTransient('video-node', { workflowInputs: { panelInput: '保留的面板参数' } });
    changePrompt('@wf{57:27|提示词|prompt}(修改后的内容)');
    expect(store.nodes[0].data.workflowInputs).toEqual({ panelInput: '保留的面板参数', '57:27': '修改后的内容' });
    // 编辑器撤销标签内容时，正文与工作流参数一起恢复；面板输入保留。
    changePrompt('@wf{57:27|提示词|prompt}(原文)', '@wf{57:27|提示词|prompt}(修改后的内容)');
    expect(store.nodes[0].data.workflowInputs).toEqual({ panelInput: '保留的面板参数', '57:27': '原文' });
    changePrompt('删除工作流标签');
    expect(store.nodes[0].data.workflowInputs).toEqual({ panelInput: '保留的面板参数' });
    store.workflows = [{ id: 'rh-test', name: 'RH', category: 'ai-video', fileName: 'RH', fileContent: '', createdAt: 1, adapterType: 'runninghub', runninghub: { version: 1, kind: 'workflow', remoteId: '123', connectionId: 'runninghub', parameters: [] } }];
    store.updateNodeDataTransient('video-node', { workflowId: 'rh-test' });
    changePrompt('@wf{9::first|首帧|image}(@{image:参考图}) @wf{6::text|正文|prompt}(动作 (特写))');
    expect(store.nodes[0].data.workflowInputs).toEqual({ panelInput: '保留的面板参数', '9::first': '@{image:参考图}', '6::text': '动作 (特写)' });
    changePrompt('@wf{6::text|正文|prompt}(编辑中');
    expect(store.nodes[0].data.prompt).toBe('@wf{6::text|正文|prompt}(编辑中');
    changePrompt('移除 RH 输入');
    expect(store.nodes[0].data.workflowInputs).toEqual({ panelInput: '保留的面板参数' });
    expect(store.commitToHistory).not.toHaveBeenCalled();
    const editWrites = store.updateNodeDataTransient.mock.calls.length;
    store.currentProjectId = 'project-b';
    changePrompt('旧项目迟到的输入', '正在编辑的内容');
    expect(store.updateNodeDataTransient).toHaveBeenCalledTimes(editWrites);
    store.currentProjectId = 'project-a';
    (promptPanel.props.onModelSelect as (model: Record<string, unknown>) => void)({
      value: 'general/custom-video',
      label: 'Custom Video',
      provider: 'general',
    });
    expect(store.updateNodeData).toHaveBeenCalledWith('video-node', expect.objectContaining({
      model: 'general/custom-video',
      provider: 'general',
    }));
    expect(store.nodes[0].data).toMatchObject({ seedanceRatio: '16:9', seedanceResolution: '720p',
      videoResolution: 640, videoFps: 24, videoFrames: 77, seedanceDuration: 5, generateAudio: false });
    store.nodes[0] = {
      ...store.nodes[0],
      data: {
        ...originalData,
        prompt: 'latest prompt',
        model: 'latest-model',
        provider: 'latest-provider',
        videoResolution: 1280,
        videoFps: 30,
        videoFrames: 121,
        seedanceResolution: '1080p',
        seedanceRatio: '9:16',
        seedanceDuration: 10,
        generateAudio: true,
        style: 'latest-style',
        workflowId: 'workflow-video',
        workflowInputs: { motion: 9 },
      },
    };

    await (promptPanel.props.onSubmit as () => Promise<void>)();

    expect(resolveProjectGenerationPrompt).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'latest prompt',
      data: expect.objectContaining({ style: 'latest-style' }),
      settings: { styleReferenceId: 'style-project' },
      customStyles: store.customStyles,
    }));
    expect(generateVideo).toHaveBeenCalledWith({
      prompt: 'resolved:latest prompt:latest-style\n\nCamera settings: 85mm portrait lens, f/2.8 aperture, soft background separation.',
      model: 'latest-model',
      provider: 'latest-provider',
      videoResolution: 1280,
      videoFps: 30,
      videoFrames: 301,
      seedanceResolution: '1080p',
      seedanceRatio: '9:16',
      seedanceDuration: 10,
      generateAudio: true,
      workflowId: 'workflow-video',
      workflowInputs: { motion: 9 },
      nodeId: 'video-node',
    });
    expect(store.updateNodeData).toHaveBeenCalledWith('video-node', expect.objectContaining({
      videoUrl: 'https://example.com/result.mp4',
      status: 'success',
    }));
    expect(store.recordOutputHistory).toHaveBeenCalledWith('video-node', expect.objectContaining({
      params: expect.objectContaining({ cameraSettings: originalData.cameraSettings }),
    }), true);
  });

  it.each(['success', 'failure', 'project-switch', 'local-stopped'])('AINodeDialog ComfyUI stop and recovery: %s', async (outcome) => {
    const store = createStore([{
      id: 'image-node',
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: {
        type: 'ai-image',
        label: 'Image node',
        prompt: 'cat',
        model: 'comfyui/workflow',
        provider: 'comfyui',
        workflowId: 'wf-1',
        status: 'loading',
      },
    }], () => 1);
    store.activeNodeId = 'image-node';
    let pendingTasks = [{ nodeId: 'image-node', taskId: 'prompt-1', taskType: 'comfyui', comfyRecoveryState: undefined as string | undefined }];
    const resumeComfyUINodeTask = vi.fn().mockResolvedValue(undefined);
    const generateImage = vi.fn();
    const cancelComfyUINodeTask = vi.fn(async () => {
      if (outcome === 'failure') {
        pendingTasks[0].comfyRecoveryState = 'cancel_pending';
        throw new Error('HTTP 503');
      }
      if (outcome === 'local-stopped') {
        pendingTasks[0].comfyRecoveryState = 'disconnected';
        return 'local-stopped';
      }
      pendingTasks = [];
      if (outcome === 'project-switch') store.currentProjectId = 'project-b';
      return 'remote-ended';
    });
    vi.doMock('../../../src/services/pollManager', () => ({
      ...mockComfyDeliveries(),
      getPendingTasksForProject: () => pendingTasks,
      resumeComfyUINodeTask,
    }));

    await installReactHookDriver();
    installStoreMock(store);
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
    vi.doMock('../../../src/components/nodes/shared/PromptPanel', () => ({
      default: function PromptPanelMock() { return null; },
    }));
    vi.doMock('../../../src/services/aiService', () => ({
      generateText: vi.fn(), generateTextResult: vi.fn(),
      generateImage,
      generateImagesBatch: vi.fn(),
      generateVideo: vi.fn(),
      generateAudio: vi.fn(),
      buildPanoramaPrompt: vi.fn(),
    }));
    vi.doMock('../../../src/services/ai/generateAudio', () => ({ persistAudioGenerationResult: vi.fn() }));
    vi.doMock('../../../src/services/fileService', () => ({
      persistMediaUrlToProjectData: vi.fn(async (url: string) => ({
        mediaUrl: url,
        sourceUrl: url,
      })),
    }));
    vi.doMock('../../../src/services/imageBatchService', () => ({ applyImageBatchResults: vi.fn() }));
    vi.doMock('../../../src/services/onnxService', () => ({
      checkModelExists: vi.fn(), createCharacterDirectionGrid: vi.fn(), downloadModel: vi.fn(),
    }));
    vi.doMock('../../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
    vi.doMock('../../../src/services/canvasViewportService', () => ({
      CANVAS_PAN_DURATION_MS: 200,
      requestCanvasPanBy: vi.fn(),
    }));
    vi.doMock('../../../src/services/projectSettingsService', async () => ({
      ...await vi.importActual<typeof import('../../../src/services/projectSettingsService')>('../../../src/services/projectSettingsService'),
      getImageNodeDimensionsForAspectRatio: vi.fn(),
      resolveProjectGenerationPrompt: vi.fn(),
    }));
    vi.doMock('../../../src/services/comfyWorkflowService', () => ({ cancelComfyUINodeTask }));

    const AINodeDialog = (await import('../../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
    const tree = AINodeDialog();
    const promptPanel = findElement(tree, (element) => componentName(element) === 'PromptPanelMock');

    expect(promptPanel.props.isGenerating).toBe(true);
    expect(promptPanel.props.onCancelGeneration).toEqual(expect.any(Function));
    (promptPanel.props.onCancelGeneration as () => void)();
    await vi.waitFor(() => expect(cancelComfyUINodeTask).toHaveBeenCalledWith('image-node'));
    if (outcome === 'project-switch') {
      expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
      return;
    }
    if (outcome === 'failure') {
      await vi.waitFor(() => expect(store.nodes[0].data.status).toBe('error'));
      const recoveredTree = AINodeDialog();
      const recoveredPanel = findElement(recoveredTree, (element) => componentName(element) === 'PromptPanelMock');
      expect(recoveredPanel.props.canGenerate).toBe(false);
      await (recoveredPanel.props.onSubmit as () => Promise<void>)();
      expect(generateImage).not.toHaveBeenCalled();
      const resume = findElement(recoveredTree, (element) => element.type === 'button' && element.props.children === '继续查询');
      (resume.props.onClick as () => void)();
      expect(resumeComfyUINodeTask).toHaveBeenCalledWith('image-node');
      expect(findElement(recoveredTree, (element) => element.type === 'button' && element.props.children === '再次终止')).toBeTruthy();
      return;
    }
    await vi.waitFor(() => expect(store.updateNodeDataTransient).toHaveBeenCalledWith(
      'image-node',
      { status: 'idle', error: undefined },
    ));
    expect(store.showToast).toHaveBeenCalledWith(outcome === 'local-stopped'
      ? '已停止本地等待；ComfyUI 任务结束尚未确认，请核对原任务后继续查询' : '已终止 ComfyUI 任务');
    if (outcome === 'local-stopped') expect(pendingTasks).toHaveLength(1);
  });
}

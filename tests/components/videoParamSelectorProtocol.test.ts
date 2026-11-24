/**
 * videoParamSelectorProtocol — 回归测试：ComfyUI 时长显示与提交一致。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { shallow } from 'zustand/shallow';
import { modelProtocolUsesVariable } from '../../src/services/ai/modelProtocol';
import { analyzeModelProtocolExamples } from '../../src/services/ai/modelProtocolImport';
import { resolveVideoSubmissionControls } from '../../src/services/ai/videoRequestResolver';
import VideoParamSelector, {
  resolveGeneralVideoControlSupport,
  resolveGeneralVideoModel,
  resolveGeneralVideoParameterDisplayState,
  resolveEffectiveVideoParameterCapability,
  resolveVideoParameterInputMode,
  selectConnectedVideoSourceNodes,
  resolveCharacterVideoReferenceOptions,
  buildCharacterVideoReferences,
} from '../../src/components/nodes/shared/VideoParamSelector';
import type { AppState } from '../../src/store/useAppStore';
import type { VideoModelCapability } from '../../src/types/aiTypes';
import type { DramaCharacter } from '../../src/types/dramaAssets';

describe('ComfyUI 时长显示与提交一致', () => {
  it.each([
    { name: '没有保存秒数和帧数', controls: {}, seconds: 5 },
    { name: '明确选择 3 秒', controls: { seedanceDuration: 3 }, seconds: 3 },
    { name: '旧节点保留 77 帧', controls: { videoFrames: 77, videoFps: 24 }, seconds: 3 },
    { name: '3 秒优先于旧的 121 帧', controls: { seedanceDuration: 3, videoFrames: 121 }, seconds: 3 },
  ])('$name', ({ controls, seconds }) => {
    const props = { provider: 'comfyui', selectedModel: 'builtin-minimax-h3-i2v', ...controls };
    const html = renderToStaticMarkup(createElement(VideoParamSelector, props));
    const submitted = resolveVideoSubmissionControls({ ...props, workflowId: props.selectedModel });

    expect(submitted.seedanceDuration).toBe(seconds);
    expect(html).toContain(`时长${seconds}s`);
  });

  it('嵌入工作流原生字段，按比例、分辨率、时长显示且不再显示独立按钮', () => {
    const html = renderToStaticMarkup(createElement(VideoParamSelector, {
      provider: 'comfyui',
      inlineFields: { ratio: '工作流比例', duration: '工作流时长' },
    }));

    expect(html).toContain('工作流比例');
    expect(html).toContain('分辨率（长边）');
    expect(html).toContain('工作流时长');
    expect(html.indexOf('工作流比例')).toBeLessThan(html.indexOf('分辨率（长边）'));
    expect(html.indexOf('分辨率（长边）')).toBeLessThan(html.indexOf('工作流时长'));
    expect(html).not.toContain('img-pill-btn');
    expect(html).not.toContain('画面比例');
    expect(html).not.toContain('data-ui-schema-field="videoDuration"');
  });
});

describe('视频比例保留与时长主题交互', () => {
  interface ElementLike { type: unknown; props: Record<string, unknown> & { children?: unknown } }
  function elements(tree: unknown): ElementLike[] {
    if (Array.isArray(tree)) return tree.flatMap(elements);
    if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
    const element = tree as ElementLike;
    return [element, ...elements(element.props.children)];
  }
  function textOf(value: unknown): string {
    if (Array.isArray(value)) return value.map(textOf).join('');
    if (value && typeof value === 'object' && 'props' in value) return textOf((value as ElementLike).props.children);
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  }
  let state: Pick<AppState, 'config' | 'dramaAssets' | 'globalCharacters' | 'loadGlobalCharacters' | 'nodes' | 'edges' | 'workflows'>;
  let Component: typeof VideoParamSelector;
  let effects: Array<() => unknown>;
  let stateIndex: number;
  let pickerFor: 'frame' | 'character' | null;
  function renderVideo(props: ComponentProps<typeof VideoParamSelector>) {
    stateIndex = 0;
    effects = [];
    const tree = elements(Component(props));
    effects.forEach((effect) => effect());
    return tree;
  }
  function configureModel(capability: VideoModelCapability) {
    state.config.generalModels = [{ id: 'video', modelId: 'model-video', name: '视频模型', category: 'video',
      providerConfigId: 'relay', videoCapability: capability }];
    return { provider: 'general', selectedModel: 'general/video' };
  }

  beforeEach(async () => {
    vi.resetModules();
    state = { config: { theme: 'light', providers: {} }, dramaAssets: { version: 2, characters: [], scenes: [], props: [] },
      globalCharacters: [], loadGlobalCharacters: vi.fn(), nodes: [], edges: [], workflows: [] };
    pickerFor = null;
    vi.doMock('react', async () => ({
      ...await vi.importActual<typeof import('react')>('react'),
      useState: () => [stateIndex++ === 0 ? true : pickerFor, vi.fn()],
      useRef: () => ({ current: null }),
      useMemo: <T,>(factory: () => T) => factory(),
      useCallback: <T,>(callback: T) => callback,
      useEffect: (effect: () => unknown) => { effects.push(effect); },
    }));
    vi.doMock('../../src/store/useAppStore', () => ({ useAppStore: (selector: (value: AppState) => unknown) => selector(state as AppState) }));
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('../../src/i18n', () => ({ useT: () => (text: string, params: Record<string, string | number> = {}) =>
      text.replace(/\{([^}]+)\}/g, (match, key: string) => String(params[key] ?? match)) }));
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    Component = (await import('../../src/components/nodes/shared/VideoParamSelector')).default;
  });
  afterEach(() => {
    vi.doUnmock('react');
    vi.doUnmock('../../src/store/useAppStore');
    vi.doUnmock('zustand/react/shallow');
    vi.doUnmock('../../src/i18n');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each(['9:16', '21:9'])('模型默认和候选改变后仍显示用户比例 %s，不通过 effect 改写它', (ratio) => {
    const model = configureModel({ ratios: ['16:9'], defaultRatio: '16:9' });
    const onChangeSeedanceRatio = vi.fn();
    const props = { ...model, seedanceRatio: ratio, onChangeSeedanceRatio };
    let tree = renderVideo(props);
    expect(tree.find((element) => element.props.className === 'img-pill-btn ui-schema-menu-trigger')?.props.title).toContain(ratio);
    configureModel({ ratios: ['1:1'], defaultRatio: '1:1' });
    tree = renderVideo(props);
    expect(tree.find((element) => element.props.className === 'img-pill-btn ui-schema-menu-trigger')?.props.title).toContain(ratio);
    expect(onChangeSeedanceRatio).not.toHaveBeenCalled();
  });

  it('参考角色只传入项目与全局库候选，连线图片仍只供参考帧选择', () => {
    const character = { id: 'shared', kind: 'character', name: '主角', imageUrl: 'project.png' } as DramaCharacter;
    state.dramaAssets.characters = [character];
    state.globalCharacters = [{ ...character, imageUrl: 'global.png' }];
    state.nodes = [{ id: 'connected', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: '连线图片', imageUrl: 'connected.png' } }] as AppState['nodes'];
    state.edges = [{ id: 'edge', source: 'connected', target: 'video' }];
    const onChangeVideoReferences = vi.fn();
    const props = { provider: 'comfyui', nodeId: 'video', onChangeVideoReferences };
    pickerFor = 'character';
    let tree = renderVideo(props);
    const picker = tree.find((element) => Array.isArray(element.props.projectItems) && Array.isArray(element.props.globalItems))!;
    const project = picker.props.projectItems as Array<{ key: string; onSelect: () => void }>;
    const global = picker.props.globalItems as Array<{ key: string; onSelect: () => void }>;
    expect(project.map((item) => item.key)).toEqual(['character:shared']);
    expect(global.map((item) => item.key)).toEqual(['character:global/shared']);
    expect(tree.some((element) => element.props.className === 'rh-video-ref-picker')).toBe(false);
    global[0].onSelect();
    expect(onChangeVideoReferences).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'character:global/shared', kind: 'character', url: 'global.png', sourceNodeId: undefined }),
    ]);

    pickerFor = 'frame';
    tree = renderVideo(props);
    const frame = tree.find((element) => element.props.className === 'rh-video-ref-option')!;
    (frame.props.onClick as () => void)();
    expect(onChangeVideoReferences).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'connected', kind: 'frame', sourceNodeId: 'connected', url: 'connected.png' }),
    ]);
  });

  it.each(['dreamina', 'comfyui'])('%s 也如实显示自定义比例，不回落首档或写回默认', (provider) => {
    const onChangeSeedanceRatio = vi.fn();
    const tree = renderVideo({ provider, selectedModel: 'seedance2.5', seedanceRatio: '7:4', onChangeSeedanceRatio });
    expect(tree.find((element) => element.props.className === 'img-pill-btn ui-schema-menu-trigger')?.props.title).toContain('7:4');
    expect(onChangeSeedanceRatio).not.toHaveBeenCalled();
  });

  it('未设比例时只展示默认值，只有用户点击才写入选择', () => {
    const model = configureModel({ ratios: ['16:9', '9:16'], defaultRatio: '16:9' });
    const onChangeSeedanceRatio = vi.fn();
    const tree = renderVideo({ ...model, onChangeSeedanceRatio });
    expect(onChangeSeedanceRatio).not.toHaveBeenCalled();
    const portrait = tree.find((element) => element.props.children === '9:16' && typeof element.props.onClick === 'function')!;
    (portrait.props.onClick as () => void)();
    expect(onChangeSeedanceRatio).toHaveBeenCalledExactlyOnceWith('9:16');
  });

  it('切换模型保留兼容的分辨率、时长、帧率及显式静音，不跟随新的默认值', () => {
    const capability: VideoModelCapability = { ratios: ['16:9', '9:16', '1:1'], defaultRatio: '16:9',
      resolutions: ['480p', '720p', '1080p'], defaultResolution: '480p', durations: [5, 15], defaultDuration: 5,
      frameRates: [24, 30], defaultFrameRate: 24, supportsAudio: true };
    const model = configureModel(capability);
    const callbacks = { onChangeSeedanceRatio: vi.fn(), onChangeSeedanceResolution: vi.fn(),
      onChangeSeedanceDuration: vi.fn(), onChangeFps: vi.fn(), onChangeGenerateAudio: vi.fn() };
    const props = { ...model, seedanceRatio: '9:16', seedanceResolution: '720p', seedanceDuration: 15,
      videoFps: 30, generateAudio: false, ...callbacks };
    renderVideo(props);
    configureModel({ ...capability, defaultRatio: '1:1', defaultResolution: '1080p', defaultDuration: 5 });
    const tree = renderVideo(props);
    const summary = tree.find((element) => element.props.className === 'img-pill-btn ui-schema-menu-trigger')?.props.title;
    expect(summary).toContain('720p');
    expect(summary).toContain('15s');
    expect(summary).toContain('9:16');
    expect(summary).toContain('30帧');
    expect(summary).toContain('无声视频');
    Object.values(callbacks).forEach((callback) => expect(callback).not.toHaveBeenCalled());
  });

  it.each([true, false, undefined])('仅明确不能生成音轨时清理旧的开启要求（supportsAudio=%s）', (supportsAudio) => {
    const model = configureModel({ supportsAudio });
    const onChangeGenerateAudio = vi.fn();
    renderVideo({ ...model, generateAudio: true, onChangeGenerateAudio });
    if (supportsAudio === false) expect(onChangeGenerateAudio).toHaveBeenCalledExactlyOnceWith(undefined);
    else expect(onChangeGenerateAudio).not.toHaveBeenCalled();
  });

  it('原生合同没有音轨开关时不将其误当成不支持声音，不清理旧值', () => {
    const onChangeGenerateAudio = vi.fn();
    renderVideo({ provider: 'dreamina', selectedModel: 'seedance2.5', generateAudio: true, onChangeGenerateAudio });
    expect(onChangeGenerateAudio).not.toHaveBeenCalled();
  });

  it.each([
    { capability: { durations: [15], defaultDuration: 15 }, value: 15, label: '15s' },
    { capability: { durations: [5, 15], automaticDurationValue: -1 }, value: -1, label: '自动' },
    { capability: { durations: [5, 15] }, value: undefined, label: '模型默认' },
  ])('时长选项 $label 使用同一品牌色分段且保持原提交值', ({ capability, value, label }) => {
    const model = configureModel(capability);
    const onChangeSeedanceDuration = vi.fn();
    const tree = renderVideo({ ...model, seedanceDuration: value, onChangeSeedanceDuration });
    const group = tree.find((element) => element.props.role === 'group' && element.props['aria-label'] === '生成时长（秒）')!;
    expect(group.props.className).toBe('ui-segmented ui-segmented--brand');
    const options = elements(group).filter((element) => element.type === 'button');
    const selected = options.filter((element) => element.props['aria-pressed']);
    expect(selected).toHaveLength(1);
    expect(textOf(selected[0].props.children)).toBe(label);
    expect(selected[0].props.className).toBe('ui-segmented__item is-active');
    expect(options.every((element) => String(element.props.className).startsWith('ui-segmented__item'))).toBe(true);
    onChangeSeedanceDuration.mockClear();
    (selected[0].props.onClick as () => void)();
    expect(onChangeSeedanceDuration).toHaveBeenCalledExactlyOnceWith(value);
  });
});

describe('视频参考角色的项目与全局身份', () => {
  it('同 ID 角色分开保存图片与明确的主音色，保留方舟资产绑定', () => {
    const project = { id: 'shared', kind: 'character', name: '主角', imageUrl: 'project.png',
      primaryVoiceClipId: 'main', voiceClips: [{ id: 'main', kind: 'timbre', audioUrl: 'project.wav' }] } as DramaCharacter;
    const global = { ...project, imageUrl: 'global.png',
      voiceClips: [{ id: 'main', kind: 'timbre', audioUrl: 'global.wav' }],
      volcengineBinding: { projectName: 'default', imageAssetId: 'remote-image' } } as DramaCharacter;
    const projectOption = resolveCharacterVideoReferenceOptions([project], [], 'project')[0];
    const globalOption = resolveCharacterVideoReferenceOptions([global], [], 'global')[0];
    expect(buildCharacterVideoReferences(projectOption)).toEqual([
      expect.objectContaining({ id: 'character:shared', url: 'project.png', sourceNodeId: undefined }),
      expect.objectContaining({ id: 'character:shared:voice', url: 'project.wav', role: 'reference_audio' }),
    ]);
    expect(buildCharacterVideoReferences(globalOption, 'volcengine')).toEqual([
      expect.objectContaining({ id: 'character:global/shared:volcengine:remote-image', url: 'asset://remote-image', previewUrl: 'global.png' }),
      expect.objectContaining({ id: 'character:global/shared:volcengine:remote-image:voice', url: 'global.wav' }),
    ]);
    expect(buildCharacterVideoReferences({ ...globalOption,
      character: { ...global, primaryVoiceClipId: 'missing' } })).toHaveLength(1);
  });

  it('全局角色不借用当前项目同名源节点，项目角色仍可使用库内绑定', () => {
    const character = { id: 'hero', kind: 'character', name: '主角', imageNodeId: 'source' } as DramaCharacter;
    const nodes = [{ id: 'source', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: '当前项目图片', imageUrl: 'current-project.png' } }] as AppState['nodes'];
    expect(resolveCharacterVideoReferenceOptions([character], nodes, 'global')).toEqual([]);
    expect(resolveCharacterVideoReferenceOptions([character], nodes, 'project')).toEqual([
      expect.objectContaining({ id: 'character:hero', url: 'current-project.png' }),
    ]);
  });
});

describe('VideoParamSelector 自定义协议参数识别', () => {
  it('手动首帧与同图连线合并，其他连线图片仍保留参考语义', () => {
    const frames = [{ role: 'first_frame' as const, url: 'https://test/first.png' }];
    const connected = { image: 1, video: 0, audio: 0, imageUrls: ['https://test/first.png'] };
    const mode = resolveVideoParameterInputMode(frames, 0, connected);
    expect(mode).toBe('keyframe');
    expect(resolveEffectiveVideoParameterCapability({
      ratios: ['16:9', 'adaptive'],
      inputModeCapabilities: { keyframe: { ratios: ['adaptive'] } },
    }, mode, 'image-to-video')?.ratios).toEqual(['adaptive']);
    expect(resolveVideoParameterInputMode(frames, 0, {
      ...connected, image: 2, imageUrls: [...connected.imageUrls, 'https://test/ref.png'],
    })).toBe('mixed');
    expect(resolveVideoParameterInputMode([], 0, connected)).toBe('reference');
  });
  it('连接素材 selector 始终返回扁平节点数组，避免 React 外部快照循环', () => {
    const imageNode = {
      id: 'image',
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: '参考图', imageUrl: 'image.png' },
    } as AppState['nodes'][number];
    const state = {
      nodes: [imageNode],
      edges: [{ id: 'edge', source: 'image', target: 'video' }],
    } as Pick<AppState, 'nodes' | 'edges'>;

    const selected = selectConnectedVideoSourceNodes(state, 'video');
    expect(Array.isArray(selected)).toBe(true);
    expect(selected).toEqual([imageNode]);
    expect(selectConnectedVideoSourceNodes(state, undefined)).toEqual([]);
    expect(shallow([], [])).toBe(true);
    expect(shallow(
      { imageNodes: [], videoCount: 0, audioCount: 0 },
      { imageNodes: [], videoCount: 0, audioCount: 0 },
    )).toBe(false);
  });

  it('保留导入协议的比例、分辨率和秒数变量', () => {
    const imported = analyzeModelProtocolExamples({
      submitRequest: `
curl https://api.paipu.net/v1/videos \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "future-provider-video-model",
    "prompt": "cinematic train station",
    "duration": 5,
    "aspect_ratio": "16:9",
    "resolution": "720p"
  }'`,
      submitResponse: '{"id":"task_1","status":"queued"}',
      pollRequest: 'curl https://api.paipu.net/v1/videos/task_1 -H "Authorization: Bearer YOUR_API_KEY"',
      pollResponse: '{"id":"task_1","status":"completed","metadata":{"url":"https://cdn.example/video.mp4"}}',
    });
    const source = JSON.stringify(imported.protocol);

    expect(modelProtocolUsesVariable(source, 'aspectRatio', 'seedanceRatio')).toBe(true);
    expect(modelProtocolUsesVariable(source, 'resolution', 'seedanceResolution')).toBe(true);
    expect(modelProtocolUsesVariable(source, 'duration', 'seedanceDuration')).toBe(true);
    expect(modelProtocolUsesVariable(source, 'videoFrames')).toBe(false);
  });

  it('兼容模板变量花括号内的空格', () => {
    expect(modelProtocolUsesVariable('{"resolution":"{{ seedanceResolution }}"}', 'seedanceResolution'))
      .toBe(true);
  });

  it('兼容节点保存的内部 ID、真实模型 ID 和 Provider 前缀引用', () => {
    const models = [{
      id: 'provider-custom-abc123',
      name: 'H3video 2K',
      modelId: 'lec-h3video-2k',
      category: 'video' as const,
      providerConfigId: 'custom-video',
      videoCapability: { ratios: ['16:9'], frameRates: [24] },
    }];

    expect(resolveGeneralVideoModel(models, 'general/provider-custom-abc123', 'general'))
      .toBe(models[0]);
    expect(resolveGeneralVideoModel(models, 'lec-h3video-2k', 'custom-video'))
      .toBe(models[0]);
    expect(resolveGeneralVideoModel(models, 'custom-video/lec-h3video-2k', 'custom-video'))
      .toBe(models[0]);
  });

  it('通用视频控件只暴露 capability 明确声明的能力', () => {
    expect(resolveGeneralVideoControlSupport({
      ratios: ['16:9'],
      frameRates: [24],
      supportsAudio: false,
    })).toEqual({
      resolution: false,
      ratio: true,
      duration: false,
      frameRate: true,
      audio: false,
    });
  });

  it('Seedance 自动时长哨兵也会开启时长控件并作为默认显示', () => {
    const capability = { automaticDurationValue: -1 };
    expect(resolveGeneralVideoControlSupport(capability).duration).toBe(true);
    expect(resolveGeneralVideoParameterDisplayState(capability, {}).duration).toBe(-1);
  });

  it('火山 Seedance 2.5 未指定时长时显示自动而不是截成 4 秒', () => {
    const html = renderToStaticMarkup(createElement(VideoParamSelector, {
      provider: 'volcengine',
      selectedModel: 'doubao-seedance-2-5',
    }));

    expect(html).toContain('时长自动');
  });

  it('首尾帧输入使用输入形态覆盖的自适应比例', () => {
    const capability = resolveEffectiveVideoParameterCapability({
      ratios: ['16:9', '9:16', 'adaptive'],
      defaultRatio: '16:9',
      inputModeCapabilities: {
        keyframe: { ratios: ['adaptive'], defaultRatio: 'adaptive' },
      },
    }, 'keyframe', 'image-to-video');

    expect(capability?.ratios).toEqual(['adaptive']);
    expect(capability?.defaultRatio).toBe('adaptive');
  });

  it('缺少 capability 时保持未知，不套用 Seedance 参数', () => {
    expect(resolveGeneralVideoControlSupport(undefined)).toEqual({
      resolution: false,
      ratio: false,
      duration: false,
      frameRate: false,
      audio: false,
    });
  });

  it('可选枚举和单侧范围不会被误当成模型默认值', () => {
    expect(resolveGeneralVideoParameterDisplayState({
      resolutions: ['2K'],
      ratios: ['7:4'],
      frameRates: [30],
      minDuration: 10,
      supportsAudio: true,
    }, {})).toEqual({
      resolution: undefined,
      ratio: undefined,
      duration: undefined,
      frameRate: undefined,
      generateAudio: undefined,
    });

    expect(resolveGeneralVideoParameterDisplayState({
      defaultResolution: '2K',
      defaultRatio: '7:4',
      defaultFrameRate: 30,
      defaultDuration: 20,
    }, {})).toMatchObject({
      resolution: '2K',
      ratio: '7:4',
      frameRate: 30,
      duration: 20,
    });
  });
});

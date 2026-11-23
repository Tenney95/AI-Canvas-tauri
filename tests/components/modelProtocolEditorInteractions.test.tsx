/**
 * modelProtocolEditorInteractions — 回归测试：model protocol editor interactions。
 */
import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface HookScope { values: unknown[]; index: number }
const driver = vi.hoisted(() => ({
  scope: null as HookScope | null, execute: vi.fn(), copy: vi.fn(),
  prepareFiles: vi.fn(),
  confirm: vi.fn(),
  layoutEffects: [] as Array<() => void>,
  effects: [] as Array<() => void>,
  catalog: vi.fn(),
}));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const scope = driver.scope!;
    const index = scope.index++;
    if (!(index in scope.values)) scope.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [scope.values[index] as T, (value: T | ((previous: T) => T)) => {
      scope.values[index] = typeof value === 'function' ? (value as (previous: T) => T)(scope.values[index] as T) : value;
    }];
  },
  useRef: <T,>(initial: T) => {
    const scope = driver.scope!;
    const index = scope.index++;
    return scope.values[index] ??= { current: initial };
  },
  useMemo: <T,>(factory: () => T, deps: readonly unknown[]) => {
    const scope = driver.scope!;
    const index = scope.index++;
    const previous = scope.values[index] as { value: T; deps: readonly unknown[] } | undefined;
    if (!previous || deps.length !== previous.deps.length || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      scope.values[index] = { value: factory(), deps };
    }
    return (scope.values[index] as { value: T }).value;
  },
  useEffect: (effect: () => void) => { driver.effects.push(effect); },
  useLayoutEffect: (effect: () => void) => { driver.layoutEffects.push(effect); },
  useId: () => `protocol-test-${driver.scope!.index++}`,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useCallback: <T,>(callback: T) => callback,
}));
vi.mock('../../src/services/ai/modelProtocolTestSession', async (original) => ({
  ...await original<typeof import('../../src/services/ai/modelProtocolTestSession')>(),
  startProtocolTestSession: (...args: unknown[]) => driver.execute(...args),
}));
vi.mock('../../src/services/ai/modelProtocolMediaFiles', () => ({
  prepareProtocolMediaFileRequest: (...args: unknown[]) => driver.prepareFiles(...args),
}));
vi.mock('../../src/services/confirmDialog', () => ({ confirmAction: (...args: unknown[]) => driver.confirm(...args) }));
vi.mock('../../src/services/clipboardService', () => ({ copyText: (...args: unknown[]) => driver.copy(...args) }));
vi.mock('../../src/store/useAppStore', async (original) => {
  const actual = await original<typeof import('../../src/store/useAppStore')>();
  return { ...actual, useAppStore: Object.assign((selector: (state: ReturnType<typeof actual.useAppStore.getState>) => unknown) => selector(actual.useAppStore.getState()), actual.useAppStore) };
});
vi.mock('../../src/services/plugins/pluginProtocolPresetService', async (original) => ({
  ...await original<typeof import('../../src/services/plugins/pluginProtocolPresetService')>(),
  listPluginProtocolPresets: (...args: unknown[]) => driver.catalog(...args),
}));
import ModelProtocolEditor from '../../src/components/settings/ModelProtocolEditor';
import { useAppStore } from '../../src/store/useAppStore';
import { getDefaultCustomProtocol, parseModelExecutionProtocol, previewModelProtocolRequest } from '../../src/services/ai/modelProtocol';
import { PREPARED_MULTIPART_FILES } from '../../src/services/ai/modelProtocolTemplate';
import { getProviderDefinition, KLING_BASE_URL, KLING_IMAGE_MODEL_MANIFEST, KLING_VIDEO_MODEL_MANIFEST } from '../../src/services/ai/providerCatalogService';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
type Props = ComponentProps<typeof ModelProtocolEditor>;
let props: Props;
let tree: unknown;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  // 浅渲染驱动展开共用的纯展示变量面板，沿用真实按钮及插入回调。
  if (typeof element.type === 'function' && element.type.name === 'ProtocolVariablePanel') {
    const renderPanel = element.type as (props: Element['props']) => unknown;
    return [element, ...elements(renderPanel(element.props))];
  }
  return [element, ...elements(element.props.children)];
}
function find(predicate: (element: Element) => boolean): Element {
  const element = elements(tree).find(predicate);
  expect(element).toBeDefined();
  return element!;
}
function button(label: string) {
  return find((element) => element.type === 'button'
    && (element.props.children === label || Array.isArray(element.props.children) && element.props.children.includes(label)));
}
function protocolField() {
  return find((element) => element.type === 'textarea' && String(element.props['aria-describedby']).endsWith('-help'));
}
function fileFieldPicker() {
  return find((element) => element.props['aria-label'] === '插入文件字段');
}
function insertFileField(field: string) {
  (fileFieldPicker().props.onChange as (value: string) => void)(field);
  render();
}
function change(element: Element, value: string) {
  const target = { value, selectionStart: value.length, selectionEnd: value.length };
  (element.props.onChange as (event: unknown) => void)({ target, currentTarget: target });
  render();
}
function render() {
  driver.scope!.index = 0;
  driver.layoutEffects = [];
  driver.effects = [];
  tree = ModelProtocolEditor(props);
  driver.layoutEffects.forEach((effect) => effect());
}
async function click(element: Element) {
  (element.props.onClick as () => void)();
  await new Promise<void>((resolve) => setImmediate(resolve));
  render();
}

beforeEach(() => {
  driver.scope = { values: [], index: 0 };
  driver.execute.mockReset().mockResolvedValue({ urls: ['https://cdn.example/result.png'] });
  driver.prepareFiles.mockReset().mockImplementation(async (protocol, variables) => ({ protocol, variables }));
  driver.copy.mockReset().mockResolvedValue(true);
  driver.confirm.mockReset().mockResolvedValue(true);
  driver.catalog.mockReset().mockResolvedValue([]);
  useAppStore.setState(useAppStore.getInitialState(), true);
  props = {
    model: { id: 'image-model', name: 'Image', category: 'image', provider: 'custom',
      executionProfile: { preset: 'custom', protocol: getDefaultCustomProtocol('image') } },
    apiKey: 'private-connection-key', baseUrl: 'https://gateway.example/v1',
    onChange: vi.fn(), onValidityChange: vi.fn(), onImageReferenceRequestModeChange: vi.fn(), onClose: vi.fn(),
  };
});

describe('model protocol editor interactions', () => {
  it('adds single or repeated image file fields in the image JSON editor and preserves an unfinished draft', () => {
    render();
    const protocol = getDefaultCustomProtocol('image');
    protocol.submit.path = '/custom-edit';
    protocol.submit.body = { prompt: '{{prompt}}', vendor_option: 'keep' };
    change(protocolField(), JSON.stringify(protocol));
    insertFileField('image');
    expect(JSON.parse(protocolField().props.value as string).submit).toMatchObject({
      path: '/custom-edit', bodyEncoding: 'multipart', body: { image: { $file: '{{imageUrls.0}}' }, vendor_option: 'keep' },
    });
    insertFileField('image[]');
    expect(JSON.parse(protocolField().props.value as string).submit.body['image[]']).toMatchObject({ $file: '{{imageUrls}}' });
    change(protocolField(), '{unfinished');
    expect(fileFieldPicker().props.disabled).toBe(true);
    insertFileField('file');
    expect(protocolField().props.value).toBe('{unfinished');
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it('maps keyframes and image, video and audio references in the video JSON and form editors', async () => {
    props.model.category = 'video';
    const protocol = getDefaultCustomProtocol('video');
    protocol.submit.path = '/custom-videos';
    protocol.poll!.path = '/custom-videos/{{submit.task_id}}';
    props.model.executionProfile = { preset: 'custom', protocol };
    render();
    insertFileField('first_frame');
    insertFileField('last_frame');
    await click(find((element) => element.props.role === 'tab' && element.props.children === '表单'));
    for (const field of ['images', 'video', 'audios']) insertFileField(field);
    const saved = vi.mocked(props.onChange).mock.calls.at(-1)![0]!;
    expect(saved.protocol).toMatchObject({
      submit: { path: protocol.submit.path, bodyEncoding: 'multipart', body: {
        first_frame: { $file: '{{firstImage}}' }, last_frame: { $file: '{{lastImage}}' },
        images: { $file: '{{referenceImageUrls}}' }, video: { $file: '{{referenceVideoUrls.0}}' },
        audios: { $file: '{{referenceAudioUrls}}' },
      } },
      poll: protocol.poll,
    });
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it('prepares multipart trial files only at submission and keeps the configured connection identity', async () => {
    render();
    insertFileField('image');
    const protocol = JSON.parse(protocolField().props.value as string);
    const prepared = { protocol, variables: { [PREPARED_MULTIPART_FILES]: { 'imageUrls.0': 'data:image/jpeg;base64,dGVzdA==' } } };
    driver.prepareFiles.mockResolvedValue({ ...prepared, filesBySource: new Map(), fileOnlySources: new Set() });
    expect(driver.prepareFiles).not.toHaveBeenCalled();
    await click(button('试跑'));
    expect(driver.prepareFiles).toHaveBeenCalledWith(protocol, expect.objectContaining({ model: props.model.id }),
      { signal: expect.any(AbortSignal), trial: true });
    expect(driver.execute).toHaveBeenCalledWith({
      identity: { scopeId: props.model.provider, modelId: props.model.id, baseUrl: props.baseUrl },
      category: 'image', apiKey: props.apiKey, ...prepared,
    });
    driver.execute.mockClear();
    driver.prepareFiles.mockRejectedValue(new Error('试跑素材无效'));
    await click(button('试跑'));
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it('shows plugin identities, saves a stable reference, and refreshes to unavailable after lifecycle changes', async () => {
    props.model = { id: 'model', name: 'model', provider: 'p', category: 'text' };
    const first = { pluginId: 'example.responses', presetId: 'responses', name: 'OpenAI Responses', pluginName: 'Responses', available: true };
    const second = { ...first, pluginId: 'other.responses' };
    driver.catalog.mockResolvedValue([first, second]);
    render(); driver.effects.forEach((effect) => effect());
    await new Promise<void>((resolve) => setImmediate(resolve)); render();
    expect(elements(tree).filter((element) => element.type === 'option' && String(element.props.value).startsWith('plugin:'))).toHaveLength(2);
    const select = find((element) => typeof element.props.onChange === 'function' && element.props.value === 'legacy');
    await (select.props.onChange as (value: string) => Promise<void>)('plugin:example.responses/responses'); render();
    expect(props.onChange).toHaveBeenLastCalledWith({ preset: 'plugin', plugin: { pluginId: 'example.responses', presetId: 'responses' } });
    driver.catalog.mockResolvedValue([{ ...first, available: false, reason: '协议插件未启用，请在插件设置中启用' }]);
    useAppStore.setState({ installedPlugins: [...useAppStore.getState().installedPlugins] });
    render(); driver.effects.forEach((effect) => effect());
    await new Promise<void>((resolve) => setImmediate(resolve)); render();
    expect(find((element) => element.type === 'option' && element.props.value === 'plugin:example.responses/responses').props.disabled).toBe(true);
    expect(props.onChange).toHaveBeenLastCalledWith({ preset: 'plugin', plugin: { pluginId: 'example.responses', presetId: 'responses' } });
  });
  it('keeps an unconfigured video protocol invalid when switching editor views', async () => {
    props.model = { id: 'unknown-video', name: 'Video', category: 'video', provider: 'custom' };
    render();
    for (const view of ['表单', 'JSON']) {
      await click(find((element) => element.props.role === 'tab' && element.props.children === view));
      expect(props.onValidityChange).toHaveBeenLastCalledWith(false);
      expect(button('试跑').props.disabled).toBe(true);
    }
  });

  it.each(['SD2.0', 'SD2.5', 'H3'])('replaces an invalid draft with %s and preserves reference media and model identity', async (name) => {
    props.model = { id: 'my-video-alias', name: 'Video', category: 'video', provider: 'custom' };
    props.onVideoCapabilityChange = vi.fn();
    render();
    expect(protocolField()).toBeDefined();
    expect(button('试跑').props.disabled).toBe(true);
    change(protocolField(), '{ broken draft');
    await click(find((element) => element.props['aria-label'] === `填入 ${name} 视频预设（APIMart）`));
    const applied = vi.mocked(props.onChange).mock.calls.at(-1)![0]!;
    expect(applied.preset).toBe('custom');
    const protocol = parseModelExecutionProtocol(applied.protocol!);
    expect(JSON.parse(protocolField().props.value as string)).toEqual(protocol);
    expect(props.onValidityChange).toHaveBeenLastCalledWith(true);
    expect(button('试跑').props.disabled).toBe(false);
    expect(props.model.id).toBe('my-video-alias');
    expect(props.onVideoCapabilityChange).toHaveBeenCalledWith(expect.objectContaining({
      maxImageReferences: name === 'SD2.5' ? 30 : 9,
    }));
    const preview = previewModelProtocolRequest({
      protocol, baseUrl: props.baseUrl, variables: {
        model: props.model.id, prompt: 'keep every reference', duration: 5,
        seedanceDuration: 5, seedanceResolution: '720p', seedanceRatio: '16:9', aspectRatio: '16:9',
        generateAudio: true, firstImage: 'https://cdn.example/first.png', lastImage: 'https://cdn.example/last.png',
        imageWithRoles: [{ url: 'https://cdn.example/ref.png', role: 'reference_image' }],
        referenceImageUrls: ['https://cdn.example/ref.png'], videoUrls: ['https://cdn.example/ref.mp4'],
        referenceVideoUrls: ['https://cdn.example/ref.mp4'], audioUrls: ['https://cdn.example/ref.mp3'],
        referenceAudioUrls: ['https://cdn.example/ref.mp3'],
      },
    });
    expect(preview.body).toMatchObject({ model: 'my-video-alias',
      video_urls: ['https://cdn.example/ref.mp4'], audio_urls: ['https://cdn.example/ref.mp3'] });
    if (name === 'H3') expect(preview.body).toMatchObject({
      first_frame_image: 'https://cdn.example/first.png', last_frame_image: 'https://cdn.example/last.png',
      image_urls: ['https://cdn.example/ref.png'],
    });
    else expect(preview.body).toMatchObject({ image_with_roles: [
      { url: 'https://cdn.example/ref.png', role: 'reference_image' },
    ] });
    expect(protocol.response.taskIdPath).toBe('data.0.task_id');
    expect(protocol.poll!.path).toContain('{{submit.data.0.task_id}}');
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it.each(['caret', 'selection', 'same variable'] as const)('inserts a variable at the saved %s and restores the editor focus', async (mode) => {
    render();
    const protocol = getDefaultCustomProtocol('image');
    const selectedText = mode === 'selection' ? '{{prompt}}' : mode === 'same variable' ? '{{model}}' : '';
    protocol.submit.body = { prompt: selectedText };
    const draft = JSON.stringify(protocol);
    change(protocolField(), draft);
    const start = draft.indexOf('"prompt":"') + '"prompt":"'.length;
    const end = start + selectedText.length;
    const textarea = {
      selectionStart: start, selectionEnd: end, focus: vi.fn(),
      setSelectionRange: vi.fn((position: number) => {
        textarea.selectionStart = position;
        textarea.selectionEnd = position;
      }),
    };
    (protocolField().props.ref as { current: unknown }).current = textarea;
    (protocolField().props.onSelect as (event: unknown) => void)({ currentTarget: textarea });
    const insert = () => find((element) => element.type === 'button' && element.props['aria-label'] === '插入变量 {{model}}');
    await click(insert());
    expect(protocolField().props.value).toBe(`${draft.slice(0, start)}{{model}}${draft.slice(end)}`);
    expect(textarea.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(textarea.setSelectionRange).toHaveBeenLastCalledWith(start + '{{model}}'.length, start + '{{model}}'.length);
    expect(props.onValidityChange).toHaveBeenLastCalledWith(true);
    await click(insert());
    expect(JSON.parse(protocolField().props.value as string).submit.body.prompt).toBe('{{model}}{{model}}');
  });

  it('inserts at the end before a cursor is chosen and keeps invalid drafts blocked', async () => {
    render();
    const textarea = { focus: vi.fn(), setSelectionRange: vi.fn() };
    (protocolField().props.ref as { current: unknown }).current = textarea;
    const draft = protocolField().props.value as string;
    await click(find((element) => element.props['aria-label'] === '插入变量 {{prompt}}'));
    expect(protocolField().props.value).toBe(`${draft}{{prompt}}`);
    expect(button('试跑').props.disabled).toBe(true);
  });

  it('offers the actual asynchronous task variable as a keyboard-accessible insertion button', async () => {
    props.model.category = 'video';
    const protocol = getDefaultCustomProtocol('video');
    protocol.submit.path = '/videos';
    protocol.response.taskIdPath = 'id';
    protocol.poll!.path = '/videos/{{submit.id}}';
    props.model.executionProfile = { preset: 'custom', protocol };
    render();
    const jsonTab = find((element) => element.props.role === 'tab' && element.props.children === 'JSON');
    await click(jsonTab);
    const insert = find((element) => element.props['aria-label'] === '插入变量 {{submit.id}}');
    expect(insert.type).toBe('button');
    expect(insert.props.type).toBe('button');
    expect(insert.props['aria-controls']).toBe(protocolField().props.id);
  });

  it('blocks an invalid JSON draft at both the button and execution boundary', async () => {
    render();
    change(protocolField(), '{ invalid JSON');
    expect(protocolField().props['aria-invalid']).toBe(true);
    expect(button('试跑').props.disabled).toBe(true);
    await click(button('试跑'));
    expect(driver.execute).not.toHaveBeenCalled();
    expect(props.onValidityChange).toHaveBeenLastCalledWith(false);
  });

  it('preserves an invalid draft when switching views and only overwrites it after explicit confirmation', async () => {
    props.model.category = 'video';
    render();
    change(protocolField(), '{ unfinished user settings');
    await click(find((element) => element.props.role === 'tab' && element.props.children === '表单'));
    expect(protocolField().props.value).toBe('{ unfinished user settings');
    expect(props.onValidityChange).toHaveBeenLastCalledWith(false);
    driver.confirm.mockResolvedValue(false);
    await click(find((element) => element.props['aria-label'] === '填入 H3 视频预设（APIMart）'));
    expect(protocolField().props.value).toBe('{ unfinished user settings');
    expect(props.onChange).not.toHaveBeenCalled();
    driver.confirm.mockResolvedValue(true);
    await click(find((element) => element.props['aria-label'] === '填入 H3 视频预设（APIMart）'));
    expect(JSON.parse(protocolField().props.value as string).submit.path).toBeTruthy();
  });

  it('keeps preview-only edits out of real trial variables', async () => {
    render();
    const previewLabel = find((element) => element.type === 'label' && element.props.children === '示例变量 JSON');
    const preview = find((element) => element.type === 'textarea' && element.props.id === previewLabel.props.htmlFor);
    change(preview, JSON.stringify({ model: 'other-model', prompt: 'preview only', imageUrls: ['https://cdn.example/not-real.png'] }));
    await click(button('试跑'));
    expect(driver.execute).toHaveBeenCalledWith(expect.objectContaining({ variables: expect.objectContaining({
      model: 'image-model', prompt: 'A cinematic product shot',
    }) }));
    expect(driver.execute.mock.calls[0][0].variables.imageUrls).toBeUndefined();
  });

  it('offers one first-frame URL for Kling Flash and uses the connection’s effective duration in a trial', async () => {
    // 先完成模块加载，断言只等待试跑编排，不受整套回归的并发转译影响。
    await import('../../src/services/ai/generateVideo');
    const model = KLING_VIDEO_MODEL_MANIFEST.find((entry) => entry.id === 'kling-video-4.0-flash-first-frame')!;
    props.model = { ...model, videoCapability: { ...model.videoCapability, defaultDuration: 12, maxDuration: 12, durations: [12] } };
    props.catalogId = 'kling';
    props.baseUrl = KLING_BASE_URL;
    props.readOnlyProtocol = true;
    driver.execute.mockResolvedValue({ urls: ['https://cdn.example/result.mp4'] });
    render();
    expect(elements(tree).some((element) => element.type === 'option' && element.props.value === 'custom')).toBe(false);
    const protocolJson = find((element) => element.type === 'pre' && typeof element.props.children === 'string'
      && element.props.children.includes('/image-to-video/kling-4.0-flash'));
    expect(protocolJson.props.contentEditable).toBeUndefined();
    find((element) => element.type === 'summary' && element.props.children === '本地请求预览');
    const label = find((element) => element.type === 'label'
      && elements(element.props.children).some((child) => child.props.children === '首帧图片地址'));
    expect(elements(tree).some((element) => element.props.children === '尾帧图片地址（可选）')).toBe(false);
    const first = 'https://media.vendor.com/frame.png';
    change(elements(label).find((element) => element.type === 'textarea')!, first);
    await click(button('试跑'));
    await vi.waitFor(() => expect(driver.execute).toHaveBeenCalledOnce());
    expect(driver.execute).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({ duration: 12, resolution: '720p', imageWithRoles: [{ type: 'first_frame', url: first }] }),
      protocol: expect.objectContaining({ submit: expect.objectContaining({ path: '/image-to-video/kling-4.0-flash' }) }),
    }));
  });

  it('blocks Kling image trials that exceed the configured budget and accepts the boundary', async () => {
    const model = KLING_IMAGE_MODEL_MANIFEST[0];
    props.model = { ...model, imageCapability: { ...model.imageCapability, promptMaxCharacters: 8, promptMaxNonAsciiCharacters: 4 } };
    props.catalogId = 'kling';
    props.baseUrl = KLING_BASE_URL;
    props.readOnlyProtocol = true;
    render();
    const trialLabel = find((element) => element.type === 'label' && elements(element.props.children).some((child) => child.props.children === '试跑参数 JSON'));
    const trial = find((element) => element.type === 'textarea' && element.props.id === trialLabel.props.htmlFor);
    change(trial, JSON.stringify({ prompt: '天空海洋岛' }));
    await click(button('试跑'));
    expect(driver.execute).not.toHaveBeenCalled();
    change(trial, JSON.stringify({ prompt: '天空海洋' }));
    await click(button('试跑'));
    expect(driver.execute).toHaveBeenCalledOnce();
    expect(driver.execute).toHaveBeenCalledWith(expect.objectContaining({ variables: expect.objectContaining({ prompt: '天空海洋' }) }));
  });

  it('uses a valid initial output count for the selectable Kling series trial', async () => {
    props.model = getProviderDefinition('kling')!.models!.find((entry) => entry.id === 'kling-image-4.0-series-selected')!;
    props.catalogId = 'kling';
    props.baseUrl = KLING_BASE_URL;
    props.readOnlyProtocol = true;
    driver.execute.mockResolvedValue({ urls: ['https://cdn.example/result-1.png', 'https://cdn.example/result-2.png'] });
    render();
    await click(button('试跑'));
    expect(driver.execute).toHaveBeenCalledWith(expect.objectContaining({ variables: expect.objectContaining({ n: 2 }) }));
  });

  it.each([
    ['kling-video-4.0-text', []],
    ['kling-video-4.0-keyframes', ['首帧图片地址', '中间帧地址（每行一条，可选）', '尾帧图片地址（可选）']],
  ] as const)('binds the video trial fields to the confirmed operation for %s', (id, labels) => {
    props.model = KLING_VIDEO_MODEL_MANIFEST.find((entry) => entry.id === id)!;
    props.catalogId = 'kling';
    props.baseUrl = KLING_BASE_URL;
    props.readOnlyProtocol = true;
    render();
    expect(elements(tree).some((element) => element.type === 'option' && element.props.value === 'reference')).toBe(false);
    const materialLabels = elements(tree).filter((element) => element.type === 'span'
      && typeof element.props.children === 'string' && /帧.*地址|参考.*地址/.test(element.props.children));
    expect(materialLabels.map((element) => element.props.children)).toEqual(labels);
  });

  it('blocks placeholder trial media locally and does not report text-only media results as success', async () => {
    render();
    const trialLabel = find((element) => element.type === 'label' && elements(element.props.children).some((child) => child.props.children === '试跑参数 JSON'));
    const trial = find((element) => element.type === 'textarea' && element.props.id === trialLabel.props.htmlFor);
    change(trial, JSON.stringify({ prompt: 'real trial', imageUrls: ['https://cdn.example/ref.png'] }));
    await click(button('试跑'));
    expect(driver.execute).not.toHaveBeenCalled();
    expect(elements(tree).some((element) => element.props.children === '试跑变量包含示例素材，请换成真实素材后再试跑')).toBe(true);
    change(trial, JSON.stringify({ prompt: 'real trial' }));
    driver.execute.mockResolvedValue({ text: 'this is not an image' });
    await click(button('试跑'));
    expect(elements(tree).some((element) => typeof element.props.children === 'string'
      && element.props.children.includes('没有解析出有效媒体结果地址'))).toBe(true);
  });

  it('executes the corrected current draft with the edited sample variables', async () => {
    render();
    change(protocolField(), '{ invalid JSON');
    const protocol = getDefaultCustomProtocol('image');
    protocol.submit.path = '/edited-images';
    change(protocolField(), JSON.stringify(protocol));
    const sample = find((element) => element.type === 'textarea'
      && String(element.props.value).includes('A cinematic product shot'));
    change(sample, JSON.stringify({ model: 'image-model', prompt: 'my trial', n: 2,
      [PREPARED_MULTIPART_FILES]: { 'imageUrls.0': 'data:image/png;base64,Zm9yZ2Vk' } }));
    expect(button('试跑').props.disabled).toBe(false);
    await click(button('试跑'));
    expect(driver.execute).toHaveBeenCalledOnce();
    expect(driver.execute).toHaveBeenCalledWith(expect.objectContaining({
      protocol: expect.objectContaining({ submit: expect.objectContaining({ path: '/edited-images' }) }),
      variables: { model: 'image-model', prompt: 'my trial', n: 2 },
    }));
  });

  it('keeps an invalid JSON subfield blocked while another form field is edited', async () => {
    props.model.category = 'video';
    render();
    await click(find((element) => element.props.role === 'tab' && element.props.children === '表单'));
    const bodyField = find((element) => element.props.fieldId === 'submit-body');
    (bodyField.props.onValidityChange as (id: string, error: string) => void)('submit-body', 'invalid body');
    render();
    const pathField = find((element) => element.type === 'input' && element.props.value === '/images/generations');
    change(pathField, '/edited-images');
    expect(button('试跑').props.disabled).toBe(true);
    await click(button('试跑'));
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it('copies configuration instructions in form view without depending on hidden DOM or exposing the key', async () => {
    props.model.category = 'video';
    const protocol = getDefaultCustomProtocol('image');
    protocol.submit.body = { prompt: '{{prompt}}', accidentalKey: props.apiKey };
    props.model.executionProfile = { preset: 'custom', protocol };
    render();
    await click(find((element) => element.props.role === 'tab' && element.props.children === '表单'));
    await click(button('复制给AI修改'));
    const copied = driver.copy.mock.calls[0][0] as string;
    expect(copied).toContain('version 固定为 2');
    expect(copied).toContain('poll.response.result');
    expect(copied).not.toContain(props.apiKey);
    expect(copied).toContain('[REDACTED]');
  });
});

import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface HookScope { values: unknown[]; index: number }
const driver = vi.hoisted(() => ({
  scope: null as HookScope | null, execute: vi.fn(), copy: vi.fn(),
  layoutEffects: [] as Array<() => void>,
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
  useMemo: <T,>(factory: () => T) => factory(),
  useEffect: () => {},
  useLayoutEffect: (effect: () => void) => { driver.layoutEffects.push(effect); },
  useId: () => `protocol-test-${driver.scope!.index++}`,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock('../../src/services/ai/modelProtocol', async (original) => ({
  ...await original<typeof import('../../src/services/ai/modelProtocol')>(),
  executeModelProtocol: (...args: unknown[]) => driver.execute(...args),
}));
vi.mock('../../src/services/clipboardService', () => ({ copyText: (...args: unknown[]) => driver.copy(...args) }));
import ModelProtocolEditor from '../../src/components/settings/ModelProtocolEditor';
import { getDefaultCustomProtocol, parseModelExecutionProtocol, previewModelProtocolRequest } from '../../src/services/ai/modelProtocol';

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
function change(element: Element, value: string) {
  const target = { value, selectionStart: value.length, selectionEnd: value.length };
  (element.props.onChange as (event: unknown) => void)({ target, currentTarget: target });
  render();
}
function render() {
  driver.scope!.index = 0;
  driver.layoutEffects = [];
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
  driver.copy.mockReset().mockResolvedValue(true);
  props = {
    model: { id: 'image-model', name: 'Image', category: 'image', provider: 'custom',
      executionProfile: { preset: 'custom', protocol: getDefaultCustomProtocol('image') } },
    apiKey: 'private-connection-key', baseUrl: 'https://gateway.example/v1',
    onChange: vi.fn(), onValidityChange: vi.fn(), onImageReferenceRequestModeChange: vi.fn(), onClose: vi.fn(),
  };
});

describe('model protocol editor interactions', () => {
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

  it('executes the corrected current draft with the edited sample variables', async () => {
    render();
    change(protocolField(), '{ invalid JSON');
    const protocol = getDefaultCustomProtocol('image');
    protocol.submit.path = '/edited-images';
    change(protocolField(), JSON.stringify(protocol));
    const sample = find((element) => element.type === 'textarea'
      && String(element.props.value).includes('A cinematic product shot'));
    change(sample, JSON.stringify({ model: 'image-model', prompt: 'my trial', n: 2 }));
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

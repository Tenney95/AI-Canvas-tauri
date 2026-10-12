import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryRecord } from '../../src/services/indexedDbService';

interface Harness {
  states: unknown[];
  memos: Array<{ value: unknown; deps: readonly unknown[] }>;
  effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }>;
  pending: Array<() => void>;
  stateIndex: number; memoIndex: number; effectIndex: number;
}
const driver = vi.hoisted(() => ({
  current: null as Harness | null,
  load: vi.fn(),
  copy: vi.fn(),
  save: vi.fn(),
  pick: vi.fn(),
  pending: vi.fn(),
  resolve: vi.fn(),
  reverse: vi.fn(),
  meta: vi.fn(),
  putMeta: vi.fn(),
  deleteMeta: vi.fn(),
  nodes: [] as unknown[],
  dramaAssets: { characters: [], scenes: [], props: [] } as unknown,
}));
vi.mock('react', async () => {
  const memo = <T,>(factory: () => T, deps: readonly unknown[]) => {
    const scope = driver.current!; const index = scope.memoIndex++;
    const previous = scope.memos[index];
    if (!previous || deps.length !== previous.deps.length || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) scope.memos[index] = { value: factory(), deps };
    return scope.memos[index].value as T;
  };
  return { ...await vi.importActual<typeof import('react')>('react'),
    useMemo: memo,
    useCallback: <T,>(callback: T, deps: readonly unknown[]) => memo(() => callback, deps),
    // Direct component harnesses read the external-store snapshot without a React dispatcher.
    useSyncExternalStore: <T,>(_subscribe: (notify: () => void) => () => void, getSnapshot: () => T) => getSnapshot(),
    useState: <T,>(initial: T | (() => T)) => {
      const scope = driver.current!; const index = scope.stateIndex++;
      if (!(index in scope.states)) scope.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [scope.states[index], (value: T | ((old: T) => T)) => {
        scope.states[index] = typeof value === 'function' ? (value as (old: T) => T)(scope.states[index] as T) : value;
      }];
    },
    useRef: <T,>(initial: T) => {
      const scope = driver.current!; const index = scope.stateIndex++;
      if (!(index in scope.states)) scope.states[index] = { current: initial };
      return scope.states[index];
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const scope = driver.current!; const index = scope.effectIndex++; const previous = scope.effects[index];
      if (previous && deps?.length === previous.deps?.length && deps?.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
      scope.pending.push(() => { previous?.cleanup?.(); scope.effects[index] = { deps, cleanup: effect() ?? undefined }; });
    },
  };
});
vi.mock('../../src/services/assetImageDetails', async () => ({
  ...await vi.importActual<typeof import('../../src/services/assetImageDetails')>('../../src/services/assetImageDetails'),
  loadAssetImageDetails: async (...args: unknown[]) => {
    const value = await driver.load(...args);
    return value && 'history' in value ? value : { identity: { assetId: 'asset-image', digest: 'a'.repeat(64), bytes: 1000 }, record: null, references: [], warning: null, contentChanged: false, history: value };
  },
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ saveAssetImageDetails: driver.save, nodes: driver.nodes, dramaAssets: driver.dramaAssets }),
}));
vi.mock('../../src/services/fs/assetImageMetadata', () => ({ MAX_ASSET_IMAGE_PROMPT: 30000, MAX_ASSET_IMAGE_REFERENCES: 16, pickAssetImageReferences: driver.pick, previewPendingAssetImageReferences: driver.pending, resolveAssetImageReferences: driver.resolve }));
vi.mock('../../src/services/clipboardService', () => ({ copyText: driver.copy }));
vi.mock('../../src/services/ai/reversePrompt', () => ({
  resolveVisionTextModel: () => ({ model: 'general/vision-model', provider: 'general' }),
  reversePromptAndTags: driver.reverse,
}));
vi.mock('../../src/services/indexedDbService', async (original) => ({
  ...await original<typeof import('../../src/services/indexedDbService')>(),
  getAllAssetMeta: async () => [], getAssetMetaById: driver.meta,
  putAssetMeta: driver.putMeta, deleteAssetMeta: driver.deleteMeta,
}));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: 'preview-modal' }));
vi.mock('../../src/components/shared/ZoomableImage', () => ({ default: 'zoomable-image' }));
vi.mock('../../src/components/shared/ViewportImage', () => ({ default: 'viewport-image' }));
vi.mock('../../src/components/shared/ResourceVideoPreview', () => ({ default: 'video-preview' }));

import AssetImagePreview from '../../src/components/assets/AssetImagePreview';
import AssetThumb from '../../src/components/shared/AssetThumb';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
type Props = ComponentProps<typeof AssetImagePreview>;
let scope: Harness;
let input: Props;
let tree: unknown;
let win: EventTarget;
const files = [
  { name: '人物.png', path: '/images/人物.png', assetUrl: 'https://images.test/a.png', category: 'image' as const, size: 1000, source: 'project' as const },
  { name: '场景.png', path: '/images/场景.png', assetUrl: 'https://images.test/b.png', category: 'image' as const, size: 2000, source: 'folder' as const },
];
const history = (prompt = '夕阳下的街道'): HistoryRecord => ({ id: 'record', projectId: 'project', nodeId: 'node', nodeLabel: '图片', timestamp: 1,
  prompt, output: '/images/人物.png', nodeType: 'ai-image', model: 'image-model', provider: 'provider', status: 'success', params: { imageSize: '2K', aspectRatio: '16:9' } });
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function find(predicate: (element: Element) => boolean): Element {
  const result = elements(tree).find(predicate); expect(result).toBeDefined(); return result!;
}
function button(label: string) { return find((element) => element.props['aria-label'] === label || element.type === 'button'
  && (element.props.children === label || Array.isArray(element.props.children) && element.props.children.includes(label))); }
function click(element: Element) { (element.props.onClick as () => void)(); }
function render() {
  driver.current = scope; scope.stateIndex = scope.memoIndex = scope.effectIndex = 0;
  tree = AssetImagePreview(input);
  scope.pending.splice(0).forEach((effect) => effect());
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
async function transactionalSaveFixture() {
  const db = await vi.importActual<typeof import('../../src/services/indexedDbService')>('../../src/services/indexedDbService');
  const assetId = crypto.randomUUID();
  const digest = 'a'.repeat(64);
  driver.load.mockResolvedValue({ history: history(), identity: { assetId, digest, bytes: 1000 }, record: null, references: [], warning: null, contentChanged: false });
  driver.meta.mockImplementation(db.getAssetMetaById);
  driver.save.mockImplementation(async (_file, edit, options) => {
    const record = { id: `asset-image:${assetId}:${digest}`, assetId, contentDigest: digest, fileName: files[0].name,
      prompt: edit.prompt, references: edit.references, revision: 1, updatedAt: Date.now() };
    await db.putAssetImageRecord(record, 0, { tagReplacement: edit.tagReplacement, signal: options.signal });
    return record;
  });
  return { db, assetId };
}
function key(name: string) {
  const event = new Event('keydown', { cancelable: true }); Object.assign(event, { key: name });
  win.dispatchEvent(event); render(); return event;
}
beforeEach(() => {
  scope = { states: [], memos: [], effects: [], pending: [], stateIndex: 0, memoIndex: 0, effectIndex: 0 };
  input = { files, initialPath: files[0].path, projectId: 'project', onClose: vi.fn() };
  // Node EventTarget 的 boolean capture 移除语义与浏览器不一致，统一为本测试的单一捕获层。
  win = new class extends EventTarget {
    override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null) { super.addEventListener(type, callback); }
    override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null) { super.removeEventListener(type, callback); }
  }(); vi.stubGlobal('window', win);
  driver.load.mockReset().mockResolvedValue(history()); driver.copy.mockReset().mockResolvedValue(true);
  driver.save.mockReset().mockImplementation(async (_file, input) => ({ id: 'asset-image:record', assetId: 'asset-image', contentDigest: 'a'.repeat(64), prompt: input.prompt, references: input.references, revision: 1, updatedAt: 1, fileName: '人物.png' }));
  driver.pick.mockReset().mockResolvedValue([]); driver.pending.mockReset().mockResolvedValue([]); driver.resolve.mockReset().mockResolvedValue([]);
  driver.reverse.mockReset().mockResolvedValue({ prompt: '反推得到的提示词', tags: ['人物', '夕阳', '人物'] });
  driver.meta.mockReset().mockResolvedValue(undefined);
  driver.putMeta.mockReset().mockResolvedValue(undefined); driver.deleteMeta.mockReset().mockResolvedValue(undefined);
  driver.nodes = []; driver.dramaAssets = { characters: [], scenes: [], props: [] };
});
afterEach(() => { scope.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe('asset image fullscreen preview', () => {
  it('persists both generated fields through the real IndexedDB transaction without a manual save', async () => {
    const { db, assetId } = await transactionalSaveFixture();
    render(); await settle(); click(button('反推提示词和标签')); render(); click(button('开始反推'));
    await vi.waitFor(async () => {
      await settle();
      expect((await db.getAssetImageRecords()).find((record) => record.assetId === assetId)?.prompt).toBe('反推得到的提示词');
      expect(await db.getAssetMetaById(assetId)).toMatchObject({ tags: ['人物', '夕阳'], taggedBy: 'vision' });
      expect(elements(tree).some((element) => element.type === 'textarea')).toBe(false);
    });
    expect(driver.save).toHaveBeenCalledOnce();
  });

  it('atomically rejects saving when tags were modified during generation and keeps the generated draft', async () => {
    const { db, assetId } = await transactionalSaveFixture();
    await db.putAssetMeta({ assetId, tags: ['旧标签'], taggedBy: 'manual', updatedAt: 1 });
    let finish!: (result: { prompt: string; tags: string[] }) => void;
    driver.reverse.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(); await settle(); click(button('反推提示词和标签')); render(); click(button('开始反推'));
    await vi.waitFor(() => expect(driver.reverse).toHaveBeenCalledOnce());
    await db.putAssetMeta({ assetId, tags: ['其他操作的新标签'], taggedBy: 'manual', updatedAt: 2 });
    finish({ prompt: '反推结果', tags: ['反推标签'] });
    await vi.waitFor(async () => {
      await settle();
      expect(button('保存').props.disabled).toBe(false);
      expect(find((element) => element.type === 'textarea').props.value).toBe('反推结果');
    });
    expect((await db.getAssetImageRecords()).some((record) => record.assetId === assetId)).toBe(false);
    expect(await db.getAssetMetaById(assetId)).toMatchObject({ tags: ['其他操作的新标签'], updatedAt: 2 });
  });

  it('automatically saves reverse prompt and replacement tags in one action and leaves edit mode', async () => {
    input.onTagsSaved = vi.fn();
    render(); await settle(); click(button('反推提示词和标签')); render();
    click(button('开始反推')); await settle();
    expect(driver.reverse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ imageUrls: [files[0].assetUrl], model: 'general/vision-model', provider: 'general' }));
    expect(driver.save).toHaveBeenCalledExactlyOnceWith(files[0], expect.objectContaining({ prompt: '反推得到的提示词',
      tagReplacement: { tags: ['人物', '夕阳'], expected: null }, newReferencePaths: [],
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(input.onTagsSaved).toHaveBeenCalledWith(files[0], ['人物', '夕阳']);
    expect(driver.putMeta).not.toHaveBeenCalled();
    expect(driver.deleteMeta).not.toHaveBeenCalled();
    expect(find((element) => element.props.children === '反推得到的提示词')).toBeDefined();
    expect(elements(tree).some((element) => element.type === 'textarea')).toBe(false);
    expect(button('编辑提示词与参考图').props.disabled).toBe(false);
    click(button('关闭图片预览'));
    expect(input.onClose).toHaveBeenCalledOnce();
    expect(elements(tree).some((element) => element.props.role === 'alertdialog')).toBe(false);
  });

  it('uses the tag baseline from before generation for the atomic replacement', async () => {
    const baseline = { tags: ['旧标签'], updatedAt: 123 };
    driver.meta.mockResolvedValueOnce(baseline);
    driver.reverse.mockImplementationOnce(async () => {
      expect(driver.meta).toHaveBeenCalledWith('asset-image');
      return { prompt: '反推结果', tags: ['新标签'] };
    });
    render(); await settle(); click(button('反推提示词和标签')); render(); click(button('开始反推')); await settle();
    expect(driver.save.mock.calls[0][1].tagReplacement).toEqual({ tags: ['新标签'], expected: baseline });
    expect(driver.meta).toHaveBeenCalledOnce();
  });

  it('preserves pending reference edits when the generated prompt and tags are automatically saved', async () => {
    driver.pick.mockResolvedValue(['/selected/ref.png']);
    driver.pending.mockResolvedValue([{ path: '/selected/ref.png', name: 'ref.png', url: 'https://images.test/ref.png' }]);
    render(); await settle(); click(button('编辑提示词与参考图')); render(); click(button('添加参考图')); await settle();
    click(button('反推提示词和标签')); render(); click(button('开始反推')); await settle();
    expect(driver.save.mock.calls[0][1]).toMatchObject({ prompt: '反推得到的提示词', newReferencePaths: ['/selected/ref.png'] });
    expect(elements(tree).some((element) => element.type === 'textarea')).toBe(false);
  });

  it('retains the generated draft after automatic save failure and retries saving without another model call', async () => {
    driver.save.mockRejectedValueOnce(new Error('write conflict'));
    render(); await settle(); click(button('反推提示词和标签')); render(); click(button('开始反推')); await settle();
    expect(find((element) => element.type === 'textarea').props.value).toBe('反推得到的提示词');
    expect(button('保存').props.disabled).toBe(false);
    expect(find((element) => element.props.children === '2K')).toBeDefined();
    click(button('保存')); await settle();
    expect(driver.reverse).toHaveBeenCalledOnce();
    expect(driver.save).toHaveBeenCalledTimes(2);
    expect(elements(tree).some((element) => element.type === 'textarea')).toBe(false);
  });

  it('cancels automatic saving and retains generated results as a draft', async () => {
    driver.save.mockImplementationOnce((_file, _input, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    }));
    render(); await settle(); click(button('反推提示词和标签')); render(); click(button('开始反推')); await settle();
    expect(button('保存').props.disabled).toBe(true);
    click(button('取消保存')); await settle();
    expect(find((element) => element.type === 'textarea').props.value).toBe('反推得到的提示词');
    expect(button('保存').props.disabled).toBe(false);
    expect(driver.reverse).toHaveBeenCalledOnce();
  });

  it('cancels generation when navigating away and never saves a late result onto another image', async () => {
    let finish!: (result: { prompt: string; tags: string[] }) => void;
    driver.reverse.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(); await settle(); click(button('反推提示词和标签')); render(); click(button('开始反推')); await settle();
    const signal = driver.reverse.mock.calls[0][0].signal as AbortSignal;
    click(button('下一张图片')); render(); await settle();
    expect(signal.aborted).toBe(true);
    finish({ prompt: '迟到结果', tags: ['旧图片'] }); await settle();
    expect(driver.save).not.toHaveBeenCalled();
    expect(find((element) => element.type === 'zoomable-image').props.src).toBe(files[1].assetUrl);
    expect(elements(tree).some((element) => element.props.children === '迟到结果')).toBe(false);
  });

  it('loads stored prompt/parameters only on opening, copies the exact prompt and reads actual pixel size', async () => {
    expect(driver.load).not.toHaveBeenCalled();
    render(); expect(driver.load).toHaveBeenCalledWith(files[0], 'project', expect.any(AbortSignal));
    await settle();
    expect(find((element) => element.props.children === '夕阳下的街道')).toBeDefined();
    expect(find((element) => element.props.children === '2K')).toBeDefined();
    const stage = find((element) => element.props.className === 'asset-image-preview-stage');
    (stage.props.onLoadCapture as (event: unknown) => void)({ target: { tagName: 'IMG', naturalWidth: 2048, naturalHeight: 1024 } }); render();
    expect(find((element) => element.props.children === '2048 × 1024')).toBeDefined();
    click(button('复制提示词')); await settle();
    expect(driver.copy).toHaveBeenCalledExactlyOnceWith('夕阳下的街道');
    expect(find((element) => element.props.children === '提示词已复制')).toBeDefined();
    expect(find((element) => element.type === 'zoomable-image').props.onClose).toBeUndefined();
  });

  it('shows missing generation information honestly and distinguishes read failure with retry', async () => {
    driver.load.mockResolvedValueOnce(null); render(); await settle();
    expect(find((element) => element.props.children === '暂无生成信息')).toBeDefined();
    expect(button('复制提示词').props.disabled).toBe(true);
    driver.load.mockRejectedValueOnce(new Error('read failed'));
    click(button('下一张图片')); render(); await settle();
    expect(find((element) => element.props.children === '生成信息读取失败')).toBeDefined();
    click(button('重试读取')); render(); await settle();
    expect(find((element) => element.props.children === '夕阳下的街道')).toBeDefined();
  });

  it('ignores late metadata after navigation and cancels reads when disposed', async () => {
    const completions: Array<(value: HistoryRecord) => void> = [];
    const signals: AbortSignal[] = [];
    driver.load.mockImplementation((_file, _project, signal: AbortSignal) => {
      signals.push(signal); return new Promise((resolve) => completions.push(resolve));
    });
    render(); click(button('下一张图片')); render();
    expect(signals[0].aborted).toBe(true);
    completions[1](history('场景的提示词')); await settle();
    completions[0](history('人物的迟到提示词')); await settle();
    expect(find((element) => element.props.children === '场景的提示词')).toBeDefined();
    expect(elements(tree).some((element) => element.props.children === '人物的迟到提示词')).toBe(false);
    scope.effects.forEach((effect) => effect.cleanup?.());
    expect(signals[1].aborted).toBe(true);
  });

  it('keyboard navigation stays within the image list and Escape consumes the background shortcut', async () => {
    render(); await settle();
    expect(button('上一张图片').props.disabled).toBe(true);
    expect(key('ArrowRight').defaultPrevented).toBe(true); await settle();
    expect(find((element) => element.type === 'zoomable-image').props.src).toBe(files[1].assetUrl);
    expect(button('下一张图片').props.disabled).toBe(true);
    key('ArrowRight'); await settle();
    expect(find((element) => element.type === 'zoomable-image').props.src).toBe(files[1].assetUrl);
    expect(key('Escape').defaultPrevented).toBe(true);
    expect(input.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows image errors and allows retry without closing the asset library', async () => {
    render(); await settle();
    (find((element) => element.type === 'zoomable-image').props.onError as () => void)(); render();
    expect(find((element) => element.props.children === '图片加载失败')).toBeDefined();
    click(button('重新加载图片')); render();
    expect(find((element) => element.type === 'zoomable-image')).toBeDefined();
    expect(input.onClose).not.toHaveBeenCalled();
  });

  it('closes when the currently viewed asset disappears', () => {
    render(); input = { ...input, files: [] }; render();
    expect(input.onClose).toHaveBeenCalledTimes(1);
    expect(tree).toBeNull();
  });

  it('edits and saves a separate prompt, preserving the original generation parameters', async () => {
    render(); await settle(); click(button('编辑提示词与参考图')); render();
    const textarea = find((element) => element.type === 'textarea');
    (textarea.props.onChange as (event: unknown) => void)({ target: { value: '用户修改后的提示词' } }); render();
    click(button('保存')); await settle();
    expect(driver.save).toHaveBeenCalledWith(files[0], expect.objectContaining({ prompt: '用户修改后的提示词', newReferencePaths: [] }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(find((element) => element.props.children === '用户修改后的提示词')).toBeDefined();
    expect(find((element) => element.props.children === '2K')).toBeDefined();
    expect(elements(tree).some((element) => element.type === 'textarea')).toBe(false);
    click(button('复制提示词')); await settle(); expect(driver.copy).toHaveBeenCalledWith('用户修改后的提示词');
  });

  it('retains a failed save draft and requires a choice before closing or switching', async () => {
    driver.save.mockRejectedValueOnce(new Error('source replaced'));
    render(); await settle(); click(button('编辑提示词与参考图')); render();
    (find((element) => element.type === 'textarea').props.onChange as (event: unknown) => void)({ target: { value: '尚未保存' } }); render();
    click(button('保存')); await settle();
    expect(find((element) => element.type === 'textarea').props.value).toBe('尚未保存');
    key('Escape'); expect(input.onClose).not.toHaveBeenCalled();
    expect(find((element) => element.props.role === 'alertdialog')).toBeDefined();
    click(button('继续编辑')); render(); click(button('下一张图片')); render();
    click(button('放弃编辑')); render(); await settle();
    expect(find((element) => element.type === 'zoomable-image').props.src).toBe(files[1].assetUrl);
  });

  it('adds pending references, views them without changing the asset, and passes only saved files to the action', async () => {
    driver.pick.mockResolvedValue(['/selected/ref.png']);
    driver.pending.mockResolvedValue([{ path: '/selected/ref.png', name: 'ref.png', url: 'https://images.test/ref.png' }]);
    render(); await settle(); click(button('编辑提示词与参考图')); render(); click(button('添加参考图')); await settle();
    click(button('查看待保存参考图 ref.png')); render();
    expect(find((element) => element.type === 'zoomable-image').props.src).toBe('https://images.test/ref.png');
    key('Escape'); expect(input.onClose).not.toHaveBeenCalled();
    expect(find((element) => element.type === 'zoomable-image').props.src).toBe(files[0].assetUrl);
    click(button('保存')); await settle();
    expect(driver.save.mock.calls[0][1].newReferencePaths).toEqual(['/selected/ref.png']);
  });

  it('does not report a committed save as failed when reference preview resolution fails', async () => {
    driver.resolve.mockRejectedValueOnce(new Error('directory unavailable'));
    render(); await settle(); click(button('编辑提示词与参考图')); render();
    click(button('保存')); await settle();
    expect(find((element) => element.props.role === 'status' && Array.isArray(element.props.children) && element.props.children.includes('已保存'))).toBeDefined();
    expect(elements(tree).some((element) => element.type === 'textarea')).toBe(false);
  });

  it('cancels an in-flight save and retains the editable draft', async () => {
    driver.save.mockImplementationOnce((_file, _input, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    }));
    render(); await settle(); click(button('编辑提示词与参考图')); render();
    click(button('保存')); render(); click(button('取消保存')); await settle();
    expect(find((element) => element.type === 'textarea').props.disabled).toBe(false);
    expect(find((element) => element.props.role === 'status' && Array.isArray(element.props.children) && element.props.children.includes('已取消，草稿仍保留'))).toBeDefined();
  });

  it('thumbnail preview is an accessible image-only action and leaves action slots independent', () => {
    const open = vi.fn(); const action = vi.fn();
    tree = AssetThumb({ ...files[0], onImagePreview: open, children: <button aria-label="编辑标签" onClick={action}>标签</button> });
    const event = { stopPropagation: vi.fn() };
    (button('查看图片 人物.png').props.onClick as (event: unknown) => void)(event);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledTimes(1);
    click(button('编辑标签')); expect(action).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledTimes(1);
    tree = AssetThumb({ name: '视频', category: 'video', size: 10, onImagePreview: open });
    expect(elements(tree).some((element) => element.props.className === 'asset-image-preview-trigger')).toBe(false);
  });

  it('renders prompt mentions as prompt-chips and shows referenced images in the top section with stage preview', async () => {
    driver.nodes = [
      { id: 'node-c90a1u5s7', data: { label: '生成图像', type: 'ai-image', imageUrl: 'https://images.test/ref-thumb.png', displayId: 1 } },
    ];
    driver.load.mockResolvedValueOnce(history('一个韩系美女跳舞@{node-c90a1u5s7:生成图像}'));
    render();
    await settle();
    await settle();

    // 检查提示词芯片渲染
    const chip = find((element) => String(element.props.className ?? '').includes('prompt-chip-node'));
    expect(chip).toBeDefined();
    expect(chip.props['data-ref-id']).toBe('node-c90a1u5s7');

    // 检查上方参考图区域
    const refButton = button('查看参考图 生成图像');
    expect(refButton).toBeDefined();
    expect(find((element) => element.type === 'img' && element.props.src === 'https://images.test/ref-thumb.png')).toBeDefined();

    // 点击参考图切换到预览舞台
    click(refButton);
    render();
    expect(find((element) => element.type === 'zoomable-image').props.src).toBe('https://images.test/ref-thumb.png');
    expect(button('返回原图')).toBeDefined();

    // 点击返回原图恢复
    click(button('返回原图'));
    render();
    expect(find((element) => element.type === 'zoomable-image').props.src).toBe(files[0].assetUrl);
  });
});


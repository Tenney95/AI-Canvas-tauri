/**
 * assetTextPreview — 回归测试：AssetThumb - 文本预览 (Text Preview)。
 */
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Harness {
  states: unknown[];
  refs: Array<{ current: unknown }>;
  effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }>;
  pending: Array<() => void>;
  stateIndex: number;
  refIndex: number;
  effectIndex: number;
}

const driver = vi.hoisted(() => ({ current: null as Harness | null }));
const fs = vi.hoisted(() => ({ open: vi.fn(), readFile: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', async (original) => ({ ...await original<object>(), open: fs.open, readFile: fs.readFile }));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  // Direct component harnesses read the external-store snapshot without a React dispatcher.
  useSyncExternalStore: <T,>(_subscribe: (notify: () => void) => () => void, getSnapshot: () => T) => getSnapshot(),
  useCallback: <T,>(callback: T) => callback,
  useState: <T,>(initial: T | (() => T)) => {
    const scope = driver.current!;
    const index = scope.stateIndex++;
    if (!(index in scope.states)) {
      scope.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    }
    return [
      scope.states[index],
      (value: T | ((old: T) => T)) => {
        scope.states[index] = typeof value === 'function' ? (value as (old: T) => T)(scope.states[index] as T) : value;
      },
    ];
  },
  useRef: <T,>(initial: T) => {
    const scope = driver.current!;
    return (scope.refs[scope.refIndex++] ??= { current: initial });
  },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const scope = driver.current!;
    const index = scope.effectIndex++;
    const old = scope.effects[index];
    if (old && deps?.length === old.deps?.length && deps?.every((dep, i) => Object.is(dep, old.deps?.[i]))) return;
    scope.pending.push(() => {
      old?.cleanup?.();
      scope.effects[index] = { deps, cleanup: effect() ?? undefined };
    });
  },
}));

import AssetThumb, { AssetTextPreview } from '../../src/components/shared/AssetThumb';
import {
  readTextFilePreview,
  getCachedTextPreview,
  clearTextPreviewCache,
  invalidateTextPreview,
} from '../../src/services/fs/core';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;

let scope: Harness;

afterEach(() => {
  scope.effects.forEach((effect) => effect?.cleanup?.());
  vi.unstubAllGlobals();
});

function renderPreview(props: Parameters<typeof AssetTextPreview>[0]) {
  driver.current = scope;
  scope.stateIndex = scope.refIndex = scope.effectIndex = 0;
  const tree = AssetTextPreview(props);
  scope.pending.splice(0).forEach((effect) => effect());
  return tree;
}

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}

function findByClassName(root: unknown, className: string): Element | undefined {
  return elements(root).find((el) => {
    const cls = el.props.className;
    return typeof cls === 'string' && cls.split(' ').includes(className);
  });
}

function pausedTextFile(text: string) {
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const bytes = new TextEncoder().encode(text);
  const file = {
    read: vi.fn(async (buffer: Uint8Array) => {
      start();
      await gate;
      const preview = bytes.subarray(0, buffer.length);
      buffer.set(preview);
      return preview.length;
    }),
    close: vi.fn(async () => undefined),
  };
  return { file, started, release };
}

describe('AssetThumb - 文本预览 (Text Preview)', () => {
  beforeEach(() => {
    clearTextPreviewCache();
    fs.open.mockReset(); fs.readFile.mockReset();
    vi.stubGlobal('window', new EventTarget());
    scope = { states: [], refs: [], effects: [], pending: [], stateIndex: 0, refIndex: 0, effectIndex: 0 };
  });

  it('非 Tauri 环境下 readTextFilePreview 返回空字符串', async () => {
    const text = await readTextFilePreview('/test/file.txt', 100);
    expect(text).toBe('');
  });

  it('size 为 0 时直接返回空字符串并不调用底层文件读取', async () => {
    const text = await readTextFilePreview('/test/empty.txt', 0);
    expect(text).toBe('');
    expect(getCachedTextPreview('/test/empty.txt', 0)).toBe('');
  });

  it.each(['open', 'read'])('大文件的 %s 失败时停止预览，不回退整文件读取', async (failure) => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const close = vi.fn(async () => undefined);
    if (failure === 'open') fs.open.mockRejectedValue(new Error('unavailable'));
    else fs.open.mockResolvedValue({ read: vi.fn(async () => { throw new Error('unavailable'); }), close });
    expect(await readTextFilePreview('/test/large.txt', 200 * 1024 * 1024)).toBe('');
    expect(fs.readFile).not.toHaveBeenCalled();
    if (failure === 'read') expect(close).toHaveBeenCalledOnce();
  });

  it('并发预览同一文件只读取一次，完成后继续复用缓存', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const source = pausedTextFile('并发预览正文');
    fs.open.mockResolvedValue(source.file);
    const previews = Array.from({ length: 3 }, () => readTextFilePreview('/test/shared.txt', 100));
    await source.started;
    expect(fs.open).toHaveBeenCalledOnce();
    source.release();
    expect(await Promise.all(previews)).toEqual(Array(3).fill('并发预览正文'));
    expect(await readTextFilePreview('/test/shared.txt', 100)).toBe('并发预览正文');
    expect(source.file.read).toHaveBeenCalledOnce();
    expect(source.file.close).toHaveBeenCalledOnce();
  });

  it('不同预览字节上限分别读取和缓存，不复用截短内容', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const source = pausedTextFile('abcdef');
    fs.open.mockResolvedValue(source.file);
    const short = readTextFilePreview('/test/limits.txt', 6, 2);
    const long = readTextFilePreview('/test/limits.txt', 6, 5);
    source.release();
    expect(await Promise.all([short, long])).toEqual(['ab', 'abcde']);
    expect(fs.open).toHaveBeenCalledTimes(2);
    expect(getCachedTextPreview('/test/limits.txt', 6, 2)).toBe('ab');
    expect(getCachedTextPreview('/test/limits.txt', 6, 5)).toBe('abcde');
    expect(getCachedTextPreview('/test/limits.txt', 6)).toBeUndefined();
  });

  it('未知大小的预览与已知空文件使用不同缓存', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    expect(await readTextFilePreview('/test/unknown.txt', 0)).toBe('');
    const source = pausedTextFile('content');
    fs.open.mockResolvedValue(source.file);
    source.release();
    expect(await readTextFilePreview('/test/unknown.txt')).toBe('content');
    expect(getCachedTextPreview('/test/unknown.txt', 0)).toBe('');
    expect(getCachedTextPreview('/test/unknown.txt')).toBe('content');
  });

  it.each(['invalidate', 'clear'])('%s 后旧请求不能覆盖新内容或移除新请求', async (operation) => {
    const surface = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} });
    vi.stubGlobal('window', surface);
    const oldFile = pausedTextFile('old');
    const newFile = pausedTextFile('new');
    fs.open.mockResolvedValueOnce(oldFile.file).mockResolvedValueOnce(newFile.file);
    const oldPreview = readTextFilePreview('/test/changed.txt', 3);
    await oldFile.started;
    if (operation === 'invalidate') invalidateTextPreview('/test/changed.txt');
    else clearTextPreviewCache();
    const newPreview = readTextFilePreview('/test/changed.txt', 3);
    await newFile.started;
    oldFile.release();
    expect(await oldPreview).toBe('old');
    expect(getCachedTextPreview('/test/changed.txt', 3)).toBeUndefined();
    const joinedPreview = readTextFilePreview('/test/changed.txt', 3);
    expect(fs.open).toHaveBeenCalledTimes(2);
    newFile.release();
    expect(await Promise.all([newPreview, joinedPreview])).toEqual(['new', 'new']);
    expect(getCachedTextPreview('/test/changed.txt', 3)).toBe('new');
    expect(oldFile.file.close).toHaveBeenCalledOnce();
    expect(newFile.file.close).toHaveBeenCalledOnce();
  });

  it('新预览先完成时，迟到的旧读取不能回灌缓存', async () => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }));
    const oldFile = pausedTextFile('old');
    const newFile = pausedTextFile('new');
    fs.open.mockResolvedValueOnce(oldFile.file).mockResolvedValueOnce(newFile.file);
    const oldPreview = readTextFilePreview('/test/late.txt', 3);
    await oldFile.started;
    invalidateTextPreview('/test/late.txt');
    const newPreview = readTextFilePreview('/test/late.txt', 3);
    newFile.release();
    expect(await newPreview).toBe('new');
    oldFile.release();
    expect(await oldPreview).toBe('old');
    expect(getCachedTextPreview('/test/late.txt', 3)).toBe('new');
  });

  it('共享读取失败后释放请求，后续预览可以重试', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const source = pausedTextFile('retry');
    fs.open.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(source.file);
    const failed = await Promise.all([
      readTextFilePreview('/test/retry.txt', 5),
      readTextFilePreview('/test/retry.txt', 5),
    ]);
    expect(failed).toEqual(['', '']);
    expect(fs.open).toHaveBeenCalledOnce();
    expect(getCachedTextPreview('/test/retry.txt', 5)).toBeUndefined();
    source.release();
    expect(await readTextFilePreview('/test/retry.txt', 5)).toBe('retry');
    expect(fs.open).toHaveBeenCalledTimes(2);
    expect(source.file.close).toHaveBeenCalledOnce();
  });

  it('当 category === "text" 且传入有效 textPreview 时，渲染 .assets-card-text-wrap 与小字内容', () => {
    const sampleText = '第1集：初入森林\n小红帽提着篮子往外婆家走去…';
    const tree = renderPreview({
      name: '小红帽-分集.txt',
      size: 3480,
      badge: '外部',
      textPreview: sampleText,
      children: <button className="test-action-btn">操作</button>,
    });

    const wrap = findByClassName(tree, 'assets-card-text-wrap');
    expect(wrap).toBeDefined();
    expect(wrap?.props.title).toBe('小红帽-分集.txt');

    const content = findByClassName(tree, 'assets-card-text-content');
    expect(content).toBeDefined();
    expect(content?.props.children).toBe(sampleText);

    const fade = findByClassName(tree, 'assets-card-text-fade');
    expect(fade).toBeDefined();

    const sizeBadge = findByClassName(tree, 'assets-card-size');
    expect(sizeBadge).toBeDefined();
    expect(sizeBadge?.props.children).toBe('3.4 KB');

    const badge = findByClassName(tree, 'assets-card-badge');
    expect(badge).toBeDefined();
    expect(badge?.props.children).toBe('外部');

    const actionBtn = findByClassName(tree, 'test-action-btn');
    expect(actionBtn).toBeDefined();
  });

  it('当 textPreview 为空或全空白时，回退到 .assets-card-icon-wrap 并展示文档图标', () => {
    const tree = renderPreview({
      name: '空白.txt',
      size: 0,
      textPreview: '   \n  ',
    });

    const textWrap = findByClassName(tree, 'assets-card-text-wrap');
    expect(textWrap).toBeUndefined();

    const iconWrap = findByClassName(tree, 'assets-card-icon-wrap');
    expect(iconWrap).toBeDefined();

    const icon = findByClassName(tree, 'assets-card-icon');
    expect(icon?.props.children).toBe('📄');
  });

  it('AssetThumb 统一外壳正确将 category === "text" 分派给 AssetTextPreview 元素', () => {
    const sample = '章节一：开始';
    const tree = AssetThumb({
      name: '剧本.txt',
      category: 'text',
      size: 1024,
      textPreview: sample,
      badge: '项目',
    });

    // AssetThumb 返回 AssetTextPreview 元素
    expect((tree as Element).type).toBe(AssetTextPreview);
    expect((tree as Element).props.name).toBe('剧本.txt');
    expect((tree as Element).props.size).toBe(1024);
    expect((tree as Element).props.textPreview).toBe(sample);

    // 渲染 AssetTextPreview
    const rendered = renderPreview((tree as Element).props as unknown as Parameters<typeof AssetTextPreview>[0]);
    const wrap = findByClassName(rendered, 'assets-card-text-wrap');
    expect(wrap).toBeDefined();
    expect(findByClassName(rendered, 'assets-card-text-content')?.props.children).toBe(sample);
  });

  it('AssetThumb 对于 image 和 video 分类维持既有渲染路径', () => {
    const imgTree = AssetThumb({
      name: '封面.png',
      category: 'image',
      size: 2048,
      assetUrl: 'https://images.test/cover.png',
    });
    expect(findByClassName(imgTree, 'assets-card-img-wrap')).toBeDefined();
    expect(findByClassName(imgTree, 'assets-card-text-wrap')).toBeUndefined();

    const videoTree = AssetThumb({
      name: '预告片.mp4',
      category: 'video',
      size: 1048576,
    });
    expect(findByClassName(videoTree, 'assets-card-video-wrap')).toBeDefined();
    expect(findByClassName(videoTree, 'assets-card-text-wrap')).toBeUndefined();
  });
});

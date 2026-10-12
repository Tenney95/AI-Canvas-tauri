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

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  // Direct component harnesses read the external-store snapshot without a React dispatcher.
  useSyncExternalStore: <T,>(_subscribe: (notify: () => void) => () => void, getSnapshot: () => T) => getSnapshot(),
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

describe('AssetThumb - 文本预览 (Text Preview)', () => {
  beforeEach(() => {
    clearTextPreviewCache();
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

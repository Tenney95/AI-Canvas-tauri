import type { ChangeEvent, ComponentProps, KeyboardEvent, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScriptWorkbenchAction } from '../../src/types/scriptWorkbench';

const values: unknown[] = [];
const effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }> = [];
const pendingEffects: Array<() => void> = [];
let stateIndex = 0;
let effectIndex = 0;
const motion = vi.hoisted(() => ({ reduced: false }));

function scheduleEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
  const index = effectIndex++;
  const previous = effects[index];
  if (previous && deps?.length === previous.deps?.length && deps?.every((dependency, i) => Object.is(dependency, previous.deps?.[i]))) return;
  pendingEffects.push(() => {
    previous?.cleanup?.();
    effects[index] = { deps, cleanup: effect() ?? undefined };
  });
}

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: <T,>(initial: T | (() => T)) => {
    const index = stateIndex++;
    if (!(index in values)) values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [values[index], (next: T | ((previous: T) => T)) => {
      values[index] = typeof next === 'function' ? (next as (previous: T) => T)(values[index] as T) : next;
    }];
  },
  useRef: <T,>(initial: T) => values[stateIndex++] ??= { current: initial },
  useId: () => `article-assistant-${stateIndex++}`,
  useEffect: scheduleEffect,
  useLayoutEffect: scheduleEffect,
}));
vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>();
  return { ...actual, useT: () => actual.t };
});
vi.mock('framer-motion', () => ({ useReducedMotion: () => motion.reduced }));

import WorkbenchArticleAssistant from '../../src/components/workbench/WorkbenchArticleAssistant';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
let props: ComponentProps<typeof WorkbenchArticleAssistant>;
let tree: unknown;
let renderedKey: string | null | undefined;
const dispatch = vi.fn<(action: ScriptWorkbenchAction) => Promise<unknown>>();
const candidate = { id: 'candidate-a', text: '修改后的文章候选', targetLabel: '第1集 · 本集剧本' };

function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' && 'props' in node ? text((node as Element).props.children) : '';
}
function render() {
  const scoped = WorkbenchArticleAssistant(props);
  if (renderedKey !== scoped.key) {
    effects.forEach((effect) => effect.cleanup?.());
    values.length = effects.length = pendingEffects.length = 0;
    renderedKey = scoped.key;
  }
  const renderEditor = scoped.type as (props: typeof scoped.props) => unknown;
  stateIndex = effectIndex = 0;
  tree = renderEditor(scoped.props);
  pendingEffects.splice(0).forEach((effect) => effect());
  stateIndex = effectIndex = 0;
  tree = renderEditor(scoped.props);
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
function editor(): ComponentProps<'textarea'> {
  return elements(tree).find((element) => element.type === 'textarea')!.props as ComponentProps<'textarea'>;
}
function button(label: string): Element {
  const control = elements(tree).find((element) => element.type === 'button'
    && (element.props['aria-label'] ?? text(element.props.children)) === label);
  expect(control, `缺少按钮：${label}`).toBeDefined();
  return control!;
}
function click(label: string) {
  const control = button(label);
  expect(control.props.disabled).not.toBe(true);
  (control.props.onClick as () => void)();
  render();
}
function writeInstruction(value: string) {
  editor().onChange!({ target: { value } } as ChangeEvent<HTMLTextAreaElement>);
  render();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((complete) => { resolve = complete; }), resolve };
}

beforeEach(() => {
  renderedKey = undefined;
  values.length = effects.length = pendingEffects.length = 0;
  motion.reduced = false;
  dispatch.mockReset().mockImplementation(async (action) => action.type === 'article_generate' ? candidate : true);
  props = { targetKey: 'article-a', targetLabel: candidate.targetLabel,
    target: { kind: 'script', episodeId: 'episode-a' }, disabled: false, generating: false, dispatch };
});
afterEach(() => { effects.forEach((effect) => effect.cleanup?.()); });

describe('工作台文章 AI 修改', () => {
  it('由父组件提供当前模型或团队入口，同时保留文章目标提示', () => {
    const onChoose = vi.fn();
    props = { ...props, executionControls: <button type="button" aria-label="选择模型" onClick={onChoose}>文本模型</button> };
    render();
    click('选择模型');
    expect(onChoose).toHaveBeenCalledOnce();
    expect(editor().title).toBe(candidate.targetLabel);
    expect(text(tree)).not.toContain(`修改：${candidate.targetLabel}`);
    props = { ...props, executionControls: <button type="button" aria-label="团队配置">创作团队</button> };
    render();
    expect(button('团队配置')).toBeDefined();
    expect(elements(tree).some((element) => element.props['aria-label'] === '选择模型')).toBe(false);
  });

  it('减少动态或性能模式保留可用发送按钮，隐藏时暂停金属效果', () => {
    render(); writeInstruction('调整节奏');
    props = { ...props, theme: 'light', hidden: true };
    render();
    const metal = elements(tree).find((element) => element.props.className === 'ui-ai-input__send-metal');
    expect(metal?.props).toMatchObject({ theme: 'light', preset: 'silver', paused: true });
    expect(button('按要求修改当前文章').props.disabled).toBe(false);
    props = { ...props, hidden: false, performanceMode: true };
    render();
    expect(elements(tree).some((element) => element.props.className === 'ui-ai-input__send-metal')).toBe(false);
    expect(button('按要求修改当前文章').props.disabled).toBe(false);
    props = { ...props, performanceMode: false };
    motion.reduced = true;
    render();
    expect(elements(tree).some((element) => element.props.className === 'ui-ai-input__send-metal')).toBe(false);
    expect(button('按要求修改当前文章').props.disabled).toBe(false);
  });

  it('按当前文章和需求生成预览，明确采用后只写入草稿而不自动保存', async () => {
    render();
    expect(button('按要求修改当前文章').props.disabled).toBe(true);
    writeInstruction('  精简对白，保留结尾悬念  ');
    const event = { key: 'Enter', ctrlKey: true, metaKey: false, nativeEvent: { isComposing: false },
      preventDefault: vi.fn(), stopPropagation: vi.fn() };
    editor().onKeyDown!(event as unknown as KeyboardEvent<HTMLTextAreaElement>);
    await settle();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: 'article_generate', target: props.target, instruction: '精简对白，保留结尾悬念' },
    ]);
    expect(text(tree)).toContain(candidate.text);
    click('采用到草稿'); await settle();
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: 'article_generate', target: props.target, instruction: '精简对白，保留结尾悬念' },
      { type: 'article_apply', candidateId: candidate.id },
    ]);
    expect(text(tree)).not.toContain(candidate.text);
    expect(text(tree)).toContain('修改已进入草稿，请保存当前文章。');
  });

  it('切换文章后忽略旧文章迟到的生成结果', async () => {
    const reply = deferred<typeof candidate>();
    dispatch.mockImplementation(async (action) => action.type === 'article_generate' ? reply.promise : true);
    render(); writeInstruction('强化冲突'); click('按要求修改当前文章');
    props = { ...props, targetKey: 'article-b', targetLabel: '第2集 · 本集大纲', target: { kind: 'outline', episodeId: 'episode-b' } };
    render();
    reply.resolve(candidate); await settle();
    expect(editor().value).toBe('');
    expect(text(tree)).not.toContain(candidate.text);
    expect(text(tree)).not.toContain('采用到草稿');
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(['article_generate']);
  });

  it('停止后忽略同一篇文章尚未返回的旧候选', async () => {
    const reply = deferred<typeof candidate>();
    dispatch.mockImplementation(async (action) => action.type === 'article_generate' ? reply.promise : true);
    render(); writeInstruction('增强悬念'); click('按要求修改当前文章');
    click('停止修改文章'); await settle();
    reply.resolve(candidate); await settle();
    expect(text(tree)).not.toContain(candidate.text);
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(['article_generate', 'article_cancel']);
    expect(button('按要求修改当前文章').props.disabled).toBe(false);
  });

  it('切换文章时清空预览，旧采用回执不覆盖新文章的输入', async () => {
    const applied = deferred<boolean>();
    render(); writeInstruction('精简对白'); click('按要求修改当前文章'); await settle();
    dispatch.mockImplementation(async (action) => action.type === 'article_apply' ? applied.promise : true);
    click('采用到草稿');
    props = { ...props, targetKey: 'article-b', target: { kind: 'script', episodeId: 'episode-b' } };
    render();
    expect(editor().value).toBe('');
    expect(text(tree)).not.toContain(candidate.text);
    writeInstruction('新文章的修改要求');
    applied.resolve(true); await settle();
    expect(editor().value).toBe('新文章的修改要求');
    expect(text(tree)).not.toContain('修改已进入草稿，请保存当前文章。');
  });
});

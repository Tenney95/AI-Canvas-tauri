/** 原文编辑器回归：真实按钮与受控编辑回调的异步交接，文件及模型由受限 RPC 替身提供。 */
import type { ChangeEvent, ComponentProps, KeyboardEvent, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OriginalWritingAction, OriginalWritingDocument, OriginalWritingSummary } from '../../src/types/originalWriting';

const values: unknown[] = [];
const effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }> = [];
const pendingEffects: Array<() => void> = [];
let stateIndex = 0;
let effectIndex = 0;

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
  useId: () => {
    const index = stateIndex++;
    return values[index] ??= `original-writing-${index}`;
  },
  useMemo: <T,>(factory: () => T) => factory(),
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = effectIndex++;
    const previous = effects[index];
    if (previous && deps?.length === previous.deps?.length && deps?.every((dependency, i) => Object.is(dependency, previous.deps?.[i]))) return;
    pendingEffects.push(() => {
      previous?.cleanup?.();
      effects[index] = { deps, cleanup: effect() ?? undefined };
    });
  },
}));
vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>();
  return { ...actual, useT: () => actual.t };
});
vi.mock('../../src/services/seriesSourceService', () => ({ indexSeriesChapters: () => [] }));

import OriginalWritingEditor from '../../src/components/OriginalWritingEditor';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
type EditAction = Extract<OriginalWritingAction, { type: 'original_edit' }>;
let props: ComponentProps<typeof OriginalWritingEditor>;
let tree: unknown;
let hostDocument: OriginalWritingDocument;
let savedContent: string;
let frames: FrameRequestCallback[];
const dispatch = vi.fn<(action: OriginalWritingAction) => Promise<unknown>>();

function document(content = '原文', overrides: Partial<OriginalWritingDocument> = {}): OriginalWritingDocument {
  return { documentId: 'document-a', fileName: '原著.txt', content, revision: 0, acceptedSequence: 0, ...overrides };
}
function summary(): OriginalWritingSummary {
  return { loaded: true, loading: false, dirty: hostDocument.content !== savedContent, saving: false, generating: false,
    documentId: hostDocument.documentId, revision: hostDocument.revision, acceptedSequence: hostDocument.acceptedSequence,
    fileName: hostDocument.fileName, isNew: hostDocument.isNew, characterCount: hostDocument.content.length, chapterCount: 1, hasCandidate: !!hostDocument.candidate };
}
function publish() { props.summary = summary(); }
function replyToEdit(action: EditAction) {
  hostDocument = { ...hostDocument, content: action.handoff.content, acceptedSequence: action.handoff.sequence,
    revision: hostDocument.revision + 1 };
  publish();
  return structuredClone(hostDocument);
}
async function hostReply(action: OriginalWritingAction): Promise<unknown> {
  if (action.type === 'original_edit') return replyToEdit(action);
  if (action.type === 'original_save') { savedContent = hostDocument.content; hostDocument = { ...hostDocument, isNew: false }; publish(); }
  if (action.type === 'original_generate') {
    hostDocument = { ...hostDocument, candidate: { id: 'candidate-a', mode: action.mode, text: '，继续前行。',
      start: action.end, end: action.end, revision: hostDocument.revision } };
    publish();
  }
  if (action.type === 'original_apply') {
    const candidate = hostDocument.candidate!;
    hostDocument = { ...hostDocument, content: hostDocument.content.slice(0, candidate.start) + candidate.text + hostDocument.content.slice(candidate.end),
      revision: hostDocument.revision + 1, candidate: undefined };
    publish();
  }
  return structuredClone(hostDocument);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (node && typeof node === 'object' && 'props' in node) return text((node as Element).props.children);
  return '';
}
function button(label: string): Element {
  const found = elements(tree).find((element) => element.type === 'button' && text(element.props.children) === label);
  expect(found, `缺少按钮：${label}`).toBeDefined();
  return found!;
}
function editor(): ComponentProps<'textarea'> {
  const found = elements(tree).find((element) => element.type === 'textarea' && typeof element.props['aria-label'] === 'string'
    && (element.props['aria-label'] === '编辑整篇原文' || element.props['aria-label'].startsWith('编辑原文章节：')));
  expect(found).toBeDefined();
  return found!.props as ComponentProps<'textarea'>;
}
function status(): string {
  const found = elements(tree).find((element) => element.type === 'span' && element.props.role === 'status');
  expect(found, '缺少原文保存状态').toBeDefined();
  return text(found!.props.children);
}
function render() {
  stateIndex = effectIndex = 0;
  tree = OriginalWritingEditor(props);
  pendingEffects.splice(0).forEach((effect) => effect());
  frames.splice(0).forEach((frame) => frame(0));
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
function click(label: string) {
  const control = button(label);
  expect(control.props.disabled).not.toBe(true);
  (control.props.onClick as () => void)();
  render();
}
function change(value: string) { editor().onChange!({ target: { value } } as ChangeEvent<HTMLTextAreaElement>); render(); }
function writeInstruction(value: string) {
  const field = elements(tree).find((element) => element.type === 'textarea' && element.props.maxLength === 2000);
  expect(field, '缺少写作要求输入框').toBeDefined();
  (field!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  render();
}
function actions(type: OriginalWritingAction['type']) { return dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === type); }

beforeEach(() => {
  values.length = effects.length = pendingEffects.length = 0;
  frames = [];
  hostDocument = document();
  savedContent = hostDocument.content;
  dispatch.mockReset().mockImplementation(hostReply);
  props = { summary: summary(), dispatch, ready: true, active: true };
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
});
afterEach(() => {
  effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

describe('原文写作编辑与异步交接', () => {
  it('使用普通文本框保留原始文字，Ctrl+S 保存且原生撤销重做不被拦截', async () => {
    hostDocument = document('已有原文', { fileName: '导入的原文.md' });
    savedContent = hostDocument.content; publish();
    render(); await settle();
    expect(elements(tree).filter((element) => element.props.role === 'toolbar')).toHaveLength(0);
    expect(text(tree)).not.toContain('Markdown');
    expect(text(tree)).not.toContain('查找替换');
    expect(elements(tree).filter((element) => element.type === 'button').map((element) => text(element.props.children)))
      .not.toEqual(expect.arrayContaining(['编辑', '预览', '分栏']));
    const value = '# 这仍是原文\n**只是文字，不转换格式**';
    change(value); await settle();
    expect(editor().value).toBe(value);

    const saveEvent = { key: 's', ctrlKey: true, metaKey: false, defaultPrevented: false,
      nativeEvent: { isComposing: false, keyCode: 83 }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    editor().onKeyDown!(saveEvent as unknown as KeyboardEvent<HTMLTextAreaElement>);
    render(); await settle();
    expect(saveEvent.preventDefault).toHaveBeenCalledOnce();
    expect(saveEvent.stopPropagation).toHaveBeenCalledOnce();
    expect(actions('original_save')).toHaveLength(1);
    expect(savedContent).toBe(value);
    expect(status()).toContain('已保存');

    for (const key of ['z', 'y']) {
      const nativeEvent = { ...saveEvent, key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      editor().onKeyDown!(nativeEvent as unknown as KeyboardEvent<HTMLTextAreaElement>);
      expect(nativeEvent.preventDefault).not.toHaveBeenCalled();
      expect(nativeEvent.stopPropagation).not.toHaveBeenCalled();
    }
  });

  it('没有原文文件时展示可手写的空白草稿，首次保存后更新为已保存', async () => {
    hostDocument = document('', { fileName: '新原文.txt', isNew: true });
    savedContent = ''; publish();
    render(); await settle();
    expect(editor().value).toBe('');
    expect(editor().readOnly).toBe(false);
    expect(text(tree)).toContain('未保存的新原文');
    expect(text(tree)).toContain('从零起稿');
    expect(button('按要求起笔').props.disabled).toBe(true);

    change('第一章 雨夜\n快递员停在一扇陌生的门前。'); await settle();
    expect(actions('original_edit')).toEqual([{ type: 'original_edit', handoff: { documentId: 'document-a', sequence: 1, content: '第一章 雨夜\n快递员停在一扇陌生的门前。' } }]);
    expect(status()).toContain('新原文草稿');
    click('保存原文'); await settle();
    expect(actions('original_save')).toHaveLength(1);
    expect(editor().value).toBe('第一章 雨夜\n快递员停在一扇陌生的门前。');
    expect(status()).toContain('已保存');
    expect(text(tree)).not.toContain('未保存的新原文');
  });

  it('空白原文按写作要求生成开篇，明确采用后才进入新稿并可首次保存', async () => {
    hostDocument = document('', { fileName: '新原文.txt', isNew: true });
    savedContent = ''; publish();
    render(); await settle();
    writeInstruction('写一段雨夜快递员收到未来包裹的悬疑开场');
    click('按要求起笔'); await settle();
    expect(actions('original_generate')).toEqual([{ type: 'original_generate', mode: 'continue', start: 0, end: 0,
      instruction: '写一段雨夜快递员收到未来包裹的悬疑开场', expectedSequence: 0 }]);
    expect(editor().value).toBe('');
    expect(text(tree)).toContain('续写候选');
    expect(actions('original_apply')).toHaveLength(0);
    click('采用到原文草稿'); await settle();
    expect(editor().value).toBe('，继续前行。');
    expect(status()).toContain('新原文草稿');
    expect(actions('original_save')).toHaveLength(0);
    click('保存原文'); await settle();
    expect(editor().value).toBe('，继续前行。');
    expect(status()).toContain('已保存');
  });

  it('编辑稿保存完成前锁定输入，续写候选只有明确采用后才进入原文草稿', async () => {
    const saving = deferred<OriginalWritingDocument>();
    dispatch.mockImplementation((action) => action.type === 'original_save' ? saving.promise : hostReply(action));
    render(); await settle();
    expect(actions('original_open')).toHaveLength(1);
    expect(editor().value).toBe('原文');
    change('原文补写'); await settle();
    expect(actions('original_edit')).toEqual([{ type: 'original_edit', handoff: { documentId: 'document-a', sequence: 1, content: '原文补写' } }]);

    click('保存原文');
    expect(editor().readOnly).toBe(true);
    await settle();
    expect(actions('original_save')).toHaveLength(1);
    savedContent = hostDocument.content; publish();
    saving.resolve(structuredClone(hostDocument)); await settle();
    expect(editor().readOnly).toBe(false);
    expect(status()).toContain('已保存');

    click('从光标续写'); await settle();
    expect(actions('original_generate')).toEqual([expect.objectContaining({ type: 'original_generate', mode: 'continue', start: 4, end: 4, expectedSequence: 1 })]);
    expect(editor().value).toBe('原文补写');
    expect(actions('original_apply')).toHaveLength(0);
    expect(text(tree)).toContain('，继续前行。');
    click('采用到原文草稿'); await settle();
    expect(actions('original_apply')).toEqual([{ type: 'original_apply', candidateId: 'candidate-a' }]);
    expect(editor().value).toBe('原文补写，继续前行。');
    expect(status()).toContain('草稿未保存');
    expect(actions('original_save')).toHaveLength(1);
  });

  it('重新载入接受新的文档身份，后续编辑交接使用新 ID 和序号', async () => {
    dispatch.mockImplementation(async (action) => {
      if (action.type === 'original_reload') {
        hostDocument = document('磁盘新正文', { documentId: 'document-reloaded' });
        savedContent = hostDocument.content; publish();
        return structuredClone(hostDocument);
      }
      return hostReply(action);
    });
    render(); await settle();
    click('重新载入'); await settle();
    expect(editor().value).toBe('磁盘新正文');
    change('磁盘新正文之后的编辑'); await settle();
    expect(actions('original_edit')).toEqual([{ type: 'original_edit', handoff: { documentId: 'document-reloaded', sequence: 1, content: '磁盘新正文之后的编辑' } }]);
    expect(editor().value).toBe('磁盘新正文之后的编辑');
  });

  it('一次草稿同步失败后保留本地正文，保存会重传最新草稿再发起写入', async () => {
    let rejectFirstEdit = true;
    dispatch.mockImplementation(async (action) => {
      if (action.type === 'original_edit' && rejectFirstEdit) { rejectFirstEdit = false; throw new Error('连接暂时中断'); }
      return hostReply(action);
    });
    render(); await settle();
    change('失败后仍要保留的新稿'); await settle();
    expect(editor().value).toBe('失败后仍要保留的新稿');
    expect(text(tree)).toContain('连接暂时中断');
    click('保存原文'); await settle();
    expect(actions('original_edit')).toEqual([
      { type: 'original_edit', handoff: { documentId: 'document-a', sequence: 1, content: '失败后仍要保留的新稿' } },
      { type: 'original_edit', handoff: { documentId: 'document-a', sequence: 2, content: '失败后仍要保留的新稿' } },
    ]);
    const calls = dispatch.mock.calls.map(([action]) => action.type);
    expect(calls.slice(-2)).toEqual(['original_edit', 'original_save']);
    expect(editor().value).toBe('失败后仍要保留的新稿');
    expect(status()).toContain('已保存');
  });

  it('生成等待旧编辑同步时若又有新输入，拒绝使用旧偏移发起模型调用', async () => {
    const firstEdit = deferred<OriginalWritingDocument>();
    dispatch.mockImplementation((action) => {
      if (action.type === 'original_edit' && action.handoff.sequence === 1) return firstEdit.promise;
      return hostReply(action);
    });
    render(); await settle();
    change('等待同步的第一版');
    click('从光标续写');
    expect(editor().readOnly).toBe(false);
    change('等待期间继续输入的第二版'); await settle();
    firstEdit.resolve(document('等待同步的第一版', { revision: 1, acceptedSequence: 1 })); await settle();
    expect(actions('original_generate')).toHaveLength(0);
    expect(editor().value).toBe('等待期间继续输入的第二版');
    expect(text(tree)).toContain('原文已变化，请重新选择写作范围');
  });
});

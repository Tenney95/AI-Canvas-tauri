import { describe, expect, it, vi } from 'vitest';
import { MentionEditorHistory, restoreMentionEditorSnapshot, type MentionEditorSnapshot } from '../../src/components/nodes/shared/mentionEditorHistory';

function snapshot(prompt: string, markup = prompt, offset = prompt.length): MentionEditorSnapshot {
  return { prompt, markup, content: [], selection: { anchor: { path: [0], offset }, focus: { path: [0], offset } } };
}

describe('提示词临时历史', () => {
  it('连续输入合并，停顿、粘贴、换行与引用操作分别撤销和重做', () => {
    const history = new MentionEditorHistory();
    history.reset(snapshot('原文'));
    history.record(snapshot('原文一'), 'insertText', 100);
    history.record(snapshot('原文一二'), 'insertText', 200);
    history.record(snapshot('原文一二三'), 'insertText', 1000);
    history.record(snapshot('原文一二三\n粘贴 @{image:素材}'));
    expect(history.undo()?.prompt).toBe('原文一二三');
    expect(history.undo()?.prompt).toBe('原文一二');
    expect(history.undo()?.prompt).toBe('原文');
    expect(history.undo()).toBeUndefined();
    expect(history.redo()?.prompt).toBe('原文一二');
    expect(history.redo()?.prompt).toBe('原文一二三');
    expect(history.redo()?.prompt).toBe('原文一二三\n粘贴 @{image:素材}');
    expect(history.redo()).toBeUndefined();
  });

  it('移动光标后输入形成新步骤，保留撤销前的选区', () => {
    const history = new MentionEditorHistory();
    history.reset(snapshot('甲'));
    history.record(snapshot('甲乙'), 'insertText', 100);
    history.updateSelection(snapshot('甲乙', '甲乙', 0).selection);
    history.record(snapshot('丙甲乙', '丙甲乙', 1), 'insertText', 200);
    expect(history.undo()).toMatchObject({ prompt: '甲乙', selection: { anchor: { offset: 0 } } });
    expect(history.undo()?.prompt).toBe('甲');
  });

  it('失焦回写不丢失重做，撤销后新编辑清除旧分支', () => {
    const history = new MentionEditorHistory();
    history.reset(snapshot('原文'));
    history.record(snapshot('修改'));
    history.undo();
    history.record(snapshot('原文'));
    expect(history.redo()?.prompt).toBe('修改');
    history.undo();
    history.record(snapshot('新修改'));
    expect(history.redo()).toBeUndefined();
    expect(history.undo()?.prompt).toBe('原文');
  });

  it('正文序列化相同时仍可撤销末尾空行', () => {
    const history = new MentionEditorHistory();
    history.reset(snapshot('原文'));
    history.record(snapshot('原文', '原文<br><br>'));
    expect(history.undo()?.markup).toBe('原文');
    expect(history.redo()?.markup).toBe('原文<br><br>');
  });

  it('外部润色是独立步骤，标签编号刷新不增加步骤', () => {
    const history = new MentionEditorHistory();
    history.reset(snapshot('原文 @{image:素材}', '原文 chip(图1)'));
    history.refresh(snapshot('原文 @{image:素材}', '原文 chip(图2)'));
    expect(history.undo()).toBeUndefined();
    history.record(snapshot('润色后 @{image:素材}'));
    expect(history.undo()?.prompt).toBe('原文 @{image:素材}');
  });

  it('关闭清空，重新打开或切换节点只保留新基线', () => {
    const history = new MentionEditorHistory();
    history.reset(snapshot('原文'));
    history.record(snapshot('保存后的内容'));
    history.clear();
    expect(history.current).toBeUndefined();
    expect(history.undo()).toBeUndefined();
    expect(history.redo()).toBeUndefined();
    history.reset(snapshot('保存后的内容'));
    expect(history.undo()).toBeUndefined();
    history.reset(snapshot('另一个节点'));
    expect(history.redo()).toBeUndefined();
  });

  it('限制条目数与大块 DOM 的历史总量', () => {
    const history = new MentionEditorHistory();
    history.reset(snapshot('0'));
    for (let index = 1; index <= 150; index += 1) history.record(snapshot(String(index)));
    let count = 0;
    while (history.undo()) count += 1;
    expect(count).toBe(99);
    history.reset(snapshot('原文'));
    for (let index = 1; index <= 4; index += 1) history.record(snapshot(String(index), 'x'.repeat(1024 * 1024)));
    expect(history.undo()?.prompt).toBe('3');
    expect(history.undo()).toBeUndefined();
  });

  it('恢复工作流值区的完整 DOM 和反向选区，重新编辑不修改快照', () => {
    const focus = vi.fn();
    interface ValueDom {
      nodeType: number;
      childNodes: unknown[];
      closest: () => ValueDom;
      focus: typeof focus;
      cloneNode: () => ValueDom;
    }
    const makeValue = (): ValueDom => {
      const value: ValueDom = { nodeType: 1, childNodes: [], closest: () => value, focus, cloneNode: makeValue };
      value.childNodes = [{ nodeType: 3, textContent: '工作流正文', childNodes: [], parentElement: value }];
      return value;
    };
    const content = makeValue();
    const setBaseAndExtent = vi.fn();
    const root = {
      childNodes: [] as unknown[],
      replaceChildren(...children: unknown[]) { this.childNodes = children; },
      ownerDocument: { getSelection: () => ({ setBaseAndExtent }) },
      focus: vi.fn(),
    };
    const entry: MentionEditorSnapshot = {
      prompt: '@wf{57:27|提示词|prompt}(工作流正文)', markup: '', content: [content as unknown as Node],
      selection: { anchor: { path: [0, 0], offset: 4 }, focus: { path: [0, 0], offset: 1 } },
    };
    restoreMentionEditorSnapshot(root as unknown as HTMLElement, entry);
    const restored = root.childNodes[0] as ReturnType<typeof makeValue>;
    expect(restored).not.toBe(content);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(setBaseAndExtent).toHaveBeenCalledWith(restored.childNodes[0], 4, restored.childNodes[0], 1);
    (restored.childNodes[0] as { textContent: string }).textContent = '重新编辑';
    expect((content.childNodes[0] as { textContent: string }).textContent).toBe('工作流正文');
  });
});

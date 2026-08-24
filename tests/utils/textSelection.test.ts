import { describe, expect, it } from 'vitest';
import { isEditableTarget } from '../../src/utils/textSelection';

/** 只读 tagName / isContentEditable，用最小桩对象即可，无需 DOM 环境 */
const el = (tagName: string, isContentEditable = false, contentEditable = 'inherit') =>
  ({ tagName, isContentEditable, contentEditable }) as unknown as EventTarget;

describe('isEditableTarget', () => {
  it('识别输入框', () => {
    expect(isEditableTarget(el('INPUT'))).toBe(true);
    expect(isEditableTarget(el('TEXTAREA'))).toBe(true);
  });

  it('识别 contenteditable 宿主', () => {
    expect(isEditableTarget(el('DIV', true, 'true'))).toBe(true);
  });

  // 回归：提示词编辑器里的行/子元素 contentEditable 是 'inherit'，
  // 旧写法 contentEditable === 'true' 会漏判，导致剪切的文字被粘成新节点
  it('识别继承可编辑性的子元素', () => {
    expect(isEditableTarget(el('DIV', true, 'inherit'))).toBe(true);
  });

  it('普通元素与空目标不算可编辑', () => {
    expect(isEditableTarget(el('DIV'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
  });
});

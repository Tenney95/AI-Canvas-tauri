import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../../src/i18n';
import {
  getPromptSubmitShortcutHint,
  normalizePromptSubmitShortcut,
  PROMPT_SUBMIT_SHORTCUT_OPTIONS,
  resolvePromptEnterAction,
} from '../../src/utils/promptSubmitShortcut';

const enter = { key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
afterEach(() => setLocale('zh-CN'));

describe('节点发送快捷键', () => {
  it('旧配置和非法值保持 Shift+Enter 默认值', () => {
    expect(normalizePromptSubmitShortcut(undefined)).toBe('shift-enter');
    expect(normalizePromptSubmitShortcut('meta-enter')).toBe('shift-enter');
    expect(normalizePromptSubmitShortcut(undefined, 'enter')).toBe('enter');
  });

  it.each(PROMPT_SUBMIT_SHORTCUT_OPTIONS)('$label 只在精确匹配修饰键时发送', ({ value }) => {
    const event = { ...enter, shiftKey: value === 'shift-enter', ctrlKey: value === 'ctrl-enter', altKey: value === 'alt-enter' };
    expect(resolvePromptEnterAction(event, value)).toBe('submit');
    expect(resolvePromptEnterAction({ ...event, metaKey: true }, value)).toBe('ignore');
    expect(resolvePromptEnterAction({ ...event, isComposing: true }, value)).toBe('ignore');
    expect(resolvePromptEnterAction({ ...event, keyCode: 229 }, value)).toBe('ignore');
    const extra = value === 'shift-enter' ? { ctrlKey: true } : { shiftKey: true };
    expect(resolvePromptEnterAction({ ...event, ...extra }, value)).not.toBe('submit');
  });

  it.each(PROMPT_SUBMIT_SHORTCUT_OPTIONS)('$label 模式下 @ 选择优先于发送', ({ value }) => {
    expect(resolvePromptEnterAction(enter, value, true)).toBe('mention');
  });

  it('Enter 发送时 Shift+Enter 换行，其他发送方式保留 Enter 和 Shift+Enter 换行', () => {
    expect(resolvePromptEnterAction({ ...enter, shiftKey: true }, 'enter')).toBe('newline');
    for (const shortcut of ['shift-enter', 'ctrl-enter', 'alt-enter'] as const) {
      expect(resolvePromptEnterAction(enter, shortcut)).toBe('newline');
    }
    expect(resolvePromptEnterAction({ ...enter, shiftKey: true }, 'ctrl-enter')).toBe('newline');
    expect(resolvePromptEnterAction({ ...enter, shiftKey: true }, 'alt-enter')).toBe('newline');
    expect(resolvePromptEnterAction({ ...enter, key: 'Escape' }, 'enter')).toBe('ignore');
  });

  it('输入提示跟随发送和换行方式切换，并沿用当前语言', () => {
    setLocale('zh-CN');
    expect(getPromptSubmitShortcutHint('enter')).toBe('(Shift+Enter 换行，Enter 发送)');
    expect(getPromptSubmitShortcutHint('ctrl-enter')).toBe('(Enter 换行，Ctrl+Enter 发送)');
    for (const locale of ['en-US', 'ja-JP', 'ko-KR'] as const) {
      setLocale(locale);
      expect(getPromptSubmitShortcutHint('alt-enter')).toContain('Alt+Enter');
      expect(getPromptSubmitShortcutHint('alt-enter')).not.toContain('发送');
    }
  });
});

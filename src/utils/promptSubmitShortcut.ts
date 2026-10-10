import type { PromptSubmitShortcut } from '../types';
import { t } from '../i18n';

export const PROMPT_SUBMIT_SHORTCUT_OPTIONS: Array<{ value: PromptSubmitShortcut; label: string }> = [
  { value: 'enter', label: 'Enter' },
  { value: 'shift-enter', label: 'Shift+Enter' },
  { value: 'ctrl-enter', label: 'Ctrl+Enter' },
  { value: 'alt-enter', label: 'Alt+Enter' },
];

export function normalizePromptSubmitShortcut(value: unknown, fallback: PromptSubmitShortcut = 'shift-enter'): PromptSubmitShortcut {
  return PROMPT_SUBMIT_SHORTCUT_OPTIONS.find((option) => option.value === value)?.value ?? fallback;
}

export function getPromptSubmitShortcutHint(shortcut: PromptSubmitShortcut): string {
  return t('({newline} 换行，{submit} 发送)', {
    newline: shortcut === 'enter' ? 'Shift+Enter' : 'Enter',
    submit: PROMPT_SUBMIT_SHORTCUT_OPTIONS.find((option) => option.value === shortcut)!.label,
  });
}

type EnterEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'> & {
  isComposing?: boolean;
  keyCode?: number;
};

/** 精确匹配修饰键；输入法确认及 @ 选中优先于生成。 */
export function resolvePromptEnterAction(event: EnterEvent, shortcut: PromptSubmitShortcut, mentionOpen = false): 'submit' | 'newline' | 'mention' | 'ignore' {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return 'ignore';
  const plain = !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
  if (mentionOpen && plain) return 'mention';
  if (!event.metaKey
    && event.shiftKey === (shortcut === 'shift-enter')
    && event.ctrlKey === (shortcut === 'ctrl-enter')
    && event.altKey === (shortcut === 'alt-enter')) return 'submit';
  return plain || (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) ? 'newline' : 'ignore';
}

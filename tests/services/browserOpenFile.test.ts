/** 浏览器文件选择的成功、取消与焦点回退都必须只清理一次。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { browserOpenFile } from '../../src/services/fs/core';

class Input extends EventTarget {
  files: File[] = [];
  click = vi.fn();
  remove = vi.fn();
}
let input: Input;
let browser: EventTarget;
beforeEach(() => {
  vi.useFakeTimers();
  input = new Input(); browser = new EventTarget();
  vi.stubGlobal('document', { createElement: () => input, body: { appendChild: vi.fn() } });
  vi.stubGlobal('window', browser);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('change 成功后清除焦点回退，不重复 remove', async () => {
  const task = browserOpenFile('.txt');
  browser.dispatchEvent(new Event('focus'));
  input.files = [new File(['content'], 'note.txt')];
  input.dispatchEvent(new Event('change'));
  await expect(task).resolves.toBe(input.files[0]);
  await vi.runAllTimersAsync();
  expect(input.remove).toHaveBeenCalledOnce();
});

it.each(['cancel', 'focus'])('%s 取消返回 null 并清理监听器', async (event) => {
  const task = browserOpenFile('*/*');
  (event === 'focus' ? browser : input).dispatchEvent(new Event(event));
  await vi.runAllTimersAsync();
  await expect(task).resolves.toBeNull();
  browser.dispatchEvent(new Event('focus'));
  input.dispatchEvent(new Event('change'));
  await vi.runAllTimersAsync();
  expect(input.remove).toHaveBeenCalledOnce();
});

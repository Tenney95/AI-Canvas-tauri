import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const manualFile = new URL('../../site/manual.html', import.meta.url);

it('离线手册从单个 HTML 加载交互脚本，内容与维护源一致', () => {
  const html = readFileSync(manualFile, 'utf8');
  expect(html.match(/<script\b[^>]*>/gi)).toEqual(['<script id="manual-interactions">']);
  const generator = fileURLToPath(new URL('../../scripts/sync-site-manual.mjs', import.meta.url));
  execFileSync(process.execPath, [generator, '--check']);
});

it('离线手册重复复制时保留最新反馈并恢复原按钮文案', async () => {
  vi.useFakeTimers();
  try {
    const html = readFileSync(manualFile, 'utf8');
    const [, script] = html.match(/<script id="manual-interactions">([\s\S]*?)<\/script>/);
    const example = { textContent: '第一行\n第二行' };
    const button = { textContent: '复制', dataset: { copy: 'example' }, addEventListener: vi.fn() };
    const element = { addEventListener() {}, setAttribute() {}, value: '' };
    const writeText = vi.fn().mockResolvedValue(undefined);
    const range = { selectNodeContents: vi.fn() };
    const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
    runInNewContext(script, {
      document: {
        documentElement: { dataset: {} },
        querySelectorAll: selector => selector === '.copy' ? [button] : [],
        querySelector: () => ({ classList: { toggle() {} } }),
        getElementById: id => id === 'example' ? example : id ? element : null,
        createRange: () => range,
      },
      window: { matchMedia: () => ({ matches: false }), addEventListener() {}, getSelection: () => selection },
      navigator: { clipboard: { writeText } },
      location: { hash: '' },
      URL,
      setTimeout,
      clearTimeout,
    });
    const [, click] = button.addEventListener.mock.calls[0];

    await click();
    vi.advanceTimersByTime(2000);
    await click();
    expect(writeText.mock.calls).toEqual([[example.textContent], [example.textContent]]);
    vi.advanceTimersByTime(500);
    expect(button.textContent).toBe('已复制');
    vi.advanceTimersByTime(2000);
    expect(button.textContent).toBe('复制');

    let finishEarlierCopy;
    writeText.mockReturnValueOnce(new Promise(resolve => { finishEarlierCopy = resolve; }));
    const earlierClick = click();
    writeText.mockRejectedValueOnce(new Error('Clipboard permission denied'));
    await click();
    expect(button.textContent).toBe('已选中，请 Ctrl+C');
    expect(range.selectNodeContents).toHaveBeenCalledWith(example);
    expect(selection.addRange).toHaveBeenCalledWith(range);
    finishEarlierCopy();
    await earlierClick;
    expect(button.textContent).toBe('已选中，请 Ctrl+C');
    vi.advanceTimersByTime(2500);
    expect(button.textContent).toBe('复制');
  } finally {
    vi.useRealTimers();
  }
});

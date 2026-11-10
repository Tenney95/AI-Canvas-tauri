import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../src-tauri/src/media/muse/page.js', import.meta.url), 'utf8');
const prompt = 'fixture-private-user-prompt';
interface Snapshot {
  thread: string; sent: boolean; refused: boolean; src: string; kind: string;
  deliveryPending: boolean; deliveryConfirmed: boolean; textConflict: boolean;
  textSize?: number; textComplete?: boolean; textUnavailable?: boolean;
}
interface Adapter {
  prepare(prompt: string, images: string[], kind: string): Promise<{ ready: boolean }>;
  send(): Promise<{ sent: boolean; thread: string }>;
  snapshot(): Snapshot;
  textSnapshot(expectedThread?: string): Snapshot;
}
const bubble = (role: 'user' | 'assistant', text: string) => ({
  className: `hatch-chat-groupable-bubble ${role === 'user' ? 'chat-user-bubble' : 'hatch-agent-bubble-bg'}`,
  innerText: text, parentElement: null,
});
const button = (label = 'Send message', text = '', testId = '', onClick?: () => void) => {
  const attributes: Record<string, string> = { 'aria-label': label, 'data-testid': testId };
  return { disabled: false, innerText: text, getClientRects: () => [{}],
    getAttribute: (name: string) => attributes[name] ?? null, click: vi.fn(() => onClick?.()) };
};

function page(options: { uploadAvailable?: boolean; readOnlyFiles?: boolean; ignoreFileSelection?: boolean; failUploadDispatch?: boolean } = {}) {
  const messages: ReturnType<typeof bubble>[] = [];
  const buttons: ReturnType<typeof button>[] = [];
  const media: Array<{ tagName: string; currentSrc: string; src: string; closest: () => null; querySelector: () => null }> = [];
  const state = { stop: false, bodyText: '', onInput: (_type: string) => {} };
  class ReferenceFile {
    readonly bytes: Uint8Array;
    readonly type: string;
    name: string;
    constructor(parts: Uint8Array[], name: string, options: { type: string }) {
      this.name = name;
      this.bytes = Uint8Array.from(parts.flatMap((part) => Array.from(part)));
      this.type = options.type;
    }
    get size() { return this.bytes.length; }
  }
  class Transfer {
    readonly files: ReferenceFile[] = [];
    readonly items = { add: (file: ReferenceFile) => { this.files.push(file); } };
  }
  let selectedFiles: ReferenceFile[] = [];
  const uploadButtons: Array<{ closest: () => null; getAttribute: (name: string) => string | null }> = [];
  const inputFile = {
    get files() { return selectedFiles; },
    set files(files: ReferenceFile[]) {
      if (options.readOnlyFiles) throw new TypeError('fixture-private-file-selection-error');
      if (!options.ignoreFileSelection) selectedFiles = [...files];
    },
    dispatchEvent: vi.fn((event: { type: string }) => {
      if (options.failUploadDispatch) throw new Error('fixture-private-file-dispatch-error');
      if (event.type === 'change') {
        uploadButtons.splice(0, uploadButtons.length, ...selectedFiles.map(() => ({
          closest: () => null, getAttribute: (name: string) => name === 'aria-label' ? 'Remove attachment' : null,
        })));
      }
      return true;
    }),
  };
  const form = { querySelectorAll: () => uploadButtons,
    querySelector: (selector: string) => selector === 'input[type="file"]' && options.uploadAvailable !== false ? inputFile : null };
  const fetch = vi.fn(async (_url: unknown) => { throw new TypeError('fixture CSP blocks data URL fetch'); });
  const decodeBase64 = vi.fn((value: string) => globalThis.atob(value));
  class Textarea {
    private text = '';
    disabled = false;
    get value() { return this.text; }
    set value(value: string) { this.text = value; }
    closest = () => form;
    focus = vi.fn();
    scrollIntoView = vi.fn();
    dispatchEvent = vi.fn((event: { type: string }) => { state.onInput(event.type); });
  }
  const textarea = new Textarea();
  const location = { pathname: '/thread/new', href: 'https://muse.ai/thread/new', origin: 'https://muse.ai' };
  const window: { __aiCanvasMuseAdapter?: Adapter; __aiCanvasMuse?: { sent: boolean };
    __aiCanvasMuseText?: { text: string; revision: number } } = {};
  const document = {
    readyState: 'complete',
    body: { get innerText() { return state.bodyText; }, querySelectorAll: () => [] },
    querySelector: (selector: string) => {
      if (selector === 'textarea') return textarea;
      if (selector.includes('hatch-composer-stop-button')) return state.stop ? {} : null;
      return null;
    },
    querySelectorAll: (selector: string) => {
      if (selector === 'div[class*="hatch-chat-groupable-bubble"]') return messages;
      if (selector === 'button,[role="button"]') return buttons;
      if (selector === '[data-testid^="hatch-chat-attachment-presentation-"]') return media;
      return [];
    },
  };
  runInNewContext(source, { window, document, location, HTMLTextAreaElement: Textarea,
    Event: class { type: string; constructor(type: string) { this.type = type; } }, Date, setTimeout, TextEncoder, URL,
    DataTransfer: Transfer, File: ReferenceFile, atob: decodeBase64, fetch,
    getComputedStyle: () => ({ overflowY: 'visible' }) });
  const accept = (text = '', reply = '') => {
    textarea.value = '';
    location.pathname = '/thread/fixture-thread';
    location.href = `https://muse.ai${location.pathname}`;
    messages.push(bubble('user', `${prompt}${text ? `\n${text}` : ''}`));
    if (reply) messages.push(bubble('assistant', reply));
  };
  return { adapter: window.__aiCanvasMuseAdapter!, window, messages, buttons, media, state, textarea, location, accept,
    inputFile, fetch, decodeBase64 };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe('Muse page adapter reference preparation', () => {
  it('decodes references locally despite data-fetch CSP and preserves bytes, MIME, order and file-input events without clicking', async () => {
    const h = page(), send = button();
    h.buttons.push(send);
    const references = [
      { type: 'image/png', bytes: [137, 80, 78, 71, 13, 10, 26, 10, 0, 255] },
      { type: 'image/jpeg', bytes: [255, 216, 255, 0, 128, 1] },
    ];
    const dataUrls = references.map((item) => `data:${item.type};base64,${Buffer.from(item.bytes).toString('base64')}`);
    await expect(h.adapter.prepare(prompt, dataUrls, 'video')).resolves.toEqual({ ready: true });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.decodeBase64).toHaveBeenCalledTimes(2);
    expect(h.inputFile.files.map((file) => ({ name: file.name, type: file.type, bytes: Array.from(file.bytes) })))
      .toEqual(references.map((item, index) => ({ name: `reference-${index + 1}.${index ? 'jpg' : 'png'}`, ...item })));
    expect(h.inputFile.dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual(['input', 'change']);
    expect(h.textarea.value).toBe(prompt);
    expect(send.click).not.toHaveBeenCalled();
    expect(h.window.__aiCanvasMuse?.sent).toBe(false);
  });

  it.each([
    'data:image/png;base64,%%%',
    'data:image/png;base64,A',
    'data:image/png;base64,',
    'data:text/plain;base64,WA==',
  ])('classifies malformed or unsupported reference data without dispatch or sending: %s', async (dataUrl) => {
    const h = page(), send = button();
    h.buttons.push(send);
    await expect(h.adapter.prepare(prompt, [dataUrl], 'image')).rejects.toThrow('upload-data');
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.inputFile.dispatchEvent).not.toHaveBeenCalled();
    expect(h.textarea.value).toBe('');
    expect(send.click).not.toHaveBeenCalled();
  });

  it.each([
    { options: { uploadAvailable: false }, code: 'upload-unavailable' },
    { options: { readOnlyFiles: true }, code: 'upload-selection' },
    { options: { ignoreFileSelection: true }, code: 'upload-selection' },
    { options: { failUploadDispatch: true }, code: 'upload-dispatch' },
  ])('classifies unavailable or rejected file-input preparation as $code and never clicks', async ({ options, code }) => {
    const h = page(options), send = button();
    h.buttons.push(send);
    await expect(h.adapter.prepare(prompt, ['data:image/png;base64,iVBORw0KGgo='], 'video')).rejects.toThrow(code);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.textarea.value).toBe('');
    expect(send.click).not.toHaveBeenCalled();
    expect(h.window.__aiCanvasMuse).toBeUndefined();
  });
});

describe('Muse page adapter delivery', () => {
  it('waits for a Send button rendered after 150ms, focuses the composer, and never sends during prepare', async () => {
    const h = page();
    const feedback = button('Send feedback', 'Send');
    const resend = button('Resend message');
    const send = button('', '发送');
    h.buttons.push(feedback, resend);
    h.state.onInput = (type) => { if (type === 'input') setTimeout(() => h.buttons.push(send), 600); };
    let prepared = false;
    const preparing = h.adapter.prepare(prompt, [], 'video').then(() => { prepared = true; });
    await vi.advanceTimersByTimeAsync(500);
    expect(prepared).toBe(false);
    expect(h.textarea.value).toBe(prompt);
    expect(h.textarea.focus).toHaveBeenCalledOnce();
    expect(h.textarea.scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
    await vi.advanceTimersByTimeAsync(200);
    await preparing;
    expect(h.textarea.dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual(['input', 'change']);
    for (const candidate of [feedback, resend, send]) expect(candidate.click).not.toHaveBeenCalled();
    expect(h.window.__aiCanvasMuse?.sent).toBe(false);
  });

  it('does not confirm a click without a new message and never clicks again after timeout', async () => {
    const h = page(), send = button();
    h.buttons.push(send);
    await h.adapter.prepare(prompt, [], 'video');
    const sending = expect(h.adapter.send()).rejects.toThrow('send-unconfirmed');
    await vi.advanceTimersByTimeAsync(15_000);
    await sending;
    expect(send.click).toHaveBeenCalledOnce();
    expect(h.adapter.snapshot()).toMatchObject({ sent: true, deliveryConfirmed: false, refused: false });
    await expect(h.adapter.send()).rejects.toThrow('send-unavailable');
    expect(send.click).toHaveBeenCalledOnce();
  });

  it('confirms one click only after a late user message clears its delivery warning', async () => {
    const h = page();
    const send = button('', '', 'hatch-composer-send-button', () => {
      setTimeout(() => h.accept('Still sending'), 9000);
      setTimeout(() => { h.messages[0].innerText = prompt; }, 11_000);
    });
    h.buttons.push(send);
    h.state.bodyText = 'Delivery not confirmed'; // Unrelated page chrome must not decide this turn.
    await h.adapter.prepare(prompt, [], 'video');
    let confirmed = false;
    const sending = h.adapter.send().then((result) => { confirmed = true; return result; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(confirmed).toBe(false);
    expect(h.adapter.snapshot()).toMatchObject({ deliveryPending: true, deliveryConfirmed: false });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(sending).resolves.toEqual({ sent: true, thread: '/thread/fixture-thread' });
    expect(send.click).toHaveBeenCalledOnce();
    expect(h.adapter.snapshot()).toMatchObject({ deliveryPending: false, deliveryConfirmed: true });
  });

  it('does not treat an empty composer and a local user bubble on /thread/new as confirmed delivery', async () => {
    const h = page();
    const send = button('Send', '', '', () => { h.textarea.value = ''; h.messages.push(bubble('user', prompt)); });
    h.buttons.push(send);
    await h.adapter.prepare(prompt, [], 'video');
    const sending = expect(h.adapter.send()).rejects.toThrow('send-unconfirmed');
    await vi.advanceTimersByTimeAsync(15_000);
    await sending;
    expect(send.click).toHaveBeenCalledOnce();
  });
});

describe('Muse page adapter turn boundaries', () => {
  it.each([
    '我无法保证视频生成一定符合所有要求，正在生成视频，请稍候。',
    "I can't guarantee the generated video will meet every preference.",
    '无法生成图片预览，视频正在生成。',
    '视频已生成，等待附件加载。',
  ])('does not mistake a progress report or limitation for refusal: %s', async (text) => {
    const h = page();
    h.accept('', text);
    h.adapter.snapshot();
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.adapter.snapshot()).toMatchObject({ deliveryConfirmed: true, refused: false });
  });

  it('requires the same current-turn refusal to stay idle for three seconds, including after a restored page', async () => {
    const h = page();
    h.accept('', '视频没生成成功：该地区目前不支持视频生成。');
    expect(h.window.__aiCanvasMuse).toBeUndefined();
    expect(h.adapter.snapshot().refused).toBe(false);
    await vi.advanceTimersByTimeAsync(2999);
    expect(h.adapter.snapshot().refused).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.adapter.snapshot().refused).toBe(true);
    h.messages[1].innerText = '我无法生成视频。';
    expect(h.adapter.snapshot().refused).toBe(false);
    h.state.stop = true;
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.adapter.snapshot().refused).toBe(false);
  });

  it('ignores assistant text before the user and refuses to attribute a conversation with extra turns', async () => {
    const h = page();
    h.messages.push(bubble('assistant', '我无法生成视频。'));
    h.adapter.snapshot();
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.adapter.snapshot().refused).toBe(false);
    h.accept('', '视频正在生成，请稍候。');
    h.adapter.snapshot();
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.adapter.snapshot().refused).toBe(false);
    h.messages.push(bubble('user', 'a second unrelated turn'), bubble('assistant', '我无法生成视频。'));
    expect(h.adapter.snapshot()).toMatchObject({ textConflict: true, deliveryConfirmed: false, refused: false });
    expect(h.adapter.textSnapshot().textConflict).toBe(true);
  });

  it('keeps text completion metadata and attachment baselines without leaking prompt, reply or upload contents', async () => {
    const h = page();
    const inputSource = 'blob:https://muse.ai/fixture-private-upload';
    const reply = 'fixture-private-assistant-answer';
    h.media.push({ tagName: 'VIDEO', currentSrc: inputSource, src: inputSource, closest: () => null, querySelector: () => null });
    h.buttons.push(button());
    await h.adapter.prepare(prompt, [], 'video');
    h.accept('', reply);
    expect(h.adapter.textSnapshot().textComplete).toBe(false);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      h.adapter.textSnapshot();
    }
    expect(h.adapter.textSnapshot()).toMatchObject({ textComplete: true, textSize: new TextEncoder().encode(reply).length });
    expect(h.adapter.snapshot().src).toBe('');
    const publicMetadata = JSON.stringify([h.adapter.snapshot(), h.adapter.textSnapshot()]);
    for (const privateValue of [prompt, reply, inputSource]) expect(publicMetadata).not.toContain(privateValue);
  });

  it('preserves the last text partial when virtualization hides its user boundary without claiming completion', () => {
    const h = page();
    h.accept('', 'fixture-private-partial');
    h.adapter.textSnapshot();
    const partial = h.window.__aiCanvasMuseText;
    h.messages.splice(0, 1);
    expect(h.adapter.textSnapshot()).toMatchObject({ textUnavailable: true, deliveryConfirmed: false });
    expect(h.adapter.textSnapshot('/thread/some-other-task').textUnavailable).toBe(true);
    expect(h.adapter.textSnapshot().textComplete).not.toBe(true);
    expect(h.window.__aiCanvasMuseText).toBe(partial);
    expect(JSON.stringify(h.adapter.textSnapshot())).not.toContain('fixture-private-partial');
    h.messages.length = 0;
    expect(h.adapter.textSnapshot('/thread/fixture-thread').textUnavailable).toBe(true);
    expect(h.window.__aiCanvasMuseText).toBe(partial);
  });

  it('continues a virtualized text answer only with the exact durable thread binding', async () => {
    const h = page(), reply = 'fixture-private-long-answer';
    h.accept('', reply);
    h.messages.splice(0, 1);
    expect(h.adapter.textSnapshot('/thread/new').textUnavailable).toBe(true);
    expect(h.adapter.textSnapshot('/thread/fixture-thread')).toMatchObject({
      deliveryConfirmed: false, textSize: new TextEncoder().encode(reply).length, textComplete: false,
    });
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      h.adapter.textSnapshot('/thread/fixture-thread');
    }
    expect(h.adapter.textSnapshot('/thread/fixture-thread').textComplete).toBe(true);
    expect(JSON.stringify(h.adapter.textSnapshot('/thread/fixture-thread'))).not.toContain(reply);
    h.messages.push(bubble('user', 'a later user'), bubble('user', 'another user'));
    expect(h.adapter.textSnapshot('/thread/fixture-thread').textConflict).toBe(true);
  });
});

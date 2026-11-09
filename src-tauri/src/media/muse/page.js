/* Muse page adapter. DOM selectors were studied from https://github.com/czg86389-hub/muse2api
 * Copyright (c) 2026 MUSE2API Authors, MIT License (see muse2api-LICENSE.txt).
 * This is a webpage adapter, not a public Muse API.
 * This file has no Tauri IPC or filesystem access. Page replies remain untrusted data. */
(() => {
  const bubbles = () => [...document.querySelectorAll('div[class*="hatch-chat-groupable-bubble"]')];
  const assistants = () => bubbles().filter(el => /hatch-agent-bubble-bg/.test(el.className || ''));
  const users = () => bubbles().filter(el => /chat-user-bubble/.test(el.className || ''));
  const visible = el => !!el && el.getClientRects().length > 0;
  const composer = () => document.querySelector('textarea');
  const scope = () => {
    const ta = composer();
    if (!ta) return null;
    return ta.closest('form') || ta.parentElement?.parentElement?.parentElement?.parentElement;
  };
  const sendButton = () => [...document.querySelectorAll('button,[role="button"]')]
    .find(el => visible(el) && /发送|send/i.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-testid') || ''}`));
  const attachments = () => {
    const results = [];
    const seen = new Set();
    const candidates = [...document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]'),
      ...document.querySelectorAll('div[class*="hatch-agent-bubble-bg"] img,div[class*="hatch-agent-bubble-bg"] video')];
    for (const el of candidates) {
      if (el.closest('form,[class*="chat-user-bubble"],[class*="group/msg"]')) continue;
      const video = el.tagName === 'VIDEO' ? el : el.querySelector('video');
      const image = el.tagName === 'IMG' ? el : el.querySelector('img');
      const media = video || image;
      const src = media?.currentSrc || media?.src || '';
      if (!src || seen.has(src) || /avatar|emoji/.test(src)) continue;
      seen.add(src);
      results.push({ src, kind: video ? 'video' : 'image' });
    }
    return results;
  };
  const uploaded = () => [...(scope()?.querySelectorAll('button[aria-label]') || [])]
    .filter(el => !el.closest('[class*="chat-user-bubble"],[class*="hatch-agent-bubble-bg"]')
      && /remove\s*attachment|移除附件|删除附件/i.test(el.getAttribute('aria-label') || '')).length;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ready = () => {
    const hydration = document.querySelector('[data-hatch-shell-hydration-state]');
    return document.readyState === 'complete' && composer() && !composer().disabled
      && (!hydration || hydration.getAttribute('data-hatch-shell-hydration-state') === 'hydrated')
      && !/Connecting\.\.\./.test(document.body?.innerText || '');
  };
  const snapshot = () => {
    if (!document.body) return { loading: true };
    // Muse virtualizes the chat: the latest attachment may not exist in DOM until scrolled.
    const root = document.querySelector('main,[class*="chat-scroll"],[class*="hatch-chat-scroll"]') || document.body;
    const scroll = [...root.querySelectorAll('*')].filter(el => {
      const overflow = getComputedStyle(el).overflowY;
      return (overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 100;
    }).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
    composer()?.scrollIntoView({ block: 'end' });
    const list = assistants();
    const last = list.at(-1);
    const text = (last?.innerText || '').trim();
    const stop = !!document.querySelector('[data-testid="hatch-composer-stop-button"],button[aria-label*="Stop" i],button[aria-label*="停止"]');
    const baseline = window.__aiCanvasMuse?.baseline || [];
    const kind = window.__aiCanvasMuse?.kind;
    const result = attachments().filter(item => !baseline.includes(item.src) && (!kind || item.kind === kind)).at(-1);
    const refusal = /(?:无法|不能|不支持).{0,24}(?:生成|视频|图像|图片)|(?:cannot|can't|unable to).{0,40}(?:generate|create)|额度不足|积分不足|out of credits|token limit/i.test(text);
    return { thread: location.pathname, stop, agentCount: list.length, userCount: users().length,
      src: result?.src || '', kind: result?.kind || '', refused: !stop && refusal,
      ready: !!ready(), sent: !!window.__aiCanvasMuse?.sent };
  };
  const textSnapshot = () => {
    const page = snapshot();
    if (page.loading) return page;
    const metadata = { thread: page.thread, stop: page.stop, agentCount: page.agentCount,
      userCount: page.userCount, ready: page.ready, sent: page.sent };
    const all = bubbles().filter(el => !el.parentElement?.closest('div[class*="hatch-chat-groupable-bubble"]'));
    const userIndexes = all.flatMap((el, index) => /chat-user-bubble/.test(el.className || '') ? [index] : []);
    // Each native task starts from an empty thread and sends one user turn only.
    // A manually added turn must not be mistaken for this task's answer.
    if (userIndexes.length > 1) return { ...metadata, textConflict: true };
    const firstAssistant = userIndexes.length ? userIndexes[0] + 1 : 0;
    const text = all.slice(firstAssistant)
      .filter(el => /hatch-agent-bubble-bg/.test(el.className || ''))
      .map(el => (el.innerText || '').trim()).filter(Boolean).join('\n\n');
    if (text.length > 262144) return { ...metadata, textOverflow: true };
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > 262144) return { ...metadata, textOverflow: true };
    const old = window.__aiCanvasMuseText;
    const now = Date.now();
    const changed = !old || old.text !== text;
    const next = {
      text, bytes,
      revision: changed ? (old?.revision || 0) + 1 : old.revision,
      changedAt: changed ? now : old.changedAt,
      stable: changed || metadata.stop ? 0 : (old?.stable || 0) + 1,
    };
    window.__aiCanvasMuseText = next;
    // Quiet text while Stop remains visible is still a running model request.
    const complete = !!text && !metadata.stop && next.stable >= 3 && now - next.changedAt >= 3000;
    return { ...metadata, textSize: bytes.length, textRevision: next.revision, textComplete: complete };
  };
  window.__aiCanvasMuseAdapter = {
    snapshot,
    textSnapshot,
    textChunk(revision, offset, length) {
      const state = window.__aiCanvasMuseText;
      if (!state || state.revision !== revision || !Number.isInteger(offset) || offset < 0
        || !Number.isInteger(length) || length < 0 || length > 32768) throw new Error('text-chunk');
      return { chunk: btoa(String.fromCharCode(...state.bytes.subarray(offset, offset + length))) };
    },
    async prepare(prompt, images, kind) {
      const limit = Date.now() + 45000;
      while (!ready()) {
        if (Date.now() > limit) throw new Error('not-ready');
        await sleep(300);
      }
      if (location.pathname !== '/thread/new' || users().length || assistants().length) throw new Error('not-new-thread');
      if (images.length) {
        const input = scope()?.querySelector('input[type="file"]');
        if (!input || uploaded()) throw new Error('upload-unavailable');
        const transfer = new DataTransfer();
        for (let index = 0; index < images.length; index++) {
          const blob = await (await fetch(images[index])).blob();
          const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type.split('/')[1];
          transfer.items.add(new File([blob], `reference-${index + 1}.${extension}`, { type: blob.type }));
        }
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const uploadLimit = Date.now() + 30000;
        while (uploaded() < images.length) {
          if (Date.now() > uploadLimit) throw new Error('upload-unconfirmed');
          await sleep(300);
        }
      }
      const ta = composer();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!ta || !setter) throw new Error('composer-unavailable');
      setter.call(ta, prompt);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(150);
      const button = sendButton();
      if (ta.value !== prompt || !button || button.disabled) throw new Error('send-unavailable');
      window.__aiCanvasMuse = { baseline: attachments().map(item => item.src), kind, sent: false, prompt };
      return { ready: true };
    },
    send() {
      const state = window.__aiCanvasMuse;
      const button = sendButton();
      if (!state || state.sent || !button || button.disabled || composer()?.value !== state.prompt
        || location.pathname !== '/thread/new' || users().length || assistants().length) throw new Error('send-unavailable');
      state.sent = true;
      // One click only. Delivery uncertainty never triggers a second click.
      button.click();
      delete state.prompt;
      return { sent: true };
    },
    async extract(src, expected) {
      const attachment = attachments().find(item => item.src === src && item.kind === expected);
      if (!attachment) throw new Error('attachment-missing');
      const url = new URL(src, location.href);
      if (!(url.protocol === 'blob:' && url.origin === location.origin)
        && !(url.protocol === 'https:' && url.hostname === 'muse.ai')
        && !(url.protocol === 'data:' && src.startsWith(`data:${expected}/`))) throw new Error('media-origin');
      const response = await fetch(src);
      if (!response.ok) throw new Error('media-fetch');
      const maximum = (expected === 'video' ? 128 : 32) * 1024 * 1024;
      if (Number(response.headers.get('content-length') || '0') > maximum) throw new Error('media-size');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > maximum) { await reader.cancel(); throw new Error('media-size'); }
        chunks.push(part.value);
      }
      if (size < 12) throw new Error('media-size');
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      window.__aiCanvasMuseBytes = bytes;
      return { size };
    },
    chunk(offset, length) {
      const bytes = window.__aiCanvasMuseBytes;
      if (!bytes || offset < 0 || length > 32768) throw new Error('media-chunk');
      return { chunk: btoa(String.fromCharCode(...bytes.subarray(offset, offset + length))) };
    },
    clear() { delete window.__aiCanvasMuseBytes; return {}; },
  };
})();

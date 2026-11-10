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
    .find(el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && (
      /^(?:send(?: message)?|发送(?:消息)?)(?:\s*[（(](?:enter|回车)[）)])?$/i.test((el.getAttribute('aria-label') || '').trim())
      || /^(?:(?:hatch-)?composer-)?send(?:-message)?(?:-button)?$/i.test(el.getAttribute('data-testid') || '')
      || (!el.getAttribute('aria-label') && /^(?:send|发送)$/i.test((el.innerText || '').trim()))
    ));
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
  const validThread = (thread = location.pathname) => thread !== '/thread/new' && thread.length <= 256
    && /^\/thread\/[a-z\d_-]+$/i.test(thread);
  const turn = () => {
    const all = bubbles().filter(el => !el.parentElement?.closest('div[class*="hatch-chat-groupable-bubble"]'));
    const indexes = all.flatMap((el, index) => /chat-user-bubble/.test(el.className || '') ? [index] : []);
    const user = indexes.length === 1 ? all[indexes[0]] : null;
    // Status belongs to this user message; page chrome or an old assistant is not delivery evidence.
    const deliveryPending = !!user && (user.innerText || '').split(/\r?\n/).some(line =>
      /^(?:still sending|delivery not confirmed|正在发送|未确认送达)(?:\.{3}|…)?[.!。]?$/i.test(line.trim()));
    const deliveryConfirmed = !!user && !!composer() && composer().value === '' && validThread() && !deliveryPending;
    const reply = user ? all.slice(indexes[0] + 1).filter(el => /hatch-agent-bubble-bg/.test(el.className || '')) : [];
    return { userCount: indexes.length, textConflict: indexes.length > 1, deliveryPending, deliveryConfirmed,
      text: reply.map(el => (el.innerText || '').trim()).filter(Boolean).join('\n\n') };
  };
  const explicitRefusal = text => text.split(/[\r\n。！？!?]+/).some(raw => {
    const line = raw.trim();
    // A limitation disclaimer or a progress report is not a refusal to generate this media.
    if (/(?:无法|不能|不)(?:保证|确保|承诺)|\b(?:cannot|can't|unable to)\s+(?:guarantee|ensure|promise)\b/i.test(line)
      || /(?:正在|仍在|还在).{0,12}(?:生成|制作|渲染|处理|上传)|\b(?:generating|rendering|processing|uploading)\b/i.test(line)) return false;
    return /^(?:(?:很抱歉|抱歉|对不起)[，,:：\s]*)?(?:我?(?:目前|现在|暂时)?(?:无法|不能|未能|不支持)(?:直接)?(?:为你|为您)?(?:生成|制作|提供|创建).{0,12}(?:视频|影片|短片|图片|图像)|(?:本次|这次)?(?:视频|影片|短片|图片|图像).{0,8}(?:生成失败|没生成成功|未生成成功|没有生成成功|未能生成|无法生成|无法提供)|(?:本次|这次)?(?:生成|制作|渲染)(?:视频|影片|短片|图片|图像).{0,4}(?:失败|未成功))/i.test(line)
      || /^(?:(?:当前|你的|您的|该|此|这个)?(?:账号|账户)|(?:当前|你所在的|您所在的|该)?(?:国家|地区)).{0,80}(?:不支持|不可用|无法使用).{0,12}(?:视频|图片|图像)/i.test(line)
      || /^(?:(?:sorry|unfortunately)[,:]?\s*)?(?:i\s+)?(?:cannot|can't|could not|couldn't|am unable to|unable to)\s+(?:directly\s+)?(?:generate|create|produce|render|provide)\b[^.\n]{0,60}\b(?:video|clip|image|picture|animation)\b/i.test(line)
      || /^(?:(?:the|your|this)\s+)?(?:video|clip|image|picture|animation)(?:\s+generation)?\s+(?:failed|was not generated|has not been generated|could not be generated)/i.test(line)
      || /^(?:(?:当前|你的|您的|该)?(?:账号|账户)?的?)?(?:额度不足|积分不足)|^(?:out of credits|token limit (?:reached|exceeded))\b/i.test(line);
  });
  let refusalObservation;
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
    const current = turn();
    const stop = !!document.querySelector('[data-testid="hatch-composer-stop-button"],button[aria-label*="Stop" i],button[aria-label*="停止"]');
    const baseline = window.__aiCanvasMuse?.baseline || [];
    const kind = window.__aiCanvasMuse?.kind;
    const result = attachments().filter(item => !baseline.includes(item.src) && (!kind || item.kind === kind)).at(-1);
    const now = Date.now();
    if (!refusalObservation || refusalObservation.text !== current.text || refusalObservation.thread !== location.pathname
      || stop || !current.deliveryConfirmed) {
      refusalObservation = { text: current.text, thread: location.pathname, changedAt: now };
    }
    const refused = current.deliveryConfirmed && !stop && !result && !!current.text
      && now - refusalObservation.changedAt >= 3000 && explicitRefusal(current.text);
    return { thread: location.pathname, stop, agentCount: list.length, userCount: current.userCount,
      deliveryPending: current.deliveryPending, deliveryConfirmed: current.deliveryConfirmed, textConflict: current.textConflict,
      src: result?.src || '', kind: result?.kind || '', refused,
      ready: !!ready(), sent: !!window.__aiCanvasMuse?.sent };
  };
  const textSnapshot = expectedThread => {
    const page = snapshot();
    if (page.loading) return page;
    const metadata = { thread: page.thread, stop: page.stop, agentCount: page.agentCount,
      userCount: page.userCount, ready: page.ready, sent: page.sent,
      deliveryPending: page.deliveryPending, deliveryConfirmed: page.deliveryConfirmed, textConflict: page.textConflict };
    // Each native task starts from an empty thread and sends one user turn only.
    // A manually added turn must not be mistaken for this task's answer.
    if (page.textConflict) return metadata;
    // Native may bind the already confirmed thread when virtualization hides its user.
    const boundThread = typeof expectedThread === 'string' && validThread(expectedThread) && expectedThread === page.thread;
    if (page.userCount !== 1 && !boundThread) return { ...metadata, textUnavailable: true };
    const text = page.userCount === 1 ? turn().text : bubbles()
      .filter(el => !el.parentElement?.closest('div[class*="hatch-chat-groupable-bubble"]') && /hatch-agent-bubble-bg/.test(el.className || ''))
      .map(el => (el.innerText || '').trim()).filter(Boolean).join('\n\n');
    if (page.userCount !== 1 && !text) return { ...metadata, textUnavailable: true };
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
    const complete = (metadata.deliveryConfirmed || boundThread) && !!text && !metadata.stop && next.stable >= 3 && now - next.changedAt >= 3000;
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
        let transfer;
        try { transfer = new DataTransfer(); } catch (_) { throw new Error('upload-selection'); }
        for (let index = 0; index < images.length; index++) {
          let file;
          try {
            // Muse's connect-src does not allow data:. Decode native-validated bytes
            // locally instead of asking fetch() to load a reference data URL.
            const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z\d+/]+={0,2})$/i.exec(images[index]);
            if (!match || match[2].length > Math.ceil(8 * 1024 * 1024 / 3) * 4) throw new Error();
            const binary = atob(match[2]);
            if (!binary.length || binary.length > 8 * 1024 * 1024) throw new Error();
            const bytes = new Uint8Array(binary.length);
            for (let offset = 0; offset < binary.length; offset++) bytes[offset] = binary.charCodeAt(offset);
            const mime = match[1].toLowerCase();
            const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
            file = new File([bytes], `reference-${index + 1}.${extension}`, { type: mime });
          } catch (_) { throw new Error('upload-data'); }
          try { transfer.items.add(file); } catch (_) { throw new Error('upload-selection'); }
        }
        try {
          input.files = transfer.files;
          if (input.files?.length !== images.length) throw new Error();
        } catch (_) { throw new Error('upload-selection'); }
        try {
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) { throw new Error('upload-dispatch'); }
        const uploadLimit = Date.now() + 30000;
        while (uploaded() < images.length) {
          if (Date.now() > uploadLimit) throw new Error('upload-unconfirmed');
          await sleep(300);
        }
      }
      const ta = composer();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!ta || !setter) throw new Error('composer-unavailable');
      ta.scrollIntoView({ block: 'center', inline: 'nearest' });
      ta.focus();
      setter.call(ta, prompt);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      const sendLimit = Date.now() + 3000;
      while (!sendButton()) {
        if (Date.now() >= sendLimit) throw new Error('send-unavailable');
        await sleep(80);
      }
      if (ta.value !== prompt) throw new Error('send-unavailable');
      window.__aiCanvasMuse = { baseline: attachments().map(item => item.src), kind, sent: false, prompt };
      return { ready: true };
    },
    async send() {
      const state = window.__aiCanvasMuse;
      const button = sendButton();
      if (!state || state.sent || !button || button.disabled || composer()?.value !== state.prompt
        || location.pathname !== '/thread/new' || users().length || assistants().length) throw new Error('send-unavailable');
      state.sent = true;
      // sent records the attempt only. A click never proves gateway delivery.
      const deadline = Date.now() + 15000;
      try { button.click(); } catch (_) { throw new Error('send-unconfirmed'); }
      finally { delete state.prompt; }
      while (Date.now() < deadline) {
        const current = turn();
        if (current.textConflict) throw new Error('send-unconfirmed');
        if (current.deliveryConfirmed) return { sent: true, thread: location.pathname };
        await sleep(100);
      }
      throw new Error('send-unconfirmed');
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

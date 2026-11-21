(() => {
  'use strict';
  const root = document.documentElement;
  const sections = [...document.querySelectorAll('main section')];
  const links = [...document.querySelectorAll('.toc .links a')];
  const search = document.getElementById('search');
  const results = document.getElementById('search-results');
  const toc = document.querySelector('.toc');
  const toggle = document.getElementById('toc-toggle');
  function setTocExpanded(expanded) {
    toc.classList.toggle('is-collapsed', !expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? '收起目录' : '展开目录';
  }
  setTocExpanded(!window.matchMedia('(max-width:780px)').matches);
  toggle.addEventListener('click', () => setTocExpanded(toggle.getAttribute('aria-expanded') !== 'true'));

  // Build small text-only blocks once; image Data URLs never enter the search index.
  const index = [];
  sections.forEach(section => {
    const chapter = section.querySelector('h2').textContent;
    let block;
    let headingCount = 0;
    for (const child of section.children) {
      if (/^H[234]$/.test(child.tagName) || child.tagName === 'DETAILS') {
        const heading = child.tagName === 'DETAILS' ? child.querySelector('summary') : child;
        if (!child.id) child.id = child.tagName === 'H2' ? `${section.id}-title` : `${section.id}-part-${++headingCount}`;
        block = { id: child.id, title: heading.textContent, chapter, headingPriority: child.tagName === 'DETAILS' ? 0 : 1, parts: [] };
        index.push(block);
        if (child.tagName === 'DETAILS') block.parts.push(child.textContent.slice(heading.textContent.length));
        continue;
      }
      if (block) block.parts.push(child.textContent);
    }
  });
  index.forEach(block => {
    block.text = block.parts.join(' ').replace(/\s+/g, ' ').trim();
    block.normalized = `${block.title} ${block.text}`.toLocaleLowerCase();
    delete block.parts;
  });
  function appendHighlighted(target, value, terms) {
    const lower = value.toLocaleLowerCase();
    let position = 0;
    while (position < value.length) {
      const next = terms.map(term => ({ term, start: lower.indexOf(term, position) }))
        .filter(match => match.start >= 0).sort((a, b) => a.start - b.start || b.term.length - a.term.length)[0];
      if (!next) { target.append(document.createTextNode(value.slice(position))); break; }
      target.append(document.createTextNode(value.slice(position, next.start)));
      const mark = document.createElement('mark');
      mark.textContent = value.slice(next.start, next.start + next.term.length);
      target.append(mark);
      position = next.start + next.term.length;
    }
  }
  search.addEventListener('input', () => {
    const query = search.value.trim().toLocaleLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    let count = 0;
    links.forEach(link => {
      const section = document.getElementById(link.hash.slice(1));
      const text = section.textContent.toLocaleLowerCase();
      const matches = terms.every(term => text.includes(term));
      link.hidden = !matches;
      if (matches) count += 1;
    });
    document.querySelectorAll('.toc .group').forEach(group => {
      let sibling = group.nextElementSibling;
      let hasMatches = false;
      while (sibling && !sibling.classList.contains('group')) {
        if (sibling.tagName === 'A' && !sibling.hidden) hasMatches = true;
        sibling = sibling.nextElementSibling;
      }
      group.hidden = !hasMatches;
    });
    results.replaceChildren();
    results.hidden = !query;
    if (query) {
      setTocExpanded(true);
      const matches = index.filter(block => terms.every(term => block.normalized.includes(term)));
      const relevance = block => Number(terms.every(term => block.title.toLocaleLowerCase().includes(term))) * 2 + block.headingPriority;
      matches.sort((a, b) => relevance(b) - relevance(a));
      matches.slice(0, 8).forEach(block => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `#${block.id}`;
        link.title = block.chapter;
        appendHighlighted(link, block.title, terms);
        const snippet = document.createElement('small');
        const positions = terms.map(term => block.text.toLocaleLowerCase().indexOf(term)).filter(position => position >= 0);
        const first = positions.length ? Math.min(...positions) : 0;
        const start = Math.max(0, first - 25);
        appendHighlighted(snippet, `${start ? '…' : ''}${block.text.slice(start, start + 100)}${start + 100 < block.text.length ? '…' : ''}`, terms);
        link.append(snippet); item.append(link); results.append(item);
      });
      document.getElementById('search-status').textContent = matches.length
        ? `匹配 ${count} 章、${matches.length} 处操作${matches.length > 8 ? '，显示前 8 处' : ''}。`
        : count ? `匹配 ${count} 章；关键词分散在不同段落，请点击目录或缩短搜索。` : '没有匹配内容，请换个关键词或用 Ctrl + F。';
    } else document.getElementById('search-status').textContent = '支持空格分隔关键词；Ctrl + F 查找全文。';
  });
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') { search.value = ''; search.dispatchEvent(new Event('input')); }
    if (event.key === 'Enter') {
      const first = results.querySelector('a');
      if (first) { first.click(); document.getElementById(first.hash.slice(1))?.focus({ preventScroll: true }); }
    }
  });
  let navigationFrame = 0;
  function syncCurrentSection() {
    navigationFrame = 0;
    const boundary = window.innerHeight * 0.3;
    const current = sections.filter(section => section.getBoundingClientRect().top <= boundary).at(-1) || sections[0];
    links.forEach(link => {
      if (link.hash === `#${current.id}`) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }
  window.addEventListener('scroll', () => {
    if (!navigationFrame) navigationFrame = requestAnimationFrame(syncCurrentSection);
  }, { passive: true });
  window.addEventListener('resize', syncCurrentSection);
  function revealAnchor() {
    let target;
    try { target = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch { return; }
    if (!target) return;
    const detail = target.closest('details');
    if (detail) detail.open = true;
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
    syncCurrentSection();
  }
  window.addEventListener('hashchange', revealAnchor);
  document.querySelectorAll('main h2[id],main h3[id],main section>h2,main section>h3').forEach(heading => {
    const target = heading.id || heading.closest('section').id;
    heading.tabIndex = -1;
    const link = document.createElement('a');
    link.href = `#${target}`; link.className = 'section-link'; link.textContent = '#';
    link.setAttribute('aria-label', `链接到${heading.textContent}`);
    heading.append(link);
  });
  revealAnchor(); syncCurrentSection();
  const themeButton = document.getElementById('theme');
  function syncTheme() {
    const dark = root.dataset.theme === 'dark';
    themeButton.setAttribute('aria-pressed', String(dark));
    themeButton.textContent = dark ? '切换浅色阅读' : '切换深色阅读';
  }
  themeButton.addEventListener('click', () => { root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; syncTheme(); });
  let beforePrintTheme;
  const detailStates = new Map();
  window.addEventListener('beforeprint', () => {
    beforePrintTheme = root.dataset.theme;
    root.dataset.theme = 'light';
    document.querySelectorAll('details').forEach(detail => { detailStates.set(detail, detail.open); detail.open = true; });
  });
  window.addEventListener('afterprint', () => {
    if (beforePrintTheme) root.dataset.theme = beforePrintTheme;
    detailStates.forEach((open, detail) => { detail.open = open; });
    detailStates.clear(); syncTheme();
  });
  document.getElementById('print').addEventListener('click', () => window.print());
  document.querySelectorAll('.copy').forEach(button => {
    button.addEventListener('click', async () => {
      const content = document.getElementById(button.dataset.copy).textContent;
      const label = button.textContent;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(content);
        button.textContent = '已复制';
      } catch {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(document.getElementById(button.dataset.copy));
        selection.removeAllRanges(); selection.addRange(range);
        button.textContent = '已选中，请 Ctrl+C';
      }
      setTimeout(() => { button.textContent = label; }, 2500);
    });
  });
  const dialog = document.getElementById('zoom');
  document.querySelectorAll('figure .shot-button').forEach(button => {
    button.addEventListener('click', () => {
      const clone = button.parentElement.cloneNode(true);
      clone.querySelector('button').tabIndex = -1;
      dialog.querySelector('.zoom-box').replaceChildren(clone);
      dialog.showModal();
    });
  });
  document.getElementById('zoom-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  function updateUrlDemo() {
    const output = document.getElementById('demo-output');
    try {
      const raw = document.getElementById('demo-base').value.trim().replace(/\/+$/, '');
      const base = new URL(raw);
      const path = document.getElementById('demo-path').value.trim();
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('请填写不含密钥、查询参数和片段的 http(s) 基础地址。');
      if (!path.startsWith('/') || path.startsWith('//')) throw new Error('协议路径应以单个 / 开头。');
      output.textContent = document.getElementById('demo-mode').value === 'origin' ? `${base.origin}${path}` : `${raw}${path}`;
    } catch (error) { output.textContent = error instanceof TypeError ? '请输入完整的 http(s) 基础地址。' : error.message; }
  }
  ['demo-base', 'demo-path', 'demo-mode'].forEach(id => document.getElementById(id).addEventListener('input', updateUrlDemo));
  updateUrlDemo();
})();

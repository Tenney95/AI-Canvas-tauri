/**
 * 轻量级 Markdown → HTML 渲染器（无外部依赖）
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMarkdown(md: string): string {
  if (!md) return '';

  // ── 1. 提取代码块，用占位符保护 ──
  const codeBlocks: string[] = [];
  let processed = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code.trimEnd())}</code></pre>`
    );
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // ── 2. 提取行内代码 ──
  const inlineCodes: string[] = [];
  processed = processed.replace(/`([^`]+)`/g, (_: string, code: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00ICODE${idx}\x00`;
  });

  // ── 3. HTML 转义（保护占位符） ──
  processed = processed
    .split('\x00')
    .map((part, i) => (i % 2 === 0 ? escapeHtml(part) : part))
    .join('\x00');

  // ── 4. 图片 ![alt](url) ──
  processed = processed.replace(
    /!\[([^\]]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g,
    (_: string, alt: string, url: string) => {
      const cleanUrl = url.replace(/\s+"[^"]*"$/, '');
      const titleMatch = url.match(/\s+"([^"]*)"$/);
      const title = titleMatch ? ` title="${escapeHtml(titleMatch[1])}"` : '';
      return `<img src="${escapeHtml(cleanUrl)}" alt="${escapeHtml(alt)}"${title} />`;
    }
  );

  // ── 5. 链接 [text](url) ──
  processed = processed.replace(
    /\[([^\]]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g,
    (_: string, text: string, url: string) => {
      const cleanUrl = url.replace(/\s+"[^"]*"$/, '');
      const titleMatch = url.match(/\s+"([^"]*)"$/);
      const title = titleMatch ? ` title="${escapeHtml(titleMatch[1])}"` : '';
      return `<a href="${escapeHtml(cleanUrl)}"${title} rel="noopener">${text}</a>`;
    }
  );

  // ── 6. 粗体 **text** ──
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // ── 7. 斜体 *text*（不匹配 ** 已处理的） ──
  processed = processed.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');

  // ── 8. 删除线 ~~text~~ ──
  processed = processed.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // ── 按行处理块级元素 ──
  const lines = processed.split('\n');
  const result: string[] = [];
  let inList: 'ul' | 'ol' | null = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // ── 9. 标题 #-###### ──
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (inList) { result.push(`</${inList}>`); inList = null; }
      const level = headingMatch[1].length;
      result.push(`<h${level}>${headingMatch[2]}</h${level}>`);
      continue;
    }

    // ── 10. 水平线 --- / *** ──
    if (/^-{3,}$/.test(line.trim()) || /^\*{3,}$/.test(line.trim())) {
      if (inList) { result.push(`</${inList}>`); inList = null; }
      result.push('<hr />');
      continue;
    }

    // ── 11. 无序列表 - item ──
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (inList !== 'ul') {
        if (inList) result.push(`</${inList}>`);
        result.push('<ul>');
        inList = 'ul';
      }
      result.push(`<li>${ulMatch[2]}</li>`);
      continue;
    }

    // ── 12. 有序列表 1. item ──
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      if (inList !== 'ol') {
        if (inList) result.push(`</${inList}>`);
        result.push('<ol>');
        inList = 'ol';
      }
      result.push(`<li>${olMatch[2]}</li>`);
      continue;
    }

    // 非列表项：关闭列表
    if (inList) { result.push(`</${inList}>`); inList = null; }

    // ── 13. 引用 > text ──
    const bqMatch = line.match(/^>\s?(.*)$/);
    if (bqMatch) {
      result.push(`<blockquote>${bqMatch[1] || '&nbsp;'}</blockquote>`);
      continue;
    }

    // ── 14. 空行 → 段落分隔 ──
    if (line.trim() === '') {
      result.push('');
      continue;
    }

    // ── 15. 普通段落 ──
    result.push(`<p>${line}</p>`);
  }

  if (inList) { result.push(`</${inList}>`); }

  // ── 恢复占位符 ──
  let html = result.join('\n');
  for (let i = 0; i < codeBlocks.length; i++) {
    html = html.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]);
  }
  for (let i = 0; i < inlineCodes.length; i++) {
    html = html.replace(`\x00ICODE${i}\x00`, inlineCodes[i]);
  }

  return html;
}

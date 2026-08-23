import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/utils/renderMarkdown';

describe('renderMarkdown URL sanitization', () => {
  it.each([
    'javascript:alert(1)',
    'java\u0000script:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
  ])('does not create a link for unsafe URL %s', (url) => {
    const html = renderMarkdown(`[打开](${url})`);

    expect(html).toContain('打开');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href=');
  });

  it.each([
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj4=',
    'file:///etc/passwd',
  ])('does not create an image for unsafe URL %s', (url) => {
    const html = renderMarkdown(`![预览](${url})`);

    expect(html).toContain('预览');
    expect(html).not.toContain('<img ');
    expect(html).not.toContain('src=');
  });

  it.each([
    'https://example.com/docs',
    'http://example.com/docs',
    'mailto:user@example.com',
    './docs/guide.md',
    '#section',
  ])('keeps safe link URL %s', (url) => {
    expect(renderMarkdown(`[文档](${url})`)).toContain('<a href=');
  });

  it.each([
    'https://example.com/image.png',
    './images/preview.webp',
    'data:image/png;base64,iVBORw0KGgo=',
  ])('keeps safe image URL %s', (url) => {
    expect(renderMarkdown(`![预览](${url})`)).toContain('<img src=');
  });
});

describe('renderMarkdown HTML escaping', () => {
  it('escapes raw HTML even when the input carries NUL bytes', () => {
    const html = renderMarkdown('\u0000 <img src=x onerror=alert(1)>');

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('\u0000');
  });

  it('escapes raw HTML after a forged code-block placeholder', () => {
    const html = renderMarkdown('\u0000CODEBLOCK0\u0000<script>alert(1)</script>');

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('still renders code blocks and inline code', () => {
    const html = renderMarkdown('```ts\nconst a = 1 < 2;\n```\n\n`a && b`');

    expect(html).toContain('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
    expect(html).toContain('<code>a &amp;&amp; b</code>');
  });
});

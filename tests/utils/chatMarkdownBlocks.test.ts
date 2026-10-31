/** 增量 Markdown 与完整解析一致，并保留已完成内容的对象和块身份。 */
import { describe, expect, it } from 'vitest';
import { createChatMarkdownParser } from '../../src/utils/chatMarkdownBlocks';

describe('chat Markdown blocks', () => {
  it.each([
    '# 标题\n\n正文 **强调**\n第二行\n\n---\n\n> 引用\n> 第二行',
    '前文\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n尾文',
    '| 名称 | 内容 |\n| --- | :---: |\n| A | 中文 |\n| B | 2 |\n\n完成',
    '正文\n---x\n\n- 第一项\n- 第二项\n1. 有序\n2. 次项',
    '正文\r\n\r\n```\r\na\r\n```\r\n\r\n尾部',
    'a | b\n--- | ---\n1 | 2\n\n# 未完成标题\n\n末段',
  ])('matches full parsing at every streaming boundary: %s', (content) => {
    const parse = createChatMarkdownParser();
    for (let length = 1; length <= content.length; length++) {
      const prefix = content.slice(0, length);
      expect(parse(prefix)).toEqual(createChatMarkdownParser()(prefix));
    }
  });

  it('reuses completed blocks and keeps a growing code block keyed by its start', () => {
    const parse = createChatMarkdownParser();
    const first = parse('已完成\n\n```ts\nconst a = 1;');
    const next = parse('已完成\n\n```ts\nconst a = 1;\nconst b = 2;');
    expect(next[0]).toBe(first[0]);
    expect(next[1].start).toBe(first[1].start);
    expect(next[1]).toMatchObject({ kind: 'code', code: 'const a = 1;\nconst b = 2;' });
    expect(parse('已完成\n\n```ts\nconst a = 1;\nconst b = 2;')).toBe(next);
  });

  it('reparses edits, truncation and replacements without stale blocks', () => {
    const parse = createChatMarkdownParser();
    for (const content of ['旧内容\n\n尾段', '新内容\n\n尾段', '新内容', '', '另一个消息']) {
      expect(parse(content)).toEqual(createChatMarkdownParser()(content));
    }
  });

  it('keeps the existing restricted Markdown grammar', () => {
    expect(createChatMarkdownParser()('# 标题\n\n```js\n1\n```\n\n| A |\n| --- |\n| B |\n\n- item')).toMatchObject([
      { kind: 'heading', level: 1, text: '标题' },
      { kind: 'code', language: 'js', code: '1' },
      { kind: 'table', header: ['A'], rows: [['B']] },
      { kind: 'list', ordered: false, items: ['item'] },
    ]);
  });
});

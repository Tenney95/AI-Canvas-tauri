/** 对话 Markdown 的块解析；追加文本只重读未封闭尾段，编辑时重新解析。 */
type BlockContent =
  | { kind: 'code'; code: string; language: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'rule' }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote' | 'paragraph'; lines: string[] };

export type ChatMarkdownBlock = BlockContent & { start: number; source: string };

function splitTableRow(value: string): string[] {
  return value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function isTableDivider(value: string): boolean {
  const cells = splitTableRow(value);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (!line.trim()) return true;
  if (/^```/.test(line) || /^#{1,6}\s+/.test(line) || /^>\s?/.test(line)) return true;
  if (/^\s*(?:[-+*]|\d+\.)\s+/.test(line) || /^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) return true;
  return index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1]);
}

/** 每个消息视图持有一个实例；缓存只保留最近输入，不跨消息保存正文。 */
export function createChatMarkdownParser(): (value: string) => ChatMarkdownBlock[] {
  let previous = '';
  let result: ChatMarkdownBlock[] = [];
  let committedCount = 0;
  let resumeOffset = 0;

  return (value) => {
    const normalized = value.replace(/\r\n?/g, '\n');
    if (normalized === previous) return result;
    const append = normalized.startsWith(previous);
    const base = append ? resumeOffset : 0;
    const blocks = append ? result.slice(0, committedCount) : [];
    const oldTail = new Map((append ? result.slice(committedCount) : []).map((block) => [block.start, block]));
    if (!append) { committedCount = 0; resumeOffset = 0; }
    const tail = normalized.slice(base);
    const lines = tail.split('\n');
    const offsets: number[] = [];
    let offset = 0;
    for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
    let index = 0;
    const push = (startLine: number, content: BlockContent) => {
      const start = base + offsets[startLine];
      const source = tail.slice(offsets[startLine], offsets[index] ?? tail.length);
      const old = oldTail.get(start);
      blocks.push(old?.kind === content.kind && old.source === source ? old : { ...content, start, source });
    };

    while (index < lines.length) {
      const start = index;
      const line = lines[index];
      if (!line.trim()) {
        // 最后一行尚可追加字符；只有完整空行才能隔断前后块，代码内空行不经过这里。
        if (index < lines.length - 1) {
          committedCount = blocks.length;
          resumeOffset = base + offsets[index + 1];
        }
        index += 1;
        continue;
      }
      const fence = /^```([^\s`]*)\s*$/.exec(line);
      if (fence) {
        const code: string[] = [];
        index += 1;
        while (index < lines.length && !/^```\s*$/.test(lines[index])) code.push(lines[index++]);
        if (index < lines.length) index += 1;
        push(start, { kind: 'code', code: code.join('\n'), language: fence[1] });
        continue;
      }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) {
        index += 1;
        push(start, { kind: 'heading', level: heading[1].length, text: heading[2] });
        continue;
      }
      if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
        index += 1;
        push(start, { kind: 'rule' });
        continue;
      }
      if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1])) {
        const header = splitTableRow(line);
        const rows: string[][] = [];
        index += 2;
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(splitTableRow(lines[index++]));
        push(start, { kind: 'table', header, rows });
        continue;
      }
      const listItem = /^\s*([-+*]|\d+\.)\s+(.+)$/.exec(line);
      if (listItem) {
        const ordered = /\d+\./.test(listItem[1]);
        const items: string[] = [];
        while (index < lines.length) {
          const item = /^\s*([-+*]|\d+\.)\s+(.+)$/.exec(lines[index]);
          if (!item || /\d+\./.test(item[1]) !== ordered) break;
          items.push(item[2]);
          index += 1;
        }
        push(start, { kind: 'list', ordered, items });
        continue;
      }
      if (/^>\s?/.test(line)) {
        const quote: string[] = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
        push(start, { kind: 'quote', lines: quote });
        continue;
      }
      const paragraph = [line];
      index += 1;
      while (index < lines.length && !isBlockStart(lines, index)) paragraph.push(lines[index++]);
      push(start, { kind: 'paragraph', lines: paragraph });
    }
    previous = normalized;
    result = blocks;
    return result;
  };
}

import { useState, type ReactNode } from 'react';
import { Icon } from '@iconify/react';
import ChatReferenceText, { type ChatReferenceHandlers } from './ChatReferenceText';

interface ChatMarkdownProps extends ChatReferenceHandlers {
  value: string;
}

interface InlineContentProps extends ChatReferenceHandlers {
  value: string;
}

const INLINE_PATTERN = /(@\{[^:}\r\n]+:[^}\r\n]+\}|@model\{[^|}\r\n]+\|[^}\r\n]*\}|@skill\{[^|}\r\n]+\|[^}\r\n]*\}|`[^`\r\n]+`|\[[^\]\r\n]+\]\([^)\s]+\)|\*\*[^*\r\n]+\*\*|~~[^~\r\n]+~~|\*[^*\r\n]+\*)/g;

function resolveSafeHref(value: string): string | null {
  const href = value.trim();
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return href;
  return null;
}

function InlineContent({
  value,
  onNodeActivate,
  onNodeHover,
  onModelActivate,
}: InlineContentProps) {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of value.matchAll(INLINE_PATTERN)) {
    const raw = match[0];
    const start = match.index;
    if (start == null) continue;
    if (start > cursor) {
      nodes.push(
        <ChatReferenceText
          key={`text-${cursor}`}
          value={value.slice(cursor, start)}
          compact
          onNodeActivate={onNodeActivate}
          onNodeHover={onNodeHover}
          onModelActivate={onModelActivate}
        />,
      );
    }

    if (raw.startsWith('@')) {
      nodes.push(
        <ChatReferenceText
          key={`ref-${start}`}
          value={raw}
          compact
          onNodeActivate={onNodeActivate}
          onNodeHover={onNodeHover}
          onModelActivate={onModelActivate}
        />,
      );
    } else if (raw.startsWith('`')) {
      nodes.push(
        <code
          key={`code-${start}`}
          className="rounded-[4px] border border-canvas-border/70 bg-canvas-bg/70 px-1.5 py-0.5 font-mono text-[0.92em] text-emerald-200"
        >
          {raw.slice(1, -1)}
        </code>,
      );
    } else if (raw.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(raw);
      const href = linkMatch ? resolveSafeHref(linkMatch[2]) : null;
      nodes.push(href ? (
        <a
          key={`link-${start}`}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-sky-300 underline decoration-sky-300/35 underline-offset-2 hover:text-sky-200 hover:decoration-sky-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/50"
        >
          {linkMatch?.[1]}
        </a>
      ) : (
        <span key={`unsafe-link-${start}`}>{linkMatch?.[1] ?? raw}</span>
      ));
    } else if (raw.startsWith('**')) {
      nodes.push(
        <strong key={`strong-${start}`} className="font-semibold text-canvas-text">
          <InlineContent
            value={raw.slice(2, -2)}
            onNodeActivate={onNodeActivate}
            onNodeHover={onNodeHover}
            onModelActivate={onModelActivate}
          />
        </strong>,
      );
    } else if (raw.startsWith('~~')) {
      nodes.push(
        <del key={`del-${start}`} className="text-canvas-text-muted">
          <InlineContent
            value={raw.slice(2, -2)}
            onNodeActivate={onNodeActivate}
            onNodeHover={onNodeHover}
            onModelActivate={onModelActivate}
          />
        </del>,
      );
    } else {
      nodes.push(
        <em key={`em-${start}`} className="italic text-canvas-text-secondary">
          <InlineContent
            value={raw.slice(1, -1)}
            onNodeActivate={onNodeActivate}
            onNodeHover={onNodeHover}
            onModelActivate={onModelActivate}
          />
        </em>,
      );
    }
    cursor = start + raw.length;
  }

  if (cursor < value.length) {
    nodes.push(
      <ChatReferenceText
        key={`text-${cursor}`}
        value={value.slice(cursor)}
        compact
        onNodeActivate={onNodeActivate}
        onNodeHover={onNodeHover}
        onModelActivate={onModelActivate}
      />,
    );
  }
  return <>{nodes}</>;
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="group/code relative my-2 overflow-hidden rounded-lg border border-canvas-border bg-canvas-bg/80">
      <div className="flex h-8 items-center justify-between border-b border-canvas-border/70 px-2.5 text-[10px] text-canvas-text-muted">
        <span className="font-medium uppercase">{language || 'code'}</span>
        <button
          type="button"
          onClick={() => void copyCode()}
          aria-label={copied ? '代码已复制' : '复制代码'}
          data-tooltip={copied ? '已复制' : '复制代码'}
          className="flex h-7 w-7 items-center justify-center rounded-md text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
        >
          <Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} width="14" />
        </button>
      </div>
      <pre className="max-h-80 overflow-auto p-3 text-[11px] leading-5 text-canvas-text-secondary">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

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

export default function ChatMarkdown({
  value,
  onNodeActivate,
  onNodeHover,
  onModelActivate,
}: ChatMarkdownProps) {
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  const inlineProps = { onNodeActivate, onNodeHover, onModelActivate };
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^```([^\s`]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(<CodeBlock key={`code-${index}`} code={code.join('\n')} language={fence[1]} />);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const headingClasses = level === 1
        ? 'mt-3 mb-1.5 text-[16px] font-semibold'
        : level === 2
          ? 'mt-3 mb-1 text-[14px] font-semibold'
          : 'mt-2.5 mb-1 text-[13px] font-semibold';
      const content = <InlineContent value={heading[2]} {...inlineProps} />;
      if (level === 1) blocks.push(<h1 key={`h-${index}`} className={headingClasses}>{content}</h1>);
      else if (level === 2) blocks.push(<h2 key={`h-${index}`} className={headingClasses}>{content}</h2>);
      else blocks.push(<h3 key={`h-${index}`} className={headingClasses}>{content}</h3>);
      index += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={`hr-${index}`} className="my-3 border-canvas-border/80" />);
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1])) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push(
        <div key={`table-${index}`} className="my-2 overflow-x-auto rounded-lg border border-canvas-border/80">
          <table className="w-full min-w-[280px] border-collapse text-left text-[11px]">
            <thead className="bg-canvas-hover/70 text-canvas-text-secondary">
              <tr>{header.map((cell, cellIndex) => (
                <th key={cellIndex} className="border-b border-canvas-border px-2.5 py-2 font-medium">
                  <InlineContent value={cell} {...inlineProps} />
                </th>
              ))}</tr>
            </thead>
            <tbody>{rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-canvas-border/60 last:border-b-0">
                {header.map((_, cellIndex) => (
                  <td key={cellIndex} className="px-2.5 py-2 align-top text-canvas-text/90">
                    <InlineContent value={row[cellIndex] ?? ''} {...inlineProps} />
                  </td>
                ))}
              </tr>
            ))}</tbody>
          </table>
        </div>,
      );
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
      const children = items.map((item, itemIndex) => (
        <li key={itemIndex} className="pl-0.5 marker:text-canvas-text-muted">
          <InlineContent value={item} {...inlineProps} />
        </li>
      ));
      blocks.push(ordered ? (
        <ol key={`list-${index}`} className="my-1.5 list-decimal space-y-1 pl-5 text-canvas-text/90">{children}</ol>
      ) : (
        <ul key={`list-${index}`} className="my-1.5 list-disc space-y-1 pl-5 text-canvas-text/90">{children}</ul>
      ));
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`} className="my-2 border-l-2 border-indigo-400/45 pl-3 text-canvas-text-muted">
          {quote.map((quoteLine, quoteIndex) => (
            <span key={quoteIndex} className="block"><InlineContent value={quoteLine} {...inlineProps} /></span>
          ))}
        </blockquote>,
      );
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`p-${index}`} className="my-1.5 break-words text-canvas-text/90 first:mt-0 last:mb-0">
        {paragraph.map((paragraphLine, lineIndex) => (
          <span key={lineIndex}>
            {lineIndex > 0 && <br />}
            <InlineContent value={paragraphLine} {...inlineProps} />
          </span>
        ))}
      </p>,
    );
  }

  return <div className="chat-markdown min-w-0">{blocks}</div>;
}

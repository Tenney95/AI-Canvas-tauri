/**
 * 渲染对话消息的受限 Markdown 子集，并把画布、模型与 Skill 引用交给专用引用组件处理。
 */
import { memo, useMemo, useState, type ReactNode } from 'react';
import { createChatMarkdownParser, type ChatMarkdownBlock } from '../../utils/chatMarkdownBlocks';
import { Icon } from '@iconify/react';
import ChatReferenceText, { type ChatReferenceHandlers } from './ChatReferenceText';
import { useT } from '../../i18n';

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
          className="ui-code"
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
  const t = useT();
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
          aria-label={copied ? t('代码已复制') : t('复制代码')}
          data-tooltip={copied ? t('已复制') : t('复制代码')}
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

const MarkdownBlock = memo(function MarkdownBlock({
  block, onNodeActivate, onNodeHover, onModelActivate,
}: ChatReferenceHandlers & { block: ChatMarkdownBlock }) {
  const inlineProps = { onNodeActivate, onNodeHover, onModelActivate };
  switch (block.kind) {
    case 'code': return <CodeBlock code={block.code} language={block.language} />;
    case 'heading': {
      const headingClasses = block.level === 1
        ? 'mt-3 mb-1.5 text-[16px] font-semibold'
        : block.level === 2 ? 'mt-3 mb-1 text-[14px] font-semibold' : 'mt-2.5 mb-1 text-[13px] font-semibold';
      const content = <InlineContent value={block.text} {...inlineProps} />;
      if (block.level === 1) return <h1 className={headingClasses}>{content}</h1>;
      if (block.level === 2) return <h2 className={headingClasses}>{content}</h2>;
      return <h3 className={headingClasses}>{content}</h3>;
    }
    case 'rule': return <hr className="my-3 border-canvas-border/80" />;
    case 'table': return (
      <div className="my-2 overflow-x-auto rounded-lg border border-canvas-border/80">
        <table className="w-full min-w-[280px] border-collapse text-left text-[11px]">
          <thead className="bg-canvas-hover/70 text-canvas-text-secondary">
            <tr>{block.header.map((cell, cellIndex) => (
              <th key={cellIndex} className="border-b border-canvas-border px-2.5 py-2 font-medium">
                <InlineContent value={cell} {...inlineProps} />
              </th>
            ))}</tr>
          </thead>
          <tbody>{block.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-canvas-border/60 last:border-b-0">
              {block.header.map((_, cellIndex) => (
                <td key={cellIndex} className="px-2.5 py-2 align-top text-canvas-text/90">
                  <InlineContent value={row[cellIndex] ?? ''} {...inlineProps} />
                </td>
              ))}
            </tr>
          ))}</tbody>
        </table>
      </div>
    );
    case 'list': {
      const children = block.items.map((item, itemIndex) => (
        <li key={itemIndex} className="pl-0.5 marker:text-canvas-text-muted">
          <InlineContent value={item} {...inlineProps} />
        </li>
      ));
      return block.ordered
        ? <ol className="my-1.5 list-decimal space-y-1 pl-5 text-canvas-text/90">{children}</ol>
        : <ul className="my-1.5 list-disc space-y-1 pl-5 text-canvas-text/90">{children}</ul>;
    }
    case 'quote': return (
      <blockquote className="my-2 border-l-2 border-indigo-400/45 pl-3 text-canvas-text-muted">
        {block.lines.map((line, index) => (
          <span key={index} className="block"><InlineContent value={line} {...inlineProps} /></span>
        ))}
      </blockquote>
    );
    case 'paragraph': return (
      <p className="my-1.5 text-canvas-text/90 first:mt-0 last:mb-0">
        {block.lines.map((line, index) => (
          <span key={index}>
            {index > 0 && <br />}
            <InlineContent value={line} {...inlineProps} />
          </span>
        ))}
      </p>
    );
  }
});

export default function ChatMarkdown({ value, ...handlers }: ChatMarkdownProps) {
  const [parse] = useState(createChatMarkdownParser);
  const blocks = useMemo(() => parse(value), [parse, value]);
  // overflow-wrap 会继承：长 URL、行内代码在列表项/表格/引用里也不会再撑破气泡。
  return <div className="chat-markdown min-w-0 [overflow-wrap:anywhere]">
    {blocks.map((block) => <MarkdownBlock key={`${block.kind}-${block.start}`} block={block} {...handlers} />)}
  </div>;
}

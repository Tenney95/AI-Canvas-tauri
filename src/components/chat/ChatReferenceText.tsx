import { useMemo } from 'react';
import { Icon } from '@iconify/react';
import { useAppStore } from '../../store/useAppStore';

type ReferenceTokenKind = 'node' | 'model' | 'skill' | 'slash';

interface ReferenceToken {
  kind: ReferenceTokenKind;
  raw: string;
  label: string;
  id?: string;
  displayId?: number;
  start: number;
  end: number;
}

interface ChatReferenceTextProps {
  value: string;
  compact?: boolean;
}

export interface ChatReferenceHandlers {
  onNodeActivate?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  onModelActivate?: (modelId: string) => void;
}

type InteractiveChatReferenceTextProps = ChatReferenceTextProps & ChatReferenceHandlers;

const TOKEN_PATTERN = /@\{([^:}\r\n]+):([^}\r\n]+)\}|@model\{([^|}\r\n]+)\|([^}\r\n]*)\}|@skill\{([^|}\r\n]+)\|([^}\r\n]*)\}|\/[^\s/]*/g;

function decodeLabel(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseReferenceTokens(
  value: string,
  nodeDisplayIds: ReadonlyMap<string, number | undefined>,
): ReferenceToken[] {
  const tokens: ReferenceToken[] = [];
  for (const match of value.matchAll(TOKEN_PATTERN)) {
    const raw = match[0];
    const start = match.index;
    if (start == null) continue;

    if (raw.startsWith('/') && start > 0 && !/\s/.test(value[start - 1])) {
      continue;
    }

    const kind: ReferenceTokenKind = raw.startsWith('@{')
      ? 'node'
      : raw.startsWith('@model{')
        ? 'model'
      : raw.startsWith('@skill{')
        ? 'skill'
        : 'slash';
    const label = kind === 'node'
      ? match[2]
      : kind === 'model'
        ? match[4] || '模型'
      : kind === 'skill'
        ? decodeLabel(match[6]) || 'Skill'
        : raw.slice(1);
    const id = kind === 'node'
      ? match[1]
      : kind === 'model'
        ? match[3]
        : kind === 'skill'
          ? match[5]
          : undefined;
    tokens.push({
      kind,
      raw,
      label,
      id,
      displayId: kind === 'node' && id ? nodeDisplayIds.get(id) : undefined,
      start,
      end: start + raw.length,
    });
  }
  return tokens;
}

const INPUT_TOKEN_CLASSES: Record<ReferenceTokenKind, string> = {
  node: 'rounded-[5px] bg-indigo-400/15 text-indigo-200 ring-1 ring-inset ring-indigo-400/25',
  model: 'rounded-[5px] bg-sky-400/15 text-sky-200 ring-1 ring-inset ring-sky-400/20',
  skill: 'rounded-[5px] bg-emerald-400/15 text-emerald-200 ring-1 ring-inset ring-emerald-400/20',
  slash: 'rounded-[4px] bg-emerald-400/10 text-emerald-200',
};

const COMPACT_TOKEN_CLASSES: Record<ReferenceTokenKind, string> = {
  node: 'border-indigo-400/25 bg-indigo-400/10 text-indigo-100',
  model: 'border-sky-400/25 bg-sky-400/10 text-sky-100',
  skill: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100',
  slash: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
};

interface CompactTokenProps extends ChatReferenceHandlers {
  token: ReferenceToken;
  missing?: boolean;
  onMissingNode: () => void;
}

function CompactToken({
  token,
  missing = false,
  onMissingNode,
  onNodeActivate,
  onNodeHover,
  onModelActivate,
}: CompactTokenProps) {
  const label = token.kind === 'skill' || token.kind === 'slash' ? `/${token.label}` : token.label;
  const interactive = token.kind === 'node' || token.kind === 'model';
  const activate = () => {
    if (token.kind === 'node' && token.id) {
      if (missing) onMissingNode();
      else onNodeActivate?.(token.id);
    }
    if (token.kind === 'model' && token.id) onModelActivate?.(token.id);
  };
  const content = (
    <>
      <span
        aria-hidden="true"
        className={`mr-1.5 h-3 w-0.5 shrink-0 rounded-full ${missing
          ? 'bg-red-300/65'
          : token.kind === 'node'
            ? 'bg-indigo-300/70'
            : token.kind === 'model'
              ? 'bg-sky-300/70'
              : 'bg-emerald-300/70'}`}
      />
      <span className="truncate">{label || '/'}</span>
      {token.kind === 'node' && token.displayId != null && (
        <span className="ml-1.5 shrink-0 border-l border-indigo-300/20 pl-1.5 text-[0.84em] font-semibold tabular-nums text-indigo-200/65">
          #{token.displayId}
        </span>
      )}
      {missing && <Icon icon="mdi:link-variant-off" width="12" className="ml-1.5 shrink-0" />}
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        onClick={activate}
        onMouseEnter={() => token.kind === 'node' && !missing && token.id && onNodeHover?.(token.id)}
        onMouseLeave={() => token.kind === 'node' && onNodeHover?.(null)}
        aria-label={missing
          ? `${label}，节点已不存在`
          : token.kind === 'node'
            ? `定位节点 ${label}`
            : `重新选择模型，当前为 ${label}`}
        data-tooltip={missing ? '节点已不存在' : token.kind === 'node' ? '在画布中定位' : '重新选择模型'}
        className={`mx-0.5 inline-flex max-w-full items-center rounded-[7px] border px-2 py-1 align-middle text-[0.92em] font-medium leading-none shadow-sm transition-[border-color,background-color,color,transform]
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50 active:scale-[0.98]
          ${missing
            ? 'border-red-400/25 bg-red-400/10 text-red-200/80'
            : `${COMPACT_TOKEN_CLASSES[token.kind]} hover:border-current hover:bg-canvas-hover/80`}`}
      >
        {content}
      </button>
    );
  }

  return (
    <span
      className={`mx-0.5 inline-flex max-w-full items-center rounded-[7px] border px-2 py-1 align-middle text-[0.92em] font-medium leading-none shadow-sm ${COMPACT_TOKEN_CLASSES[token.kind]}`}
    >
      {content}
    </span>
  );
}

export default function ChatReferenceText({
  value,
  compact = false,
  onNodeActivate,
  onNodeHover,
  onModelActivate,
}: InteractiveChatReferenceTextProps) {
  const nodes = useAppStore((state) => state.nodes);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const showToast = useAppStore((state) => state.showToast);
  const setHoveredMentionNodeId = useAppStore((state) => state.setHoveredMentionNodeId);
  const nodeDisplayIds = useMemo(
    () => new Map(nodes.map((node) => [node.id, node.data.displayId])),
    [nodes],
  );
  const tokens = parseReferenceTokens(value, nodeDisplayIds);
  if (tokens.length === 0) return <>{value}</>;

  const activateNode = onNodeActivate ?? ((nodeId: string) => {
    window.dispatchEvent(new CustomEvent('canvas-focus-node', { detail: { nodeId } }));
  });
  const hoverNode = onNodeHover ?? setHoveredMentionNodeId;
  const activateModel = onModelActivate ?? ((modelId: string) => {
    window.dispatchEvent(new CustomEvent('chat-open-reference-menu', {
      detail: { kind: 'model', modelId },
    }));
  });

  const content: React.ReactNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) content.push(value.slice(cursor, token.start));
    const missing = token.kind === 'node'
      && !!currentProjectId
      && !!token.id
      && !nodeDisplayIds.has(token.id);
    content.push(compact
      ? (
          <CompactToken
            key={`${token.start}-${token.raw}`}
            token={token}
            missing={missing}
            onMissingNode={() => showToast('引用的节点已不存在', 'error')}
            onNodeActivate={activateNode}
            onNodeHover={hoverNode}
            onModelActivate={activateModel}
          />
        )
      : (
          <span
            key={`${token.start}-${token.raw}`}
            className={INPUT_TOKEN_CLASSES[token.kind]}
          >
            {token.raw}
          </span>
        ));
    cursor = token.end;
  }
  if (cursor < value.length) content.push(value.slice(cursor));
  return <>{content}</>;
}

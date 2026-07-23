import { Icon } from '@iconify/react';
import type { WebSource } from '../../types/chat';
import { normalizePublicWebUrl } from '../../services/chat/webAccessGrantService';

interface SourceListProps {
  sources: WebSource[];
}

async function openExternalUrl(url: string): Promise<void> {
  const normalized = normalizePublicWebUrl(url);
  if (!normalized) return;
  try {
    await import('@tauri-apps/plugin-shell').then(({ open }) => open(normalized));
  } catch {
    window.open(normalized, '_blank', 'noopener,noreferrer');
  }
}

export default function SourceList({ sources }: SourceListProps) {
  if (sources.length === 0) return null;
  return (
    <details className="mt-3 border-t border-canvas-border/70 pt-2">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] text-canvas-text-secondary hover:text-canvas-text">
        <Icon icon="mdi:web" width="14" />
        来源（{sources.length}）
        <Icon icon="mdi:chevron-down" width="14" className="ml-auto" />
      </summary>
      <div className="mt-2 space-y-1.5">
        {sources.map((source, index) => (
          <button
            key={`${source.id}-${source.url}`}
            type="button"
            onClick={() => void openExternalUrl(source.url)}
            title={source.snippet}
            className="flex w-full items-start gap-2 rounded-md border border-canvas-border/60 bg-canvas-bg/50 px-2 py-1.5 text-left hover:bg-canvas-card"
          >
            <span className="mt-0.5 shrink-0 text-[11px] font-medium text-indigo-400">
              {source.citationId || `S${index + 1}`}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-canvas-text">{source.title}</span>
              <span className="block truncate text-[11px] text-canvas-text-muted">{source.domain}</span>
            </span>
            <Icon icon="mdi:open-in-new" width="13" className="mt-0.5 shrink-0 text-canvas-text-muted" />
          </button>
        ))}
      </div>
    </details>
  );
}

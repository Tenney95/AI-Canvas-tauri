import { memo, useState, useCallback } from 'react';
import type { BaseNodeData } from '../../../types';

interface TextNodeToolbarProps {
  nodeId: string;
  data: BaseNodeData;
  onCopy: (text: string) => void;
  onClearEmptyLines: () => void;
  onFullscreen: () => void;
}

function TextNodeToolbar({ data, onCopy, onClearEmptyLines, onFullscreen }: TextNodeToolbarProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!data.output) return;
      onCopy(data.output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
    [data.output, onCopy],
  );

  const handleClearEmptyLines = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!data.output) return;
      const cleaned = data.output.replace(/\n{3,}/g, '\n\n');
      if (cleaned !== data.output) {
        onClearEmptyLines();
      }
    },
    [data.output, onClearEmptyLines],
  );

  const handleFullscreen = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onFullscreen();
    },
    [onFullscreen],
  );

  return (
    <div className="node-floating-toolbar text-toolbar">
      <button
        className="ftb-btn icon-only act-copy"
        data-tooltip={copied ? '已复制' : '复制'}
        aria-label="复制"
        onClick={handleCopy}
      >
        {copied ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      <button
        className="ftb-btn icon-only act-clear-empty-lines"
        data-tooltip="清除空行"
        aria-label="清除空行"
        onClick={handleClearEmptyLines}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
          <path d="M4 6h16" />
          <path d="M4 12h16" />
          <path d="M4 18h8" />
          <path d="M18 15l3 3" />
          <path d="M21 15l-3 3" />
        </svg>
      </button>
      <button
        className="ftb-btn icon-only act-fullscreen"
        data-tooltip="全屏显示"
        aria-label="全屏显示"
        onClick={handleFullscreen}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
        </svg>
      </button>
    </div>
  );
}

export default memo(TextNodeToolbar);

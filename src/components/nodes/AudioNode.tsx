import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';

function AIAudioNode({ data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  return (
    <div className="node-wrapper" style={{ width: 260 }}>
      <NodeLabel kind="ai-audio" label={data.label || '生成音频'} displayId={data.displayId as number | undefined} isBeta />
      <div
        className={`node audio-node ${selected ? 'selected' : ''} ${data.status === 'loading' ? 'loading' : ''}`}
        style={{ minHeight: 140 }}
      >
        <div className="node-preview compact">
          {data.audioUrl ? (
            <audio src={data.audioUrl} controls className="audio-player" />
          ) : data.status === 'loading' ? (
            <div className="node-preview-loading">
              <div className="spinner" />
              <span>生成音频中...</span>
            </div>
          ) : (
            <div className="node-preview-placeholder">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
              <span>TTS 文本转语音</span>
            </div>
          )}
        </div>
        {data.error && <div className="node-error">{data.error}</div>}
        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-audio" />
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-audio" />
      </div>
    </div>
  );
}

export default memo(AIAudioNode);

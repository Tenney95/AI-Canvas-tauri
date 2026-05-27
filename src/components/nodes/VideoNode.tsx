import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';

function AIVideoNode({ data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  return (
    <div className="node-wrapper" style={{ width: 280 }}>
      <NodeLabel kind="ai-video" label={data.label || '生成视频'} displayId={data.displayId as number | undefined} />
      <div
        className={`node video-node ${selected ? 'selected' : ''} ${data.status === 'loading' ? 'loading' : ''}`}
        style={{ minHeight: 160 }}
      >
        <div className="node-preview compact">
          {data.videoUrl ? (
            <video
              src={data.videoUrl}
              className="video-preview-player compact"
              controls
              muted
            />
          ) : data.thumbnailUrl ? (
            <img
              src={data.thumbnailUrl}
              alt="Video thumbnail"
              className="image-preview-img compact"
            />
          ) : data.status === 'loading' ? (
            <div className="node-preview-loading">
              <div className="spinner large" />
              <span>生成视频中...</span>
            </div>
          ) : (
            <div className="node-preview-placeholder">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" />
              </svg>
            </div>
          )}
        </div>
        {data.error && <div className="node-error">{data.error}</div>}
        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-video" />
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-video" />
      </div>
    </div>
  );
}

export default memo(AIVideoNode);

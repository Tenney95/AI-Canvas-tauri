/**
 * VideoNode 视频节点 — 在画布上渲染视频内容，支持上传本地视频、播放控制、连接其他节点
 */
import { memo, useCallback } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import { useNodeRename } from './shared/useNodeRename';
import { useSourceFileUpload } from './shared/useSourceFileUpload';
import { useAppStore } from '../../store/useAppStore';

function AIVideoNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const isSource = data.role === 'source';

  // ── Upload handler for source nodes ──
  const { isUploading, handleUpload: doUpload } = useSourceFileUpload('.mp4,.webm,.avi,.mov,.mkv');

  const handleUpload = useCallback(async () => {
    const result = await doUpload();
    if (!result) return;
    updateNodeData(id, {
      videoUrl: result.dataUrl,
      filePath: result.filePath,
      fileName: result.fileName,
      label: result.fileName,
      status: 'success',
    } as Partial<BaseNodeData>);
  }, [doUpload, id, updateNodeData]);

  const { displayLabel, handleRename } = useNodeRename(id, data, '粘贴视频');

  return (
    <div className="node-wrapper" style={{ width: 280 }}>
      <NodeLabel
        kind="ai-video"
        label={displayLabel}
        displayId={data.displayId as number | undefined}
        nodeId={id}
        onRename={handleRename}
      />
      <div
        className={`node video-node ${selected ? 'selected' : ''} ${data.status === 'loading' || isUploading ? 'loading' : ''}`}
        style={{ minHeight: 160 }}
      >
        <div className="node-preview compact">
          {isSource && (
            <button
              className="node-upload-btn"
              onClick={(e) => { e.stopPropagation(); handleUpload(); }}
              data-tooltip="上传视频"
              aria-label="上传视频"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
          )}
          {data.videoUrl ? (
            <video
              src={data.videoUrl}
              className="video-preview-player compact"
              controls
              muted
              data-source-url={data.sourceUrl}
            />
          ) : data.thumbnailUrl ? (
            <img
              src={data.thumbnailUrl}
              alt="Video thumbnail"
              className="image-preview-img compact"
            />
          ) : isUploading ? (
            <div className="node-preview-loading">
              <div className="spinner large" />
              <span>上传中...</span>
            </div>
          ) : data.status === 'loading' ? (
            <div className="node-preview-loading">
              <div className="spinner large" />
              <span>生成视频中...</span>
            </div>
          ) : (
            <div className="node-preview-placeholder">
              {isSource ? (
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              ) : (
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <polygon points="23 7 16 12 23 17 23 7" />
                  <rect x="1" y="5" width="15" height="14" rx="2" />
                </svg>
              )}
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

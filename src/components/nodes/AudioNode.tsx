import { memo, useCallback, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import { useAppStore } from '../../store/useAppStore';
import { uploadSourceFile } from '../../services/fileService';

function AIAudioNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const isSource = data.role === 'source';

  // ── Upload handler for source nodes ──
  const [isUploading, setIsUploading] = useState(false);

  const handleUpload = useCallback(async () => {
    setIsUploading(true);
    try {
      const result = await uploadSourceFile('.mp3,.wav,.ogg,.flac,.aac,.m4a,.wma');
      if (!result) return;

      updateNodeData(id, {
        audioUrl: result.dataUrl,
        fileName: result.fileName,
        label: result.fileName,
        status: 'success',
      } as Partial<BaseNodeData>);
    } catch {
      // silently ignore
    } finally {
      setIsUploading(false);
    }
  }, [id, updateNodeData]);

  // ── Display label ──
  const displayLabel = data.fileName || data.label || '粘贴音频';

  return (
    <div className="node-wrapper" style={{ width: 260 }}>
      <NodeLabel
        kind="ai-audio"
        label={displayLabel}
        displayId={data.displayId as number | undefined}
        isBeta={!isSource}
      />
      <div
        className={`node audio-node ${selected ? 'selected' : ''} ${data.status === 'loading' || isUploading ? 'loading' : ''}`}
        style={{ minHeight: 140 }}
      >
        <div className="node-preview compact">
          {isSource && (
            <button
              className="node-upload-btn"
              onClick={(e) => { e.stopPropagation(); handleUpload(); }}
              title="上传音频"
              aria-label="上传音频"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
          )}
          {data.audioUrl ? (
            <audio src={data.audioUrl} controls className="audio-player" />
          ) : isUploading ? (
            <div className="node-preview-loading">
              <div className="spinner" />
              <span>上传中...</span>
            </div>
          ) : data.status === 'loading' ? (
            <div className="node-preview-loading">
              <div className="spinner" />
              <span>生成音频中...</span>
            </div>
          ) : (
            <div className="node-preview-placeholder">
              {isSource ? (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              ) : (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              )}
              <span>{isSource ? '上传音频文件' : 'TTS 文本转语音'}</span>
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

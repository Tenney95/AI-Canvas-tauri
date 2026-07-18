/**
 * AnimationNode — 2D 角色 Sprite Sheet 生成与逐帧预览节点
 */
import { memo, useCallback, useEffect, useState } from 'react';
import { Icon } from '@iconify/react';
import { Handle, Position } from '@xyflow/react';
import type { AnimationPreviewMode, BaseNodeData } from '../../types';
import { ANIMATION_ACTION_LABELS, ANIMATION_FRAME_GRIDS } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { useCompletionFlash } from '../../hooks/useCompletionFlash';
import NodeLabel from './shared/NodeLabel';
import NodeError from './shared/NodeError';
import GooeyBtn from './shared/GooeyBtn';
import ResizeHandle from './shared/ResizeHandle';
import { useNodeRename } from './shared/useNodeRename';

function parseAspectRatio(value: unknown) {
  if (typeof value !== 'string') return null;
  const [width, height] = value.split(':').map(Number);
  return width > 0 && height > 0 ? width / height : null;
}

function AnimationNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const updateNodeDataTransient = useAppStore((s) => s.updateNodeDataTransient);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const justCompleted = useCompletionFlash(data.status);
  const nodeWidth = (data.nodeWidth as number) || 320;
  // 预览区宽高始终一致：节点总高 = 4px 顶边距 + 正方形预览 + 42px 参数栏
  const nodeHeight = nodeWidth + 38;
  const action = data.animationAction ?? 'idle';
  const frameCount = data.animationFrames ?? 8;
  const previewMode = data.animationPreviewMode ?? 'playing';
  const displaySrc = (data.imageUrl || data.thumbnailUrl) as string | undefined;
  const grid = ANIMATION_FRAME_GRIDS[frameCount];
  const [frameIndex, setFrameIndex] = useState(0);
  const { displayLabel, handleRename } = useNodeRename(id, data, '生成动画');

  useEffect(() => {
    setFrameIndex(0);
    if (!displaySrc || previewMode !== 'playing') return;
    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frameCount);
    }, 125);
    return () => window.clearInterval(timer);
  }, [displaySrc, frameCount, previewMode]);

  const handlePreviewModeChange = useCallback((mode: AnimationPreviewMode) => {
    updateNodeDataTransient(id, { animationPreviewMode: mode });
  }, [id, updateNodeDataTransient]);

  const handleResize = useCallback((width: number) => {
    updateNodeDataTransient(id, { nodeWidth: width, nodeHeight: width + 38 });
  }, [id, updateNodeDataTransient]);

  const column = frameIndex % grid.cols;
  const row = Math.floor(frameIndex / grid.cols);
  const generatedSheetAspect = data.imageWidth && data.imageHeight
    ? data.imageWidth / data.imageHeight
    : null;
  const sheetAspect = generatedSheetAspect
    ?? parseAspectRatio(data.aspectRatio)
    ?? grid.cols / grid.rows;
  const cellAspect = sheetAspect * grid.rows / grid.cols;
  const cellWidthPercent = cellAspect >= 1 ? 100 : cellAspect * 100;
  const cellHeightPercent = cellAspect >= 1 ? 100 / cellAspect : 100;
  const frameImageStyle: React.CSSProperties = {
    width: `${cellWidthPercent * grid.cols}%`,
    height: `${cellHeightPercent * grid.rows}%`,
    left: `${(100 - cellWidthPercent) / 2 - column * cellWidthPercent}%`,
    top: `${(100 - cellHeightPercent) / 2 - row * cellHeightPercent}%`,
  };

  return (
    <div className="node-wrapper relative" style={{ width: nodeWidth }}>
      <NodeLabel
        kind="ai-animation"
        label={displayLabel}
        displayId={data.displayId as number | undefined}
        nodeId={id}
        onRename={handleRename}
      />

      <div
        className={`node animation-node ${selected ? 'selected' : ''} ${data.status === 'loading' ? 'loading' : ''} ${justCompleted ? 'just-completed' : ''}`}
        style={{ height: nodeHeight }}
      >
        <div className="animation-preview">
          {displaySrc ? (
            previewMode === 'playing' ? (
              <div className="animation-frame" role="img" aria-label={`${ANIMATION_ACTION_LABELS[action]}动画第 ${frameIndex + 1} 帧`}>
                <img className="animation-frame-sheet" src={displaySrc} alt="" style={frameImageStyle} draggable={false} />
              </div>
            ) : (
              <img className="animation-sheet" src={displaySrc} alt={`${ANIMATION_ACTION_LABELS[action]} Sprite Sheet`} draggable={false} />
            )
          ) : data.status === 'loading' ? (
            <div className="animation-empty">
              <div className="spinner large" />
              <span>正在生成 Sprite Sheet</span>
            </div>
          ) : (
            <div className="animation-empty">
              <Icon icon="mdi:animation-play-outline" width="38" height="38" />
              <span>点击节点描述角色并生成</span>
              <small>{ANIMATION_ACTION_LABELS[action]} · {frameCount} 帧 · {grid.cols}×{grid.rows}</small>
            </div>
          )}

          <div className="animation-preview-switch nodrag nopan" aria-label="预览模式">
            <button
              type="button"
              className={previewMode === 'playing' ? 'active' : ''}
              data-tooltip="动图状态"
              aria-label="动图状态"
              aria-pressed={previewMode === 'playing'}
              onClick={(event) => { event.stopPropagation(); handlePreviewModeChange('playing'); }}
            >
              <Icon icon="mdi:play" width="13" height="13" />
            </button>
            <button
              type="button"
              className={previewMode === 'sheet' ? 'active' : ''}
              data-tooltip="静态排布状态"
              aria-label="静态排布状态"
              aria-pressed={previewMode === 'sheet'}
              onClick={(event) => { event.stopPropagation(); handlePreviewModeChange('sheet'); }}
            >
              <Icon icon="mdi:grid" width="13" height="13" />
            </button>
          </div>
        </div>

        <div className="animation-param-bar nodrag nopan">
          <span className="animation-param-action">
            <Icon icon="mdi:motion-play-outline" width="14" height="14" />
            {ANIMATION_ACTION_LABELS[action]}
          </span>
        </div>

        {data.error && <NodeError nodeId={id} message={data.error} />}
        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-animation">
          <GooeyBtn className="gooey-btn-left" hue={292} />
        </Handle>
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-animation">
          <GooeyBtn className="gooey-btn-right" hue={292} />
        </Handle>
      </div>

      <ResizeHandle
        nodeId={id}
        currentWidth={nodeWidth}
        currentHeight={nodeHeight}
        minWidth={280}
        minHeight={318}
        onResizeStart={commitToHistory}
        onResizeEnd={commitToHistory}
        onResize={handleResize}
      />
    </div>
  );
}

export default memo(AnimationNode);

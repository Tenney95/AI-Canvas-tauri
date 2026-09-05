/**
 * AnimationNode — 2D 角色 Sprite Sheet 生成与逐帧预览节点
 */
import { memo, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Icon } from '@iconify/react';
import { Handle, Position } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import type { AnimationPreviewMode, BaseNodeData } from '../../types';
import { ANIMATION_ACTION_LABELS, ANIMATION_FRAME_GRIDS } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { useCompletionFlash } from '../../hooks/useCompletionFlash';
import { buildAnimationReskinPrompt } from '../../services/ai/animationPrompt';
import { collectConnectedReferenceMedia } from '../../services/ai/connectedReferenceMedia';
import { exportSpriteFrames } from '../../services/spriteExportService';
import { batchExecuteNodes } from '../../utils/batchExecute';
import { createPresetNode } from './shared/toolbar/presetAction';
import NodeLabel from './shared/NodeLabel';
import NodeError from './shared/NodeError';
import GooeyBtn from './shared/GooeyBtn';
import ResizeHandle from './shared/ResizeHandle';
import { useNodeRename } from './shared/useNodeRename';
import { useT } from '../../i18n';
import NodeGenerationProgress from './shared/NodeGenerationProgress';

const pageVisibilityListeners = new Set<() => void>();
let listeningForPageVisibility = false;

function handlePageVisibilityChange() {
  pageVisibilityListeners.forEach((listener) => listener());
}

function subscribeToPageVisibility(listener: () => void) {
  pageVisibilityListeners.add(listener);
  if (!listeningForPageVisibility) {
    document.addEventListener('visibilitychange', handlePageVisibilityChange);
    listeningForPageVisibility = true;
  }
  return () => {
    pageVisibilityListeners.delete(listener);
    if (pageVisibilityListeners.size === 0 && listeningForPageVisibility) {
      document.removeEventListener('visibilitychange', handlePageVisibilityChange);
      listeningForPageVisibility = false;
    }
  };
}

function usePageVisible() {
  return useSyncExternalStore(
    subscribeToPageVisibility,
    () => !document.hidden,
    () => true,
  );
}

function parseAspectRatio(value: unknown) {
  if (typeof value !== 'string') return null;
  const [width, height] = value.split(':').map(Number);
  return width > 0 && height > 0 ? width / height : null;
}

function AnimationNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const t = useT();
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
  const fps = data.animationFps ?? 8;
  const loop = data.animationLoop ?? true;
  const [frameIndex, setFrameIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reskinning, setReskinning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const pageVisible = usePageVisible();
  const { displayLabel, handleRename } = useNodeRename(id, data, t('生成动画'));
  const visibleFrameIndex = frameIndex % frameCount;

  // 单次播放走到末帧即停：由此推出「停住」，定时器随之拆掉，不需要额外的 setState
  const endedOnce = !loop && visibleFrameIndex === frameCount - 1;
  const stopped = paused || endedOnce;

  useEffect(() => {
    if (!pageVisible || !displaySrc || previewMode !== 'playing' || stopped) return;
    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frameCount);
    }, 1000 / fps);
    return () => window.clearInterval(timer);
  }, [displaySrc, fps, frameCount, pageVisible, previewMode, stopped]);

  const handleTogglePlay = useCallback(() => {
    // 单次播放停在末帧后再点播放，从头放一遍
    if (endedOnce) {
      setFrameIndex(0);
      setPaused(false);
      return;
    }
    setPaused((current) => !current);
  }, [endedOnce]);

  const handleStepFrame = useCallback((delta: number) => {
    setPaused(true);
    setFrameIndex((current) => (current % frameCount + delta + frameCount) % frameCount);
  }, [frameCount]);

  const handleExport = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    const store = useAppStore.getState();
    const filePath = data.filePath as string | undefined;
    if (!filePath) {
      store.showToast(t('该节点没有本地文件，无法切帧导出'), 'error');
      return;
    }
    setExporting(true);
    try {
      const result = await exportSpriteFrames({
        inputPath: filePath,
        defaultName: `${displayLabel}_${action}_${frameCount}f`,
        cols: grid.cols,
        rows: grid.rows,
        frameCount,
        fps,
      });
      if (result) {
        store.showToast(result.files.length > 1
          ? t('已导出 {count} 张序列帧（{w}×{h}）', { count: result.files.length, w: result.frame_width, h: result.frame_height })
          : t('GIF 已导出（{w}×{h} · {fps}fps）', { w: result.frame_width, h: result.frame_height, fps }));
      }
    } catch (error) {
      store.showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setExporting(false);
    }
  }, [action, data.filePath, displayLabel, fps, frameCount, grid.cols, grid.rows, t]);

  const handlePreviewModeChange = useCallback((mode: AnimationPreviewMode) => {
    updateNodeDataTransient(id, { animationPreviewMode: mode });
  }, [id, updateNodeDataTransient]);

  const handleResize = useCallback((width: number) => {
    updateNodeDataTransient(id, { nodeWidth: width, nodeHeight: width + 38 });
  }, [id, updateNodeDataTransient]);

  // 一键换皮：本节点的 Sprite Sheet 当姿势母版，连入的角色图当新外观，出一张同动作新 sheet
  const handleReskin = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    const store = useAppStore.getState();
    const sourceNode = store.nodes.find((n) => n.id === id) as Node<BaseNodeData> | undefined;
    if (!sourceNode) return;

    const skinRefs = collectConnectedReferenceMedia(id).references
      .filter((ref) => ref.kind === 'image' && ref.sourceNodeId);
    if (skinRefs.length === 0) {
      store.showToast(t('请先把新角色的图片节点连到该动画节点'), 'error');
      return;
    }

    const mentionOf = (nodeId: string, fallback: string) => {
      const target = store.nodes.find((n) => n.id === nodeId);
      const label = (target?.data.label || target?.data.fileName || fallback).replace(/[{}:]/g, '');
      return `@{${nodeId}:${label}}`;
    };
    const sourceLabel = (sourceNode.data.label || '生成动画').replace(/[{}:]/g, '');
    const { node, edge } = createPresetNode(sourceNode, {
      label: `${sourceLabel} 换皮`,
      icon: 'mdi:hanger',
      filledPrompt: '',
      shouldTrigger: true,
    });
    const reskinNode: Node<BaseNodeData> = {
      ...node,
      data: {
        ...node.data,
        // createPresetNode 只拼了源节点引用，换皮提示词整体重写
        prompt: buildAnimationReskinPrompt(
          mentionOf(id, '生成动画'),
          skinRefs.map((ref) => mentionOf(ref.sourceNodeId!, '角色图')),
        ),
        animationAction: action,
        animationFrames: frameCount,
        animationPreviewMode: previewMode,
        nodeWidth,
        nodeHeight,
      },
    };
    store.addNodeWithEdge(reskinNode, edge);

    setReskinning(true);
    const live = useAppStore.getState();
    const { ok, fail } = await batchExecuteNodes([reskinNode.id], live.nodes, live.edges, {
      commitToHistory: live.commitToHistory,
      updateNodeDataTransient: live.updateNodeDataTransient,
      recordOutputHistory: live.recordOutputHistory,
      currentProjectId: live.currentProjectId,
    });
    setReskinning(false);
    if (ok) live.showToast(t('换皮完成'));
    else live.showToast(fail ? t('换皮失败') : t('请先为该节点选择模型'), 'error');
  }, [action, frameCount, id, nodeHeight, nodeWidth, previewMode, t]);

  const column = visibleFrameIndex % grid.cols;
  const row = Math.floor(visibleFrameIndex / grid.cols);
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
              <div className="animation-frame" role="img" aria-label={t('{action}动画第 {index} 帧', { action: t(ANIMATION_ACTION_LABELS[action]), index: visibleFrameIndex + 1 })}>
                <img className="animation-frame-sheet" src={displaySrc} alt="" style={frameImageStyle} draggable={false} />
              </div>
            ) : (
              <img className="animation-sheet" src={displaySrc} alt={t('{action} Sprite Sheet', { action: t(ANIMATION_ACTION_LABELS[action]) })} draggable={false} />
            )
          ) : data.status === 'loading' ? (
            <NodeGenerationProgress nodeId={id} fallbackLabel={t('正在生成 Sprite Sheet')} />
          ) : (
            <div className="animation-empty">
              <Icon icon="mdi:animation-play-outline" width="38" height="38" />
              <span>{t('点击节点描述角色并生成')}</span>
              <small>{t(ANIMATION_ACTION_LABELS[action])} · {t('{count} 帧', { count: frameCount })} · {grid.cols}×{grid.rows}</small>
            </div>
          )}

          {displaySrc && data.status === 'loading' && (
            <NodeGenerationProgress nodeId={id} fallbackLabel={t('正在生成 Sprite Sheet')} overlay />
          )}

          <div className="animation-preview-switch nodrag nopan" aria-label={t('预览模式')}>
            <button
              type="button"
              className={previewMode === 'playing' ? 'active' : ''}
              data-tooltip={t('动图状态')}
              aria-label={t('动图状态')}
              aria-pressed={previewMode === 'playing'}
              onClick={(event) => { event.stopPropagation(); handlePreviewModeChange('playing'); }}
            >
              <Icon icon="mdi:play" width="13" height="13" />
            </button>
            <button
              type="button"
              className={previewMode === 'sheet' ? 'active' : ''}
              data-tooltip={t('静态排布状态')}
              aria-label={t('静态排布状态')}
              aria-pressed={previewMode === 'sheet'}
              onClick={(event) => { event.stopPropagation(); handlePreviewModeChange('sheet'); }}
            >
              <Icon icon="mdi:grid" width="13" height="13" />
            </button>
          </div>

          {displaySrc && previewMode === 'playing' && (
            <div className="animation-transport nodrag nopan" aria-label={t('播放控制')}>
              <button
                type="button"
                data-tooltip={stopped ? t('播放') : t('暂停')}
                aria-label={stopped ? t('播放') : t('暂停')}
                onClick={(event) => { event.stopPropagation(); handleTogglePlay(); }}
              >
                <Icon icon={stopped ? 'mdi:play' : 'mdi:pause'} width="13" height="13" />
              </button>
              <button
                type="button"
                data-tooltip={t('上一帧')}
                aria-label={t('上一帧')}
                onClick={(event) => { event.stopPropagation(); handleStepFrame(-1); }}
              >
                <Icon icon="mdi:skip-previous" width="13" height="13" />
              </button>
              <span className="animation-transport-counter">{visibleFrameIndex + 1}/{frameCount}</span>
              <button
                type="button"
                data-tooltip={t('下一帧')}
                aria-label={t('下一帧')}
                onClick={(event) => { event.stopPropagation(); handleStepFrame(1); }}
              >
                <Icon icon="mdi:skip-next" width="13" height="13" />
              </button>
              <input
                type="range"
                className="animation-fps-range"
                min={1}
                max={24}
                step={1}
                value={fps}
                data-tooltip={`${fps} fps`}
                aria-label={t('播放帧率')}
                onChange={(event) => {
                  updateNodeDataTransient(id, { animationFps: Number(event.target.value) });
                }}
                onPointerDown={(event) => event.stopPropagation()}
              />
              <span className="animation-transport-counter">{fps}</span>
              <button
                type="button"
                className={loop ? 'active' : ''}
                data-tooltip={loop ? t('循环播放') : t('单次播放')}
                aria-label={loop ? t('循环播放') : t('单次播放')}
                aria-pressed={loop}
                onClick={(event) => {
                  event.stopPropagation();
                  updateNodeDataTransient(id, { animationLoop: !loop });
                  if (loop) return;
                  setFrameIndex(0);
                  setPaused(false);
                }}
              >
                <Icon icon={loop ? 'mdi:repeat' : 'mdi:repeat-once'} width="13" height="13" />
              </button>
            </div>
          )}
        </div>

        <div className="animation-param-bar nodrag nopan">
          <span className="animation-param-action">
            <Icon icon="mdi:motion-play-outline" width="14" height="14" />
            {t(ANIMATION_ACTION_LABELS[action])}
          </span>
          {displaySrc && (
            <span className="animation-param-actions">
              <button
                type="button"
                className="animation-param-btn"
                data-tooltip={t('切帧导出：选 .gif 出动图，选 .png 出序列帧')}
                disabled={exporting}
                onClick={handleExport}
              >
                {exporting
                  ? <span className="spinner-sm" />
                  : <Icon icon="mdi:tray-arrow-down" width="13" height="13" />}
                {t('导出')}
              </button>
              <button
                type="button"
                className="animation-param-btn"
                data-tooltip={t('一键换皮：用连入的角色图替换外观，保留骨骼与动作')}
                disabled={reskinning}
                onClick={handleReskin}
              >
                {reskinning
                  ? <span className="spinner-sm" />
                  : <Icon icon="mdi:hanger" width="13" height="13" />}
                {t('换皮')}
              </button>
            </span>
          )}
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

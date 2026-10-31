/**
 * AnimationNode — 2D 角色 Sprite Sheet 生成与逐帧预览节点
 */
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Icon } from '@iconify/react';
import { Handle, Position } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import type { AnimationAction, AnimationPreviewMode, BaseNodeData } from '../../types';
import { ANIMATION_ACTION_LABELS, ANIMATION_FRAME_GRIDS } from '../../types';
import type { AnimationFrameCount } from '../../services/ai/animationPrompt';
import { animationSheet, animationProcessing, animationEdits, animationFrameStyle, prepareAnimationPreview, type AnimationPreview } from '../../services/animationService';
import { useAppStore } from '../../store/useAppStore';
import { useCompletionFlash } from '../../hooks/useCompletionFlash';
import { useComfyImageSource } from '../../hooks/useComfyImageSource';
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

const AnimationEditor = lazy(() => import('./shared/AnimationEditor'));

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
  const projectId = useAppStore((s) => s.currentProjectId);
  const updateNodeDataTransient = useAppStore((s) => s.updateNodeDataTransient);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const justCompleted = useCompletionFlash(data.status);
  const nodeWidth = (data.nodeWidth as number) || 320;
  // 预览区宽高始终一致：节点总高 = 4px 顶边距 + 正方形预览 + 42px 参数栏
  const nodeHeight = nodeWidth + 38;
  const { animationSheet: storedSheet, animationFrames, animationAction, animationProcessing: storedProcessing, animationEdits: storedEdits } = data;
  const sheet = useMemo(() => animationSheet({ animationSheet: storedSheet, animationFrames, animationAction }), [storedSheet, animationFrames, animationAction]);
  const action = (Object.hasOwn(ANIMATION_ACTION_LABELS, sheet.action) ? sheet.action : data.animationAction ?? 'idle') as AnimationAction;
  const processing = useMemo(() => animationProcessing({ animationSheet: storedSheet, animationFrames, animationAction, animationProcessing: storedProcessing }), [storedProcessing, storedSheet, animationFrames, animationAction]);
  const edits = useMemo(() => animationEdits({ animationSheet: storedSheet, animationFrames, animationAction, animationEdits: storedEdits }), [storedEdits, storedSheet, animationFrames, animationAction]);
  const playingFrames = edits.filter((edit) => edit.enabled);
  const frameCount = playingFrames.length;
  const previewMode = data.animationPreviewMode ?? 'playing';
  const originalSrc = (data.imageUrl || data.thumbnailUrl) as string | undefined;
  const grid = sheet;
  const fps = Math.min(24, Math.max(1, data.animationFps ?? 8));
  const loop = data.animationLoop ?? true;
  const [frameIndex, setFrameIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reskinning, setReskinning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [previewState, setPreviewState] = useState<{ key: string; value?: AnimationPreview; error?: string }>();
  const pageVisible = usePageVisible();
  const previewKey = JSON.stringify([projectId, data.filePath, sheet, processing]);
  const preview = previewState?.key === previewKey ? previewState.value : undefined;
  const processingError = previewState?.key === previewKey ? previewState.error : undefined;
  // 离屏后会重新挂载；先等透明缓存，避免键控底色原图闪现。
  const preparingPreview = !!data.filePath && !preview && !processingError;
  const displaySrc = useComfyImageSource(preview?.url ?? (preparingPreview ? undefined : originalSrc));
  useEffect(() => {
    if (!data.filePath || !pageVisible) return;
    let active = true;
    let prepared: AnimationPreview | undefined;
    void prepareAnimationPreview(data.filePath, sheet, processing, projectId).then((value) => {
      if (!active) { value.dispose(); return; }
      prepared = value;
      setPreviewState({ key: previewKey, value });
    }).catch((error: unknown) => {
      if (active) setPreviewState({ key: previewKey, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { active = false; prepared?.dispose(); };
  }, [data.filePath, pageVisible, previewKey, processing, projectId, sheet]);
  const { displayLabel: storedLabel, handleRename } = useNodeRename(id, data, t('帧动画'));
  const displayLabel = !data.displayLabel && !data.fileName && ['生成动画', '动画'].includes(storedLabel)
    ? t('帧动画') : storedLabel;
  const openEditor = () => {
    useAppStore.getState().closeNodeDialog();
    setEditorOpen(true);
  };
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

  const handleTogglePlay = () => {
    // 单次播放停在末帧后再点播放，从头放一遍
    if (endedOnce) {
      setFrameIndex(0);
      setPaused(false);
      return;
    }
    setPaused((current) => !current);
  };

  const handleStepFrame = (delta: number) => {
    setPaused(true);
    setFrameIndex((current) => (current % frameCount + delta + frameCount) % frameCount);
  };

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
        frameCount: sheet.frameCount,
        fps,
        processing,
        edits,
        loop,
        action: sheet.action,
      });
      if (result) {
        store.showToast(result.format === 'json' ? t('PNG 图集与 JSON 元数据已导出') : result.format === 'png'
          ? t('已导出 {count} 张序列帧（{w}×{h}）', { count: result.files.length, w: result.frame_width, h: result.frame_height })
          : t('GIF 已导出（{w}×{h} · {fps}fps）', { w: result.frame_width, h: result.frame_height, fps }));
      }
    } catch (error) {
      store.showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setExporting(false);
    }
  }, [action, data.filePath, displayLabel, edits, fps, frameCount, grid.cols, grid.rows, loop, processing, sheet, t]);

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
    const reskinFrames = sheet.frameCount as AnimationFrameCount;
    const reskinGrid = ANIMATION_FRAME_GRIDS[reskinFrames];
    if (!reskinGrid || reskinGrid.cols !== sheet.cols || reskinGrid.rows !== sheet.rows) {
      store.showToast(t('自定义宫格请通过提示词重新生成；一键换皮支持标准生成宫格'), 'error');
      return;
    }

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
    const sourceLabel = (sourceNode.data.label || '帧动画').replace(/[{}:]/g, '');
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
          mentionOf(id, '帧动画'),
          skinRefs.map((ref) => mentionOf(ref.sourceNodeId!, '角色图')),
        ),
        animationAction: action,
        animationFrames: reskinFrames,
        animationProcessing: processing,
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
      currentProjectId: live.currentProjectId,
    });
    setReskinning(false);
    if (useAppStore.getState().currentProjectId !== live.currentProjectId) return;
    if (ok) live.showToast(t('换皮完成'));
    else live.showToast(fail ? t('换皮失败') : t('请先为该节点选择模型'), 'error');
  }, [action, id, nodeHeight, nodeWidth, previewMode, processing, sheet, t]);

  const currentEdit = playingFrames[visibleFrameIndex];
  const layout = preview ?? { cols: grid.cols, rows: grid.rows, cellWidth: (data.imageWidth ?? grid.cols) / grid.cols, cellHeight: (data.imageHeight ?? grid.rows) / grid.rows };
  const column = currentEdit.sourceIndex % layout.cols;
  const row = Math.floor(currentEdit.sourceIndex / layout.cols);
  const generatedSheetAspect = data.imageWidth && data.imageHeight
    ? data.imageWidth / data.imageHeight
    : null;
  const sheetAspect = generatedSheetAspect
    ?? parseAspectRatio(data.aspectRatio)
    ?? grid.cols / grid.rows;
  const cellAspect = preview ? preview.cellWidth / preview.cellHeight : sheetAspect * layout.rows / layout.cols;
  const cellWidthPercent = cellAspect >= 1 ? 100 : cellAspect * 100;
  const cellHeightPercent = cellAspect >= 1 ? 100 / cellAspect : 100;
  const frameImageStyle: React.CSSProperties = {
    clipPath: animationFrameStyle(layout, currentEdit).clipPath,
    width: `${cellWidthPercent * layout.cols}%`,
    height: `${cellHeightPercent * layout.rows}%`,
    left: `${(100 - cellWidthPercent) / 2 - column * cellWidthPercent + currentEdit.offsetX / layout.cellWidth * cellWidthPercent}%`,
    top: `${(100 - cellHeightPercent) / 2 - row * cellHeightPercent + currentEdit.offsetY / layout.cellHeight * cellHeightPercent}%`,
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
        onDoubleClick={(event) => {
          event.stopPropagation();
          if ((event.target as Element).closest('button, input, select, textarea, a, [role="button"], [contenteditable="true"], .react-flow__handle')) return;
          openEditor();
        }}
      >
        <div className="animation-preview">
          {displaySrc ? (
            previewMode === 'playing' ? (
              <div className="animation-frame" role="img" aria-label={t('{action}动画第 {index} 帧', { action: t(ANIMATION_ACTION_LABELS[action]), index: visibleFrameIndex + 1 })}>
                <img className="animation-frame-sheet" src={displaySrc} alt="" style={frameImageStyle} draggable={false} />
              </div>
            ) : (
              <div className="animation-curated-sheet" style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))` }}>
                {playingFrames.map((edit) => <div key={edit.sourceIndex} className="animation-cell" style={{ aspectRatio: `${layout.cellWidth} / ${layout.cellHeight}` }}>
                  <img className="animation-frame-sheet" src={displaySrc} alt={t('第 {index} 帧', { index: edit.sourceIndex + 1 })} style={animationFrameStyle(layout, edit)} draggable={false} />
                </div>)}
              </div>
            )
          ) : data.status === 'loading' ? (
            <NodeGenerationProgress nodeId={id} fallbackLabel={t('正在生成 Sprite Sheet')} />
          ) : preparingPreview ? (
            <div className="animation-empty" role="status">
              <span className="spinner-sm" aria-hidden="true" />
              <span>{t('加载帧动画预览')}</span>
            </div>
          ) : (
            <div className="animation-empty">
              <Icon icon="mdi:animation-play-outline" width="38" height="38" />
              <span>{t('双击编辑帧动画')}</span>
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
                onPointerDown={(event) => { event.stopPropagation(); commitToHistory(); }}
                onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) commitToHistory(); }}
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
                  updateNodeData(id, { animationLoop: !loop });
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
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={t('编辑帧动画')} onClick={(event) => { event.stopPropagation(); openEditor(); }}>
            <Icon icon="mdi:tune" width="13" />{t('编辑')}
          </button>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={t('生成帧动画')} data-tooltip={t('生成帧动画')} onClick={(event) => { event.stopPropagation(); useAppStore.getState().openNodeDialog(id); }}>
            <Icon icon="mdi:creation-outline" width="13" />{!displaySrc && t('生成')}
          </button>
          {displaySrc && (
            <span className="animation-param-actions">
              <button
                type="button"
                className="animation-param-btn"
                data-tooltip={t('导出 GIF、PNG 序列帧或 JSON 图集')}
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
        {processingError && <div className="animation-processing-hint" role="status">{processingError}</div>}
        {!processingError && !!preview?.warnings.length && <div className="animation-processing-hint" role="status">{preview.warnings[0]}</div>}
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
      {editorOpen && <Suspense fallback={null}><AnimationEditor nodeId={id} onClose={() => setEditorOpen(false)} /></Suspense>}
    </div>
  );
}

export default memo(AnimationNode);

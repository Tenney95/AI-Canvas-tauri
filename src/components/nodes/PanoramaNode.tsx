/**
 * PanoramaNode 360全景图节点
 * 使用 XiaoLuo-Panorama 的嵌入式核心，支持节点内预览、全屏漫游与截图。
 */
import { Icon } from '@iconify/react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import NodeError from './shared/NodeError';
import GooeyBtn from './shared/GooeyBtn';
import ResizeHandle from './shared/ResizeHandle';
import PanoramaNodeToolbar from './shared/PanoramaNodeToolbar';
import FullscreenOverlay from '../shared/FullscreenOverlay';
import AnimatedButton from '../shared/AnimatedButton';
import QualityRatioSelector from './shared/QualityRatioSelector';
import XiaoLuoPanoramaViewer, {
  type XiaoLuoPanoramaViewerHandle,
} from './panorama/XiaoLuoPanoramaViewer';
import { useNodeRename } from './shared/useNodeRename';
import { useSourceFileUpload } from './shared/useSourceFileUpload';
import { useAppStore, generateId } from '../../store/useAppStore';
import { saveDataUrlToProjectData, buildNodeFileName } from '../../services/fileService';
import { useCompletionFlash } from '../../hooks/useCompletionFlash';

function ratioToNumber(ratio: string): number | null {
  if (!ratio || ratio === '自适应') return null;
  const [width, height] = ratio.split(':').map(Number);
  if (!width || !height) return null;
  return width / height;
}

function AIPanoramaNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const justCompleted = useCompletionFlash(data.status);
  const updateNodeData = useAppStore((state) => state.updateNodeData);
  const updateNodeDataTransient = useAppStore((state) => state.updateNodeDataTransient);
  const commitToHistory = useAppStore((state) => state.commitToHistory);
  const nodeWidth = (data.nodeWidth as number) || 280;
  const nodeHeight = (data.nodeHeight as number) || 200;

  const compactViewerRef = useRef<XiaoLuoPanoramaViewerHandle>(null);
  const fullscreenViewerRef = useRef<XiaoLuoPanoramaViewerHandle>(null);
  const [captureRatio, setCaptureRatio] = useState('自适应');
  const fsStageRef = useRef<HTMLDivElement>(null);
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 });

  const previewMode = (data.previewMode as 'image' | '360') || 'image';
  const isFullscreen = (data.panoFullscreen as boolean) || false;
  const captureAspect = ratioToNumber(captureRatio);
  const panoramaUrl = data.imageUrl || data.thumbnailUrl || '';

  const handleResize = useCallback(
    (newWidth: number, newHeight: number) => {
      updateNodeDataTransient(id, { nodeWidth: newWidth, nodeHeight: newHeight } as Partial<BaseNodeData>);
    },
    [id, updateNodeDataTransient],
  );

  useEffect(() => {
    if (!isFullscreen) return;
    const element = fsStageRef.current;
    if (!element) return;
    const updateStageBox = () => setStageBox({ w: element.clientWidth, h: element.clientHeight });
    const resizeObserver = new ResizeObserver(updateStageBox);
    resizeObserver.observe(element);
    updateStageBox();
    return () => resizeObserver.disconnect();
  }, [isFullscreen]);

  const captureFrame = (() => {
    if (!captureAspect || !stageBox.w || !stageBox.h) return null;
    let width: number;
    let height: number;
    if (stageBox.w / stageBox.h > captureAspect) {
      height = stageBox.h;
      width = height * captureAspect;
    } else {
      width = stageBox.w;
      height = width / captureAspect;
    }
    return {
      x: (stageBox.w - width) / 2,
      y: (stageBox.h - height) / 2,
      w: width,
      h: height,
    };
  })();

  const toggleMode = useCallback(() => {
    updateNodeDataTransient(id, {
      previewMode: previewMode === '360' ? 'image' : '360',
    } as Partial<BaseNodeData>);
  }, [id, previewMode, updateNodeDataTransient]);

  const toggleFullscreen = useCallback(() => {
    updateNodeDataTransient(id, { panoFullscreen: !isFullscreen } as Partial<BaseNodeData>);
  }, [id, isFullscreen, updateNodeDataTransient]);

  const handleScreenshot = useCallback(async () => {
    const aspect = isFullscreen ? ratioToNumber(captureRatio) : null;
    const activeViewer = isFullscreen ? fullscreenViewerRef.current : compactViewerRef.current;
    const dataUrl = await activeViewer?.captureScreenshot(aspect);
    if (!dataUrl) {
      useAppStore.getState().showToast('截图失败', 'error');
      return;
    }

    const store = useAppStore.getState();
    const panoramaNode = store.nodes.find((node) => node.id === id);
    const position = panoramaNode?.position ?? { x: 0, y: 0 };
    const imageLabel = `全景截图-${Date.now()}`;
    const fileName = buildNodeFileName(imageLabel, 'png', 'panorama-screenshot');

    let imageUrl = dataUrl;
    let filePath: string | undefined;
    try {
      if (!store.currentProjectId) {
        store.showToast('请先打开项目再保存截图', 'error');
        return;
      }
      const saved = await saveDataUrlToProjectData(
        dataUrl,
        store.currentProjectId,
        fileName,
      );
      if (saved) {
        imageUrl = saved.assetUrl || dataUrl;
        filePath = saved.filePath;
      }
    } catch {
      // Web 模式或文件系统不可用时保留 Data URL。
    }

    const imageNodeWidth = nodeWidth;
    const imageNodeHeight = aspect ? Math.round(imageNodeWidth / aspect) : nodeHeight;
    store.addNode({
      id: `node-${generateId()}`,
      type: 'ai-image',
      position: { x: position.x + imageNodeWidth + 60, y: position.y },
      data: {
        label: imageLabel,
        type: 'ai-image' as const,
        role: 'source' as const,
        status: 'success' as const,
        imageUrl,
        filePath,
        fileName,
        nodeWidth: imageNodeWidth,
        nodeHeight: imageNodeHeight,
      },
    } as Parameters<typeof store.addNode>[0]);
    store.showToast('截图已创建为图片节点', 'success');
  }, [captureRatio, id, isFullscreen, nodeHeight, nodeWidth]);

  const { isUploading, handleUpload: uploadSourceFile } = useSourceFileUpload('.png,.jpg,.jpeg,.webp');
  const handleUpload = useCallback(async () => {
    const result = await uploadSourceFile();
    if (!result) return;

    const maxWidth = 280;
    const minWidth = 160;
    const image = new Image();
    image.src = result.dataUrl;
    await new Promise<void>((resolve) => {
      image.onload = () => resolve();
      image.onerror = () => resolve();
    });

    const nodeW = Math.max(minWidth, Math.min(maxWidth, image.naturalWidth || maxWidth));
    const contentWidth = nodeW - 4;
    const nodeH = Math.round(contentWidth / 2) + 4;
    updateNodeData(id, {
      imageUrl: result.dataUrl,
      filePath: result.filePath,
      fileName: result.fileName,
      label: result.fileName,
      status: 'success',
      previewMode: '360',
      nodeWidth: nodeW,
      nodeHeight: nodeH,
      imageWidth: image.naturalWidth || nodeW,
      imageHeight: image.naturalHeight || nodeH,
    } as Partial<BaseNodeData>);
  }, [id, updateNodeData, uploadSourceFile]);

  const { displayLabel, handleRename } = useNodeRename(id, data, '360全景图');
  const hasImage = Boolean(panoramaUrl);
  const show360 = hasImage && previewMode === '360';
  const showImage = hasImage && previewMode === 'image';

  const handleOpenFullscreen = useCallback(() => {
    if (!hasImage) return;
    updateNodeDataTransient(id, { panoFullscreen: true } as Partial<BaseNodeData>);
  }, [hasImage, id, updateNodeDataTransient]);

  return (
    <>
      <div className="node-wrapper" style={{ width: nodeWidth }}>
        <NodeLabel
          kind="ai-panorama"
          label={displayLabel}
          displayId={data.displayId as number | undefined}
          nodeId={id}
          onRename={handleRename}
        />
        <div
          className={`node pano-node ${selected ? 'selected' : ''} ${data.status === 'loading' || isUploading ? 'loading' : ''} ${justCompleted ? 'just-completed' : ''}`}
          style={{ height: nodeHeight }}
        >
          <div
            className="node-preview compact"
            onDoubleClick={(event) => {
              event.stopPropagation();
              handleOpenFullscreen();
            }}
          >
            {!hasImage && (
              <button
                type="button"
                className="node-upload-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  void handleUpload();
                }}
                data-tooltip="上传全景图"
                aria-label="上传全景图"
              >
                <Icon icon="mdi:upload" width="14" height="14" />
              </button>
            )}

            {show360 ? (
              <XiaoLuoPanoramaViewer ref={compactViewerRef} imageUrl={panoramaUrl} />
            ) : showImage ? (
              <div className="image-preview-container">
                <img
                  src={panoramaUrl}
                  alt="360 Panorama"
                  className="image-preview-img compact"
                />
              </div>
            ) : isUploading ? (
              <div className="node-preview-loading">
                <div className="spinner large" />
                <span>上传中...</span>
              </div>
            ) : data.status === 'loading' ? (
              <div className="node-preview-loading">
                <div className="spinner large" />
                <span>生成全景图中...</span>
              </div>
            ) : (
              <div className="node-preview-placeholder">
                <Icon icon="mdi:panorama-sphere-outline" width="36" height="36" />
                <span className="text-xs text-canvas-text-muted mt-1">上传全景图或连线生成</span>
              </div>
            )}
          </div>

          {data.error && <NodeError nodeId={id} message={data.error} />}

          <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-panorama">
            <GooeyBtn className="gooey-btn-left" hue={180} />
          </Handle>
          <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-panorama">
            <GooeyBtn className="gooey-btn-right" hue={180} />
          </Handle>
        </div>

        <ResizeHandle
          nodeId={id}
          currentWidth={nodeWidth}
          currentHeight={nodeHeight}
          minWidth={160}
          minHeight={120}
          onResizeStart={commitToHistory}
          onResizeEnd={commitToHistory}
          onResize={handleResize}
        />

        {hasImage && (
          <div className={`node-toolbar-shell ${selected ? 'is-visible' : ''}`}>
            <PanoramaNodeToolbar
              nodeId={id}
              onUpload={handleUpload}
              onToggleMode={toggleMode}
              previewMode={previewMode}
              onScreenshot={handleScreenshot}
              onFullscreen={toggleFullscreen}
            />
          </div>
        )}
      </div>

      <FullscreenOverlay
        isOpen={isFullscreen && hasImage}
        onClose={toggleFullscreen}
        title={(data.label as string) || '360全景图'}
        panelWidth="min(92vw, 1400px)"
        hideHeader
        bodyClassName="fullscreen-body--pano"
      >
        <div className="pano-fs-stage" ref={fsStageRef}>
          <XiaoLuoPanoramaViewer
            ref={fullscreenViewerRef}
            imageUrl={panoramaUrl}
            immersive
          />
          {captureFrame && (
            <div
              className="pano-capture-frame"
              style={{
                left: captureFrame.x,
                top: captureFrame.y,
                width: captureFrame.w,
                height: captureFrame.h,
              }}
            />
          )}
        </div>
        <div className="fullscreen-pano-toolbar">
          <QualityRatioSelector
            aspectRatio={captureRatio}
            onChangeAspectRatio={setCaptureRatio}
            showImageSize={false}
          />
          <AnimatedButton
            className="pano-fs-btn"
            onClick={handleScreenshot}
            data-tooltip="截图并创建图片节点"
          >
            <Icon icon="mdi:camera-outline" width="16" height="16" />
            <span>截图</span>
          </AnimatedButton>
        </div>
      </FullscreenOverlay>
    </>
  );
}

export default memo(AIPanoramaNode);

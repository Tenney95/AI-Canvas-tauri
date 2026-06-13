/**
 * ImageNode 图像节点 — 在画布上渲染图像内容，支持上传/粘贴图片、遮罩编辑、工具栏、全屏预览
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import GooeyBtn from './shared/GooeyBtn';
import ImageNodeToolbar from './shared/image/ImageNodeToolbar';
import FreeAnglePanel from './shared/image/FreeAnglePanel';
import MattingEditor from './shared/image/MattingEditor';
import CropEditor from './shared/image/CropEditor';
import ResizeHandle from './shared/ResizeHandle';
import FullscreenOverlay from '../shared/FullscreenOverlay';
import { computeImageNodeDimensions } from './shared/image/imageUtils';
import { useNodeRename } from './shared/useNodeRename';
import { useSourceFileUpload } from './shared/useSourceFileUpload';
import { useAppStore, generateId } from '../../store/useAppStore';
import { saveDataUrlToProjectData } from '../../services/fileService';
import { blobToDataUrl } from '../../store/store.utils';
import { generateAngleImage } from '../../services/apimartService';

/* ════════════════════════════════════════════
   AIImageNode
   ════════════════════════════════════════════ */
function AIImageNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const selectedNodeIds = useAppStore((s) => s.selectedNodeIds);
  const isSource = data.role === 'source';
  const nodeWidth = (data.nodeWidth as number) || 280;
  const nodeHeight = (data.nodeHeight as number) || 158;

  // ── Resize handler ──
  const handleResize = useCallback(
    (newWidth: number, newHeight: number) => {
      updateNodeData(id, { nodeWidth: newWidth, nodeHeight: newHeight } as Partial<BaseNodeData>);
    },
    [id, updateNodeData],
  );

  // ── Upload ──
  const { isUploading, handleUpload: doUpload } = useSourceFileUpload('.png,.jpg,.jpeg,.gif,.webp,.svg');

  const handleUpload = useCallback(async () => {
    const result = await doUpload();
    if (!result) return;
    const img = new Image();
    img.onload = () => {
      const contentWidth = nodeWidth - 4;
      const naturalRatio = img.naturalWidth / img.naturalHeight;
      const previewHeight = Math.round(contentWidth / naturalRatio);
      const newHeight = Math.max(120, previewHeight + 4);
      updateNodeData(id, {
        imageUrl: result.dataUrl,
        filePath: result.filePath,
        fileName: result.fileName,
        label: result.fileName,
        status: 'success',
        nodeHeight: newHeight,
        imageWidth: img.naturalWidth,
        imageHeight: img.naturalHeight,
      } as Partial<BaseNodeData>);
    };
    img.src = result.dataUrl;
  }, [doUpload, id, nodeWidth, updateNodeData]);

  /* ════════════════════════════════════════════
     Free Angle State
     ════════════════════════════════════════════ */
  const [isFreeAngle, setIsFreeAngle] = useState(false);
  const [imgLoadError, setImgLoadError] = useState(false);
  const [mattingError, setMattingError] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);

  // 当 imageUrl 变化时重置加载错误状态
  const displaySrc = (data.imageUrl || data.thumbnailUrl) as string | undefined;
  useEffect(() => {
    setImgLoadError(false);
    setFullscreenError(false);
  }, [displaySrc]);
  useEffect(() => {
    setMattingError(false);
  }, [data.mattingMask]);

  const handleOpenFreeAngle = useCallback(() => setIsFreeAngle(true), []);
  const handleCloseFreeAngle = useCallback(() => setIsFreeAngle(false), []);

  const handleFreeAngleGenerate = useCallback(
    async (params: { rotation: number; pitch: number; scale: number; model: string; provider: string }) => {
      const store = useAppStore.getState();
      const imageUrl = (data.imageUrl || data.thumbnailUrl) as string | undefined;
      if (!imageUrl) {
        store.showToast('没有可用的图片', 'error');
        return;
      }

      setIsFreeAngle(false);

      if (params.provider !== 'apimart') {
        store.showToast(`${params.provider} 角度控制暂未实现`, 'error');
        return;
      }

      const apiKey = store.config.providers.apimart?.apiKey;
      if (!apiKey) {
        store.showToast('请先在设置中配置 APIMart API Key', 'error');
        return;
      }

      const model = params.model.startsWith('apimart/')
        ? params.model.slice('apimart/'.length)
        : params.model;

      updateNodeData(id, { status: 'loading', output: undefined, error: undefined });

      try {
        const result = await generateAngleImage(
          { apiKey, model, imageUrl, rotation: params.rotation, pitch: params.pitch },
          (progress) => {
            updateNodeData(id, { output: `生成中 ${progress}%...` });
          },
        );

        const currentNodes = store.nodes;
        const currentPos = currentNodes.find((n) => n.id === id)?.position || { x: 0, y: 0 };

        for (let i = 0; i < result.imageUrls.length; i++) {
          const genUrl = result.imageUrls[i];
          const resp = await fetch(genUrl);
          const blob = await resp.blob();
          let dataUrl = await blobToDataUrl(blob);

          let filePath: string | undefined;
          let assetUrl = dataUrl;
          const projectId = store.currentProjectId;
          if (projectId && projectId !== 'default') {
            const ext = blob.type.split('/').pop() || 'png';
            const savedName = `angle_${params.rotation.toFixed(0)}_${i}.${ext}`;
            const saved = await saveDataUrlToProjectData(dataUrl, projectId, savedName);
            if (saved && saved.assetUrl) {
              assetUrl = saved.assetUrl;
              filePath = saved.filePath;
            }
          }

          const dims = await computeImageNodeDimensions(assetUrl);
          const newNode: Node<BaseNodeData> = {
            id: `node-${generateId()}`,
            type: 'ai-image',
            position: { x: currentPos.x + nodeWidth + 40 + i * 40, y: currentPos.y },
            data: {
              label: `角度视图 ${params.rotation.toFixed(0)}°`,
              type: 'ai-image',
              role: 'source',
              imageUrl: assetUrl,
              filePath,
              status: 'success',
              imageWidth: dims.nodeWidth,
              imageHeight: dims.nodeHeight,
              nodeWidth: dims.nodeWidth,
              nodeHeight: dims.nodeHeight,
            } as BaseNodeData,
          };
          store.addNode(newNode);
        }

        updateNodeData(id, { status: 'success' });
        store.showToast(`已生成 ${result.imageUrls.length} 张角度图片`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : '生成失败';
        updateNodeData(id, { status: 'error', error: message });
        store.showToast(message, 'error');
      }
    },
    [id, data.imageUrl, data.thumbnailUrl, updateNodeData],
  );

  /* ════════════════════════════════════════════
     Crop State
     ════════════════════════════════════════════ */
  const [isCrop, setIsCrop] = useState(false);
  const pendingCropNodeId = useRef<string | null>(null);

  const handleOpenCrop = useCallback(() => setIsCrop(true), []);
  const handleCloseCrop = useCallback(() => {
    setIsCrop(false);
    pendingCropNodeId.current = null;
  }, []);

  /** 确认裁切时立即调用：创建 loading 状态的新节点并关闭弹窗 */
  const handleCropStart = useCallback(() => {
    const store = useAppStore.getState();
    const currentNodes = store.nodes;
    const currentPos = currentNodes.find((n) => n.id === id)?.position || { x: 0, y: 0 };

    const newNodeId = `node-${generateId()}`;
    pendingCropNodeId.current = newNodeId;

    const newNode: Node<BaseNodeData> = {
      id: newNodeId,
      type: 'ai-image',
      position: { x: currentPos.x + nodeWidth + 40, y: currentPos.y },
      data: {
        label: `${(data.label as string) || '图像'} 裁切`,
        type: 'ai-image',
        role: 'source',
        status: 'loading',
        nodeWidth,
        nodeHeight: 158,
      } as BaseNodeData,
    };
    store.addNode(newNode);
    setIsCrop(false);
  }, [id, data.label, nodeWidth]);

  /** 后台裁切完成后调用：更新节点数据 */
  const handleCropSave = useCallback(
    async (croppedDataUrl: string, metadata?: { width: number; height: number }) => {
      const store = useAppStore.getState();
      const nodeId = pendingCropNodeId.current;
      pendingCropNodeId.current = null;

      if (!croppedDataUrl || !nodeId) {
        if (nodeId) store.deleteNode(nodeId);
        store.showToast('裁切失败，请重试', 'error');
        return;
      }

      // Save to project data if applicable
      let assetUrl = croppedDataUrl;
      let filePath: string | undefined;
      const projectId = store.currentProjectId;
      if (projectId && projectId !== 'default') {
        const savedName = `cropped_${Date.now()}.png`;
        const saved = await saveDataUrlToProjectData(croppedDataUrl, projectId, savedName);
        if (saved && saved.assetUrl) {
          assetUrl = saved.assetUrl;
          filePath = saved.filePath;
        }
      }

      const dims = await computeImageNodeDimensions(assetUrl);
      store.updateNodeData(nodeId, {
        imageUrl: assetUrl,
        filePath,
        status: 'success',
        imageWidth: metadata?.width || dims.nodeWidth,
        imageHeight: metadata?.height || dims.nodeHeight,
        nodeWidth: dims.nodeWidth,
        nodeHeight: dims.nodeHeight,
      } as Partial<BaseNodeData>);

      store.showToast('裁切完成，已创建新节点');
    },
    [updateNodeData],
  );

  /* ════════════════════════════════════════════
     Matting State
     ════════════════════════════════════════════ */
  const [isMatting, setIsMatting] = useState(false);

  const handleOpenMatting = useCallback(() => setIsMatting(true), []);
  const handleCloseMatting = useCallback(() => setIsMatting(false), []);

  const handleMattingSave = useCallback(
    (maskUrl: string) => {
      updateNodeData(id, { mattingMask: maskUrl } as Partial<BaseNodeData>);
      setIsMatting(false);
    },
    [id, updateNodeData],
  );

  /* ════════════════════════════════════════════
     Fullscreen State
     ════════════════════════════════════════════ */
  const [isFullscreen, setIsFullscreen] = useState(false);
  const handleOpenFullscreen = useCallback(() => setIsFullscreen(true), []);
  const handleCloseFullscreen = useCallback(() => setIsFullscreen(false), []);

  /* ════════════════════════════════════════════
     Download
     ════════════════════════════════════════════ */
  const handleDownload = useCallback(() => {
    const src = (data.imageUrl || data.thumbnailUrl) as string | undefined;
    if (!src) return;
    const link = document.createElement('a');
    link.download = (data.fileName as string) || `image-${Date.now()}.png`;
    link.href = src;
    link.click();
  }, [data.imageUrl, data.thumbnailUrl, data.fileName]);

  const { displayLabel, handleRename } = useNodeRename(id, data, '粘贴图像');

  return (
    <>
      <div className="node-wrapper relative" style={{ width: nodeWidth }}>
        <NodeLabel
          kind="ai-image"
          label={displayLabel}
          displayId={data.displayId as number | undefined}
          nodeId={id}
          onRename={handleRename}
        />
        <div
          className={`node image-node ${selected ? 'selected' : ''} ${data.status === 'loading' || isUploading ? 'loading' : ''}`}
          style={{ height: nodeHeight }}
        >
          <div className="node-preview compact">
            {isSource && (
              <button
                className="node-upload-btn"
                onClick={(e) => { e.stopPropagation(); handleUpload(); }}
                data-tooltip="上传图片"
                aria-label="上传图片"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </button>
            )}
            {displaySrc ? (
              <div className="image-preview-container">
                {imgLoadError ? (
                  <div className="flex flex-col items-center justify-center gap-2 h-full min-h-[80px] text-canvas-text-muted">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.5">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                    <span className="text-xs">图片加载失败</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); setImgLoadError(false); }}
                      className="text-[10px] px-2 py-0.5 rounded bg-canvas-hover hover:bg-canvas-border transition-colors"
                    >
                      重新加载
                    </button>
                  </div>
                ) : (
                  <img
                    src={displaySrc}
                    alt="Generated"
                    className="image-preview-img compact"
                    data-source-url={data.sourceUrl}
                    onError={() => setImgLoadError(true)}
                  />
                )}
                {data.mattingMask && !mattingError && (
                  <img
                    src={data.mattingMask as string}
                    alt="Mask"
                    className="image-preview-mask"
                    onError={() => setMattingError(true)}
                  />
                )}
              </div>
            ) : isUploading ? (
              <div className="node-preview-loading">
                <div className="spinner large" />
                <span>上传中...</span>
              </div>
            ) : data.status === 'loading' ? (
              <div className="node-preview-loading">
                <div className="spinner large" />
                <span>生成图像中...</span>
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
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                )}
              </div>
            )}
          </div>
          {data.error && <div className="node-error">{data.error}</div>}
          <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-image" >
            <GooeyBtn className="gooey-btn-left" hue={142} />
          </Handle>
          <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-image" >
            <GooeyBtn className="gooey-btn-right" hue={142} />
          </Handle>
        </div>

        {/* Resize handle */}
        <ResizeHandle
          currentWidth={nodeWidth}
          currentHeight={nodeHeight}
          minWidth={160}
          minHeight={120}
          onResize={handleResize}
        />

        {/* Floating toolbar — single-select only */}
        {selected && selectedNodeIds.length <= 1 && (data.imageUrl || data.thumbnailUrl) && (
          <ImageNodeToolbar
            nodeId={id}
            onMatting={handleOpenMatting}
            onMultiAngle={handleOpenFreeAngle}
            onCrop={handleOpenCrop}
            onFullscreen={handleOpenFullscreen}
            onDownload={handleDownload}
          />
        )}
      </div>

      {/* Matting Editor Overlay */}
      <MattingEditor
        isOpen={isMatting}
        imageUrl={(data.imageUrl || data.thumbnailUrl) as string}
        initialMask={data.mattingMask as string | undefined}
        onClose={handleCloseMatting}
        onSave={handleMattingSave}
      />

      {/* Free Angle Panel */}
      <FreeAnglePanel
        isOpen={isFreeAngle}
        imageUrl={(data.imageUrl || data.thumbnailUrl) as string | undefined}
        onClose={handleCloseFreeAngle}
        onGenerate={handleFreeAngleGenerate}
      />

      {/* Crop Editor */}
      <CropEditor
        isOpen={isCrop}
        imageUrl={(data.imageUrl || data.thumbnailUrl) as string}
        onClose={handleCloseCrop}
        onStart={handleCropStart}
        onSave={handleCropSave}
      />

      {/* Fullscreen preview */}
      <FullscreenOverlay
        isOpen={isFullscreen}
        onClose={handleCloseFullscreen}
        title={(data.label as string) || '图片预览'}
        panelWidth="min(92vw, 1400px)"
        bodyClassName="fullscreen-body--image"
      >
        {fullscreenError ? (
          <div className="flex flex-col items-center justify-center gap-3 h-full text-canvas-text-muted">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <span className="text-sm">图片加载失败</span>
            <button
              onClick={() => setFullscreenError(false)}
              className="text-xs px-3 py-1 rounded bg-canvas-hover hover:bg-canvas-border transition-colors"
            >
              重新加载
            </button>
          </div>
        ) : (
          <img
            src={(data.imageUrl || data.thumbnailUrl) as string}
            alt={(data.label as string) || '预览'}
            className="fullscreen-img-view"
            onError={() => setFullscreenError(true)}
          />
        )}
      </FullscreenOverlay>
    </>
  );
}

export default memo(AIImageNode);

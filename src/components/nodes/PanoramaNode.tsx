/**
 * PanoramaNode 360全景图节点 — Three.js WebGL 全景查看器
 * 支持图片/360预览双模式切换、上传、全屏、日夜景切换
 */
import { memo, useCallback, useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import { Handle, Position } from '@xyflow/react';
import {
  Scene,
  PerspectiveCamera,
  SphereGeometry,
  MeshBasicMaterial,
  Mesh,
  TextureLoader,
  Texture,
  WebGLRenderer,
  SRGBColorSpace,
} from 'three';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import NodeError from './shared/NodeError';
import GooeyBtn from './shared/GooeyBtn';
import ResizeHandle from './shared/ResizeHandle';
import PanoramaNodeToolbar from './shared/PanoramaNodeToolbar';
import FullscreenOverlay from '../shared/FullscreenOverlay';
import AnimatedButton from '../shared/AnimatedButton';
import QualityRatioSelector from './shared/QualityRatioSelector';
import { useNodeRename } from './shared/useNodeRename';
import { useSourceFileUpload } from './shared/useSourceFileUpload';
import { useAppStore, generateId } from '../../store/useAppStore';
import { saveDataUrlToProjectData, buildNodeFileName } from '../../services/fileService';
import { useCompletionFlash } from '../../hooks/useCompletionFlash';

/* ═════════════════════════════════════════════════
   Three.js 360° Panorama Viewer
   ═════════════════════════════════════════════════ */

export interface PanoramaViewerHandle {
  /** 截图；传入宽高比则居中裁剪到该比例，不传/为空则整帧 */
  captureScreenshot: (aspect?: number | null) => string | null;
}

/** '16:9' → 1.777…；'自适应' / 非法 → null（不裁剪） */
function ratioToNumber(ratio: string): number | null {
  if (!ratio || ratio === '自适应') return null;
  const [a, b] = ratio.split(':').map(Number);
  if (!a || !b) return null;
  return a / b;
}

interface PanoramaViewerProps {
  imageUrl: string;
  onClose: () => void;
  onUpload: () => void;
  onToggleFullscreen: () => void;
}

const PanoramaViewer = forwardRef<PanoramaViewerHandle, PanoramaViewerProps>(function PanoramaViewer({
  imageUrl
}, ref) {
  const shellRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    scene: Scene;
    camera: PerspectiveCamera;
    sphere: Mesh;
    texture: Texture;
    renderer: WebGLRenderer;
    animId: number;
  } | null>(null);
  /** 当前拖拽旋转角度（弧度） */
  const rotation = useRef({ lon: 0, lat: 0 });
  const dragRef = useRef({ active: false, lastX: 0, lastY: 0, pointerId: 0 });
  const fovRef = useRef(75);
  /** 请求一次按需渲染（仅在交互/resize 时调用，空闲不渲染） */
  const requestRenderRef = useRef<() => void>(() => {});

  /* ── Expose screenshot capture ── */
  useImperativeHandle(ref, () => ({
    captureScreenshot(aspect?: number | null) {
      const state = sceneRef.current;
      if (!state?.renderer?.domElement) return null;
      // Force-render to ensure drawing buffer is populated (preserveDrawingBuffer=false by default)
      state.renderer.render(state.scene, state.camera);
      const src = state.renderer.domElement;
      if (!aspect || aspect <= 0) return src.toDataURL('image/png');
      // 居中裁剪到目标比例（取能放进画布的最大居中矩形，与蒙版框一致）
      const cw = src.width;
      const ch = src.height;
      let cropW: number;
      let cropH: number;
      if (cw / ch > aspect) { cropH = ch; cropW = Math.round(ch * aspect); }
      else { cropW = cw; cropH = Math.round(cw / aspect); }
      const sx = Math.round((cw - cropW) / 2);
      const sy = Math.round((ch - cropH) / 2);
      const off = document.createElement('canvas');
      off.width = cropW;
      off.height = cropH;
      const ctx = off.getContext('2d');
      if (!ctx) return src.toDataURL('image/png');
      ctx.drawImage(src, sx, sy, cropW, cropH, 0, 0, cropW, cropH);
      return off.toDataURL('image/png');
    },
  }), []);

  /* ── Init / Dispose Three.js ── */
  useEffect(() => {
    const el = mountRef.current;
    if (!el || !imageUrl) return;

    const w = el.clientWidth;
    const h = el.clientHeight;

    /* ---- Scene & Camera ---- */
    const scene = new Scene();
    const camera = new PerspectiveCamera(75, w / h, 0.1, 1000);

    /* ---- Sphere (equirectangular skybox) ---- */
    const geo = new SphereGeometry(500, 64, 32);
    // Flip normals so we see the inside
    geo.scale(-1, 1, 1);

    const texture = new TextureLoader().load(imageUrl, () => {
      // 纹理加载完成后渲染一次
      requestRenderRef.current();
    });
    texture.colorSpace = SRGBColorSpace;
    const mat = new MeshBasicMaterial({ map: texture });
    const sphere = new Mesh(geo, mat);
    scene.add(sphere);

    /* ---- Renderer ---- */
    const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    renderer.domElement.className = 'panorama-scene-webgl';
    renderer.domElement.setAttribute('data-panorama-empty', '0');
    renderer.domElement.style.display = 'block';

    /* ---- On-demand render (空闲不渲染，仅交互/resize 时合并到一帧) ---- */
    let animId = 0;
    const renderFrame = () => {
      animId = 0;
      // Apply rotation
      sphere.rotation.y = rotation.current.lon;
      camera.rotation.x = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, rotation.current.lat));
      camera.fov = fovRef.current;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };
    const requestRender = () => {
      if (animId) return; // 已排程，合并本帧多次请求
      animId = requestAnimationFrame(renderFrame);
    };
    requestRenderRef.current = requestRender;
    requestRender(); // 初始渲染一次

    sceneRef.current = { scene, camera, sphere, texture, renderer, animId };

    /* ---- ResizeObserver ---- */
    const ro = new ResizeObserver(() => {
      const nw = el.clientWidth;
      const nh = el.clientHeight;
      if (nw === 0 || nh === 0) return;
      renderer.setSize(nw, nh);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      requestRender();
    });
    ro.observe(el);

    return () => {
      cancelAnimationFrame(animId);
      requestRenderRef.current = () => {};
      ro.disconnect();
      renderer.dispose();
      texture.dispose();
      geo.dispose();
      mat.dispose();
      if (renderer.domElement.parentElement === el) {
        el.removeChild(renderer.domElement);
      }
    };
  }, [imageUrl]);

  /* ── Pointer events (drag rotate) ── */
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY, pointerId: e.pointerId };
    shellRef.current?.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.lastX;
    const dy = e.clientY - dragRef.current.lastY;
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;
    rotation.current.lon += dx * 0.005;
    rotation.current.lat += dy * 0.005;
    rotation.current.lat = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, rotation.current.lat));
    requestRenderRef.current();
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    try {
      shellRef.current?.releasePointerCapture(dragRef.current.pointerId);
    } catch {
      // pointer already released or element disconnected
    }
  }, []);

  /* ── Wheel (zoom) — must be non‑passive so preventDefault works ── */
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      fovRef.current = Math.max(20, Math.min(110, fovRef.current + e.deltaY * 0.05));
      requestRenderRef.current();
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  return (
    <div className="panorama-viewer-wrapper">
      {/* ── Shell (Three.js viewer) ── */}
      <div
        ref={shellRef}
        className="panorama-scene-shell"
        data-ui-stop="1"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ touchAction: 'none' }}
      >
        {/* ── Three.js mount point ── */}
        <div ref={mountRef} className="panorama-scene-viewport" style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
});

/* ═════════════════════════════════════════════════
   Main Panorama Node Component
   ═════════════════════════════════════════════════ */

function AIPanoramaNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const justCompleted = useCompletionFlash(data.status);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const nodeWidth = (data.nodeWidth as number) || 280;
  const nodeHeight = (data.nodeHeight as number) || 200;

  /* ── Panorama viewer refs (compact + fullscreen) ── */
  const compactViewerRef = useRef<PanoramaViewerHandle>(null);
  const fullscreenViewerRef = useRef<PanoramaViewerHandle>(null);

  /* ── 全屏截图比例（蒙版裁剪框）── */
  const [captureRatio, setCaptureRatio] = useState('自适应');
  const fsStageRef = useRef<HTMLDivElement>(null);
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 });

  /* ── Resize handler ── */
  const handleResize = useCallback(
    (newWidth: number, newHeight: number) => {
      updateNodeData(id, { nodeWidth: newWidth, nodeHeight: newHeight } as Partial<BaseNodeData>);
    },
    [id, updateNodeData],
  );

  /* ── States ── */
  const previewMode = (data.previewMode as 'image' | '360') || 'image';
  const isFullscreen = (data.panoFullscreen as boolean) || false;

  /* ── 全屏舞台尺寸跟踪 → 计算居中裁剪框 ── */
  const captureAspect = ratioToNumber(captureRatio);
  useEffect(() => {
    if (!isFullscreen) return;
    const el = fsStageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStageBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [isFullscreen]);

  const captureFrame = (() => {
    if (!captureAspect || !stageBox.w || !stageBox.h) return null;
    let w: number;
    let h: number;
    if (stageBox.w / stageBox.h > captureAspect) { h = stageBox.h; w = h * captureAspect; }
    else { w = stageBox.w; h = w / captureAspect; }
    return { x: (stageBox.w - w) / 2, y: (stageBox.h - h) / 2, w, h };
  })();

  const toggleMode = useCallback(() => {
    updateNodeData(id, { previewMode: previewMode === '360' ? 'image' : '360' } as Partial<BaseNodeData>);
  }, [id, previewMode, updateNodeData]);

  const toggleFullscreen = useCallback(() => {
    updateNodeData(id, { panoFullscreen: !isFullscreen } as Partial<BaseNodeData>);
  }, [id, isFullscreen, updateNodeData]);

  /* ── Screenshot → save to project dir & create image node ── */
  const handleScreenshot = useCallback(async () => {
    // 仅全屏支持比例蒙版裁剪；紧凑模式整帧
    const aspect = isFullscreen ? ratioToNumber(captureRatio) : null;
    const activeViewer = isFullscreen ? fullscreenViewerRef.current : compactViewerRef.current;
    const dataUrl = activeViewer?.captureScreenshot(aspect);
    if (!dataUrl) {
      useAppStore.getState().showToast('截图失败', 'error');
      return;
    }
    // Get current panorama node position and offset the image node
    const store = useAppStore.getState();
    const panoNode = store.nodes.find((n) => n.id === id);
    const pos = panoNode?.position ?? { x: 0, y: 0 };
    const imgLabel = `全景截图-${Date.now()}`;
    const fileName = buildNodeFileName(imgLabel, 'png', 'panorama-screenshot');

    // Save to project data directory (Tauri) or fall back to base64 data URL
    let imageUrl = dataUrl;
    let filePath: string | undefined;
    try {
      if (!store.currentProjectId) return;
      const saved = await saveDataUrlToProjectData(dataUrl, store.currentProjectId, fileName);
      if (saved) {
        imageUrl = saved.assetUrl || dataUrl;
        filePath = saved.filePath;
      }
    } catch {
      // Fall back to base64 data URL
    }

    // Create image node offset to the right —— 有裁剪比例时按比例定高
    const imgNodeW = nodeWidth as number;
    const imgNodeH = aspect ? Math.round(imgNodeW / aspect) : (nodeHeight as number);
    const nodeId = `node-${generateId()}`;
    store.addNode({
      id: nodeId,
      type: 'ai-image',
      position: { x: pos.x + imgNodeW + 60, y: pos.y },
      data: {
        label: imgLabel,
        type: 'ai-image' as const,
        role: 'source' as const,
        status: 'success' as const,
        imageUrl,
        filePath,
        fileName,
        nodeWidth: imgNodeW,
        nodeHeight: imgNodeH,
      },
    } as Parameters<typeof store.addNode>[0]);
    store.showToast('截图已创建为图片节点', 'success');
  }, [id, nodeWidth, nodeHeight, isFullscreen, captureRatio]);

  /* ── Upload ── */
  const { isUploading, handleUpload: doUpload } = useSourceFileUpload('.png,.jpg,.jpeg,.webp');
  const handleUpload = useCallback(async () => {
    const result = await doUpload();
    if (!result) return;
    // 360° equirectangular 全景图强制 2:1 宽高比
    const maxWidth = 280;
    const minWidth = 160;
    const img = new Image();
    img.src = result.dataUrl;
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
    });
    let nodeW = img.naturalWidth || maxWidth;
    if (nodeW > maxWidth) nodeW = maxWidth;
    if (nodeW < minWidth) nodeW = minWidth;
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
      imageWidth: img.naturalWidth || nodeW,
      imageHeight: img.naturalHeight || nodeH,
    } as Partial<BaseNodeData>);
  }, [doUpload, id, updateNodeData]);

  const { displayLabel, handleRename } = useNodeRename(id, data, '360全景图');

  const hasImage = !!(data.imageUrl || data.thumbnailUrl);
  const show360 = hasImage && previewMode === '360';
  const showImage = hasImage && previewMode === 'image';

  return (
    <>
      {/* ── Compact node view (always on canvas) ── */}
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
          <div className="node-preview compact">
            {/* Upload button (when no image yet) */}
            {!hasImage && (
              <button
                className="node-upload-btn"
                onClick={(e) => { e.stopPropagation(); handleUpload(); }}
                data-tooltip="上传全景图"
                aria-label="上传全景图"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </button>
            )}

            {show360 ? (
              <PanoramaViewer
                ref={compactViewerRef}
                imageUrl={data.imageUrl || data.thumbnailUrl || ''}
                onClose={toggleMode}
                onUpload={handleUpload}
                onToggleFullscreen={toggleFullscreen}
              />
            ) : showImage ? (
              <div className="image-preview-container">
                <img
                  src={data.imageUrl || data.thumbnailUrl}
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
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <circle cx="12" cy="12" r="10" />
                  <ellipse cx="12" cy="12" rx="6" ry="10" />
                  <line x1="12" y1="2" x2="12" y2="22" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                </svg>
                <span className="text-xs text-canvas-text-muted mt-1">
                  上传全景图或连线生成
                </span>
              </div>
            )}
          </div>
          {data.error && <NodeError nodeId={id} message={data.error} />}

          {/* Panorama handles — 青色 hue=180 */}
          <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-panorama" >
            <GooeyBtn className="gooey-btn-left" hue={180} />
          </Handle>
          <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-panorama" >
            <GooeyBtn className="gooey-btn-right" hue={180} />
          </Handle>
        </div>

        {/* Resize handle — always visible in compact mode */}
        <ResizeHandle
          nodeId={id}
          currentWidth={nodeWidth}
          currentHeight={nodeHeight}
          minWidth={160}
          minHeight={120}
          onResize={handleResize}
        />

        {/* Keep the toolbar mounted to animate selection changes. */}
        {hasImage && (
          <div className={`node-toolbar-shell ${selected ? 'is-visible' : ''}`}>
            <PanoramaNodeToolbar
              onUpload={handleUpload}
              onToggleMode={toggleMode}
              previewMode={previewMode}
              onScreenshot={handleScreenshot}
              onFullscreen={toggleFullscreen}
            />
          </div>
        )}
      </div>

      {/* ── Fullscreen overlay ── */}
      <FullscreenOverlay
        isOpen={isFullscreen && hasImage}
        onClose={toggleFullscreen}
        title={(data.label as string) || '360全景图'}
        panelWidth="min(92vw, 1400px)"
        hideHeader
        bodyClassName="fullscreen-body--pano"
      >
        <div className="pano-fs-stage" ref={fsStageRef}>
          <PanoramaViewer
            ref={fullscreenViewerRef}
            imageUrl={data.imageUrl || data.thumbnailUrl || ''}
            onClose={toggleFullscreen}
            onUpload={() => {}}
            onToggleFullscreen={toggleFullscreen}
          />
          {/* 比例蒙版：暗化裁剪框外区域 */}
          {captureFrame && (
            <div
              className="pano-capture-frame"
              style={{ left: captureFrame.x, top: captureFrame.y, width: captureFrame.w, height: captureFrame.h }}
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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            <span>截图</span>
          </AnimatedButton>
        </div>
      </FullscreenOverlay>
    </>
  );
}

export default memo(AIPanoramaNode);

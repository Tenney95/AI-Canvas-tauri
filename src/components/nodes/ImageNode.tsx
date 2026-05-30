/**
 * ImageNode 图像节点 — 在画布上渲染图像内容，支持上传/粘贴图片、遮罩编辑、工具栏、全屏预览
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import ImageNodeToolbar from './shared/ImageNodeToolbar';
import MattingToolbar from './shared/MattingToolbar';
import FreeAnglePanel from './shared/FreeAnglePanel';
import { useAppStore, generateId } from '../../store/useAppStore';
import { uploadSourceFileToProject, saveDataUrlToProjectData } from '../../services/fileService';
import { generateAngleImage } from '../../services/apimartService';

/* ── Matting types ── */
type MattingTool = 'brush' | 'eraser' | 'bucket';
type BrushMode = 'normal' | 'alpha';

/* ── 图像节点尺寸计算 ── */
function computeImageNodeDimensions(dataUrl: string): Promise<{ nodeWidth: number; nodeHeight: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const naturalRatio = img.naturalWidth / img.naturalHeight;
      const maxWidth = 280;
      const minWidth = 160;
      let nodeWidth = img.naturalWidth;
      if (nodeWidth > maxWidth) nodeWidth = maxWidth;
      if (nodeWidth < minWidth) nodeWidth = minWidth;
      const contentWidth = nodeWidth - 4;
      const previewHeight = Math.round(contentWidth / naturalRatio);
      const nodeHeight = Math.max(120, previewHeight + 4);
      resolve({ nodeWidth, nodeHeight });
    };
    img.onerror = () => resolve({ nodeWidth: 280, nodeHeight: 158 });
    img.src = dataUrl;
  });
}

/* ── Flood fill helper ── */
function floodFill(
  imageData: ImageData,
  startX: number,
  startY: number,
  fillColor: [number, number, number, number],
): void {
  const { data, width, height } = imageData;
  const targetIdx = (startY * width + startX) * 4;
  const targetR = data[targetIdx];
  const targetG = data[targetIdx + 1];
  const targetB = data[targetIdx + 2];
  const targetA = data[targetIdx + 3];

  // If target is already the fill color, skip
  if (
    targetR === fillColor[0] &&
    targetG === fillColor[1] &&
    targetB === fillColor[2] &&
    targetA === fillColor[3]
  ) return;

  const stack = [[startX, startY]];
  const visited = new Uint8Array(width * height);

  const idx = startY * width + startX;
  visited[idx] = 1;

  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    const pi = (y * width + x) * 4;

    // Set pixel
    data[pi] = fillColor[0];
    data[pi + 1] = fillColor[1];
    data[pi + 2] = fillColor[2];
    data[pi + 3] = fillColor[3];

    // Check neighbors
    const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = ny * width + nx;
      if (visited[ni]) continue;
      const np = ni * 4;
      const tolerance = 20;
      if (
        Math.abs(data[np] - targetR) <= tolerance &&
        Math.abs(data[np + 1] - targetG) <= tolerance &&
        Math.abs(data[np + 2] - targetB) <= tolerance &&
        Math.abs(data[np + 3] - targetA) <= tolerance
      ) {
        visited[ni] = 1;
        stack.push([nx, ny]);
      }
    }
  }
}

/* ════════════════════════════════════════════
   AIImageNode
   ════════════════════════════════════════════ */
function AIImageNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const isSource = data.role === 'source';

  // ── Resize ──
  const isResizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, width: 280, height: 158 });
  const nodeWidth = (data.nodeWidth as number) || 280;
  const nodeHeight = (data.nodeHeight as number) || 158;

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      isResizing.current = true;
      resizeStart.current = { x: e.clientX, y: e.clientY, width: nodeWidth, height: nodeHeight };

      const handlePointerMove = (ev: PointerEvent) => {
        if (!isResizing.current) return;
        const dx = ev.clientX - resizeStart.current.x;
        const dy = ev.clientY - resizeStart.current.y;
        const newWidth = Math.max(160, resizeStart.current.width + dx);
        const newHeight = Math.max(120, resizeStart.current.height + dy);
        updateNodeData(id, { nodeWidth: newWidth, nodeHeight: newHeight } as Partial<BaseNodeData>);
      };

      const handlePointerUp = () => {
        isResizing.current = false;
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
    },
    [id, nodeWidth, nodeHeight, updateNodeData],
  );

  // ── Upload ──
  const [isUploading, setIsUploading] = useState(false);

  const handleUpload = useCallback(async () => {
    setIsUploading(true);
    try {
      const result = await uploadSourceFileToProject('.png,.jpg,.jpeg,.gif,.webp,.svg', currentProjectId);
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
    } catch {
      /* silently ignore */
    } finally {
      setIsUploading(false);
    }
  }, [id, nodeWidth, updateNodeData, currentProjectId]);

  /* ════════════════════════════════════════════
     Free Angle State
     ════════════════════════════════════════════ */
  const [isFreeAngle, setIsFreeAngle] = useState(false);

  const handleOpenFreeAngle = useCallback(() => {
    setIsFreeAngle(true);
  }, []);

  const handleCloseFreeAngle = useCallback(() => {
    setIsFreeAngle(false);
  }, []);

  const handleFreeAngleGenerate = useCallback(
    async (params: { rotation: number; pitch: number; scale: number; model: string; provider: string }) => {
      const store = useAppStore.getState();
      const imageUrl = (data.imageUrl || data.thumbnailUrl) as string | undefined;
      if (!imageUrl) {
        store.showToast('没有可用的图片', 'error');
        return;
      }

      setIsFreeAngle(false);

      // 仅处理 apimart provider，其他 provider 暂未实现
      if (params.provider !== 'apimart') {
        store.showToast(`${params.provider} 角度控制暂未实现`, 'error');
        return;
      }

      const apiKey = store.config.providers.apimart?.apiKey;
      if (!apiKey) {
        store.showToast('请先在设置中配置 APIMart API Key', 'error');
        return;
      }

      // 去掉 model 值中的 'apimart/' 前缀
      const model = params.model.startsWith('apimart/')
        ? params.model.slice('apimart/'.length)
        : params.model;

      // 当前节点设为 loading
      updateNodeData(id, { status: 'loading', output: undefined, error: undefined });

      try {
        const result = await generateAngleImage(
          { apiKey, model, imageUrl, rotation: params.rotation, pitch: params.pitch },
          (progress) => {
            updateNodeData(id, { output: `生成中 ${progress}%...` });
          },
        );

        // 获取当前节点位置（用于放置新节点）
        const currentNodes = store.nodes;
        const currentPos = currentNodes.find((n) => n.id === id)?.position || { x: 0, y: 0 };

        // 逐个创建新图片节点
        for (let i = 0; i < result.imageUrls.length; i++) {
          const genUrl = result.imageUrls[i];

          // 下载图片并转为 data URL
          const resp = await fetch(genUrl);
          const blob = await resp.blob();
          let dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });

          // Tauri: save generated image to project data dir
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
     Matting State
     ════════════════════════════════════════════ */
  const [isMatting, setIsMatting] = useState(false);
  const [mattingPhase, setMattingPhase] = useState<'idle' | 'entering' | 'active'>('idle');
  const [mattingEnterAnimating, setMattingEnterAnimating] = useState(false);
  const [mattingAnimRect, setMattingAnimRect] = useState<{
    from: { top: number; left: number; width: number; height: number };
    to: { top: number; left: number; width: number; height: number };
  } | null>(null);
  const mattingCanvasRef = useRef<HTMLCanvasElement>(null);
  const mattingImageRef = useRef<HTMLImageElement>(null);
  const previewImgRef = useRef<HTMLImageElement>(null);
  const mattingStrokeBaseline = useRef<ImageData | null>(null);
  const mattingStrokePoints = useRef<{ x: number; y: number }[]>([]);
  const [mattingTool, setMattingTool] = useState<MattingTool>('brush');
  const [mattingBrushMode, setMattingBrushMode] = useState<BrushMode>('normal');
  const [mattingBrushSize, setMattingBrushSize] = useState(40);
  const mattingIsDrawing = useRef(false);
  const mattingHistoryRef = useRef<ImageData[]>([]);
  const [mattingHistoryIdx, setMattingHistoryIdx] = useState(-1);

  const MASK_COLOR = 'rgba(255, 200, 0, 0.45)';

  /* Initialize canvas when entering matting */
  const initMattingCanvas = useCallback(() => {
    const canvas = mattingCanvasRef.current;
    const image = mattingImageRef.current;
    if (!canvas || !image) return;

    const rect = image.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Restore previously saved mask if exists
    const savedMask = data.mattingMask as string | undefined;
    if (savedMask) {
      const maskImg = new Image();
      maskImg.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
        // Push restored state to history
        const initial = ctx.getImageData(0, 0, canvas.width, canvas.height);
        mattingHistoryRef.current = [initial];
        setMattingHistoryIdx(0);
      };
      maskImg.src = savedMask;
      return;
    }

    // Push initial state to history
    const initial = ctx.getImageData(0, 0, canvas.width, canvas.height);
    mattingHistoryRef.current = [initial];
    setMattingHistoryIdx(0);
  }, [data.mattingMask]);

  /* Push current canvas state to history */
  const pushHistory = useCallback(() => {
    const canvas = mattingCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Truncate any future states (when we're not at the end)
    const newHistory = mattingHistoryRef.current.slice(0, mattingHistoryIdx + 1);
    newHistory.push(imageData);
    if (newHistory.length > 30) newHistory.shift(); // Limit history
    mattingHistoryRef.current = newHistory;
    setMattingHistoryIdx(newHistory.length - 1);
  }, [mattingHistoryIdx]);

  /* Restore history state */
  const restoreHistory = useCallback((idx: number) => {
    const canvas = mattingCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = mattingHistoryRef.current[idx];
    if (!imageData) return;
    ctx.putImageData(imageData, 0, 0);
  }, []);

  /* Enter matting mode */
  const handleOpenMatting = useCallback(() => {
    const img = previewImgRef.current;
    if (img) {
      const r = img.getBoundingClientRect();
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const maxW = viewportW * 0.9;
      const maxH = viewportH * 0.82; // account for toolbar

      const scaleW = maxW / r.width;
      const scaleH = maxH / r.height;
      const scale = Math.min(scaleW, scaleH);

      const targetW = r.width * scale;
      const targetH = r.height * scale;
      const targetTop = (viewportH - targetH) / 2;
      const targetLeft = (viewportW - targetW) / 2;

      setMattingAnimRect({
        from: { top: r.top, left: r.left, width: r.width, height: r.height },
        to: { top: targetTop, left: targetLeft, width: targetW, height: targetH },
      });
    } else {
      setMattingAnimRect(null);
    }
    setIsMatting(true);
    setMattingPhase('entering');
    setMattingEnterAnimating(false);
    setMattingTool('brush');
    setMattingBrushMode('normal');
    setMattingBrushSize(40);
    mattingHistoryRef.current = [];
    setMattingHistoryIdx(-1);
  }, []);

  /* Exit matting mode */
  const handleCloseMatting = useCallback(() => {
    setIsMatting(false);
    setMattingPhase('idle');
    setMattingAnimRect(null);
    setMattingEnterAnimating(false);
  }, []);

  /* Handle matting canvas pointer events */
  const getCanvasCoords = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
      const canvas = mattingCanvasRef.current;
      if (!canvas) return [0, 0];
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
    },
    [],
  );

  const handleMattingPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = mattingCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      mattingIsDrawing.current = true;
      canvas.setPointerCapture(e.pointerId);

      const [x, y] = getCanvasCoords(e);

      if (mattingTool === 'bucket') {
        // Bucket is a one-shot operation, no stroke tracking needed
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const fillR = mattingBrushMode === 'normal' ? 255 : 0;
        const fillG = mattingBrushMode === 'normal' ? 200 : 0;
        const fillB = mattingBrushMode === 'normal' ? 0 : 0;
        const fillA = mattingBrushMode === 'normal' ? 115 : 0;
        floodFill(imageData, Math.round(x), Math.round(y), [fillR, fillG, fillB, fillA]);
        ctx.putImageData(imageData, 0, 0);
        return;
      }

      // Save baseline to restore before each redraw
      mattingStrokeBaseline.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
      mattingStrokePoints.current = [{ x, y }];
    },
    [mattingTool, mattingBrushMode, mattingBrushSize, getCanvasCoords],
  );

  const handleMattingPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!mattingIsDrawing.current) return;
      e.preventDefault();
      if (mattingTool === 'bucket') return;
      const canvas = mattingCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const [x, y] = getCanvasCoords(e);
      mattingStrokePoints.current.push({ x, y });

      // Restore pre-stroke baseline (undoes all previous frames of this stroke)
      const baseline = mattingStrokeBaseline.current;
      if (baseline) ctx.putImageData(baseline, 0, 0);

      // Redraw entire stroke as ONE continuous path → no alpha accumulation
      const points = mattingStrokePoints.current;
      if (points.length < 1) return;

      const op = mattingTool === 'brush'
        ? (mattingBrushMode === 'normal' ? 'source-over' : 'destination-out' as const)
        : 'destination-out' as const;
      const color = mattingTool === 'brush' ? MASK_COLOR : '#000';

      ctx.save();
      ctx.globalCompositeOperation = op;
      ctx.strokeStyle = color;
      ctx.lineWidth = mattingBrushSize;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
      ctx.restore();
    },
    [mattingTool, mattingBrushMode, mattingBrushSize, getCanvasCoords],
  );

  const handleMattingPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!mattingIsDrawing.current) return;
      mattingIsDrawing.current = false;
      mattingStrokeBaseline.current = null;
      mattingStrokePoints.current = [];
      const canvas = mattingCanvasRef.current;
      canvas?.releasePointerCapture(e.pointerId);
      pushHistory();
    },
    [pushHistory],
  );

  /* Undo / Redo */
  const handleMattingUndo = useCallback(() => {
    const newIdx = mattingHistoryIdx - 1;
    if (newIdx < 0) return;
    setMattingHistoryIdx(newIdx);
    restoreHistory(newIdx);
  }, [mattingHistoryIdx, restoreHistory]);

  const handleMattingRedo = useCallback(() => {
    const newIdx = mattingHistoryIdx + 1;
    if (newIdx >= mattingHistoryRef.current.length) return;
    setMattingHistoryIdx(newIdx);
    restoreHistory(newIdx);
  }, [mattingHistoryIdx, restoreHistory]);

  const handleMattingClear = useCallback(() => {
    const canvas = mattingCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pushHistory();
  }, [pushHistory]);

  /* Save matting result — mask only, don't merge with image */
  const handleMattingSave = useCallback(() => {
    const canvas = mattingCanvasRef.current;
    if (!canvas) return;

    // Save mask as standalone data URL
    const maskUrl = canvas.toDataURL('image/png');
    updateNodeData(id, { mattingMask: maskUrl } as Partial<BaseNodeData>);
    setIsMatting(false);
    setMattingPhase('idle');
    setMattingAnimRect(null);
    setMattingEnterAnimating(false);
  }, [id, updateNodeData]);

  /* Keyboard shortcuts in matting mode */
  useEffect(() => {
    if (!isMatting) return;

    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      switch (e.key.toLowerCase()) {
        case 'escape':
          handleCloseMatting();
          break;
        case 'b':
          setMattingTool((t) => {
            if (t === 'brush') {
              const next = mattingBrushMode === 'normal' ? 'alpha' : 'normal';
              setMattingBrushMode(next);
            } else {
              setMattingBrushMode('normal');
            }
            return 'brush';
          });
          break;
        case 'e':
          setMattingTool('eraser');
          break;
        case 'g':
          setMattingTool('bucket');
          break;
        case 'r':
          handleMattingClear();
          break;
        case 'z':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            handleMattingUndo();
          }
          break;
        case 'y':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            handleMattingRedo();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isMatting, handleCloseMatting, mattingBrushMode, handleMattingClear, handleMattingUndo, handleMattingRedo]);

  /* Trigger enter animation after mount */
  useEffect(() => {
    if (mattingPhase === 'entering' && mattingAnimRect && !mattingEnterAnimating) {
      // Double rAF: browser paints initial position first, then we kick off CSS transition
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setMattingEnterAnimating(true);
        });
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [mattingPhase, mattingAnimRect, mattingEnterAnimating]);

  /* Init canvas when matting enters active phase */
  useEffect(() => {
    if (mattingPhase === 'active') {
      const timer = requestAnimationFrame(() => {
        requestAnimationFrame(initMattingCanvas);
      });
      return () => cancelAnimationFrame(timer);
    }
  }, [mattingPhase, initMattingCanvas]);

  // ── Display label ──
  const displayLabel = data.fileName || data.label || '粘贴图像';

  return (
    <>
      <div className="node-wrapper relative" style={{ width: nodeWidth }}>
        <NodeLabel
          kind="ai-image"
          label={displayLabel}
          displayId={data.displayId as number | undefined}
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
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </button>
            )}
            {data.imageUrl || data.thumbnailUrl ? (
              <div className="image-preview-container">
                <img
                  ref={previewImgRef}
                  src={data.imageUrl || data.thumbnailUrl}
                  alt="Generated"
                  className="image-preview-img compact"
                />
                {data.mattingMask && (
                  <img
                    src={data.mattingMask as string}
                    alt="Mask"
                    className="image-preview-mask"
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
          <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-image" />
          <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-image" />
        </div>

        {/* Resize handle */}
        <div className="node-resize-handle" onPointerDownCapture={handleResizeStart} />

        {/* Floating toolbar — when selected AND has output */}
        {selected && (data.imageUrl || data.thumbnailUrl) && (
          <ImageNodeToolbar
            nodeId={id}
            onMatting={handleOpenMatting}
            onMultiAngle={handleOpenFreeAngle}
          />
        )}
      </div>

      {/* ════════════════════════════════════════════
           Matting Enter Animation — image scales from node to fullscreen
           ════════════════════════════════════════════ */}
      {isMatting && mattingPhase === 'entering' && mattingAnimRect && createPortal(
        <div className="matting-enter-overlay">
          <img
            src={data.imageUrl || data.thumbnailUrl}
            alt=""
            className={`matting-enter-image${mattingEnterAnimating ? ' matting-enter-image--animating' : ''}`}
            style={mattingEnterAnimating
              ? {
                  position: 'fixed',
                  top: mattingAnimRect.to.top,
                  left: mattingAnimRect.to.left,
                  width: mattingAnimRect.to.width,
                  height: mattingAnimRect.to.height,
                }
              : {
                  position: 'fixed',
                  top: mattingAnimRect.from.top,
                  left: mattingAnimRect.from.left,
                  width: mattingAnimRect.from.width,
                  height: mattingAnimRect.from.height,
                }
            }
            onTransitionEnd={() => setMattingPhase('active')}
          />
        </div>,
        document.body,
      )}

      {/* ════════════════════════════════════════════
           Matting Overlay — fullscreen mask editor (portal to body)
           ════════════════════════════════════════════ */}
      {isMatting && mattingPhase === 'active' && createPortal(
        <div className="matting-overlay">
          {/* Toolbar */}
          <MattingToolbar
            onCancel={handleCloseMatting}
            onSave={handleMattingSave}
            onToolChange={setMattingTool}
            onBrushSizeChange={setMattingBrushSize}
            onBrushModeChange={setMattingBrushMode}
            onUndo={handleMattingUndo}
            onRedo={handleMattingRedo}
            onClear={handleMattingClear}
            canUndo={mattingHistoryIdx > 0}
            canRedo={mattingHistoryIdx < mattingHistoryRef.current.length - 1}
          />

          {/* Image + canvas container */}
          <div className="matting-stage">
            <img
              ref={mattingImageRef}
              src={data.imageUrl || data.thumbnailUrl}
              alt="Editing"
              className="matting-image"
              draggable={false}
              onLoad={initMattingCanvas}
            />
            <canvas
              ref={mattingCanvasRef}
              className={`matting-canvas${mattingTool === 'bucket' ? ' cursor-crosshair' : ''}`}
              style={mattingTool !== 'bucket' ? {
                cursor: `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="${mattingBrushSize}" height="${mattingBrushSize}" viewBox="0 0 ${mattingBrushSize} ${mattingBrushSize}"><circle cx="${mattingBrushSize/2}" cy="${mattingBrushSize/2}" r="${mattingBrushSize/2 - 1}" fill="none" stroke="white" stroke-width="1" opacity="0.8"/></svg>') ${mattingBrushSize/2} ${mattingBrushSize/2}, auto`,
              } : undefined}
              onPointerDown={handleMattingPointerDown}
              onPointerMove={handleMattingPointerMove}
              onPointerUp={handleMattingPointerUp}
            />
          </div>
        </div>,
        document.body,
      )}

      {/* ════════════════════════════════════════════
           Free Angle Panel — 3D 正方体角度控制面板 (portal to body)
           ════════════════════════════════════════════ */}
      <FreeAnglePanel
        isOpen={isFreeAngle}
        imageUrl={(data.imageUrl || data.thumbnailUrl) as string | undefined}
        onClose={handleCloseFreeAngle}
        onGenerate={handleFreeAngleGenerate}
      />
    </>
  );
}

export default memo(AIImageNode);

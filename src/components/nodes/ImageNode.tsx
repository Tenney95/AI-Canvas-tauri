/**
 * ImageNode 图像节点 — 在画布上渲染图像内容，支持上传/粘贴图片、遮罩编辑、工具栏、全屏预览
 */
import { memo, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import type {
  AnnotationLayerProps,
  PointEditEditorProps,
} from '@tenney95/xiaoluo-image-editor';
import '@tenney95/xiaoluo-image-editor/style.css';
import type { BaseNodeData, ImageAnnotationLayer as ImageAnnotationLayerData } from '../../types';
import NodeLabel from './shared/NodeLabel';
import GooeyBtn from './shared/GooeyBtn';
import ImageNodeToolbar from './shared/image/ImageNodeToolbar';
import CropEditor from './shared/image/CropEditor';
import ResizeHandle from './shared/ResizeHandle';
import FullscreenOverlay from '../shared/FullscreenOverlay';
import ZoomableImage from '../shared/ZoomableImage';
import NodeError from './shared/NodeError';
import ModelDownloadDialog from '../shared/ModelDownloadDialog';
import { computeImageNodeDimensions } from './shared/image/imageUtils';
import { useNodeRename } from './shared/useNodeRename';
import { useSourceFileUpload } from './shared/useSourceFileUpload';
import { useAppStore, generateId } from '../../store/useAppStore';
import { saveDataUrlToProjectData, buildNodeFileName } from '../../services/fileService';
import { copyImage as copyImageToClipboard } from '../../services/clipboardService';
import { blobToDataUrl } from '../../store/store.utils';
import { generateOutpaintImage } from '../../services/apimartService';
import { imageUpscale, subjectMatting, checkModelExists, downloadModel } from '../../services/onnxService';
import { executeGeneration } from '../../services/generationService';
import { useCompletionFlash } from '../../hooks/useCompletionFlash';
import { createPresetNode } from './shared/toolbar/presetAction';
import type { CameraStudioResult } from './shared/image/cameraStudio';
import {
  useReferencedImageRevisions,
  withPreviewRevision,
} from '../../hooks/useReferencedImageWatcher';
import {
  cancelCanvasDerivation,
  completeCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
  type CanvasDerivationGuard,
} from '../../services/canvasDerivationGuard';

const MattingEditor = lazy(() => import('./shared/image/MattingEditor'));
const CustomGridEditor = lazy(() => import('./shared/image/CustomGridEditor'));
const ExpandEditor = lazy(() => import('./shared/image/ExpandEditor'));
const ImageComposerEditor = lazy(() => import('./shared/image/composer/ImageComposerEditor'));
const CameraStudioPanel = lazy(() => import('./shared/image/CameraStudioPanel'));

const loadImageEditorRuntime = () => import('@tenney95/xiaoluo-image-editor');

type DeferredAnnotationLayerProps = Omit<AnnotationLayerProps, 'layer'> & {
  layer: unknown;
  legacyUrl?: string;
  onLegacyError?: () => void;
};

const AnnotationLayer = lazy(async () => {
  const runtime = await loadImageEditorRuntime();
  const RuntimeAnnotationLayer = runtime.AnnotationLayer;
  return {
    default: function DeferredAnnotationLayer({
      layer,
      legacyUrl,
      onLegacyError,
      ...props
    }: DeferredAnnotationLayerProps) {
      if (runtime.isImageAnnotationLayer(layer)) {
        return <RuntimeAnnotationLayer {...props} layer={layer} />;
      }
      return legacyUrl ? (
        <img
          src={legacyUrl}
          alt="Annotation"
          className="image-preview-mask"
          onError={onLegacyError}
        />
      ) : null;
    },
  };
});

type DeferredPointEditEditorProps = Omit<PointEditEditorProps, 'initialAnnotationLayer'> & {
  initialAnnotationLayer?: unknown;
};

const PointEditEditor = lazy(async () => {
  const runtime = await loadImageEditorRuntime();
  const RuntimePointEditEditor = runtime.PointEditEditor;
  return {
    default: function DeferredPointEditEditor({
      initialAnnotationLayer,
      ...props
    }: DeferredPointEditEditorProps) {
      return (
        <RuntimePointEditEditor
          {...props}
          initialAnnotationLayer={runtime.isImageAnnotationLayer(initialAnnotationLayer)
            ? initialAnnotationLayer
            : undefined}
        />
      );
    },
  };
});

/* ════════════════════════════════════════════
   AIImageNode
   ════════════════════════════════════════════ */
function AIImageNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const justCompleted = useCompletionFlash(data.status);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const updateNodeDataTransient = useAppStore((s) => s.updateNodeDataTransient);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const isSingleSelection = useAppStore((s) => s.selectedNodeIds.length <= 1);
  const isSource = data.role === 'source';
  const nodeWidth = (data.nodeWidth as number) || 280;
  const nodeHeight = (data.nodeHeight as number) || 158;

  // ── Resize handler ──
  const handleResize = useCallback(
    (newWidth: number, newHeight: number) => {
      updateNodeDataTransient(id, { nodeWidth: newWidth, nodeHeight: newHeight } as Partial<BaseNodeData>);
    },
    [id, updateNodeDataTransient],
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
        annotation: undefined,
        annotationLayer: undefined,
      } as Partial<BaseNodeData>);
    };
    img.src = result.dataUrl;
  }, [doUpload, id, nodeWidth, updateNodeData]);

  const [isCameraStudio, setIsCameraStudio] = useState(false);
  const [imgLoadError, setImgLoadError] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [mattingError, setMattingError] = useState(false);
  const [annotateError, setAnnotateError] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const imagePreviewRef = useRef<HTMLImageElement>(null);
  const [fullscreenOrigin, setFullscreenOrigin] = useState<{ left: number; top: number; width: number; height: number } | undefined>();

  // 文件被外部工具覆盖时只刷新本地预览，不修改节点数据或撤销历史。
  const revisionFor = useReferencedImageRevisions([data.filePath]);
  const previewRevision = revisionFor(data.filePath);
  const rawDisplaySrc = (data.imageUrl || data.thumbnailUrl) as string | undefined;
  const displaySrc = withPreviewRevision(rawDisplaySrc, previewRevision);
  const annotationLayer = data.annotationLayer;

  // 当 imageUrl 或外部文件版本变化时重置加载错误状态
  useEffect(() => {
    setImgLoadError(false);
    setFullscreenError(false);
    setImgLoaded(false);
  }, [displaySrc]);
  useEffect(() => {
    setMattingError(false);
  }, [data.mattingMask]);
  useEffect(() => {
    setAnnotateError(false);
  }, [data.annotation]);

  const handleOpenCameraStudio = useCallback(() => setIsCameraStudio(true), []);
  const handleCloseCameraStudio = useCallback(() => setIsCameraStudio(false), []);

  const handleCameraStudioGenerate = useCallback((result: CameraStudioResult) => {
    const store = useAppStore.getState();
    const sourceNode = store.nodes.find((node) => node.id === id) as Node<BaseNodeData> | undefined;
    if (!sourceNode) {
      store.showToast('图片节点不存在', 'error');
      return;
    }

    const modeLabel = result.mode === 'camera'
      ? '摄影机视角'
      : result.mode === 'lighting'
        ? '摄影棚打光'
        : '视角与打光';
    const { node, edge } = createPresetNode(sourceNode, {
      label: modeLabel,
      icon: 'mdi:camera-control',
      filledPrompt: result.prompt,
      shouldTrigger: true,
    });

    store.addNodeWithEdge(node, edge);
    setIsCameraStudio(false);
    void executeGeneration(node.id, node.data.prompt, undefined, node.data);
  }, [id]);

  /* ════════════════════════════════════════════
     Crop State
     ════════════════════════════════════════════ */
  const [isCrop, setIsCrop] = useState(false);
  const pendingCropDerivation = useRef<CanvasDerivationGuard | null>(null);

  const handleOpenCrop = useCallback(() => {
    if (pendingCropDerivation.current) {
      useAppStore.getState().showToast('已有裁切任务正在处理，请稍候');
      return;
    }
    setIsCrop(true);
  }, []);
  const handleCloseCrop = useCallback(() => {
    setIsCrop(false);
  }, []);

  /** 确认裁切时立即调用：创建 loading 状态的新节点并关闭弹窗 */
  const handleCropStart = useCallback(() => {
    const store = useAppStore.getState();
    const currentNodes = store.nodes;
    const currentPos = currentNodes.find((n) => n.id === id)?.position || { x: 0, y: 0 };

    const newNodeId = `node-${generateId()}`;
    const projectId = store.currentProjectId;
    const derivation = registerCanvasDerivation(store, id, {
      placeholderNodeId: newNodeId,
      onCancel: () => {
        const liveStore = useAppStore.getState();
        if (liveStore.currentProjectId !== projectId) return;
        liveStore.setNodes(liveStore.nodes.filter((node) => node.id !== newNodeId));
      },
    });
    if (!derivation) {
      store.showToast('图片节点已失效，请重试', 'error');
      return;
    }
    pendingCropDerivation.current = derivation;

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
      const derivation = pendingCropDerivation.current;
      const nodeId = derivation?.placeholderNodeId;
      const clearPending = () => {
        if (pendingCropDerivation.current === derivation) pendingCropDerivation.current = null;
      };

      if (!derivation || !croppedDataUrl || !nodeId) {
        if (derivation) cancelCanvasDerivation(derivation);
        clearPending();
        const store = useAppStore.getState();
        if (!derivation || store.currentProjectId === derivation.projectId) {
          store.showToast('裁切失败，请重试', 'error');
        }
        return;
      }
      const ensureFresh = () => {
        const fresh = isCanvasDerivationFresh(derivation, useAppStore.getState());
        if (!fresh) {
          cancelCanvasDerivation(derivation);
          clearPending();
        }
        return fresh;
      };
      if (!ensureFresh()) return;

      try {
        let assetUrl = croppedDataUrl;
        let filePath: string | undefined;
        if (derivation.projectId !== 'default') {
          const savedName = buildNodeFileName(`${(data.label as string) || '图像'} 裁切`, 'png', 'cropped');
          const saved = await saveDataUrlToProjectData(croppedDataUrl, derivation.projectId, savedName);
          if (saved?.assetUrl) {
            assetUrl = saved.assetUrl;
            filePath = saved.filePath;
          }
        }
        if (!ensureFresh()) return;

        const dims = await computeImageNodeDimensions(assetUrl);
        if (!ensureFresh()) return;

        const liveStore = useAppStore.getState();
        liveStore.updateNodeDataTransient(nodeId, {
          imageUrl: assetUrl,
          filePath,
          status: 'success',
          imageWidth: metadata?.width ?? dims.imageWidth,
          imageHeight: metadata?.height ?? dims.imageHeight,
          nodeWidth: dims.nodeWidth,
          nodeHeight: dims.nodeHeight,
        } as Partial<BaseNodeData>);
        liveStore.commitToHistory();
        completeCanvasDerivation(derivation);
        clearPending();
        liveStore.showToast('裁切完成，已创建新节点');
      } catch {
        const shouldNotify = isCanvasDerivationFresh(derivation, useAppStore.getState());
        cancelCanvasDerivation(derivation);
        clearPending();
        if (shouldNotify) useAppStore.getState().showToast('裁切失败，请重试', 'error');
      }
    },
    [data.label],
  );

  /* ════════════════════════════════════════════
     CustomGrid State — 自定义宫格裁切
     ════════════════════════════════════════════ */
  const [isCustomGrid, setIsCustomGrid] = useState(false);

  const handleOpenCustomGrid = useCallback(() => setIsCustomGrid(true), []);
  const handleCloseCustomGrid = useCallback(() => setIsCustomGrid(false), []);

  /** 确认自定义宫格：按实际线位置生成 StoryboardNode */
  const handleCustomGridConfirm = useCallback(
    async (hPercentages: number[], vPercentages: number[]) => {
      setIsCustomGrid(false);
      const store = useAppStore.getState();
      const imageUrl = (data.imageUrl || data.thumbnailUrl) as string | undefined;
      if (!imageUrl) {
        store.showToast('无可裁切的图像', 'error');
        return;
      }

      const rows = hPercentages.length + 1;
      const cols = vPercentages.length + 1;

      store.commitToHistory();
      const srcPos = store.nodes.find((n) => n.id === id)?.position || { x: 0, y: 0 };
      const dims = await computeImageNodeDimensions(imageUrl);

      store.addNodeTransient({
        id: `node-${generateId()}`,
        type: 'ai-storyboard',
        position: { x: srcPos.x + nodeWidth + 60, y: srcPos.y },
        data: {
          label: `${(data.label as string) || '图像'} 自定义宫格${rows}×${cols}`,
          type: 'ai-storyboard',
          role: 'source',
          status: 'success',
          imageUrl,
          filePath: data.filePath as string | undefined,
          storyboardRows: rows,
          storyboardCols: cols,
          storyboardRowPositions: hPercentages,
          storyboardColPositions: vPercentages,
          nodeWidth: dims.nodeWidth,
          nodeHeight: dims.nodeHeight,
        } as BaseNodeData,
      });
      store.commitToHistory();
      store.showToast(`已按线生成 ${rows}×${cols} 自定义宫格节点`);
    },
    [id, data.imageUrl, data.thumbnailUrl, data.label, data.filePath, nodeWidth],
  );

  /* ════════════════════════════════════════════
     宫格裁切：源图生成一个「宫格分镜」节点（单节点内按 side×side 网格拼接展示）
     ════════════════════════════════════════════ */
  const handleMultiGrid = useCallback(
    async (side: number) => {
      const store = useAppStore.getState();
      const imageUrl = (data.imageUrl || data.thumbnailUrl) as string | undefined;
      if (!imageUrl) {
        store.showToast('无可裁切的图像', 'error');
        return;
      }

      store.commitToHistory();
      const srcPos = store.nodes.find((n) => n.id === id)?.position || { x: 0, y: 0 };
      // 分镜节点按源图纵横比展示 → 复用图像节点的尺寸计算
      const dims = await computeImageNodeDimensions(imageUrl);

      store.addNodeTransient({
        id: `node-${generateId()}`,
        type: 'ai-storyboard',
        position: { x: srcPos.x + nodeWidth + 60, y: srcPos.y },
        data: {
          label: `${(data.label as string) || '图像'} 宫格${side}×${side}`,
          type: 'ai-storyboard',
          role: 'source',
          status: 'success',
          imageUrl,
          filePath: data.filePath as string | undefined,
          storyboardRows: side,
          storyboardCols: side,
          nodeWidth: dims.nodeWidth,
          nodeHeight: dims.nodeHeight,
        } as BaseNodeData,
      });
      store.commitToHistory();
      store.showToast(`已生成 ${side}×${side} 宫格分镜节点`);
    },
    [id, data.imageUrl, data.thumbnailUrl, data.label, data.filePath, nodeWidth],
  );

  /* ════════════════════════════════════════════
     Compose (多图自由编辑) State
     ════════════════════════════════════════════ */
  const [isCompose, setIsCompose] = useState(false);
  const pendingComposeDerivation = useRef<CanvasDerivationGuard | null>(null);

  const handleOpenCompose = useCallback(() => {
    if (pendingComposeDerivation.current) {
      useAppStore.getState().showToast('已有合成任务正在处理，请稍候');
      return;
    }
    setIsCompose(true);
  }, []);
  const handleCloseCompose = useCallback(() => {
    setIsCompose(false);
  }, []);

  /** 确认合成：立即创建 loading 新节点并关闭弹窗 */
  const handleComposeStart = useCallback(() => {
    const store = useAppStore.getState();
    const currentPos = store.nodes.find((n) => n.id === id)?.position || { x: 0, y: 0 };

    const newNodeId = `node-${generateId()}`;
    const projectId = store.currentProjectId;
    const derivation = registerCanvasDerivation(store, id, {
      placeholderNodeId: newNodeId,
      onCancel: () => {
        const liveStore = useAppStore.getState();
        if (liveStore.currentProjectId !== projectId) return;
        liveStore.setNodes(liveStore.nodes.filter((node) => node.id !== newNodeId));
      },
    });
    if (!derivation) {
      store.showToast('图片节点已失效，请重试', 'error');
      return;
    }
    pendingComposeDerivation.current = derivation;

    const newNode: Node<BaseNodeData> = {
      id: newNodeId,
      type: 'ai-image',
      position: { x: currentPos.x + nodeWidth + 40, y: currentPos.y },
      data: {
        label: `${(data.label as string) || '图像'} 合成`,
        type: 'ai-image',
        role: 'source',
        status: 'loading',
        nodeWidth,
        nodeHeight: 158,
      } as BaseNodeData,
    };
    store.addNode(newNode);
    setIsCompose(false);
  }, [id, data.label, nodeWidth]);

  /** 合成完成后回填节点数据 */
  const handleComposeSave = useCallback(
    async (composedDataUrl: string, metadata?: { width: number; height: number }) => {
      const derivation = pendingComposeDerivation.current;
      const nodeId = derivation?.placeholderNodeId;
      const clearPending = () => {
        if (pendingComposeDerivation.current === derivation) pendingComposeDerivation.current = null;
      };

      if (!derivation || !composedDataUrl || !nodeId) {
        if (derivation) cancelCanvasDerivation(derivation);
        clearPending();
        const store = useAppStore.getState();
        if (!derivation || store.currentProjectId === derivation.projectId) {
          store.showToast('合成失败，请重试', 'error');
        }
        return;
      }
      const ensureFresh = () => {
        const fresh = isCanvasDerivationFresh(derivation, useAppStore.getState());
        if (!fresh) {
          cancelCanvasDerivation(derivation);
          clearPending();
        }
        return fresh;
      };
      if (!ensureFresh()) return;

      try {
        let assetUrl = composedDataUrl;
        let filePath: string | undefined;
        if (derivation.projectId !== 'default') {
          const savedName = buildNodeFileName(`${(data.label as string) || '图像'} 合成`, 'png', 'composed');
          const saved = await saveDataUrlToProjectData(composedDataUrl, derivation.projectId, savedName);
          if (saved?.assetUrl) {
            assetUrl = saved.assetUrl;
            filePath = saved.filePath;
          }
        }
        if (!ensureFresh()) return;

        const dims = await computeImageNodeDimensions(assetUrl);
        if (!ensureFresh()) return;

        const liveStore = useAppStore.getState();
        liveStore.updateNodeDataTransient(nodeId, {
          imageUrl: assetUrl,
          filePath,
          status: 'success',
          imageWidth: metadata?.width ?? dims.imageWidth,
          imageHeight: metadata?.height ?? dims.imageHeight,
          nodeWidth: dims.nodeWidth,
          nodeHeight: dims.nodeHeight,
        } as Partial<BaseNodeData>);
        liveStore.commitToHistory();
        completeCanvasDerivation(derivation);
        clearPending();
        liveStore.showToast('合成完成，已创建新节点');
      } catch {
        const shouldNotify = isCanvasDerivationFresh(derivation, useAppStore.getState());
        cancelCanvasDerivation(derivation);
        clearPending();
        if (shouldNotify) useAppStore.getState().showToast('合成失败，请重试', 'error');
      }
    },
    [data.label],
  );

  /* ════════════════════════════════════════════
     Expand (扩图 / outpainting) State
     ════════════════════════════════════════════ */
  const [isExpand, setIsExpand] = useState(false);

  const handleOpenExpand = useCallback(() => setIsExpand(true), []);
  const handleCloseExpand = useCallback(() => setIsExpand(false), []);

  /** 确认扩图：立即创建 loading 新节点 → 后台云端生成 → 回填结果 */
  const handleExpandGenerate = useCallback(
    async (
      compositeDataUrl: string,
      meta: { size: string; width: number; height: number; model: string; provider: string; prompt: string },
    ) => {
      const store = useAppStore.getState();
      setIsExpand(false);

      if (meta.provider !== 'apimart') {
        store.showToast(`${meta.provider} 扩图暂未实现`, 'error');
        return;
      }

      const apiKey = store.config.providers.apimart?.apiKey;
      if (!apiKey) {
        store.showToast('请先在设置中配置 APIMart API Key', 'error');
        return;
      }

      const model = meta.model.startsWith('apimart/') ? meta.model.slice('apimart/'.length) : meta.model;

      // 1. 立即创建 loading 节点（与裁切/超分一致的即时反馈）
      const currentPos = store.nodes.find((n) => n.id === id)?.position || { x: 0, y: 0 };
      const newNodeId = `node-${generateId()}`;
      const projectId = store.currentProjectId;
      const derivation = registerCanvasDerivation(store, id, {
        placeholderNodeId: newNodeId,
        onCancel: () => {
          const liveStore = useAppStore.getState();
          if (liveStore.currentProjectId !== projectId) return;
          liveStore.setNodes(liveStore.nodes.filter((node) => node.id !== newNodeId));
        },
      });
      if (!derivation) {
        store.showToast('图片节点已失效，请重试', 'error');
        return;
      }
      const newNode: Node<BaseNodeData> = {
        id: newNodeId,
        type: 'ai-image',
        position: { x: currentPos.x + nodeWidth + 40, y: currentPos.y },
        data: {
          label: `${(data.label as string) || '图像'} 扩图`,
          type: 'ai-image',
          role: 'source',
          status: 'loading',
          nodeWidth,
          nodeHeight: 158,
        } as BaseNodeData,
      };
      store.addNode(newNode);
      const ensureFresh = () => {
        const fresh = isCanvasDerivationFresh(derivation, useAppStore.getState());
        if (!fresh) cancelCanvasDerivation(derivation);
        return fresh;
      };

      // 2. 后台生成
      try {
        const result = await generateOutpaintImage(
          { apiKey, model, imageUrl: compositeDataUrl, size: meta.size, prompt: meta.prompt },
          (progress) => {
            if (!ensureFresh()) return;
            useAppStore.getState().updateNodeDataTransient(newNodeId, { output: `扩图中 ${progress}%...` });
          },
        );
        if (!ensureFresh()) return;

        const genUrl = result.imageUrls[0];
        const resp = await fetch(genUrl);
        if (!ensureFresh()) return;
        const blob = await resp.blob();
        if (!ensureFresh()) return;
        const dataUrl = await blobToDataUrl(blob);
        if (!ensureFresh()) return;

        let assetUrl = dataUrl;
        let filePath: string | undefined;
        if (derivation.projectId !== 'default') {
          const ext = blob.type.split('/').pop() || 'png';
          const savedName = buildNodeFileName(`${(data.label as string) || '图像'} 扩图`, ext, 'expand');
          const saved = await saveDataUrlToProjectData(dataUrl, derivation.projectId, savedName);
          if (saved?.assetUrl) {
            assetUrl = saved.assetUrl;
            filePath = saved.filePath;
          }
        }
        if (!ensureFresh()) return;

        const dims = await computeImageNodeDimensions(assetUrl);
        if (!ensureFresh()) return;

        const liveStore = useAppStore.getState();
        liveStore.updateNodeDataTransient(newNodeId, {
          imageUrl: assetUrl,
          filePath,
          status: 'success',
          output: undefined,
          imageWidth: dims.imageWidth,
          imageHeight: dims.imageHeight,
          nodeWidth: dims.nodeWidth,
          nodeHeight: dims.nodeHeight,
        } as Partial<BaseNodeData>);
        liveStore.commitToHistory();
        completeCanvasDerivation(derivation);
        liveStore.showToast('扩图完成，已创建新节点');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : '扩图失败';
        const shouldNotify = isCanvasDerivationFresh(derivation, useAppStore.getState());
        cancelCanvasDerivation(derivation);
        if (shouldNotify) useAppStore.getState().showToast(message, 'error');
      }
    },
    [id, data.label, nodeWidth],
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
     Annotate State
     ════════════════════════════════════════════ */
  const [isAnnotate, setIsAnnotate] = useState(false);

  const handleOpenAnnotate = useCallback(() => setIsAnnotate(true), []);
  const handleCloseAnnotate = useCallback(() => setIsAnnotate(false), []);

  const handleAnnotateSave = useCallback(
    (layer: ImageAnnotationLayerData) => {
      updateNodeData(id, {
        annotation: undefined,
        annotationLayer: layer,
      } as Partial<BaseNodeData>);
      setIsAnnotate(false);
    },
    [id, updateNodeData],
  );

  /* ════════════════════════════════════════════
     Fullscreen State
     ════════════════════════════════════════════ */
  const [isFullscreen, setIsFullscreen] = useState(false);
  const handleOpenFullscreen = useCallback(() => {
    const rect = imagePreviewRef.current?.getBoundingClientRect();
    setFullscreenOrigin(rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : undefined);
    setIsFullscreen(true);
  }, []);
  const handleCloseFullscreen = useCallback(() => {
    setIsFullscreen(false);
    setFullscreenOrigin(undefined);
  }, []);

  /* ════════════════════════════════════════════
     Upscale — ONNX + DirectML 超分
     ════════════════════════════════════════════ */
  const [isUpscaling, setIsUpscaling] = useState(false);
  const [upscaleProgress, setUpscaleProgress] = useState(0);
  const [downloadPrompt, setDownloadPrompt] = useState(false);
  const [isDownloadingModel, setIsDownloadingModel] = useState(false);
  const modelName = 'realesrgan-x4.onnx';

  /** 检查模型可用性 → 若缺失则弹出下载确认 */
  const handleUpscale = useCallback(async () => {
    const filePath = data.filePath as string | undefined;
    if (!filePath) {
      useAppStore.getState().showToast('该图片没有本地文件，无法超分', 'error');
      return;
    }

    // 检查模型是否存在
    const modelExists = await checkModelExists(modelName);
    if (!modelExists) {
      setDownloadPrompt(true);
      return;
    }

    // 模型已就绪 → 直接执行超分
    await doUpscale(filePath);
  }, [data.filePath, modelName]);

  /** 重绘 — 打开 PromptPanel 对话框 */
  const handleRepaint = useCallback(() => {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    if (el) {
      const rect = el.getBoundingClientRect();
      useAppStore.getState().openNodeDialog(id, { x: rect.left + rect.width / 2, y: rect.bottom });
    } else {
      useAppStore.getState().openNodeDialog(id);
    }
  }, [id]);

  /** 复制图像到系统剪贴板（位图，可粘贴到 PS / 聊天） */
  const handleCopyImage = useCallback(async () => {
    const store = useAppStore.getState();
    const imageUrl = (data.imageUrl || data.thumbnailUrl) as string | undefined;
    if (!imageUrl) {
      store.showToast('没有可用的图片', 'error');
      return;
    }
    const ok = await copyImageToClipboard(imageUrl);
    store.showToast(ok ? '已复制图像到剪贴板' : '复制失败', ok ? undefined : 'error');
  }, [data.imageUrl, data.thumbnailUrl]);

  /** 确认下载模型 */
  const handleDownloadConfirm = useCallback(async () => {
    setDownloadPrompt(false);
    setIsDownloadingModel(true);
    try {
      await downloadModel(modelName);
      useAppStore.getState().showToast('模型下载完成，开始超分...', 'success');
    } catch (err: unknown) {
      // Tauri 2 invoke reject 抛出的是字符串或 { message } 对象，非标准 Error
      const message =
        typeof err === 'string' ? err
        : err instanceof Error ? err.message
        : (err && typeof err === 'object' && 'message' in err) ? String((err as Record<string, unknown>).message)
        : '模型下载失败';
      useAppStore.getState().showToast(message, 'error');
      setIsDownloadingModel(false);
      return;
    }
    setIsDownloadingModel(false);

    // 下载完成 → 继续执行超分
    const filePath = data.filePath as string;
    await doUpscale(filePath);
  }, [data.filePath, modelName]);

  /** 取消下载 */
  const handleDownloadCancel = useCallback(() => {
    setDownloadPrompt(false);
    setIsDownloadingModel(false);
  }, []);

  /** 执行实际的超分推理 */
  const doUpscale = useCallback(async (filePath: string) => {
    setIsUpscaling(true);
    setUpscaleProgress(0);
    updateNodeDataTransient(id, { status: 'loading', output: 'ONNX 超分处理中...' });

    // 监听后端分块进度，仅响应本次任务（taskId 隔离多节点并发超分）
    const taskId = `upscale-${id}-${Date.now()}`;
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<{ taskId: string; percent: number }>(
      'image-upscale-progress',
      (e) => {
        if (e.payload.taskId === taskId) setUpscaleProgress(e.payload.percent);
      },
    );

    try {
      const ext = filePath.split('.').pop() || 'png';
      const baseName = filePath.replace(/\.[^.]+$/, '');
      const outputPath = `${baseName}_upscaled.${ext}`;

      const result = await imageUpscale(filePath, outputPath, modelName, taskId);

      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const assetUrl = convertFileSrc(result.output_path);

      const store = useAppStore.getState();
      const currentNodes = store.nodes;
      const currentPos = currentNodes.find((n) => n.id === id)?.position || { x: 0, y: 0 };

      const dims = await computeImageNodeDimensions(assetUrl);
      const newNode: Node<BaseNodeData> = {
        id: `node-${generateId()}`,
        type: 'ai-image',
        position: { x: currentPos.x + nodeWidth + 40, y: currentPos.y },
        data: {
          label: `${(data.label as string) || '图像'} 高清`,
          type: 'ai-image',
          role: 'source',
          imageUrl: assetUrl,
          filePath: result.output_path,
          status: 'success',
          imageWidth: dims.imageWidth,
          imageHeight: dims.imageHeight,
          nodeWidth: dims.nodeWidth,
          nodeHeight: dims.nodeHeight,
        } as BaseNodeData,
      };
      store.addNode(newNode);
      store.commitToHistory();

      updateNodeDataTransient(id, { status: 'success' });
      store.showToast(`超分完成 ${result.input_size} → ${result.output_size}`);
    } catch (err: unknown) {
      // Tauri 2 invoke reject 抛出的是字符串或 { message } 对象，非标准 Error
      const message =
        typeof err === 'string' ? err
        : err instanceof Error ? err.message
        : (err && typeof err === 'object' && 'message' in err) ? String((err as Record<string, unknown>).message)
        : 'ONNX 超分失败';
      updateNodeDataTransient(id, { status: 'error', error: message });
      useAppStore.getState().showToast(message, 'error');
    } finally {
      unlisten();
      setIsUpscaling(false);
      setUpscaleProgress(0);
    }
  }, [id, data.label, nodeWidth, modelName, updateNodeDataTransient]);

  /* ════════════════════════════════════════════
     Subject Matting — ONNX RMBG-1.4 主体识别
     ════════════════════════════════════════════ */
  const mattingModelName = 'rmbg-1.4.onnx';
  const [isMattingRunning, setIsMattingRunning] = useState(false);
  const [mattingDownloadPrompt, setMattingDownloadPrompt] = useState(false);
  const [isDownloadingMattingModel, setIsDownloadingMattingModel] = useState(false);

  const handleSubjectMatting = useCallback(async () => {
    const filePath = data.filePath as string | undefined;
    if (!filePath) {
      useAppStore.getState().showToast('该图片没有本地文件，无法识别主体', 'error');
      return;
    }

    const modelExists = await checkModelExists(mattingModelName);
    if (!modelExists) {
      setMattingDownloadPrompt(true);
      return;
    }

    await doSubjectMatting(filePath);
  }, [data.filePath, mattingModelName]);

  const handleMattingDownloadConfirm = useCallback(async () => {
    setMattingDownloadPrompt(false);
    setIsDownloadingMattingModel(true);
    try {
      await downloadModel(mattingModelName);
      useAppStore.getState().showToast('模型下载完成，开始识别主体...', 'success');
    } catch (err: unknown) {
      const message =
        typeof err === 'string' ? err
        : err instanceof Error ? err.message
        : (err && typeof err === 'object' && 'message' in err) ? String((err as Record<string, unknown>).message)
        : '模型下载失败';
      useAppStore.getState().showToast(message, 'error');
      setIsDownloadingMattingModel(false);
      return;
    }
    setIsDownloadingMattingModel(false);

    const filePath = data.filePath as string;
    await doSubjectMatting(filePath);
  }, [data.filePath, mattingModelName]);

  const handleMattingDownloadCancel = useCallback(() => {
    setMattingDownloadPrompt(false);
    setIsDownloadingMattingModel(false);
  }, []);

  const doSubjectMatting = useCallback(async (filePath: string) => {
    setIsMattingRunning(true);
    updateNodeDataTransient(id, { status: 'loading', output: 'AI 识别主体中...' });

    const taskId = `matting-${id}-${Date.now()}`;

    try {
      // 主体图含透明通道(RGBA)，JPEG 不支持，强制 PNG
      const baseName = filePath.replace(/\.[^.]+$/, '');
      const outputPath = `${baseName}_subject.png`;

      const result = await subjectMatting(filePath, outputPath, mattingModelName, taskId);

      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const assetUrl = convertFileSrc(result.subject_path);

      const store = useAppStore.getState();
      const currentNodes = store.nodes;
      const currentPos = currentNodes.find((n) => n.id === id)?.position || { x: 0, y: 0 };

      const dims = await computeImageNodeDimensions(assetUrl);
      const newNode: Node<BaseNodeData> = {
        id: `node-${generateId()}`,
        type: 'ai-image',
        position: { x: currentPos.x + nodeWidth + 40, y: currentPos.y },
        data: {
          label: `${(data.label as string) || '图像'} 主体`,
          type: 'ai-image',
          role: 'source',
          imageUrl: assetUrl,
          filePath: result.subject_path,
          status: 'success',
          imageWidth: dims.imageWidth,
          imageHeight: dims.imageHeight,
          nodeWidth: dims.nodeWidth,
          nodeHeight: dims.nodeHeight,
        } as BaseNodeData,
      };
      store.addNode(newNode);
      store.commitToHistory();

      updateNodeDataTransient(id, { status: 'success' });
      store.showToast(`主体识别完成，已创建新节点 (${result.input_size})`);
    } catch (err: unknown) {
      const message =
        typeof err === 'string' ? err
        : err instanceof Error ? err.message
        : (err && typeof err === 'object' && 'message' in err) ? String((err as Record<string, unknown>).message)
        : '主体识别失败';
      updateNodeDataTransient(id, { status: 'error', error: message });
      useAppStore.getState().showToast(message, 'error');
    } finally {
      setIsMattingRunning(false);
    }
  }, [id, data.label, nodeWidth, mattingModelName, updateNodeDataTransient]);

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
          className={`node image-node ${selected ? 'selected' : ''} ${data.status === 'loading' || isUploading ? 'loading' : ''} ${justCompleted ? 'just-completed' : ''}`}
          style={{ height: nodeHeight }}
        >
          <div className="node-preview compact">
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
                    ref={imagePreviewRef}
                    src={displaySrc}
                    alt="Generated"
                    className={`image-preview-img compact img-reveal${imgLoaded ? ' is-loaded' : ''}`}
                    data-source-url={data.sourceUrl}
                    onLoad={() => setImgLoaded(true)}
                    onError={() => setImgLoadError(true)}
                    onDoubleClick={(e) => { e.stopPropagation(); handleOpenFullscreen(); }}
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
                {annotationLayer ? (
                  <Suspense fallback={data.annotation && !annotateError ? (
                    <img
                      src={data.annotation as string}
                      alt="Annotation"
                      className="image-preview-mask"
                      onError={() => setAnnotateError(true)}
                    />
                  ) : null}>
                    <AnnotationLayer
                      layer={annotationLayer}
                      legacyUrl={data.annotation as string | undefined}
                      onLegacyError={() => setAnnotateError(true)}
                      className="image-annotation-layer"
                      fit="cover"
                    />
                  </Suspense>
                ) : data.annotation && !annotateError ? (
                  <img
                    src={data.annotation as string}
                    alt="Annotation"
                    className="image-preview-mask"
                    onError={() => setAnnotateError(true)}
                  />
                ) : null}
                {/* 超分加载动画：光晕流动 + 扫描光带 */}
                {isUpscaling && (
                  <div className="upscale-glow" aria-hidden="true">
                    <div className="upscale-glow-scan" />
                    <div className="upscale-glow-ring" />
                    <span className="upscale-glow-label">
                      <span className="upscale-glow-dot" />
                      {upscaleProgress > 0 ? `超分中 ${upscaleProgress}%` : '超分中'}
                    </span>
                  </div>
                )}
                {/* 主体识别加载动画：复用超分光晕效果 */}
                {isMattingRunning && (
                  <div className="upscale-glow" aria-hidden="true">
                    <div className="upscale-glow-scan" />
                    <div className="upscale-glow-ring" />
                    <span className="upscale-glow-label">
                      <span className="upscale-glow-dot" />
                      主体识别中...
                    </span>
                  </div>
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
              isSource ? (
                <button
                  type="button"
                  className="node-preview-placeholder nodrag nopan border-0 bg-transparent p-0 cursor-pointer transition-[color,transform] duration-100 hover:text-canvas-text-secondary active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-canvas-border"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleUpload();
                  }}
                  data-tooltip="上传图片"
                  aria-label="上传图片"
                >
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </button>
              ) : (
                <div className="node-preview-placeholder">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                </div>
              )
            )}
          </div>
          {data.error && <NodeError nodeId={id} message={data.error} />}
          <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-image" >
            <GooeyBtn className="gooey-btn-left" hue={142} />
          </Handle>
          <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-image" >
            <GooeyBtn className="gooey-btn-right" hue={142} />
          </Handle>
        </div>

        {/* Resize handle */}
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

        {/* Keep the toolbar mounted to animate selection changes. */}
        {(data.imageUrl || data.thumbnailUrl) && (
          <div className={`node-toolbar-shell ${selected && isSingleSelection ? 'is-visible' : ''}`}>
            <ImageNodeToolbar
              nodeId={id}
              onUpload={handleUpload}
              onMatting={handleOpenMatting}
              onSubjectMatting={handleSubjectMatting}
              onCameraStudio={handleOpenCameraStudio}
              onExpand={handleOpenExpand}
              onMultiGrid={handleMultiGrid}
              onCustomGrid={handleOpenCustomGrid}
              onCompose={handleOpenCompose}
              onCrop={handleOpenCrop}
              onFullscreen={handleOpenFullscreen}
              onAnnotate={handleOpenAnnotate}
              onUpscale={handleUpscale}
              onRepaint={handleRepaint}
              onCopyFile={handleCopyImage}
              isUpscaling={isUpscaling}
              isSubjectMattingRunning={isMattingRunning}
            />
          </div>
        )}
      </div>

      {/* 编辑器覆盖层：条件挂载 —— 关闭时不实例化组件（每个 ImageNode 少跑 6 套 hooks） */}

      <Suspense fallback={null}>
        {/* Matting Editor Overlay */}
        {isMatting && (
          <MattingEditor
            isOpen={isMatting}
            imageUrl={(data.imageUrl || data.thumbnailUrl) as string}
            initialMask={data.mattingMask as string | undefined}
            onClose={handleCloseMatting}
            onSave={handleMattingSave}
          />
        )}

        {/* Annotate Editor Overlay */}
        {isAnnotate && (
          <PointEditEditor
            isOpen={isAnnotate}
            imageUrl={(data.imageUrl || data.thumbnailUrl) as string}
            initialAnnotationLayer={annotationLayer}
            onClose={handleCloseAnnotate}
            onSave={handleAnnotateSave}
          />
        )}

        {/* Expand Editor — 扩图 */}
        {isExpand && (
          <ExpandEditor
            isOpen={isExpand}
            imageUrl={(data.imageUrl || data.thumbnailUrl) as string}
            onClose={handleCloseExpand}
            onGenerate={handleExpandGenerate}
          />
        )}

        {/* Crop Editor */}
        {isCrop && (
          <CropEditor
            isOpen={isCrop}
            imageUrl={(data.imageUrl || data.thumbnailUrl) as string}
            onClose={handleCloseCrop}
            onStart={handleCropStart}
            onSave={handleCropSave}
          />
        )}

        {/* CustomGrid Editor */}
        {isCustomGrid && (
          <CustomGridEditor
            isOpen={isCustomGrid}
            imageUrl={(data.imageUrl || data.thumbnailUrl) as string}
            onClose={handleCloseCustomGrid}
            onConfirm={handleCustomGridConfirm}
          />
        )}
      </Suspense>

      {isCameraStudio && (
        <Suspense fallback={null}>
          <CameraStudioPanel
            isOpen={isCameraStudio}
            imageUrl={(data.imageUrl || data.thumbnailUrl) as string | undefined}
            onClose={handleCloseCameraStudio}
            onGenerate={handleCameraStudioGenerate}
          />
        </Suspense>
      )}

      {/* 多图自由编辑 / 合成（konva 懒加载，首次打开时才拉取 chunk） */}
      {isCompose && (
        <Suspense fallback={null}>
          <ImageComposerEditor
            isOpen={isCompose}
            nodeId={id}
            imageUrl={(data.imageUrl || data.thumbnailUrl) as string}
            onClose={handleCloseCompose}
            onStart={handleComposeStart}
            onSave={handleComposeSave}
          />
        </Suspense>
      )}

      {/* Fullscreen preview */}
      <FullscreenOverlay
        isOpen={isFullscreen}
        onClose={handleCloseFullscreen}
        data-tooltip={(data.label as string) || '图片预览'}
        hidePanel
      >
        {fullscreenError ? (
          <div className="flex flex-col items-center justify-center gap-3 text-canvas-text-muted" style={{ height: '100vh' }}>
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
          <ZoomableImage
            src={(data.imageUrl || data.thumbnailUrl) as string}
            alt={(data.label as string) || '预览'}
            className="fullscreen-img-view"
            originRect={fullscreenOrigin}
            onClose={handleCloseFullscreen}
            onError={() => setFullscreenError(true)}
          />
        )}
      </FullscreenOverlay>

      {/* ── 超分模型下载弹窗（Portal → body）── */}
      <ModelDownloadDialog
        type="upscale"
        showPrompt={downloadPrompt}
        showDownloading={isDownloadingModel}
        onConfirm={handleDownloadConfirm}
        onCancel={handleDownloadCancel}
      />

      {/* ── 主体识别模型下载弹窗（Portal → body）── */}
      <ModelDownloadDialog
        type="matting"
        showPrompt={mattingDownloadPrompt}
        showDownloading={isDownloadingMattingModel}
        onConfirm={handleMattingDownloadConfirm}
        onCancel={handleMattingDownloadCancel}
      />
    </>
  );
}

export default memo(AIImageNode);

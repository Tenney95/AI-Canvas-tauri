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
import { useImageNodeOnnxActions } from './shared/image/useImageNodeOnnxActions';
import { useT } from '../../i18n';
import { getImageLoadRetryDelay, isRetryableImageSource } from '../../utils/imageLoadRetry';

const MattingEditor = lazy(() => import('./shared/image/MattingEditor'));
const CustomGridEditor = lazy(() => import('./shared/image/CustomGridEditor'));
const ExpandEditor = lazy(() => import('./shared/image/ExpandEditor'));
const CropEditor = lazy(() => import('./shared/image/CropEditor'));
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
  const t = useT();
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
  // 加载状态按来源记账：来源一变旧状态自然失效，无需 effect 逐个重置
  const [imgState, setImgState] = useState<{
    src?: string;
    loaded?: boolean;
    failed?: boolean;
    retryAttempt?: number;
    retrying?: boolean;
  }>({});
  const imageRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageRetryRef = useRef<{ src?: string; scheduledAttempts: number }>({ scheduledAttempts: 0 });
  const [fullscreenFailedSrc, setFullscreenFailedSrc] = useState<string | undefined>();
  const [mattingFailedSrc, setMattingFailedSrc] = useState<string | undefined>();
  const [annotateFailedSrc, setAnnotateFailedSrc] = useState<string | undefined>();
  const imagePreviewRef = useRef<HTMLImageElement>(null);
  const [fullscreenOrigin, setFullscreenOrigin] = useState<{ left: number; top: number; width: number; height: number } | undefined>();

  // 文件被外部工具覆盖时只刷新本地预览，不修改节点数据或撤销历史。
  const revisionFor = useReferencedImageRevisions([data.filePath]);
  const previewRevision = revisionFor(data.filePath);
  const rawDisplaySrc = (data.imageUrl || data.thumbnailUrl) as string | undefined;
  const displaySrc = withPreviewRevision(rawDisplaySrc, previewRevision);
  const annotationLayer = data.annotationLayer;

  // imageUrl 或外部文件版本变化后，下面这些标记自动回到初始态
  const imgLoaded = imgState.src === displaySrc && !!imgState.loaded;
  const imgLoadError = imgState.src === displaySrc && !!imgState.failed;
  const imgRetrying = imgState.src === displaySrc && !!imgState.retrying;
  const imgRetryAttempt = imgState.src === displaySrc ? (imgState.retryAttempt ?? 0) : 0;
  const fullscreenError = !!displaySrc && fullscreenFailedSrc === displaySrc;
  const mattingError = !!data.mattingMask && mattingFailedSrc === data.mattingMask;
  const annotateError = !!data.annotation && annotateFailedSrc === data.annotation;

  useEffect(() => {
    imageRetryRef.current = { src: displaySrc, scheduledAttempts: 0 };
    return () => {
      if (imageRetryTimerRef.current) clearTimeout(imageRetryTimerRef.current);
      imageRetryTimerRef.current = null;
    };
  }, [displaySrc]);

  const handlePreviewImageLoad = useCallback(() => {
    if (!displaySrc) return;
    if (imageRetryTimerRef.current) clearTimeout(imageRetryTimerRef.current);
    imageRetryTimerRef.current = null;
    imageRetryRef.current = { src: displaySrc, scheduledAttempts: 0 };
    setImgState({ src: displaySrc, loaded: true });
  }, [displaySrc]);

  const handlePreviewImageError = useCallback(() => {
    if (!displaySrc) return;

    if (imageRetryTimerRef.current) clearTimeout(imageRetryTimerRef.current);
    imageRetryTimerRef.current = null;

    if (imageRetryRef.current.src !== displaySrc) {
      imageRetryRef.current = { src: displaySrc, scheduledAttempts: 0 };
    }
    const scheduledAttempts = imageRetryRef.current.scheduledAttempts;
    const retryDelay = isRetryableImageSource(displaySrc)
      ? getImageLoadRetryDelay(scheduledAttempts)
      : null;
    if (retryDelay === null) {
      setImgState({ src: displaySrc, failed: true, retryAttempt: scheduledAttempts });
      return;
    }

    const nextAttempt = scheduledAttempts + 1;
    imageRetryRef.current.scheduledAttempts = nextAttempt;
    setImgState({ src: displaySrc, retryAttempt: scheduledAttempts, retrying: true });
    imageRetryTimerRef.current = setTimeout(() => {
      imageRetryTimerRef.current = null;
      if (imageRetryRef.current.src !== displaySrc) return;
      setImgState({ src: displaySrc, retryAttempt: nextAttempt, retrying: true });
    }, retryDelay);
  }, [displaySrc]);

  const handlePreviewImageReload = useCallback(() => {
    if (imageRetryTimerRef.current) clearTimeout(imageRetryTimerRef.current);
    imageRetryTimerRef.current = null;
    imageRetryRef.current = { src: displaySrc, scheduledAttempts: 0 };
    setImgState({});
  }, [displaySrc]);

  const handleOpenCameraStudio = useCallback(() => setIsCameraStudio(true), []);
  const handleCloseCameraStudio = useCallback(() => setIsCameraStudio(false), []);

  const handleCameraStudioGenerate = useCallback((result: CameraStudioResult) => {
    const store = useAppStore.getState();
    const sourceNode = store.nodes.find((node) => node.id === id) as Node<BaseNodeData> | undefined;
    if (!sourceNode) {
      store.showToast(t('图片节点不存在'), 'error');
      return;
    }

    const modeLabel = result.mode === 'camera'
      ? t('摄影机视角')
      : result.mode === 'lighting'
        ? t('摄影棚打光')
        : t('视角与打光');
    const { node, edge } = createPresetNode(sourceNode, {
      label: modeLabel,
      icon: 'mdi:camera-control',
      filledPrompt: result.prompt,
      shouldTrigger: true,
    });

    store.addNodeWithEdge(node, edge);
    setIsCameraStudio(false);
    void executeGeneration(node.id, node.data.prompt, undefined, node.data);
  }, [id, t]);

  /* ════════════════════════════════════════════
     Crop State
     ════════════════════════════════════════════ */
  const [isCrop, setIsCrop] = useState(false);
  const pendingCropDerivation = useRef<CanvasDerivationGuard | null>(null);

  const handleOpenCrop = useCallback(() => {
    if (pendingCropDerivation.current) {
      useAppStore.getState().showToast(t('已有裁切任务正在处理，请稍候'));
      return;
    }
    setIsCrop(true);
  }, [t]);
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
      store.showToast(t('图片节点已失效，请重试'), 'error');
      return;
    }
    pendingCropDerivation.current = derivation;

    const newNode: Node<BaseNodeData> = {
      id: newNodeId,
      type: 'ai-image',
      position: { x: currentPos.x + nodeWidth + 40, y: currentPos.y },
      data: {
        label: t('{name} 裁切', { name: (data.label as string) || t('图像') }),
        type: 'ai-image',
        role: 'source',
        status: 'loading',
        nodeWidth,
        nodeHeight: 158,
      } as BaseNodeData,
    };
    store.addNode(newNode);
    setIsCrop(false);
  }, [id, data.label, nodeWidth, t]);

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
          store.showToast(t('裁切失败，请重试'), 'error');
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
          const savedName = buildNodeFileName(t('{name} 裁切', { name: (data.label as string) || t('图像') }), 'png', 'cropped');
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
        liveStore.showToast(t('裁切完成，已创建新节点'));
      } catch {
        const shouldNotify = isCanvasDerivationFresh(derivation, useAppStore.getState());
        cancelCanvasDerivation(derivation);
        clearPending();
        if (shouldNotify) useAppStore.getState().showToast(t('裁切失败，请重试'), 'error');
      }
    },
    [data.label, t],
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
        store.showToast(t('无可裁切的图像'), 'error');
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
          label: t('{name} 自定义宫格{rows}×{cols}', { name: (data.label as string) || t('图像'), rows, cols }),
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
      store.showToast(t('已按线生成 {rows}×{cols} 自定义宫格节点', { rows, cols }));
    },
    [id, data.imageUrl, data.thumbnailUrl, data.label, data.filePath, nodeWidth, t],
  );

  /* ════════════════════════════════════════════
     宫格裁切：源图生成一个「宫格分镜」节点（单节点内按 side×side 网格拼接展示）
     ════════════════════════════════════════════ */
  const handleMultiGrid = useCallback(
    async (side: number) => {
      const store = useAppStore.getState();
      const imageUrl = (data.imageUrl || data.thumbnailUrl) as string | undefined;
      if (!imageUrl) {
        store.showToast(t('无可裁切的图像'), 'error');
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
          label: t('{name} 宫格{side}×{side}', { name: (data.label as string) || t('图像'), side }),
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
      store.showToast(t('已生成 {side}×{side} 宫格分镜节点', { side }));
    },
    [id, data.imageUrl, data.thumbnailUrl, data.label, data.filePath, nodeWidth, t],
  );

  /* ════════════════════════════════════════════
     Compose (多图自由编辑) State
     ════════════════════════════════════════════ */
  const [isCompose, setIsCompose] = useState(false);
  const pendingComposeDerivation = useRef<CanvasDerivationGuard | null>(null);

  const handleOpenCompose = useCallback(() => {
    if (pendingComposeDerivation.current) {
      useAppStore.getState().showToast(t('已有合成任务正在处理，请稍候'));
      return;
    }
    setIsCompose(true);
  }, [t]);
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
      store.showToast(t('图片节点已失效，请重试'), 'error');
      return;
    }
    pendingComposeDerivation.current = derivation;

    const newNode: Node<BaseNodeData> = {
      id: newNodeId,
      type: 'ai-image',
      position: { x: currentPos.x + nodeWidth + 40, y: currentPos.y },
      data: {
        label: t('{name} 合成', { name: (data.label as string) || t('图像') }),
        type: 'ai-image',
        role: 'source',
        status: 'loading',
        nodeWidth,
        nodeHeight: 158,
      } as BaseNodeData,
    };
    store.addNode(newNode);
    setIsCompose(false);
  }, [id, data.label, nodeWidth, t]);

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
          store.showToast(t('合成失败，请重试'), 'error');
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
          const savedName = buildNodeFileName(t('{name} 合成', { name: (data.label as string) || t('图像') }), 'png', 'composed');
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
        liveStore.showToast(t('合成完成，已创建新节点'));
      } catch {
        const shouldNotify = isCanvasDerivationFresh(derivation, useAppStore.getState());
        cancelCanvasDerivation(derivation);
        clearPending();
        if (shouldNotify) useAppStore.getState().showToast(t('合成失败，请重试'), 'error');
      }
    },
    [data.label, t],
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
        store.showToast(t('{provider} 扩图暂未实现', { provider: meta.provider }), 'error');
        return;
      }

      const apiKey = store.config.providers.apimart?.apiKey;
      if (!apiKey) {
        store.showToast(t('请先在设置中配置 APIMart API Key'), 'error');
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
        store.showToast(t('图片节点已失效，请重试'), 'error');
        return;
      }
      const newNode: Node<BaseNodeData> = {
        id: newNodeId,
        type: 'ai-image',
        position: { x: currentPos.x + nodeWidth + 40, y: currentPos.y },
        data: {
          label: t('{name} 扩图', { name: (data.label as string) || t('图像') }),
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
            useAppStore.getState().updateNodeDataTransient(newNodeId, { output: t('扩图中 {progress}%...', { progress }) });
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
          const savedName = buildNodeFileName(t('{name} 扩图', { name: (data.label as string) || t('图像') }), ext, 'expand');
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
        liveStore.showToast(t('扩图完成，已创建新节点'));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('扩图失败');
        const shouldNotify = isCanvasDerivationFresh(derivation, useAppStore.getState());
        cancelCanvasDerivation(derivation);
        if (shouldNotify) useAppStore.getState().showToast(message, 'error');
      }
    },
    [id, data.label, nodeWidth, t],
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
      store.showToast(t('没有可用的图片'), 'error');
      return;
    }
    const ok = await copyImageToClipboard(imageUrl);
    store.showToast(ok ? t('已复制图像到剪贴板') : t('复制失败'), ok ? undefined : 'error');
  }, [data.imageUrl, data.thumbnailUrl, t]);

  const handleReversePrompt = useCallback(() => {
    const store = useAppStore.getState();
    const imageUrl = (data.imageUrl || data.thumbnailUrl) as string | undefined;
    if (!imageUrl) {
      store.showToast(t('没有可反推的图片'), 'error');
      return;
    }
    store.setReversePromptRequest({ sourceNodeId: id, kind: 'image', imageUrls: [imageUrl] });
  }, [data.imageUrl, data.thumbnailUrl, id, t]);

  const {
    isUpscaling,
    upscaleProgress,
    downloadPrompt,
    isDownloadingModel,
    handleUpscale,
    handleDownloadConfirm,
    handleDownloadCancel,
    isMattingRunning,
    mattingDownloadPrompt,
    isDownloadingMattingModel,
    handleSubjectMatting,
    handleMattingDownloadConfirm,
    handleMattingDownloadCancel,
  } = useImageNodeOnnxActions({
    id,
    data,
    nodeWidth,
    updateNodeDataTransient,
  });


  const { displayLabel, handleRename } = useNodeRename(id, data, t('粘贴图像'));

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
                    <span className="text-xs">{t('图片加载失败')}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); handlePreviewImageReload(); }}
                      className="text-[10px] px-2 py-0.5 rounded bg-canvas-hover hover:bg-canvas-border transition-colors"
                    >
                      {t('重新加载')}
                    </button>
                  </div>
                ) : (
                  <img
                    key={`${displaySrc}:${imgRetryAttempt}`}
                    ref={imagePreviewRef}
                    src={displaySrc}
                    alt="Generated"
                    className={`image-preview-img compact img-reveal${imgLoaded ? ' is-loaded' : ''}`}
                    data-source-url={data.sourceUrl}
                    onLoad={handlePreviewImageLoad}
                    onError={handlePreviewImageError}
                    onDoubleClick={(e) => { e.stopPropagation(); handleOpenFullscreen(); }}
                  />
                )}
                {imgRetrying && (
                  <div className="absolute inset-0 flex items-center justify-center bg-canvas-card" aria-hidden="true">
                    <div className="spinner" />
                  </div>
                )}
                {data.mattingMask && !mattingError && (
                  <img
                    src={data.mattingMask as string}
                    alt="Mask"
                    className="image-preview-mask"
                    onError={() => setMattingFailedSrc(data.mattingMask as string)}
                  />
                )}
                {annotationLayer ? (
                  <Suspense fallback={data.annotation && !annotateError ? (
                    <img
                      src={data.annotation as string}
                      alt="Annotation"
                      className="image-preview-mask"
                      onError={() => setAnnotateFailedSrc(data.annotation as string)}
                    />
                  ) : null}>
                    <AnnotationLayer
                      layer={annotationLayer}
                      legacyUrl={data.annotation as string | undefined}
                      onLegacyError={() => setAnnotateFailedSrc(data.annotation as string)}
                      className="image-annotation-layer"
                      fit="cover"
                    />
                  </Suspense>
                ) : data.annotation && !annotateError ? (
                  <img
                    src={data.annotation as string}
                    alt="Annotation"
                    className="image-preview-mask"
                    onError={() => setAnnotateFailedSrc(data.annotation as string)}
                  />
                ) : null}
                {/* 超分加载动画：光晕流动 + 扫描光带 */}
                {isUpscaling && (
                  <div className="upscale-glow" aria-hidden="true">
                    <div className="upscale-glow-scan" />
                    <div className="upscale-glow-ring" />
                    <span className="upscale-glow-label">
                      <span className="upscale-glow-dot" />
                      {upscaleProgress > 0 ? t('超分中 {progress}%', { progress: upscaleProgress }) : t('超分中')}
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
                      {t('主体识别中...')}
                    </span>
                  </div>
                )}
              </div>
            ) : isUploading ? (
              <div className="node-preview-loading">
                <div className="spinner large" />
                <span>{t('上传中...')}</span>
              </div>
            ) : data.status === 'loading' ? (
              <div className="node-preview-loading">
                <div className="spinner large" />
                <span>{t('生成图像中...')}</span>
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
                  data-tooltip={t('上传图片')}
                  aria-label={t('上传图片')}
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
              onReversePrompt={handleReversePrompt}
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
        data-tooltip={(data.label as string) || t('图片预览')}
        hidePanel
      >
        {fullscreenError ? (
          <div className="flex flex-col items-center justify-center gap-3 text-canvas-text-muted" style={{ height: '100vh' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <span className="text-sm">{t('图片加载失败')}</span>
            <button
              onClick={() => setFullscreenFailedSrc(undefined)}
              className="text-xs px-3 py-1 rounded bg-canvas-hover hover:bg-canvas-border transition-colors"
            >
              {t('重新加载')}
            </button>
          </div>
        ) : (
          <ZoomableImage
            src={(data.imageUrl || data.thumbnailUrl) as string}
            alt={(data.label as string) || t('预览')}
            className="fullscreen-img-view"
            originRect={fullscreenOrigin}
            onClose={handleCloseFullscreen}
            onError={() => setFullscreenFailedSrc(displaySrc)}
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

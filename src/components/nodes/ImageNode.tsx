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
import AnnotateEditor from './shared/image/AnnotateEditor';
import CropEditor from './shared/image/CropEditor';
import ExpandEditor from './shared/image/ExpandEditor';
import ImageComposerEditor from './shared/image/composer/ImageComposerEditor';
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
import { blobToDataUrl } from '../../store/store.utils';
import { generateAngleImage, generateOutpaintImage } from '../../services/apimartService';
import { imageUpscale, subjectMatting, checkModelExists, downloadModel } from '../../services/onnxService';
import { useCompletionFlash } from '../../hooks/useCompletionFlash';

/* ════════════════════════════════════════════
   AIImageNode
   ════════════════════════════════════════════ */
function AIImageNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const justCompleted = useCompletionFlash(data.status);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const isSingleSelection = useAppStore((s) => s.selectedNodeIds.length <= 1);
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
  const [imgLoaded, setImgLoaded] = useState(false);
  const [mattingError, setMattingError] = useState(false);
  const [annotateError, setAnnotateError] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);

  // 当 imageUrl 变化时重置加载错误状态
  const displaySrc = (data.imageUrl || data.thumbnailUrl) as string | undefined;
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
            const savedName = buildNodeFileName(`角度视图 ${params.rotation.toFixed(0)}°`, ext, `angle_${params.rotation.toFixed(0)}`);
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
        const savedName = buildNodeFileName(`${(data.label as string) || '图像'} 裁切`, 'png', 'cropped');
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
     Compose (多图自由编辑) State
     ════════════════════════════════════════════ */
  const [isCompose, setIsCompose] = useState(false);
  const pendingComposeNodeId = useRef<string | null>(null);

  const handleOpenCompose = useCallback(() => setIsCompose(true), []);
  const handleCloseCompose = useCallback(() => {
    setIsCompose(false);
    pendingComposeNodeId.current = null;
  }, []);

  /** 确认合成：立即创建 loading 新节点并关闭弹窗 */
  const handleComposeStart = useCallback(() => {
    const store = useAppStore.getState();
    const currentPos = store.nodes.find((n) => n.id === id)?.position || { x: 0, y: 0 };

    const newNodeId = `node-${generateId()}`;
    pendingComposeNodeId.current = newNodeId;

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
      const store = useAppStore.getState();
      const nodeId = pendingComposeNodeId.current;
      pendingComposeNodeId.current = null;

      if (!composedDataUrl || !nodeId) {
        if (nodeId) store.deleteNode(nodeId);
        store.showToast('合成失败，请重试', 'error');
        return;
      }

      let assetUrl = composedDataUrl;
      let filePath: string | undefined;
      const projectId = store.currentProjectId;
      if (projectId && projectId !== 'default') {
        const savedName = buildNodeFileName(`${(data.label as string) || '图像'} 合成`, 'png', 'composed');
        const saved = await saveDataUrlToProjectData(composedDataUrl, projectId, savedName);
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

      store.showToast('合成完成，已创建新节点');
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

      // 2. 后台生成
      try {
        const result = await generateOutpaintImage(
          { apiKey, model, imageUrl: compositeDataUrl, size: meta.size, prompt: meta.prompt },
          (progress) => {
            store.updateNodeData(newNodeId, { output: `扩图中 ${progress}%...` });
          },
        );

        const genUrl = result.imageUrls[0];
        const resp = await fetch(genUrl);
        const blob = await resp.blob();
        const dataUrl = await blobToDataUrl(blob);

        let assetUrl = dataUrl;
        let filePath: string | undefined;
        const projectId = store.currentProjectId;
        if (projectId && projectId !== 'default') {
          const ext = blob.type.split('/').pop() || 'png';
          const savedName = buildNodeFileName(`${(data.label as string) || '图像'} 扩图`, ext, 'expand');
          const saved = await saveDataUrlToProjectData(dataUrl, projectId, savedName);
          if (saved && saved.assetUrl) {
            assetUrl = saved.assetUrl;
            filePath = saved.filePath;
          }
        }

        const dims = await computeImageNodeDimensions(assetUrl);
        store.updateNodeData(newNodeId, {
          imageUrl: assetUrl,
          filePath,
          status: 'success',
          output: undefined,
          imageWidth: dims.nodeWidth,
          imageHeight: dims.nodeHeight,
          nodeWidth: dims.nodeWidth,
          nodeHeight: dims.nodeHeight,
        } as Partial<BaseNodeData>);
        store.commitToHistory();
        store.showToast('扩图完成，已创建新节点');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : '扩图失败';
        store.deleteNode(newNodeId);
        store.showToast(message, 'error');
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
    (annotationUrl: string) => {
      updateNodeData(id, { annotation: annotationUrl } as Partial<BaseNodeData>);
      setIsAnnotate(false);
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
  }, []);

  /** 执行实际的超分推理 */
  const doUpscale = useCallback(async (filePath: string) => {
    setIsUpscaling(true);
    setUpscaleProgress(0);
    updateNodeData(id, { status: 'loading', output: 'ONNX 超分处理中...' });

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
          imageWidth: dims.nodeWidth,
          imageHeight: dims.nodeHeight,
          nodeWidth: dims.nodeWidth,
          nodeHeight: dims.nodeHeight,
        } as BaseNodeData,
      };
      store.addNode(newNode);
      store.commitToHistory();

      updateNodeData(id, { status: 'success' });
      store.showToast(`超分完成 ${result.input_size} → ${result.output_size}`);
    } catch (err: unknown) {
      // Tauri 2 invoke reject 抛出的是字符串或 { message } 对象，非标准 Error
      const message =
        typeof err === 'string' ? err
        : err instanceof Error ? err.message
        : (err && typeof err === 'object' && 'message' in err) ? String((err as Record<string, unknown>).message)
        : 'ONNX 超分失败';
      updateNodeData(id, { status: 'error', error: message });
      useAppStore.getState().showToast(message, 'error');
    } finally {
      unlisten();
      setIsUpscaling(false);
      setUpscaleProgress(0);
    }
  }, [id, data.label, nodeWidth, modelName, updateNodeData]);

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
  }, []);

  const doSubjectMatting = useCallback(async (filePath: string) => {
    setIsMattingRunning(true);
    updateNodeData(id, { status: 'loading', output: 'AI 识别主体中...' });

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
          imageWidth: dims.nodeWidth,
          imageHeight: dims.nodeHeight,
          nodeWidth: dims.nodeWidth,
          nodeHeight: dims.nodeHeight,
        } as BaseNodeData,
      };
      store.addNode(newNode);
      store.commitToHistory();

      updateNodeData(id, { status: 'success' });
      store.showToast(`主体识别完成，已创建新节点 (${result.input_size})`);
    } catch (err: unknown) {
      const message =
        typeof err === 'string' ? err
        : err instanceof Error ? err.message
        : (err && typeof err === 'object' && 'message' in err) ? String((err as Record<string, unknown>).message)
        : '主体识别失败';
      updateNodeData(id, { status: 'error', error: message });
      useAppStore.getState().showToast(message, 'error');
    } finally {
      setIsMattingRunning(false);
    }
  }, [id, data.label, nodeWidth, mattingModelName, updateNodeData]);

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
            {isSource && !data.imageUrl && !data.thumbnailUrl && (
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
                    className={`image-preview-img compact img-reveal${imgLoaded ? ' is-loaded' : ''}`}
                    data-source-url={data.sourceUrl}
                    onLoad={() => setImgLoaded(true)}
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
                {data.annotation && !annotateError && (
                  <img
                    src={data.annotation as string}
                    alt="Annotation"
                    className="image-preview-mask"
                    onError={() => setAnnotateError(true)}
                  />
                )}
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
          currentWidth={nodeWidth}
          currentHeight={nodeHeight}
          minWidth={160}
          minHeight={120}
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
              onMultiAngle={handleOpenFreeAngle}
              onExpand={handleOpenExpand}
              onCompose={handleOpenCompose}
              onCrop={handleOpenCrop}
              onFullscreen={handleOpenFullscreen}
              onAnnotate={handleOpenAnnotate}
              onUpscale={handleUpscale}
              onRepaint={handleRepaint}
            />
          </div>
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

      {/* Annotate Editor Overlay */}
      <AnnotateEditor
        isOpen={isAnnotate}
        imageUrl={(data.imageUrl || data.thumbnailUrl) as string}
        initialAnnotation={data.annotation as string | undefined}
        onClose={handleCloseAnnotate}
        onSave={handleAnnotateSave}
      />

      {/* Free Angle Panel */}
      <FreeAnglePanel
        isOpen={isFreeAngle}
        imageUrl={(data.imageUrl || data.thumbnailUrl) as string | undefined}
        onClose={handleCloseFreeAngle}
        onGenerate={handleFreeAngleGenerate}
      />

      {/* Expand Editor — 扩图 */}
      <ExpandEditor
        isOpen={isExpand}
        imageUrl={(data.imageUrl || data.thumbnailUrl) as string}
        onClose={handleCloseExpand}
        onGenerate={handleExpandGenerate}
      />

      {/* Crop Editor */}
      <CropEditor
        isOpen={isCrop}
        imageUrl={(data.imageUrl || data.thumbnailUrl) as string}
        onClose={handleCloseCrop}
        onStart={handleCropStart}
        onSave={handleCropSave}
      />

      {/* 多图自由编辑 / 合成 */}
      <ImageComposerEditor
        isOpen={isCompose}
        nodeId={id}
        imageUrl={(data.imageUrl || data.thumbnailUrl) as string}
        onClose={handleCloseCompose}
        onStart={handleComposeStart}
        onSave={handleComposeSave}
      />

      {/* Fullscreen preview */}
      <FullscreenOverlay
        isOpen={isFullscreen}
        onClose={handleCloseFullscreen}
        title={(data.label as string) || '图片预览'}
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

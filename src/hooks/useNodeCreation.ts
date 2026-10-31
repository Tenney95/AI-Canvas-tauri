/**
 * useNodeCreation — 节点创建 Hook
 * 封装所有节点创建方法（文本/图片/视频/音频）、文件拖放（浏览器 + Tauri 原生）
 */
import { t } from '../i18n';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Node as RFNode } from '@xyflow/react';
import { useAppStore, generateId, computeImageNodeDimensions } from '../store/useAppStore';
import { arrayBufferToBase64, copyFileToProjectData, readBinaryFile } from '../services/fileService';
import type { BaseNodeData } from '../types';
import { isExternalDropCaptured } from '../utils/dropCapture';
import { nativeDropClientPosition } from '../utils/nativeDropPosition';
import { textNodeHeight } from '../utils/num';
import { COMFY_REFMOD_MIME } from '../utils/comfyRefmod';
import { registerCanvasImport, registerCanvasDerivation, isCanvasDerivationFresh, completeCanvasDerivation } from '../services/canvasDerivationGuard';
import { getPreferredNodeModel } from '../services/modelPreferenceService';

import { classifyFile, MIME_MAP } from '../utils/sourceFileType';
export { classifyFile, FILE_EXT_IMAGE, FILE_EXT_VIDEO, FILE_EXT_AUDIO, FILE_EXT_TEXT } from '../utils/sourceFileType';
export type { FileCategory } from '../utils/sourceFileType';

function getFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}


// ── Hook ──

export function useNodeCreation() {
  const rf = useReactFlow();
  const addNode = useAppStore((s) => s.addNode);

  // ── Drag-over visual state (shared by browser HTML5 + Tauri native) ──
  const [isDragOver, setIsDragOver] = useState(false);
  const enterCount = useRef(0);

  // ===========================
  //  Node creation helpers
  // ===========================

  const addTextNode = useCallback(
    (position: { x: number; y: number }, opts?: { label?: string; prompt?: string; width?: number; height?: number }) => {
      const defaultModel = getPreferredNodeModel('ai-text', useAppStore.getState());
      addNode({
        id: `node-${generateId()}`,
        type: 'ai-text',
        position,
        data: {
          label: opts?.label ?? '生成文本',
          type: 'ai-text' as const,
          prompt: opts?.prompt ?? '',
          status: 'idle' as const,
          nodeWidth: opts?.width ?? 280,
          nodeHeight: opts?.height ?? 160,
          ...defaultModel,
        },
      } as RFNode<BaseNodeData>);
    },
    [addNode],
  );

  const addImageNode = useCallback(
    async (position: { x: number; y: number }, opts?: { label?: string; dataUrl?: string }) => {
      const dataUrl = opts?.dataUrl;
      const isGenerator = !dataUrl;
      const defaultModel = isGenerator ? getPreferredNodeModel('ai-image', useAppStore.getState()) : null;
      const dims = dataUrl
        ? await computeImageNodeDimensions(dataUrl)
        : { nodeWidth: 280, nodeHeight: 158 };
      addNode({
        id: `node-${generateId()}`,
        type: 'ai-image',
        position,
        data: {
          label: opts?.label ?? '生成图像',
          type: 'ai-image' as const,
          role: dataUrl ? ('source' as const) : ('generator' as const),
          status: dataUrl ? ('success' as const) : ('idle' as const),
          ...(dataUrl
            ? { imageUrl: dataUrl }
            : { prompt: '', aspectRatio: '16:9' as const, imageSize: '2K' as const }),
          ...dims,
          ...defaultModel,
        },
      } as RFNode<BaseNodeData>);
    },
    [addNode],
  );

  const addVideoNode = useCallback(
    (position: { x: number; y: number }, opts?: { label?: string; dataUrl?: string }) => {
      const dataUrl = opts?.dataUrl;
      const isGenerator = !dataUrl;
      const defaultModel = isGenerator ? getPreferredNodeModel('ai-video', useAppStore.getState()) : null;
      addNode({
        id: `node-${generateId()}`,
        type: 'ai-video',
        position,
        data: {
          label: opts?.label ?? '生成视频',
          type: 'ai-video' as const,
          role: dataUrl ? ('source' as const) : ('generator' as const),
          status: dataUrl ? ('success' as const) : ('idle' as const),
          ...(dataUrl ? { videoUrl: dataUrl } : { prompt: '' }),
          nodeWidth: 280,
          nodeHeight: 160,
          ...defaultModel,
        },
      } as RFNode<BaseNodeData>);
    },
    [addNode],
  );

  const addAudioNode = useCallback(
    (position: { x: number; y: number }, opts?: { label?: string; dataUrl?: string }) => {
      const dataUrl = opts?.dataUrl;
      const isGenerator = !dataUrl;
      const defaultModel = isGenerator ? getPreferredNodeModel('ai-audio', useAppStore.getState()) : null;
      addNode({
        id: `node-${generateId()}`,
        type: 'ai-audio',
        position,
        data: {
          label: opts?.label ?? '生成音频',
          type: 'ai-audio' as const,
          role: dataUrl ? ('source' as const) : ('generator' as const),
          status: dataUrl ? ('success' as const) : ('idle' as const),
          ...(dataUrl ? { audioUrl: dataUrl } : { prompt: '' }),
          nodeWidth: 260,
          nodeHeight: 140,
          ...defaultModel,
        },
      } as RFNode<BaseNodeData>);
    },
    [addNode],
  );

  // ===========================
  //  Browser HTML5 drag-and-drop
  // ===========================

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes(COMFY_REFMOD_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    if (useAppStore.getState().workflowPanelOpen || isExternalDropCaptured()) return;
    enterCount.current++;
    if (e.dataTransfer?.types?.length > 0) setIsDragOver(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes(COMFY_REFMOD_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes(COMFY_REFMOD_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    enterCount.current--;
    if (enterCount.current <= 0) {
      enterCount.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes(COMFY_REFMOD_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      enterCount.current = 0;
      if (useAppStore.getState().workflowPanelOpen || isExternalDropCaptured()) return;
      const dt = e.dataTransfer;
      if (!dt || dt.files.length === 0) return;
      const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      await useAppStore.getState().pasteExternalFromDataTransfer(dt, pos, 20, '已拖入');
    },
    [rf],
  );

  // ===========================
  //  Tauri native drag-and-drop
  // ===========================

  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;

    let cancelled = false;

    (async () => {
      // Tauri v2 把拖拽拆成 drag-enter/over/drop/leave 四个事件。
      // 用【全局 listen】而非 webview 级 onDragDropEvent：后者收不到同进程 tauri-plugin-drag
      // （资源搜索窗拖拽）投递到本窗口的 drop。全局通道两种来源都能收到。
      const { listen } = await import('@tauri-apps/api/event');

      // Clean up any previous listener before registering a new one
      unlistenRef.current?.();
      unlistenRef.current = null;
      if (cancelled) return;

      type DragPayload =
        | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
        | { type: 'over'; position: { x: number; y: number } }
        | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
        | { type: 'leave' };

      // drop 会同时从 webview 与全局两路到达（外部拖拽），去重
      let lastDropTs = 0;

      const handleDrag = async (payload: DragPayload) => {
        if (cancelled) return;
        if (payload.type === 'drop') {
          if (Date.now() - lastDropTs < 400) return;
          lastDropTs = Date.now();
        }
        // 全屏编辑器（如合成器）独占外部拖放时，画布跳过建节点
        if (useAppStore.getState().workflowPanelOpen || isExternalDropCaptured()) { setIsDragOver(false); return; }

        if (payload.type === 'enter' || payload.type === 'over') {
          setIsDragOver(true);
          return;
        }
        if (payload.type === 'leave') {
          setIsDragOver(false);
          return;
        }

        // payload.type === 'drop'
        const { paths, position } = payload;
        setIsDragOver(false);
        if (!paths?.length) return;

        const flowPos = rf.screenToFlowPosition(nativeDropClientPosition(position));
        const store = useAppStore.getState();
        const recordSuccessfulDrop = (path: string, nodeId: string, projectId: string) => {
          const current = useAppStore.getState();
          if (current.currentProjectId === projectId
            && current.nodes.some((node) => node.id === nodeId && node.data.status === 'success')) {
            void current.markAssetUsed({ path });
          }
        };
        let count = 0;
        const maxItems = 20;

        for (const fp of paths) {
          if (count >= maxItems) break;
          const ext = fp.split('.').pop()?.toLowerCase() || '';
          const fileName = getFileName(fp);
          const cat = classifyFile(ext);
          if (!cat) continue;

          const offX = count * 30;
          const offY = count * 30;

          if (useAppStore.getState().currentProjectId !== store.currentProjectId) break;
          const importGuard = registerCanvasImport(useAppStore.getState());
          if (!importGuard) break;
          const isFresh = () => isCanvasDerivationFresh(importGuard, useAppStore.getState());
          try {
            const projectId = store.currentProjectId;
            if (cat !== 'text' && projectId && projectId !== 'default') {
              // 立即显示占位节点；后台复制只允许回写原项目、原节点与原 revision。
              const nodeId = `node-${generateId()}`;
              const type = `ai-${cat}` as BaseNodeData['type'];
              const field = cat === 'image' ? 'imageUrl' : cat === 'video' ? 'videoUrl' : 'audioUrl';
              store.addNode({
                id: nodeId, type,
                position: { x: flowPos.x + offX, y: flowPos.y + offY },
                data: { label: fileName, type, role: 'source', status: 'loading',
                  nodeWidth: cat === 'audio' ? 260 : 280, nodeHeight: cat === 'audio' ? 140 : cat === 'image' ? 158 : 160 },
              });
              count++;
              const guard = registerCanvasDerivation(useAppStore.getState(), nodeId);
              if (!guard) continue;
              void (async () => {
                const canWrite = () => isCanvasDerivationFresh(guard, useAppStore.getState());
                try {
                  const result = await copyFileToProjectData(fp, projectId);
                  if (!canWrite()) return;
                  let url = result?.assetUrl;
                  if (!url) {
                    const content = await readBinaryFile(fp);
                    if (!canWrite()) return;
                    url = `data:${MIME_MAP[ext] || 'application/octet-stream'};base64,${arrayBufferToBase64(content.buffer)}`;
                  }
                  const dims = cat === 'image' ? await computeImageNodeDimensions(url) : {};
                  if (!canWrite()) return;
                  useAppStore.getState().updateNodeDataTransient(nodeId, {
                    [field]: url, status: 'success', ...dims,
                    ...(result?.assetUrl ? { label: result.fileName, filePath: result.filePath, fileName: result.fileName } : {}),
                  });
                  recordSuccessfulDrop(fp, nodeId, projectId);
                } catch (err) {
                  if (canWrite()) useAppStore.getState().updateNodeDataTransient(nodeId, {
                    status: 'error', error: err instanceof Error ? err.message : '拷贝失败',
                  });
                } finally { completeCanvasDerivation(guard); }
              })();
              continue;
            }

            const content = await readBinaryFile(fp);
            if (!isFresh()) break;
            if (cat === 'text') {
              const isMarkdown = ext === 'md';
              const text = new TextDecoder('utf-8').decode(content);
              if (!isMarkdown && !text.trim()) continue;
              const lines = text.split('\n').length;
              const nodeType = isMarkdown ? 'ai-markdown' : 'ai-text';
              store.addNode({
                id: `node-${generateId()}`, type: nodeType,
                position: { x: flowPos.x + offX, y: flowPos.y + offY },
                data: { label: fileName, type: nodeType, role: 'source', output: text, status: 'success', fileName,
                  nodeWidth: 280, nodeHeight: isMarkdown ? textNodeHeight(lines, 160) : textNodeHeight(lines) },
              });
            } else {
              const dataUrl = `data:${MIME_MAP[ext] || 'application/octet-stream'};base64,${arrayBufferToBase64(content.buffer)}`;
              const dims = cat === 'image' ? await computeImageNodeDimensions(dataUrl)
                : { nodeWidth: cat === 'audio' ? 260 : 280, nodeHeight: cat === 'audio' ? 140 : 160 };
              if (!isFresh()) break;
              const type = `ai-${cat}` as BaseNodeData['type'];
              store.addNode({
                id: `node-${generateId()}`, type,
                position: { x: flowPos.x + offX, y: flowPos.y + offY },
                data: { label: fileName, type, role: 'source', status: 'success', fileName, ...dims,
                  [cat === 'image' ? 'imageUrl' : cat === 'video' ? 'videoUrl' : 'audioUrl']: dataUrl },
              });
            }
            if (projectId) void useAppStore.getState().markAssetUsed({ path: fp });
            count++;
          } catch {
            if (isFresh()) store.showToast(t('文件读取失败'), 'error');
          } finally { completeCanvasDerivation(importGuard); }
        }

        if (count > 0 && useAppStore.getState().currentProjectId === store.currentProjectId) store.showToast(t('已拖入 {count} 个源节点', { count }));
      };

      type RawPaths = { paths: string[]; position: { x: number; y: number } };
      // webview 级：外部拖拽的 enter/over/leave/drop 只发到目标 webview
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      const unWebview = await getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type !== 'over') console.log('[drag webview]', e.payload.type);
        handleDrag(e.payload as DragPayload);
      });
      const un = [
        unWebview,
        // 全局 drop：补上 tauri-plugin-drag（资源搜索窗）投递、webview 收不到的 drop（外部 drop 也会来一份 → 去重）
        await listen<RawPaths>('tauri://drag-drop', (e) => {
          console.log('[drag global drop]', e.payload.paths);
          handleDrag({ type: 'drop', paths: e.payload.paths, position: e.payload.position });
        }),
      ];
      unlistenRef.current = () => un.forEach((u) => u());
    })();

    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [rf]);

  // ===========================
  //  Double-click → text node
  // ===========================

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('react-flow__pane')) return;
      const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addTextNode(pos);
    },
    [rf, addTextNode],
  );

  return {
    addTextNode,
    addImageNode,
    addVideoNode,
    addAudioNode,
    isDragOver,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onDoubleClick,
  } as const;
}

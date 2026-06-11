/**
 * useNodeCreation — 节点创建 Hook
 * 封装所有节点创建方法（文本/图片/视频/音频）、文件拖放（浏览器 + Tauri 原生）
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Node as RFNode } from '@xyflow/react';
import { useAppStore, generateId, computeImageNodeDimensions } from '../store/useAppStore';
import { arrayBufferToBase64, copyFileToProjectData } from '../services/fileService';
import { readFile } from '@tauri-apps/plugin-fs';
import type { BaseNodeData } from '../types';

// ── File type constants ──

const FILE_EXT_IMAGE: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
const FILE_EXT_VIDEO: readonly string[] = ['mp4', 'webm', 'avi', 'mov', 'mkv'];
const FILE_EXT_AUDIO: readonly string[] = ['mp3', 'wav', 'ogg', 'flac', 'aac'];
const FILE_EXT_TEXT: readonly string[] = [
  'txt', 'md', 'json', 'xml', 'csv', 'html', 'css', 'js', 'ts', 'jsx', 'tsx',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'log', 'py', 'java', 'c', 'cpp', 'h',
  'rs', 'go', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql', 'r', 'swift', 'kt',
];

const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo',
  mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
};

export { FILE_EXT_IMAGE, FILE_EXT_VIDEO, FILE_EXT_AUDIO, FILE_EXT_TEXT };

// ── Model preference helper ──
const MODEL_PREF_KEY = 'canvas-model-prefs';

function loadDefaultModel(nodeType: string): { model: string; provider: string } | null {
  try {
    const raw = localStorage.getItem(MODEL_PREF_KEY);
    if (!raw) return null;
    const prefs: Record<string, string> = JSON.parse(raw);
    const modelValue = prefs[nodeType];
    if (!modelValue) return null;
    // modelValue format: "provider/modelId" → data.model stores the full value, data.provider stores the prefix
    const slashIdx = modelValue.indexOf('/');
    if (slashIdx === -1) return null;
    const provider = modelValue.slice(0, slashIdx);
    if (!provider) return null;
    return { model: modelValue, provider };
  } catch {
    return null;
  }
}

export type FileCategory = 'image' | 'video' | 'audio' | 'text';

export function classifyFile(ext: string): FileCategory | null {
  const e = ext.toLowerCase();
  if (FILE_EXT_IMAGE.includes(e)) return 'image';
  if (FILE_EXT_VIDEO.includes(e)) return 'video';
  if (FILE_EXT_AUDIO.includes(e)) return 'audio';
  if (FILE_EXT_TEXT.includes(e)) return 'text';
  return null;
}

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
      const defaultModel = loadDefaultModel('ai-text');
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
          ...(defaultModel ? { model: defaultModel.model, provider: defaultModel.provider } : {}),
        },
      } as RFNode<BaseNodeData>);
    },
    [addNode],
  );

  const addImageNode = useCallback(
    async (position: { x: number; y: number }, opts?: { label?: string; dataUrl?: string }) => {
      const dataUrl = opts?.dataUrl;
      const isGenerator = !dataUrl;
      const defaultModel = isGenerator ? loadDefaultModel('ai-image') : null;
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
          ...(defaultModel ? { model: defaultModel.model, provider: defaultModel.provider } : {}),
        },
      } as RFNode<BaseNodeData>);
    },
    [addNode],
  );

  const addVideoNode = useCallback(
    (position: { x: number; y: number }, opts?: { label?: string; dataUrl?: string }) => {
      const dataUrl = opts?.dataUrl;
      const isGenerator = !dataUrl;
      const defaultModel = isGenerator ? loadDefaultModel('ai-video') : null;
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
          ...(defaultModel ? { model: defaultModel.model, provider: defaultModel.provider } : {}),
        },
      } as RFNode<BaseNodeData>);
    },
    [addNode],
  );

  const addAudioNode = useCallback(
    (position: { x: number; y: number }, opts?: { label?: string; dataUrl?: string }) => {
      const dataUrl = opts?.dataUrl;
      const isGenerator = !dataUrl;
      const defaultModel = isGenerator ? loadDefaultModel('ai-audio') : null;
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
          ...(defaultModel ? { model: defaultModel.model, provider: defaultModel.provider } : {}),
        },
      } as RFNode<BaseNodeData>);
    },
    [addNode],
  );

  // ===========================
  //  Browser HTML5 drag-and-drop
  // ===========================

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    enterCount.current++;
    if (e.dataTransfer?.types?.length > 0) setIsDragOver(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
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
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      enterCount.current = 0;
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
      const { listen } = await import('@tauri-apps/api/event');

      // Clean up any previous listener before registering a new one
      unlistenRef.current?.();
      unlistenRef.current = null;
      if (cancelled) return;

      type DragPayload = {
        type: 'enter' | 'over' | 'leave' | 'drop' | 'cancelled';
        paths: string[];
        position: { x: number; y: number };
      };

      const ul = await listen<DragPayload>('tauri://drag-drop', async (event) => {
        if (cancelled) return;
        const { type, paths, position } = event.payload;

        if (type === 'enter' || type === 'over') { setIsDragOver(true); return; }
        if (type === 'leave' || type === 'cancelled') { setIsDragOver(false); return; }

        // type === 'drop'
        setIsDragOver(false);
        if (!paths?.length) return;

        const scale = window.devicePixelRatio || 1;
        const flowPos = rf.screenToFlowPosition({ x: position.x / scale, y: position.y / scale });
        const store = useAppStore.getState();
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

          try {
            if (cat === 'image' || cat === 'video' || cat === 'audio') {
              const projectId = store.currentProjectId;
              if (projectId && projectId !== 'default') {
                // Create node immediately with loading, copy file in background
                if (cat === 'image') {
                  const nodeId = `node-${generateId()}`;
                  store.addNode({
                    id: nodeId,
                    type: 'ai-image',
                    position: { x: flowPos.x + offX, y: flowPos.y + offY },
                    data: { label: fileName, type: 'ai-image', role: 'source', status: 'loading', nodeWidth: 280, nodeHeight: 158 },
                  } as Parameters<typeof store.addNode>[0]);
                  count++;
                  void (async () => {
                    try {
                      const result = await copyFileToProjectData(fp, projectId);
                      if (result && result.assetUrl) {
                        const dims = await computeImageNodeDimensions(result.assetUrl);
                        store.updateNodeData(nodeId, { label: result.fileName, imageUrl: result.assetUrl, filePath: result.filePath, fileName: result.fileName, status: 'success', ...dims });
                      } else {
                        const content = await readFile(fp);
                        const base64 = arrayBufferToBase64(content.buffer);
                        const mime = MIME_MAP[ext] || 'application/octet-stream';
                        const dataUrl = `data:${mime};base64,${base64}`;
                        const dims = await computeImageNodeDimensions(dataUrl);
                        store.updateNodeData(nodeId, { imageUrl: dataUrl, status: 'success', ...dims });
                      }
                    } catch (err) {
                      console.error(`[drop] failed for "${fp}":`, err);
                      store.updateNodeData(nodeId, { status: 'error', error: err instanceof Error ? err.message : '拷贝失败' });
                    }
                  })();
                } else if (cat === 'video') {
                  const nodeId = `node-${generateId()}`;
                  store.addNode({
                    id: nodeId,
                    type: 'ai-video',
                    position: { x: flowPos.x + offX, y: flowPos.y + offY },
                    data: { label: fileName, type: 'ai-video', role: 'source', status: 'loading', nodeWidth: 280, nodeHeight: 160 },
                  } as Parameters<typeof store.addNode>[0]);
                  count++;
                  void (async () => {
                    try {
                      const result = await copyFileToProjectData(fp, projectId);
                      if (result && result.assetUrl) {
                        store.updateNodeData(nodeId, { label: result.fileName, videoUrl: result.assetUrl, filePath: result.filePath, fileName: result.fileName, status: 'success' });
                      } else {
                        const content = await readFile(fp);
                        const base64 = arrayBufferToBase64(content.buffer);
                        const mime = MIME_MAP[ext] || 'application/octet-stream';
                        const dataUrl = `data:${mime};base64,${base64}`;
                        store.updateNodeData(nodeId, { videoUrl: dataUrl, status: 'success' });
                      }
                    } catch (err) {
                      console.error(`[drop] failed for "${fp}":`, err);
                      store.updateNodeData(nodeId, { status: 'error', error: err instanceof Error ? err.message : '拷贝失败' });
                    }
                  })();
                } else {
                  const nodeId = `node-${generateId()}`;
                  store.addNode({
                    id: nodeId,
                    type: 'ai-audio',
                    position: { x: flowPos.x + offX, y: flowPos.y + offY },
                    data: { label: fileName, type: 'ai-audio', role: 'source', status: 'loading', nodeWidth: 260, nodeHeight: 140 },
                  } as Parameters<typeof store.addNode>[0]);
                  count++;
                  void (async () => {
                    try {
                      const result = await copyFileToProjectData(fp, projectId);
                      if (result && result.assetUrl) {
                        store.updateNodeData(nodeId, { label: result.fileName, audioUrl: result.assetUrl, filePath: result.filePath, fileName: result.fileName, status: 'success' });
                      } else {
                        const content = await readFile(fp);
                        const base64 = arrayBufferToBase64(content.buffer);
                        const mime = MIME_MAP[ext] || 'application/octet-stream';
                        const dataUrl = `data:${mime};base64,${base64}`;
                        store.updateNodeData(nodeId, { audioUrl: dataUrl, status: 'success' });
                      }
                    } catch (err) {
                      console.error(`[drop] failed for "${fp}":`, err);
                      store.updateNodeData(nodeId, { status: 'error', error: err instanceof Error ? err.message : '拷贝失败' });
                    }
                  })();
                }
                continue;
              }

              // Fallback: read into memory (browser mode or copy failed)
              const content = await readFile(fp);
              const base64 = arrayBufferToBase64(content.buffer);
              const mime = MIME_MAP[ext] || 'application/octet-stream';
              const dataUrl = `data:${mime};base64,${base64}`;

              if (cat === 'image') {
                const dims = await computeImageNodeDimensions(dataUrl);
                store.addNode({
                  id: `node-${generateId()}`,
                  type: 'ai-image',
                  position: { x: flowPos.x + offX, y: flowPos.y + offY },
                  data: { label: fileName, type: 'ai-image', role: 'source', imageUrl: dataUrl, status: 'success', fileName, ...dims },
                } as Parameters<typeof store.addNode>[0]);
              } else if (cat === 'video') {
                store.addNode({
                  id: `node-${generateId()}`,
                  type: 'ai-video',
                  position: { x: flowPos.x + offX, y: flowPos.y + offY },
                  data: { label: fileName, type: 'ai-video', role: 'source', videoUrl: dataUrl, status: 'success', fileName, nodeWidth: 280, nodeHeight: 160 },
                } as Parameters<typeof store.addNode>[0]);
              } else {
                store.addNode({
                  id: `node-${generateId()}`,
                  type: 'ai-audio',
                  position: { x: flowPos.x + offX, y: flowPos.y + offY },
                  data: { label: fileName, type: 'ai-audio', role: 'source', audioUrl: dataUrl, status: 'success', fileName, nodeWidth: 260, nodeHeight: 140 },
                } as Parameters<typeof store.addNode>[0]);
              }
            } else {
              // Text file
              const content = await readFile(fp);
              const text = new TextDecoder('utf-8').decode(content);
              if (!text.trim()) continue;
              const lines = text.split('\n').length;
              const h = Math.max(120, Math.min(600, 40 + lines * 20));
              store.addNode({
                id: `node-${generateId()}`,
                type: 'ai-text',
                position: { x: flowPos.x + offX, y: flowPos.y + offY },
                data: { label: fileName, type: 'ai-text', role: 'source', output: text, status: 'success', fileName, nodeWidth: 280, nodeHeight: h },
              } as Parameters<typeof store.addNode>[0]);
            }
            count++;
          } catch (err) {
            console.error('Tauri drag-drop: failed to read', fp, err);
          }
        }

        if (count > 0) store.showToast(`已拖入 ${count} 个源节点`);
      });

      unlistenRef.current = ul;
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

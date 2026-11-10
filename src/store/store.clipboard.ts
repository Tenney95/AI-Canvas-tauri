/**
 * Clipboard slice — copy / paste nodes including external content from OS clipboard
 */
import { t } from '../i18n';

import type { Node } from '@xyflow/react';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { BaseNodeData, NodeGroup } from '../types';
import { generateId, computeImageNodeDimensions, blobToDataUrl } from './store.utils';
import { textNodeHeight } from '../utils/num';
import * as fileService from '../services/fileService';
import { copyNodeMedia, needsNodeMediaCopy, discardCopiedNodeMedia } from '../services/nodeMediaCopy';
import { registerCanvasImport, isCanvasDerivationFresh, completeCanvasDerivation } from '../services/canvasDerivationGuard';
import { AI_APP_COPY_MESSAGE, isAiAppNode } from '../services/aiApps/aiAppCreation';
import { collectCanvasDescendantIds } from '../utils/canvasHierarchy';
import { clearGroupLayoutData } from '../utils/groupCollapseLayout';

export interface ClipboardSlice {
  clipboard: {
    nodes: Node<BaseNodeData>[];
    groups: NodeGroup[];
    /** 复制时所在项目；粘贴到别的项目时需要把媒体文件复制过来 */
    projectId: string | null;
  };
  copySelectedNodes: () => boolean;
  pasteNodes: (position: { x: number; y: number }) => Promise<void>;
  pasteExternalContent: (position: { x: number; y: number }) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pasteExternalFromDataTransfer: (dt: any, position: { x: number; y: number }, maxItems?: number, actionName?: string) => Promise<void>;
}

// ---- helper: 粘贴媒体落盘 ----

/** mime 子类型 → 文件扩展名（仅列出不一致的） */
const EXT_BY_MIME_SUBTYPE: Record<string, string> = { jpeg: 'jpg', 'svg+xml': 'svg', mpeg: 'mp3' };

/** 从 dataUrl 的 mime 推断扩展名 */
function extFromDataUrl(dataUrl: string, fallback: string): string {
  const m = dataUrl.match(/^data:\w+\/([\w+.-]+)[;,]/);
  if (!m) return fallback;
  const sub = m[1].toLowerCase();
  return EXT_BY_MIME_SUBTYPE[sub] || sub;
}

/**
 * 将粘贴的 dataUrl 媒体落盘到项目数据目录（与上传走同一套保存逻辑），
 * 返回节点媒体字段。非 Tauri 环境 / 无项目 / 写盘失败时回退为内存 dataUrl。
 */
async function persistPastedMedia(
  projectId: string | null,
  dataUrl: string,
  label: string,
  fallbackExt: string,
): Promise<{ url: string; filePath?: string; fileName?: string }> {
  if (projectId) {
    try {
      const fileName = fileService.buildNodeFileName(label, extFromDataUrl(dataUrl, fallbackExt), 'paste');
      const saved = await fileService.saveDataUrlToProjectData(dataUrl, projectId, fileName);
      if (saved?.assetUrl) {
        const savedName = saved.filePath.replace(/\\/g, '/').split('/').pop() || fileName;
        return { url: saved.assetUrl, filePath: saved.filePath, fileName: savedName };
      }
    } catch { /* 落盘失败 → 回退内存态 */ }
  }
  return { url: dataUrl };
}

export const createClipboardSlice: StateCreator<AppState, [], [], ClipboardSlice> = (set, get) => ({
  clipboard: { nodes: [], groups: [], projectId: null },

  copySelectedNodes: () => {
    const { nodes, selectedNodeIds, groups } = get();
    if (selectedNodeIds.length === 0) return false;

    // Collect all node IDs to copy: selected + descendants of selected group nodes
    const idsToCopy = collectCanvasDescendantIds(nodes, selectedNodeIds);

    if (nodes.some((node) => idsToCopy.has(node.id) && isAiAppNode(node))) {
      set({ clipboard: { nodes: [], groups: [], projectId: null } });
      get().showToast(AI_APP_COPY_MESSAGE, 'error');
      return false;
    }

    // data 做浅快照：不与源节点共享同一对象，之后编辑源节点不会改到剪贴板内容
    const copiedNodes = nodes
      .filter((n) => idsToCopy.has(n.id))
      .map((n) => ({ ...n, data: { ...n.data } }));
    const copiedGroups = groups.filter((g) => idsToCopy.has(g.id)).map((g) => ({ ...g }));
    set({
      clipboard: { nodes: copiedNodes, groups: copiedGroups, projectId: get().currentProjectId },
    });
    return true;
  },

  pasteNodes: async (_position) => {
    const { clipboard } = get();
    if (clipboard.nodes.length === 0) return;
    if (clipboard.nodes.some(isAiAppNode)) {
      get().showToast(AI_APP_COPY_MESSAGE, 'error');
      return;
    }
    let copiedNodes = clipboard.nodes;
    if (copiedNodes.some((node) => needsNodeMediaCopy(node.data))) {
      const guard = registerCanvasImport(get());
      if (!guard) { get().showToast('请先创建项目再复制媒体', 'error'); return; }
      get().showToast('正在复制素材…');
      const staged: { data: BaseNodeData; source: BaseNodeData }[] = [];
      let ready = false;
      try {
        copiedNodes = [];
        for (const node of clipboard.nodes) {
          const data = needsNodeMediaCopy(node.data) ? await copyNodeMedia(node.data, guard.projectId) : node.data;
          if (data !== node.data) staged.push({ data, source: node.data });
          if (!isCanvasDerivationFresh(guard, get())) { get().showToast('画布已变化，请重新粘贴'); return; }
          copiedNodes.push({ ...node, data });
        }
        ready = true;
      } catch {
        if (get().currentProjectId === guard.projectId) get().showToast('素材复制失败，请重新粘贴', 'error');
        return;
      } finally {
        completeCanvasDerivation(guard);
        if (!ready) for (const item of staged) await discardCopiedNodeMedia(item.data, item.source);
      }
    }
    get().commitToHistory();

    const offset = { x: 30, y: 30 };
    const idMap = new Map<string, string>();

    // Build IDs for ALL copied nodes first
    clipboard.nodes.forEach((node) => {
      const newId = `node-${generateId()}`;
      idMap.set(node.id, newId);
    });

    // Prepare new nodes with remapped parentId and group ID
    const newNodes: Node<BaseNodeData>[] = copiedNodes.map((node, idx) => {
      const newId = idMap.get(node.id)!;
      const newNode: Node<BaseNodeData> = {
        ...node,
        id: newId,
        data: clearGroupLayoutData(node.data),
        position: { x: node.position.x + offset.x * (idx + 1), y: node.position.y + offset.y * (idx + 1) },
        selected: false,
      };
      // Remap parentId
      if (newNode.parentId && idMap.has(newNode.parentId)) {
        newNode.parentId = idMap.get(newNode.parentId);
      } else if (newNode.parentId && clipboard.projectId !== get().currentProjectId) {
        newNode.parentId = undefined;
        newNode.extent = undefined;
      }
      // Remap data.groupId for group nodes
      if (newNode.data?.groupId && idMap.has(newNode.data.groupId as string)) {
        newNode.data = { ...newNode.data, groupId: idMap.get(newNode.data.groupId as string) };
      }
      return newNode;
    });

    // Create new group entries with remapped nodeIds
    const newGroups: NodeGroup[] = clipboard.groups.map((g) => ({
      ...g,
      id: idMap.get(g.id) || g.id,
      nodeIds: g.nodeIds.map((nid) => idMap.get(nid) || nid),
      createdAt: Date.now(),
    }));
    const usedNames = new Set(get().groups.map((group) => group.name));
    for (const group of newGroups) {
      const baseName = group.name;
      let suffix = 2;
      while (usedNames.has(group.name)) group.name = `${baseName} ${suffix++}`;
      usedNames.add(group.name);
      const groupNode = newNodes.find((node) => node.id === group.id);
      if (groupNode) groupNode.data = { ...groupNode.data, label: group.name };
    }

    // Add new groups to store
    set((s) => ({
      groups: [...s.groups, ...newGroups],
    }));

    // Add nodes: group nodes first, children after (xyflow requirement)
    const groupNodes = newNodes.filter((n) => n.type === 'group');
    const childNodes = newNodes.filter((n) => n.type !== 'group');
    get().addNodesTransient([...groupNodes, ...childNodes]);

    // Re-create incoming edges for pasted nodes. Internal sources are remapped to
    // their pasted copies, while external sources keep pointing to the new nodes.
    const { edges } = get();
    const newEdges = edges
      .filter((edge) => idMap.has(edge.target))
      .map((edge) => ({
        ...edge,
        id: `edge-${generateId()}`,
        source: idMap.get(edge.source) ?? edge.source,
        target: idMap.get(edge.target)!,
      }));
    if (newEdges.length > 0) {
      set((state) => ({ edges: [...state.edges, ...newEdges] }));
    }

    get().commitToHistory();
    get().showToast(t('已粘贴 {count} 个节点', { count: clipboard.nodes.length }));

  },

  pasteExternalContent: async (position) => {
    const state = get();
    if (typeof navigator === 'undefined' || !navigator.clipboard?.read) {
      state.showToast('当前环境不支持读取剪贴板', 'error');
      return;
    }
    const currentProjectId = state.currentProjectId;
    const projectId = currentProjectId && currentProjectId !== 'default' ? currentProjectId : null;

    const offsets = [
      { x: 0, y: 0 },
      { x: 40, y: 40 },
      { x: 80, y: 80 },
      { x: -40, y: 40 },
      { x: -80, y: 80 },
    ];

    let pastedCount = 0;
    let historyCommitted = false;
    const addPastedNode = (node: Node<BaseNodeData>) => {
      if (!historyCommitted) {
        get().commitToHistory();
        historyCommitted = true;
      }
      get().addNodeTransient(node);
    };

    try {
      const items = await navigator.clipboard.read();
      if (!items || items.length === 0) {
        state.showToast('剪贴板为空', 'error');
        return;
      }

      for (let i = 0; i < items.length && i < offsets.length; i++) {
        const item = items[i];
        const offset = offsets[i];
        const nodePos = { x: position.x + offset.x, y: position.y + offset.y };

        if (item.types.some((t) => t.startsWith('image/'))) {
          const imageType = item.types.find((t) => t.startsWith('image/'))!;
          const blob = await item.getType(imageType);
          const dataUrl = await blobToDataUrl(blob);
          const media = await persistPastedMedia(projectId, dataUrl, '粘贴图像', 'png');
          const dims = await computeImageNodeDimensions(media.url);

          const newNode: Node<BaseNodeData> = {
            id: `node-${generateId()}`,
            type: 'ai-image',
            position: nodePos,
            data: {
              label: '粘贴图像', type: 'ai-image', role: 'source', imageUrl: media.url,
              filePath: media.filePath, fileName: media.fileName, status: 'success', ...dims,
            },
          };
          addPastedNode(newNode);
          pastedCount++;
        } else if (item.types.some((t) => t.startsWith('video/'))) {
          const videoType = item.types.find((t) => t.startsWith('video/'))!;
          const blob = await item.getType(videoType);
          const dataUrl = await blobToDataUrl(blob);
          const media = await persistPastedMedia(projectId, dataUrl, '粘贴视频', 'mp4');

          const newNode: Node<BaseNodeData> = {
            id: `node-${generateId()}`,
            type: 'ai-video',
            position: nodePos,
            data: {
              label: '粘贴视频', type: 'ai-video', role: 'source', videoUrl: media.url,
              filePath: media.filePath, fileName: media.fileName, status: 'success',
            },
          };
          addPastedNode(newNode);
          pastedCount++;
        } else if (item.types.some((t) => t.startsWith('audio/'))) {
          const audioType = item.types.find((t) => t.startsWith('audio/'))!;
          const blob = await item.getType(audioType);
          const dataUrl = await blobToDataUrl(blob);
          const media = await persistPastedMedia(projectId, dataUrl, '粘贴音频', 'mp3');

          const newNode: Node<BaseNodeData> = {
            id: `node-${generateId()}`,
            type: 'ai-audio',
            position: nodePos,
            data: {
              label: '粘贴音频', type: 'ai-audio', role: 'source', audioUrl: media.url,
              filePath: media.filePath, fileName: media.fileName, status: 'success', nodeWidth: 260, nodeHeight: 140,
            },
          };
          addPastedNode(newNode);
          pastedCount++;
        } else if (item.types.includes('text/html')) {
          const htmlBlob = await item.getType('text/html');
          const html = await htmlBlob.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const img = doc.querySelector('img');
          if (img?.src) {
            let dataUrl: string | null = null;
            if (img.src.startsWith('data:')) {
              dataUrl = img.src;
            } else if (img.src.startsWith('file://')) {
              const filePath = fileService.fileUriToPath(img.src);
              dataUrl = await fileService.readFileToDataUrl(filePath);
            } else if (img.src.startsWith('http://') || img.src.startsWith('https://')) {
              try {
                const resp = await fetch(img.src);
                const fetchedBlob = await resp.blob();
                dataUrl = await blobToDataUrl(fetchedBlob);
              } catch { /* skip */ }
            }

            if (dataUrl) {
              const media = await persistPastedMedia(projectId, dataUrl, '粘贴图像', 'png');
              const dims = await computeImageNodeDimensions(media.url);
              const newNode: Node<BaseNodeData> = {
                id: `node-${generateId()}`,
                type: 'ai-image',
                position: nodePos,
                data: {
                  label: '粘贴图像', type: 'ai-image', role: 'source', imageUrl: media.url,
                  filePath: media.filePath, fileName: media.fileName, status: 'success', ...dims,
                },
              };
              addPastedNode(newNode);
              pastedCount++;
            }
          }
        } else if (item.types.includes('text/uri-list')) {
          const uriBlob = await item.getType('text/uri-list');
          const uriText = await uriBlob.text();
          const uris = uriText.split('\n').filter((u) => u.trim().startsWith('file://'));

          for (let j = 0; j < uris.length && pastedCount < offsets.length; j++) {
            const uri = uris[j].trim();
            const filePath = fileService.fileUriToPath(uri);
            const ext = filePath.split('.').pop()?.toLowerCase() || '';

            const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
            const videoExts = ['mp4', 'webm', 'avi', 'mov', 'mkv'];
            const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac'];

            let mediaType: 'image' | 'video' | 'audio' | null = null;
            if (imageExts.includes(ext)) mediaType = 'image';
            else if (videoExts.includes(ext)) mediaType = 'video';
            else if (audioExts.includes(ext)) mediaType = 'audio';

            if (mediaType) {
              const dataUrl = await fileService.readFileToDataUrl(filePath);
              if (dataUrl) {
                const uriOffset = offsets[pastedCount] || { x: pastedCount * 40, y: pastedCount * 40 };
                const uriNodePos = { x: position.x + uriOffset.x, y: position.y + uriOffset.y };

                const srcName = filePath.split(/[\\/]/).pop() || '粘贴文件';
                const baseLabel = srcName.replace(/\.[^.]+$/, '');
                if (mediaType === 'image') {
                  const media = await persistPastedMedia(projectId, dataUrl, baseLabel, ext);
                  const dims = await computeImageNodeDimensions(media.url);
                  const newNode: Node<BaseNodeData> = {
                    id: `node-${generateId()}`,
                    type: 'ai-image',
                    position: uriNodePos,
                    data: {
                      label: srcName, type: 'ai-image', role: 'source', imageUrl: media.url,
                      filePath: media.filePath, fileName: media.fileName, status: 'success', ...dims,
                    },
                  };
                  addPastedNode(newNode);
                } else if (mediaType === 'video') {
                  const media = await persistPastedMedia(projectId, dataUrl, baseLabel, ext);
                  const newNode: Node<BaseNodeData> = {
                    id: `node-${generateId()}`,
                    type: 'ai-video',
                    position: uriNodePos,
                    data: {
                      label: srcName, type: 'ai-video', role: 'source', videoUrl: media.url,
                      filePath: media.filePath, fileName: media.fileName, status: 'success',
                    },
                  };
                  addPastedNode(newNode);
                } else if (mediaType === 'audio') {
                  const media = await persistPastedMedia(projectId, dataUrl, baseLabel, ext);
                  const newNode: Node<BaseNodeData> = {
                    id: `node-${generateId()}`,
                    type: 'ai-audio',
                    position: uriNodePos,
                    data: {
                      label: srcName, type: 'ai-audio', role: 'source', audioUrl: media.url,
                      filePath: media.filePath, fileName: media.fileName, status: 'success', nodeWidth: 260, nodeHeight: 140,
                    },
                  };
                  addPastedNode(newNode);
                }
                pastedCount++;
              }
            }
          }
        } else if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          const text = await blob.text();

          if (!text.trim()) continue;

          const lineCount = text.split('\n').length;
          const estimatedHeight = textNodeHeight(lineCount);

          const newNode: Node<BaseNodeData> = {
            id: `node-${generateId()}`,
            type: 'ai-text',
            position: nodePos,
            data: { label: '粘贴文本', type: 'ai-text', role: 'source', output: text, status: 'success', nodeWidth: 280, nodeHeight: estimatedHeight },
          };
          addPastedNode(newNode);
          pastedCount++;
        }
      }

      if (historyCommitted) get().commitToHistory();
      if (pastedCount > 0) {
        get().showToast(t('已粘贴 {count} 个源节点', { count: pastedCount }));
      } else {
        get().showToast('剪贴板无可识别内容', 'error');
      }
    } catch (err: unknown) {
      const e = err as { name?: string };
      if (e?.name === 'NotAllowedError') {
        get().showToast('无剪贴板读取权限', 'error');
      } else {
        console.error('External clipboard paste failed:', err);
        get().showToast('无法读取剪贴板', 'error');
      }
    }
  },

  pasteExternalFromDataTransfer: async (dt, position, maxItems = 10, actionName = '粘贴') => {
    if (!dt) return;
    const currentProjectId = get().currentProjectId;
    const projectId = currentProjectId && currentProjectId !== 'default' ? currentProjectId : null;

    const offsets = Array.from({ length: maxItems }, (_, i) => ({
      x: (i % 5) * 40, y: Math.floor(i / 5) * 40,
    }));

    let pastedCount = 0;
    let historyCommitted = false;
    const addPastedNode = (node: Node<BaseNodeData>) => {
      if (!historyCommitted) {
        get().commitToHistory();
        historyCommitted = true;
      }
      get().addNodeTransient(node);
    };
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
    const videoExts = ['mp4', 'webm', 'avi', 'mov', 'mkv'];
    const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac'];

    // 粘贴媒体统一先落盘到项目目录（与上传一致），失败/浏览器环境回退 dataUrl
    const addImageNode = async (dataUrl: string, idx: number) => {
      const media = await persistPastedMedia(projectId, dataUrl, '粘贴图像', 'png');
      const dims = await computeImageNodeDimensions(media.url);
      const newNode: Node<BaseNodeData> = {
        id: `node-${generateId()}`,
        type: 'ai-image',
        position: { x: position.x + offsets[idx].x, y: position.y + offsets[idx].y },
        data: {
          label: '粘贴图像', type: 'ai-image', role: 'source', imageUrl: media.url,
          filePath: media.filePath, fileName: media.fileName, status: 'success', ...dims,
        },
      };
      addPastedNode(newNode);
    };

    const addVideoNode = async (dataUrl: string, idx: number) => {
      const media = await persistPastedMedia(projectId, dataUrl, '粘贴视频', 'mp4');
      const newNode: Node<BaseNodeData> = {
        id: `node-${generateId()}`,
        type: 'ai-video',
        position: { x: position.x + offsets[idx].x, y: position.y + offsets[idx].y },
        data: {
          label: '粘贴视频', type: 'ai-video', role: 'source', videoUrl: media.url,
          filePath: media.filePath, fileName: media.fileName, status: 'success',
        },
      };
      addPastedNode(newNode);
    };

    const addAudioNode = async (dataUrl: string, idx: number) => {
      const media = await persistPastedMedia(projectId, dataUrl, '粘贴音频', 'mp3');
      const newNode: Node<BaseNodeData> = {
        id: `node-${generateId()}`,
        type: 'ai-audio',
        position: { x: position.x + offsets[idx].x, y: position.y + offsets[idx].y },
        data: {
          label: '粘贴音频', type: 'ai-audio', role: 'source', audioUrl: media.url,
          filePath: media.filePath, fileName: media.fileName, status: 'success', nodeWidth: 260, nodeHeight: 140,
        },
      };
      addPastedNode(newNode);
    };

    const addTextNode = (text: string, idx: number, fileName?: string) => {
      const lineCount = text.split('\n').length;
      const estimatedHeight = fileName ? textNodeHeight(lineCount, 160) : textNodeHeight(lineCount);
      const nodeType = fileName ? 'ai-markdown' : 'ai-text';
      const newNode: Node<BaseNodeData> = {
        id: `node-${generateId()}`,
        type: nodeType,
        position: { x: position.x + offsets[idx].x, y: position.y + offsets[idx].y },
        data: { label: fileName || '粘贴文本', type: nodeType, role: 'source', output: text, status: 'success',
          ...(fileName ? { fileName } : {}), nodeWidth: 280, nodeHeight: estimatedHeight },
      };
      addPastedNode(newNode);
    };

    const hasMarkdownFile = Array.from(dt.files || []).some((file) => (file as File).name.toLowerCase().endsWith('.md'));
    const parseGuard = hasMarkdownFile ? registerCanvasImport(get()) : null;
    if (hasMarkdownFile && !parseGuard) return;
    let parsedItems: ParsedDTItem[];
    try {
      parsedItems = await parseDataTransferItems(dt);
      if (parseGuard && !isCanvasDerivationFresh(parseGuard, get())) return;
    } finally {
      if (parseGuard) completeCanvasDerivation(parseGuard);
    }
    if (parsedItems.length === 0) return;

    for (const p of parsedItems) {
      if (pastedCount >= maxItems) break;
      const off = offsets[pastedCount] || { x: pastedCount * 40, y: pastedCount * 40 };

      if (p.kind === 'file' && p.filePath && projectId) {
        // Try to copy file to project data dir via file path
        const filePath = p.filePath;
        const fileName = filePath.split(/[\\/]/).pop() || 'file';
        const extLower = fileName.split('.').pop()?.toLowerCase() || '';

        if (imageExts.includes(extLower)) {
          const nodeId = `node-${generateId()}`;
          const newNode: Node<BaseNodeData> = {
            id: nodeId,
            type: 'ai-image',
            position: { x: position.x + off.x, y: position.y + off.y },
            data: { label: fileName, type: 'ai-image', role: 'source', status: 'loading', nodeWidth: 280, nodeHeight: 160 },
          };
          addPastedNode(newNode);
          pastedCount++;

          // Copy file to project data dir asynchronously
          fileService.copyFileToProjectData(filePath, projectId).then(async (result) => {
            if (result?.assetUrl) {
              const dims = await computeImageNodeDimensions(result.assetUrl);
              get().updateNodeDataTransient(nodeId, {
                label: result.fileName, imageUrl: result.assetUrl, filePath: result.filePath,
                fileName: result.fileName, status: 'success', ...dims,
              });
            } else {
              // Fallback to in-memory data URL if copy fails
              const dataUrl = await fileService.readFileToDataUrl(filePath);
              if (dataUrl) {
                const dims = await computeImageNodeDimensions(dataUrl);
                const fileName = filePath.split(/[\\/]/).pop() || 'file';
                get().updateNodeDataTransient(nodeId, {
                  imageUrl: dataUrl, fileName, label: fileName, status: 'success', ...dims,
                });
              } else {
                get().updateNodeDataTransient(nodeId, { status: 'error', error: '无法读取文件' });
              }
            }
          }).catch((err) => {
            get().updateNodeDataTransient(nodeId, { status: 'error', error: err instanceof Error ? err.message : '复制失败' });
          });
        } else if (videoExts.includes(extLower)) {
          const nodeId = `node-${generateId()}`;
          const newNode: Node<BaseNodeData> = {
            id: nodeId, type: 'ai-video',
            position: { x: position.x + off.x, y: position.y + off.y },
            data: { label: fileName, type: 'ai-video', role: 'source', status: 'loading', nodeWidth: 280, nodeHeight: 160 },
          };
          addPastedNode(newNode);
          pastedCount++;

          fileService.copyFileToProjectData(filePath, projectId).then((result) => {
            if (result?.assetUrl) {
              get().updateNodeDataTransient(nodeId, {
                label: result.fileName, videoUrl: result.assetUrl, filePath: result.filePath,
                fileName: result.fileName, status: 'success',
              });
            }
          }).catch((err) => {
            get().updateNodeDataTransient(nodeId, { status: 'error', error: err instanceof Error ? err.message : '复制失败' });
          });
        } else if (audioExts.includes(extLower)) {
          const nodeId = `node-${generateId()}`;
          const newNode: Node<BaseNodeData> = {
            id: nodeId, type: 'ai-audio',
            position: { x: position.x + off.x, y: position.y + off.y },
            data: { label: fileName, type: 'ai-audio', role: 'source', status: 'loading', nodeWidth: 260, nodeHeight: 140 },
          };
          addPastedNode(newNode);
          pastedCount++;

          fileService.copyFileToProjectData(filePath, projectId).then((result) => {
            if (result?.assetUrl) {
              get().updateNodeDataTransient(nodeId, {
                label: result.fileName, audioUrl: result.assetUrl, filePath: result.filePath,
                fileName: result.fileName, status: 'success',
              });
            }
          }).catch((err) => {
            get().updateNodeDataTransient(nodeId, { status: 'error', error: err instanceof Error ? err.message : '复制失败' });
          });
        }
      } else if (p.kind === 'file' && p.filePath) {
        // No projectId available — read into memory
        const dataUrl = await fileService.readFileToDataUrl(p.filePath);
        if (dataUrl) {
          const ext = (p.filePath || '').split('.').pop()?.toLowerCase() || '';
          if (imageExts.includes(ext)) {
            await addImageNode(dataUrl, pastedCount);
            pastedCount++;
          } else if (videoExts.includes(ext)) {
            await addVideoNode(dataUrl, pastedCount);
            pastedCount++;
          } else if (audioExts.includes(ext)) {
            await addAudioNode(dataUrl, pastedCount);
            pastedCount++;
          }
        }
      } else if (p.kind === 'markdown' && p.file) {
        if (get().currentProjectId !== currentProjectId) break;
        const guard = registerCanvasImport(get());
        if (!guard) continue;
        let content: string;
        try {
          content = await p.file.text();
          if (!isCanvasDerivationFresh(guard, get())) continue;
        } catch {
          // 文件读取失败时不创建空节点。
          continue;
        } finally {
          completeCanvasDerivation(guard);
        }
        addTextNode(content, pastedCount, p.file.name);
        pastedCount++;
      } else if (p.kind === 'image') {
        // 浏览器复制的图像走此分支：先落盘再建节点，避免 base64 常驻节点数据
        await addImageNode(p.dataUrl!, pastedCount);
        pastedCount++;
      } else if (p.kind === 'text') {
        addTextNode(p.text!, pastedCount);
        pastedCount++;
      }
    }

    if (historyCommitted) get().commitToHistory();
    if (pastedCount > 0) {
      get().showToast(t('{action} {count} 个源节点', { action: t(actionName), count: pastedCount }));
    } else {
      get().showToast('无可识别内容', 'error');
    }
  },
});

// ---- helper: parse dataTransfer into structured items ----

interface ParsedDTItem {
  kind: 'text' | 'image' | 'file' | 'markdown';
  text?: string;
  dataUrl?: string;
  filePath?: string;
  file?: File;
}

async function parseDataTransferItems(dt: DataTransfer): Promise<ParsedDTItem[]> {
  const items: ParsedDTItem[] = [];
  const files = Array.from(dt.files || []);
  const rawItems = Array.from(dt.items || []);

  // Process files first
  for (const file of files) {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (ext === 'md') {
      items.push({ kind: 'markdown', file });
      continue;
    }
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
    if (imageExts.includes(ext)) {
      try {
        const dataUrl = await blobToDataUrl(file);
        items.push({ kind: 'image', dataUrl });
        continue;
      } catch {
        // 读取失败时继续走下面的路径探测与兜底
      }
    }
    // Try to detect file path for Tauri drag-drop
    try {
      const dtItem = rawItems.find((ri) => ri.kind === 'file');
      if (dtItem) {
        const fileEntry = await getAsFileSystemHandle(dt);
        if (fileEntry) {
          items.push({ kind: 'file', filePath: fileEntry });
          continue;
        }
      }
    } catch {
      // 非 Tauri 环境或无路径权限时忽略，改用 dataUrl 兜底
    }
    // Fallback: try reading as dataUrl
    try {
      const dataUrl = await blobToDataUrl(file);
      if (imageExts.includes(ext)) {
        items.push({ kind: 'image', dataUrl });
      }
    } catch {
      // 兜底也失败则跳过该文件
    }
  }

  // Process text/uri-list/html data
  if (dt.types.includes('text/uri-list')) {
    const uriText = dt.getData('text/uri-list');
    const uris = uriText.split('\n').filter((u) => u.trim().startsWith('file://'));
    for (const uri of uris) {
      const filePath = fileService.fileUriToPath(uri.trim());
      items.push({ kind: 'file', filePath });
    }
  }

  if (dt.types.includes('text/html')) {
    const html = dt.getData('text/html');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const img = doc.querySelector('img');
    if (img?.src) {
      if (img.src.startsWith('data:')) {
        items.push({ kind: 'image', dataUrl: img.src });
      }
    }
  }

  if (dt.types.includes('text/plain')) {
    const text = dt.getData('text/plain');
    if (text.trim()) {
      items.push({ kind: 'text', text });
    }
  }

  return items;
}

/** Tauri / 宿主环境扩展出来的字段，标准 DOM 类型里没有声明 */
type FileSystemHandleCapableTransfer = DataTransfer & {
  getAsFileSystemHandle?: () => Promise<unknown>;
};
type PathBearingFile = File & { path?: string };

async function getAsFileSystemHandle(dt: DataTransfer): Promise<string | null> {
  try {
    const entries = await (dt as FileSystemHandleCapableTransfer).getAsFileSystemHandle?.();
    if (!entries) return null;
    // For multiple items, just return the first path
    const files = dt.files;
    if (files.length > 0) {
      // On Tauri/Windows, files may have a path property
      const file = files[0] as PathBearingFile;
      if (file.path) return file.path;
    }
    return null;
  } catch {
    return null;
  }
}

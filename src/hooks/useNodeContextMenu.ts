/**
 * useNodeContextMenu 节点右键菜单 Hook — 管理节点上右键弹出操作菜单的显示/隐藏，处理复制、剪切、创建副本、删除
 */
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { getActiveTextSelection, type ActiveTextSelection } from '../utils/textSelection';
import {
  ensureGroupFolder,
  openDirectoryInFileManager,
  revealFileInFolder,
  openInJianying,
  openInPhotoshop,
  openInPremiere,
  saveNodeOutputToFile,
} from '../services/fileService';
import { copyImage as copyImageToClipboard, copyFile as copyFileToClipboard } from '../services/clipboardService';
import { hasVideoSource, isEditableMediaNode, openVideoEditorForNodes } from '../services/videoEditorService';
import type { BaseNodeData, NodeType } from '../types';
import type { Node as RFNode } from '@xyflow/react';
import { isEligibleCharacterReferenceNode } from '../store/store.dramaAssets';
import { useT } from '../i18n';

export interface NodeContextMenuState {
  visible: boolean;
  position: { x: number; y: number };
  nodeId: string | null;
  textSelection: ActiveTextSelection | null;
}

export function useNodeContextMenu() {
  const t = useT();
  const nodes = useAppStore((s) => s.nodes);
  const selectedNodeIds = useAppStore((s) => s.selectedNodeIds);
  const copySelectedNodes = useAppStore((s) => s.copySelectedNodes);
  const pasteNodes = useAppStore((s) => s.pasteNodes);
  const deleteNode = useAppStore((s) => s.deleteNode);
  const ungroupSelectedNodes = useAppStore((s) => s.ungroupSelectedNodes);
  const setSelectedNodeIds = useAppStore((s) => s.setSelectedNodeIds);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const convertImageNodeKind = useAppStore((s) => s.convertImageNodeKind);

  const [menu, setMenu] = useState<NodeContextMenuState>({
    visible: false,
    position: { x: 0, y: 0 },
    nodeId: null,
    textSelection: null,
  });
  const [characterCaptureNodeId, setCharacterCaptureNodeId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => {
    setMenu({ visible: false, position: { x: 0, y: 0 }, nodeId: null, textSelection: null });
  }, []);

  // Close on click outside or Escape
  useEffect(() => {
    if (!menu.visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element;
      if (menuRef.current?.contains(target)) return;
      if (target.closest('.canvas-ctx-menu') || target.closest('.node-ctx-menu')) return;
      closeMenu();
    };
    document.addEventListener('keydown', onKey);
    // 捕获阶段监听：传统交互模式下左键平移会被 React Flow(d3-zoom)在 pane 上 stopPropagation，
    // 冒泡阶段的 document 监听收不到事件，必须在捕获阶段先于其触发才能关闭菜单。
    document.addEventListener('mousedown', onClick, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick, true);
    };
  }, [menu.visible, closeMenu]);

  const openMenu = useCallback(
    (e: React.MouseEvent, node: RFNode<BaseNodeData>) => {
      e.preventDefault();
      e.stopPropagation();
      const textSelection = getActiveTextSelection();
      // 右键落在已有多选内时保留整个选择（同主流应用），
      // 否则收敛到该节点，让复制/剪切仍作用在它身上
      const currentSelection = useAppStore.getState().selectedNodeIds;
      const keepSelection = currentSelection.length > 1 && currentSelection.includes(node.id);
      if (!keepSelection) setSelectedNodeIds([node.id]);
      setMenu({
        visible: true,
        position: { x: e.clientX, y: e.clientY },
        nodeId: node.id,
        textSelection,
      });
    },
    [setSelectedNodeIds],
  );

  // ── Copy ──
  const handleCopy = useCallback(() => {
    copySelectedNodes();
    closeMenu();
    useAppStore.getState().showToast(t('节点已复制'));
  }, [copySelectedNodes, closeMenu, t]);

  // ── Cut: copy + delete ──
  const handleCut = useCallback(() => {
    if (!menu.nodeId) return;
    copySelectedNodes();
    deleteNode(menu.nodeId);
    closeMenu();
    useAppStore.getState().showToast(t('节点已剪切'));
  }, [menu.nodeId, copySelectedNodes, deleteNode, closeMenu, t]);

  // ── Text selection copy/cut ──
  const handleCopyText = useCallback(async () => {
    if (!menu.textSelection) return;
    await navigator.clipboard?.writeText(menu.textSelection.text).catch(() => {});
    useAppStore.setState({ clipboard: { nodes: [], groups: [], projectId: null } });
    window.getSelection()?.removeAllRanges();
    closeMenu();
    useAppStore.getState().showToast(t('已复制选中文字'));
  }, [menu.textSelection, closeMenu, t]);

  const handleCutText = useCallback(async () => {
    if (!menu.nodeId || !menu.textSelection) return;
    const node = nodes.find((n) => n.id === menu.nodeId);
    const output = (node?.data as BaseNodeData | undefined)?.output ?? '';
    const { start, end, text } = menu.textSelection;

    await navigator.clipboard?.writeText(text).catch(() => {});
    updateNodeData(menu.nodeId, { output: output.slice(0, start) + output.slice(end) });
    useAppStore.setState({ clipboard: { nodes: [], groups: [], projectId: null } });
    window.getSelection()?.removeAllRanges();
    closeMenu();
    useAppStore.getState().showToast(t('已剪切选中文字'));
  }, [menu.nodeId, menu.textSelection, nodes, updateNodeData, closeMenu, t]);

  // ── Duplicate: copy + paste at offset (group-aware) ──
  const handleDuplicate = useCallback(() => {
    if (!menu.nodeId) return;
    const source = nodes.find((n) => n.id === menu.nodeId);
    if (!source) return;
    copySelectedNodes();
    pasteNodes({ x: source.position.x + 30, y: source.position.y + 30 });
    closeMenu();
    useAppStore.getState().showToast(t('节点已创建副本'));
  }, [menu.nodeId, nodes, copySelectedNodes, pasteNodes, closeMenu, t]);

  // ── Ungroup ──
  const handleUngroup = useCallback(() => {
    if (!menu.nodeId) return;
    ungroupSelectedNodes();
    closeMenu();
    useAppStore.getState().showToast(t('已解除分组'));
  }, [menu.nodeId, ungroupSelectedNodes, closeMenu, t]);

  // ── Delete ──
  const handleDelete = useCallback(() => {
    if (!menu.nodeId) return;
    deleteNode(menu.nodeId);
    closeMenu();
    useAppStore.getState().showToast(t('节点已删除'));
  }, [menu.nodeId, deleteNode, closeMenu, t]);

  // ── 打开文件所在位置 ──
  const mediaTypes: NodeType[] = [
    'ai-image', 'ai-video', 'ai-audio', 'ai-panorama',
    'source-image', 'source-video', 'source-audio',
    'ai-markdown', 'ai-storyboard', 'ai-animation',
  ];
  const currentNode = nodes.find((n) => n.id === menu.nodeId);
  const nodeType = (currentNode?.type) as NodeType | undefined;
  const nodeData = currentNode?.data as BaseNodeData | undefined;
  const isNodeLocked = currentNode?.draggable === false;
  const actionMediaIdentity = [nodeData?.fileName, nodeData?.filePath, nodeData?.imageUrl]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  const hasCharacterActionMedia = Boolean(nodeData?.videoUrl)
    || /(?:^|[./\\])[^?#]*\.gif(?:[?#]|$)/i.test(actionMediaIdentity)
    || nodeData?.imageUrl?.startsWith('data:image/gif') === true;
  const showAddToCharacter = isEligibleCharacterReferenceNode(currentNode)
    || hasCharacterActionMedia;
  const isImageNote = nodeType === 'canvas-note' && nodeData?.note?.kind === 'image';
  const isImageNode = nodeType === 'ai-image' || nodeType === 'source-image';
  const showImageConversion = (isImageNote || isImageNode)
    && !!(nodeData?.imageUrl || nodeData?.thumbnailUrl);
  const imageConversionLabel = isImageNote ? t('转换为图片节点') : t('转换为图片笔记');

  const handleConvertImage = useCallback(() => {
    if (!menu.nodeId) return;
    const result = convertImageNodeKind(menu.nodeId);
    closeMenu();
    const store = useAppStore.getState();
    if (result === 'connected') {
      store.showToast(t('该图片节点存在连线，请先断开连线'), 'error');
      return;
    }
    if (result === 'to-note') store.showToast(t('已转换为图片笔记'));
    if (result === 'to-node') store.showToast(t('已转换为图片节点'));
  }, [closeMenu, convertImageNodeKind, menu.nodeId, t]);

  const handleToggleLock = useCallback(() => {
    if (!menu.nodeId) return;
    const store = useAppStore.getState();
    const node = store.nodes.find((candidate) => candidate.id === menu.nodeId);
    if (!node) return;

    // 多选时整批锁定/解锁；锁定分组同时锁定组内子节点
    const picked = store.selectedNodeIds.includes(menu.nodeId)
      ? store.selectedNodeIds
      : [menu.nodeId];
    const targets = new Set(picked);
    for (const candidate of store.nodes) {
      if (candidate.parentId && targets.has(candidate.parentId)) targets.add(candidate.id);
    }

    const nextLocked = node.draggable !== false;
    store.commitToHistory();
    store.setNodes(store.nodes.map((candidate) => targets.has(candidate.id)
      ? { ...candidate, draggable: nextLocked ? false : undefined }
      : candidate));
    closeMenu();
    store.showToast(nextLocked ? t('节点已锁定') : t('节点已解锁'));
  }, [closeMenu, menu.nodeId, t]);

  // ── 分组：在系统文件管理器中打开分组文件夹 ──
  const handleOpenGroupFolder = useCallback(async () => {
    const store = useAppStore.getState();
    const node = store.nodes.find((n) => n.id === menu.nodeId);
    const gid = (node?.data as BaseNodeData | undefined)?.groupId as string | undefined;
    const group = store.groups.find((g) => g.id === (gid ?? menu.nodeId));
    closeMenu();
    if (!group) return;
    const dir = await ensureGroupFolder(store.currentProjectId, group.name);
    if (!dir) {
      store.showToast(t('无法打开文件位置'));
      return;
    }
    try {
      await openDirectoryInFileManager(dir);
    } catch {
      store.showToast(t('无法打开文件位置'));
    }
  }, [closeMenu, menu.nodeId, t]);

  const handleAddToCharacter = useCallback(() => {
    if (!menu.nodeId) return;
    setCharacterCaptureNodeId(menu.nodeId);
    closeMenu();
  }, [closeMenu, menu.nodeId]);

  const closeCharacterCapture = useCallback(() => {
    setCharacterCaptureNodeId(null);
  }, []);
  const showInFolder = menu.nodeId != null
    && nodeType != null
    && mediaTypes.includes(nodeType)
    && !!nodeData?.filePath;

  const handleShowInFolder = useCallback(async () => {
    if (!menu.nodeId) return;
    const node = nodes.find((n) => n.id === menu.nodeId);
    const fp = (node?.data as BaseNodeData | undefined)?.filePath;
    if (!fp) {
      useAppStore.getState().showToast(t('无法找到文件路径'));
      closeMenu();
      return;
    }
    try {
      await revealFileInFolder(fp);
      closeMenu();
      useAppStore.getState().showToast(t('已打开文件位置'));
    } catch {
      useAppStore.getState().showToast(t('无法打开文件位置'));
      closeMenu();
    }
  }, [menu.nodeId, nodes, closeMenu, t]);

  // ── 在 Photoshop 中打开 ──
  const openInPSTypes: NodeType[] = [
    'ai-image', 'source-image', 'ai-storyboard', 'ai-animation',
  ];
  const showOpenInPS = menu.nodeId != null
    && nodeType != null
    && openInPSTypes.includes(nodeType)
    && !!nodeData?.filePath;

  const handleOpenInPS = useCallback(async () => {
    if (!menu.nodeId) return;
    const node = nodes.find((n) => n.id === menu.nodeId);
    const fp = (node?.data as BaseNodeData | undefined)?.filePath;
    if (!fp) {
      useAppStore.getState().showToast(t('无法找到文件路径'));
      closeMenu();
      return;
    }
    try {
      const photoshopPath = useAppStore.getState().config.photoshopPath;
      await openInPhotoshop(fp, photoshopPath);
      closeMenu();
      useAppStore.getState().showToast(t('已在 Photoshop 中打开'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('打开失败');
      useAppStore.getState().showToast(message, 'error');
      closeMenu();
    }
  }, [menu.nodeId, nodes, closeMenu, t]);

  // ── 在视频编辑器中打开 ──
  const openInVideoEditorTypes: NodeType[] = ['ai-video', 'source-video'];
  const showOpenInVideoEditor = menu.nodeId != null
    && nodeType != null
    && openInVideoEditorTypes.includes(nodeType)
    && !!nodeData?.filePath;

  const handleOpenInVideoEditor = useCallback(async (editor: 'jianying' | 'premiere') => {
    if (!menu.nodeId) return;
    const node = nodes.find((candidate) => candidate.id === menu.nodeId);
    const filePath = (node?.data as BaseNodeData | undefined)?.filePath;
    if (!filePath) {
      useAppStore.getState().showToast(t('无法找到文件路径'));
      closeMenu();
      return;
    }

    const state = useAppStore.getState();
    try {
      if (editor === 'jianying') {
        await openInJianying(filePath, state.config.jianyingPath);
        state.showToast(t('已在剪映中打开'));
      } else {
        await openInPremiere(filePath, state.config.premierePath);
        state.showToast(t('已在 Premiere Pro 中打开'));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('打开失败');
      state.showToast(message, 'error');
    } finally {
      closeMenu();
    }
  }, [menu.nodeId, nodes, closeMenu, t]);

  // ── 内置视频编辑器（独立窗口）──
  // 右键点在多选内时，把整批可用素材（视频 + 图片）一起送进时间轴
  const editVideoNodes = useMemo(() => {
    if (!menu.nodeId) return [];
    const clicked = nodes.find((candidate) => candidate.id === menu.nodeId);
    if (!clicked) return [];
    const batch = selectedNodeIds.length > 1 && selectedNodeIds.includes(menu.nodeId)
      // 按当前选择顺序取节点，保证时间轴排布与用户的选择次序一致
      ? selectedNodeIds
        .map((id) => nodes.find((candidate) => candidate.id === id))
        .filter((candidate): candidate is RFNode<BaseNodeData> => !!candidate)
      : [clicked];
    return batch
      .map((node) => ({ id: node.id, type: node.type, data: node.data }))
      .filter(isEditableMediaNode);
  }, [menu.nodeId, nodes, selectedNodeIds]);

  const showEditVideo = editVideoNodes.length > 0 && hasVideoSource(editVideoNodes);
  const editVideoLabel = editVideoNodes.length > 1
    ? t('编辑视频（{count} 个素材）', { count: editVideoNodes.length })
    : t('编辑视频');

  const handleEditVideo = useCallback(async () => {
    const store = useAppStore.getState();
    try {
      await openVideoEditorForNodes({
        projectId: store.currentProjectId ?? '',
        nodes: editVideoNodes,
        theme: store.config.theme === 'light' ? 'light' : 'dark',
      });
    } catch (err: unknown) {
      store.showToast(err instanceof Error ? err.message : t('打开视频编辑器失败'), 'error');
    } finally {
      closeMenu();
    }
  }, [closeMenu, editVideoNodes, t]);

  const handleOpenInJianying = useCallback(
    () => handleOpenInVideoEditor('jianying'),
    [handleOpenInVideoEditor],
  );
  const handleOpenInPremiere = useCallback(
    () => handleOpenInVideoEditor('premiere'),
    [handleOpenInVideoEditor],
  );

  // ── 文件另存为 ──
  const saveAsTypes: NodeType[] = [
    'ai-text', 'ai-image', 'ai-video', 'ai-audio',
    'ai-markdown', 'ai-panorama',
    'source-image', 'source-video', 'source-audio',
  ];
  const showSaveAs = menu.nodeId != null
    && nodeType != null
    && saveAsTypes.includes(nodeType)
    && (!!nodeData?.filePath || !!nodeData?.imageUrl || !!nodeData?.videoUrl || !!nodeData?.audioUrl || !!nodeData?.output);

  const handleSaveAs = useCallback(async () => {
    if (!menu.nodeId) return;
    const node = nodes.find((n) => n.id === menu.nodeId);
    const data = node?.data as BaseNodeData | undefined;
    if (!data) {
      useAppStore.getState().showToast(t('无法读取节点数据'));
      closeMenu();
      return;
    }

    const mediaUrl = data.imageUrl || data.videoUrl || data.audioUrl || undefined;
    try {
      const result = await saveNodeOutputToFile({
        filePath: data.filePath,
        mediaUrl,
        textOutput: data.output,
        nodeType: nodeType!,
        fileName: data.fileName || data.label,
      });
      closeMenu();
      if (result) {
        useAppStore.getState().showToast(t('文件已保存'));
      }
    } catch {
      useAppStore.getState().showToast(t('文件保存失败'));
      closeMenu();
    }
  }, [menu.nodeId, nodeType, nodes, closeMenu, t]);

  // ── 复制媒体（系统剪贴板）──
  // 图像节点复制位图到剪贴板；视频/音频节点复制文件到剪贴板（CF_HDROP，可在资源管理器粘贴）。
  const copyMediaTypes: NodeType[] = ['ai-image', 'ai-video', 'ai-audio'];
  const showCopyMedia = menu.nodeId != null
    && nodeType != null
    && copyMediaTypes.includes(nodeType)
    && (!!nodeData?.imageUrl || !!nodeData?.videoUrl || !!nodeData?.audioUrl);
  const copyMediaLabel = nodeType === 'ai-image'
    ? t('复制图像')
    : nodeType === 'ai-video'
      ? t('复制视频')
      : t('复制音频');

  const handleCopyMedia = useCallback(async () => {
    if (!menu.nodeId) return;
    const node = nodes.find((n) => n.id === menu.nodeId);
    const data = node?.data as BaseNodeData | undefined;
    if (!data) { closeMenu(); return; }
    const toast = useAppStore.getState().showToast.bind(useAppStore.getState());

    let ok: boolean;
    try {
      if (nodeType === 'ai-image') {
        const imageUrl = data.imageUrl || data.thumbnailUrl;
        if (!imageUrl) { toast(t('没有可用的图片'), 'error'); closeMenu(); return; }
        ok = await copyImageToClipboard(imageUrl);
      } else {
        const filePath = data.filePath;
        if (!filePath) { toast(t('该节点没有本地文件，无法复制'), 'error'); closeMenu(); return; }
        ok = await copyFileToClipboard(filePath);
      }
      toast(ok ? t('已{label}到剪贴板', { label: copyMediaLabel }) : t('复制失败'), ok ? undefined : 'error');
    } catch {
      toast(t('复制失败'), 'error');
    }
    closeMenu();
  }, [menu.nodeId, nodes, nodeType, copyMediaLabel, closeMenu, t]);

  return {
    menu,
    menuRef,
    openMenu,
    closeMenu,
    handleCopy,
    handleCut,
    handleCopyText,
    handleCutText,
    handleDuplicate,
    handleToggleLock,
    isNodeLocked,
    handleConvertImage,
    showImageConversion,
    imageConversionLabel,
    handleUngroup,
    handleOpenGroupFolder,
    handleDelete,
    handleShowInFolder,
    showInFolder,
    handleSaveAs,
    showSaveAs,
    handleOpenInPS,
    showOpenInPS,
    handleEditVideo,
    showEditVideo,
    editVideoLabel,
    handleOpenInJianying,
    handleOpenInPremiere,
    showOpenInVideoEditor,
    handleCopyMedia,
    showCopyMedia,
    copyMediaLabel,
    characterCaptureNodeId,
    handleAddToCharacter,
    closeCharacterCapture,
    showAddToCharacter,
  };
}

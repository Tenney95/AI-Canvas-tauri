/**
 * useNodeContextMenu 节点右键菜单 Hook — 管理节点上右键弹出操作菜单的显示/隐藏，处理复制、剪切、创建副本、删除
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { getActiveTextSelection, type ActiveTextSelection } from '../utils/textSelection';
import { revealFileInFolder, openInPhotoshop, saveNodeOutputToFile } from '../services/fileService';
import { copyImage as copyImageToClipboard, copyFile as copyFileToClipboard } from '../services/clipboardService';
import type { BaseNodeData, NodeType } from '../types';
import type { Node as RFNode } from '@xyflow/react';

export interface NodeContextMenuState {
  visible: boolean;
  position: { x: number; y: number };
  nodeId: string | null;
  textSelection: ActiveTextSelection | null;
}

export function useNodeContextMenu() {
  const nodes = useAppStore((s) => s.nodes);
  const copySelectedNodes = useAppStore((s) => s.copySelectedNodes);
  const pasteNodes = useAppStore((s) => s.pasteNodes);
  const deleteNode = useAppStore((s) => s.deleteNode);
  const ungroupSelectedNodes = useAppStore((s) => s.ungroupSelectedNodes);
  const setSelectedNodeIds = useAppStore((s) => s.setSelectedNodeIds);
  const updateNodeData = useAppStore((s) => s.updateNodeData);

  const [menu, setMenu] = useState<NodeContextMenuState>({
    visible: false,
    position: { x: 0, y: 0 },
    nodeId: null,
    textSelection: null,
  });
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
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menu.visible, closeMenu]);

  const openMenu = useCallback(
    (e: React.MouseEvent, node: RFNode<BaseNodeData>) => {
      e.preventDefault();
      e.stopPropagation();
      const textSelection = getActiveTextSelection();
      // Select only this node so copy/cut works on it
      setSelectedNodeIds([node.id]);
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
    useAppStore.getState().showToast('节点已复制');
  }, [copySelectedNodes, closeMenu]);

  // ── Cut: copy + delete ──
  const handleCut = useCallback(() => {
    if (!menu.nodeId) return;
    copySelectedNodes();
    deleteNode(menu.nodeId);
    closeMenu();
    useAppStore.getState().showToast('节点已剪切');
  }, [menu.nodeId, copySelectedNodes, deleteNode, closeMenu]);

  // ── Text selection copy/cut ──
  const handleCopyText = useCallback(async () => {
    if (!menu.textSelection) return;
    await navigator.clipboard?.writeText(menu.textSelection.text).catch(() => {});
    useAppStore.setState({ clipboard: { nodes: [], groups: [] } });
    window.getSelection()?.removeAllRanges();
    closeMenu();
    useAppStore.getState().showToast('已复制选中文字');
  }, [menu.textSelection, closeMenu]);

  const handleCutText = useCallback(async () => {
    if (!menu.nodeId || !menu.textSelection) return;
    const node = nodes.find((n) => n.id === menu.nodeId);
    const output = (node?.data as BaseNodeData | undefined)?.output ?? '';
    const { start, end, text } = menu.textSelection;

    await navigator.clipboard?.writeText(text).catch(() => {});
    updateNodeData(menu.nodeId, { output: output.slice(0, start) + output.slice(end) });
    useAppStore.setState({ clipboard: { nodes: [], groups: [] } });
    window.getSelection()?.removeAllRanges();
    closeMenu();
    useAppStore.getState().showToast('已剪切选中文字');
  }, [menu.nodeId, menu.textSelection, nodes, updateNodeData, closeMenu]);

  // ── Duplicate: copy + paste at offset (group-aware) ──
  const handleDuplicate = useCallback(() => {
    if (!menu.nodeId) return;
    const source = nodes.find((n) => n.id === menu.nodeId);
    if (!source) return;
    copySelectedNodes();
    pasteNodes({ x: source.position.x + 30, y: source.position.y + 30 });
    closeMenu();
    useAppStore.getState().showToast('节点已创建副本');
  }, [menu.nodeId, nodes, copySelectedNodes, pasteNodes, closeMenu]);

  // ── Ungroup ──
  const handleUngroup = useCallback(() => {
    if (!menu.nodeId) return;
    ungroupSelectedNodes();
    closeMenu();
    useAppStore.getState().showToast('已解除分组');
  }, [menu.nodeId, ungroupSelectedNodes, closeMenu]);

  // ── Delete ──
  const handleDelete = useCallback(() => {
    if (!menu.nodeId) return;
    deleteNode(menu.nodeId);
    closeMenu();
    useAppStore.getState().showToast('节点已删除');
  }, [menu.nodeId, deleteNode, closeMenu]);

  // ── 打开文件所在位置 ──
  const mediaTypes: NodeType[] = [
    'ai-image', 'ai-video', 'ai-audio', 'ai-panorama',
    'source-image', 'source-video', 'source-audio',
    'ai-markdown', 'ai-storyboard', 'ai-animation',
  ];
  const currentNode = nodes.find((n) => n.id === menu.nodeId);
  const nodeType = (currentNode?.type) as NodeType | undefined;
  const nodeData = currentNode?.data as BaseNodeData | undefined;
  const showInFolder = menu.nodeId != null
    && nodeType != null
    && mediaTypes.includes(nodeType)
    && !!nodeData?.filePath;

  const handleShowInFolder = useCallback(async () => {
    if (!menu.nodeId) return;
    const node = nodes.find((n) => n.id === menu.nodeId);
    const fp = (node?.data as BaseNodeData | undefined)?.filePath;
    if (!fp) {
      useAppStore.getState().showToast('无法找到文件路径');
      closeMenu();
      return;
    }
    try {
      await revealFileInFolder(fp);
      closeMenu();
      useAppStore.getState().showToast('已打开文件位置');
    } catch {
      useAppStore.getState().showToast('无法打开文件位置');
      closeMenu();
    }
  }, [menu.nodeId, nodes, closeMenu]);

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
      useAppStore.getState().showToast('无法找到文件路径');
      closeMenu();
      return;
    }
    try {
      const photoshopPath = useAppStore.getState().config.photoshopPath;
      await openInPhotoshop(fp, photoshopPath);
      closeMenu();
      useAppStore.getState().showToast('已在 Photoshop 中打开');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '打开失败';
      useAppStore.getState().showToast(message, 'error');
      closeMenu();
    }
  }, [menu.nodeId, nodes, closeMenu]);

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
      useAppStore.getState().showToast('无法读取节点数据');
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
        useAppStore.getState().showToast('文件已保存');
      }
    } catch {
      useAppStore.getState().showToast('文件保存失败');
      closeMenu();
    }
  }, [menu.nodeId, nodeType, nodes, closeMenu]);

  // ── 复制媒体（系统剪贴板）──
  // 图像节点复制位图到剪贴板；视频/音频节点复制文件到剪贴板（CF_HDROP，可在资源管理器粘贴）。
  const copyMediaTypes: NodeType[] = ['ai-image', 'ai-video', 'ai-audio'];
  const showCopyMedia = menu.nodeId != null
    && nodeType != null
    && copyMediaTypes.includes(nodeType)
    && (!!nodeData?.imageUrl || !!nodeData?.videoUrl || !!nodeData?.audioUrl);
  const copyMediaLabel = nodeType === 'ai-image'
    ? '复制图像'
    : nodeType === 'ai-video'
      ? '复制视频'
      : '复制音频';

  const handleCopyMedia = useCallback(async () => {
    if (!menu.nodeId) return;
    const node = nodes.find((n) => n.id === menu.nodeId);
    const data = node?.data as BaseNodeData | undefined;
    if (!data) { closeMenu(); return; }
    const toast = useAppStore.getState().showToast.bind(useAppStore.getState());

    let ok = false;
    try {
      if (nodeType === 'ai-image') {
        const imageUrl = data.imageUrl || data.thumbnailUrl;
        if (!imageUrl) { toast('没有可用的图片', 'error'); closeMenu(); return; }
        ok = await copyImageToClipboard(imageUrl);
      } else {
        const filePath = data.filePath;
        if (!filePath) { toast('该节点没有本地文件，无法复制', 'error'); closeMenu(); return; }
        ok = await copyFileToClipboard(filePath);
      }
      toast(ok ? `已${copyMediaLabel}到剪贴板` : '复制失败', ok ? undefined : 'error');
    } catch {
      toast('复制失败', 'error');
    }
    closeMenu();
  }, [menu.nodeId, nodes, nodeType, copyMediaLabel, closeMenu]);

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
    handleUngroup,
    handleDelete,
    handleShowInFolder,
    showInFolder,
    handleSaveAs,
    showSaveAs,
    handleOpenInPS,
    showOpenInPS,
    handleCopyMedia,
    showCopyMedia,
    copyMediaLabel,
  };
}

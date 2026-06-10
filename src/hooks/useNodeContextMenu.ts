/**
 * useNodeContextMenu 节点右键菜单 Hook — 管理节点上右键弹出操作菜单的显示/隐藏，处理复制、剪切、创建副本、删除
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { BaseNodeData, NodeType } from '../types';
import type { Node as RFNode } from '@xyflow/react';

export interface NodeContextMenuState {
  visible: boolean;
  position: { x: number; y: number };
  nodeId: string | null;
}

export function useNodeContextMenu() {
  const nodes = useAppStore((s) => s.nodes);
  const copySelectedNodes = useAppStore((s) => s.copySelectedNodes);
  const pasteNodes = useAppStore((s) => s.pasteNodes);
  const deleteNode = useAppStore((s) => s.deleteNode);
  const ungroupSelectedNodes = useAppStore((s) => s.ungroupSelectedNodes);
  const setSelectedNodeIds = useAppStore((s) => s.setSelectedNodeIds);

  const [menu, setMenu] = useState<NodeContextMenuState>({
    visible: false,
    position: { x: 0, y: 0 },
    nodeId: null,
  });
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => {
    setMenu({ visible: false, position: { x: 0, y: 0 }, nodeId: null });
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
      // Select only this node so copy/cut works on it
      setSelectedNodeIds([node.id]);
      setMenu({
        visible: true,
        position: { x: e.clientX, y: e.clientY },
        nodeId: node.id,
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
      const { revealFileInFolder } = await import('../services/fileService');
      await revealFileInFolder(fp);
      closeMenu();
      useAppStore.getState().showToast('已打开文件位置');
    } catch {
      useAppStore.getState().showToast('无法打开文件位置');
      closeMenu();
    }
  }, [menu.nodeId, nodes, closeMenu]);

  return {
    menu,
    menuRef,
    openMenu,
    closeMenu,
    handleCopy,
    handleCut,
    handleDuplicate,
    handleUngroup,
    handleDelete,
    handleShowInFolder,
    showInFolder,
  };
}

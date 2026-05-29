import { useState, useRef, useCallback, useEffect } from 'react';
import { useAppStore, generateId } from '../store/useAppStore';
import type { BaseNodeData } from '../types';
import type { Node as RFNode } from '@xyflow/react';

export interface NodeContextMenuState {
  visible: boolean;
  position: { x: number; y: number };
  nodeId: string | null;
}

export function useNodeContextMenu() {
  const nodes = useAppStore((s) => s.nodes);
  const copySelectedNodes = useAppStore((s) => s.copySelectedNodes);
  const deleteNode = useAppStore((s) => s.deleteNode);
  const addNode = useAppStore((s) => s.addNode);
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

  // ── Duplicate: clone + paste at offset ──
  const handleDuplicate = useCallback(() => {
    if (!menu.nodeId) return;
    const source = nodes.find((n) => n.id === menu.nodeId);
    if (!source) return;
    const newNode: RFNode<BaseNodeData> = {
      ...JSON.parse(JSON.stringify(source)),
      id: `node-${generateId()}`,
      position: { x: source.position.x + 30, y: source.position.y + 30 },
      selected: false,
    };
    addNode(newNode);
    closeMenu();
    useAppStore.getState().showToast('节点已创建副本');
  }, [menu.nodeId, nodes, addNode, closeMenu]);

  // ── Delete ──
  const handleDelete = useCallback(() => {
    if (!menu.nodeId) return;
    deleteNode(menu.nodeId);
    closeMenu();
    useAppStore.getState().showToast('节点已删除');
  }, [menu.nodeId, deleteNode, closeMenu]);

  return {
    menu,
    menuRef,
    openMenu,
    closeMenu,
    handleCopy,
    handleCut,
    handleDuplicate,
    handleDelete,
  };
}

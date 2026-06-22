/**
 * useCanvasContextMenu 画布右键菜单 Hook — 管理画布空白区域右键菜单的显示/隐藏、子菜单展开、节点添加操作
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Node as RFNode } from '@xyflow/react';
import { useAppStore, generateId } from '../store/useAppStore';
import type { BaseNodeData, NodeType } from '../types';

// ── Model preference helper ──
const MODEL_PREF_KEY = 'canvas-model-prefs';

function loadDefaultModel(nodeType: string): { model: string; provider: string } | null {
  try {
    const raw = localStorage.getItem(MODEL_PREF_KEY);
    if (!raw) return null;
    const prefs: Record<string, string> = JSON.parse(raw);
    // 全景图回退到生图偏好
    const modelValue = prefs[nodeType] || (nodeType === 'ai-panorama' ? prefs['ai-image'] : undefined);
    if (!modelValue) return null;
    const slashIdx = modelValue.indexOf('/');
    if (slashIdx === -1) return null;
    const provider = modelValue.slice(0, slashIdx);
    if (!provider) return null;
    return { model: modelValue, provider };
  } catch {
    return null;
  }
}

interface ContextMenuState {
  visible: boolean;
  position: { x: number; y: number };
  flowPosition: { x: number; y: number };
  hoverMenu: 'addNode' | 'genNode' | 'srcNode' | null;
}

export function useCanvasContextMenu() {
  const reactFlowInstance = useReactFlow();
  const addNode = useAppStore((s) => s.addNode);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const pasteNodes = useAppStore((s) => s.pasteNodes);

  const [menu, setMenu] = useState<ContextMenuState>({
    visible: false,
    position: { x: 0, y: 0 },
    flowPosition: { x: 0, y: 0 },
    hoverMenu: null,
  });
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeMenu = useCallback(() => {
    setMenu({ visible: false, position: { x: 0, y: 0 }, flowPosition: { x: 0, y: 0 }, hoverMenu: null });
  }, []);

  // Close on click outside or Escape
  useEffect(() => {
    if (!menu.visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element;
      const ctxEl = menuRef.current;
      const subEl = submenuRef.current;
      if ((ctxEl && ctxEl.contains(target)) || (subEl && subEl.contains(target))) return;
      if (target.closest('.canvas-ctx-menu')) return;
      closeMenu();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menu.visible, closeMenu]);

  const addNodeAtCtxPos = useCallback(
    (type: NodeType, label: string, role: 'generator' | 'source' = 'generator') => {
      const pos = menu.flowPosition;
      const flowPos = reactFlowInstance.screenToFlowPosition({ x: pos.x, y: pos.y });
      const isImage = type === 'ai-image';
      const isPanorama = type === 'ai-panorama';
      const isSource = role === 'source';
      const newWidth = type === 'ai-audio' ? 260 : isPanorama ? 300 : type === 'ai-markdown' ? 280 : 280;
      const newHeight = type === 'ai-audio' ? 140 : isImage ? 158 : isPanorama ? 200 : type === 'ai-markdown' ? 200 : 160;
      const defaultModel = !isSource ? loadDefaultModel(type) : null;
      const newNode: RFNode<BaseNodeData> = {
        id: `node-${generateId()}`,
        type,
        position: { x: flowPos.x - newWidth / 2, y: flowPos.y - newHeight / 2 },
        data: {
          label,
          type,
          role,
          prompt: '',
          status: 'idle',
          nodeWidth: newWidth,
          nodeHeight: newHeight,
          ...(isImage && !isSource ? { aspectRatio: '16:9', imageSize: '2K' } : {}),
          ...(defaultModel ? { model: defaultModel.model, provider: defaultModel.provider } : {}),
        },
      };
      addNode(newNode);
      closeMenu();
    },
    [menu.flowPosition, reactFlowInstance, addNode, closeMenu],
  );

  const handleUndo = useCallback(() => { undo(); closeMenu(); }, [undo, closeMenu]);
  const handleRedo = useCallback(() => { redo(); closeMenu(); }, [redo, closeMenu]);

  const handlePaste = useCallback(() => {
    const pos = menu.flowPosition;
    const flowPos = reactFlowInstance.screenToFlowPosition({ x: pos.x, y: pos.y });
    const { clipboard } = useAppStore.getState();
    if (clipboard.nodes.length > 0) {
      pasteNodes(flowPos);
    } else {
      useAppStore.getState().pasteExternalContent(flowPos);
    }
    closeMenu();
  }, [menu.flowPosition, reactFlowInstance, pasteNodes, closeMenu]);

  const showSubmenu = useCallback((m: ContextMenuState['hoverMenu']) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setMenu((s) => ({ ...s, hoverMenu: m }));
  }, []);

  const hideSubmenu = useCallback((backTo: ContextMenuState['hoverMenu']) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setMenu((s) => ({ ...s, hoverMenu: backTo }));
    }, 250);
  }, []);

  const openMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    if (!target.classList.contains('react-flow__pane')) return;
    setMenu({
      visible: true,
      position: { x: e.clientX, y: e.clientY },
      flowPosition: { x: e.clientX, y: e.clientY },
      hoverMenu: null,
    });
  }, []);

  return {
    menu,
    menuRef,
    submenuRef,
    openMenu,
    closeMenu,
    addNodeAtCtxPos,
    handleUndo,
    handleRedo,
    handlePaste,
    showSubmenu,
    hideSubmenu,
  };
}
